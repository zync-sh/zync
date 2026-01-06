import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useSettings } from '../../context/SettingsContext';
import { X, Type, Monitor, FileText, Keyboard } from 'lucide-react';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

type Tab = 'terminal' | 'appearance' | 'fileManager' | 'shortcuts';

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
    const { settings, updateSettings, updateTerminalSettings, updateFileManagerSettings } = useSettings();
    const [activeTab, setActiveTab] = useState<Tab>('terminal');

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
