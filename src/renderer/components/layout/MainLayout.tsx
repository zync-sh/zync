import { Code, Files, LayoutDashboard, Network, Terminal as TerminalIcon } from 'lucide-react';
import { useState } from 'react';
import { type Tab, useConnections } from '../../context/ConnectionContext';
// import { useSettings } from '../../context/SettingsContext';
import { cn } from '../../lib/utils';
import { Dashboard } from '../dashboard/Dashboard';
import { WelcomeScreen } from '../dashboard/WelcomeScreen';
import { FileManager } from '../FileManager';
import { AddConnectionModal } from '../modals/AddConnectionModal';
import { SnippetsManager } from '../snippets/SnippetsManager';
import { TerminalManager } from '../terminal/TerminalManager';
import { TunnelManager } from '../tunnel/TunnelManager';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { TabBar } from './TabBar';

function TabContent({ tab, isActive }: { tab: Tab; isActive: boolean }) {
  const { setTabView } = useConnections();

  // Each tab content is rendered but hidden if not active
  return (
    <div className={cn('absolute inset-0 flex flex-col bg-app-bg', !isActive && 'hidden')}>
      {/* Tab Toolbar (View Switcher) */}
      <div className="h-10 shrink-0 border-b border-app-border flex items-center px-4 bg-app-panel gap-4">
        <button
          onClick={() => {
            console.log(`[MainLayout] Switching to Files tab for connection: ${tab.connectionId}`);
            setTabView(tab.id, 'files');
          }}
          className={cn(
            'flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg transition-all',
            tab.view === 'files'
              ? 'bg-app-accent/10 text-app-accent font-medium shadow-sm'
              : 'text-app-muted hover:text-app-text hover:bg-app-surface',
          )}
        >
          <Files size={14} /> Files
        </button>
        <button
          onClick={() => {
            console.log(`[MainLayout] Switching to Dashboard tab for connection: ${tab.connectionId}`);
            setTabView(tab.id, 'dashboard');
          }}
          className={cn(
            'flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg transition-all',
            tab.view === 'dashboard'
              ? 'bg-app-accent/10 text-app-accent font-medium shadow-sm'
              : 'text-app-muted hover:text-app-text hover:bg-app-surface',
          )}
        >
          <LayoutDashboard size={14} /> Dashboard
        </button>
        <button
          onClick={() => {
            console.log(`[MainLayout] Switching to Tunnels tab for connection: ${tab.connectionId}`);
            setTabView(tab.id, 'tunnels');
          }}
          className={cn(
            'flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg transition-all',
            tab.view === 'tunnels'
              ? 'bg-app-accent/10 text-app-accent font-medium shadow-sm'
              : 'text-app-muted hover:text-app-text hover:bg-app-surface',
          )}
        >
          <Network size={14} /> Tunnels
        </button>
        <button
          onClick={() => {
            console.log(`[MainLayout] Switching to Snippets tab for connection: ${tab.connectionId}`);
            setTabView(tab.id, 'snippets');
          }}
          className={cn(
            'flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg transition-all',
            tab.view === 'snippets'
              ? 'bg-app-accent/10 text-app-accent font-medium shadow-sm'
              : 'text-app-muted hover:text-app-text hover:bg-app-surface',
          )}
        >
          <Code size={14} /> Snippets
        </button>
        <button
          onClick={() => {
            console.log(`[MainLayout] Switching to Terminal tab for connection: ${tab.connectionId}`);
            setTabView(tab.id, 'terminal');
          }}
          className={cn(
            'flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg transition-all',
            tab.view === 'terminal'
              ? 'bg-app-accent/10 text-app-accent font-medium shadow-sm'
              : 'text-app-muted hover:text-app-text hover:bg-app-surface',
          )}
        >
          <TerminalIcon size={14} /> Terminal
        </button>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-hidden relative flex flex-col">
        <div className={cn('absolute inset-0 z-10 bg-app-bg', tab.view === 'files' ? 'block' : 'hidden')}>
          <FileManager connectionId={tab.connectionId} />
        </div>
        <div className={cn('absolute inset-0 z-10 bg-app-bg', tab.view === 'dashboard' ? 'block' : 'hidden')}>
          <Dashboard connectionId={tab.connectionId} />
        </div>
        {/* Tunnels & Snippets can be conditionally rendered or hidden. 
                    Tunnels holds network state? No, backend holds state. UI can remount.
                    But let's hide only if necessary. Since tunnel manager works on load, remount is fine.
                */}
        {tab.view === 'tunnels' && (
          <div className="absolute inset-0 z-10 bg-app-bg">
            <TunnelManager connectionId={tab.connectionId} />
          </div>
        )}
        {tab.view === 'snippets' && (
          <div className="absolute inset-0 z-10 bg-app-bg">
            <SnippetsManager />
          </div>
        )}

        {/* 
                    Terminal View: MUST be kept alive (hidden, not unmounted) to preserve Xterm state/buffer. 
                    We render it always but control visibility.
                */}
        <div className={cn('absolute inset-0 z-10 bg-app-bg', tab.view === 'terminal' ? 'block' : 'hidden')}>
          {/* We used to use TerminalPanel, now using TerminalManager for tabs */}
          <TerminalManager connectionId={tab.connectionId} />
        </div>
      </div>
    </div>
  );
}

export function MainLayout() {
  const { tabs, activeTabId } = useConnections();
  // const { settings } = useSettings();
  const [isAppMode, setIsAppMode] = useState(false);

  const showSidebar = tabs.length > 0 || isAppMode;

  return (
    <div className="flex h-screen bg-app-bg text-app-text font-sans selection:bg-app-accent/30 overflow-hidden">
      {showSidebar && <Sidebar />}

      <div className="flex-1 flex flex-col min-w-0 bg-app-bg">
        {/* Tab Bar - Show only if we have tabs or maybe if in AppMode? No, TabBar empty is useless. */}
        {tabs.length > 0 && <TabBar />}

        {/* Main Content Area */}
        <div className="flex-1 overflow-hidden relative flex flex-col">
          {tabs.length > 0 ? (
            tabs.map((tab) => <TabContent key={tab.id} tab={tab} isActive={tab.id === activeTabId} />)
          ) : (
            <WelcomeScreen onGoToApp={!showSidebar ? () => setIsAppMode(true) : undefined} />
          )}
        </div>

        {/* Status Bar */}
        <StatusBar />
      </div>
      <AddConnectionModal />
    </div>
  );
}
