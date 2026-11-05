export interface PlainSearchMatches {
    length: number;
    at: (index: number) => { start: number; end: number } | undefined;
}

const MATCHES_PER_BLOCK = 4096;

/** Keep every match while using packed offsets instead of allocating an object per occurrence. */
export function indexPlainSearchMatches(haystack: string, needle: string): PlainSearchMatches {
    const blocks: Uint32Array[] = [];
    let length = 0;
    if (needle) {
        for (let offset = 0; offset < haystack.length; ) {
            const found = haystack.indexOf(needle, offset);
            if (found < 0) {
                break;
            }
            const block = Math.floor(length / MATCHES_PER_BLOCK);
            blocks[block] ??= new Uint32Array(MATCHES_PER_BLOCK);
            blocks[block][length % MATCHES_PER_BLOCK] = found;
            length++;
            offset = found + needle.length;
        }
    }
    return {
        length,
        /** Resolve just the selected match without materializing all match objects. */
        at(index) {
            if (!Number.isInteger(index) || index < 0 || index >= length) {
                return undefined;
            }
            const start = blocks[Math.floor(index / MATCHES_PER_BLOCK)][index % MATCHES_PER_BLOCK];
            return { start, end: start + needle.length };
        },
    };
}
