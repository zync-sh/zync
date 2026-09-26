const MAX_PLUGIN_MESSAGE_BYTES = 256 * 1024;
const MAX_PLUGIN_MESSAGE_DEPTH = 32;
const MAX_PLUGIN_MESSAGE_NODES = 10_000;
const MESSAGE_TYPE_PATTERN = /^[a-z][a-z0-9:-]*$/;

export interface PluginWorkerMessageEnvelope {
    type: string;
    payload: unknown;
}

/** Accept only bounded JSON-shaped messages before they reach any host API router. */
export function parsePluginWorkerMessage(value: unknown): PluginWorkerMessageEnvelope | null {
    if (!isRecord(value)) return null;
    const type = value.type;
    if (
        typeof type !== 'string'
        || type.length === 0
        || type.length > 128
        || !MESSAGE_TYPE_PATTERN.test(type)
    ) return null;
    const payload = value.payload ?? {};
    if (!isBoundedJson(payload)) return null;
    return { type, payload };
}

function isBoundedJson(root: unknown): boolean {
    const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
    const seen = new WeakSet<object>();
    let bytes = 0;
    let nodes = 0;

    while (stack.length > 0) {
        const current = stack.pop()!;
        nodes += 1;
        if (nodes > MAX_PLUGIN_MESSAGE_NODES || current.depth > MAX_PLUGIN_MESSAGE_DEPTH) {
            return false;
        }
        const value = current.value;
        if (value === null || typeof value === 'boolean') {
            bytes += 4;
        } else if (typeof value === 'number') {
            if (!Number.isFinite(value)) return false;
            bytes += 16;
        } else if (typeof value === 'string') {
            bytes += value.length * 2;
        } else if (Array.isArray(value)) {
            if (seen.has(value)) return false;
            seen.add(value);
            bytes += value.length;
            for (const item of value) stack.push({ value: item, depth: current.depth + 1 });
        } else if (isRecord(value)) {
            if (seen.has(value)) return false;
            seen.add(value);
            const prototype = Object.getPrototypeOf(value);
            if (prototype !== Object.prototype && prototype !== null) return false;
            for (const [key, item] of Object.entries(value)) {
                bytes += key.length * 2;
                stack.push({ value: item, depth: current.depth + 1 });
            }
        } else {
            return false;
        }
        if (bytes > MAX_PLUGIN_MESSAGE_BYTES) return false;
    }
    return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
