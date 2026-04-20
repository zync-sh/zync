import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';

export interface RegistryPlugin {
    id: string;
    name: string;
    version: string;
    description: string;
    author: string;
    downloadUrl: string;
    thumbnailUrl?: string;
    mode?: 'dark' | 'light';
    type?: 'theme' | 'tool' | 'editor-provider' | 'icon-theme';
}

export interface InstalledPlugin {
    manifest: {
        id: string;
        name: string;
        version: string;
        icon?: string;
        type?: string;
        mode?: 'light' | 'dark';
        preview_bg?: string;
        preview_accent?: string;
    };
    enabled: boolean;
    path: string;
}

export interface ConfirmDialogOptions {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'primary' | 'danger';
}

interface UseSettingsPluginsOptions {
    isOpen: boolean;
    activeTab: string;
    showToast: (type: 'info' | 'success' | 'warning' | 'error', message: string) => void;
    showConfirmDialog: (options: ConfirmDialogOptions) => Promise<boolean>;
}

export function useSettingsPlugins({
    isOpen,
    activeTab,
    showToast,
    showConfirmDialog,
}: UseSettingsPluginsOptions) {
    const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
    const [isLoadingPlugins, setIsLoadingPlugins] = useState(false);
    const [registry, setRegistry] = useState<RegistryPlugin[]>([]);
    const [isLoadingRegistry, setIsLoadingRegistry] = useState(false);
    const [activeMenu, setActiveMenu] = useState<string | null>(null);
    const [processingId, setProcessingId] = useState<string | null>(null);
    const [needsRestart, setNeedsRestart] = useState(false);
    const [localPluginInstallMode, setLocalPluginInstallMode] = useState<'zip' | 'folder' | null>(null);

    const reloadPluginsInModal = async () => {
        try {
            const list = await window.ipcRenderer.invoke('plugins:load');
            setPlugins(list);
            return true;
        } catch (error) {
            console.error('Failed to reload plugins list', error);
            showToast('warning', 'Plugin installed, but list refresh failed. Reopen Settings to refresh.');
            return false;
        }
    };

    useEffect(() => {
        if (!(isOpen && (activeTab === 'plugins' || activeTab === 'appearance'))) return;

        let isMounted = true;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        setIsLoadingPlugins(true);
        window.ipcRenderer.invoke('plugins:load')
            .then((list: InstalledPlugin[]) => {
                if (!isMounted) return;
                setPlugins(list);
            })
            .catch((err: unknown) => console.error('Failed to load plugins', err))
            .finally(() => {
                if (isMounted) setIsLoadingPlugins(false);
            });

        setIsLoadingRegistry(true);
        fetch("https://raw.githubusercontent.com/zync-sh/zync-extensions/main/marketplace.json", {
            signal: controller.signal
        })
            .then(res => res.json())
            .then(data => {
                if (!isMounted || controller.signal.aborted) return;
                setRegistry(data.plugins || []);
            })
            .catch((err: unknown) => {
                if (err instanceof DOMException && err.name === 'AbortError') {
                    console.error('Plugin registry fetch timed out after 10s');
                } else {
                    console.error('Failed to fetch registry', err);
                }
            })
            .finally(() => {
                clearTimeout(timeoutId);
                if (isMounted) setIsLoadingRegistry(false);
            });

        return () => {
            isMounted = false;
            controller.abort();
            clearTimeout(timeoutId);
        };
    }, [isOpen, activeTab]);

    const handleInstallLocalPlugin = async (mode: 'zip' | 'folder') => {
        setLocalPluginInstallMode(mode);
        const modeLabel = mode === 'zip' ? 'ZIP package' : 'plugin folder';
        try {
            const selection = await open(
                mode === 'zip'
                    ? {
                        multiple: false,
                        directory: false,
                        filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
                    }
                    : {
                        multiple: false,
                        directory: true,
                    }
            );

            if (!selection) return;
            const selectedPath = Array.isArray(selection) ? selection[0] : selection;
            if (!selectedPath) return;

            await window.ipcRenderer.invoke('plugins:install_local', { path: selectedPath });
            const reloaded = await reloadPluginsInModal();
            setNeedsRestart(true);
            if (reloaded) showToast('success', `${modeLabel} installed successfully`);
        } catch (error: unknown) {
            console.error('Failed to install local plugin', error);
            showToast('error', `Failed to install ${modeLabel}. Check plugin.json and package layout.`);
        } finally {
            setLocalPluginInstallMode(null);
        }
    };

    const handleTogglePlugin = async (id: string, enabled: boolean) => {
        setProcessingId(id);
        setActiveMenu(null);
        try {
            setPlugins(prev => prev.map(p => p.manifest.id === id ? { ...p, enabled } : p));
            await window.ipcRenderer.invoke('plugins:toggle', { id, enabled });
            showToast('info', `Plugin ${enabled ? 'enabled' : 'disabled'}. Restart required.`);
            setNeedsRestart(true);
        } catch (error) {
            console.error('Failed to toggle plugin', error);
            showToast('error', 'Failed to update plugin state');
            setPlugins(prev => prev.map(p => p.manifest.id === id ? { ...p, enabled: !enabled } : p));
        } finally {
            setProcessingId(null);
        }
    };

    const handleUninstallPlugin = async (id: string) => {
        const confirmed = await showConfirmDialog({
            title: "Uninstall Plugin",
            message: "Are you sure you want to uninstall this plugin? This action cannot be undone.",
            confirmText: "Uninstall",
            variant: "danger"
        });
        if (!confirmed) return;

        setProcessingId(id);
        setActiveMenu(null);
        try {
            await window.ipcRenderer.invoke('plugins:uninstall', { id });
            await reloadPluginsInModal();
            showToast('success', 'Plugin uninstalled successfully');
            setNeedsRestart(true);
        } catch (err: unknown) {
            console.error(err);
            const message = err instanceof Error ? err.message : String(err);
            showToast('error', `Failed to uninstall: ${message}`);
        } finally {
            setProcessingId(null);
        }
    };

    const handleUpdatePlugin = async (plugin: RegistryPlugin) => {
        setProcessingId(plugin.id);
        setActiveMenu(null);
        try {
            await window.ipcRenderer.invoke('plugins:install', { url: plugin.downloadUrl });
            await reloadPluginsInModal();
            showToast('success', 'Plugin updated successfully');
            setNeedsRestart(true);
        } catch (err: unknown) {
            console.error(err);
            const message = err instanceof Error ? err.message : String(err);
            showToast('error', `Failed to update: ${message}`);
        } finally {
            setProcessingId(null);
        }
    };

    return {
        plugins,
        isLoadingPlugins,
        registry,
        isLoadingRegistry,
        activeMenu,
        setActiveMenu,
        processingId,
        needsRestart,
        setNeedsRestart,
        localPluginInstallMode,
        handleInstallLocalPlugin,
        handleTogglePlugin,
        handleUninstallPlugin,
        handleUpdatePlugin,
        reloadPluginsInModal,
    };
}
