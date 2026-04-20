import { useEffect, useRef, useState } from 'react';
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
    const isMountedRef = useRef(false);
    const showToastRef = useRef(showToast);
    const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
    const [isLoadingPlugins, setIsLoadingPlugins] = useState(false);
    const [registry, setRegistry] = useState<RegistryPlugin[]>([]);
    const [isLoadingRegistry, setIsLoadingRegistry] = useState(false);
    const [activeMenu, setActiveMenu] = useState<string | null>(null);
    const [processingId, setProcessingId] = useState<string | null>(null);
    const [needsRestart, setNeedsRestart] = useState(false);
    const [localPluginInstallMode, setLocalPluginInstallMode] = useState<'zip' | 'folder' | null>(null);

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    useEffect(() => {
        showToastRef.current = showToast;
    }, [showToast]);

    const reloadPluginsInModal = async () => {
        try {
            const list = await window.ipcRenderer.invoke('plugins:load') as InstalledPlugin[];
            if (isMountedRef.current) {
                setPlugins(list);
            }
            return true;
        } catch (error) {
            console.error('Failed to reload plugins list', error);
            if (isMountedRef.current) {
                showToastRef.current('warning', 'Plugin installed, but list refresh failed. Reopen Settings to refresh.');
            }
            return false;
        }
    };

    useEffect(() => {
        if (!(isOpen && (activeTab === 'plugins' || activeTab === 'appearance'))) return;

        let isMounted = true;

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

        return () => {
            isMounted = false;
        };
    }, [isOpen, activeTab]);

    useEffect(() => {
        if (!(isOpen && (activeTab === 'plugins' || activeTab === 'appearance'))) return;

        let isMounted = true;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        setIsLoadingRegistry(true);
        fetch("https://raw.githubusercontent.com/zync-sh/zync-extensions/main/marketplace.json", {
            signal: controller.signal
        })
            .then((res) => {
                if (!res.ok) {
                    throw new Error(`Registry fetch failed: ${res.status} ${res.statusText}`);
                }
                return res.json();
            })
            .then(data => {
                if (!isMounted || controller.signal.aborted) return;
                if (
                    !data
                    || typeof data !== 'object'
                    || !('plugins' in data)
                    || !Array.isArray((data as { plugins?: unknown }).plugins)
                ) {
                    throw new Error('Registry payload is invalid');
                }
                setRegistry((data as { plugins: RegistryPlugin[] }).plugins);
            })
            .catch((err: unknown) => {
                if (err instanceof DOMException && err.name === 'AbortError') {
                    console.error('Plugin registry fetch timed out after 10s');
                } else {
                    console.error('Failed to fetch registry', err);
                    if (isMounted && isMountedRef.current) {
                        showToastRef.current('error', 'Failed to load plugin marketplace. Please try again later.');
                    }
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
        if (isMountedRef.current) setLocalPluginInstallMode(mode);
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
            if (isMountedRef.current) {
                setNeedsRestart(true);
                if (reloaded) showToastRef.current('success', `${modeLabel} installed successfully`);
            }
        } catch (error: unknown) {
            console.error('Failed to install local plugin', error);
            if (isMountedRef.current) {
                showToastRef.current('error', `Failed to install ${modeLabel}. Check plugin.json and package layout.`);
            }
        } finally {
            if (isMountedRef.current) {
                setLocalPluginInstallMode(null);
            }
        }
    };

    const handleTogglePlugin = async (id: string, enabled: boolean) => {
        if (processingId) return;
        if (isMountedRef.current) {
            setProcessingId(id);
            setActiveMenu(null);
        }
        try {
            setPlugins(prev => prev.map(p => p.manifest.id === id ? { ...p, enabled } : p));
            await window.ipcRenderer.invoke('plugins:toggle', { id, enabled });
            if (isMountedRef.current) {
                showToastRef.current('info', `Plugin ${enabled ? 'enabled' : 'disabled'}. Restart required.`);
                setNeedsRestart(true);
            }
        } catch (error) {
            console.error('Failed to toggle plugin', error);
            if (isMountedRef.current) {
                showToastRef.current('error', 'Failed to update plugin state');
                setPlugins(prev => prev.map(p => p.manifest.id === id ? { ...p, enabled: !enabled } : p));
            }
        } finally {
            if (isMountedRef.current) {
                setProcessingId(null);
            }
        }
    };

    const handleUninstallPlugin = async (id: string) => {
        if (processingId) return;
        const confirmed = await showConfirmDialog({
            title: "Uninstall Plugin",
            message: "Are you sure you want to uninstall this plugin? This action cannot be undone.",
            confirmText: "Uninstall",
            variant: "danger"
        });
        if (!confirmed) return;

        if (isMountedRef.current) {
            setProcessingId(id);
            setActiveMenu(null);
        }
        try {
            await window.ipcRenderer.invoke('plugins:uninstall', { id });
            await reloadPluginsInModal();
            if (isMountedRef.current) {
                showToastRef.current('success', 'Plugin uninstalled successfully');
                setNeedsRestart(true);
            }
        } catch (err: unknown) {
            console.error(err);
            const message = err instanceof Error ? err.message : String(err);
            if (isMountedRef.current) {
                showToastRef.current('error', `Failed to uninstall: ${message}`);
            }
        } finally {
            if (isMountedRef.current) {
                setProcessingId(null);
            }
        }
    };

    const handleUpdatePlugin = async (plugin: RegistryPlugin) => {
        if (processingId) return;
        if (isMountedRef.current) {
            setProcessingId(plugin.id);
            setActiveMenu(null);
        }
        try {
            await window.ipcRenderer.invoke('plugins:install', { url: plugin.downloadUrl });
            await reloadPluginsInModal();
            if (isMountedRef.current) {
                showToastRef.current('success', 'Plugin updated successfully');
                setNeedsRestart(true);
            }
        } catch (err: unknown) {
            console.error(err);
            const message = err instanceof Error ? err.message : String(err);
            if (isMountedRef.current) {
                showToastRef.current('error', `Failed to update: ${message}`);
            }
        } finally {
            if (isMountedRef.current) {
                setProcessingId(null);
            }
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
