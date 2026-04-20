import { useCallback, useEffect, useState } from 'react';
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
    const [appVersion, setAppVersion] = useState('');
    const [isAppImage, setIsAppImage] = useState(false);
    const [showRestartConfirm, setShowRestartConfirm] = useState(false);

    useEffect(() => {
        if (!isOpen) return;
        let mounted = true;

        window.ipcRenderer.invoke('app:getVersion')
            .then((ver: string) => {
                if (mounted) setAppVersion(ver);
            })
            .catch((error: unknown) => {
                console.error('Failed to resolve app version', error);
            });

        window.ipcRenderer.invoke('app:isAppImage')
            .then((is: boolean) => {
                if (mounted) setIsAppImage(is);
            })
            .catch((error: unknown) => {
                console.error('Failed to resolve app image mode', error);
            });

        return () => {
            mounted = false;
        };
    }, [isOpen]);

    const isNewer = useCallback((v1: string) => {
        if (!appVersion || !v1) return false;
        try {
            const v1Parts = v1.replace('v', '').split('.').map(Number);
            const appParts = appVersion.replace('v', '').split('.').map(Number);
            for (let i = 0; i < Math.max(v1Parts.length, appParts.length); i++) {
                const a = v1Parts[i] || 0;
                const b = appParts[i] || 0;
                if (a > b) return true;
                if (a < b) return false;
            }
        } catch {
            return false;
        }
        return false;
    }, [appVersion]);

    const checkForUpdates = async () => {
        setUpdateStatus('checking');
        try {
            const result = await window.ipcRenderer.invoke('update:check') as UpdateCheckResult | null;
            const nextInfo = result?.updateInfo ?? null;
            if (nextInfo?.version && isNewer(nextInfo.version)) {
                setUpdateStatus('available');
                setUpdateInfo(nextInfo);
                showToast('info', `Update v${nextInfo.version} available!`);
            } else {
                setUpdateStatus('not-available');
                setUpdateInfo(nextInfo);
            }
        } catch (error) {
            setUpdateStatus('error');
            console.error('Update check failed', error);
        }
    };

    const platform = window.electronUtils?.platform;
    const isMac = platform === 'darwin' || window.navigator.userAgent.toLowerCase().includes('mac');
    const resolvedPlatform = platform || (isMac ? 'darwin' : (isWindows ? 'win32' : 'linux'));
    const platformLabel = isAppImage ? 'AppImage' : isMac ? 'macOS' : isWindows ? 'Windows' : 'Linux';
    const canAutoUpdate = resolvedPlatform !== 'darwin';

    const handleUpdateAction = () => {
        if (updateStatus === 'downloading') return;
        if (updateStatus === 'available') {
            if (canAutoUpdate) {
                setUpdateStatus('downloading');
                window.ipcRenderer.invoke('update:download')
                    .catch((error: unknown) => {
                        console.error('Update download failed', error);
                        setUpdateStatus('available');
                        showToast('error', 'Update download failed. Please try again.');
                    });
            } else {
                window.ipcRenderer.invoke('shell:open', 'https://github.com/zync-sh/zync/releases/latest');
            }
        } else if (updateStatus === 'ready') {
            setShowRestartConfirm(true);
        } else {
            void checkForUpdates();
        }
    };

    const handleConfirmRestart = async () => {
        try {
            await window.ipcRenderer.invoke('update:install');
            setShowRestartConfirm(false);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('Failed to install update', error);
            showToast('error', `Failed to install update: ${message}`);
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
