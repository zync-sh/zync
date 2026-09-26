export type PluginRuntimeStatus =
    | 'disabled'
    | 'inactive'
    | 'starting'
    | 'active'
    | 'crashed'
    | 'quarantined'
    | 'safe-mode';

export interface PluginRuntimeHealth {
    pluginId: string;
    status: PluginRuntimeStatus;
    crashCount: number;
    lastStartedAt?: number;
    lastCrashAt?: number;
    lastError?: string;
}

export interface PluginRuntimeWorker {
    terminate: () => void;
}

interface RuntimeRecord extends PluginRuntimeHealth {
    crashTimes: number[];
}

interface KnownPluginRuntime {
    pluginId: string;
    enabled: boolean;
    runnable: boolean;
    safeModeBlocked?: boolean;
}

interface PendingHeartbeat<TWorker> {
    worker: TWorker;
    nonce: number;
    sentAt: number;
}

export interface PluginHeartbeatProbe<TWorker> {
    pluginId: string;
    worker: TWorker;
    nonce: number;
}

export interface UnresponsivePluginRuntime {
    pluginId: string;
    runtimeInstanceId: string | null;
}

export interface PluginHeartbeatPoll<TWorker> {
    probes: PluginHeartbeatProbe<TWorker>[];
    unresponsive: UnresponsivePluginRuntime[];
}

const DEFAULT_CRASH_LIMIT = 3;
const DEFAULT_CRASH_WINDOW_MS = 60_000;

/**
 * Owns frontend runtime generations. Policy and grants remain native; this class
 * only decides whether one Worker generation is still current and healthy.
 */
export class PluginRuntimeSupervisor<TWorker extends PluginRuntimeWorker> {
    private readonly workers = new Map<string, TWorker>();
    private readonly runtimeInstances = new Map<string, string>();
    private readonly records = new Map<string, RuntimeRecord>();
    private readonly listeners = new Set<(health: PluginRuntimeHealth[]) => void>();
    private readonly pendingHeartbeats = new Map<string, PendingHeartbeat<TWorker>>();
    private heartbeatNonce = 0;
    private lastHeartbeatPollAt: number | null = null;

    constructor(
        private readonly now: () => number = Date.now,
        private readonly crashLimit = DEFAULT_CRASH_LIMIT,
        private readonly crashWindowMs = DEFAULT_CRASH_WINDOW_MS,
    ) { }

    subscribe(listener: (health: PluginRuntimeHealth[]) => void): () => void {
        this.listeners.add(listener);
        listener(this.snapshot());
        return () => this.listeners.delete(listener);
    }

    snapshot(): PluginRuntimeHealth[] {
        return [...this.records.values()]
            .map(({ crashTimes: _crashTimes, ...health }) => ({ ...health }))
            .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
    }

    syncKnownPlugins(plugins: KnownPluginRuntime[]): void {
        const known = new Set(plugins.map(plugin => plugin.pluginId));
        for (const pluginId of this.records.keys()) {
            if (!known.has(pluginId)) this.records.delete(pluginId);
        }
        for (const plugin of plugins) {
            const record = this.record(plugin.pluginId);
            this.pruneCrashes(record);
            if (!plugin.enabled) record.status = 'disabled';
            else if (plugin.safeModeBlocked) record.status = 'safe-mode';
            else if (record.crashTimes.length >= this.crashLimit) record.status = 'quarantined';
            else if (!plugin.runnable) record.status = 'inactive';
            else if (!this.workers.has(plugin.pluginId)) record.status = 'inactive';
        }
        this.emit();
    }

    beginStart(pluginId: string): boolean {
        const record = this.record(pluginId);
        if (record.status === 'safe-mode' || record.status === 'disabled') return false;
        this.pruneCrashes(record);
        if (record.crashTimes.length >= this.crashLimit) {
            record.status = 'quarantined';
            record.crashCount = record.crashTimes.length;
            this.emit();
            return false;
        }
        record.status = 'starting';
        this.emit();
        return true;
    }

    attach(pluginId: string, worker: TWorker, runtimeInstanceId: string): void {
        const previous = this.workers.get(pluginId);
        if (previous && previous !== worker) previous.terminate();
        this.workers.set(pluginId, worker);
        this.runtimeInstances.set(pluginId, runtimeInstanceId);
        this.pendingHeartbeats.delete(pluginId);
        const record = this.record(pluginId);
        record.status = 'active';
        record.lastStartedAt = this.now();
        record.lastError = undefined;
        this.emit();
    }

    markStartFailure(pluginId: string, error: unknown): void {
        this.recordCrash(pluginId, error);
    }

    markCrash(pluginId: string, worker: TWorker, error: unknown): string | null {
        if (!this.isCurrentWorker(pluginId, worker)) return null;
        worker.terminate();
        this.workers.delete(pluginId);
        this.pendingHeartbeats.delete(pluginId);
        const runtimeInstanceId = this.runtimeInstances.get(pluginId) ?? null;
        this.runtimeInstances.delete(pluginId);
        this.recordCrash(pluginId, error);
        return runtimeInstanceId;
    }

    stopAll(beforeTerminate: (pluginId: string) => void): void {
        this.workers.forEach((worker, pluginId) => {
            beforeTerminate(pluginId);
            worker.terminate();
        });
        this.workers.clear();
        this.runtimeInstances.clear();
        this.pendingHeartbeats.clear();
        this.lastHeartbeatPollAt = null;
        for (const record of this.records.values()) {
            if (record.status === 'active' || record.status === 'starting') record.status = 'inactive';
        }
        this.emit();
    }

    clearQuarantine(pluginId: string): void {
        const record = this.record(pluginId);
        record.crashTimes = [];
        record.crashCount = 0;
        record.lastError = undefined;
        record.status = 'inactive';
        this.emit();
    }

    restoreFailures(pluginId: string, failureTimes: number[], lastKind?: string): void {
        const record = this.record(pluginId);
        const cutoff = this.now() - this.crashWindowMs;
        record.crashTimes = [...new Set([...record.crashTimes, ...failureTimes])]
            .filter(timestamp => Number.isFinite(timestamp) && timestamp >= cutoff)
            .sort((left, right) => left - right);
        record.crashCount = record.crashTimes.length;
        record.lastCrashAt = record.crashTimes[record.crashTimes.length - 1];
        if (lastKind) record.lastError = `Previous runtime failure: ${lastKind}`;
        if (record.crashCount >= this.crashLimit) record.status = 'quarantined';
        this.emit();
    }

    getWorker(pluginId: string): TWorker | undefined {
        return this.workers.get(pluginId);
    }

    getRuntimeInstanceId(pluginId: string): string | undefined {
        return this.runtimeInstances.get(pluginId);
    }

    isCurrentWorker(pluginId: string, worker: TWorker): boolean {
        return this.workers.get(pluginId) === worker;
    }

    isCurrentRuntime(pluginId: string, runtimeInstanceId: string): boolean {
        return this.runtimeInstances.get(pluginId) === runtimeInstanceId;
    }

    pollHeartbeats(timeoutMs: number): PluginHeartbeatPoll<TWorker> {
        const now = this.now();
        const probes: PluginHeartbeatProbe<TWorker>[] = [];
        const unresponsive: UnresponsivePluginRuntime[] = [];

        // Browser timers pause during sleep and may be heavily throttled in the background.
        // A large polling gap therefore starts a fresh cycle instead of blaming every plugin.
        if (this.lastHeartbeatPollAt !== null && now - this.lastHeartbeatPollAt > timeoutMs) {
            this.pendingHeartbeats.clear();
        }
        this.lastHeartbeatPollAt = now;

        for (const [pluginId, worker] of this.workers) {
            const pending = this.pendingHeartbeats.get(pluginId);
            if (pending && pending.worker === worker) {
                if (now - pending.sentAt < timeoutMs) continue;
                const runtimeInstanceId = this.markCrash(
                    pluginId,
                    worker,
                    `Plugin runtime stopped responding for ${timeoutMs} ms`,
                );
                unresponsive.push({ pluginId, runtimeInstanceId });
                continue;
            }

            const nonce = ++this.heartbeatNonce;
            this.pendingHeartbeats.set(pluginId, { worker, nonce, sentAt: now });
            probes.push({ pluginId, worker, nonce });
        }
        return { probes, unresponsive };
    }

    acknowledgeHeartbeat(pluginId: string, worker: TWorker, nonce: unknown): boolean {
        const pending = this.pendingHeartbeats.get(pluginId);
        if (
            !pending
            || pending.worker !== worker
            || !this.isCurrentWorker(pluginId, worker)
            || typeof nonce !== 'number'
            || nonce !== pending.nonce
        ) return false;
        this.pendingHeartbeats.delete(pluginId);
        return true;
    }

    private record(pluginId: string): RuntimeRecord {
        const existing = this.records.get(pluginId);
        if (existing) return existing;
        const created: RuntimeRecord = {
            pluginId,
            status: 'inactive',
            crashCount: 0,
            crashTimes: [],
        };
        this.records.set(pluginId, created);
        return created;
    }

    private pruneCrashes(record: RuntimeRecord): void {
        const cutoff = this.now() - this.crashWindowMs;
        record.crashTimes = record.crashTimes.filter(timestamp => timestamp >= cutoff);
        record.crashCount = record.crashTimes.length;
    }

    private recordCrash(pluginId: string, error: unknown): void {
        const record = this.record(pluginId);
        this.pruneCrashes(record);
        const crashedAt = this.now();
        record.crashTimes.push(crashedAt);
        record.crashCount = record.crashTimes.length;
        record.lastCrashAt = crashedAt;
        record.lastError = error instanceof Error ? error.message : String(error || 'Plugin runtime crashed');
        record.status = record.crashCount >= this.crashLimit ? 'quarantined' : 'crashed';
        this.emit();
    }

    private emit(): void {
        const health = this.snapshot();
        this.listeners.forEach(listener => listener(health));
    }
}
