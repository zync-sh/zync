import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { FolderPlus, Laptop, Link2, Monitor, Network, Search } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { OSIcon } from '../../icons/OSIcon';
import { PublicUrlsLabel } from '../../share/PublicUrlsLabel';
import { HardeningAuditIcon } from '../../icons/HardeningAuditIcon';
import { TopbarDropdown } from '../../ui/TopbarDropdown';
import { APP_ADD_GROUP_LABEL, buildAppAddItems } from './buildAppAddItems';
import { groupAppAddItems, visibleAppAddItems } from './filterAppAddItems';
import type { AppAddCloseSource, AppAddHost, AppAddItem, AppAddOpenState } from './types';

export function AppAddMenu({
    hosts,
    showHostAddressesInLists,
    open,
    onClose,
    onNewHost,
    onNewFolder,
    onNewTunnel,
    onOpenPortForwarding,
    onOpenPublicUrls,
    onOpenSecurityAudits,
    onOpenLocal,
    onOpenHost,
}: {
    hosts: readonly AppAddHost[];
    showHostAddressesInLists?: boolean;
    open?: AppAddOpenState;
    onClose: (source?: AppAddCloseSource) => void;
    onNewHost: () => void;
    onNewFolder: () => void;
    onNewTunnel: () => void;
    onOpenPortForwarding: () => void;
    onOpenPublicUrls: () => void;
    onOpenSecurityAudits: () => void;
    onOpenLocal: () => void;
    onOpenHost: (hostId: string) => void;
}) {
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const searchRef = useRef<HTMLInputElement>(null);
    const listId = useId();

    const items = useMemo(
        () => buildAppAddItems({ hosts, open, showHostAddressesInLists }),
        [hosts, open, showHostAddressesInLists],
    );
    const visible = useMemo(() => visibleAppAddItems(items, query), [items, query]);
    const sections = useMemo(() => groupAppAddItems(visible), [visible]);
    const activeItem = visible.length > 0 ? visible[Math.min(activeIndex, visible.length - 1)] : undefined;
    const activeDescendantId = activeItem ? `${listId}-${activeItem.id}` : undefined;

    useEffect(() => {
        searchRef.current?.focus();
    }, []);

    useEffect(() => {
        setActiveIndex((index) => {
            if (visible.length === 0) return 0;
            return Math.min(index, visible.length - 1);
        });
    }, [visible.length]);

    useEffect(() => {
        if (!activeDescendantId) return;
        document.getElementById(activeDescendantId)?.scrollIntoView({ block: 'nearest' });
    }, [activeDescendantId]);

    const runItem = (item: AppAddItem) => {
        switch (item.kind) {
            case 'new-host':
                onNewHost();
                break;
            case 'new-folder':
                onNewFolder();
                break;
            case 'new-tunnel':
                onNewTunnel();
                break;
            case 'port-forwarding':
                onOpenPortForwarding();
                break;
            case 'public-urls':
                onOpenPublicUrls();
                break;
            case 'security-audits':
                onOpenSecurityAudits();
                break;
            case 'local':
                onOpenLocal();
                break;
            case 'host':
                if (item.hostId) onOpenHost(item.hostId);
                break;
            default:
                return;
        }
        onClose();
    };

    const onMenuKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onClose('keyboard');
    };

    const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (visible.length === 0) return;
            setActiveIndex((index) => (index + 1) % visible.length);
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (visible.length === 0) return;
            setActiveIndex((index) => (index - 1 + visible.length) % visible.length);
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            const item = visible[activeIndex];
            if (item) runItem(item);
        }
    };

    let rowIndex = -1;

    return (
        <TopbarDropdown
            widthClass="w-72"
            className="p-0 flex flex-col shadow-xl"
            role="dialog"
            aria-label="Create or go"
            onKeyDownCapture={onMenuKeyDownCapture}
        >
            <div className="flex items-center gap-2 px-2.5 py-2 border-b border-app-border/60">
                <Search size={13} className="text-app-muted shrink-0" />
                <input
                    ref={searchRef}
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setActiveIndex(0);
                    }}
                    onKeyDown={onSearchKeyDown}
                    placeholder="Create or go…"
                    className="flex-1 min-w-0 bg-transparent text-xs text-app-text placeholder:text-app-muted/50 outline-none"
                    role="combobox"
                    aria-expanded
                    aria-controls={listId}
                    aria-activedescendant={activeDescendantId}
                    aria-autocomplete="list"
                    aria-label="Filter create and go"
                />
            </div>

            <div id={listId} role="listbox" aria-label="Create or go" className="max-h-80 overflow-y-auto py-1">
                {sections.map((section) => (
                    <div key={section.group} className="px-1 pb-1">
                        <div className="px-2.5 py-1 text-[10px] font-bold text-app-muted uppercase tracking-wider">
                            {APP_ADD_GROUP_LABEL[section.group]}
                        </div>
                        {section.items.map((item) => {
                            rowIndex += 1;
                            const index = rowIndex;
                            return (
                                <AppAddRow
                                    key={item.id}
                                    id={`${listId}-${item.id}`}
                                    item={item}
                                    host={item.hostId ? hosts.find((h) => h.id === item.hostId) : undefined}
                                    active={index === activeIndex}
                                    onHover={() => setActiveIndex(index)}
                                    onSelect={() => runItem(item)}
                                />
                            );
                        })}
                    </div>
                ))}
                {visible.length === 0 && (
                    <div className="px-3 py-4 text-xs text-app-muted">No matches</div>
                )}
            </div>
        </TopbarDropdown>
    );
}

function AppAddRow({
    id,
    item,
    host,
    active,
    onHover,
    onSelect,
}: {
    id: string;
    item: AppAddItem;
    host?: AppAddHost;
    active: boolean;
    onHover: () => void;
    onSelect: () => void;
}) {
    return (
        <button
            type="button"
            id={id}
            role="option"
            aria-selected={active}
            onMouseEnter={onHover}
            onClick={onSelect}
            className={cn(
                'w-full min-h-7 text-left px-2.5 py-1 text-xs flex items-center gap-2.5 rounded-md transition-colors',
                active ? 'bg-app-surface text-app-text' : 'text-app-text hover:bg-app-surface',
            )}
        >
            <span className="inline-flex h-5 w-5 items-center justify-center shrink-0 text-app-muted">
                <AppAddIcon item={item} host={host} />
            </span>
            <span className="flex-1 min-w-0 truncate font-medium">
                {item.kind === 'public-urls' ? (
                    <PublicUrlsLabel className="text-xs font-medium" />
                ) : (
                    item.label
                )}
            </span>
            {item.detail && (
                <span className="text-[10px] text-app-muted/70 truncate max-w-[7rem] shrink-0">{item.detail}</span>
            )}
            {item.hint && (
                <span className="text-[10px] text-app-muted/70 shrink-0">{item.hint}</span>
            )}
        </button>
    );
}

function AppAddIcon({ item, host }: { item: AppAddItem; host?: AppAddHost }): ReactNode {
    if (item.kind === 'new-host') return <Laptop size={13} />;
    if (item.kind === 'new-folder') return <FolderPlus size={13} />;
    if (item.kind === 'new-tunnel') return <Network size={13} />;
    if (item.kind === 'port-forwarding') return <Network size={13} />;
    if (item.kind === 'public-urls') return <Link2 size={13} />;
    if (item.kind === 'security-audits') return <HardeningAuditIcon size={13} />;
    if (item.kind === 'local') return <Monitor size={13} />;
    if (item.kind === 'host') {
        return <OSIcon icon={host?.icon || 'Server'} className="w-[13px] h-[13px]" />;
    }
    return <Laptop size={13} />;
}
