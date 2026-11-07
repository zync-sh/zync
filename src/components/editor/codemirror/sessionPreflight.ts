import { historyField } from '@codemirror/commands';
import { ChangeDesc, ChangeSet, EditorSelection, type EditorState } from '@codemirror/state';

import {
    type CodeMirrorSessionCacheLimits,
    DEFAULT_CODEMIRROR_SESSION_LIMITS,
} from './sessionCache.js';

/** Reject snapshots that already exceed cache budgets without flattening document/history text.
 * History is exposed as unknown by CodeMirror. Unknown layouts are left uncached;
 * live editing and undo remain intact. The cache still checks exact serialized size.
 */
export function canSerializeCodeMirrorSession(
    state: EditorState,
    savedContentLength: number,
    limits: CodeMirrorSessionCacheLimits = DEFAULT_CODEMIRROR_SESSION_LIMITS,
): boolean {
    const limit = Math.min(limits.maxEntryCharacters, limits.maxTotalCharacters);
    let characters = savedContentLength + state.doc.length;
    if (!Number.isSafeInteger(characters) || characters > limit) {
        return false;
    }
    const history = state.field(historyField, false) as
        | { done?: unknown; undone?: unknown }
        | undefined;
    if (!history) {
        return true;
    }
    if (!Array.isArray(history.done) || !Array.isArray(history.undone)) {
        return false;
    }
    const exhausted = {};
    try {
        for (const branch of [history.done, history.undone]) {
            for (const value of branch) {
                if (!value || typeof value !== 'object') {
                    return false;
                }
                const event = value as {
                    changes?: unknown;
                    mapped?: unknown;
                    startSelection?: unknown;
                    selectionsAfter?: unknown;
                };
                characters++;
                if (characters > limit) {
                    return false;
                }
                if (event.changes !== undefined) {
                    if (!(event.changes instanceof ChangeSet)) {
                        return false;
                    }
                    event.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
                        characters += inserted.length + 1;
                        if (characters > limit) {
                            throw exhausted;
                        }
                    });
                }
                if (event.mapped !== undefined) {
                    if (!(event.mapped instanceof ChangeDesc)) {
                        return false;
                    }
                    event.mapped.iterChangedRanges(() => {
                        characters++;
                        if (characters > limit) {
                            throw exhausted;
                        }
                    });
                }
                if (
                    event.startSelection !== undefined &&
                    !(event.startSelection instanceof EditorSelection)
                ) {
                    return false;
                }
                if (!Array.isArray(event.selectionsAfter)) {
                    return false;
                }
                const selections = event.selectionsAfter;
                if (event.startSelection instanceof EditorSelection) {
                    characters += event.startSelection.ranges.length;
                    if (characters > limit) {
                        return false;
                    }
                }
                for (const selection of selections) {
                    if (selection === undefined) {
                        continue;
                    }
                    if (!(selection instanceof EditorSelection)) {
                        return false;
                    }
                    characters += selection.ranges.length;
                    if (characters > limit) {
                        return false;
                    }
                }
            }
        }
        return true;
    } catch {
        // Optional cache retention must never prevent the editor from disposing its live view.
        return false;
    }
}
