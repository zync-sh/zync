import { useState } from 'react';
import type { AppSettings } from '../../../store/settingsSlice';
import { useAppStore } from '../../../store/useAppStore';
import { Section } from '../common/Section';
import { Toggle } from '../common/Toggle';

interface FileManagerTabProps {
    settings: AppSettings;
    updateFileManagerSettings: (updates: Partial<AppSettings['fileManager']>) => Promise<void>;
    onPickDefaultDownloadPath: () => Promise<void>;
}

export function FileManagerTab({
    settings,
    updateFileManagerSettings,
    onPickDefaultDownloadPath
}: FileManagerTabProps) {
    const [isUpdating, setIsUpdating] = useState(false);
    const showToast = useAppStore((state) => state.showToast);

    const runUpdate = async (work: () => Promise<void>) => {
        setIsUpdating(true);
        try {
            await work();
        } catch (error) {
            console.error('Failed to update file manager settings', error);
            const message = error instanceof Error ? error.message : String(error);
            showToast('error', `Failed to save file manager setting: ${message}`);
        } finally {
            setIsUpdating(false);
        }
    };

    return (
        <div className="space-y-6">
            <Section title="Behavior">
                <div className="space-y-4">
                    <Toggle
                        label="Show Hidden Files"
                        description="Display files starting with ."
                        checked={settings.fileManager.showHiddenFiles}
                        disabled={isUpdating}
                        onChange={(v) => { void runUpdate(() => updateFileManagerSettings({ showHiddenFiles: v })); }}
                    />
                    <Toggle
                        label="Confirm Deletion"
                        description="Ask for confirmation before deleting files"
                        checked={settings.fileManager.confirmDelete}
                        disabled={isUpdating}
                        onChange={(v) => { void runUpdate(() => updateFileManagerSettings({ confirmDelete: v })); }}
                    />
                    <div className="p-4 bg-[var(--color-app-surface)]/50 rounded-lg border border-[var(--color-app-border)]/50">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <div className="text-sm font-medium text-[var(--color-app-text)]">Default Download Folder</div>
                                <div
                                    className="text-xs text-[var(--color-app-muted)] mt-1 truncate"
                                    title={settings.fileManager.defaultDownloadPath || 'Ask every time'}
                                >
                                    {settings.fileManager.defaultDownloadPath || 'Ask every time'}
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    disabled={isUpdating}
                                    onClick={() => { void runUpdate(onPickDefaultDownloadPath); }}
                                    className="px-3 py-1.5 bg-[var(--color-app-bg)] border border-[var(--color-app-border)] rounded-md text-xs font-medium text-[var(--color-app-text)] hover:border-[var(--color-app-accent)]/50 disabled:hover:border-[var(--color-app-border)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                    Browse
                                </button>
                                <button
                                    type="button"
                                    disabled={isUpdating}
                                    onClick={() => { void runUpdate(() => updateFileManagerSettings({ defaultDownloadPath: '' })); }}
                                    className="px-3 py-1.5 bg-[var(--color-app-bg)] border border-[var(--color-app-border)] rounded-md text-xs font-medium text-[var(--color-app-muted)] hover:text-[var(--color-app-text)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                    Reset
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </Section>
        </div>
    );
}
