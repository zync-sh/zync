import { ReactNode, lazy, Suspense } from 'react';
import { Sidebar } from './Sidebar';
import { useAppStore, Tab } from '../../store/useAppStore';
import { cn } from '../../lib/utils';
import { Terminal as TerminalIcon, LayoutDashboard, Files, Network, Code } from 'lucide-react';
import { StatusBar } from './StatusBar';
import { TabBar } from './TabBar';
import { ShortcutManager } from '../managers/ShortcutManager';
import { CommandPalette } from './CommandPalette';

// Lazy Load Heavy Components
const FileManager = lazy(() => import('../FileManager').then(module => ({ default: module.FileManager })));
const Dashboard = lazy(() => import('../dashboard/Dashboard').then(module => ({ default: module.Dashboard })));
const TunnelManager = lazy(() => import('../tunnel/TunnelManager').then(module => ({ default: module.TunnelManager })));
const SnippetsManager = lazy(() => import('../snippets/SnippetsManager').then(module => ({ default: module.SnippetsManager })));
const TerminalManager = lazy(() => import('../terminal/TerminalManager').then(module => ({ default: module.TerminalManager })));
const GlobalTunnelList = lazy(() => import('../tunnel/GlobalTunnelList').then(module => ({ default: module.GlobalTunnelList })));

// Loading Component
const TabLoading = () => (
    <div className="absolute inset-0 flex items-center justify-center bg-app-bg">
        <div className="w-6 h-6 border-2 border-app-accent/30 border-t-app-accent rounded-full animate-spin" />
    </div>
);

const SplashScreen = () => (
    <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-app-bg transition-colors duration-300">
        <div className="flex flex-col items-center">
            <svg width="128" height="128" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" className="animate-pulse drop-shadow-2xl">
                <rect width="512" height="512" rx="128" className="fill-app-panel" />
                <path d="M128 170.667L213.333 256L128 341.333" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" className="stroke-app-accent" />
                <path d="M256 341.333H384" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" className="stroke-app-text" />
            </svg>
        </div>
    </div>
);

function TabContent({ tab, isActive }: {
    tab: Tab;
    isActive: boolean;
}) {
    const setTabView = useAppStore(state => state.setTabView); // Updated Hook
    const connections = useAppStore(state => state.connections); // Updated Hook
    const connect = useAppStore(state => state.connect); // Updated Hook
    // Global Tunnels Tab
    if (tab.type === 'tunnels') {
        return (
            <div className={cn(
                "absolute inset-0 z-10 bg-app-bg",
                !isActive && "hidden",
                isActive && "animate-in fade-in zoom-in-95 duration-200"
            )}>
                <Suspense fallback={<TabLoading />}>
                    <GlobalTunnelList />
                </Suspense>
            </div>
        );
    }

    const connection = connections.find((c: any) => c.id === tab.connectionId);
    const isConnecting = connection?.status === 'connecting';
    const isError = connection?.status === 'error';

    // Each tab content is rendered but hidden if not active
    return (
        <div className={cn(
            "absolute inset-0 flex flex-col bg-app-bg transition-all",
            !isActive && "hidden",
            isActive && "animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out fill-mode-forwards"
        )}>
            {isConnecting ? (
                <div className="flex-1 flex flex-col items-center justify-center space-y-4">
                    <div className="w-8 h-8 border-4 border-[var(--color-app-accent)]/30 border-t-[var(--color-app-accent)] rounded-full animate-spin"></div>
                    <div className="text-[var(--color-app-muted)] animate-pulse">Connecting to server...</div>
                </div>
            ) : isError ? (
                <div className="flex-1 flex flex-col items-center justify-center space-y-4">
                    <div className="text-[var(--color-app-danger)] text-4xl mb-4">⚠️</div>
                    <div className="text-xl font-medium text-[var(--color-app-text)]">Connection Failed</div>
                    <div className="text-[var(--color-app-muted)] text-sm max-w-md text-center">
                        Could not establish a connection to <span className="font-mono text-[var(--color-app-text)]">{connection?.host}</span>.
                    </div>
                    <button
                        onClick={() => connection && connect(connection.id)}
                        className="px-4 py-2 bg-[var(--color-app-accent)] text-white rounded-lg hover:brightness-110 transition-all font-medium text-sm mt-4"
                    >
                        Retry Connection
                    </button>
                </div>
            ) : (
                <>
                    {/* Tab Toolbar (View Switcher) */}
                    <div className="h-10 shrink-0 border-b border-app-border flex items-center px-4 bg-app-panel gap-4">
                        <button
                            onClick={() => setTabView(tab.id, 'terminal')}
                            className={cn(
                                "flex items-center gap-2 text-sm px-2 py-1 rounded transition-colors",
                                tab.view === 'terminal' ? "bg-app-accent/10 text-app-accent" : "text-app-muted hover:text-app-text"
                            )}
                        >
                            <TerminalIcon size={14} /> Terminal
                        </button>
                        <button
                            onClick={() => setTabView(tab.id, 'snippets')}
                            className={cn(
                                "flex items-center gap-2 text-sm px-2 py-1 rounded transition-colors",
                                tab.view === 'snippets' ? "bg-app-accent/10 text-app-accent" : "text-app-muted hover:text-app-text"
                            )}
                        >
                            <Code size={14} /> Snippets
                        </button>
                        <button
                            onClick={() => setTabView(tab.id, 'tunnels')}
                            className={cn(
                                "flex items-center gap-2 text-sm px-2 py-1 rounded transition-colors",
                                tab.view === 'tunnels' ? "bg-app-accent/10 text-app-accent" : "text-app-muted hover:text-app-text"
                            )}
                        >
                            <Network size={14} /> Tunnels
                        </button>
                        <button
                            onClick={() => setTabView(tab.id, 'files')}
                            className={cn(
                                "flex items-center gap-2 text-sm px-2 py-1 rounded transition-colors",
                                tab.view === 'files' ? "bg-app-accent/10 text-app-accent" : "text-app-muted hover:text-app-text"
                            )}
                        >
                            <Files size={14} /> Files
                        </button>
                        <button
                            onClick={() => setTabView(tab.id, 'dashboard')}
                            className={cn(
                                "flex items-center gap-2 text-sm px-2 py-1 rounded transition-colors",
                                tab.view === 'dashboard' ? "bg-app-accent/10 text-app-accent" : "text-app-muted hover:text-app-text"
                            )}
                        >
                            <LayoutDashboard size={14} /> Dashboard
                        </button>
                    </div>

                    {/* Content Area */}
                    <div className="flex-1 overflow-hidden relative flex flex-col">
                        <Suspense fallback={<TabLoading />}>
                            <div className={cn("absolute inset-0 z-10 bg-app-bg", tab.view === 'files' ? "block" : "hidden")}>
                                <FileManager connectionId={tab.connectionId} />
                            </div>
                            <div className={cn("absolute inset-0 z-10 bg-app-bg", tab.view === 'dashboard' ? "block" : "hidden")}>
                                <Dashboard connectionId={tab.connectionId} />
                            </div>
                            {/* Tunnels & Snippets */}
                            {tab.view === 'tunnels' && (
                                <div className="absolute inset-0 z-10 bg-app-bg">
                                    <TunnelManager connectionId={tab.connectionId} />
                                </div>
                            )}
                            {tab.view === 'snippets' && (
                                <div className="absolute inset-0 z-10 bg-app-bg">
                                    <SnippetsManager connectionId={tab.connectionId} />
                                </div>
                            )}

                            {/* 
                                Terminal View: MUST be kept alive (hidden, not unmounted) to preserve Xterm state/buffer. 
                                We render it always but control visibility.
                            */}
                            <div className={cn("absolute inset-0 z-10 bg-app-bg", tab.view === 'terminal' ? "block" : "hidden")}>
                                <TerminalManager
                                    connectionId={tab.connectionId}
                                    isVisible={isActive && tab.view === 'terminal'}
                                />
                            </div>
                        </Suspense>
                    </div>
                </>
            )}
        </div>
    );
}


import { useState, useEffect } from 'react';
import { SetupWizard } from '../onboarding/SetupWizard';
// @ts-ignore
const ipc = window.ipcRenderer;

export function MainLayout({ children }: { children: ReactNode }) {
    const tabs = useAppStore(state => state.tabs); // Updated Hook
    const activeTabId = useAppStore(state => state.activeTabId); // Updated Hook
    const isLoadingSettings = useAppStore(state => state.isLoadingSettings);
    const [showWizard, setShowWizard] = useState(false);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        checkConfig();
    }, []);

    // Theme Application Effect
    const theme = useAppStore(state => state.settings.theme);
    useEffect(() => {
        // Persist for splash screen
        localStorage.setItem('zync-theme', theme);

        // Remove old theme classes
        document.body.classList.remove('light', 'dark', 'dracula', 'monokai', 'midnight', 'warm', 'light-warm');

        if (theme === 'system') {
            const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            document.body.classList.add(systemTheme);
        } else {
            document.body.classList.add(theme);
        }
    }, [theme]);

    const checkConfig = async () => {
        try {
            const config = await ipc.invoke('config:get');
            if (!config || !config.isConfigured) {
                setShowWizard(true);
            }
        } catch (error) {
            console.error('Failed to load config:', error);
        } finally {
            setIsLoading(false);
        }
    };

    if (isLoading || isLoadingSettings) return <SplashScreen />;

    return (
        <div className={cn("flex h-screen bg-app-bg text-app-text font-sans selection:bg-app-accent/30 overflow-hidden")}>
            {showWizard && <SetupWizard onComplete={() => setShowWizard(false)} />}
            <CommandPalette />
            <ShortcutManager />
            <Sidebar />

            <div className="flex-1 flex flex-col min-w-0 bg-app-bg">
                {/* Tab Bar */}
                <TabBar />

                {/* Main Content Area */}
                <div className="flex-1 overflow-hidden relative flex flex-col">
                    {tabs.length > 0 ? (
                        tabs.map((tab: Tab) => (
                            <TabContent
                                key={tab.id}
                                tab={tab}
                                isActive={tab.id === activeTabId}
                            />
                        ))
                    ) : (
                        children // Default / Empty State
                    )}
                </div>

                {/* Status Bar */}
                <StatusBar />
            </div>
        </div>
    );
}
