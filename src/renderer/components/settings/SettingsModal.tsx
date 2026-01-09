import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useSettings } from '../../context/SettingsContext';
import { X, Type, Monitor, FileText, Keyboard, Info, Check, RefreshCw, AlertTriangle, Download, Folder, Settings as SettingsIcon } from 'lucide-react';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

type Tab = 'general' | 'terminal' | 'appearance' | 'fileManager' | 'shortcuts' | 'about';

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
    const { settings, updateSettings, updateTerminalSettings, updateFileManagerSettings, updateLocalTermSettings, updateKeybindings } = useSettings();
    const [activeTab, setActiveTab] = useState<Tab>('terminal');
    const [wslDistros, setWslDistros] = useState<string[]>([]);

    // About / Update State
    const [appVersion, setAppVersion] = useState('');
    const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'not-available' | 'error' | 'downloading'>('idle');
    const [updateInfo, setUpdateInfo] = useState<any>(null);
    const [isAppImage, setIsAppImage] = useState(false);

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

    // Update Listeners
    useEffect(() => {
        const onUpdateStatus = (_: any, status: string) => {
            if (status === 'Checking for update...') setUpdateStatus('checking');
            if (status === 'Update not available.') setUpdateStatus('not-available');
        };
        const onUpdateAvailable = (_: any, info: any) => {
            setUpdateStatus('available');
            setUpdateInfo(info);
        };
        const onUpdateProgress = () => {
            setUpdateStatus('downloading');
        };
        const onUpdateError = () => setUpdateStatus('error');

        window.ipcRenderer.on('update:status', onUpdateStatus);
        window.ipcRenderer.on('update:available', onUpdateAvailable);
        window.ipcRenderer.on('update:progress', onUpdateProgress);
        window.ipcRenderer.on('update:error', onUpdateError);

        return () => {
            window.ipcRenderer.off('update:status', onUpdateStatus);
            window.ipcRenderer.off('update:available', onUpdateAvailable);
            window.ipcRenderer.off('update:progress', onUpdateProgress);
            window.ipcRenderer.off('update:error', onUpdateError);
        };
    }, []);

    const checkForUpdates = async () => {
        setUpdateStatus('checking');
        try {
            await window.ipcRenderer.invoke('update:check');
        } catch (e) {
            setUpdateStatus('error');
        }
    };

    const isWindows = window.navigator.userAgent.indexOf('Windows') !== -1;
    const canAutoUpdate = isWindows || isAppImage;

    const handleUpdateAction = () => {
        if (updateStatus === 'downloading') return;

        if (updateStatus === 'available') {
            if (canAutoUpdate) {
                window.ipcRenderer.invoke('update:install');
            } else {
                // Manual Download Fallback
                window.ipcRenderer.invoke('shell:open', 'https://github.com/FDgajju/zync/releases/latest');
            }
        } else {
            checkForUpdates();
        }
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

    if (!isOpen) return null;

    return createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="w-[800px] h-[600px] bg-[var(--color-app-panel)] rounded-xl border border-[var(--color-app-border)] shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">

                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-[var(--color-app-border)] bg-[var(--color-app-bg)]/50">
                    <h2 className="text-xl font-semibold text-[var(--color-app-text)]">Settings</h2>
                    <button onClick={onClose} className="p-2 hover:bg-[var(--color-app-surface)] rounded-lg transition-colors text-[var(--color-app-muted)] hover:text-[var(--color-app-text)]">
                        <X size={20} />
                    </button>
                </div>

                <div className="flex flex-1 overflow-hidden">
                    {/* Sidebar Tabs */}
                    <div className="w-56 bg-[var(--color-app-bg)]/30 p-4 space-y-2 border-r border-[var(--color-app-border)] shrink-0">
                        <TabButton
                            active={activeTab === 'general'}
                            onClick={() => setActiveTab('general')}
                            icon={<SettingsIcon size={18} />}
                            label="General"
                        />
                        <TabButton
                            active={activeTab === 'terminal'}
                            onClick={() => setActiveTab('terminal')}
                            icon={<Type size={18} />}
                            label="Terminal"
                        />
                        <TabButton
                            active={activeTab === 'appearance'}
                            onClick={() => setActiveTab('appearance')}
                            icon={<Monitor size={18} />}
                            label="Appearance"
                        />
                        <TabButton
                            active={activeTab === 'fileManager'}
                            onClick={() => setActiveTab('fileManager')}
                            icon={<FileText size={18} />}
                            label="File Manager"
                        />
                        <TabButton
                            active={activeTab === 'shortcuts'}
                            onClick={() => setActiveTab('shortcuts')}
                            icon={<Keyboard size={18} />}
                            label="Shortcuts"
                        />
                        <div className="pt-4 mt-4 border-t border-[var(--color-app-border)]">
                            <TabButton
                                active={activeTab === 'about'}
                                onClick={() => setActiveTab('about')}
                                icon={<Info size={18} />}
                                label="About"
                            />
                        </div>
                    </div>

                    {/* Content Area */}
                    <div className="flex-1 p-8 overflow-y-auto bg-[var(--color-app-panel)]">

                        {activeTab === 'general' && (
                            <div className="space-y-8 animate-in fade-in duration-300">
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
                                                        Where Zync stores your connections, snippets, tunnels, and settings.
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
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </Section>

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
                            <div className="space-y-8">
                                <Section title="Typography">
                                    <div className="grid grid-cols-2 gap-6">
                                        <div className="space-y-3">
                                            <label className="text-sm font-medium text-[var(--color-app-text)] opacity-80">Font Family</label>
                                            <select
                                                className="w-full bg-[var(--color-app-bg)] border border-[var(--color-app-border)] rounded-lg p-2.5 text-[var(--color-app-text)] focus:ring-2 focus:ring-[var(--color-app-accent)] focus:border-transparent outline-none"
                                                value={settings.terminal.fontFamily}
                                                onChange={(e) => updateTerminalSettings({ fontFamily: e.target.value })}
                                            >
                                                <option value="'Fira Code', monospace">Fira Code</option>
                                                <option value="'JetBrains Mono', monospace">JetBrains Mono</option>
                                                <option value="Menlo, monospace">Menlo</option>
                                                <option value="'Courier New', monospace">Courier New</option>
                                            </select>
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

                                {window.navigator.userAgent.indexOf('Windows') !== -1 && (
                                    <Section title="Local Terminal (Windows)">
                                        <div className="space-y-3">
                                            <label className="text-sm font-medium text-[var(--color-app-text)] opacity-80">Default Shell</label>
                                            <select
                                                className="w-full bg-[var(--color-app-bg)] border border-[var(--color-app-border)] rounded-lg p-2.5 text-[var(--color-app-text)] focus:ring-2 focus:ring-[var(--color-app-accent)] focus:border-transparent outline-none"
                                                value={settings.localTerm?.windowsShell || 'default'}
                                                onChange={(e) => updateLocalTermSettings({ windowsShell: e.target.value })}
                                            >
                                                <option value="default">Default (System Decision)</option>
                                                <option value="powershell">PowerShell</option>
                                                <option value="cmd">Command Prompt</option>
                                                <option value="gitbash">Git Bash</option>
                                                <option value="wsl">WSL (Default Distro)</option>
                                                {wslDistros.map(distro => (
                                                    <option key={distro} value={`wsl:${distro}`}>WSL: {distro}</option>
                                                ))}
                                            </select>
                                            <div className="text-xs text-[var(--color-app-muted)]">
                                                Note: Changes take effect on new split panes or tabs.
                                            </div>
                                        </div>
                                    </Section>
                                )}

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
                                                onClick={() => updateSettings({ theme: theme.id as any })}
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
                                    </div>
                                </Section>

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
                            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                                {/* Hero Card */}
                                <div className="relative overflow-hidden rounded-2xl border border-[var(--color-app-border)] bg-[var(--color-app-panel)] shadow-lg group">
                                    {/* Decorative Gradient Blob */}
                                    <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
                                    <div className="absolute bottom-0 left-0 w-64 h-64 bg-purple-500/10 rounded-full blur-3xl translate-y-1/2 -translate-x-1/2" />

                                    <div className="relative z-10 flex flex-col items-center justify-center py-12 text-center">
                                        {/* Animated Logo */}
                                        <div className="relative mb-6">
                                            <div className="w-24 h-24 flex items-center justify-center relative transform transition-transform duration-500 hover:scale-110 hover:rotate-3 mx-auto">
                                                <img
                                                    src="icon.png"
                                                    alt="Zync"
                                                    className="w-full h-full object-contain select-none drop-shadow-2xl"
                                                />
                                            </div>
                                        </div>

                                        {/* Title & Version */}
                                        <h3 className="text-4xl font-black text-[var(--color-app-text)] mb-2 tracking-tight">
                                            <span className="bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 via-purple-400 to-pink-400 animate-gradient-x">
                                                Zync
                                            </span>
                                        </h3>

                                        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--color-app-surface)] border border-[var(--color-app-border)] text-[var(--color-app-muted)] text-xs font-mono mb-8 hover:border-[var(--color-app-accent)] transition-colors cursor-default">
                                            <span className="font-semibold text-[var(--color-app-text)]">v{appVersion}</span>
                                            <span className="w-1 h-1 rounded-full bg-[var(--color-app-border)]" />
                                            <span>{isAppImage ? 'AppImage' : isWindows ? 'Windows' : 'Linux'}</span>
                                            <span className="w-1 h-1 rounded-full bg-[var(--color-app-border)]" />
                                            <span>Release</span>
                                        </div>

                                        {/* Update Button */}
                                        <div className="w-full max-w-xs px-4">
                                            <button
                                                onClick={handleUpdateAction}
                                                disabled={updateStatus === 'checking' || (canAutoUpdate && updateStatus === 'downloading')}
                                                className={`
                                                    group relative flex items-center justify-center gap-3 px-6 py-3.5 rounded-xl border font-semibold transition-all w-full overflow-hidden
                                                    ${updateStatus === 'available'
                                                        ? 'bg-gradient-to-r from-green-500/10 to-emerald-600/10 border-green-500/50 text-green-500 hover:from-green-500/20 hover:to-emerald-600/20 shadow-[0_0_20px_-5px_rgba(34,197,94,0.3)]'
                                                        : 'bg-[var(--color-app-surface)] border-[var(--color-app-border)] text-[var(--color-app-text)] hover:bg-[var(--color-app-surface)]/80 hover:border-[var(--color-app-accent)] hover:shadow-[0_0_15px_-5px_var(--color-app-accent)]'
                                                    }
                                                    disabled:opacity-50 disabled:cursor-not-allowed
                                                `}
                                            >
                                                <div className={`transition-transform duration-700 ${updateStatus === 'checking' ? 'animate-spin' : 'group-hover:scale-110'}`}>
                                                    {updateStatus === 'checking' && <RefreshCw size={18} />}
                                                    {updateStatus === 'idle' && <RefreshCw size={18} />}
                                                    {updateStatus === 'available' && <Download size={18} />}
                                                    {updateStatus === 'not-available' && <Check size={18} />}
                                                    {updateStatus === 'error' && <AlertTriangle size={18} />}
                                                </div>

                                                <span className="relative z-10">
                                                    {updateStatus === 'idle' && 'Check for Updates'}
                                                    {updateStatus === 'checking' && 'Checking...'}
                                                    {updateStatus === 'available' && (canAutoUpdate ? 'Install & Restart' : 'Download Update')}
                                                    {updateStatus === 'not-available' && 'Up to Date'}
                                                    {updateStatus === 'error' && 'Check Failed'}
                                                </span>
                                            </button>

                                            {/* Status Messages */}
                                            {updateStatus === 'not-available' && (
                                                <p className="text-xs text-[var(--color-app-muted)] mt-3 animate-in fade-in slide-in-from-top-1">
                                                    You are running the latest version.
                                                </p>
                                            )}

                                            {updateStatus === 'available' && updateInfo && (
                                                <div className="w-full bg-[var(--color-app-bg)]/50 p-3 rounded-lg border border-[var(--color-app-border)] text-left text-xs mt-3 animate-in zoom-in-95">
                                                    <div className="font-semibold text-[var(--color-app-text)] mb-1 flex justify-between">
                                                        <span>v{updateInfo.version} available</span>
                                                        <span className="text-[var(--color-app-accent)]">New</span>
                                                    </div>
                                                    <div className="text-[var(--color-app-muted)]">
                                                        {canAutoUpdate
                                                            ? "Update will be installed automatically."
                                                            : "Please download the update from GitHub."}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* Links Grid */}
                                <div className="grid grid-cols-2 gap-4">
                                    <button
                                        onClick={() => window.ipcRenderer.invoke('shell:open', 'https://github.com/FDgajju/zync')}
                                        className="flex items-center gap-4 p-4 rounded-xl border border-[var(--color-app-border)] bg-[var(--color-app-surface)]/30 hover:bg-[var(--color-app-surface)] hover:border-[var(--color-app-accent)]/50 transition-all group text-left"
                                    >
                                        <div className="p-3 rounded-lg bg-[var(--color-app-bg)] group-hover:bg-[var(--color-app-text)] group-hover:text-[var(--color-app-bg)] transition-colors border border-[var(--color-app-border)]">
                                            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>
                                        </div>
                                        <div>
                                            <div className="font-semibold text-[var(--color-app-text)] group-hover:text-[var(--color-app-accent)] transition-colors">GitHub</div>
                                            <div className="text-xs text-[var(--color-app-muted)]">Source Code & Issues</div>
                                        </div>
                                    </button>

                                    <button
                                        onClick={() => window.ipcRenderer.invoke('shell:open', 'https://zync.thesudoer.in')}
                                        className="flex items-center gap-4 p-4 rounded-xl border border-[var(--color-app-border)] bg-[var(--color-app-surface)]/30 hover:bg-[var(--color-app-surface)] hover:border-[var(--color-app-accent)]/50 transition-all group text-left"
                                    >
                                        <div className="p-3 rounded-lg bg-[var(--color-app-bg)] group-hover:bg-[var(--color-app-text)] group-hover:text-[var(--color-app-bg)] transition-colors border border-[var(--color-app-border)]">
                                            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>
                                        </div>
                                        <div>
                                            <div className="font-semibold text-[var(--color-app-text)] group-hover:text-[var(--color-app-accent)] transition-colors">Website</div>
                                            <div className="text-xs text-[var(--color-app-muted)]">Documentation & Guides</div>
                                        </div>
                                    </button>
                                </div>

                                {/* Footer */}
                                <div className="text-center pt-8 pb-4">
                                    <div className="flex items-center justify-center gap-1.5 text-sm text-[var(--color-app-muted)]">
                                        <span>Made with</span>
                                        <span className="text-red-500 animate-pulse text-lg leading-none">❤️</span>
                                        <span>by Gajendra</span>
                                    </div>
                                    <p className="text-xs text-[var(--color-app-muted)]/50 mt-2 font-mono">© 2026 Zync SSH Client. All rights reserved.</p>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>,
        document.body
    );
}

function TabButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
    return (
        <button
            onClick={onClick}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${active
                ? 'bg-[var(--color-app-accent)] text-[var(--color-app-bg)]' // Accent bg + dark text implies accent is bright. Standard 'text-white' might be safer if accent is dark. 
                : 'text-[var(--color-app-muted)] hover:bg-[var(--color-app-surface)] hover:text-[var(--color-app-text)]'
                } ${active ? 'text-white' : ''}`} // Override text color for active state to white/light for readability on accent
        >
            {/* Fix: explicit white text on accent, assuming accents are dark/vibrant enough */}
            <span className={active ? 'text-white' : ''}>{icon}</span>
            <span className={active ? 'text-white' : ''}>{label}</span>
        </button>
    );
}

function Section({ title, children }: { title: string, children: React.ReactNode }) {
    return (
        <div className="space-y-4">
            <h3 className="text-sm font-bold text-[var(--color-app-muted)] uppercase tracking-wider">{title}</h3>
            {children}
        </div>
    );
}

function Toggle({ label, description, checked, onChange }: { label: string, description: string, checked: boolean, onChange: (v: boolean) => void }) {
    return (
        <div className="flex items-center justify-between p-4 bg-[var(--color-app-bg)]/50 rounded-lg border border-[var(--color-app-border)]">
            <div>
                <div className="font-medium text-[var(--color-app-text)]">{label}</div>
                <div className="text-sm text-[var(--color-app-muted)]">{description}</div>
            </div>
            <button
                onClick={() => onChange(!checked)}
                className={`w-12 h-6 rounded-full transition-colors relative ${checked ? 'bg-[var(--color-app-accent)]' : 'bg-[var(--color-app-surface)]'}`}
            >
                <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-6' : 'translate-x-0'}`} />
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
