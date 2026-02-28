import { X } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../../lib/utils';
import { Button } from './Button';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
  className?: string;
}

/**
 * Render a centered modal dialog into document.body.
 *
 * @param isOpen - Whether the modal is visible.
 * @param onClose - Callback invoked to close the modal (overlay click, Escape key, or close button).
 * @param title - Header title text displayed at the top of the modal.
 * @param children - Modal content.
 * @param width - Tailwind width utility applied to the dialog container (default 'max-w-md').
 * @param className - Additional classes merged into the dialog container.
 * @returns The modal element mounted into document.body when `isOpen` is true, otherwise null.
 */
export function Modal({ isOpen, onClose, title, children, width = 'max-w-md', className }: ModalProps) {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleEsc, { capture: true });
    return () => window.removeEventListener('keydown', handleEsc, { capture: true });
  }, [isOpen, onClose]);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/70 backdrop-blur-md"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: 'spring', duration: 0.2, bounce: 0.2 }}
            className={cn(
              'relative w-full bg-app-panel backdrop-blur-xl border border-app-border rounded-xl shadow-2xl flex flex-col max-h-[90vh] ring-1 ring-black/5 dark:ring-white/5',
              width,
              className
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-5 border-b border-app-border/50">
              <h3 className="text-lg font-semibold text-app-text tracking-tight">{title}</h3>
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="h-8 w-8 rounded-full text-app-muted hover:bg-app-accent hover:text-white transition-all hover:scale-110 active:scale-95 hover:shadow-lg hover:shadow-app-accent/20"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="p-6 overflow-y-auto custom-scrollbar flex-1">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
