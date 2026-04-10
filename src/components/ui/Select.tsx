import { useState, useRef, useEffect, useId, useLayoutEffect } from 'react';
import { ZPortal } from './ZPortal';
import { ChevronDown, Check, Search } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Command } from 'cmdk';
import { cn } from '../../lib/utils';

export interface SelectOption {
    value: string;
    label: string;
    description?: string;
    icon?: React.ReactNode;
}

interface SelectProps {
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

const calculateDropdownCoords = (trigger: HTMLElement): DropdownCoords => {
    const triggerRect = trigger.getBoundingClientRect();
    const modalSurface = trigger.closest('[data-zync-modal-surface]') as HTMLElement | null;
    const bounds: BoundsRect = modalSurface
        ? {
            top: modalSurface.getBoundingClientRect().top,
            left: modalSurface.getBoundingClientRect().left,
            right: modalSurface.getBoundingClientRect().right,
            bottom: modalSurface.getBoundingClientRect().bottom,
            width: modalSurface.getBoundingClientRect().width,
        }
        : createDefaultBounds();

    const spaceBelow = Math.max(MIN_LIST_HEIGHT, bounds.bottom - triggerRect.bottom - DROPDOWN_GAP);
    const spaceAbove = Math.max(MIN_LIST_HEIGHT, triggerRect.top - bounds.top - DROPDOWN_GAP);
    const openUpward = spaceBelow < MIN_PANEL_HEIGHT && spaceAbove > spaceBelow;

    const top = openUpward
        ? Math.max(bounds.top + DROPDOWN_GAP, triggerRect.top - DROPDOWN_GAP - Math.min(spaceAbove, MAX_PANEL_HEIGHT))
        : triggerRect.bottom + DROPDOWN_GAP;

    return {
        top,
        left: Math.max(bounds.left + DROPDOWN_GAP, triggerRect.left),
        width: Math.min(triggerRect.width, bounds.width - DROPDOWN_GAP * 2),
        maxHeight: Math.min(openUpward ? spaceAbove : spaceBelow, MAX_PANEL_HEIGHT),
        openUpward
    };
};

export function Select({
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
    const dropdownId = `select-dropdown-${internalId}`;
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const [coords, setCoords] = useState<DropdownCoords>({ top: 0, left: 0, width: 0, maxHeight: MIN_LIST_HEIGHT, openUpward: false });

    const selectedOption = options.find(opt => opt.value === value);

    useLayoutEffect(() => {
        if (!(isOpen && portal && containerRef.current)) return;

        setCoords(calculateDropdownCoords(containerRef.current));
    }, [isOpen, portal]);

    useEffect(() => {
        const handleEscClose = (event: KeyboardEvent) => {
            if (!isOpen) return;
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            setIsOpen(false);
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
                    setCoords(calculateDropdownCoords(containerRef.current));
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
            initial={{ opacity: 0, y: coords.openUpward ? -2 : 2, scale: 0.995 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: coords.openUpward ? -2 : 2, scale: 0.995 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            style={portal ? {
                position: 'absolute',
                top: coords.top || 0,
                left: coords.left || 0,
                width: coords.width > 0 ? coords.width : 'auto',
                minWidth: '160px',
                maxHeight: `${coords.maxHeight}px`,
                zIndex: 9999
            } : undefined}
            className={cn(
                !portal && "absolute z-[110] w-full mt-1.5",
                "bg-app-panel/95 border border-app-border shadow-2xl rounded-xl overflow-hidden backdrop-blur-3xl ring-1 ring-black/5 dark:ring-white/10"
            )}
        >
            <Command className="flex flex-col w-full bg-transparent">
                {showSearch && (
                    <div className="flex items-center border-b border-white/[0.05] px-3 bg-white/[0.02]" cmdk-input-wrapper="">
                        <Search className="w-3.5 h-3.5 text-app-muted/30" />
                        <Command.Input
                            autoFocus
                            placeholder="Filter..."
                            className="w-full h-10 bg-transparent text-xs outline-none px-2.5 placeholder:text-app-muted/20"
                        />
                    </div>
                )}
                <Command.List
                    className="max-h-40 overflow-y-auto custom-scrollbar p-1 scroll-smooth"
                    style={portal ? { maxHeight: `${Math.max(MIN_LIST_HEIGHT, coords.maxHeight - (showSearch ? SEARCH_HEADER_HEIGHT + LIST_PADDING : LIST_PADDING))}px` } : undefined}
                >
                    <Command.Empty className="py-4 text-center text-[9px] text-app-muted/40 font-bold uppercase tracking-widest italic leading-none">
                        No hits
                    </Command.Empty>

                    {options.map((option) => (
                        <Command.Item
                            key={option.value}
                            value={option.label + " " + (option.description || "")}
                            onSelect={() => {
                                onChange(option.value);
                                setIsOpen(false);
                            }}
                            className={cn(
                                "flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-xs transition-all cursor-pointer select-none group/item mb-0.5 last:mb-0",
                                "aria-selected:bg-app-accent/10 aria-selected:text-app-accent",
                                value === option.value
                                    ? "bg-app-accent text-white font-semibold shadow-md shadow-app-accent/10 aria-selected:bg-app-accent aria-selected:text-white"
                                    : "text-app-text/60 hover:bg-app-accent/5 hover:text-app-accent",
                                itemClassName
                            )}
                        >
                            {option.icon && (
                                <div className={cn(
                                    "flex-none transition-all duration-300 group-hover/item:scale-105 scale-90",
                                    value === option.value ? "text-white" : "text-app-muted group-aria-selected:text-app-accent"
                                )}>
                                    {option.icon}
                                </div>
                            )}
                            <div className="flex-1 overflow-hidden">
                                <div className="truncate leading-none font-medium text-[11px]">{option.label}</div>
                                {option.description && (
                                    <div className={cn(
                                        "text-[8px] truncate mt-0.5 opacity-30 group-aria-selected:opacity-70 transition-opacity",
                                        value === option.value && "opacity-70"
                                    )}>
                                        {option.description}
                                    </div>
                                )}
                            </div>
                            {showCheck && value === option.value && (
                                <motion.div layoutId="check" className="flex-none">
                                    <Check className="w-2.5 h-2.5 text-white" />
                                </motion.div>
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
                <label className="text-[10px] font-bold text-app-muted uppercase tracking-wider block mb-2 px-1">
                    {label}
                </label>
            )}
            <button
                type="button"
                onClick={() => !disabled && setIsOpen(!isOpen)}
                className={cn(
                    "w-full flex items-center justify-between px-3 py-2 rounded-xl border text-[13px] transition-all duration-300 outline-none group",
                    "bg-app-surface text-app-text",
                    isOpen
                        ? "border-app-accent/40 shadow-[0_0_15px_rgba(121,123,206,0.1)] ring-1 ring-app-accent/20"
                        : "border-app-border/60 hover:border-app-border hover:bg-app-surface/80 shadow-sm",
                    disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer",
                    triggerClassName
                )}
                disabled={disabled}
            >
                <div className="flex-1 flex items-center gap-2 overflow-hidden text-left min-w-0">
                    {selectedOption?.icon && (
                        <div className="flex-none transition-transform duration-300 group-hover:scale-105">
                            {/* Force smaller icon for trigger */}
                            <div className="scale-90 opacity-80">{selectedOption.icon}</div>
                        </div>
                    )}
                    <span className={cn("truncate font-medium tracking-tight", !selectedOption && "text-app-muted opacity-70")}>
                        {selectedOption ? selectedOption.label : placeholder}
                    </span>
                </div>
                <ChevronDown
                    className={cn(
                        "w-3 h-3 text-app-muted transition-all duration-500 ml-1.5 opacity-30 group-hover:opacity-80",
                        isOpen && "transform rotate-180 text-app-accent opacity-100 scale-110"
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
