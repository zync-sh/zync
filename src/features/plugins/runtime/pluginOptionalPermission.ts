export interface OptionalPermissionPrompt {
    pluginName: string;
    capability: string;
    reason: string;
    packageDigest: string;
}

/** Host-only approval coordinator. Denials are deliberately not cached. */
export function createOptionalPermissionRequester(dependencies: {
    inspect(runtime: string, capability: string, approvedDigest?: string): Promise<OptionalPermissionPrompt | null>;
    confirm(prompt: OptionalPermissionPrompt): Promise<boolean>;
}) {
    const pending = new Map<string, Promise<boolean>>();
    return async (runtime: string, capability: string, isCurrent: () => boolean): Promise<boolean> => {
        if (!isCurrent()) return false;
        const key = JSON.stringify([runtime, capability]);
        let request = pending.get(key);
        if (!request) {
            if (pending.size >= 8) throw new Error('Too many plugin permission requests');
            request = (async () => {
                const prompt = await dependencies.inspect(runtime, capability);
                if (!isCurrent()) return false;
                if (!prompt) return true;
                const allowed = await dependencies.confirm(prompt);
                if (!allowed || !isCurrent()) return false;
                await dependencies.inspect(runtime, capability, prompt.packageDigest);
                return isCurrent();
            })();
            pending.set(key, request);
            void request.finally(() => pending.delete(key)).catch(() => {});
        }
        return (await request) && isCurrent();
    };
}
