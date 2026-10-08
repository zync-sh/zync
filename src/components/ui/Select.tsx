import { useState, useRef, useEffect, useId, useLayoutEffect } from 'react';
import { ZPortal } from './ZPortal';
import { ChevronDown, Check, Search } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Command } from 'cmdk';
import { cn } from '../../lib/utils';
import { CONTROL_BASE_CLASSES, CONTROL_LABEL_CLASSES } from './controlStyles';
import { MENU_ITEM_CLASSES, POPUP_SURFACE_CLASSES } from './surfaceStyles';

export interface SelectOption {
    value: string;
    label: string;
    description?: string;
    icon?: React.ReactNode;
}

interface SelectProps {
    id?: string;
    ariaLabel?: string;
    ariaDescribedBy?: string;
    title?: string;
    value?: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    label?: string;
    showSearch?: boolean;
    triggerClassName?: string;
    showCheck?: boolean;
    itemClassName?: string;
    portal?: boolean;
}

interface BoundsRect {
    top: number;
    left: number;
    right: number;
    bottom: number;
    width: number;
}

interface DropdownCoords {
    top: number;
    left: number;
    width: number;
    maxHeight: number;
    openUpward: boolean;
}

const EDGE_MARGIN = 8;
const DROPDOWN_GAP = 6;
const MIN_PANEL_HEIGHT = 140;
const MAX_PANEL_HEIGHT = 280;
const MIN_LIST_HEIGHT = 120;
const SEARCH_HEADER_HEIGHT = 44;
const LIST_PADDING = 8;

const createDefaultBounds = (): BoundsRect => ({
    top: EDGE_MARGIN,
    left: EDGE_MARGIN,
    right: window.innerWidth - EDGE_MARGIN,
    bottom: window.innerHeight - EDGE_MARGIN,
    width: window.innerWidth - EDGE_MARGIN * 2,
});

const calculateDropdownCoords = (
    trigger: HTMLElement,
    /** When true (portal menus), escape modal overflow and use the viewport. */
    useViewportBounds = false,
): DropdownCoords => {
    const triggerRect = trigger.getBoundingClientRect();
    const modalSurface = useViewportBounds
        ? null
        : trigger.closest('[data-zync-modal-surface]') as HTMLElement | null;
    const bounds: BoundsRect = modalSurface
        ? {
            top: modalSurface.getBoundingClientRect().top,
            left: modalSurface.getBoundingClientRect().left,
            right: modalSurface.getBoundingClientRect().right,
            bottom: modalSurface.getBoundingClientRect().bottom,
            width: modalSurface.getBoundingClientRect().width,
        }
        : createDefaultBounds();

    const availableBelow = Math.max(0, bounds.bottom - triggerRect.bottom - DROPDOWN_GAP);
    const availableAbove = Math.max(0, triggerRect.top - bounds.top - DROPDOWN_GAP);
    const openUpward = availableBelow < MIN_PANEL_HEIGHT && availableAbove > availableBelow;

    const top = openUpward
        ? Math.max(bounds.top + DROPDOWN_GAP, triggerRect.top - DROPDOWN_GAP - Math.min(Math.max(MIN_LIST_HEIGHT, availableAbove), MAX_PANEL_HEIGHT))
        : triggerRect.bottom + DROPDOWN_GAP;

    return {
        top,
        left: Math.max(bounds.left + DROPDOWN_GAP, triggerRect.left),
        width: Math.min(triggerRect.width, bounds.width - DROPDOWN_GAP * 2),
        maxHeight: Math.min(openUpward ? availableAbove : availableBelow, MAX_PANEL_HEIGHT),
        openUpward
    };
};

/** Theme-aware selector; inline/portal placement and local keyboard ownership stay with the control. */
export function Select({
    id,
    ariaLabel,
    ariaDescribedBy,
    title,
    value,
    onChange,
    options,
    placeholder = "Select...",
    disabled,
    className,
    label,
    showSearch = true,
    triggerClassName,
    showCheck = true,
    itemClassName,
    portal = false
}: SelectProps) {
    const internalId = useId();
    const reduceMotion = useReducedMotion();
    const dropdownId = `select-dropdown-${internalId}`;
    const triggerId = id ?? `select-trigger-${internalId}`;
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const commandRef = useRef<HTMLDivElement>(null);
    const [coords, setCoords] = useState<DropdownCoords>({ top: 0, left: 0, width: 0, maxHeight: MIN_LIST_HEIGHT, openUpward: false });

    const selectedOption = options.find(opt => opt.value === value);

    useLayoutEffect(() => {
        if (!(isOpen && portal && containerRef.current)) return;

        setCoords(calculateDropdownCoords(containerRef.current, true));
    }, [isOpen, portal]);

    useLayoutEffect(() => {
        if (isOpen && !showSearch) commandRef.current?.focus();
    }, [isOpen, showSearch]);

    useEffect(() => {
        const handleEscClose = (event: KeyboardEvent) => {
            if (!isOpen) return;
            if (event.key !== 'Escape') return;
            if (event.isComposing) return;
            event.preventDefault();
            event.stopPropagation();
            setIsOpen(false);
            triggerRef.current?.focus();
        };

        const handleClickOutside = (event: MouseEvent) => {
            // Check if click is inside the portal content (we can't easily ref the portal content from here without state/ref forwarding, 
            // but the containerRef only covers the trigger if portal is used)
            // Actually, we can check if the target is NOT inside the containerRef AND NOT inside the portal.
            // But checking 'portal' is hard.
            // A common trick is to use a large transparent overlay or check specific classes.
            // Or we can rely on Command to handle some of it?

            // For now, simple check: if it's in container, don't close. 
            // Using a specific ID or class for portal content might help.
            if (containerRef.current && containerRef.current.contains(event.target as Node)) {
                return;
            }

            // If click is on the portal dropdown itself
            const dropdown = document.getElementById(dropdownId);
            if (dropdown && dropdown.contains(event.target as Node)) {
                return;
            }

            setIsOpen(false);
        };

        if (isOpen) {
            window.addEventListener('keydown', handleEscClose, { capture: true });
            document.addEventListener('mousedown', handleClickOutside);
            let updateCoords: (() => void) | null = null;
            if (portal && containerRef.current) {
                updateCoords = () => {
                    if (!containerRef.current) return;
                    setCoords(calculateDropdownCoords(containerRef.current, true));
                };
                window.addEventListener('resize', updateCoords);
                window.addEventListener('scroll', updateCoords, true);
            }
            return () => {
                window.removeEventListener('keydown', handleEscClose, { capture: true });
                document.removeEventListener('mousedown', handleClickOutside);
                if (updateCoords) {
                    window.removeEventListener('resize', updateCoords);
                    window.removeEventListener('scroll', updateCoords, true);
                }
            };
        }

        return undefined;
    }, [isOpen, portal, dropdownId]);

    const dropdownContent = (
        <motion.div
            id={dropdownId}
            data-zync-select-open="true"
            data-zync-shortcuts="local"
            initial={reduceMotion ? false : { opacity: 0, y: coords.openUpward ? -2 : 2, scale: 0.995 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : coords.openUpward ? -2 : 2, scale: reduceMotion ? 1 : 0.995 }}
            transition={{ duration: reduceMotion ? 0 : 0.15, ease: [0.16, 1, 0.3, 1] }}
            style={portal ? {
                position: 'absolute',
                top: coords.top || 0,
                left: coords.left || 0,
                width: coords.width > 0 ? coords.width : 'auto',
                minWidth: '160px',
                maxHeight: `${coords.maxHeight}px`,
                zIndex: 10050
            } : undefined}
            className={cn(
                !portal && "absolute z-[110] w-full mt-1.5",
                POPUP_SURFACE_CLASSES,
                "overflow-hidden"
            )}
        >
            <Command ref={commandRef} defaultValue={selectedOption ? (selectedOption.label + " " + (selectedOption.description || "")).trim() : undefined} loop className="flex flex-col w-full bg-transparent">
                {showSearch && (
                    <div className="flex items-center border-b border-app-border px-3" cmdk-input-wrapper="">
                        <Search aria-hidden="true" className="w-3.5 h-3.5 text-app-muted" />
                        <Command.Input
                            autoFocus
                            placeholder="Filter..."
                            aria-label={`Filter ${label ?? ariaLabel ?? 'options'}`}
                            className="w-full h-10 bg-transparent text-[length:var(--zync-control-font-size)] text-app-text outline-none px-2.5 placeholder:text-app-muted"
                        />
                    </div>
                )}
                <Command.List
                    className="max-h-40 overflow-y-auto custom-scrollbar p-1 scroll-smooth motion-reduce:scroll-auto"
                    style={portal ? { maxHeight: `${Math.max(0, coords.maxHeight - (showSearch ? SEARCH_HEADER_HEIGHT + LIST_PADDING : LIST_PADDING))}px` } : undefined}
                >
                    <Command.Empty className="py-4 text-center text-xs text-app-muted">
                        No matches
                    </Command.Empty>

                    {options.map((option) => (
                        <Command.Item
                            key={option.value}
                            value={option.label + " " + (option.description || "")}
                            onSelect={() => {
                                setIsOpen(false);
                                triggerRef.current?.focus();
                                onChange(option.value);
                            }}
                            className={cn(
                                MENU_ITEM_CLASSES,
                                "cursor-pointer select-none group/item mb-0.5 last:mb-0 aria-selected:bg-app-accent/10",
                                value === option.value
                                    ? "bg-app-accent/15 font-semibold aria-selected:bg-app-accent/20"
                                    : "hover:bg-app-surface",
                                itemClassName
                            )}
                        >
                            {option.icon && (
                                <div className={cn(
                                    "flex-none shrink-0",
                                    value !== option.value && "text-app-muted"
                                )}>
                                    {option.icon}
                                </div>
                            )}
                            <div className="flex-1 overflow-hidden">
                                <div className="truncate leading-snug font-medium">
                                    {option.label}
                                </div>
                                {option.description && (
                                    <div className="text-xs text-app-muted truncate mt-0.5">
                                        {option.description}
                                    </div>
                                )}
                            </div>
                            {showCheck && value === option.value && (
                                <span className="flex-none" aria-hidden="true">
                                    <Check className="w-3.5 h-3.5 text-current" />
                                </span>
                            )}
                        </Command.Item>
                    ))}
                </Command.List>
            </Command>
        </motion.div>
    );

    return (
        <div className={cn("relative w-full", className)} ref={containerRef}>
            {label && (
                <label htmlFor={triggerId} className={cn(CONTROL_LABEL_CLASSES, 'mb-1')}>
                    {label}
                </label>
            )}
            <button
                ref={triggerRef}
                id={triggerId}
                type="button"
                role={ariaLabel ? 'combobox' : undefined}
                aria-label={ariaLabel}
                aria-describedby={ariaDescribedBy}
                aria-expanded={isOpen}
                aria-controls={isOpen ? dropdownId : undefined}
                aria-haspopup="listbox"
                title={title}
                onClick={() => !disabled && setIsOpen(!isOpen)}
                onKeyDown={event => {
                    if (!disabled && !event.nativeEvent.isComposing && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                        event.preventDefault();
                        setIsOpen(true);
                    }
                }}
                className={cn(
                    CONTROL_BASE_CLASSES,
                    "h-[var(--zync-control-height-md)] w-full flex items-center justify-between px-3 py-2 border group",
                    "bg-app-surface text-app-text",
                    isOpen
                        ? "border-control-focus ring-2 ring-control-focus"
                        : "border-app-border hover:border-app-muted",
                    !disabled && "cursor-pointer",
                    triggerClassName
                )}
                disabled={disabled}
            >
                <div className="flex-1 flex items-center gap-2 overflow-hidden text-left min-w-0">
                    {selectedOption?.icon && (
                        <div className="flex-none shrink-0">
                            {/* Keep badge/image colors fully visible on the closed trigger */}
                            {selectedOption.icon}
                        </div>
                    )}
                    <span className={cn("truncate font-medium", !selectedOption && "text-app-muted")}>
                        {selectedOption ? selectedOption.label : placeholder}
                    </span>
                </div>
                <ChevronDown
                    aria-hidden="true"
                    className={cn(
                        "w-3.5 h-3.5 shrink-0 text-app-muted transition-transform duration-150 motion-reduce:transition-none ml-1.5",
                        isOpen && "rotate-180"
                    )}
                />
            </button>

            {portal ? (
                <ZPortal>
                    <AnimatePresence mode="wait">
                        {isOpen && dropdownContent}
                    </AnimatePresence>
                </ZPortal>
            ) : (
                <AnimatePresence mode="wait">
                    {isOpen && dropdownContent}
                </AnimatePresence>
            )}
        </div>
    );
}
