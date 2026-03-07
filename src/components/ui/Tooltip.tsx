import { type ReactNode, useState, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

interface TooltipProps {
  content: string;
  children: ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}

export function Tooltip({ content, children, position = 'top', className }: TooltipProps) {
  const [show, setShow] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (show && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const spacing = 8; // Distance from trigger

      let top = 0;
      let left = 0;

      switch (position) {
        case 'top':
          top = rect.top - spacing;
          left = rect.left + rect.width / 2;
          break;
        case 'bottom':
          top = rect.bottom + spacing;
          left = rect.left + rect.width / 2;
          break;
        case 'left':
          top = rect.top + rect.height / 2;
          left = rect.left - spacing;
          break;
        case 'right':
          top = rect.top + rect.height / 2;
          left = rect.right + spacing;
          break;
      }

      setCoords({ top, left });
    }
  }, [show, position]);

  return (
    <div
      ref={triggerRef}
      className={cn("relative inline-flex items-center justify-center", className)}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
      onFocus={() => setShow(true)}
      onBlur={() => setShow(false)}
    >
      {children}
      {show && createPortal(
        <div
          style={{ top: coords.top, left: coords.left }}
          className={cn(
            "fixed px-2.5 py-1.5 bg-app-panel/95 backdrop-blur-md text-app-text text-xs font-medium rounded-md whitespace-nowrap shadow-xl border border-app-border z-[9999] animate-in fade-in duration-150 pointer-events-none",
            position === 'top' ? "-translate-y-full -translate-x-1/2 slide-in-from-bottom-1" :
              position === 'bottom' ? "-translate-x-1/2 slide-in-from-top-1" :
                position === 'left' ? "-translate-x-full -translate-y-1/2 slide-in-from-right-1" :
                  "-translate-y-1/2 slide-in-from-left-1"
          )}
        >
          {content}
        </div>,
        document.body
      )}
    </div>
  );
}
