import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

export type ContextMenuItem =
  | {
    label: string;
    icon?: React.ReactNode;
    action: () => void;
    variant?: 'default' | 'danger';
    disabled?: boolean;
    separator?: never;
  }
  | {
    separator: true;
  };

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleScroll = () => {
      // Close on scroll to avoid detached menu
      onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [onClose]);

  // Simple boundary checking to keep menu on screen
  const style: React.CSSProperties = {
    top: y,
    left: x,
  };

  // Adjust if too close to edge (simple check)
  if (x + 200 > window.innerWidth) {
    style.left = x - 200;
  }
  if (y + 200 > window.innerHeight) {
    style.top = y - 200; // rough height estimate
  }

  return createPortal(
    <div
      ref={ref}
      style={style}
      className="fixed z-50 w-52 rounded-xl border border-app-border/50 bg-app-panel shadow-xl overflow-hidden text-sm animate-in fade-in zoom-in-95 duration-100 ring-1 ring-white/5 context-menu-container flex flex-col py-1"
    >
      {items.map((item, i) => {
        if ('separator' in item) {
          return <div key={i} className="h-[1px] bg-app-border/50 my-1 mx-2" />;
        }

        return (
          <button
            key={i}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.action();
              onClose();
            }}
            className={cn(
              'w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors relative mx-1 rounded-md text-xs',
              // Fix width to account for margins
              'w-[calc(100%-8px)]',
              item.disabled
                ? 'text-app-muted/50 cursor-not-allowed'
                : item.variant === 'danger'
                  ? 'text-app-danger hover:bg-app-danger/10'
                  : 'text-app-text hover:bg-app-surface',
            )}
          >
            {item.icon && <span className="text-current opacity-80">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
