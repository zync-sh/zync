import { X } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { ZPortal } from './ZPortal';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../../lib/utils';
import { Button } from './Button';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  width?: string;
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
  titleClassName?: string;
}

/**
 * Render a centered modal dialog into the ZPortal target (defaults to 'modal-portal-root').
 *
 * @param isOpen - Whether the modal is visible.
 * @param onClose - Callback invoked to close the modal (overlay click, Escape key, or close button).
 * @param title - Header title text displayed at the top of the modal.
 * @param subtitle - Optional secondary text shown under the title in the modal header.
 * @param children - Modal content.
 * @param width - Tailwind width utility applied to the dialog container (default 'max-w-md').
 * @param className - Additional classes merged into the dialog container.
 * @param headerClassName - Optional classes applied to the modal header container.
 * @param contentClassName - Optional classes applied to the modal body/content container.
 * @param titleClassName - Optional classes applied to the modal title text.
 * @returns The modal element mounted into the ZPortal target when `isOpen` is true, otherwise null.
 */
export function Modal({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  width = 'max-w-md',
  className,
  headerClassName,
  contentClassName,
  titleClassName,
}: ModalProps) {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (document.querySelector('[data-zync-select-open="true"]')) return;
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleEsc, { capture: true });
    return () => window.removeEventListener('keydown', handleEsc, { capture: true });
  }, [isOpen, onClose]);

  return (
    <ZPortal>
      <AnimatePresence>
        {isOpen && (
          <div className="absolute inset-0 z-[9999] flex items-center justify-center p-4">
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
                'relative w-full bg-app-panel backdrop-blur-xl border border-app-border rounded-xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden ring-1 ring-black/5 dark:ring-white/5',
                width,
                className
              )}
              data-zync-modal-surface="true"
              onClick={(e) => e.stopPropagation()}
            >
              <div className={cn("flex items-start justify-between p-5 border-b border-app-border/50", headerClassName)}>
                <div className="min-w-0 pr-2">
                  <h3 className={cn("text-lg font-semibold text-app-text tracking-tight", titleClassName)}>{title}</h3>
                  {subtitle && (
                    <p className="mt-1 text-xs text-app-muted leading-relaxed">{subtitle}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onClose}
                  className="h-8 w-8 rounded-full text-app-muted hover:bg-app-accent hover:text-white transition-all hover:scale-110 active:scale-95 hover:shadow-lg hover:shadow-app-accent/20"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <div className={cn("p-6 overflow-y-auto custom-scrollbar flex-1", contentClassName)}>{children}</div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </ZPortal>
  );
}
