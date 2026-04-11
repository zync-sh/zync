import { useState } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { cn } from '../../../lib/utils';

interface SidebarSectionProps {
    title: string;
    count?: number;
    children: React.ReactNode;
    defaultExpanded?: boolean;
    compactMode?: boolean;
    onDrop?: (e: React.DragEvent) => void;
    onContextMenu?: (e: React.MouseEvent) => void;
}

export function SidebarSection({
    title,
    count,
    children,
    defaultExpanded = true,
    compactMode = false,
    onDrop,
    onContextMenu
}: SidebarSectionProps) {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);

    return (
        <div
            className="mb-2"
            onDragOver={onDrop ? (e) => {
                e.preventDefault();
                e.stopPropagation();
            } : undefined}
            onDrop={onDrop ? (e) => {
                e.preventDefault();
                e.stopPropagation();
                const types = Array.from(e.dataTransfer.types || []);
                const isExternal = types.includes('Files') || types.includes('text/uri-list');
                if (isExternal) {
                    useAppStore.getState().showToast('info', 'External drop here is currently disabled. We are working to bring this feature to Zync soon!');
                    return;
                }
                onDrop(e);
            } : undefined}
        >
            <button
                onClick={() => setIsExpanded(!isExpanded)}
                aria-expanded={isExpanded}
                onContextMenu={onContextMenu}
                className={cn(
                    "w-full flex items-center gap-1 group select-none mb-1",
                    compactMode ? "px-2" : "px-4"
                )}
            >
                {isExpanded ? (
                    <ChevronDown size={12} className="text-app-muted group-hover:text-app-text transition-colors" />
                ) : (
                    <ChevronRight size={12} className="text-app-muted group-hover:text-app-text transition-colors" />
                )}
                <span className="text-xs font-bold text-app-muted group-hover:text-app-text transition-colors uppercase tracking-wider">
                    {title}
                </span>
                {count !== undefined && count > 0 && (
                    <span className="ml-auto text-[10px] font-medium text-app-accent bg-app-accent/10 px-1.5 rounded-full">
                        {count}
                    </span>
                )}
            </button>

            {isExpanded && (
                <div className="animate-in fade-in slide-in-from-top-1 duration-200">
                    {children}
                </div>
            )}
        </div>
    );
}
