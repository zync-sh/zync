import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useSettings } from '../../context/SettingsContext';
import { X, Type, Monitor, FileText, Keyboard, Info, Check, RefreshCw, AlertTriangle, Download } from 'lucide-react';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

type Tab = 'terminal' | 'appearance' | 'fileManager' | 'shortcuts' | 'about';

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
    const { settings, updateSettings, updateTerminalSettings, updateFileManagerSettings, updateLocalTermSettings } = useSettings();
    const [activeTab, setActiveTab] = useState<Tab>('terminal');
    const [wslDistros, setWslDistros] = useState<string[]>([]);
    
    // About / Update State
    const [appVersion, setAppVersion] = useState('');
    const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'available' | 'not-available' | 'error' | 'downloading'>('idle');
    const [updateInfo, setUpdateInfo] = useState<any>(null);

    useEffect(() => {
        if (isOpen) {
            if (window.navigator.userAgent.indexOf('Windows') !== -1) {
                window.ipcRenderer.invoke('shell:getWslDistros').then((distros: string[]) => {
                    setWslDistros(distros);
                }).catch(err => console.error('Failed to fetch WSL distros', err));
            }
            
            // Get Version
            window.ipcRenderer.invoke('app:getVersion').then(ver => setAppVersion(ver));
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
                            <div className="space-y-8">
                                <Section title="Global Shortcuts">
                                    <div className="space-y-2">
                                        <ShortcutRow keys={['Ctrl', 'N']} action="New Connection" />
                                        <ShortcutRow keys={['Ctrl', 'B']} action="Toggle Sidebar" />
                                        <ShortcutRow keys={['Ctrl', 'T']} action="Local Terminal" />
                                        <ShortcutRow keys={['Ctrl', ',']} action="Settings" />
                                        <ShortcutRow keys={['Ctrl', 'W']} action="Close Tab" />
                                        <ShortcutRow keys={['Ctrl', 'Tab']} action="Next Tab" />
                                        <ShortcutRow keys={['Ctrl', '1-9']} action="Switch Tab" />
                                    </div>
                                </Section>

                                <Section title="Terminal">
                                    <div className="space-y-2">
                                        <ShortcutRow keys={['Ctrl', 'Shift', 'C']} action="Copy" />
                                        <ShortcutRow keys={['Ctrl', 'Shift', 'V']} action="Paste" />
                                        <ShortcutRow keys={['Ctrl', 'F']} action="Find" />
                                    </div>
                                </Section>
                            </div>
                        )}

                        {activeTab === 'about' && (
                            <div className="space-y-8">
                                <div className="flex flex-col items-center justify-center py-8 text-center bg-app-bg/30 rounded-2xl border border-app-border">
                                    <div className="w-24 h-24 mb-6 rounded-2xl bg-linear-to-br from-indigo-500 to-purple-600 shadow-xl flex items-center justify-center">
                                        <span className="text-4xl font-bold text-white">Z</span>
                                    </div>
                                    <h3 className="text-3xl font-bold text-app-text mb-2">Zync</h3>
                                    <div className="text-app-muted text-sm mb-6">v{appVersion}</div>
                                    
                                    <div className="flex flex-col items-center gap-4 w-full max-w-sm px-4">
                                        <button
                                            onClick={checkForUpdates}
                                            disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
                                            className={`
                                                flex items-center gap-2 px-6 py-2.5 rounded-lg border font-medium transition-all w-full justify-center
                                                ${updateStatus === 'available'
                                                    ? 'bg-green-500/10 border-green-500/50 text-green-500 hover:bg-green-500/20'
                                                    : 'bg-app-surface border-app-border text-app-text hover:bg-app-surface/80 hover:border-app-accent'
                                                }
                                                disabled:opacity-50 disabled:cursor-not-allowed
                                            `}
                                        >
                                            {updateStatus === 'checking' && <RefreshCw className="animate-spin" size={18} />}
                                            {updateStatus === 'idle' && <RefreshCw size={18} />}
                                            {updateStatus === 'available' && <Download size={18} />}
                                            {updateStatus === 'not-available' && <Check size={18} />}
                                            {updateStatus === 'error' && <AlertTriangle size={18} />}
                                            
                                            <span>
                                                {updateStatus === 'idle' && 'Check for Updates'}
                                                {updateStatus === 'checking' && 'Checking...'}
                                                {updateStatus === 'available' && 'Update Available'}
                                                {updateStatus === 'not-available' && 'Up to Date'}
                                                {updateStatus === 'error' && 'Check Failed'}
                                            </span>
                                        </button>
                                        
                                        {updateStatus === 'not-available' && (
                                            <p className="text-xs text-app-muted animate-in fade-in">
                                                You are running the latest version.
                                            </p>
                                        )}
                                        
                                         {updateStatus === 'available' && updateInfo && (
                                             <div className="w-full bg-app-bg/50 p-3 rounded-lg border border-app-border text-left text-xs">
                                                 <div className="font-semibold text-app-text mb-1">v{updateInfo.version} available</div>
                                                 <div className="text-app-muted">Check the main window to download and install.</div>
                                             </div>
                                         )}
                                    </div>
                                </div>
                                
                                <Section title="Legal">
                                    <div className="space-y-4">
                                        <div className="p-4 bg-app-bg/30 rounded-lg border border-app-border text-sm text-app-muted">
                                            <p>© 2026 Zync SSH Client. All rights reserved.</p>
                                            <p className="mt-2">Made with ❤️ by Gajendra.</p>
                                        </div>
                                    </div>
                                </Section>
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


function ShortcutRow({ keys, action }: { keys: string[], action: string }) {
    return (
        <div className="flex items-center justify-between p-3 bg-[var(--color-app-bg)]/30 rounded-lg border border-[var(--color-app-border)] hover:border-[var(--color-app-accent)]/50 transition-colors">
            <span className="text-[var(--color-app-text)] font-medium">{action}</span>
            <div className="flex items-center gap-1">
                {keys.map((k, i) => (
                    <div key={i} className="flex items-center">
                        <kbd className="px-2 py-1 min-w-[24px] text-center bg-[var(--color-app-surface)] border border-[var(--color-app-border)] rounded text-xs font-mono text-[var(--color-app-text)] shadow-sm">
                            {k}
                        </kbd>
                        {i < keys.length - 1 && <span className="text-[var(--color-app-muted)] text-xs mx-1">+</span>}
                    </div>
                ))}
            </div>
        </div>
    );
}
