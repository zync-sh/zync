import { Globe, Settings as SettingsIcon, X } from 'lucide-react';
import { useConnections } from '../../context/ConnectionContext';
import { cn } from '../../lib/utils';

export function TabBar() {
  const { tabs, activeTabId, activateTab, closeTab } = useConnections();

  if (tabs.length === 0) return null;

  return (
    <div className="flex h-10 bg-app-bg items-end px-0 border-b border-app-border overflow-x-auto scrollbar-thin scrollbar-thumb-app-border scrollbar-track-transparent pt-1">
      {tabs.map((tab) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: <explanation>
        <div
          key={tab.id}
          onClick={() => activateTab(tab.id)}
          className={cn(
            'group flex shrink-0 items-center gap-2 px-4 py-1.5 min-w-[140px] max-w-[220px] text-sm cursor-pointer select-none transition-all relative border-r border-app-border/20 first:border-l first:border-l-transparent',
            activeTabId === tab.id
              ? 'bg-app-bg text-app-text border-t-2 border-t-app-accent shadow-[0_-1px_2px_rgba(0,0,0,0.1)] z-10'
              : 'bg-app-bg text-app-muted hover:bg-app-text/5 hover:text-app-text border-t-2 border-t-transparent h-full pt-2',
          )}
        >
          {/* Icon based on type */}
          {tab.type === 'connection' ? (
            <Globe size={13} className="shrink-0" />
          ) : (
            <SettingsIcon size={13} className="shrink-0" />
          )}

          <span className="truncate flex-1 font-medium">{tab.title}</span>

          <button
            onClick={(e) => {
              e.stopPropagation();
              closeTab(tab.id);
            }}
            className={cn(
              'p-1 rounded-sm transition-all opacity-0 group-hover:opacity-100 shrink-0',
              activeTabId === tab.id
                ? 'hover:bg-app-surface text-app-muted/70 hover:text-app-text'
                : 'hover:bg-app-text/10 text-app-muted/50 hover:text-app-text',
            )}
          >
            <X size={12} />
          </button>

          {/* Active Tab Bottom Cover (to blend with content) */}
          {activeTabId === tab.id && <div className="absolute -bottom-[1px] left-0 right-0 h-1 bg-app-bg z-20" />}
        </div>
      ))}
    </div>
  );
}
