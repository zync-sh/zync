import { useCallback, useEffect, useRef } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { notify } from '../notifications/notify';
import type { UpdateProgressDetail } from './types';
import { evaluateAutoDownloadDecision } from './updaterIpcCore';
import {
    checkForUpdates,
    installAndRestart,
    openReleasePage,
    startDownload,
} from './updaterService';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

/** Own updater checks/actions and expose view state only to components that request it. */
export function useAutoUpdater() {
    const updateStatus = useAppStore((state) => state.updateStatus);
    const updateInfo = useAppStore((state) => state.updateInfo);
    const downloadProgress = useAppStore((state) => state.downloadProgress);
    const setUpdateStatus = useAppStore((state) => state.setUpdateStatus);
    const setUpdateInfo = useAppStore((state) => state.setUpdateInfo);
    const setDownloadProgress = useAppStore((state) => state.setDownloadProgress);

    const isCheckingRef = useRef(false);
    const hasAutoDownloadedRef = useRef(false);

    const handleRestartAndInstall = useCallback(async () => {
        try {
            await installAndRestart();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            notify.error(`Failed to restart for update: ${message}`, {
                id: 'zync-updater',
                actions: [
                    {
                        id: 'retry-restart',
                        label: 'Retry Restart',
                        /** Retry installation after a failed updater restart. */
                        onClick: () => {
                            void handleRestartAndInstall();
                        },
                    },
                    {
                        id: 'manual-download',
                        label: 'Download Manually',
                        /** Open the existing manual-release fallback. */
                        onClick: () => {
                            void openReleasePage();
                        },
                    },
                ],
            });
        }
    }, []);

    const handleStartDownload = useCallback(async () => {
        setUpdateStatus('downloading');
        setDownloadProgress(0);
        try {
            await startDownload();
        } catch (error) {
            if (import.meta.env.DEV) {
                console.warn(
                    'Real package download not available (running simulated download in dev mode):',
                    error,
                );
                try {
                    const { runDevSimulatedDownloadFallback } = await import('./mockUpdater');
                    const currentInfo = useAppStore.getState().updateInfo;
                    const handled = await runDevSimulatedDownloadFallback(
                        currentInfo?.version || '2.25.0',
                        2000,
                    );
                    if (handled) {
                        return;
                    }
                } catch (simErr) {
                    console.error('Simulated download failed:', simErr);
                }
            }
            console.error('Download start failed:', error);
            setUpdateStatus('error');
            notify.error('Update download failed. Please try again or download manually.', {
                id: 'zync-updater',
                persist: true,
                history: true,
                source: 'updater',
                actions: [
                    {
                        id: 'retry-dl',
                        label: 'Retry Download',
                        /** Retry a failed package download. */
                        onClick: () => {
                            void handleStartDownload();
                        },
                    },
                    {
                        id: 'manual-dl',
                        label: 'Download Manually',
                        /** Open the manual package download fallback. */
                        onClick: () => {
                            void openReleasePage();
                        },
                    },
                ],
            });
        }
    }, [setUpdateStatus, setDownloadProgress]);

    const performCheck = useCallback(
        async (isManual = false) => {
            const currentStatus = useAppStore.getState().updateStatus;
            if (currentStatus === 'downloading' || currentStatus === 'ready') {
                return;
            }
            if (isCheckingRef.current) {
                return;
            }
            isCheckingRef.current = true;
            setUpdateStatus('checking');

            try {
                let autoDownload = true;
                try {
                    const config = (await window.ipcRenderer.invoke('config:get')) as {
                        autoDownloadUpdates?: boolean;
                    } | null;
                    if (config?.autoDownloadUpdates === false) {
                        autoDownload = false;
                    }
                } catch {
                    autoDownload = true;
                }

                const info = await checkForUpdates();
                if (info && info.version) {
                    setUpdateInfo(info);

                    const decision = evaluateAutoDownloadDecision({
                        autoDownload,
                        hasAutoDownloaded: hasAutoDownloadedRef.current,
                    });

                    if (decision.shouldTriggerDownload) {
                        // Scenario 1: Auto-update enabled -> quietly download in background without notification noise
                        hasAutoDownloadedRef.current = decision.nextHasAutoDownloaded;
                        await handleStartDownload();
                        if (useAppStore.getState().updateStatus === 'error') {
                            hasAutoDownloadedRef.current = false;
                        }
                    } else if (!autoDownload) {
                        // Scenario 2: Auto-download disabled -> show available state + Download action
                        setUpdateStatus('available');
                        notify.info(`Update v${info.version} is available.`, {
                            id: 'zync-updater',
                            persist: true,
                            history: true,
                            source: 'updater',
                            actions: [
                                {
                                    id: 'start-download',
                                    label: 'Download',
                                    /** Start the update explicitly requested by the user. */
                                    onClick: () => {
                                        void handleStartDownload();
                                    },
                                },
                            ],
                        });
                    } else {
                        setUpdateStatus('available');
                    }
                } else {
                    setUpdateStatus('not-available');
                    if (isManual) {
                        notify.success('Zync is up to date.', { duration: 3000 });
                    }
                }
            } catch (error) {
                console.error('Update check failed:', error);
                setUpdateStatus('error');
                if (isManual) {
                    const message = error instanceof Error ? error.message : String(error);
                    notify.error(`Update check failed: ${message}`);
                }
            } finally {
                isCheckingRef.current = false;
            }
        },
        [setUpdateStatus, setUpdateInfo, setDownloadProgress, handleStartDownload],
    );

    useEffect(() => {
        let isCancelled = false;

        // Progress listener
        /** Apply updater progress and final notifications through the existing store actions. */
        const handleProgress = (event: Event) => {
            const customEvent = event as CustomEvent<UpdateProgressDetail>;
            const detail = customEvent.detail;
            if (!detail) {
                return;
            }

            if (detail.status === 'started') {
                setUpdateStatus('downloading');
                setDownloadProgress(0);
            } else if (detail.status === 'progress') {
                setDownloadProgress(detail.percent);
            } else if (detail.status === 'finished') {
                setDownloadProgress(100);
                setUpdateStatus('ready');

                const latestInfo = useAppStore.getState().updateInfo;
                const versionLabel = latestInfo?.version
                    ? `v${latestInfo.version}`
                    : 'latest version';

                // Single notification with stable id (replaces any previous updater notification)
                notify.success(`Zync ${versionLabel} is ready to install!`, {
                    id: 'zync-updater',
                    persist: true,
                    history: true,
                    source: 'updater',
                    actions: [
                        {
                            id: 'restart-install',
                            label: 'Restart & Install',
                            /** Install the downloaded package after an explicit restart action. */
                            onClick: () => {
                                void handleRestartAndInstall();
                            },
                        },
                    ],
                });
            } else if (detail.status === 'error') {
                setUpdateStatus('error');
            }
        };

        window.addEventListener('zync:update-progress', handleProgress);

        // Initial check if enabled and post-update welcome
        /** Show a completed-update acknowledgement and honor the configured startup-check policy. */
        const initUpdateCheck = async () => {
            // Check if app just restarted from a successful update
            try {
                if (
                    typeof localStorage !== 'undefined' &&
                    localStorage.getItem('zync-just-updated') === 'true'
                ) {
                    localStorage.removeItem('zync-just-updated');
                    const currentVersion =
                        ((await window.ipcRenderer.invoke('app:getVersion')) as string) || '';
                    const versionLabel = currentVersion ? `v${currentVersion}` : '';
                    notify.success(`Updated to Zync ${versionLabel} successfully!`, {
                        id: 'zync-updated-welcome',
                        duration: 6000,
                        history: true,
                        source: 'updater',
                        actions: [
                            {
                                id: 'whats-new',
                                label: "What's New",
                                onClick: () => {
                                    useAppStore.getState().openReleaseNotesTab();
                                },
                            },
                        ],
                    });
                }
            } catch (err) {
                console.warn('Post-update check failed:', err);
            }

            try {
                const config = (await window.ipcRenderer.invoke('config:get')) as {
                    autoUpdateCheck?: boolean;
                } | null;
                if (isCancelled) {
                    return;
                }
                if (config?.autoUpdateCheck !== false) {
                    await performCheck(false);
                }
            } catch (err) {
                console.warn('Could not read autoUpdateCheck config, running default check:', err);
                if (!isCancelled) {
                    await performCheck(false);
                }
            }
        };

        void initUpdateCheck();

        // 4-hour recurring check interval
        const interval = setInterval(async () => {
            try {
                const config = (await window.ipcRenderer.invoke('config:get')) as {
                    autoUpdateCheck?: boolean;
                } | null;
                if (isCancelled) {
                    return;
                }
                if (config?.autoUpdateCheck !== false) {
                    void performCheck(false);
                }
            } catch {
                if (!isCancelled) {
                    void performCheck(false);
                }
            }
        }, FOUR_HOURS_MS);

        return () => {
            isCancelled = true;
            clearInterval(interval);
            window.removeEventListener('zync:update-progress', handleProgress);
        };
    }, [performCheck, setUpdateStatus, setDownloadProgress, handleRestartAndInstall]);

    return {
        updateStatus,
        updateInfo,
        downloadProgress,
        checkForUpdates: () => performCheck(true),
        startDownload: handleStartDownload,
        installAndRestart: handleRestartAndInstall,
        openReleasePage,
    };
}

/** Isolate progress subscriptions from the application root and its workspace subtree. */
export function AutoUpdaterController() {
    useAutoUpdater();
    return null;
}
