import * as Dialog from '@radix-ui/react-dialog';
import { useAppStore } from '../../store/useAppStore';
import { cn } from '../../lib/utils';
import { AlertCircle, HelpCircle } from 'lucide-react';

export function GlobalConfirmDialog() {
    const dialog = useAppStore(state => state.confirmDialog);
    const closeDialog = useAppStore(state => state.closeConfirmDialog);

    if (!dialog) return null;

    const isDanger = dialog.variant === 'danger';
    const Icon = isDanger ? AlertCircle : HelpCircle;

    const handleOpenChange = (open: boolean) => {
        if (!open) {
            // If closed via ESC or outside click, treat as cancel
            dialog.onCancel();
            closeDialog();
        }
    };

    return (
        <Dialog.Root open={!!dialog} onOpenChange={handleOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-[20000] bg-black/60 backdrop-blur-sm animate-in fade-in" />
                <Dialog.Content
                    className={cn(
                        "fixed z-[20000] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2",
                        "w-full max-w-md bg-[var(--color-app-bg)] rounded-xl border border-[var(--color-app-border)]",
                        "shadow-2xl flex flex-col overflow-hidden",
                        "animate-in fade-in zoom-in-95 duration-200"
                    )}
                >
                    <div className="p-6">
                        <div className="flex gap-4">
                            <div className={cn(
                                "shrink-0 w-10 h-10 rounded-full flex items-center justify-center",
                                isDanger ? "bg-red-500/10 text-red-500" : "bg-[var(--color-app-accent)]/10 text-[var(--color-app-accent)]"
                            )}>
                                <Icon className="w-5 h-5" />
                            </div>
                            <div className="flex-1 space-y-2 pt-1">
                                <Dialog.Title className="text-lg font-semibold text-[var(--color-app-text)]">
                                    {dialog.title}
                                </Dialog.Title>
                                <Dialog.Description className="text-sm text-[var(--color-app-muted)] leading-relaxed">
                                    {dialog.message}
                                </Dialog.Description>
                            </div>
                        </div>
                    </div>

                    <div className="p-4 bg-[var(--color-app-bg-secondary)] border-t border-[var(--color-app-border)] flex justify-end gap-3">
                        <button
                            onClick={() => {
                                dialog.onCancel();
                            }}
                            className="px-4 py-2 rounded-lg text-sm font-medium text-[var(--color-app-text)] hover:bg-[var(--color-app-bg-hover)] transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--color-app-accent)]"
                        >
                            {dialog.cancelText || 'Cancel'}
                        </button>
                        <button
                            onClick={() => {
                                dialog.onConfirm();
                            }}
                            className={cn(
                                "px-4 py-2 rounded-lg text-sm font-medium text-white transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[var(--color-app-bg)]",
                                isDanger
                                    ? "bg-red-500 hover:bg-red-600 focus:ring-red-500"
                                    : "bg-[var(--color-app-accent)] hover:brightness-110 focus:ring-[var(--color-app-accent)]"
                            )}
                        >
                            {dialog.confirmText || 'Confirm'}
                        </button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
}
