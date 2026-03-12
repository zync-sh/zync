import { Check, X, XCircle, AlertTriangle, Info as InfoIcon } from 'lucide-react';
import { ZPortal } from './ZPortal';
import { useAppStore } from '../../store/useAppStore';
import type { Toast, ToastType } from '../../store/toastSlice';

export type { ToastType };

export function ToastContainer() {
    const toasts = useAppStore(state => state.toasts);
    const removeToast = useAppStore(state => state.removeToast);

    if (toasts.length === 0) return null;

    return (
        <ZPortal className="absolute bottom-8 left-1/2 -translate-x-1/2 z-[10000] flex flex-col items-center gap-2 pointer-events-auto">
            {toasts.map((toast: Toast) => (
                <div
                    key={toast.id}
                    role={toast.type === 'error' ? 'alert' : 'status'}
                    aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
                    className={`
                        flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border backdrop-blur-xl
                        animate-in slide-in-from-bottom-3 fade-in duration-300
                        ${toast.type === 'success' ? 'bg-app-panel/90 border-green-500/30 text-green-400' : ''}
                        ${toast.type === 'error' ? 'bg-app-panel/90 border-red-500/30 text-red-400' : ''}
                        ${toast.type === 'warning' ? 'bg-app-panel/90 border-yellow-500/30 text-yellow-400' : ''}
                        ${toast.type === 'info' ? 'bg-app-panel/90 border-app-border text-app-text' : ''}
                    `}
                >
                    {toast.type === 'success' && <Check className="w-4 h-4 shrink-0" />}
                    {toast.type === 'error' && <XCircle className="w-4 h-4 shrink-0" />}
                    {toast.type === 'warning' && <AlertTriangle className="w-4 h-4 shrink-0" />}
                    {toast.type === 'info' && <InfoIcon className="w-4 h-4 shrink-0" />}
                    <span className="text-sm font-medium">{toast.message}</span>
                    <button
                        onClick={() => removeToast(toast.id)}
                        className="opacity-40 hover:opacity-100 transition-opacity ml-1 shrink-0"
                        aria-label="Dismiss notification"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            ))}
        </ZPortal>
    );
}
