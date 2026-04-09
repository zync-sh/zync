import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils.js';
import { ChevronRight } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────

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

// ── Layout constants ───────────────────────────────────────────────

const VIEWPORT_PADDING = 8;
const SUBMENU_GAP = 4;
const SUBMENU_HOVER_DELAY_MS = 150;
const MAX_HEIGHT_RATIO = 0.7;

// ── Shared styles ──────────────────────────────────────────────────

const menuPanelClass =
  'fixed z-[99999] w-52 rounded-xl border border-app-border/50 bg-app-panel shadow-xl text-sm ring-1 ring-white/5 flex flex-col py-1 overflow-y-auto overscroll-contain transition-opacity duration-150';

// ── Position helpers ───────────────────────────────────────────────

interface MenuPosition {
  top: number;
  left: number;
  maxHeight?: number;
}

/** Clamp a menu so it stays within the viewport, flipping direction or enabling scroll as needed. */
function calcPosition(
  anchorX: number,
  anchorY: number,
  menuWidth: number,
  menuHeight: number,
): MenuPosition {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Horizontal: prefer right of anchor, flip left if clipping
  let left = anchorX;
  if (anchorX + menuWidth > vw - VIEWPORT_PADDING) {
    left = Math.max(VIEWPORT_PADDING, anchorX - menuWidth);
  }

  // Vertical: prefer below anchor, flip above if clipping
  let top = anchorY;
  let maxHeight: number | undefined;

  if (anchorY + menuHeight > vh - VIEWPORT_PADDING) {
    const upTop = anchorY - menuHeight;
    if (upTop >= VIEWPORT_PADDING) {
      top = upTop;
    } else {
      top = VIEWPORT_PADDING;
      maxHeight = vh - VIEWPORT_PADDING * 2;
    }
  }

  return { top, left, maxHeight };
}

/** Position a submenu relative to its parent item, with horizontal flip and vertical scroll fallback. */
function calcSubmenuPosition(
  parentRect: DOMRect,
  submenuWidth: number,
  submenuHeight: number,
): MenuPosition {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Horizontal: right → left → edge fallback
  let left: number;
  if (parentRect.right + submenuWidth + VIEWPORT_PADDING <= vw) {
    left = parentRect.right + SUBMENU_GAP;
  } else if (parentRect.left - submenuWidth - SUBMENU_GAP >= VIEWPORT_PADDING) {
    left = parentRect.left - submenuWidth - SUBMENU_GAP;
  } else {
    left = Math.max(VIEWPORT_PADDING, vw - submenuWidth - VIEWPORT_PADDING);
  }

  // Vertical: align top → align bottom → clamp + scroll
  let top = parentRect.top;
  let maxHeight: number | undefined;

  if (top + submenuHeight > vh - VIEWPORT_PADDING) {
    const upTop = parentRect.bottom - submenuHeight;
    if (upTop >= VIEWPORT_PADDING) {
      top = upTop;
    } else {
      top = VIEWPORT_PADDING;
      maxHeight = vh - VIEWPORT_PADDING * 2;
    }
  }

  return { top, left, maxHeight };
}

function getDefaultMaxHeight() {
  return window.innerHeight * MAX_HEIGHT_RATIO;
}

// ── ContextMenu ────────────────────────────────────────────────────

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [pos, setPos] = useState<MenuPosition>({ top: 0, left: 0 });

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleScroll = (e: Event) => {
      // Ignore scrolls inside the menu itself (when content overflows and scrolls)
      if (ref.current && ref.current.contains(e.target as Node)) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('scroll', handleScroll, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Measure while invisible, compute position, then reveal — all before paint
  useLayoutEffect(() => {
    if (!ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    setPos(calcPosition(x, y, width, height));
    setReady(true);
  }, [x, y]);

  return createPortal(
    <div
      ref={ref}
      style={{
        top: pos.top,
        left: pos.left,
        maxHeight: pos.maxHeight ?? getDefaultMaxHeight(),
        opacity: ready ? 1 : 0,
        pointerEvents: ready ? 'auto' : 'none',
      }}
      className={cn(menuPanelClass, 'context-menu-container')}
    >
      {items.map((item, i) => (
        <MenuItem key={i} item={item} onClose={onClose} />
      ))}
    </div>,
    document.body
  );
}

// ── MenuItem ───────────────────────────────────────────────────────

function MenuItem({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const itemRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [submenuReady, setSubmenuReady] = useState(false);
  const [submenuPos, setSubmenuPos] = useState<MenuPosition>({ top: 0, left: 0 });

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  // Position submenu before paint
  useLayoutEffect(() => {
    if (!isOpen || !itemRef.current || !submenuRef.current) return;
    if ('separator' in item || !item.children) return;

    const parentRect = itemRef.current.getBoundingClientRect();
    const { width, height } = submenuRef.current.getBoundingClientRect();

    setSubmenuPos(calcSubmenuPosition(parentRect, width, height));
    setSubmenuReady(true);
  }, [isOpen, item]);

  // Reset ready state when submenu closes
  useEffect(() => {
    if (!isOpen) setSubmenuReady(false);
  }, [isOpen]);

  if ('separator' in item) {
    return <div className="h-px bg-app-border/50 my-1 mx-2" />;
  }

  const hasChildren = item.children && item.children.length > 0;

  const handleMouseEnter = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setIsOpen(true);
  };

  const handleMouseLeave = () => {
    timeoutRef.current = setTimeout(() => {
      setIsOpen(false);
    }, SUBMENU_HOVER_DELAY_MS);
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

      {isOpen && hasChildren && createPortal(
        <div
          ref={submenuRef}
          style={{
            top: submenuPos.top,
            left: submenuPos.left,
            maxHeight: submenuPos.maxHeight ?? getDefaultMaxHeight(),
            opacity: submenuReady ? 1 : 0,
            pointerEvents: submenuReady ? 'auto' : 'none',
          }}
          className={menuPanelClass}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {item.children!.map((child, i) => (
            <MenuItem key={i} item={child} onClose={onClose} />
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
