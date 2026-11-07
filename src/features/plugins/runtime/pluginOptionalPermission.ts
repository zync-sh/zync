export interface OptionalPermissionPrompt {
    pluginName: string;
    capability: string;
    reason: string;
    packageDigest: string;
}

type WaitObserver = (waitingForUser: boolean) => void;

/** Host-only approval coordinator. Denials are deliberately not cached. */
export function createOptionalPermissionRequester(dependencies: {
    inspect(
        runtime: string,
        capability: string,
        approvedDigest?: string,
    ): Promise<OptionalPermissionPrompt | null>;
    confirm(prompt: OptionalPermissionPrompt): Promise<boolean>;
}) {
    const pending = new Map<
        string,
        { request: Promise<boolean>; phase: { waiting: boolean; observers: Set<WaitObserver> } }
    >();
    return async (
        runtime: string,
        capability: string,
        isCurrent: () => boolean,
        onWait?: WaitObserver,
    ): Promise<boolean> => {
        if (!isCurrent()) {
            return false;
        }
        const key = JSON.stringify([runtime, capability]);
        let entry = pending.get(key);
        if (!entry) {
            if (pending.size >= 8) {
                throw new Error('Too many plugin permission requests');
            }
            const phase = { waiting: false, observers: new Set<WaitObserver>() };
            /** Track only time spent in the confirmation dialog, excluding native IPC. */
            const setWaiting = (waiting: boolean) => {
                phase.waiting = waiting;
                for (const observer of phase.observers) {
                    observer(waiting);
                }
            };
            const request = (async () => {
                const prompt = await dependencies.inspect(runtime, capability);
                if (!isCurrent()) {
                    return false;
                }
                if (!prompt) {
                    return true;
                }
                setWaiting(true);
                let allowed: boolean;
                try {
                    allowed = await dependencies.confirm(prompt);
                } finally {
                    setWaiting(false);
                }
                if (!allowed || !isCurrent()) {
                    return false;
                }
                await dependencies.inspect(runtime, capability, prompt.packageDigest);
                return isCurrent();
            })();
            entry = { request, phase };
            pending.set(key, entry);
            void request.finally(() => pending.delete(key)).catch(() => {});
        }
        try {
            if (onWait) {
                entry.phase.observers.add(onWait);
                if (entry.phase.waiting) {
                    onWait(true);
                }
            }
            return (await entry.request) && isCurrent();
        } finally {
            if (onWait) {
                entry.phase.observers.delete(onWait);
            }
        }
    };
}
