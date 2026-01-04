import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useSettings } from '../../context/SettingsContext';
import { X, Type, Monitor, FileText } from 'lucide-react';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

type Tab = 'terminal' | 'appearance' | 'fileManager';

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
    const { settings, updateTerminalSettings, updateFileManagerSettings } = useSettings();
    const [activeTab, setActiveTab] = useState<Tab>('terminal');

    if (!isOpen) return null;

    return createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="w-[800px] h-[600px] bg-[#1e293b] rounded-xl border border-white/10 shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">

                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-white/5 bg-[#0f172a]/50">
                    <h2 className="text-xl font-semibold text-white">Settings</h2>
                    <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg transition-colors text-gray-400 hover:text-white">
                        <X size={20} />
                    </button>
                </div>

                <div className="flex flex-1 overflow-hidden">
                    {/* Sidebar Tabs */}
                    <div className="w-56 bg-[#0f172a]/30 p-4 space-y-2 border-r border-white/5 shrink-0">
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
                    </div>

                    {/* Content Area */}
                    <div className="flex-1 p-8 overflow-y-auto bg-[#1e293b]">

                        {activeTab === 'terminal' && (
                            <div className="space-y-8">
                                <Section title="Typography">
                                    <div className="grid grid-cols-2 gap-6">
                                        <div className="space-y-3">
                                            <label className="text-sm font-medium text-gray-300">Font Family</label>
                                            <select
                                                className="w-full bg-[#0f172a] border border-white/10 rounded-lg p-2.5 text-white focus:ring-2 focus:ring-[#6366f1] focus:border-transparent outline-none"
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
                                                <label className="text-sm font-medium text-gray-300">Font Size</label>
                                                <span className="text-sm text-[#6366f1] font-mono">{settings.terminal.fontSize}px</span>
                                            </div>
                                            <input
                                                type="range" min="10" max="24" step="1"
                                                className="w-full accent-[#6366f1] h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                                                value={settings.terminal.fontSize}
                                                onChange={(e) => updateTerminalSettings({ fontSize: parseInt(e.target.value) })}
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
                                                        ? 'bg-[#6366f1]/20 border-[#6366f1] text-white ring-1 ring-[#6366f1]'
                                                        : 'border-white/10 hover:bg-white/5 text-gray-400'
                                                    }`}
                                            >
                                                {/* Visual Representation */}
                                                <div className="h-12 w-24 bg-black/40 rounded border border-white/5 flex items-center justify-center relative overflow-hidden font-mono text-xs">
                                                    <span className="text-gray-500">_</span>
                                                    {/* Cursor Element */}
                                                    <div className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[#6366f1] 
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
                                    <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-yellow-200 text-sm flex items-start gap-3">
                                        <Monitor className="shrink-0 mt-0.5" size={16} />
                                        <div>
                                            <p className="font-medium">Work in Progress</p>
                                            <p className="opacity-80 mt-1">Full theme customization is coming soon. Currently using <strong>Prism Dark</strong>.</p>
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
                    ? 'bg-[#6366f1] text-white'
                    : 'text-gray-400 hover:bg-white/5 hover:text-white'
                }`}
        >
            {icon}
            {label}
        </button>
    );
}

function Section({ title, children }: { title: string, children: React.ReactNode }) {
    return (
        <div className="space-y-4">
            <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wider">{title}</h3>
            {children}
        </div>
    );
}

function Toggle({ label, description, checked, onChange }: { label: string, description: string, checked: boolean, onChange: (v: boolean) => void }) {
    return (
        <div className="flex items-center justify-between p-4 bg-[#0f172a]/50 rounded-lg border border-white/5">
            <div>
                <div className="font-medium text-white">{label}</div>
                <div className="text-sm text-gray-400">{description}</div>
            </div>
            <button
                onClick={() => onChange(!checked)}
                className={`w-12 h-6 rounded-full transition-colors relative ${checked ? 'bg-[#6366f1]' : 'bg-gray-700'}`}
            >
                <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-6' : 'translate-x-0'}`} />
            </button>
        </div>
    );
}
