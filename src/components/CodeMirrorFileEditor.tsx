import { historyField } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';
import { openSearchPanel } from '@codemirror/search';
import {
    Compartment,
    EditorSelection,
    EditorState,
    type Extension,
    type Text,
    Transaction,
} from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    clearEditorStatus,
    createEditorStatusSource,
    publishEditorStatus,
} from '../features/editor/editorStatus';
import {
    type EditorSaveAccess,
    EditorSaveBlockedError,
    editorSaveBlocked,
    editorSaveErrorMessage,
} from '../features/files/domain/editorSaveAccess';
import { getCspStyleNonce } from '../lib/cspStyleNonce';
import { useAppStore } from '../store/useAppStore';
import { CodeMirrorToolbar } from './editor/codemirror/CodeMirrorToolbar';
import { buildLineCommentChanges } from './editor/codemirror/comments';
import { createCodeMirrorExtensions } from './editor/codemirror/extensions';
import { getLanguageLabel, getLineCommentToken } from './editor/codemirror/fileTypes';
import { GoToLinePanel } from './editor/codemirror/GoToLinePanel';
import { isCommentShortcut } from './editor/codemirror/keymap';
import { loadCodeMirrorLanguage } from './editor/codemirror/language';
import { observeCodeMirrorLayout } from './editor/codemirror/layout';
import { resolveCodeMirrorPerformanceMode } from './editor/codemirror/performance';
import { resolveSavedBaseline } from './editor/codemirror/saveState';
import {
    deleteCodeMirrorSession,
    saveCodeMirrorSession,
    takeCodeMirrorSession,
} from './editor/codemirror/sessionCache';
import { canSerializeCodeMirrorSession } from './editor/codemirror/sessionPreflight';
import { formatCodeMirrorStatus } from './editor/codemirror/status';
import { createCodeMirrorHighlightStyle, createCodeMirrorTheme } from './editor/codemirror/theme';
import { EditorSaveAccessStatus } from './editor/EditorSaveAccessStatus';

interface CodeMirrorFileEditorProps {
    documentId?: string;
    filename: string;
    initialContent: string;
    onSave: (content: string) => Promise<void>;
    onClose: () => void;
    onDirtyChange?: (dirty: boolean) => void;
    hideToolbar?: boolean;
    saveAccess?: EditorSaveAccess;
}

/** Parse and clamp an optional line/column request to the current document. */
function parseGoToLineInput(input: string, maxLine: number) {
    const trimmed = input.trim();
    if (!trimmed) {
        return null;
    }
    const [linePart, columnPart] = trimmed.split(/[:.,]/);
    const line = Number(linePart);
    if (!Number.isFinite(line)) {
        return null;
    }

    const resolvedLine = Math.max(1, Math.min(maxLine, Math.floor(line)));
    const column =
        columnPart !== undefined && columnPart !== ''
            ? Math.max(1, Math.floor(Number(columnPart)))
            : null;

    return {
        line: resolvedLine,
        column: Number.isFinite(column) ? column : null,
    };
}

/** Resolve editing capabilities from the complete document size and selected mode. */
function useDocumentPerformanceMode(sessionKey: string, initialContent: string) {
    const resolvedModeRef = useRef<{
        sessionKey: string;
        mode: ReturnType<typeof resolveCodeMirrorPerformanceMode>;
    } | null>(null);

    if (resolvedModeRef.current?.sessionKey !== sessionKey) {
        resolvedModeRef.current = {
            sessionKey,
            mode: resolveCodeMirrorPerformanceMode(initialContent),
        };
    }

    return resolvedModeRef.current.mode;
}

/** Own the editor model, save baseline, layout observation and bounded session retention. */
export function CodeMirrorFileEditor({
    documentId,
    filename,
    initialContent,
    onSave,
    onClose,
    onDirtyChange,
    hideToolbar = false,
    saveAccess,
}: CodeMirrorFileEditorProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const languageCompartment = useRef(new Compartment()).current;
    const themeCompartment = useRef(new Compartment()).current;
    const readOnlyCompartment = useRef(new Compartment()).current;
    const saveBlocked = editorSaveBlocked(saveAccess);
    const [isDirty, setIsDirty] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [showGoToLine, setShowGoToLine] = useState(false);
    const [goToLineValue, setGoToLineValue] = useState('');
    const [goToLineError, setGoToLineError] = useState<string | null>(null);
    const goToLineInputRef = useRef<HTMLInputElement>(null);
    const showConfirmDialog = useAppStore((state) => state.showConfirmDialog);
    const showToast = useAppStore((state) => state.showToast);
    const theme = useAppStore((state) => state.settings.theme);
    const sessionKey = documentId ?? filename;

    const lineCommentToken = useMemo(() => getLineCommentToken(filename), [filename]);
    const languageLabel = useMemo(() => getLanguageLabel(filename), [filename]);
    const performanceMode = useDocumentPerformanceMode(sessionKey, initialContent);
    const saveRef = useRef<() => Promise<void> | void>(() => {});
    const closeRef = useRef<() => Promise<void> | void>(() => {});
    const toggleCommentRef = useRef<(view: EditorView) => boolean>(() => false);
    const savedDocRef = useRef<Text | null>(null);
    const isDirtyRef = useRef(false);
    const isSavingRef = useRef(false);
    const statusFrameRef = useRef<number | null>(null);
    const statusSourceRef = useRef(createEditorStatusSource(`codemirror:${filename}`));
    const discardSessionRef = useRef(false);

    const updateDirtyState = useCallback(
        (dirty: boolean) => {
            isDirtyRef.current = dirty;
            setIsDirty((current) => (current === dirty ? current : dirty));
            onDirtyChange?.(dirty);
        },
        [onDirtyChange],
    );

    const publishStatus = useCallback(
        (state: EditorState) => {
            if (statusFrameRef.current !== null) {
                cancelAnimationFrame(statusFrameRef.current);
            }

            statusFrameRef.current = requestAnimationFrame(() => {
                statusFrameRef.current = null;
                const head = state.selection.main.head;
                const line = state.doc.lineAt(head);
                publishEditorStatus(
                    statusSourceRef.current,
                    formatCodeMirrorStatus(
                        filename,
                        line.number,
                        head - line.from + 1,
                        languageLabel,
                        isDirtyRef.current,
                    ),
                );
            });
        },
        [filename, languageLabel],
    );

    const resolvedThemeMode = theme === 'light' ? 'light' : 'dark';
    const createTheme = useCallback(
        () => createCodeMirrorTheme(resolvedThemeMode),
        [resolvedThemeMode],
    );

    const handleSave = useCallback(async () => {
        const view = viewRef.current;
        if (!view || isSavingRef.current || saveBlocked) {
            return;
        }

        isSavingRef.current = true;
        setIsSaving(true);

        const savedDocument = view.state.doc;
        const baselineAtSaveStart = savedDocRef.current;
        try {
            await onSave(savedDocument.toString());
            savedDocRef.current = resolveSavedBaseline(
                baselineAtSaveStart,
                savedDocRef.current,
                savedDocument,
            );
            updateDirtyState(
                savedDocRef.current === null || !view.state.doc.eq(savedDocRef.current),
            );
            publishStatus(view.state);
        } catch (error) {
            if (!(error instanceof EditorSaveBlockedError)) {
                showToast('error', editorSaveErrorMessage(error));
            }
        } finally {
            isSavingRef.current = false;
            setIsSaving(false);
            requestAnimationFrame(() => view.focus());
        }
    }, [onSave, publishStatus, saveBlocked, showToast, updateDirtyState]);

    const handleClose = useCallback(async () => {
        if (!isDirtyRef.current) {
            onClose();
            return;
        }

        const confirmed = await showConfirmDialog({
            title: 'Discard unsaved changes?',
            message: `Close ${filename} without saving your changes?`,
            confirmText: 'Discard',
            cancelText: 'Keep Editing',
            variant: 'danger',
        });

        if (confirmed) {
            discardSessionRef.current = true;
            onClose();
        }
    }, [filename, onClose, showConfirmDialog]);

    const openSearch = useCallback(() => {
        const view = viewRef.current;
        if (!view) {
            return;
        }
        openSearchPanel(view);
    }, []);

    const openGoToLineDialog = useCallback(() => {
        const view = viewRef.current;
        if (!view) {
            return;
        }
        const line = view.state.doc.lineAt(view.state.selection.main.head).number;
        setGoToLineValue(String(line));
        setGoToLineError(null);
        setShowGoToLine(true);
        requestAnimationFrame(() => {
            goToLineInputRef.current?.focus();
            goToLineInputRef.current?.select();
        });
    }, []);

    const handleGoToLine = useCallback(() => {
        const view = viewRef.current;
        const target = parseGoToLineInput(goToLineValue, view?.state.doc.lines ?? 1);
        if (!view || !target) {
            setGoToLineError('Enter a valid line number (or line:column).');
            return;
        }
        const lineNumber = target.line;
        const line = view.state.doc.line(lineNumber);
        const to = target.column ? Math.min(line.to, line.from + target.column - 1) : line.from;
        view.dispatch({
            selection: EditorSelection.cursor(to),
            scrollIntoView: true,
        });
        view.focus();
        setGoToLineError(null);
        setShowGoToLine(false);
        publishStatus(view.state);
    }, [goToLineValue, publishStatus]);

    const toggleLineComment = useCallback(
        (view: EditorView) => {
            if (view.state.readOnly) {
                return true;
            }
            if (!lineCommentToken) {
                return false;
            }
            const changes = buildLineCommentChanges(
                view.state.doc.toString(),
                view.state.selection.ranges.map((range) => ({ from: range.from, to: range.to })),
                lineCommentToken,
            );
            if (!changes.length) {
                return true;
            }
            view.dispatch({ changes });
            return true;
        },
        [lineCommentToken],
    );

    saveRef.current = handleSave;
    closeRef.current = handleClose;
    toggleCommentRef.current = toggleLineComment;

    useEffect(() => {
        const container = containerRef.current;
        if (!container || viewRef.current) {
            return;
        }
        const initialTheme = createCodeMirrorTheme(resolvedThemeMode);

        const keyBindings = [
            {
                key: 'Mod-s',
                preventDefault: true,
                /** Invoke the current save handler from the editor-owned shortcut. */
                run: () => {
                    void saveRef.current();
                    return true;
                },
            },
            {
                key: 'Mod-/',
                run: (view: EditorView) => toggleCommentRef.current(view),
            },
            {
                key: 'Mod-Shift-7',
                run: (view: EditorView) => toggleCommentRef.current(view),
            },
            {
                key: 'Mod-f',
                /** Open the CodeMirror search panel from the editor-owned shortcut. */
                run: (view: EditorView) => {
                    openSearchPanel(view);
                    return true;
                },
            },
            {
                key: 'Mod-g',
                /** Open the line/column navigation dialog from the editor-owned shortcut. */
                run: () => {
                    openGoToLineDialog();
                    return true;
                },
            },
        ];

        // Tauri nonces the bundled <style> in release builds. CodeMirror mounts
        // its layout CSS later, so its generated <style> needs that same nonce.
        const styleNonce = getCspStyleNonce();
        const extensions: Extension[] = [
            ...(styleNonce ? [EditorView.cspNonce.of(styleNonce)] : []),
            ...createCodeMirrorExtensions({
                keyBindings,
                richEditing: performanceMode.kind === 'full',
                /** Update dirty state and cursor status only for relevant editor transactions. */
                onUpdate: (update) => {
                    if (update.docChanged) {
                        const savedDocument = savedDocRef.current;
                        updateDirtyState(
                            savedDocument ? !update.state.doc.eq(savedDocument) : true,
                        );
                    }

                    if (update.docChanged || update.selectionSet) {
                        publishStatus(update.state);
                    }
                },
            }),
            EditorView.domEventHandlers({
                /** Route recognized comment shortcuts through the current language policy. */
                keydown: (event, view) => {
                    if (isCommentShortcut(event)) {
                        event.preventDefault();
                        return toggleCommentRef.current(view);
                    }

                    return false;
                },
            }),
            languageCompartment.of([]),
            readOnlyCompartment.of(EditorState.readOnly.of(saveBlocked)),
            themeCompartment.of([
                initialTheme,
                syntaxHighlighting(createCodeMirrorHighlightStyle(resolvedThemeMode), {
                    fallback: true,
                }),
            ]),
        ];

        const cachedSession = takeCodeMirrorSession(sessionKey);
        let restoredSession: typeof cachedSession = null;
        let state: EditorState;

        if (cachedSession?.savedContent === initialContent) {
            try {
                state = EditorState.fromJSON(
                    cachedSession.state,
                    { extensions },
                    { history: historyField },
                );
                restoredSession = cachedSession;
            } catch {
                state = EditorState.create({ doc: initialContent, extensions });
            }
        } else {
            state = EditorState.create({ doc: initialContent, extensions });
        }

        const view = new EditorView({
            state,
            parent: container,
        });
        const stopObservingLayout = observeCodeMirrorLayout(container, view);

        viewRef.current = view;
        savedDocRef.current = view.state.toText(restoredSession?.savedContent ?? initialContent);
        updateDirtyState(!view.state.doc.eq(savedDocRef.current));
        discardSessionRef.current = false;
        publishStatus(view.state);
        const initialFocusFrame = requestAnimationFrame(() => {
            if (restoredSession) {
                view.scrollDOM.scrollLeft = restoredSession.scrollLeft;
                view.scrollDOM.scrollTop = restoredSession.scrollTop;
            }
            view.focus();
        });

        return () => {
            cancelAnimationFrame(initialFocusFrame);
            if (statusFrameRef.current !== null) {
                cancelAnimationFrame(statusFrameRef.current);
                statusFrameRef.current = null;
            }
            if (discardSessionRef.current) {
                deleteCodeMirrorSession(sessionKey);
            } else if (
                canSerializeCodeMirrorSession(
                    view.state,
                    savedDocRef.current?.length ?? initialContent.length,
                )
            ) {
                saveCodeMirrorSession(sessionKey, {
                    savedContent: savedDocRef.current?.toString() ?? initialContent,
                    scrollLeft: view.scrollDOM.scrollLeft,
                    scrollTop: view.scrollDOM.scrollTop,
                    state: view.state.toJSON({ history: historyField }),
                });
            } else {
                deleteCodeMirrorSession(sessionKey);
            }

            stopObservingLayout();
            view.destroy();
            viewRef.current = null;
            savedDocRef.current = null;
        };
    }, [
        filename,
        openGoToLineDialog,
        performanceMode.kind,
        publishStatus,
        sessionKey,
        updateDirtyState,
    ]);

    useEffect(() => {
        viewRef.current?.dispatch({
            effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(saveBlocked)),
        });
    }, [readOnlyCompartment, saveBlocked]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) {
            return;
        }

        view.dispatch({
            effects: languageCompartment.reconfigure([]),
        });

        if (performanceMode.kind === 'large-file') {
            return;
        }

        let cancelled = false;
        void loadCodeMirrorLanguage(filename)
            .then((language) => {
                if (cancelled || viewRef.current !== view) {
                    return;
                }
                view.dispatch({
                    effects: languageCompartment.reconfigure(language),
                });
            })
            .catch((error) => {
                if (cancelled) {
                    return;
                }
                const message = error instanceof Error ? error.message : String(error);
                showToast('warning', `Syntax support could not be loaded: ${message}`);
            });

        return () => {
            cancelled = true;
        };
    }, [filename, languageCompartment, performanceMode.kind, showToast]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) {
            return;
        }
        view.dispatch({
            effects: themeCompartment.reconfigure([
                createTheme(),
                syntaxHighlighting(createCodeMirrorHighlightStyle(resolvedThemeMode), {
                    fallback: true,
                }),
            ]),
        });
    }, [createTheme, resolvedThemeMode, themeCompartment]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) {
            return;
        }
        const current = view.state.doc.toString();
        if (current === initialContent) {
            savedDocRef.current = view.state.doc;
            updateDirtyState(false);
            publishStatus(view.state);
            return;
        }

        if (savedDocRef.current?.toString() === initialContent) {
            return;
        }

        /** Reconcile externally refreshed content with the active document and saved baseline. */
        const applyIncomingContent = () => {
            view.dispatch({
                changes: {
                    from: 0,
                    to: view.state.doc.length,
                    insert: initialContent,
                },
                annotations: Transaction.addToHistory.of(false),
            });
            savedDocRef.current = view.state.doc;
            updateDirtyState(false);
            publishStatus(view.state);
        };

        if (!isDirtyRef.current) {
            applyIncomingContent();
            return;
        }

        let cancelled = false;
        void (async () => {
            const confirmed = await showConfirmDialog({
                title: 'Replace unsaved changes?',
                message: `${filename} has unsaved edits. Reload incoming content and discard current edits?`,
                confirmText: 'Reload',
                cancelText: 'Keep Editing',
                variant: 'danger',
            });
            if (!confirmed || cancelled) {
                return;
            }
            applyIncomingContent();
        })();

        return () => {
            cancelled = true;
        };
    }, [filename, initialContent, publishStatus, showConfirmDialog, updateDirtyState]);

    useEffect(() => () => clearEditorStatus(statusSourceRef.current), []);

    return (
        <div
            className="absolute inset-0 z-[70] flex min-h-0 flex-col bg-app-panel"
            onKeyDownCapture={(event) => {
                if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'w') {
                    return;
                }

                event.preventDefault();
                event.stopPropagation();
                event.nativeEvent.stopImmediatePropagation();
                void closeRef.current();
            }}
        >
            {!hideToolbar && (
                <CodeMirrorToolbar
                    filename={filename}
                    isDirty={isDirty}
                    isSaving={isSaving}
                    saveAccess={saveAccess}
                    onClose={() => {
                        void closeRef.current();
                    }}
                    onGoToLine={openGoToLineDialog}
                    onOpenSearch={openSearch}
                    onSave={() => {
                        void saveRef.current();
                    }}
                />
            )}

            <div className="flex min-h-0 flex-1 flex-col">
                {hideToolbar && saveBlocked && (
                    <div className="border-b border-app-border px-3 py-1">
                        <EditorSaveAccessStatus access={saveAccess} />
                    </div>
                )}
                {performanceMode.kind === 'large-file' && (
                    <div className="border-b border-app-border bg-app-surface/40 px-3 py-1.5 text-xs text-app-muted">
                        Large-file mode: syntax analysis, folding, and completion are paused to keep
                        editing responsive.
                    </div>
                )}

                {showGoToLine && (
                    <GoToLinePanel
                        error={goToLineError}
                        inputRef={goToLineInputRef}
                        maxLine={viewRef.current?.state.doc.lines ?? 1}
                        value={goToLineValue}
                        onCancel={() => {
                            setShowGoToLine(false);
                            setGoToLineError(null);
                            requestAnimationFrame(() => viewRef.current?.focus());
                        }}
                        onChange={(value) => {
                            setGoToLineValue(value);
                            if (goToLineError) {
                                setGoToLineError(null);
                            }
                        }}
                        onSubmit={handleGoToLine}
                    />
                )}

                <div
                    className="min-h-0 flex-1 overflow-hidden bg-app-bg"
                    onMouseDown={(event) => {
                        event.stopPropagation();
                        const target = event.target as HTMLElement | null;
                        if (target?.closest('.cm-panels')) {
                            return;
                        }
                        requestAnimationFrame(() => viewRef.current?.focus());
                    }}
                    onClick={(event) => {
                        event.stopPropagation();
                        const target = event.target as HTMLElement | null;
                        if (target?.closest('.cm-panels')) {
                            return;
                        }
                        viewRef.current?.focus();
                    }}
                >
                    <div
                        ref={containerRef}
                        className="h-full w-full"
                    />
                </div>
            </div>
        </div>
    );
}
