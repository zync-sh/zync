import { ChevronRight, Plus } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { cn } from '../../../lib/utils';
import { useAppStore } from '../../../store/useAppStore';
import { CONTROL_INSET_FOCUS_CLASSES } from '../../ui/controlStyles';
import { Tooltip } from '../../ui/Tooltip';
import { ZPortal } from '../../ui/ZPortal';

export interface SidebarSectionCreateItem {
    id: string;
    label: string;
    icon?: ReactNode;
    onSelect: () => void;
}

interface SidebarSectionProps {
    title: string;
    count?: number;
    children: React.ReactNode;
    defaultExpanded?: boolean;
    compactMode?: boolean;
    /** Match Port Forwarding / Vault action-button chrome (recommended for All Hosts). */
    variant?: 'plain' | 'action';
    /**
     * Fill remaining height while expanded; collapsed sections occupy only their header.
     * Children manage their own scroll (used by All Hosts).
     */
    fill?: boolean;
    icon?: ReactNode;
    /**
     * Optional create menu — renders a trailing `+` on the section header
     * without changing expand/collapse behavior.
     */
    createMenu?: SidebarSectionCreateItem[];
    onDrop?: (e: React.DragEvent) => void;
    onContextMenu?: (e: React.MouseEvent) => void;
}

const MENU_MIN_WIDTH = 176;

/** Share section controls while releasing the content allocation when collapsed. */
export function SidebarSection({
    title,
    count,
    children,
    defaultExpanded = true,
    compactMode = false,
    variant = 'plain',
    fill = false,
    icon,
    createMenu,
    onDrop,
    onContextMenu,
}: SidebarSectionProps) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);
    const [menuOpen, setMenuOpen] = useState(false);
    const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
    const isAction = variant === 'action';
    const hasCreateMenu = Boolean(createMenu && createMenu.length > 0);
    const headerRef = useRef<HTMLDivElement>(null);
    const plusRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    const updateMenuPosition = useCallback(() => {
        const el = plusRef.current ?? headerRef.current;
        if (!el) {
            return;
        }
        const rect = el.getBoundingClientRect();
        const left = Math.min(
            Math.max(8, rect.right - MENU_MIN_WIDTH),
            window.innerWidth - MENU_MIN_WIDTH - 8,
        );
        setMenuPos({ top: rect.bottom + 4, left });
    }, []);

    useLayoutEffect(() => {
        if (!menuOpen) {
            return;
        }
        updateMenuPosition();
        window.addEventListener('resize', updateMenuPosition);
        window.addEventListener('scroll', updateMenuPosition, true);
        return () => {
            window.removeEventListener('resize', updateMenuPosition);
            window.removeEventListener('scroll', updateMenuPosition, true);
        };
    }, [menuOpen, updateMenuPosition]);

    useEffect(() => {
        if (!menuOpen) {
            return;
        }
        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Node;
            if (headerRef.current?.contains(target)) {
                return;
            }
            if (menuRef.current?.contains(target)) {
                return;
            }
            setMenuOpen(false);
        };
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleEscape);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [menuOpen]);

    return (
        <div
            className={cn(
                isAction ? 'mb-1.5' : 'mb-2',
                fill && (isExpanded ? 'flex-1 min-h-min flex flex-col' : 'shrink-0'),
            )}
            onDragOver={
                onDrop
                    ? (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                      }
                    : undefined
            }
            onDrop={
                onDrop
                    ? (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const types = Array.from(e.dataTransfer.types || []);
                          const isExternal =
                              types.includes('Files') || types.includes('text/uri-list');
                          if (isExternal) {
                              useAppStore
                                  .getState()
                                  .showToast(
                                      'info',
                                      'External drop here is currently disabled. We are working to bring this feature to Zync soon!',
                                  );
                              return;
                          }
                          onDrop(e);
                      }
                    : undefined
            }
        >
            <div
                ref={headerRef}
                className={cn(
                    'group flex w-full shrink-0 items-center select-none',
                    isAction &&
                        cn(
                            'rounded-lg border border-transparent',
                            'bg-app-surface/30',
                            'hover:bg-app-surface hover:border-app-border/30',
                            (isExpanded || menuOpen) && 'text-app-text border-app-border/20',
                        ),
                )}
                onContextMenu={onContextMenu}
            >
                <button
                    type="button"
                    onClick={() => setIsExpanded(!isExpanded)}
                    aria-expanded={isExpanded}
                    className={cn(
                        'flex min-w-0 flex-1 items-center outline-none transition-all',
                        CONTROL_INSET_FOCUS_CLASSES,
                        isAction
                            ? cn(
                                  'gap-0 rounded-lg py-2 px-3',
                                  'text-app-muted hover:text-app-text',
                                  isExpanded && 'text-app-text',
                              )
                            : cn('gap-1 mb-1', compactMode ? 'px-2' : 'px-4'),
                    )}
                >
                    {isAction ? (
                        <>
                            {icon && (
                                <span className="shrink-0 opacity-70 group-hover:opacity-100">
                                    {icon}
                                </span>
                            )}
                            <span
                                data-zync-color-label
                                className={cn(
                                    'truncate font-medium text-[10px] uppercase tracking-wider opacity-80 group-hover:opacity-100',
                                    icon ? 'ml-3' : undefined,
                                )}
                            >
                                {title}
                            </span>
                            {count !== undefined && count > 0 && (
                                <span className="ml-2 text-[10px] font-medium text-app-accent bg-app-accent/10 px-1.5 rounded-full">
                                    {count}
                                </span>
                            )}
                            <span className="ml-auto shrink-0 flex items-center justify-center opacity-60 group-hover:opacity-100">
                                <ChevronRight
                                    size={12}
                                    className={cn(
                                        'transition-transform duration-200',
                                        isExpanded && 'rotate-90',
                                    )}
                                />
                            </span>
                        </>
                    ) : (
                        <>
                            <ChevronRight
                                size={12}
                                className={cn(
                                    'text-app-muted group-hover:text-app-text transition-transform duration-200',
                                    isExpanded && 'rotate-90',
                                )}
                            />
                            <span className="text-xs font-bold text-app-muted group-hover:text-app-text transition-colors uppercase tracking-wider">
                                {title}
                            </span>
                            {count !== undefined && count > 0 && (
                                <span className="ml-auto text-[10px] font-medium text-app-accent bg-app-accent/10 px-1.5 rounded-full">
                                    {count}
                                </span>
                            )}
                        </>
                    )}
                </button>

                {hasCreateMenu && (
                    <Tooltip
                        content={`Create in ${title}`}
                        disabled={menuOpen}
                    >
                        <button
                            ref={plusRef}
                            type="button"
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            aria-label={`Create in ${title}`}
                            className={cn(
                                'mr-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors',
                                CONTROL_INSET_FOCUS_CLASSES,
                                'text-app-muted hover:bg-app-surface hover:text-app-text',
                                menuOpen && 'bg-app-surface text-app-text',
                            )}
                            onClick={(e) => {
                                e.stopPropagation();
                                setMenuOpen((open) => !open);
                            }}
                        >
                            <Plus size={14} />
                        </button>
                    </Tooltip>
                )}
            </div>

            {menuOpen && menuPos && createMenu && (
                <ZPortal>
                    <div
                        ref={menuRef}
                        role="menu"
                        aria-label={`Create in ${title}`}
                        style={{
                            position: 'fixed',
                            top: menuPos.top,
                            left: menuPos.left,
                            minWidth: MENU_MIN_WIDTH,
                        }}
                        className={cn(
                            'z-[200] overflow-hidden rounded-xl border border-app-border bg-app-panel p-1 shadow-2xl',
                            'animate-in fade-in zoom-in-95 duration-150',
                        )}
                    >
                        {createMenu.map((item) => (
                            <button
                                key={item.id}
                                type="button"
                                role="menuitem"
                                className={cn(
                                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium',
                                    'text-app-text/90 hover:bg-app-surface/70',
                                    CONTROL_INSET_FOCUS_CLASSES,
                                )}
                                onClick={() => {
                                    setMenuOpen(false);
                                    item.onSelect();
                                }}
                            >
                                {item.icon ? (
                                    <span className="shrink-0 text-app-muted">{item.icon}</span>
                                ) : null}
                                {item.label}
                            </button>
                        ))}
                    </div>
                </ZPortal>
            )}

            {isExpanded && (
                <div
                    className={cn(
                        'animate-in fade-in slide-in-from-top-1 duration-200',
                        isAction ? 'mt-1.5' : undefined,
                        fill && 'flex-1 min-h-0 flex flex-col overflow-hidden',
                    )}
                >
                    {children}
                </div>
            )}
        </div>
    );
}
