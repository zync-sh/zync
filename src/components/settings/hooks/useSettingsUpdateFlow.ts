import { useEffect, useRef, useState } from 'react';
import type { UpdateInfo, UpdateStatus } from '../../../store/updateSlice';

interface UpdateCheckResult {
    updateInfo?: UpdateInfo;
}

interface UseSettingsUpdateFlowOptions {
    isOpen: boolean;
    isWindows: boolean;
    updateStatus: UpdateStatus;
    updateInfo: UpdateInfo | null;
    setUpdateStatus: (status: UpdateStatus) => void;
    setUpdateInfo: (info: UpdateInfo | null) => void;
    showToast: (type: 'info' | 'success' | 'warning' | 'error', message: string) => void;
}

export function useSettingsUpdateFlow({
    isOpen,
    isWindows,
    updateStatus,
    updateInfo,
    setUpdateStatus,
    setUpdateInfo,
    showToast,
}: UseSettingsUpdateFlowOptions) {
    const isCheckingRef = useRef(false);
    const isUpdateActionInFlightRef = useRef(false);
    const isInstallingRef = useRef(false);
    const isMountedRef = useRef(false);
    const isOpenRef = useRef(isOpen);
    const [appVersion, setAppVersion] = useState('');
    const [isAppImage, setIsAppImage] = useState(false);
    const [showRestartConfirm, setShowRestartConfirm] = useState(false);

    useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    useEffect(() => {
        isOpenRef.current = isOpen;
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        window.ipcRenderer.invoke('app:getVersion')
            .then((ver: string) => {
                if (isMountedRef.current) setAppVersion(ver);
            })
            .catch((error: unknown) => {
                console.error('Failed to resolve app version', error);
            });

        window.ipcRenderer.invoke('app:isAppImage')
            .then((is: boolean) => {
                if (isMountedRef.current) setIsAppImage(is);
            })
            .catch((error: unknown) => {
                console.error('Failed to resolve app image mode', error);
            });
    }, [isOpen]);

    const checkForUpdates = async () => {
        if (isCheckingRef.current || updateStatus === 'checking') return;
        isCheckingRef.current = true;
        setUpdateStatus('checking');
        let nextInfo: UpdateInfo | null = null;
        let nextStatus: UpdateStatus = 'not-available';
        try {
            const result = await window.ipcRenderer.invoke('update:check') as UpdateCheckResult | null;
            nextInfo = result?.updateInfo ?? null;
            if (nextInfo) {
                nextStatus = 'available';
                if (isMountedRef.current && isOpenRef.current) {
                    showToast('info', nextInfo.version ? `Update v${nextInfo.version} available!` : 'An update is available!');
                }
            } else {
                nextStatus = 'not-available';
            }
        } catch (error) {
            nextStatus = 'error';
            console.error('Update check failed', error);
            const message = error instanceof Error ? error.message : String(error);
            if (isMountedRef.current && isOpenRef.current) {
                showToast('error', `Failed to check for updates: ${message}`);
            }
        } finally {
            setUpdateStatus(nextStatus);
            setUpdateInfo(nextInfo);
            isCheckingRef.current = false;
        }
    };

    const platform = window.electronUtils?.platform;
    const userAgent = window.navigator.userAgent.toLowerCase();
    const userAgentIndicatesMac = userAgent.includes('mac');
    const resolvedPlatform = platform || (isWindows ? 'win32' : (userAgentIndicatesMac ? 'darwin' : 'linux'));
    const platformLabel = isAppImage
        ? 'AppImage'
        : resolvedPlatform === 'darwin'
            ? 'macOS'
            : resolvedPlatform === 'win32'
                ? 'Windows'
                : 'Linux';
    const canAutoUpdate = resolvedPlatform !== 'darwin';

    const handleUpdateAction = async () => {
        if (isUpdateActionInFlightRef.current) return;
        if (updateStatus === 'checking' || updateStatus === 'downloading') return;
        isUpdateActionInFlightRef.current = true;
        try {
            if (updateStatus === 'available') {
                if (canAutoUpdate) {
                    setUpdateStatus('downloading');
                    try {
                        await window.ipcRenderer.invoke('update:download');
                    } catch (error: unknown) {
                        console.error('Update download failed', error);
                        setUpdateStatus('available');
                        if (isMountedRef.current && isOpenRef.current) {
                            showToast('error', 'Update download failed. Please try again.');
                        }
                    }
                } else {
                    try {
                        await window.ipcRenderer.invoke('shell:open', 'https://github.com/zync-sh/zync/releases/latest');
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        console.error('Failed to open release page', error);
                        if (isMountedRef.current && isOpenRef.current) {
                            showToast('error', `Failed to open release page: ${message}`);
                        }
                    }
                }
            } else if (updateStatus === 'ready') {
                setShowRestartConfirm(true);
            } else {
                await checkForUpdates();
            }
        } finally {
            isUpdateActionInFlightRef.current = false;
        }
    };

    const handleConfirmRestart = async () => {
        if (isInstallingRef.current) return;
        isInstallingRef.current = true;
        try {
            await window.ipcRenderer.invoke('update:install');
            if (!isMountedRef.current) return;
            setShowRestartConfirm(false);
            if (isOpenRef.current) {
                showToast('success', 'Restart initiated.');
            }
        } catch (error) {
            if (!isMountedRef.current) return;
            const message = error instanceof Error ? error.message : String(error);
            console.error('Failed to install update', error);
            if (isOpenRef.current) {
                showToast('error', `Failed to install update: ${message}`);
            }
        } finally {
            isInstallingRef.current = false;
        }
    };

    return {
        appVersion,
        isAppImage,
        showRestartConfirm,
        setShowRestartConfirm,
        platformLabel,
        canAutoUpdate,
        handleUpdateAction,
        handleConfirmRestart,
        checkForUpdates,
        updateInfo,
    };
}
