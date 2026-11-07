export interface EditorStatusReport {
    docId: string;
    line: number;
    column: number;
    language?: string;
}

const MAX_POSITION = 10_000_000;
const LANGUAGE_PATTERN = /^[a-zA-Z0-9_+#.-]{1,32}$/;

/** Ignore stale, malformed, or unbounded status data from an editor iframe. */
export function parseEditorStatusReport(
    payload: unknown,
    expectedDocId: string,
): EditorStatusReport | null {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const value = payload as Record<string, unknown>;
    if (value.docId !== expectedDocId) {
        return null;
    }
    if (
        !Number.isSafeInteger(value.line) ||
        (value.line as number) < 1 ||
        (value.line as number) > MAX_POSITION
    ) {
        return null;
    }
    if (
        !Number.isSafeInteger(value.column) ||
        (value.column as number) < 1 ||
        (value.column as number) > MAX_POSITION
    ) {
        return null;
    }
    if (
        value.language !== undefined &&
        (typeof value.language !== 'string' || !LANGUAGE_PATTERN.test(value.language))
    ) {
        return null;
    }
    return {
        docId: expectedDocId,
        line: value.line as number,
        column: value.column as number,
        language: value.language as string | undefined,
    };
}

/** Textarea selection offsets are UTF-16, matching the browser's cursor model. */
export function plainCursorPosition(
    content: string,
    selectionStart: number,
): { line: number; column: number } {
    return createPlainCursorIndex(content).position(selectionStart);
}

const CURSOR_CHECKPOINT_SPAN = 4096;

interface CursorCheckpoint {
    line: number;
    lineStart: number;
}

/** Count line breaks in a range starting at a known line and column. */
function scanPlainCursor(
    content: string,
    start: number,
    end: number,
    checkpoint: CursorCheckpoint,
): CursorCheckpoint {
    let { line, lineStart } = checkpoint;
    for (let index = start; index < end; index++) {
        if (content.charCodeAt(index) === 10) {
            line++;
            lineStart = index + 1;
        }
    }
    return { line, lineStart };
}

/** Cache sparse line checkpoints up to the caret so edits near the start avoid a full scan. */
export function createPlainCursorIndex(content: string) {
    const checkpoints: CursorCheckpoint[] = [{ line: 1, lineStart: 0 }];
    return {
        /** Reuse previous scans; moving within indexed text inspects at most one checkpoint span. */
        position(selectionStart: number): { line: number; column: number } {
            const end = Math.max(0, Math.min(content.length, selectionStart));
            const block = Math.floor(end / CURSOR_CHECKPOINT_SPAN);
            while (checkpoints.length <= block) {
                const previous = checkpoints.length - 1;
                checkpoints.push(
                    scanPlainCursor(
                        content,
                        previous * CURSOR_CHECKPOINT_SPAN,
                        (previous + 1) * CURSOR_CHECKPOINT_SPAN,
                        checkpoints[previous],
                    ),
                );
            }
            const { line, lineStart } = scanPlainCursor(
                content,
                block * CURSOR_CHECKPOINT_SPAN,
                end,
                checkpoints[block],
            );
            return { line, column: end - lineStart + 1 };
        },
    };
}
