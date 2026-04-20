import { FileText, Folder, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { AppSettings } from '../../../store/settingsSlice';
import type { SelectOption } from '../../ui/Select';
import { Select } from '../../ui/Select';
import { Section } from '../common/Section';

interface ActiveEditorProvider {
    manifest: {
        id: string;
    };
}

interface GeneralTabProps {
    settings: AppSettings;
    defaultEditorProvider: string;
    autoUpdateCheck: boolean;
    isWindows: boolean;
    isDefaultDataPath: boolean;
    currentDataPath: string;
    isDefaultLogPath: boolean;
    isDefaultDataPathForLogs: boolean;
    currentLogPath: string;
    activeEditorCapabilitySummary: string;
    activeEditorProvider: ActiveEditorProvider | null;
    editorProviderOptions: SelectOption[];
    onToggleAutoUpdate: () => Promise<void> | void;
    onUpdateSettings: (updates: Partial<AppSettings>) => Promise<void>;
    onChangeLocation: () => Promise<void>;
    onResetLocation: () => Promise<void>;
    onChangeLogLocation: () => Promise<void>;
    onResetLogLocation: () => Promise<void>;
    onClearConnections: () => Promise<void>;
}

export function GeneralTab({
    settings,
    defaultEditorProvider,
    autoUpdateCheck,
    isWindows,
    isDefaultDataPath,
    currentDataPath,
    isDefaultLogPath,
    isDefaultDataPathForLogs,
    currentLogPath,
    activeEditorCapabilitySummary,
    activeEditorProvider,
    editorProviderOptions,
    onToggleAutoUpdate,
    onUpdateSettings,
    onChangeLocation,
    onResetLocation,
    onChangeLogLocation,
    onResetLogLocation,
    onClearConnections,
}: GeneralTabProps) {
    const [isUpdatingAutoCheck, setIsUpdatingAutoCheck] = useState(false);

    const handleAutoUpdateToggle = async () => {
        if (isUpdatingAutoCheck) return;
        setIsUpdatingAutoCheck(true);
        try {
            await onToggleAutoUpdate();
        } finally {
            setIsUpdatingAutoCheck(false);
        }
    };

    return (
        <div className="space-y-6 animate-in fade-in duration-300">
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
                            onClick={() => { void handleAutoUpdateToggle(); }}
                            role="switch"
                            aria-checked={autoUpdateCheck}
                            aria-disabled={isUpdatingAutoCheck}
                            aria-label="Auto-update check"
                            disabled={isUpdatingAutoCheck}
                            className={`w-11 h-6 rounded-full transition-colors relative focus:outline-none focus:ring-2 focus:ring-[var(--color-app-accent)]/50 ${autoUpdateCheck ? 'bg-[var(--color-app-accent)]' : 'bg-[var(--color-app-border)]'
                                } ${isUpdatingAutoCheck ? 'opacity-60 cursor-not-allowed' : ''}`}
                        >
                            <span
                                className={`absolute top-1 left-1 bg-white w-4 h-4 rounded-full transition-transform ${autoUpdateCheck ? 'translate-x-5' : 'translate-x-0'
                                    }`}
                            />
                        </button>
                    </div>
                </div>
            </Section>

            <Section title="Editor">
                <div className="space-y-3 rounded-lg border border-[var(--color-app-border)] bg-[var(--color-app-surface)]/50 p-4">
                    <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                            <h4 className="text-sm font-medium text-[var(--color-app-text)]">Default File Editor</h4>
                            <p className="mt-1 text-xs text-[var(--color-app-muted)]">
                                Choose which editor opens files from the file manager. Plugin-based editors appear here automatically, and CodeMirror is the recommended default.
                            </p>
                        </div>
                        <div className="w-64 shrink-0">
                            <Select
                                value={settings.editor?.defaultProvider ?? defaultEditorProvider}
                                onChange={(value) => onUpdateSettings({
                                    editor: {
                                        ...(settings.editor || {}),
                                        defaultProvider: value
                                    }
                                })}
                                options={editorProviderOptions}
                                showSearch={false}
                            />
                        </div>
                    </div>
                    <div className="rounded-md border border-[var(--color-app-border)] bg-[var(--color-app-bg)]/40 px-3 py-2 text-xs text-[var(--color-app-muted)]">
                        <span className="font-medium text-[var(--color-app-text)]">Capabilities:</span>{' '}
                        {activeEditorProvider
                            ? activeEditorCapabilitySummary
                            : 'Built-in fallback editor'}
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
                                    Where Zync stores your connections, snippets, and port forwards.
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
                                        onClick={onChangeLocation}
                                        className="px-3 py-1.5 bg-[var(--color-app-surface)] hover:bg-[var(--color-app-bg)] border border-[var(--color-app-border)] rounded-lg text-xs font-medium text-[var(--color-app-text)] transition-colors flex items-center gap-2"
                                    >
                                        Change Location
                                    </button>
                                    {!isDefaultDataPath && (
                                        <button
                                            onClick={onResetLocation}
                                            className="px-3 py-1.5 bg-[var(--color-app-surface)] hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/30 border border-[var(--color-app-border)] rounded-lg text-xs font-medium text-[var(--color-app-muted)] transition-colors"
                                        >
                                            Reset to Default
                                        </button>
                                    )}
                                    <button
                                        onClick={onClearConnections}
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
                                            ? (
                                                isDefaultDataPathForLogs
                                                    ? (isWindows ? '%APPDATA%\\zync\\logs' : '~/.config/zync/logs')
                                                    : (isWindows ? `${currentDataPath}\\logs` : `${currentDataPath}/logs`)
                                            )
                                            : currentLogPath}
                                    </code>
                                    {isDefaultLogPath && <span className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-app-muted)] border border-[var(--color-app-border)] px-1.5 py-0.5 rounded">Default</span>}
                                </div>

                                <div className="flex gap-2">
                                    <button
                                        onClick={onChangeLogLocation}
                                        className="px-3 py-1.5 bg-[var(--color-app-surface)] hover:bg-[var(--color-app-bg)] border border-[var(--color-app-border)] rounded-lg text-xs font-medium text-[var(--color-app-text)] transition-colors flex items-center gap-2"
                                    >
                                        Change Location
                                    </button>
                                    {!isDefaultLogPath && (
                                        <button
                                            onClick={onResetLogLocation}
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
    );
}
