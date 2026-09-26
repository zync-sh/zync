const MAX_PANE_MESSAGE_BYTES = 64 * 1024;
const MAX_PANE_MESSAGE_DEPTH = 16;
const MAX_PANE_MESSAGE_KEYS = 128;
const MAX_PANE_MESSAGE_ARRAY_ITEMS = 4_096;

export type PluginPaneMessageResult =
    | { ok: true; message: unknown }
    | { ok: false };

function isJsonValue(value: unknown, depth: number): boolean {
    if (depth > MAX_PANE_MESSAGE_DEPTH) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) {
        return value.length <= MAX_PANE_MESSAGE_ARRAY_ITEMS
            && value.every(item => isJsonValue(item, depth + 1));
    }
    if (typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const entries = Object.entries(value);
    if (entries.length > MAX_PANE_MESSAGE_KEYS) return false;
    return entries.every(([key, item]) => (
        key.length <= 128 && isJsonValue(item, depth + 1)
    ));
}

export function validatePluginPaneMessage(message: unknown): PluginPaneMessageResult {
    if (!isJsonValue(message, 0)) return { ok: false };
    try {
        if (new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_PANE_MESSAGE_BYTES) {
            return { ok: false };
        }
    } catch {
        return { ok: false };
    }
    return { ok: true, message };
}

export function parsePluginPaneMessage(data: unknown): PluginPaneMessageResult {
    if (!data || typeof data !== 'object') return { ok: false };
    const record = data as Record<string, unknown>;
    if (record.type !== 'zync:pane:message') return { ok: false };
    return validatePluginPaneMessage(record.payload);
}
