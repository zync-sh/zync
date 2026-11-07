import type { TunnelConfig } from '../../../components/tunnel/TunnelCard';
import type { Connection } from '../../connections/domain/types';

type TunnelIdentity = Pick<TunnelConfig, 'id' | 'connectionId'>;
export type UserTunnelStartResult = 'started' | 'already-running' | 'cancelled';
export interface UserTunnelStartSummary {
    started: number;
    failed: number;
    cancelled: number;
}
export interface UserTunnelPort {
    connectionStatus(connectionId: string): Connection['status'] | undefined;
    subscribeConnectionStatus(
        connectionId: string,
        listener: (status: Connection['status'] | undefined) => void,
    ): () => void;
    tunnelStatus(tunnel: TunnelIdentity): TunnelConfig['status'] | undefined;
    connect(connectionId: string): Promise<void>;
    refreshTunnels(connectionId: string): Promise<void>;
    startTunnel(tunnelId: string, connectionId: string): Promise<void>;
}

interface ConnectionAdmission {
    ready: Promise<boolean>;
    finished: Promise<void>;
    cancelled: boolean;
    users: number;
    settled: boolean;
    unsubscribe?: () => void;
    finish(): void;
}

/** Explicit UI starts share connection admission; background restart services keep their existing transport-only path. */
export function createUserTunnelActions(port: UserTunnelPort) {
    const connections = new Map<string, ConnectionAdmission>();
    const starts = new Map<
        string,
        { admission: ConnectionAdmission; result: Promise<UserTunnelStartResult> }
    >();
    const waitingGroups = new Set<{ admission: ConnectionAdmission; keys: Set<string> }>();
    const startListeners = new Set<() => void>();

    /** Scope pending starts to the saved forward and its host. */
    function startKey(tunnel: TunnelIdentity): string {
        return JSON.stringify([tunnel.connectionId, tunnel.id]);
    }

    /** Refresh the UI when a start is admitted, cancelled or settled. */
    function notifyStartsChanged(): void {
        for (const listener of startListeners) {
            listener();
        }
    }

    /** Show explicit starts and forwards queued or starting in a group. */
    function isStarting(tunnel: TunnelIdentity): boolean {
        const key = startKey(tunnel);
        const pending = starts.get(key);
        if (pending && !pending.admission.cancelled) {
            return true;
        }
        for (const group of waitingGroups) {
            if (!group.admission.cancelled && group.keys.has(key)) {
                return true;
            }
        }
        return false;
    }

    /** Let either Port Forwarding view observe the same pending starts. */
    function subscribeStarts(listener: () => void): () => void {
        startListeners.add(listener);
        return () => {
            startListeners.delete(listener);
        };
    }

    function releaseAdmission(connectionId: string, admission: ConnectionAdmission): void {
        admission.users--;
        finishAdmission(connectionId, admission);
    }

    /** Release the host observer only after admission settles and all users exit. */
    function finishAdmission(connectionId: string, admission: ConnectionAdmission): void {
        if (admission.users > 0 || !admission.settled) {
            return;
        }
        admission.unsubscribe?.();
        if (connections.get(connectionId) === admission) {
            connections.delete(connectionId);
        }
        admission.finish();
    }

    /** A fresh explicit retry waits for cancelled work to unwind, without reusing its authority or racing its transport. */
    function acquireAdmission(connectionId: string): ConnectionAdmission {
        const pending = connections.get(connectionId);
        if (pending && !pending.cancelled) {
            pending.users++;
            return pending;
        }
        let finish!: () => void;
        let resolveReady!: (ready: boolean) => void;
        let rejectReady!: (error: unknown) => void;
        const admission: ConnectionAdmission = {
            ready: new Promise<boolean>((resolve, reject) => {
                resolveReady = resolve;
                rejectReady = reject;
            }),
            finished: new Promise<void>((resolve) => {
                finish = resolve;
            }),
            cancelled: false,
            users: 1,
            settled: false,
            finish: () => finish(),
        };
        connections.set(connectionId, admission);
        void (async () => {
            try {
                if (pending) {
                    await pending.finished;
                }
                const status = port.connectionStatus(connectionId);
                if (!status) {
                    throw new Error('The host for this forward is no longer available.');
                }
                // Another surface owns this attempt; do not queue another reconnect behind it.
                if (status === 'connecting') {
                    return false;
                }
                let observedActive = status === 'connected';
                admission.unsubscribe = port.subscribeConnectionStatus(connectionId, (next) => {
                    if (next === 'connecting' || next === 'connected') {
                        observedActive = true;
                    } else if (observedActive && next !== 'error' && !admission.cancelled) {
                        admission.cancelled = true;
                        notifyStartsChanged();
                    }
                });
                if (status === 'connected') {
                    return true;
                }
                await port.connect(connectionId);
                if (admission.cancelled) {
                    return false;
                }
                const finalStatus = port.connectionStatus(connectionId);
                if (finalStatus === 'error') {
                    throw new Error('Could not connect to the host for this forward.');
                }
                if (finalStatus !== 'connected') {
                    return false;
                }
                await port.refreshTunnels(connectionId);
                return !admission.cancelled && port.connectionStatus(connectionId) === 'connected';
            } catch (error) {
                if (admission.cancelled) {
                    return false;
                }
                throw error;
            } finally {
                admission.settled = true;
                finishAdmission(connectionId, admission);
            }
        })().then(resolveReady, rejectReady);
        return admission;
    }

    /** Repeated clicks across global/per-host lists share one start, with fresh host and saved-forward checks. */
    function start(
        tunnel: TunnelIdentity,
        owner?: ConnectionAdmission,
    ): Promise<UserTunnelStartResult> {
        const key = startKey(tunnel);
        const pending = starts.get(key);
        if (pending && !pending.admission.cancelled) {
            return pending.result;
        }
        if (!port.tunnelStatus(tunnel)) {
            return Promise.reject(new Error('This saved forward is no longer available.'));
        }
        const admission = owner ?? acquireAdmission(tunnel.connectionId);
        if (owner) {
            admission.users++;
        }
        const operation = (async (): Promise<UserTunnelStartResult> => {
            if (
                !(await admission.ready) ||
                admission.cancelled ||
                port.connectionStatus(tunnel.connectionId) !== 'connected'
            ) {
                return 'cancelled';
            }
            const status = port.tunnelStatus(tunnel);
            if (!status) {
                throw new Error('This saved forward is no longer available.');
            }
            if (status === 'active') {
                return 'already-running';
            }
            try {
                await port.startTunnel(tunnel.id, tunnel.connectionId);
                return admission.cancelled ? 'cancelled' : 'started';
            } catch (error) {
                if (admission.cancelled) {
                    return 'cancelled';
                }
                throw error;
            }
        })();
        const settled: Promise<UserTunnelStartResult> = operation.finally(() => {
            if (starts.get(key)?.result === settled) {
                starts.delete(key);
                notifyStartsChanged();
            }
            releaseAdmission(tunnel.connectionId, admission);
        });
        starts.set(key, { admission, result: settled });
        notifyStartsChanged();
        return settled;
    }

    /** One cancelled host attempt skips its remaining forwards instead of reopening authentication for every row. */
    async function startGroup(tunnels: readonly TunnelIdentity[]): Promise<UserTunnelStartSummary> {
        const summary = { started: 0, failed: 0, cancelled: 0 };
        const groups = new Map<string, TunnelIdentity[]>();
        for (const tunnel of tunnels) {
            const status = port.tunnelStatus(tunnel);
            if (!status) {
                summary.failed++;
                continue;
            }
            const group = groups.get(tunnel.connectionId) ?? [];
            group.push(tunnel);
            groups.set(tunnel.connectionId, group);
        }
        for (const [connectionId, group] of groups) {
            const admission = acquireAdmission(connectionId);
            const waiting = { admission, keys: new Set(group.map(startKey)) };
            waitingGroups.add(waiting);
            notifyStartsChanged();
            try {
                try {
                    if (!(await admission.ready)) {
                        summary.cancelled += group.length;
                        continue;
                    }
                } catch {
                    summary.failed += group.length;
                    continue;
                }
                for (let index = 0; index < group.length; index++) {
                    const tunnel = group[index];
                    try {
                        if (
                            admission.cancelled ||
                            port.connectionStatus(connectionId) !== 'connected'
                        ) {
                            summary.cancelled += group.length - index;
                            break;
                        }
                        // A cached active flag can outlive disconnect; trust it only after host admission and refresh.
                        if (port.tunnelStatus(tunnel) === 'active') {
                            continue;
                        }
                        if ((await start(tunnel, admission)) === 'cancelled') {
                            summary.cancelled += group.length - index;
                            break;
                        }
                        summary.started++;
                    } catch {
                        summary.failed++;
                    } finally {
                        if (waiting.keys.delete(startKey(tunnel))) {
                            notifyStartsChanged();
                        }
                    }
                }
            } finally {
                waitingGroups.delete(waiting);
                releaseAdmission(connectionId, admission);
                if (waiting.keys.size > 0) {
                    notifyStartsChanged();
                }
            }
        }
        return summary;
    }

    return {
        /** Only explicit starts may initiate host connection; the internal connected-only mode stays private. */
        start: (tunnel: TunnelIdentity) => start(tunnel),
        startGroup,
        isStarting,
        subscribeStarts,
    };
}
