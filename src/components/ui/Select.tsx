import { useState, useRef, useEffect } from 'react';
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
}

export function Select({ value, onChange, options, placeholder = "Select...", disabled, className, label, showSearch = true, triggerClassName, showCheck = true, itemClassName }: SelectProps) {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const selectedOption = options.find(opt => opt.value === value);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };

        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
        }

        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen]);

    return (
        <div className={cn("relative w-full", className)} ref={containerRef}>
            {label && (
                <label className="text-xs font-semibold text-app-muted uppercase tracking-wider block mb-2 px-1">
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

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, y: 2, scale: 0.995 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 2, scale: 0.995 }}
                        transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                        className="absolute z-[110] w-full mt-1.5 bg-app-panel border border-white/10 shadow-[0_15px_40px_rgba(0,0,0,0.6)] rounded-xl overflow-hidden backdrop-blur-3xl ring-1 ring-white/5"
                    >
                        <Command className="flex flex-col">
                            {showSearch && (
                                <div className="flex items-center border-b border-white/[0.05] px-2.5 bg-white/[0.02]" cmdk-input-wrapper="">
                                    <Search className="w-3 h-3 text-app-muted/30" />
                                    <Command.Input
                                        autoFocus
                                        placeholder="Filter..."
                                        className="w-full h-9 bg-transparent text-xs outline-none px-2 placeholder:text-app-muted/20"
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
                )}
            </AnimatePresence>
        </div>
    );
}
