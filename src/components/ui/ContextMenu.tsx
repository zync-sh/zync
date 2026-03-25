import { useEffect, useRef, useState } from 'react';
import { ZPortal } from './ZPortal';
import { cn } from '../../lib/utils';
import { ChevronRight } from 'lucide-react';

export type ContextMenuItem =
  | {
    label: string;
    icon?: React.ReactNode;
    action: () => void;
    children?: never;
    variant?: 'default' | 'danger';
    disabled?: boolean;
    separator?: never;
  }
  | {
    label: string;
    icon?: React.ReactNode;
    action?: never;
    children: ContextMenuItem[];
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

  return (
    <ZPortal>
      <div
        ref={ref}
        style={style}
        className="absolute z-50 w-52 rounded-xl border border-app-border/50 bg-app-panel shadow-xl text-sm animate-in fade-in zoom-in-95 duration-100 ring-1 ring-white/5 context-menu-container flex flex-col py-1"
      >
        {items.map((item, i) => (
          <MenuItem key={i} item={item} onClose={onClose} />
        ))}
      </div>
    </ZPortal>
  );
}

function MenuItem({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const itemRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [submenuDirection, setSubmenuDirection] = useState<'right' | 'left'>('right');
  const [submenuTop, setSubmenuTop] = useState(0);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (isOpen && itemRef.current && item.separator !== true && item.children) {
      const rect = itemRef.current.getBoundingClientRect();
      const spaceRight = window.innerWidth - rect.right;
      
      // Determine L/R placement
      if (spaceRight < 200) {
        setSubmenuDirection('left');
      } else {
        setSubmenuDirection('right');
      }
      
      // Prevent off-screen vertical overflow
      const spaceBottom = window.innerHeight - rect.top;
      const estimatedHeight = (item.children.length) * 32 + 10;
      if (spaceBottom < estimatedHeight) {
        const offset = spaceBottom - estimatedHeight - 10;
        setSubmenuTop(Math.max(offset, -rect.top));
      } else {
        setSubmenuTop(0);
      }
    }
  }, [isOpen, item]);

  if ('separator' in item) {
    return <div className="h-[1px] bg-app-border/50 my-1 mx-2" />;
  }

  const hasChildren = item.children && item.children.length > 0;

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setIsOpen(true);
  };

  const handleMouseLeave = () => {
    timeoutRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 150);
  };

  return (
    <div
      ref={itemRef}
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        disabled={item.disabled}
        onClick={(e) => {
          if (hasChildren) {
            e.preventDefault();
            e.stopPropagation();
            setIsOpen(!isOpen);
            return;
          }
          if (item.action) {
             item.action();
             onClose();
          }
        }}
        className={cn(
          'flex items-center justify-between px-3 py-1.5 text-left transition-colors mx-1 rounded-md text-xs',
          'w-[calc(100%-8px)]',
          item.disabled
            ? 'text-app-muted/50 cursor-not-allowed'
            : item.variant === 'danger'
              ? 'text-app-danger hover:bg-app-danger/10'
              : 'text-app-text hover:bg-app-surface',
          isOpen && hasChildren && 'bg-app-surface'
        )}
      >
        <div className="flex items-center gap-2.5">
          {item.icon && <span className="text-current opacity-80">{item.icon}</span>}
          <span>{item.label}</span>
        </div>
        {hasChildren && <ChevronRight size={14} className="opacity-50" />}
      </button>

      {isOpen && hasChildren && (
        <div 
           className={cn(
             "absolute w-52 bg-app-panel border border-app-border/50 rounded-xl shadow-xl py-1 z-50 flex flex-col animate-in fade-in zoom-in-95 duration-100",
             submenuDirection === 'right' ? 'left-full ml-1' : 'right-full mr-1'
           )}
           style={{ top: submenuTop }}
        >
          {item.children!.map((child, i) => (
            <MenuItem key={i} item={child} onClose={onClose} />
          ))}
        </div>
      )}
    </div>
  );
}
