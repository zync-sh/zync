import { GripHorizontal, X } from 'lucide-react';
import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ZPortal } from './ZPortal';
import { motion, AnimatePresence, useDragControls, useMotionValue, useReducedMotion } from 'framer-motion';
import { cn } from '../../lib/utils';
import { Button } from './Button';
import { DIALOG_SURFACE_CLASSES } from './surfaceStyles';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Share visible, enabled Tab candidates between initial focus and focus wrapping.
 * Client rects exclude hidden ancestors without excluding fixed-position controls.
 * Do not filter opacity: the dialog itself fades in while acquiring focus.
 */
function getFocusableControls(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(element => {
    if (element.tabIndex < 0 || element.matches(':disabled, input[type="hidden"]')
      || element.closest('[inert]') || element.getClientRects().length === 0) return false;
    const visibility = getComputedStyle(element).visibility;
    return visibility !== 'hidden' && visibility !== 'collapse';
  });
}

const DRAG_BLOCK_SELECTOR = 'button, a, input, textarea, select, [role="button"], [data-no-modal-drag="true"]';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  width?: string;
  /** Initial dialog anchor; dragging still works and resets on each open. */
  placement?: 'center' | 'bottom-right';
  /** Lighter dimming for compact dialogs; standard dialogs keep their backdrop. */
  backdrop?: 'default' | 'subtle';
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
  titleClassName?: string;
  closeOnEsc?: boolean;
  closeOnOverlayClick?: boolean;
  showCloseButton?: boolean;
  /** When true, only in-content actions dismiss the modal (no Escape, overlay, or header X). */
  explicitDismissOnly?: boolean;
  /** Optional custom z-index class for the modal wrapper and overlay (defaults to 'z-[9999]') */
  zIndexClassName?: string;
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
 * @param closeOnEsc - Whether pressing Escape closes the modal (default true).
 * @param closeOnOverlayClick - Whether clicking the overlay closes the modal (default true).
 * @param showCloseButton - Whether to render the close button in the header (default true).
 * @param explicitDismissOnly - When true, only in-content actions dismiss the modal (Escape, overlay, and header X are disabled).
 * @returns The modal element mounted into the ZPortal target when `isOpen` is true, otherwise null.
 */
export function Modal({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  width = 'max-w-md',
  placement = 'center',
  backdrop = 'default',
  className,
  headerClassName,
  contentClassName,
  titleClassName,
  closeOnEsc = true,
  closeOnOverlayClick = true,
  showCloseButton = true,
  explicitDismissOnly = false,
  zIndexClassName,
}: ModalProps) {
  const titleId = useId();
  const subtitleId = useId();
  const reduceMotion = useReducedMotion();
  const [dialogElement, setDialogElement] = useState<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const dragConstraintsRef = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const effectiveCloseOnEsc = explicitDismissOnly ? false : closeOnEsc;
  const effectiveCloseOnOverlayClick = explicitDismissOnly ? false : closeOnOverlayClick;
  const effectiveShowCloseButton = explicitDismissOnly
    ? false
    : (closeOnEsc || closeOnOverlayClick || showCloseButton ? showCloseButton : true);

  useEffect(() => {
    if (
      import.meta.env.DEV
      && !explicitDismissOnly
      && !closeOnEsc
      && !closeOnOverlayClick
      && !showCloseButton
    ) {
      console.warn(
        '[Modal] closeOnEsc, closeOnOverlayClick, and showCloseButton are all false; forcing close button for accessibility.'
      );
    }
  }, [explicitDismissOnly, closeOnEsc, closeOnOverlayClick, showCloseButton]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (document.querySelector('[data-zync-select-open="true"]')) return;
      if (e.key === 'Escape') onClose();
    };
    if (isOpen && effectiveCloseOnEsc) {
      window.addEventListener('keydown', handleEsc, { capture: true });
    }
    return () => window.removeEventListener('keydown', handleEsc, { capture: true });
  }, [effectiveCloseOnEsc, isOpen, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    x.set(0);
    y.set(0);
  }, [isOpen, x, y]);

  // Capture the opener before ZPortal's passive mount can auto-focus a child.
  // Keep the saved opener stable across dialog/content ref updates.
  useLayoutEffect(() => {
    if (!isOpen) return;
    openerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }, [isOpen]);

  // ZPortal mounts asynchronously: acquire focus only after the dialog exists.
  useEffect(() => {
    if (!isOpen || !dialogElement) return;
    const previouslyFocused = openerRef.current;
    const frame = window.requestAnimationFrame(() => {
      for (const control of getFocusableControls(dialogElement)) {
        control.focus();
        // Some rendered candidates still reject focus (e.g. closed content).
        if (dialogElement.ownerDocument.activeElement === control) return;
      }
      dialogElement.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      // Restore after the closing commit, not during layout-effect teardown.
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [isOpen, dialogElement]);

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;

    const dialog = dialogElement;
    if (!dialog) return;

    const focusable = getFocusableControls(dialog);

    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleDragHandlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest(DRAG_BLOCK_SELECTOR)) return;
    dragControls.start(event.nativeEvent);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <ZPortal passive key={titleId}>
          <motion.div
            ref={dragConstraintsRef}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, pointerEvents: 'none' }}
            transition={{ duration: reduceMotion ? 0 : 0.15, ease: 'easeOut' }}
            className={cn(
              "absolute inset-0 flex p-4 pointer-events-none",
              placement === 'bottom-right' ? 'items-end justify-end' : 'items-center justify-center',
              zIndexClassName ?? "z-[9999]"
            )}
          >
            <motion.div
              aria-hidden
              initial={false}
              animate={{ pointerEvents: 'auto' }}
              exit={{ pointerEvents: 'none' }}
              onClick={effectiveCloseOnOverlayClick ? onClose : undefined}
              className={cn('absolute inset-0', backdrop === 'subtle' ? 'bg-black/15' : 'bg-black/70')}
            />
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: reduceMotion ? 1 : 0.96, y: reduceMotion ? 0 : 8, pointerEvents: 'none' }}
              transition={{ duration: reduceMotion ? 0 : 0.15, ease: 'easeOut' }}
              drag
              dragControls={dragControls}
              dragListener={false}
              dragConstraints={dragConstraintsRef}
              dragElastic={0}
              dragMomentum={false}
              style={{ x, y }}
              className={cn(
                DIALOG_SURFACE_CLASSES,
                'relative w-full flex flex-col max-h-[90vh] overflow-hidden transition-[max-width] duration-150 motion-reduce:transition-none pointer-events-auto',
                width,
                className
              )}
              ref={setDialogElement}
              data-zync-modal-surface="true"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={subtitle ? subtitleId : undefined}
              tabIndex={-1}
              onKeyDown={handleDialogKeyDown}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                className={cn("flex items-start justify-between p-5 border-b border-app-border/50 cursor-move active:cursor-grabbing select-none", headerClassName)}
                onPointerDown={handleDragHandlePointerDown}
              >
                <div className="min-w-0 pr-2">
                  <h3 id={titleId} className={cn("text-lg font-semibold text-app-text tracking-tight", titleClassName)}>{title}</h3>
                  {subtitle && (
                    <p id={subtitleId} className="mt-1 text-xs text-app-muted leading-relaxed">{subtitle}</p>
                  )}
                </div>
                <GripHorizontal
                  aria-hidden="true"
                  className="mx-3 mt-1 h-4 w-4 shrink-0 text-app-muted/45"
                />
                {effectiveShowCloseButton && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={onClose}
                    aria-label="Close"
                    className="h-8 w-8 shrink-0"
                  >
                    <X aria-hidden="true" className="h-4 w-4" />
                  </Button>
                )}
              </div>
              <div className={cn("p-6 overflow-y-auto custom-scrollbar flex-1", contentClassName)}>{children}</div>
            </motion.div>
          </motion.div>
        </ZPortal>
      )}
    </AnimatePresence>
  );
}
