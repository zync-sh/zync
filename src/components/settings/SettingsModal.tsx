import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../../store/useAppStore'; // Updated Import
import { X, Type, Monitor, FileText, Keyboard, Info, Check, RefreshCw, AlertTriangle, Download, Folder, Settings as SettingsIcon, Star, Gift, ChevronRight, Terminal } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { ToastContainer, showToast } from '../ui/Toast';
import { Select } from '../ui/Select';


interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

type Tab = 'general' | 'terminal' | 'appearance' | 'fileManager' | 'shortcuts' | 'about';

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
    const settings = useAppStore(state => state.settings);
    const updateSettings = useAppStore(state => state.updateSettings);
    const updateTerminalSettings = useAppStore(state => state.updateTerminalSettings);
    const updateFileManagerSettings = useAppStore(state => state.updateFileManagerSettings);
    const updateLocalTermSettings = useAppStore(state => state.updateLocalTermSettings);
    const updateKeybindings = useAppStore(state => state.updateKeybindings);
    const [activeTab, setActiveTab] = useState<Tab>('terminal');
    const [isTransitioning, setIsTransitioning] = useState(false);
    const [wslDistros, setWslDistros] = useState<string[]>([]);

    // About / Update State
    const [appVersion, setAppVersion] = useState('');
    // Global Update State
    // Global Update State
    const updateStatus = useAppStore(state => state.updateStatus);
    const updateInfo = useAppStore(state => state.updateInfo);
    const setUpdateStatus = useAppStore(state => state.setUpdateStatus);
    const setUpdateInfo = useAppStore(state => state.setUpdateInfo);
    const [isAppImage, setIsAppImage] = useState(false);
    const [contributors, setContributors] = useState<any[]>([]);
    const [stars, setStars] = useState<number | null>(null);
    const [showReleaseNotes, setShowReleaseNotes] = useState(false);
    const [releaseNotes, setReleaseNotes] = useState('');
    const [autoUpdateCheck, setAutoUpdateCheck] = useState(false);
    const [showRestartConfirm, setShowRestartConfirm] = useState(false);

    // 3D Tilt State Removed - Moved to TiltLogo component

    useEffect(() => {
        if (isOpen && activeTab === 'about') {
            // Contributors & Stars Cache
            const cachedParams = localStorage.getItem('zync-about-data');
            const now = Date.now();

            if (cachedParams) {
                try {
                    const { contributors, stars, timestamp } = JSON.parse(cachedParams);
                    if (now - timestamp < 3600000) { // 1 hour
                        setContributors(contributors);
                        setStars(stars);
                        return; // Skip fetch
                    }
                } catch { /* ignore */ }
            }

            Promise.all([
                fetch('https://api.github.com/repos/FDgajju/zync/contributors'),
                fetch('https://api.github.com/repos/FDgajju/zync')
            ])
                .then(async ([contribRes, repoRes]) => {
                    const contribData = await contribRes.json();
                    const repoData = await repoRes.json();

                    if (Array.isArray(contribData)) {
                        setContributors(contribData);
                    }
                    if (repoData.stargazers_count) {
                        setStars(repoData.stargazers_count);
                    }

                    localStorage.setItem('zync-about-data', JSON.stringify({
                        contributors: Array.isArray(contribData) ? contribData : [],
                        stars: repoData.stargazers_count,
                        timestamp: now
                    }));
                })
                .catch(console.error);

            // Fetch Release Notes if needed
            if (!releaseNotes) {
                fetch('https://api.github.com/repos/FDgajju/zync/releases/latest')
                    .then(res => res.json())
                    .then(data => {
                        if (data.body) setReleaseNotes(data.body);
                    })
                    .catch(() => setReleaseNotes('Could not load release notes.'));
            }
        }
    }, [isOpen, activeTab]);

    useEffect(() => {
        if (isOpen) {
            if (window.navigator.userAgent.indexOf('Windows') !== -1) {
                window.ipcRenderer.invoke('shell:getWslDistros').then((distros: string[]) => {
                    setWslDistros(distros);
                }).catch(err => console.error('Failed to fetch WSL distros', err));
            }

            // Get Version & AppImage Status
            window.ipcRenderer.invoke('app:getVersion').then(ver => setAppVersion(ver));
            window.ipcRenderer.invoke('app:isAppImage').then(is => setIsAppImage(is));
        }
    }, [isOpen]);

    // Version comparison helper
    const isNewer = (v1: string) => {
        if (!appVersion || !v1) return false;
        try {
            const v1Parts = v1.replace('v', '').split('.').map(Number);
            const appParts = appVersion.replace('v', '').split('.').map(Number);
            for (let i = 0; i < Math.max(v1Parts.length, appParts.length); i++) {
                const a = v1Parts[i] || 0;
                const b = appParts[i] || 0;
                if (a > b) return true;
                if (a < b) return false;
            }
        } catch (e) { return false; }
        return false;
    };

    // Note: Update listeners moved to UpdateNotification.tsx (Global Store)

    // Keyboard Navigation
    useEffect(() => {
        if (!isOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            // Escape to close
            if (e.key === 'Escape') {
                onClose();
                return;
            }

            // Arrow keys for tab navigation
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const tabs: Tab[] = ['general', 'terminal', 'appearance', 'fileManager', 'shortcuts', 'about'];
                const currentIndex = tabs.indexOf(activeTab);
                let nextIndex: number;

                if (e.key === 'ArrowRight') {
                    nextIndex = (currentIndex + 1) % tabs.length;
                } else {
                    nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
                }

                handleTabChange(tabs[nextIndex]);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, activeTab, onClose]);

    // Smooth Tab Transition Handler
    const handleTabChange = (newTab: Tab) => {
        if (newTab === activeTab) return;
        setIsTransitioning(true);
        setTimeout(() => {
            setActiveTab(newTab);
            setIsTransitioning(false);
        }, 150);
    };





    const checkForUpdates = async () => {
        setUpdateStatus('checking');
        try {
            const result = await window.ipcRenderer.invoke('update:check');

            // Handle result directly in case events fail / dev mode
            if (result && result.updateInfo && isNewer(result.updateInfo.version)) {
                setUpdateStatus('available');
                setUpdateInfo(result.updateInfo);
                showToast(`Update v${result.updateInfo.version} available!`, 'info');
            } else {
                setUpdateStatus('not-available');
            }
        } catch (e) {
            setUpdateStatus('error');
            console.error('Update check failed', e);
        }
    };

    const isWindows = window.navigator.userAgent.indexOf('Windows') !== -1;
    // Allow auto-update on Windows and Linux (AppImage context primarily, but UI should allow it)
    const canAutoUpdate = window.electronUtils?.platform !== 'darwin';

    const handleUpdateAction = () => {
        if (updateStatus === 'downloading') return;

        if (updateStatus === 'available') {
            if (canAutoUpdate) {
                // Fix: Must download first!
                window.ipcRenderer.invoke('update:download');
                setUpdateStatus('downloading');
            } else {
                // Manual Download Fallback
                window.ipcRenderer.invoke('shell:open', 'https://github.com/FDgajju/zync/releases/latest');
            }
        } else if (updateStatus === 'ready') {
            // Install & Restart - Show Confirmation First
            setShowRestartConfirm(true);
        } else {
            checkForUpdates();
        }
    };

    const handleConfirmRestart = () => {
        window.ipcRenderer.invoke('update:install');
        setShowRestartConfirm(false); // Just in case
    };

    // Data Path State
    const [currentDataPath, setCurrentDataPath] = useState('');
    const [isDefaultDataPath, setIsDefaultDataPath] = useState(true);

    // Log Path State
    const [currentLogPath, setCurrentLogPath] = useState('');
    const [isDefaultLogPath, setIsDefaultLogPath] = useState(true);

    useEffect(() => {
        if (isOpen) {
            // ... existing calls ...
            window.ipcRenderer.invoke('config:get').then((config: any) => {
                if (config) {
                    setCurrentDataPath(config.dataPath || '');
                    setIsDefaultDataPath(!config.dataPath);

                    setCurrentLogPath(config.logPath || '');
                    setIsDefaultLogPath(!config.logPath);

                    setAutoUpdateCheck(config.autoUpdateCheck !== false);
                }
            });
        }
    }, [isOpen]);

    const handleChangeLocation = async () => {
        const path = await window.ipcRenderer.invoke('config:select-folder');
        if (path) {
            await window.ipcRenderer.invoke('config:set', { dataPath: path });
            setCurrentDataPath(path);
            setIsDefaultDataPath(false);
            // Optional: Trigger a toast or restart notification
        }
    };

    const handleResetLocation = async () => {
        await window.ipcRenderer.invoke('config:set', { dataPath: null }); // Explicitly reset via null
        setCurrentDataPath('');
        setIsDefaultDataPath(true);
    };

    const handleChangeLogLocation = async () => {
        const path = await window.ipcRenderer.invoke('config:select-folder');
        if (path) {
            await window.ipcRenderer.invoke('config:set', { logPath: path });
            setCurrentLogPath(path);
            setIsDefaultLogPath(false);
        }
    };

    const handleResetLogLocation = async () => {
        await window.ipcRenderer.invoke('config:set', { logPath: null }); // Explicitly reset via null
        setCurrentLogPath('');
        setIsDefaultLogPath(true);
    };

    const handleToggleAutoUpdate = async () => {
        const newValue = !autoUpdateCheck;
        setAutoUpdateCheck(newValue);
        await window.ipcRenderer.invoke('config:set', { autoUpdateCheck: newValue });
    };

    if (!isOpen) return null;

    return createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="relative w-[700px] h-[500px] bg-[var(--color-app-bg)] rounded-xl border border-[var(--color-app-border)] shadow-2xl flex overflow-hidden animate-in zoom-in-95 duration-200 ring-1 ring-white/5">

                {/* Sidebar */}
                <div className="w-[180px] flex flex-col border-r border-[var(--color-app-border)]/40 bg-[var(--color-app-surface)]/20 p-2 space-y-0.5">
                    <div className="px-3 py-4 mb-1">
                        <span className="text-xs font-bold text-[var(--color-app-muted)] uppercase tracking-wider opacity-70">Settings</span>
                    </div>

                    <TabButton active={activeTab === 'general'} onClick={() => handleTabChange('general')} icon={<SettingsIcon size={15} />} label="General" />
                    <TabButton active={activeTab === 'terminal'} onClick={() => handleTabChange('terminal')} icon={<Type size={15} />} label="Terminal" />
                    <TabButton active={activeTab === 'appearance'} onClick={() => handleTabChange('appearance')} icon={<Monitor size={15} />} label="Appearance" />
                    <TabButton active={activeTab === 'fileManager'} onClick={() => handleTabChange('fileManager')} icon={<FileText size={15} />} label="File Manager" />
                    <TabButton active={activeTab === 'shortcuts'} onClick={() => handleTabChange('shortcuts')} icon={<Keyboard size={15} />} label="Shortcuts" />

                    <div className="mt-auto pt-2 border-t border-[var(--color-app-border)]/30">
                        <TabButton
                            active={activeTab === 'about'}
                            onClick={() => handleTabChange('about')}
                            icon={<Info size={15} />}
                            label="About"
                            badge={updateStatus === 'available' || updateStatus === 'downloading' || updateStatus === 'ready'}
                        />
                    </div>
                </div>

                {/* Content Area */}
                <div className="flex-1 flex flex-col min-w-0 bg-[var(--color-app-bg)]">
                    {/* Header */}
                    <div className="h-14 flex items-center justify-between px-6 border-b border-[var(--color-app-border)]/30 shrink-0">
                        <h2 className="font-medium text-[var(--color-app-text)] text-sm tracking-tight">
                            {activeTab === 'fileManager' ? 'File Manager' : activeTab.charAt(0).toUpperCase() + activeTab.slice(1)}
                        </h2>
                        <button onClick={onClose} className="p-1.5 rounded-md text-[var(--color-app-muted)] hover:text-[var(--color-app-text)] hover:bg-[var(--color-app-surface)] transition-colors">
                            <X size={16} />
                        </button>
                    </div>

                    {/* Scrollable Content */}
                    <div className={`flex-1 overflow-y-auto p-6 space-y-8 transition-opacity duration-150 ${isTransitioning ? 'opacity-0' : 'opacity-100'}`}>

                        {activeTab === 'general' && (
                            <div className="space-y-8 animate-in fade-in duration-300">
                                <Section title="Application">
                                    <div className="p-4 rounded-lg bg-[var(--color-app-surface)]/50 border border-[var(--color-app-border)]">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-start gap-3">
                                                <div className="p-2 bg-[var(--color-app-bg)] rounded-md border border-[var(--color-app-border)] text-[var(--color-app-accent)]">
                                                    <RefreshCw size={20} />
                                                </div>
                                                <div>
                                                    <h4 className="text-sm font-medium text-[var(--color-app-text)]">Auto-Check for Updates</h4>
                                                    <p className="text-xs text-[var(--color-app-muted)] mt-1">
                                                        Automatically check for new versions when Zync starts.
                                                    </p>
                                                </div>
                                            </div>
                                            <button
                                                onClick={handleToggleAutoUpdate}
                                                className={`w-11 h-6 rounded-full transition-colors relative focus:outline-none focus:ring-2 focus:ring-[var(--color-app-accent)]/50 ${autoUpdateCheck ? 'bg-[var(--color-app-accent)]' : 'bg-[var(--color-app-border)]'
                                                    }`}
                                            >
                                                <span
                                                    className={`absolute top-1 left-1 bg-white w-4 h-4 rounded-full transition-transform ${autoUpdateCheck ? 'translate-x-5' : 'translate-x-0'
                                                        }`}
                                                />
                                            </button>
                                        </div>
                                    </div>
                                </Section>

                                <Section title="Data Storage">
                                    <div className="space-y-4">
                                        <div className="p-4 rounded-lg bg-[var(--color-app-surface)]/50 border border-[var(--color-app-border)]">
                                            <div className="flex items-start gap-3">
                                                <div className="p-2 bg-[var(--color-app-bg)] rounded-md border border-[var(--color-app-border)] text-[var(--color-app-accent)]">
                                                    <Folder size={20} />
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <h4 className="text-sm font-medium text-[var(--color-app-text)]">Storage Location</h4>
                                                    <p className="text-xs text-[var(--color-app-muted)] mt-1 mb-3">
                                                        Where Zync stores your connections, snippets, port forwards, and settings.
                                                    </p>
                                                    <div className="flex items-center gap-2 mb-3">
                                                        <code className="px-2 py-1 bg-[var(--color-app-bg)] border border-[var(--color-app-border)] rounded text-xs font-mono text-[var(--color-app-text)] truncate max-w-full block">
                                                            {isDefaultDataPath
                                                                ? (isWindows ? '%APPDATA%\\zync' : '~/.config/zync')
                                                                : currentDataPath}
                                                        </code>
                                                        {isDefaultDataPath && <span className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-app-muted)] border border-[var(--color-app-border)] px-1.5 py-0.5 rounded">Default</span>}
                                                    </div>

                                                    <div className="flex gap-2">
                                                        <button
                                                            onClick={handleChangeLocation}
                                                            className="px-3 py-1.5 bg-[var(--color-app-surface)] hover:bg-[var(--color-app-bg)] border border-[var(--color-app-border)] rounded-lg text-xs font-medium text-[var(--color-app-text)] transition-colors flex items-center gap-2"
                                                        >
                                                            Change Location
                                                        </button>
                                                        {!isDefaultDataPath && (
                                                            <button
                                                                onClick={handleResetLocation}
                                                                className="px-3 py-1.5 bg-[var(--color-app-surface)] hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/30 border border-[var(--color-app-border)] rounded-lg text-xs font-medium text-[var(--color-app-muted)] transition-colors"
                                                            >
                                                                Reset to Default
                                                            </button>
                                                        )}
                                                        <button
                                                            onClick={() => {
                                                                if (confirm("Are you sure you want to clear all connections? This cannot be undone.")) {
                                                                    useAppStore.getState().clearConnections();
                                                                    showToast("Connections cleared.", "info");
                                                                }
                                                            }}
                                                            className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded-lg text-xs font-medium text-red-500 transition-colors"
                                                        >
                                                            Clear All Connections
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </Section>

                                <div className="h-px bg-[var(--color-app-border)]/20 my-2" />

                                <Section title="Log Storage">
                                    <div className="space-y-4">
                                        <div className="p-4 rounded-lg bg-[var(--color-app-surface)]/50 border border-[var(--color-app-border)]">
                                            <div className="flex items-start gap-3">
                                                <div className="p-2 bg-[var(--color-app-bg)] rounded-md border border-[var(--color-app-border)] text-[var(--color-app-accent)]">
                                                    <FileText size={20} />
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <h4 className="text-sm font-medium text-[var(--color-app-text)]">Log Location</h4>
                                                    <p className="text-xs text-[var(--color-app-muted)] mt-1 mb-3">
                                                        Where Zync stores application logs.
                                                    </p>
                                                    <div className="flex items-center gap-2 mb-3">
                                                        <code className="px-2 py-1 bg-[var(--color-app-bg)] border border-[var(--color-app-border)] rounded text-xs font-mono text-[var(--color-app-text)] truncate max-w-full block">
                                                            {isDefaultLogPath
                                                                ? (isDefaultDataPath ? (isWindows ? '%APPDATA%\\zync\\logs' : '~/.config/zync/logs') : `${currentDataPath}/logs`)
                                                                : currentLogPath}
                                                        </code>
                                                        {isDefaultLogPath && <span className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-app-muted)] border border-[var(--color-app-border)] px-1.5 py-0.5 rounded">Default</span>}
                                                    </div>

                                                    <div className="flex gap-2">
                                                        <button
                                                            onClick={handleChangeLogLocation}
                                                            className="px-3 py-1.5 bg-[var(--color-app-surface)] hover:bg-[var(--color-app-bg)] border border-[var(--color-app-border)] rounded-lg text-xs font-medium text-[var(--color-app-text)] transition-colors flex items-center gap-2"
                                                        >
                                                            Change Location
                                                        </button>
                                                        {!isDefaultLogPath && (
                                                            <button
                                                                onClick={handleResetLogLocation}
                                                                className="px-3 py-1.5 bg-[var(--color-app-surface)] hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/30 border border-[var(--color-app-border)] rounded-lg text-xs font-medium text-[var(--color-app-muted)] transition-colors"
                                                            >
                                                                Reset to Default
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </Section>
                            </div>
                        )}

                        {activeTab === 'terminal' && (
                            <div className="space-y-6">
                                <Section title="Typography">
                                    <div className="grid grid-cols-2 gap-6">
                                        <div className="space-y-3">
                                            <Select
                                                label="Font Family"
                                                value={settings.terminal.fontFamily}
                                                onChange={(val) => updateTerminalSettings({ fontFamily: val })}
                                                options={[
                                                    { value: "'Fira Code', monospace", label: "Fira Code", description: "Modern, ligatures support" },
                                                    { value: "'JetBrains Mono', monospace", label: "JetBrains Mono", description: "Excellent readability" },
                                                    { value: "Menlo, monospace", label: "Menlo", description: "Standard Apple mono" },
                                                    { value: "'Courier New', monospace", label: "Courier New", description: "Classic typewriter" }
                                                ]}
                                                className="bg-app-bg/50"
                                            />
                                        </div>
                                        <div className="space-y-3">
                                            <div className="flex justify-between">
                                                <label className="text-sm font-medium text-[var(--color-app-text)] opacity-80">Font Size</label>
                                                <span className="text-sm text-[var(--color-app-accent)] font-mono">{settings.terminal.fontSize}px</span>
                                            </div>
                                            <input
                                                type="range" min="10" max="24" step="1"
                                                className="w-full accent-[var(--color-app-accent)] h-2 bg-[var(--color-app-surface)] rounded-lg appearance-none cursor-pointer"
                                                value={settings.terminal.fontSize}
                                                onChange={(e) => updateTerminalSettings({ fontSize: parseInt(e.target.value) })}
                                            />
                                        </div>
                                        <div className="space-y-3 col-span-2">
                                            <div className="flex justify-between">
                                                <label className="text-sm font-medium text-[var(--color-app-text)] opacity-80">Internal Padding</label>
                                                <span className="text-sm text-[var(--color-app-accent)] font-mono">{settings.terminal.padding || 12}px</span>
                                            </div>
                                            <input
                                                type="range" min="0" max="48" step="4"
                                                className="w-full accent-[var(--color-app-accent)] h-2 bg-[var(--color-app-surface)] rounded-lg appearance-none cursor-pointer"
                                                value={settings.terminal.padding || 12}
                                                onChange={(e) => updateTerminalSettings({ padding: parseInt(e.target.value) })}
                                            />
                                        </div>
                                    </div>
                                </Section>

                                <div className="h-px bg-[var(--color-app-border)]/20 my-2" />

                                {window.navigator.userAgent.indexOf('Windows') !== -1 && (
                                    <Section title="Local Terminal (Windows)">
                                        <div className="space-y-3">
                                            <Select
                                                label="Default Shell"
                                                value={settings.localTerm?.windowsShell || 'default'}
                                                onChange={(val) => updateLocalTermSettings({ windowsShell: val })}
                                                options={[
                                                    { value: 'default', label: 'Default', icon: <Terminal size={14} />, description: 'System Decision' },
                                                    { value: 'powershell', label: 'PowerShell', icon: <Terminal size={14} /> },
                                                    { value: 'cmd', label: 'Command Prompt', icon: <Terminal size={14} /> },
                                                    { value: 'gitbash', label: 'Git Bash', icon: <Terminal size={14} /> },
                                                    { value: 'wsl', label: 'WSL (Default)', icon: <Terminal size={14} /> },
                                                    ...wslDistros.map(distro => ({
                                                        value: `wsl:${distro}`,
                                                        label: `WSL: ${distro}`,
                                                        icon: <Terminal size={14} />
                                                    }))
                                                ]}
                                                className="bg-app-bg/50"
                                            />
                                            <div className="text-[10px] text-[var(--color-app-muted)] pl-1">
                                                Note: Changes take effect on new split panes or tabs.
                                            </div>
                                        </div>
                                    </Section>
                                )}

                                <div className="h-px bg-[var(--color-app-border)]/20 my-2" />

                                <Section title="Cursor">
                                    <div className="grid grid-cols-3 gap-4">
                                        {(['block', 'bar', 'underline'] as const).map(style => (
                                            <button
                                                key={style}
                                                onClick={() => updateTerminalSettings({ cursorStyle: style })}
                                                className={`p-4 rounded-lg border flex flex-col items-center gap-3 transition-all h-32 justify-center ${settings.terminal.cursorStyle === style
                                                    ? 'bg-[var(--color-app-accent)]/20 border-[var(--color-app-accent)] text-[var(--color-app-text)] ring-1 ring-[var(--color-app-accent)]'
                                                    : 'border-[var(--color-app-border)] hover:bg-[var(--color-app-surface)] text-[var(--color-app-muted)]'
                                                    }`}
                                            >
                                                {/* Visual Representation */}
                                                <div className="h-12 w-24 bg-black/20 rounded border border-[var(--color-app-border)] flex items-center justify-center relative overflow-hidden font-mono text-xs">
                                                    <span className="text-[var(--color-app-muted)]">_</span>
                                                    {/* Cursor Element */}
                                                    <div className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[var(--color-app-accent)] 
                                                        ${style === 'underline' ? 'h-0.5 w-2 mt-2' : style === 'bar' ? 'w-0.5 h-4' : 'w-2 h-4'}
                                                    `} />
                                                </div>
                                                <span className="capitalize text-sm font-medium">{style}</span>
                                            </button>
                                        ))}
                                    </div>
                                </Section>
                            </div>
                        )}

                        {activeTab === 'appearance' && (
                            <div className="space-y-8">
                                <Section title="Theme">
                                    <div className="grid grid-cols-2 gap-4">
                                        {[
                                            { id: 'system', name: 'System', sub: 'Auto-detect', bg: 'linear-gradient(135deg, #09090b 50%, #ffffff 50%)', accent: '#6366f1' },
                                            { id: 'dark', name: 'Dark', sub: 'Default', bg: '#09090b', accent: '#6366f1' }, // Standard Dark
                                            { id: 'midnight', name: 'Midnight', sub: 'Classic Blue', bg: '#0f111a', accent: '#6366f1' }, // Blue Dark
                                            { id: 'light', name: 'Light', sub: 'Theme', bg: '#ffffff', accent: '#0969da' }, // Blue
                                            { id: 'dracula', name: 'Dracula', sub: 'Theme', bg: '#282a36', accent: '#ff79c6' }, // Pink
                                            { id: 'monokai', name: 'Monokai', sub: 'Theme', bg: '#272822', accent: '#a6e22e' }, // Green
                                            { id: 'warm', name: 'Dark Warm', sub: 'Theme', bg: '#1c1917', accent: '#d97706' }, // Amber
                                            { id: 'light-warm', name: 'Light Warm', sub: 'Theme', bg: '#f9f5eb', accent: '#d97706' }, // Amber/Cream
                                        ].map(theme => (
                                            <button
                                                key={theme.id}
                                                onClick={() => updateSettings({ theme: theme.id as any, accentColor: undefined })}
                                                className={`group p-4 rounded-xl border text-left flex items-center gap-4 transition-all relative overflow-hidden ${settings.theme === theme.id
                                                    ? 'bg-[var(--color-app-bg)] border-[var(--color-app-accent)] ring-1 ring-[var(--color-app-accent)]'
                                                    : 'bg-[var(--color-app-bg)]/40 border-[var(--color-app-border)] hover:bg-[var(--color-app-bg)]/60 hover:border-[var(--color-app-border)]'
                                                    }`}
                                            >
                                                {/* Preview Box */}
                                                <div
                                                    className="w-12 h-12 rounded-lg shadow-inner flex items-center justify-center shrink-0 border border-white/10"
                                                    style={{ background: theme.bg }}
                                                >
                                                    <div
                                                        className="w-3 h-3 rounded-full shadow-sm"
                                                        style={{ backgroundColor: theme.accent }}
                                                    />
                                                </div>

                                                {/* Labels */}
                                                <div>
                                                    <div className="font-semibold text-[var(--color-app-text)] text-sm">{theme.name}</div>
                                                    <div className="text-xs text-[var(--color-app-muted)] mt-0.5">{theme.sub}</div>
                                                </div>
                                            </button>
                                        ))}
                                    </div>
                                </Section>

                                <div className="h-px bg-[var(--color-app-border)]/20 my-2" />

                                <Section title="Customization">
                                    <div className="space-y-4">
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium text-[var(--color-app-text)] opacity-80">Accent Color</label>
                                            <div className="flex gap-2 flex-wrap">
                                                {['#6366f1', '#0969da', '#10b981', '#ef4444', '#f59e0b', '#8b5cf6', '#ec4899'].map(color => (
                                                    <button
                                                        key={color}
                                                        onClick={() => updateSettings({ accentColor: color })}
                                                        className={`w-8 h-8 rounded-full border-2 transition-all ${settings.accentColor === color || (!settings.accentColor && color === '#6366f1')
                                                            ? 'border-[var(--color-app-text)] scale-110'
                                                            : 'border-transparent hover:scale-110'
                                                            }`}
                                                        style={{ backgroundColor: color }}
                                                    />
                                                ))}
                                                <input
                                                    type="color"
                                                    value={settings.accentColor || '#6366f1'}
                                                    onChange={(e) => updateSettings({ accentColor: e.target.value })}
                                                    className="w-8 h-8 rounded-lg overflow-hidden border-0 p-0 cursor-pointer"
                                                />
                                            </div>
                                        </div>

                                        <div className="space-y-3 pt-4 border-t border-[var(--color-app-border)]/50">
                                            <div className="flex justify-between">
                                                <label className="text-sm font-medium text-[var(--color-app-text)] opacity-80">Window Opacity</label>
                                                <span className="text-sm text-[var(--color-app-accent)] font-mono">{Math.round((settings.windowOpacity ?? 0.95) * 100)}%</span>
                                            </div>
                                            <input
                                                type="range" min="50" max="100" step="1"
                                                className="w-full accent-[var(--color-app-accent)] h-2 bg-[var(--color-app-surface)] rounded-lg appearance-none cursor-pointer"
                                                value={(settings.windowOpacity ?? 0.95) * 100}
                                                onChange={(e) => updateSettings({ windowOpacity: parseInt(e.target.value) / 100 })}
                                            />
                                            <div className="text-xs text-[var(--color-app-muted)]">
                                                Note: Requires app restart to enable transparency support if currently disabled.
                                            </div>
                                        </div>
                                    </div>
                                </Section>

                                <div className="h-px bg-[var(--color-app-border)]/20 my-2" />

                                <Section title="Interface">
                                    <div className="space-y-4">
                                        <div className="flex items-center justify-between p-4 bg-[var(--color-app-surface)]/50 rounded-lg border border-[var(--color-app-border)]/50">
                                            <div>
                                                <div className="text-sm font-medium text-[var(--color-app-text)]">Compact Mode</div>
                                                <div className="text-xs text-[var(--color-app-muted)] mt-1">Reduce spacing for denser UI</div>
                                            </div>
                                            <label className="relative inline-flex items-center cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    checked={settings.compactMode}
                                                    onChange={(e) => updateSettings({ compactMode: e.target.checked })}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-11 h-6 bg-[var(--color-app-bg)] border-2 border-[var(--color-app-border)] rounded-full peer peer-checked:after:translate-x-full peer-checked:bg-[var(--color-app-accent)] after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
                                            </label>
                                        </div>

                                        <div className="flex items-center justify-between p-4 bg-[var(--color-app-surface)]/50 rounded-lg border border-[var(--color-app-border)]/50">
                                            <div>
                                                <div className="text-sm font-medium text-[var(--color-app-text)]">Vibrancy Effects</div>
                                                <div className="text-xs text-[var(--color-app-muted)] mt-1">Enable translucent background blur</div>
                                            </div>
                                            <label className="relative inline-flex items-center cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    checked={settings.enableVibrancy}
                                                    onChange={(e) => updateSettings({ enableVibrancy: e.target.checked })}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-11 h-6 bg-[var(--color-app-bg)] border-2 border-[var(--color-app-border)] rounded-full peer peer-checked:after:translate-x-full peer-checked:bg-[var(--color-app-accent)] after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all"></div>
                                            </label>
                                        </div>
                                    </div>
                                </Section>
                            </div>
                        )}

                        {activeTab === 'fileManager' && (
                            <div className="space-y-8">
                                <Section title="Behavior">
                                    <div className="space-y-4">
                                        <Toggle
                                            label="Show Hidden Files"
                                            description="Display files starting with ."
                                            checked={settings.fileManager.showHiddenFiles}
                                            onChange={(v) => updateFileManagerSettings({ showHiddenFiles: v })}
                                        />
                                        <Toggle
                                            label="Confirm Deletion"
                                            description="Ask for confirmation before deleting files"
                                            checked={settings.fileManager.confirmDelete}
                                            onChange={(v) => updateFileManagerSettings({ confirmDelete: v })}
                                        />
                                    </div>
                                </Section>
                            </div>
                        )}

                        {activeTab === 'shortcuts' && (
                            <div className="space-y-8 animate-in fade-in duration-300">
                                <Section title="Global Shortcuts">
                                    <div className="space-y-2">
                                        <KeybindingRow
                                            label="New Connection"
                                            binding={settings.keybindings?.openNewConnection || 'Mod+N'}
                                            onChange={(val) => updateKeybindings({ openNewConnection: val })}
                                        />
                                        <KeybindingRow
                                            label="Toggle Sidebar"
                                            binding={settings.keybindings?.toggleSidebar || 'Mod+B'}
                                            onChange={(val) => updateKeybindings({ toggleSidebar: val })}
                                        />
                                        <KeybindingRow
                                            label="Local Terminal"
                                            binding={settings.keybindings?.newLocalTerminal || 'Mod+T'}
                                            onChange={(val) => updateKeybindings({ newLocalTerminal: val })}
                                        />
                                        <KeybindingRow
                                            label="Settings"
                                            binding={settings.keybindings?.toggleSettings || 'Mod+,'}
                                            onChange={(val) => updateKeybindings({ toggleSettings: val })}
                                        />
                                    </div>
                                </Section>

                                <Section title="File Manager">
                                    <div className="space-y-2">
                                        <div className="grid grid-cols-2 gap-4">
                                            <div className="space-y-2">
                                                <KeybindingRow
                                                    label="Copy"
                                                    binding={settings.keybindings?.fmCopy || 'Mod+C'}
                                                    onChange={(val) => updateKeybindings({ fmCopy: val })}
                                                />
                                                <KeybindingRow
                                                    label="Cut"
                                                    binding={settings.keybindings?.fmCut || 'Mod+X'}
                                                    onChange={(val) => updateKeybindings({ fmCut: val })}
                                                />
                                                <KeybindingRow
                                                    label="Paste"
                                                    binding={settings.keybindings?.fmPaste || 'Mod+V'}
                                                    onChange={(val) => updateKeybindings({ fmPaste: val })}
                                                />
                                            </div>
                                            <div className="space-y-2">
                                                <KeybindingRow
                                                    label="Select All"
                                                    binding={settings.keybindings?.fmSelectAll || 'Mod+A'}
                                                    onChange={(val) => updateKeybindings({ fmSelectAll: val })}
                                                />
                                                <KeybindingRow
                                                    label="Rename"
                                                    binding={settings.keybindings?.fmRename || 'F2'}
                                                    onChange={(val) => updateKeybindings({ fmRename: val })}
                                                />
                                                <KeybindingRow
                                                    label="Delete"
                                                    binding={settings.keybindings?.fmDelete || 'Delete'}
                                                    onChange={(val) => updateKeybindings({ fmDelete: val })}
                                                />
                                            </div>
                                        </div>

                                        <div className="h-px bg-[var(--color-app-border)]/50 my-2" />

                                        <KeybindingRow
                                            label="Edit Path"
                                            binding={settings.keybindings?.fmEditPath || 'Mod+L'}
                                            onChange={(val) => updateKeybindings({ fmEditPath: val })}
                                        />

                                        <div className="h-px bg-[var(--color-app-border)]/50 my-2" />

                                        <KeybindingRow
                                            label="Open Selection"
                                            binding={settings.keybindings?.fmOpen || 'Enter'}
                                            onChange={(val) => updateKeybindings({ fmOpen: val })}
                                        />
                                        <KeybindingRow
                                            label="Go Up"
                                            binding={settings.keybindings?.fmUp || 'Backspace'}
                                            onChange={(val) => updateKeybindings({ fmUp: val })}
                                        />
                                        <div className="grid grid-cols-2 gap-4">
                                            <KeybindingRow
                                                label="Go Back"
                                                binding={settings.keybindings?.fmBack || 'Alt+Left'}
                                                onChange={(val) => updateKeybindings({ fmBack: val })}
                                            />
                                            <KeybindingRow
                                                label="Go Forward"
                                                binding={settings.keybindings?.fmForward || 'Alt+Right'}
                                                onChange={(val) => updateKeybindings({ fmForward: val })}
                                            />
                                        </div>
                                    </div>
                                </Section>

                                <Section title="Tabs">
                                    <div className="space-y-2">
                                        <KeybindingRow
                                            label="New Terminal (Current Host)"
                                            binding={settings.keybindings?.newHostTerminal || 'Mod+Shift+T'}
                                            onChange={(val) => updateKeybindings({ newHostTerminal: val })}
                                        />
                                        <KeybindingRow
                                            label="Close Tab"
                                            binding={settings.keybindings?.closeTab || 'Mod+W'}
                                            onChange={(val) => updateKeybindings({ closeTab: val })}
                                        />
                                        <KeybindingRow
                                            label="Next Tab"
                                            binding={settings.keybindings?.switchTabNext || 'Ctrl+Tab'}
                                            onChange={(val) => updateKeybindings({ switchTabNext: val })}
                                        />
                                        <KeybindingRow
                                            label="Previous Tab"
                                            binding={settings.keybindings?.switchTabPrev || 'Ctrl+Shift+Tab'}
                                            onChange={(val) => updateKeybindings({ switchTabPrev: val })}
                                        />
                                        <div className="h-px bg-[var(--color-app-border)]/50 my-2" />
                                        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(n => (
                                            <KeybindingRow
                                                key={n}
                                                label={`Switch to Tab ${n}`}
                                                binding={(settings.keybindings as any)?.[`switchTab${n}`] || `Mod+${n}`}
                                                onChange={(val) => updateKeybindings({ [`switchTab${n}`]: val } as any)}
                                            />
                                        ))}
                                    </div>
                                </Section>

                                <Section title="Terminal (Active)">
                                    <div className="space-y-2">
                                        <KeybindingRow
                                            label="Copy"
                                            binding={settings.keybindings?.termCopy || 'Mod+Shift+C'}
                                            onChange={(val) => updateKeybindings({ termCopy: val })}
                                        />
                                        <KeybindingRow
                                            label="Paste"
                                            binding={settings.keybindings?.termPaste || 'Mod+Shift+V'}
                                            onChange={(val) => updateKeybindings({ termPaste: val })}
                                        />
                                        <KeybindingRow
                                            label="Find"
                                            binding={settings.keybindings?.termFind || 'Mod+F'}
                                            onChange={(val) => updateKeybindings({ termFind: val })}
                                        />
                                        <KeybindingRow
                                            label="Close Terminal Tab"
                                            binding={settings.keybindings?.closeTerminalTab || 'Mod+Shift+W'}
                                            onChange={(val) => updateKeybindings({ closeTerminalTab: val })}
                                        />
                                    </div>
                                </Section>

                                <Section title="View">
                                    <div className="space-y-2">
                                        <KeybindingRow
                                            label="Zoom In"
                                            binding={settings.keybindings?.zoomIn || 'Mod+='}
                                            onChange={(val) => updateKeybindings({ zoomIn: val })}
                                        />
                                        <KeybindingRow
                                            label="Zoom Out"
                                            binding={settings.keybindings?.zoomOut || 'Mod+-'}
                                            onChange={(val) => updateKeybindings({ zoomOut: val })}
                                        />
                                    </div>
                                </Section>
                            </div>
                        )}

                        {activeTab === 'about' && (
                            <div className="flex flex-col items-center justify-start min-h-full pt-16 pb-8 space-y-6 animate-in fade-in duration-300">
                                {/* Logo & Title (Interactive) */}
                                <TiltLogo />

                                {/* Version Badge */}
                                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[var(--color-app-surface)] border border-[var(--color-app-border)] text-xs font-mono text-[var(--color-app-muted)]">
                                    <span>v{appVersion}</span>
                                    <span className="w-1 h-1 rounded-full bg-[var(--color-app-muted)]/50" />
                                    <span>{isAppImage ? 'AppImage' : isWindows ? 'Windows' : 'Linux'}</span>
                                </div>

                                {/* Update Action */}
                                <div className="flex flex-col items-center gap-3 min-w-[200px] w-full max-w-[240px]">
                                    <button
                                        onClick={handleUpdateAction}
                                        disabled={updateStatus === 'checking' || (canAutoUpdate && updateStatus === 'downloading')}
                                        className={`
                                            flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all w-full
                                            ${updateStatus === 'available'
                                                ? 'bg-[var(--color-app-accent)] text-white hover:opacity-90 shadow-md shadow-[var(--color-app-accent)]/20'
                                                : 'bg-[var(--color-app-surface)] text-[var(--color-app-text)] hover:bg-[var(--color-app-border)]/50 border border-[var(--color-app-border)]'
                                            }
                                            disabled:opacity-50 disabled:cursor-not-allowed
                                        `}
                                    >
                                        <div className={`${updateStatus === 'checking' ? 'animate-spin' : ''}`}>
                                            {updateStatus === 'checking' && <RefreshCw size={14} />}
                                            {updateStatus === 'idle' && <RefreshCw size={14} />}
                                            {updateStatus === 'available' && <Download size={14} />}
                                            {updateStatus === 'not-available' && <Check size={14} />}
                                            {updateStatus === 'error' && <AlertTriangle size={14} />}
                                        </div>
                                        <span>
                                            {updateStatus === 'idle' && 'Check for Updates'}
                                            {updateStatus === 'checking' && 'Checking...'}
                                            {updateStatus === 'available' && 'Download Update'}
                                            {updateStatus === 'downloading' && (
                                                <>
                                                    <RefreshCw size={14} className="animate-spin" />
                                                    <span>Downloading...</span>
                                                </>
                                            )}
                                            {updateStatus === 'ready' && 'Install & Restart'}
                                            {updateStatus === 'not-available' && 'Up to date'}
                                            {updateStatus === 'error' && 'Check Failed'}
                                        </span>
                                    </button>

                                    {/* What's New Button (Release Notes) */}
                                    <button
                                        onClick={() => setShowReleaseNotes(!showReleaseNotes)}
                                        className="text-xs text-[var(--color-app-muted)] hover:text-[var(--color-app-accent)] flex items-center gap-1 transition-colors"
                                    >
                                        <Gift size={12} />
                                        <span>What's New in v{appVersion}?</span>
                                        <ChevronRight size={12} className={`transition-transform duration-200 ${showReleaseNotes ? 'rotate-90' : ''}`} />
                                    </button>

                                    {/* Release Notes Expandable */}
                                    {showReleaseNotes && (
                                        <div className="w-full bg-[var(--color-app-surface)]/30 border border-[var(--color-app-border)] rounded-lg p-3 text-xs text-left max-h-60 overflow-y-auto animate-in fade-in slide-in-from-top-2 custom-scrollbar">
                                            <div className="prose prose-invert prose-xs max-w-none text-[var(--color-app-text)] opacity-90 [&>ul]:list-disc [&>ul]:pl-4 [&>ol]:list-decimal [&>ol]:pl-4 [&>h1]:text-sm [&>h2]:text-xs [&>h2]:font-bold [&>h3]:text-xs [&>h3]:font-semibold [&>p]:mb-2 [&>a]:text-[var(--color-app-accent)]">
                                                {releaseNotes ? <ReactMarkdown>{releaseNotes}</ReactMarkdown> : 'Loading release notes...'}
                                            </div>
                                        </div>
                                    )}

                                    {updateStatus === 'available' && updateInfo && (
                                        <span className="text-xs text-[var(--color-app-accent)] font-medium">
                                            v{updateInfo.version} is available
                                        </span>
                                    )}
                                </div>

                                {/* Links */}
                                <div className="flex items-center gap-4 pt-4 border-t border-[var(--color-app-border)]/50 w-full max-w-xs justify-center">
                                    <button
                                        onClick={() => window.ipcRenderer.invoke('shell:open', 'https://github.com/FDgajju/zync')}
                                        className="text-xs text-[var(--color-app-muted)] hover:text-[var(--color-app-text)] transition-colors flex items-center gap-1.5"
                                    >
                                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>
                                        GitHub
                                        {stars !== null && (
                                            <span className="flex items-center gap-0.5 bg-[var(--color-app-surface)] text-[var(--color-app-text)] px-1.5 py-0.5 rounded-full border border-[var(--color-app-border)] text-[10px]">
                                                <Star size={8} fill="currentColor" className="text-yellow-500" />
                                                {stars > 1000 ? `${(stars / 1000).toFixed(1)}k` : stars}
                                            </span>
                                        )}
                                    </button>
                                    <span className="text-[var(--color-app-border)]">|</span>
                                    <button
                                        onClick={() => window.ipcRenderer.invoke('shell:open', 'https://zync.thesudoer.in')}
                                        className="text-xs text-[var(--color-app-muted)] hover:text-[var(--color-app-text)] transition-colors flex items-center gap-1.5"
                                    >
                                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
                                        Website
                                    </button>
                                </div>

                                {/* Contributors */}
                                <div className="mt-auto pt-8 text-center w-full">
                                    <div className="text-[10px] uppercase tracking-wider text-[var(--color-app-muted)] mb-3 font-semibold">
                                        Contributors
                                    </div>
                                    <div className="flex flex-wrap justify-center gap-2 max-w-[280px] mx-auto">
                                        {contributors.map((c: any) => (
                                            <a
                                                key={c.id}
                                                href={c.html_url}
                                                onClick={(e) => { e.preventDefault(); window.ipcRenderer.invoke('shell:open', c.html_url); }}
                                                className="relative group block"
                                                title={c.login}
                                            >
                                                <img
                                                    src={c.avatar_url}
                                                    alt={c.login}
                                                    className="w-8 h-8 rounded-full border border-[var(--color-app-border)] bg-[var(--color-app-surface)] grayscale group-hover:grayscale-0 transition-all group-hover:scale-110 group-hover:border-[var(--color-app-accent)]"
                                                />
                                            </a>
                                        ))}
                                    </div>
                                    <p className="text-[10px] text-[var(--color-app-muted)]/40 font-mono mt-4">© 2026 Zync</p>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
                {/* Restart Confirmation Overlay */}
                {showRestartConfirm && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                        <div className="bg-[var(--color-app-bg)] rounded-xl border border-[var(--color-app-border)] shadow-2xl p-6 w-[320px] animate-in zoom-in-95 text-center">
                            <div className="w-12 h-12 rounded-full bg-[var(--color-app-accent)]/10 text-[var(--color-app-accent)] flex items-center justify-center mx-auto mb-4">
                                <RefreshCw size={24} />
                            </div>
                            <h3 className="text-lg font-bold text-[var(--color-app-text)] mb-2">Ready to Restart?</h3>
                            <p className="text-xs text-[var(--color-app-muted)] mb-6 leading-relaxed">
                                Zync will restart to install the update. Any active SSH sessions will be disconnected.
                            </p>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => setShowRestartConfirm(false)}
                                    className="flex-1 py-2 rounded-lg bg-[var(--color-app-surface)] text-[var(--color-app-text)] text-sm font-medium hover:bg-[var(--color-app-border)] transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleConfirmRestart}
                                    className="flex-1 py-2 rounded-lg bg-[var(--color-app-accent)] text-white text-sm font-medium hover:opacity-90 transition-opacity shadow-lg shadow-[var(--color-app-accent)]/20"
                                >
                                    Restart
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
            <ToastContainer />
        </div>,
        document.body
    );
}

function TabButton({ active, onClick, icon, label, dimmed = false, badge = false }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string, dimmed?: boolean, badge?: boolean }) {
    return (
        <button
            onClick={onClick}
            className={`w-full relative flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all ${dimmed ? 'opacity-30 cursor-default' :
                active
                    ? 'bg-[var(--color-app-surface)] text-[var(--color-app-text)] font-medium shadow-sm'
                    : 'text-[var(--color-app-muted)] hover:text-[var(--color-app-text)] hover:bg-[var(--color-app-surface)]/50'
                }`}
            disabled={dimmed}
        >
            {icon}
            <span>{label}</span>
            {badge && !active && (
                <div className="absolute right-2 top-1/2 -translate-y-1/2 w-2 h-2 bg-[var(--color-app-accent)] rounded-full animate-pulse shadow-[0_0_8px_var(--color-app-accent)]" />
            )}
        </button>
    );
}

function Section({ title, children }: { title: string, children: React.ReactNode }) {
    return (
        <div className="space-y-3">
            <h3 className="text-xs font-semibold text-[var(--color-app-muted)] uppercase tracking-wider opacity-70">{title}</h3>
            {children}
        </div>
    );
}

function Toggle({ label, description, checked, onChange }: { label: string, description: string, checked: boolean, onChange: (v: boolean) => void }) {
    return (
        <div className="flex items-center justify-between py-3 px-4 rounded-lg hover:bg-[var(--color-app-surface)]/30 transition-colors group">
            <div className="flex-1">
                <div className="text-sm font-medium text-[var(--color-app-text)]">{label}</div>
                <div className="text-xs text-[var(--color-app-muted)] mt-0.5">{description}</div>
            </div>
            <button
                onClick={() => onChange(!checked)}
                className={`w-11 h-6 rounded-full transition-all relative ${checked ? 'bg-[var(--color-app-accent)]' : 'bg-[var(--color-app-surface)] border border-[var(--color-app-border)]'}`}
            >
                <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
        </div>
    );
}


// Helper Component for Keybinding Recording
function KeybindingRow({ label, binding, onChange }: { label: string, binding: string, onChange: (val: string) => void }) {
    const [isRecording, setIsRecording] = useState(false);

    // Safety check for binding
    const displayBinding = binding || '';

    useEffect(() => {
        if (!isRecording) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();

            const parts = [];
            if (e.ctrlKey) parts.push('Ctrl');
            if (e.metaKey) parts.push('Mod'); // Simplify Meta to Mod for UI consistency
            if (e.altKey) parts.push('Alt');
            if (e.shiftKey) parts.push('Shift');

            // Don't capture just modifiers
            if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return;

            let key = e.key;
            if (key === ' ') key = 'Space';
            if (key.length === 1) key = key.toUpperCase();

            parts.push(key);

            const newBinding = parts.join('+');

            // Finish recording on key release usually, but for simplicity, finish on valid combo press
            onChange(newBinding);
            setIsRecording(false);
        };

        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
    }, [isRecording, onChange]);

    return (
        <div className="flex items-center justify-between p-3 bg-[var(--color-app-bg)]/30 rounded-lg border border-[var(--color-app-border)] hover:border-[var(--color-app-accent)]/50 transition-colors">
            <span className="text-[var(--color-app-text)] font-medium">{label}</span>
            <button
                onClick={() => setIsRecording(true)}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-mono border transition-all min-w-[100px] justify-center
                    ${isRecording
                        ? 'bg-[var(--color-app-accent)] text-white border-[var(--color-app-accent)] animate-pulse'
                        : 'bg-[var(--color-app-surface)] border-[var(--color-app-border)] text-[var(--color-app-text)] hover:border-[var(--color-app-accent)]'
                    }`}
            >
                {isRecording ? 'Recording...' : displayBinding.split('+').map((k, i) => (
                    <span key={i} className="flex items-center">
                        {k}
                        {i < displayBinding.split('+').length - 1 && <span className="mx-1 opacity-50">+</span>}
                    </span>
                ))}
            </button>
        </div>
    );
}


function TiltLogo() {
    const [tilt, setTilt] = useState({ x: 0, y: 0 });

    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
        const { left, top, width, height } = e.currentTarget.getBoundingClientRect();
        const x = (e.clientX - left - width / 2) / 20; // Increased sensitivity slightly
        const y = (e.clientY - top - height / 2) / 20;

        // React state updates here are isolated to this component now.
        setTilt({ x: -y, y: x });
    };

    const handleMouseLeave = () => {
        setTilt({ x: 0, y: 0 });
    };

    return (
        <div
            className="flex flex-col items-center space-y-4"
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            style={{ perspective: 1000 }}
        >
            <div
                className="w-24 h-24 bg-[var(--color-app-surface)]/50 rounded-2xl flex items-center justify-center shadow-sm border border-[var(--color-app-border)] transition-transform duration-75 ease-out will-change-transform"
                style={{
                    transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg) scale3d(1.05, 1.05, 1.05)`,
                    boxShadow: `${-tilt.y * 2}px ${tilt.x * 2}px 20px rgba(0,0,0,0.1)`
                }}
            >
                <svg width="64" height="64" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" className="select-none pointer-events-none">
                    <rect width="512" height="512" rx="128" className="fill-[var(--color-app-accent)]/10" />
                    <path d="M128 170.667L213.333 256L128 341.333" className="stroke-[var(--color-app-accent)]" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M256 341.333H384" className="stroke-[var(--color-app-text)]" strokeWidth="64" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </div>
            <div className="text-center select-none">
                <h3 className="text-2xl font-bold text-[var(--color-app-text)] tracking-tight">Zync</h3>
                <p className="text-sm text-[var(--color-app-muted)]">The minimal SSH client</p>
            </div>
        </div>
    );
}
