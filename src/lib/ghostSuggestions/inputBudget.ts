import maxCommandBytes from './inputBudgetBytes.json' with { type: 'json' };

/** Shared with native Ghost history/inference; terminal delivery has no size cap. */
export const MAX_GHOST_COMMAND_BYTES = maxCommandBytes;

/** Counts UTF-8 without allocating an encoded copy, stopping as soon as the budget is exceeded. */
export function ghostInputByteLength(
    text: string,
    maxBytes = MAX_GHOST_COMMAND_BYTES,
): number | null {
    if (text.length > maxBytes) {
        return null;
    }
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) {
            bytes++;
        } else if (code < 0x800) {
            bytes += 2;
        } else if (
            code >= 0xd800 &&
            code <= 0xdbff &&
            i + 1 < text.length &&
            text.charCodeAt(i + 1) >= 0xdc00 &&
            text.charCodeAt(i + 1) <= 0xdfff
        ) {
            bytes += 4;
            i++;
        } else {
            bytes += 3;
        }
        if (bytes > maxBytes) {
            return null;
        }
    }
    return bytes;
}
