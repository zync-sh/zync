import { AlertTriangle, Info } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';
import { cn } from '../../lib/utils';

interface ConfirmModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string | React.ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'primary' | 'danger';
    isLoading?: boolean;
}

export function ConfirmModal({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    variant = 'primary',
    isLoading
}: ConfirmModalProps) {
    const isDanger = variant === 'danger';

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={title}
            width="max-w-sm"
        >
            <div className="flex flex-col py-2">
                <div className="flex items-start gap-4 mb-6 px-1">
                    <div className={cn(
                        "w-10 h-10 shrink-0 rounded-full flex items-center justify-center shadow-xl ring-1",
                        isDanger
                            ? "bg-red-500/10 border-red-500/30 text-red-400 ring-red-500/20"
                            : "bg-app-accent/10 border-app-accent/30 text-app-accent ring-app-accent/20"
                    )}>
                        {isDanger ? <AlertTriangle size={20} /> : <Info size={20} />}
                    </div>
                    <div className="flex-1 pt-1">
                        <p className="text-app-text/70 text-[12px] leading-relaxed font-medium">
                            {message}
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2 justify-end">
                    <Button
                        variant="ghost"
                        onClick={onClose}
                        className="px-4 h-8 font-bold text-[10px] uppercase tracking-widest hover:bg-white/[0.05]"
                        disabled={isLoading}
                    >
                        {cancelLabel}
                    </Button>
                    <Button
                        variant={variant}
                        onClick={onConfirm}
                        isLoading={isLoading}
                        className={cn(
                            "px-6 h-8 font-bold text-[10px] uppercase tracking-widest min-w-[100px]",
                            isDanger && "bg-red-500 hover:bg-red-600 border-0 text-white shadow-lg shadow-red-500/20"
                        )}
                    >
                        {confirmLabel}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
