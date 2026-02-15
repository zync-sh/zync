import { useState, useRef, useEffect, useId, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
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
    const [coords, setCoords] = useState({ top: 0, left: 0, width: 0 });

    const selectedOption = options.find(opt => opt.value === value);

    useLayoutEffect(() => {
        if (isOpen && portal && containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            setCoords({
                top: rect.bottom + 6,
                left: rect.left,
                width: rect.width
            });
        }
    }, [isOpen, portal]);

    useEffect(() => {
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
            document.addEventListener('mousedown', handleClickOutside);
            // Calculate coords
            if (portal && containerRef.current) {
                const updateCoords = () => {
                    const rect = containerRef.current?.getBoundingClientRect();
                    if (rect) {
                        setCoords({
                            top: rect.bottom + 6, // Added gap
                            left: rect.left,
                            width: rect.width
                        });
                    }
                };
                window.addEventListener('resize', updateCoords);
                window.addEventListener('scroll', updateCoords, true);

                return () => {
                    window.removeEventListener('resize', updateCoords);
                    window.removeEventListener('scroll', updateCoords, true);
                };
            }
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen, portal, dropdownId]);

    const dropdownContent = (
        <motion.div
            id={dropdownId}
            initial={{ opacity: 0, y: 2, scale: 0.995 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 2, scale: 0.995 }}
            transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            style={portal ? {
                position: 'fixed',
                top: coords.top || 0,
                left: coords.left || 0,
                width: coords.width > 0 ? coords.width : 'auto',
                minWidth: '160px',
                maxHeight: '400px',
                zIndex: 2147483647,
                pointerEvents: 'auto'
            } : undefined}
            className={cn(
                portal ? "pointer-events-auto" : "absolute z-[110] w-full mt-1.5",
                "bg-[#18181b] border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.8)] rounded-xl overflow-hidden backdrop-blur-3xl ring-1 ring-white/10"
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
                <Command.List className="max-h-40 overflow-y-auto custom-scrollbar p-1 scroll-smooth">
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
                                "aria-selected:bg-app-accent/10 aria-selected:text-white",
                                value === option.value
                                    ? "bg-app-accent text-white font-semibold shadow-md shadow-app-accent/10"
                                    : "text-app-text/60 hover:bg-white/[0.03] hover:text-white",
                                itemClassName
                            )}
                        >
                            {option.icon && (
                                <div className={cn(
                                    "flex-none transition-all duration-300 group-hover/item:scale-105 scale-90",
                                    value === option.value ? "text-white" : "text-app-muted/40 group-hover/item:text-app-accent"
                                )}>
                                    {option.icon}
                                </div>
                            )}
                            <div className="flex-1 overflow-hidden">
                                <div className="truncate leading-none font-medium text-[11px]">{option.label}</div>
                                {option.description && (
                                    <div className={cn(
                                        "text-[8px] truncate mt-0.5 opacity-30 group-hover/item:opacity-50 transition-opacity",
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
                <label className="text-[10px] font-bold text-app-muted uppercase tracking-wider block mb-2 px-1 opacity-60">
                    {label}
                </label>
            )}
            <button
                type="button"
                onClick={() => !disabled && setIsOpen(!isOpen)}
                className={cn(
                    "w-full flex items-center justify-between px-3 py-2 rounded-xl border text-[13px] transition-all duration-300 outline-none group",
                    "bg-app-surface/20 text-app-text",
                    isOpen
                        ? "border-app-accent/40 bg-app-surface/40 shadow-[0_0_15px_rgba(121,123,206,0.1)] ring-1 ring-app-accent/20"
                        : "border-white/[0.05] hover:border-white/10 hover:bg-app-surface/30 shadow-[inset_0_0_10px_rgba(255,255,255,0.01)]",
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
                    <span className={cn("truncate font-medium tracking-tight", !selectedOption && "text-app-muted opacity-50")}>
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

            {portal ? createPortal(
                <AnimatePresence mode="wait">
                    {isOpen && (
                        <div className="z-[2147483647] relative">
                            {dropdownContent}
                        </div>
                    )}
                </AnimatePresence>,
                document.body
            ) : (
                <AnimatePresence mode="wait">
                    {isOpen && dropdownContent}
                </AnimatePresence>
            )}
        </div>
    );
}
