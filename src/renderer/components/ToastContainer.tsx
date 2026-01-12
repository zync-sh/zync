import { AlertCircle, CheckCircle, Info, X, XCircle } from 'lucide-react';
import { useAppStore, type Toast, type ToastType } from '../store/useAppStore';
import { cn } from '../lib/utils';

export function ToastContainer() {
    const toasts = useAppStore((state) => state.toasts);
    const removeToast = useAppStore((state) => state.removeToast);

    return (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 pointer-events-none">
            {toasts.map((toast: Toast) => (
                <ToastItem key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
            ))}
        </div>
    );
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
    const icons: Record<ToastType, React.ReactElement> = {
        success: <CheckCircle className="h-5 w-5" style={{ color: 'var(--color-app-success)' }} />,
        error: <XCircle className="h-5 w-5" style={{ color: 'var(--color-app-danger)' }} />,
        warning: <AlertCircle className="h-5 w-5" style={{ color: 'var(--color-app-warning)' }} />,
        info: <Info className="h-5 w-5" style={{ color: 'var(--color-app-accent)' }} />,
    };

    const styles: Record<ToastType, string> = {
        success: 'bg-app-surface border-app-success/30 text-app-text',
        error: 'bg-app-surface border-app-danger/30 text-app-text',
        warning: 'bg-app-surface border-app-warning/30 text-app-text',
        info: 'bg-app-surface border-app-accent/30 text-app-text',
    };

    return (
        <div
            className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-lg border backdrop-blur-sm shadow-lg animate-in slide-in-from-bottom duration-200 pointer-events-auto min-w-[300px] max-w-md',
                styles[toast.type],
            )}
        >
            {icons[toast.type]}
            <span className="flex-1 text-sm font-medium">{toast.message}</span>
            <button onClick={onClose} className="hover:opacity-70 transition-opacity">
                <X className="h-4 w-4" />
            </button>
        </div>
    );
}
