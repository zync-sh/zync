import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { filterUnsupportedHostThemes } from '../../../features/plugins/pluginCommandBridge';
import {
    clearPluginStorage,
    rollbackPluginVersion,
    setPluginOptionalPermissions,
    uninstallPlugin,
} from '../../../features/plugins/management/pluginManagement';
import type {
    InstalledPlugin,
    PluginActivationTransaction,
    PluginInstallInspection,
    RegistryPlugin,
    RegistryRevocation,
    TrustedPluginRegistrySnapshot,
} from '../../../features/plugins/types';
import { selectMarketplaceReleases } from '../../../features/plugins/marketplace/releases';

export type { InstalledPlugin, RegistryPlugin } from '../../../features/plugins/types';

const LEGACY_PLUGIN_CATALOG_URL = 'https://raw.githubusercontent.com/zync-sh/zync-extensions/main/marketplace.json';

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
    reloadPluginRuntime: (healthCheckPluginId?: string) => Promise<boolean>;
}

export function useSettingsPlugins({
    isOpen,
    activeTab,
    showToast,
    showConfirmDialog,
    reloadPluginRuntime,
}: UseSettingsPluginsOptions) {
    const isMountedRef = useRef(false);
    const processingRef = useRef<string | null>(null);
    const approvalInProgressRef = useRef(false);
    const showToastRef = useRef(showToast);
    const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
    const [isLoadingPlugins, setIsLoadingPlugins] = useState(false);
    const [registry, setRegistry] = useState<RegistryPlugin[]>([]);
    const [betaPluginIds, setBetaPluginIds] = useState<Set<string>>(new Set());
    const [isLoadingRegistry, setIsLoadingRegistry] = useState(false);
    const [activeMenu, setActiveMenu] = useState<string | null>(null);
    const [processingId, setProcessingId] = useState<string | null>(null);
    const [needsRestart, setNeedsRestart] = useState(false);
    const [localPluginInstallMode, setLocalPluginInstallMode] = useState<'zip' | 'folder' | null>(null);
    const [pendingPluginInspection, setPendingPluginInspection] = useState<PluginInstallInspection | null>(null);
    const [isApprovingLocalPlugin, setIsApprovingLocalPlugin] = useState(false);
    const [pluginDeveloperMode, setPluginDeveloperMode] = useState(false);
    const [isUpdatingDeveloperMode, setIsUpdatingDeveloperMode] = useState(false);

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
        if (!(isOpen && activeTab === 'plugins')) return;
        let isMounted = true;
        window.ipcRenderer.invoke('plugins:developer_mode_get')
            .then((enabled: boolean) => {
                if (isMounted) setPluginDeveloperMode(enabled === true);
            })
            .catch((error: unknown) => {
                console.error('Failed to load plugin Developer Mode state', error);
                if (isMounted) setPluginDeveloperMode(false);
            });
        return () => {
            isMounted = false;
        };
    }, [isOpen, activeTab]);

    useEffect(() => {
        if (!(isOpen && (activeTab === 'plugins' || activeTab === 'appearance'))) return;

        let isMounted = true;
        const controller = new AbortController();
        setIsLoadingRegistry(true);
        void (async () => {
            try {
                const snapshot = await window.ipcRenderer.invoke('plugins:registry_load') as TrustedPluginRegistrySnapshot;
                if (isMounted) {
                    const revocationReason = (plugin: RegistryPlugin): string | undefined => snapshot.revocations.find(
                        (revocation: RegistryRevocation) => revocation.publisher === plugin.publisher && (
                            (revocation.kind === 'publisherKey' && revocation.keyId === plugin.publisherKeyId)
                            || (revocation.kind === 'pluginRelease'
                                && revocation.pluginId === plugin.id
                                && revocation.version === plugin.version
                                && revocation.packageDigest === plugin.packageDigest)
                        ),
                    )?.reason;
                    setRegistry(snapshot.plugins.map(plugin => ({
                        ...plugin,
                        registryVerified: true,
                        revokedReason: revocationReason(plugin),
                    })));
                }
            } catch (trustedRegistryError) {
                console.info('Trusted plugin registry is unavailable; loading the legacy catalog', trustedRegistryError);
                try {
                    const response = await fetch(LEGACY_PLUGIN_CATALOG_URL, { signal: controller.signal });
                    if (!response.ok) throw new Error(`Legacy catalog returned ${response.status}`);
                    const data = await response.json() as { plugins?: RegistryPlugin[] };
                    if (!Array.isArray(data.plugins)) throw new Error('Legacy catalog is invalid');
                    if (isMounted) {
                        setRegistry(data.plugins.map(plugin => ({ ...plugin, registryVerified: false })));
                    }
                } catch (legacyError) {
                    if (!(legacyError instanceof DOMException && legacyError.name === 'AbortError')) {
                        console.error('Failed to load plugin catalog', legacyError);
                        if (isMounted) setRegistry([]);
                    }
                }
            } finally {
                if (isMounted) setIsLoadingRegistry(false);
            }
        })();

        return () => {
            isMounted = false;
            controller.abort();
        };
    }, [isOpen, activeTab]);

    useEffect(() => {
        if (!(isOpen && activeTab === 'plugins')) return;
        let mounted = true;
        window.ipcRenderer.invoke('plugins:beta_plugins_get')
            .then((ids: string[]) => { if (mounted) setBetaPluginIds(new Set(ids)); })
            .catch((error: unknown) => console.error('Failed to load plugin beta preferences', error));
        return () => { mounted = false; };
    }, [isOpen, activeTab]);

    const handleSetPluginBeta = async (pluginId: string, enabled: boolean) => {
        try {
            await window.ipcRenderer.invoke('plugins:beta_plugin_set', { pluginId, enabled });
            setBetaPluginIds(current => {
                const next = new Set(current);
                if (enabled) next.add(pluginId);
                else next.delete(pluginId);
                return next;
            });
        } catch (error) {
            showToastRef.current('error', `Could not change beta updates: ${String(error)}`);
        }
    };

    const handleInstallLocalPlugin = async (mode: 'zip' | 'folder') => {
        if (!pluginDeveloperMode) {
            showToastRef.current('warning', 'Enable Developer Mode before installing local plugins.');
            return;
        }
        if (isMountedRef.current) setLocalPluginInstallMode(mode);
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

            const inspection = await window.ipcRenderer.invoke('plugins:inspect_local', {
                path: selectedPath,
            }) as PluginInstallInspection;
            if (isMountedRef.current) {
                setPendingPluginInspection(inspection);
            }
        } catch (error: unknown) {
            console.error('Failed to inspect local plugin', error);
            const message = error instanceof Error ? error.message : String(error);
            if (isMountedRef.current) {
                showToastRef.current('error', `Plugin inspection failed: ${message}`);
            }
        } finally {
            if (isMountedRef.current) {
                setLocalPluginInstallMode(null);
            }
        }
    };

    const handleSetPluginDeveloperMode = async (enabled: boolean) => {
        if (isUpdatingDeveloperMode || enabled === pluginDeveloperMode) return;
        if (enabled) {
            const confirmed = await showConfirmDialog({
                title: 'Enable Developer Mode?',
                message: 'Developer Mode allows local and legacy plugins that have not been verified by the signed marketplace. Enable it only while testing code you trust.',
                confirmText: 'Enable Developer Mode',
                variant: 'danger',
            });
            if (!confirmed) return;
        }

        setIsUpdatingDeveloperMode(true);
        try {
            await window.ipcRenderer.invoke('plugins:developer_mode_set', { enabled });
            setPluginDeveloperMode(enabled);
            const runtimeReloaded = await reloadPluginRuntime();
            await reloadPluginsInModal();
            showToastRef.current(
                runtimeReloaded ? 'success' : 'warning',
                enabled
                    ? 'Developer Mode enabled for local plugin testing.'
                    : runtimeReloaded
                        ? 'Developer Mode disabled. Local and legacy plugins were stopped.'
                        : 'Developer Mode disabled. Restart Zync before using plugins again.',
            );
        } catch (error) {
            console.error('Failed to update plugin Developer Mode', error);
            showToastRef.current('error', 'Failed to update Developer Mode.');
        } finally {
            if (isMountedRef.current) setIsUpdatingDeveloperMode(false);
        }
    };

    const handleApproveLocalPlugin = async (optionalPermissionIds: string[]) => {
        const inspection = pendingPluginInspection;
        if (!inspection || approvalInProgressRef.current) return;
        approvalInProgressRef.current = true;
        setIsApprovingLocalPlugin(true);
        try {
            const activation = await window.ipcRenderer.invoke('plugins:install_inspected', {
                inspectionId: inspection.inspectionId,
                packageDigest: inspection.packageDigest,
                optionalPermissionIds,
            }) as PluginActivationTransaction;
            const reloaded = await reloadPluginsInModal();
            const runtimeReloaded = await reloadPluginRuntime(activation.pluginId);
            if (!runtimeReloaded) {
                await window.ipcRenderer.invoke('plugins:rollback_activation', {
                    activationId: activation.activationId,
                });
                await reloadPluginsInModal();
                const previousRuntimeRestored = await reloadPluginRuntime();
                if (isMountedRef.current) {
                    setPendingPluginInspection(null);
                    setNeedsRestart(!previousRuntimeRestored);
                    showToastRef.current(
                        'error',
                        activation.previousVersion
                            ? `${inspection.manifest.name} failed its activation check. Version ${activation.previousVersion} was restored.`
                            : `${inspection.manifest.name} failed its activation check and was removed.`,
                    );
                }
                return;
            }
            const rollbackRetained = await window.ipcRenderer.invoke('plugins:commit_activation', {
                activationId: activation.activationId,
            }) as boolean;
            if (isMountedRef.current) {
                setPendingPluginInspection(null);
                setNeedsRestart(false);
                if (reloaded) {
                    showToastRef.current(
                        activation.previousVersion && !rollbackRetained ? 'warning' : 'success',
                        activation.previousVersion && !rollbackRetained
                            ? `${inspection.manifest.name} activated, but its previous version could not be retained.`
                            : `${inspection.manifest.name} installed and activated`,
                    );
                }
            }
        } catch (error: unknown) {
            console.error('Failed to install local plugin', error);
            const message = error instanceof Error ? error.message : String(error);
            if (isMountedRef.current) {
                showToastRef.current('error', `Plugin installation failed: ${message}`);
            }
        } finally {
            approvalInProgressRef.current = false;
            if (isMountedRef.current) {
                setIsApprovingLocalPlugin(false);
            }
        }
    };

    const handleCancelLocalPluginReview = async () => {
        if (approvalInProgressRef.current) return;
        const inspection = pendingPluginInspection;
        setPendingPluginInspection(null);
        if (!inspection) return;
        try {
            await window.ipcRenderer.invoke('plugins:discard_inspection', {
                inspectionId: inspection.inspectionId,
            });
        } catch (error) {
            console.error('Failed to discard staged plugin inspection', error);
        }
    };

    const handleTogglePlugin = async (id: string, enabled: boolean) => {
        if (processingRef.current) return;
        processingRef.current = id;
        if (isMountedRef.current) {
            setProcessingId(id);
            setActiveMenu(null);
        }
        try {
            setPlugins(prev => prev.map(p => p.manifest.id === id ? { ...p, enabled } : p));
            await window.ipcRenderer.invoke('plugins:toggle', { id, enabled });
            const runtimeReloaded = await reloadPluginRuntime();
            if (isMountedRef.current) {
                setNeedsRestart(!runtimeReloaded);
                showToastRef.current(
                    runtimeReloaded ? 'info' : 'warning',
                    runtimeReloaded
                        ? `Plugin ${enabled ? 'enabled' : 'disabled'}.`
                        : `Plugin ${enabled ? 'enabled' : 'disabled'}, but runtime reload failed. Restart Zync to retry.`,
                );
            }
        } catch (error) {
            console.error('Failed to toggle plugin', error);
            if (isMountedRef.current) {
                const message = error instanceof Error ? error.message : String(error);
                showToastRef.current('error', `Failed to update plugin state: ${message}`);
                setPlugins(prev => prev.map(p => p.manifest.id === id ? { ...p, enabled: !enabled } : p));
            }
        } finally {
            processingRef.current = null;
            if (isMountedRef.current) {
                setProcessingId(null);
            }
        }
    };

    const handleUninstallPlugin = async (plugin: InstalledPlugin, deleteData: boolean) => {
        if (processingRef.current) return;
        const id = plugin.manifest.id;
        const confirmed = await showConfirmDialog({
            title: deleteData ? 'Uninstall and delete data' : 'Uninstall plugin',
            message: deleteData
                ? `Remove ${plugin.manifest.name} and permanently delete all of its private data from this device?`
                : `Remove ${plugin.manifest.name}? Its private data will be kept in case you reinstall it.`,
            confirmText: deleteData ? 'Uninstall and delete' : 'Uninstall',
            variant: 'danger',
        });
        if (!confirmed) return;

        processingRef.current = id;
        if (isMountedRef.current) {
            setProcessingId(id);
            setActiveMenu(null);
        }
        try {
            const result = await uninstallPlugin(id, deleteData);
            await reloadPluginsInModal();
            const runtimeReloaded = await reloadPluginRuntime();
            if (isMountedRef.current) {
                const dataDeleteFailed = deleteData && Boolean(result.dataDeleteError);
                showToastRef.current(
                    runtimeReloaded && !dataDeleteFailed ? 'success' : 'warning',
                    dataDeleteFailed
                        ? 'Plugin uninstalled, but its private data could not be deleted.'
                        : runtimeReloaded
                            ? deleteData ? 'Plugin and private data deleted' : 'Plugin uninstalled; private data was kept'
                            : 'Plugin uninstalled, but runtime reload failed. Restart Zync to finish cleanup.',
                );
                setNeedsRestart(!runtimeReloaded);
            }
        } catch (err: unknown) {
            console.error(err);
            // Uninstall revokes the native runtime before touching the package. If package
            // removal fails, start a fresh generation so the installed plugin remains usable.
            const runtimeReloaded = await reloadPluginRuntime();
            const message = err instanceof Error ? err.message : String(err);
            if (isMountedRef.current) {
                setNeedsRestart(!runtimeReloaded);
                showToastRef.current('error', `Failed to uninstall: ${message}`);
            }
        } finally {
            processingRef.current = null;
            if (isMountedRef.current) {
                setProcessingId(null);
            }
        }
    };

    const handleInspectMarketplacePlugin = async (plugin: RegistryPlugin) => {
        if (processingRef.current) return;
        if (!plugin.registryVerified) {
            showToastRef.current('warning', 'Install is unavailable because this catalog entry is not signed.');
            return;
        }
        processingRef.current = plugin.id;
        if (isMountedRef.current) {
            setProcessingId(plugin.id);
            setActiveMenu(null);
        }
        try {
            const inspection = await window.ipcRenderer.invoke('plugins:inspect_marketplace', {
                pluginId: plugin.id,
                version: plugin.version,
            }) as PluginInstallInspection;
            if (isMountedRef.current) {
                setPendingPluginInspection(inspection);
            }
        } catch (err: unknown) {
            console.error(err);
            const message = err instanceof Error ? err.message : String(err);
            if (isMountedRef.current) {
                showToastRef.current('error', `Marketplace verification failed: ${message}`);
            }
        } finally {
            processingRef.current = null;
            if (isMountedRef.current) {
                setProcessingId(null);
            }
        }
    };

    const handleUpdatePlugin = handleInspectMarketplacePlugin;

    const handleSetOptionalPluginPermissions = async (
        pluginId: string,
        optionalPermissionIds: string[],
    ): Promise<boolean> => {
        if (processingRef.current) return false;
        processingRef.current = pluginId;
        if (isMountedRef.current) setProcessingId(pluginId);
        try {
            await setPluginOptionalPermissions(pluginId, optionalPermissionIds);
            const runtimeReloaded = await reloadPluginRuntime();
            if (isMountedRef.current) {
                setNeedsRestart(!runtimeReloaded);
                showToastRef.current(
                    runtimeReloaded ? 'success' : 'warning',
                    runtimeReloaded
                        ? 'Plugin permissions updated'
                        : 'Permissions updated, but runtime reload failed. Restart Zync to apply them.',
                );
            }
            return true;
        } catch (error) {
            console.error('Failed to update plugin permissions', error);
            const message = error instanceof Error ? error.message : String(error);
            if (isMountedRef.current) {
                showToastRef.current('error', `Failed to update permissions: ${message}`);
            }
            return false;
        } finally {
            processingRef.current = null;
            if (isMountedRef.current) setProcessingId(null);
        }
    };

    const handleClearPluginData = async (plugin: InstalledPlugin): Promise<boolean> => {
        if (processingRef.current) return false;
        const confirmed = await showConfirmDialog({
            title: 'Clear plugin data',
            message: `Delete all private data stored by ${plugin.manifest.name} on this device? The plugin will reload with an empty store.`,
            confirmText: 'Clear data',
            variant: 'danger',
        });
        if (!confirmed) return false;

        const pluginId = plugin.manifest.id;
        processingRef.current = pluginId;
        if (isMountedRef.current) setProcessingId(pluginId);
        try {
            await clearPluginStorage(pluginId);
            const runtimeReloaded = await reloadPluginRuntime();
            if (isMountedRef.current) {
                setNeedsRestart(!runtimeReloaded);
                showToastRef.current(
                    runtimeReloaded ? 'success' : 'warning',
                    runtimeReloaded
                        ? 'Plugin data cleared'
                        : 'Plugin data cleared, but runtime reload failed. Restart Zync before using the plugin.',
                );
            }
            return true;
        } catch (error) {
            console.error('Failed to clear plugin data', error);
            // The native command revokes the runtime before touching disk. Restore a fresh
            // generation even when deletion fails so the plugin is not left half-stopped.
            const runtimeReloaded = await reloadPluginRuntime();
            const message = error instanceof Error ? error.message : String(error);
            if (isMountedRef.current) {
                setNeedsRestart(!runtimeReloaded);
                showToastRef.current('error', `Failed to clear plugin data: ${message}`);
            }
            return false;
        } finally {
            processingRef.current = null;
            if (isMountedRef.current) setProcessingId(null);
        }
    };

    const handleRollbackPlugin = async (
        plugin: InstalledPlugin,
        rollbackVersion: string,
    ): Promise<boolean> => {
        if (processingRef.current) return false;
        const confirmed = await showConfirmDialog({
            title: `Restore version ${rollbackVersion}`,
            message: `Replace ${plugin.manifest.name} ${plugin.manifest.version} with the retained ${rollbackVersion} package and its reviewed permissions? Plugin data will be kept.`,
            confirmText: 'Restore version',
            variant: 'primary',
        });
        if (!confirmed) return false;

        const pluginId = plugin.manifest.id;
        processingRef.current = pluginId;
        if (isMountedRef.current) setProcessingId(pluginId);
        try {
            const result = await rollbackPluginVersion(pluginId);
            await reloadPluginsInModal();
            const runtimeHealthy = await reloadPluginRuntime(pluginId);
            if (!runtimeHealthy) {
                await rollbackPluginVersion(pluginId);
                await reloadPluginsInModal();
                const originalRuntimeRestored = await reloadPluginRuntime(pluginId);
                if (isMountedRef.current) {
                    setNeedsRestart(!originalRuntimeRestored);
                    showToastRef.current(
                        'error',
                        `Version ${result.restoredVersion} failed its activation check. Version ${result.replacedVersion} was restored.`,
                    );
                }
                return false;
            }
            if (isMountedRef.current) {
                setNeedsRestart(false);
                showToastRef.current('success', `${plugin.manifest.name} restored to version ${result.restoredVersion}`);
            }
            return true;
        } catch (error) {
            console.error('Failed to roll back plugin version', error);
            const runtimeReloaded = await reloadPluginRuntime();
            const message = error instanceof Error ? error.message : String(error);
            if (isMountedRef.current) {
                setNeedsRestart(!runtimeReloaded);
                showToastRef.current('error', `Plugin rollback failed: ${message}`);
            }
            return false;
        } finally {
            processingRef.current = null;
            if (isMountedRef.current) setProcessingId(null);
        }
    };

    return {
        // Host-global manifest.style support was removed for sandbox safety. Keep these
        // packages manageable on the Plugins tab, but do not advertise them as usable themes.
        plugins: activeTab === 'appearance'
            ? filterUnsupportedHostThemes(plugins).filter(plugin => plugin.enabled)
            : plugins,
        isLoadingPlugins,
        registry,
        selectedRegistry: selectMarketplaceReleases(registry, betaPluginIds),
        betaPluginIds,
        handleSetPluginBeta,
        isLoadingRegistry,
        activeMenu,
        setActiveMenu,
        processingId,
        needsRestart,
        setNeedsRestart,
        localPluginInstallMode,
        pluginDeveloperMode,
        isUpdatingDeveloperMode,
        pendingPluginInspection,
        isApprovingLocalPlugin,
        handleInstallLocalPlugin,
        handleSetPluginDeveloperMode,
        handleApproveLocalPlugin,
        handleCancelLocalPluginReview,
        handleTogglePlugin,
        handleUninstallPlugin,
        handleUpdatePlugin,
        handleInspectMarketplacePlugin,
        handleSetOptionalPluginPermissions,
        handleClearPluginData,
        handleRollbackPlugin,
        reloadPluginsInModal,
    };
}
