import { AnimatePresence, motion } from 'framer-motion';
import { Clock } from 'lucide-react';
import type { Connection } from '../../../../store/connectionSlice';
import { OSIcon } from '../../../icons/OSIcon';
import { cn } from '../../../../lib/utils';

interface SuggestionsDropdownProps {
    showDropdown: boolean;
    showRecents: boolean;
    listboxId: string;
    dropItems: Connection[];
    activeIndex: number;
    setActiveIndex: (index: number) => void;
    onSelectExisting: (id: string) => void;
}

export function SuggestionsDropdown({
    showDropdown,
    showRecents,
    listboxId,
    dropItems,
    activeIndex,
    setActiveIndex,
    onSelectExisting,
}: SuggestionsDropdownProps) {
    return (
        <AnimatePresence>
            {showDropdown && (
                <motion.ul
                    id={listboxId}
                    role="listbox"
                    aria-label={showRecents ? 'Recent connections' : 'Matching connections'}
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.12 }}
                    className="absolute top-full mt-1.5 left-0 right-0 bg-app-panel/98 backdrop-blur-xl border border-app-border/60 rounded-2xl shadow-2xl overflow-hidden z-50 py-1"
                >
                    {showRecents && (
                        <li role="presentation" className="flex items-center gap-1.5 px-3 pt-2 pb-1">
                            <Clock size={10} className="text-app-muted/30" aria-hidden="true" />
                            <span className="text-[10px] uppercase tracking-widest text-app-muted/40 font-medium">Recent</span>
                        </li>
                    )}
                    {dropItems.map((conn, index) => (
                        <li
                            key={conn.id}
                            id={`${listboxId}-opt-${index}`}
                            role="option"
                            aria-selected={activeIndex === index}
                            className={cn(
                                'flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors',
                                activeIndex === index ? 'bg-app-surface/70' : 'hover:bg-app-surface/40'
                            )}
                            onClick={() => onSelectExisting(conn.id)}
                            onMouseEnter={() => setActiveIndex(index)}
                        >
                            <div className="relative shrink-0">
                                <OSIcon icon={conn.icon || 'Server'} className="w-3.5 h-3.5 text-app-muted/60" />
                                {conn.status === 'connected' && (
                                    <span
                                        className="absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-green-500 border border-app-panel"
                                        aria-hidden="true"
                                    />
                                )}
                            </div>

                            <div className="flex-1 min-w-0">
                                <span className="block text-xs font-medium text-app-text truncate">{conn.name || conn.host}</span>
                                <span className="block text-[10px] text-app-muted/60 font-mono truncate">
                                    {conn.username}@{conn.host}:{conn.port}
                                </span>
                            </div>

                            {conn.status === 'connected' && (
                                <span className="text-[9px] text-green-500/70 font-medium shrink-0">live</span>
                            )}
                        </li>
                    ))}
                </motion.ul>
            )}
        </AnimatePresence>
    );
}
