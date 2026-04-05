import { StateCreator } from 'zustand';

export interface ConfirmDialogOpts {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'primary' | 'danger';
    onConfirm: () => void;
    onCancel: () => void;
}

export interface UiSlice {
    confirmDialog: ConfirmDialogOpts | null;
    showConfirmDialog: (opts: Omit<ConfirmDialogOpts, 'onConfirm' | 'onCancel'>) => Promise<boolean>;
    closeConfirmDialog: () => void;
    _resolveConfirm: ((value: boolean) => void) | null;
    editorDiagnosticsVisible: boolean;
    editorDiagnosticsCount: number;
    editorDiagnosticsSeverity: 'warning' | 'error' | null;
    setEditorDiagnosticsVisible: (visible: boolean) => void;
    setEditorDiagnosticsSummary: (count: number, severity: 'warning' | 'error' | null) => void;
    clearEditorDiagnosticsSummary: () => void;
}

export const createUiSlice: StateCreator<UiSlice, [], [], UiSlice> = (set, get) => ({
    confirmDialog: null,
    _resolveConfirm: null,
    editorDiagnosticsVisible: false,
    editorDiagnosticsCount: 0,
    editorDiagnosticsSeverity: null,
    showConfirmDialog: (opts) => {
        return new Promise((resolve) => {
            // Unmount any previous if there was one
            const { _resolveConfirm } = get();
            if (_resolveConfirm) {
                _resolveConfirm(false);
            }

            set({
                confirmDialog: {
                    ...opts,
                    onConfirm: () => {
                        get()._resolveConfirm?.(true);
                        get().closeConfirmDialog();
                    },
                    onCancel: () => {
                        get()._resolveConfirm?.(false);
                        get().closeConfirmDialog();
                    }
                },
                _resolveConfirm: resolve,
            });
        });
    },
    closeConfirmDialog: () => {
        set({ confirmDialog: null, _resolveConfirm: null });
    },
    setEditorDiagnosticsVisible: (visible) => {
        set({ editorDiagnosticsVisible: visible });
    },
    setEditorDiagnosticsSummary: (count, severity) => {
        set({
            editorDiagnosticsCount: count,
            editorDiagnosticsSeverity: severity,
            editorDiagnosticsVisible: count > 0 ? get().editorDiagnosticsVisible : false,
        });
    },
    clearEditorDiagnosticsSummary: () => {
        set({
            editorDiagnosticsCount: 0,
            editorDiagnosticsSeverity: null,
            editorDiagnosticsVisible: false,
        });
    },
});
