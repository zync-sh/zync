import { X } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';
import { Button } from './Button';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
}

export function Modal({ isOpen, onClose, title, children, width = 'max-w-md' }: ModalProps) {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleEsc, { capture: true });
    return () => window.removeEventListener('keydown', handleEsc, { capture: true });
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-4 animate-in fade-in duration-300">
      <div
        className={cn(
          'w-full bg-app-panel/95 backdrop-blur-xl border border-app-border rounded-xl shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-2 duration-300 flex flex-col max-h-[90vh] ring-1 ring-white/5',
          width,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-app-border/50">
          <h3 className="text-lg font-semibold text-app-text tracking-tight">{title}</h3>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-8 w-8 rounded-full hover:bg-app-accent/10 hover:text-white transition-colors"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="p-6 overflow-y-auto custom-scrollbar">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
