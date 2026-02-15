import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronsUpDown, Plus, Folder } from 'lucide-react';
import { Command } from 'cmdk';
import { cn } from '../../lib/utils';
import { motion, AnimatePresence } from 'framer-motion';

interface GroupSelectorProps {
    value: string;
    onChange: (value: string) => void;
    existingGroups: string[];
    className?: string;
    placeholder?: string;
    label?: string;
    portal?: boolean;
}

export function GroupSelector({
    value,
    onChange,
    existingGroups,
    className,
    placeholder = "Select or create group...",
    label,
    portal = false
}: GroupSelectorProps) {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const [coords, setCoords] = useState({ top: 0, left: 0, width: 0 });

    // Close when clicking outside
    // Close when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                // If portal is active, check if click is outside the portal content
                const dropdown = document.getElementById(`group-selector-dropdown-${label || 'generic'}`);
                if (dropdown && dropdown.contains(event.target as Node)) {
                    return;
                }
                setOpen(false);
            }
        };

        if (open) {
            document.addEventListener('mousedown', handleClickOutside);
            // Calculate coords for portal
            if (portal && containerRef.current) {
                const updateCoords = () => {
                    const rect = containerRef.current?.getBoundingClientRect();
                    if (rect) {
                        setCoords({
                            top: rect.bottom + 8,
                            left: rect.left,
                            width: rect.width
                        });
                    }
                };
                updateCoords();
                window.addEventListener('resize', updateCoords);
                window.addEventListener('scroll', updateCoords, true);

                return () => {
                    document.removeEventListener('mousedown', handleClickOutside);
                    window.removeEventListener('resize', updateCoords);
                    window.removeEventListener('scroll', updateCoords, true);
                };
            }
        }
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [open, portal, label]);

    return (
        <div className={cn("relative w-full", className)} ref={containerRef}>
            {label && (
                <label className="text-[10px] font-bold text-app-muted uppercase tracking-wider block mb-2 px-1 opacity-60">
                    {label}
                </label>
            )}
            <div
                onClick={() => {
                    setOpen(true);
                    setTimeout(() => inputRef.current?.focus(), 0);
                }}
                className={cn(
                    "flex items-center justify-between px-3 py-2.5 rounded-xl border text-sm bg-app-surface/40 cursor-text transition-all",
                    open ? "border-app-accent ring-2 ring-app-accent/20 bg-app-surface/60" : "border-app-border/50 hover:border-app-muted hover:bg-app-surface/50",
                    !value && "text-app-muted"
                )}
            >
                <div className="flex items-center gap-2 flex-1 overflow-hidden">
                    <Folder size={16} className={cn("shrink-0", value ? "text-app-accent" : "text-app-muted/50")} />
                    <span className="truncate flex-1">{value || placeholder}</span>
                </div>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </div>

            <AnimatePresence>
                {open && (
                    portal ? createPortal(
                        <motion.div
                            id={`group-selector-dropdown-${label || 'generic'}`}
                            initial={{ opacity: 0, y: 5, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 5, scale: 0.98 }}
                            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
                            style={{
                                position: 'fixed',
                                top: coords.top,
                                left: coords.left,
                                width: coords.width,
                                maxHeight: '300px', // Ensure it doesn't run off screen
                                zIndex: 9999
                            }}
                            className="bg-app-panel border border-app-border shadow-2xl rounded-xl overflow-hidden backdrop-blur-2xl ring-1 ring-white/5"
                        >
                            <Command loop className="flex flex-col w-full">
                                <div className="flex items-center border-b border-app-border/50 px-3" cmdk-input-wrapper="">
                                    <Command.Input
                                        ref={inputRef}
                                        placeholder="Search or type new..."
                                        value={value}
                                        onValueChange={onChange}
                                        className="flex h-10 w-full rounded-md bg-transparent py-2 text-sm outline-none placeholder:text-app-muted/40 text-app-text disabled:cursor-not-allowed disabled:opacity-50"
                                        autoFocus
                                    />
                                </div>
                                <Command.List className="max-h-60 overflow-y-auto custom-scrollbar p-1.5 scroll-smooth">
                                    <Command.Empty className="py-4 px-2 text-xs text-app-muted text-center">
                                        <button
                                            onClick={() => setOpen(false)}
                                            className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded hover:bg-app-accent/10 hover:text-app-accent transition-colors"
                                        >
                                            <Plus size={12} />
                                            Create "{value}"
                                        </button>
                                    </Command.Empty>

                                    {existingGroups.map((group) => (
                                        <Command.Item
                                            key={group}
                                            value={group}
                                            onSelect={(currentValue) => {
                                                onChange(currentValue);
                                                setOpen(false);
                                            }}
                                            className={cn(
                                                "flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm transition-all cursor-pointer select-none",
                                                "aria-selected:bg-app-accent/15 aria-selected:text-app-accent",
                                                value === group ? "bg-app-accent/5 text-app-accent font-medium" : "text-app-text/90 hover:bg-app-surface"
                                            )}
                                        >
                                            <Check
                                                className={cn(
                                                    "mr-2 h-3.5 w-3.5",
                                                    value === group ? "opacity-100" : "opacity-0"
                                                )}
                                            />
                                            <span className="truncate">{group}</span>
                                        </Command.Item>
                                    ))}
                                </Command.List>
                            </Command>
                        </motion.div>,
                        document.body
                    ) : (
                        <motion.div
                            initial={{ opacity: 0, y: 5, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 5, scale: 0.98 }}
                            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
                            className="absolute z-[100] w-full mt-2 bg-app-panel border border-app-border shadow-2xl rounded-xl overflow-hidden backdrop-blur-2xl ring-1 ring-white/5"
                        >
                            <Command loop className="flex flex-col w-full">
                                <div className="flex items-center border-b border-app-border/50 px-3" cmdk-input-wrapper="">
                                    <Command.Input
                                        ref={inputRef}
                                        placeholder="Search or type new..."
                                        value={value}
                                        onValueChange={onChange}
                                        className="flex h-10 w-full rounded-md bg-transparent py-2 text-sm outline-none placeholder:text-app-muted/40 text-app-text disabled:cursor-not-allowed disabled:opacity-50"
                                    />
                                </div>
                                <Command.List className="max-h-60 overflow-y-auto custom-scrollbar p-1.5 scroll-smooth">
                                    <Command.Empty className="py-4 px-2 text-xs text-app-muted text-center">
                                        <button
                                            onClick={() => setOpen(false)}
                                            className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded hover:bg-app-accent/10 hover:text-app-accent transition-colors"
                                        >
                                            <Plus size={12} />
                                            Create "{value}"
                                        </button>
                                    </Command.Empty>

                                    {existingGroups.map((group) => (
                                        <Command.Item
                                            key={group}
                                            value={group}
                                            onSelect={(currentValue) => {
                                                onChange(currentValue);
                                                setOpen(false);
                                            }}
                                            className={cn(
                                                "flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm transition-all cursor-pointer select-none",
                                                "aria-selected:bg-app-accent/15 aria-selected:text-app-accent",
                                                value === group ? "bg-app-accent/5 text-app-accent font-medium" : "text-app-text/90 hover:bg-app-surface"
                                            )}
                                        >
                                            <Check
                                                className={cn(
                                                    "mr-2 h-3.5 w-3.5",
                                                    value === group ? "opacity-100" : "opacity-0"
                                                )}
                                            />
                                            <span className="truncate">{group}</span>
                                        </Command.Item>
                                    ))}
                                </Command.List>
                            </Command>
                        </motion.div>
                    )
                )}
            </AnimatePresence>
        </div>
    );
}
