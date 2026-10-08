import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { MENU_ITEM_CLASSES, POPUP_SURFACE_CLASSES } from './surfaceStyles';

export const MENU_PANEL_CLASS = cn(POPUP_SURFACE_CLASSES, 'fixed z-[99999] w-52 max-w-[calc(100vw-16px)] text-sm flex flex-col py-1 overflow-y-auto overscroll-contain');

/** Portaled descendants belong to the menu containing their trigger, including nested flyouts. */
export function isInsideMenu(root: HTMLElement | null, target: EventTarget | null): boolean {
    if (!root || !(target instanceof Node)) return false;
    const visited = new Set<Node>();
    let current: Node | null = target;
    while (current && !visited.has(current)) {
        if (root.contains(current)) return true;
        visited.add(current);
        const layer: HTMLElement | null = (current instanceof Element ? current : current.parentElement)?.closest('[data-submenu-owner]') ?? null;
        current = layer ? document.getElementById(layer.dataset.submenuOwner ?? '') : null;
    }
    return false;
}

/** Shared context-menu flyout: viewport placement, hover delay, focus, and keyboard navigation. */
export function MenuSubmenu({ label, icon, children, disabled = false, triggerClassName, descriptionId, localKeyboard = false }: {
    label: string;
    icon?: ReactNode;
    children: ReactNode;
    disabled?: boolean;
    triggerClassName?: string;
    descriptionId?: string;
    localKeyboard?: boolean;
}) {
    const id = useId();
    const root = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const focusOnOpen = useRef(false);
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
    const cancelClose = () => clearTimeout(timer.current);
    const focusItem = () => (panel.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
        ?? panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
    const close = (restoreFocus = false) => {
        cancelClose();
        setOpen(false);
        if (restoreFocus) trigger.current?.focus();
    };
    const show = (focus = false) => {
        if (disabled) return;
        cancelClose();
        if (open) { if (focus) focusItem(); return; }
        focusOnOpen.current = focus;
        setPosition(previous => ({ ...previous, ready: false }));
        setOpen(true);
    };
    const leave = () => {
        cancelClose();
        timer.current = setTimeout(() => close(), 150);
    };
    useEffect(() => () => clearTimeout(timer.current), []);
    useLayoutEffect(() => {
        if (!open) return;
        const place = () => {
            if (!trigger.current || !panel.current) return;
            const anchor = trigger.current.getBoundingClientRect();
            const bounds = panel.current.getBoundingClientRect();
            const right = anchor.right + 4;
            const left = right + bounds.width <= window.innerWidth - 8 ? right
                : anchor.left - bounds.width - 4 >= 8 ? anchor.left - bounds.width - 4
                    : Math.max(8, window.innerWidth - bounds.width - 8);
            const top = Math.max(8, Math.min(anchor.top, window.innerHeight - bounds.height - 8));
            setPosition({ left, top, ready: true });
        };
        place();
        if (focusOnOpen.current) { focusItem(); focusOnOpen.current = false; }
        const outside = (event: MouseEvent) => { if (!isInsideMenu(root.current, event.target)) close(); };
        window.addEventListener('resize', place);
        document.addEventListener('mousedown', outside);
        return () => {
            window.removeEventListener('resize', place);
            document.removeEventListener('mousedown', outside);
        };
    }, [open, children]);

    return <div ref={root} className="relative" data-zync-shortcuts={localKeyboard ? 'local' : undefined}
        onMouseEnter={() => show()} onMouseLeave={leave}
        onBlur={event => { if (!isInsideMenu(root.current, event.relatedTarget)) close(); }}
        onKeyDown={event => {
            if (open && (event.key === 'Escape' || event.key === 'ArrowLeft')) {
                event.preventDefault(); event.stopPropagation(); close(true);
            }
        }}
    >
        <button id={id} ref={trigger} type="button" disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-panel` : undefined}
            onClick={() => show(true)}
            onKeyDown={event => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); show(true); }
            }}
            className={cn(MENU_ITEM_CLASSES, 'w-full text-app-text hover:bg-app-surface', triggerClassName)}
        >
            {icon && <span className="text-app-muted" aria-hidden="true">{icon}</span>}
            <span>{label}</span><ChevronRight size={13} className="ml-auto opacity-50" aria-hidden="true" />
        </button>
        {open && createPortal(<div ref={panel} id={`${id}-panel`} role="menu" aria-label={label} aria-describedby={descriptionId}
            data-submenu-owner={id} data-zync-shortcuts={localKeyboard ? 'local' : undefined}
            className={cn(MENU_PANEL_CLASS, 'context-menu-submenu-portal')}
            style={{ left: position.left, top: position.top, maxHeight: 'calc(100vh - 16px)', opacity: position.ready ? 1 : 0, pointerEvents: position.ready ? 'auto' : 'none' }}
            onMouseEnter={cancelClose} onMouseLeave={leave}
            onKeyDown={event => {
                if (event.defaultPrevented || event.target instanceof Element && event.target.closest('[role="menu"]') !== panel.current) return;
                const items = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
                    .filter(item => item.closest('[role="menu"]') === panel.current);
                const index = items.indexOf(document.activeElement as HTMLButtonElement);
                const next = event.key === 'ArrowDown' ? (index + 1) % items.length
                    : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length
                        : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
                if (next >= 0) { event.preventDefault(); event.stopPropagation(); items[next]?.focus(); }
            }}
        >{children}</div>, document.body)}
    </div>;
}
