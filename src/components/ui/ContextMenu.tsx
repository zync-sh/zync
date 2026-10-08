import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils.js';
import { isInsideMenu, MENU_PANEL_CLASS, MenuSubmenu } from './MenuSubmenu';
import { MENU_ITEM_CLASSES } from './surfaceStyles';

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
const MAX_HEIGHT_RATIO = 0.7;

// ── Shared styles ──────────────────────────────────────────────────

const menuPanelClass = MENU_PANEL_CLASS;

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

function getDefaultMaxHeight() {
  return window.innerHeight * MAX_HEIGHT_RATIO;
}

function getMenuItemBaseKey(item: ContextMenuItem): string {
  if ('separator' in item) return 'separator';
  const childrenSig = item.children?.map((child) => ('separator' in child ? 'sep' : child.label)).join('|') ?? '';
  return `item:${item.label}:${item.variant ?? 'default'}:${childrenSig}`;
}

function renderMenuItems(items: ContextMenuItem[], onClose: () => void) {
  const keyCounts = new Map<string, number>();

  return items.map((item) => {
    const baseKey = getMenuItemBaseKey(item);
    const count = (keyCounts.get(baseKey) ?? 0) + 1;
    keyCounts.set(baseKey, count);
    const key = count === 1 ? baseKey : `${baseKey}#${count}`;

    return <MenuItem key={key} item={item} onClose={onClose} />;
  });
}

// ── ContextMenu ────────────────────────────────────────────────────

function eventInsideSubmenu(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(
    '[data-submenu-owner], button[aria-haspopup="menu"][aria-expanded="true"]',
  ));
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [pos, setPos] = useState<MenuPosition>({ top: 0, left: 0 });

  useEffect(() => {
    const isInsideAnyMenuLayer = (target: EventTarget | null) => isInsideMenu(ref.current, target);

    const handleClickOutside = (e: MouseEvent) => {
      if (!isInsideAnyMenuLayer(e.target)) {
        onClose();
      }
    };
    const handleScroll = (e: Event) => {
      // Ignore scrolls inside the menu itself (when content overflows and scrolls)
      if (isInsideAnyMenuLayer(e.target)) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
      if (eventInsideSubmenu(e.target)) return;
      // Menu dismissal owns Escape even when the terminal retains DOM focus.
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('scroll', handleScroll, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [onClose]);

  // Measure while invisible, compute position, then reveal — all before paint
  useLayoutEffect(() => {
    if (!ref.current) return;
    setReady(false);
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
      {renderMenuItems(items, onClose)}
    </div>,
    document.body
  );
}

// ── MenuItem ───────────────────────────────────────────────────────

function MenuItem({ item, onClose }: { item: ContextMenuItem; onClose: () => void }) {
  if ('separator' in item) return <div className="h-px bg-app-border/50 my-1 mx-2" />;
  const itemClass = cn(
    MENU_ITEM_CLASSES,
    'mx-1 w-[calc(100%-8px)]',
    item.disabled ? 'text-app-muted'
      : item.variant === 'danger' ? 'text-app-danger hover:bg-app-danger/10' : 'text-app-text hover:bg-app-surface',
  );
  if (item.children?.length) {
    return <MenuSubmenu label={item.label} icon={item.icon} disabled={item.disabled} triggerClassName={itemClass}>
      {renderMenuItems(item.children, onClose)}
    </MenuSubmenu>;
  }
  return <button type="button" role="menuitem" disabled={item.disabled} className={itemClass}
    onClick={() => { item.action?.(); onClose(); }}>
    {item.icon && <span className="text-current opacity-80">{item.icon}</span>}
    <span>{item.label}</span>
  </button>;
}
