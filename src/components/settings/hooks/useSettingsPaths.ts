import { useEffect, useState } from 'react';
import { useAppStore } from '../../../store/useAppStore';

interface UseSettingsPathsOptions {
    isOpen: boolean;
}

interface AppConfig {
    dataPath?: string | null;
    logPath?: string | null;
    autoUpdateCheck?: boolean;
}

export function useSettingsPaths({ isOpen }: UseSettingsPathsOptions) {
    const showToast = useAppStore((state) => state.showToast);
    const [currentDataPath, setCurrentDataPath] = useState('');
    const [isDefaultDataPath, setIsDefaultDataPath] = useState(true);
    const [currentLogPath, setCurrentLogPath] = useState('');
    const [isDefaultLogPath, setIsDefaultLogPath] = useState(true);
    const [autoUpdateCheck, setAutoUpdateCheck] = useState(true);

    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;

        const loadConfig = async () => {
            try {
                const config = await window.ipcRenderer.invoke('config:get') as AppConfig | null;
                if (cancelled) return;
                const dataPath = config?.dataPath || '';
                const logPath = config?.logPath || '';

                setCurrentDataPath(dataPath);
                setIsDefaultDataPath(!dataPath);
                setCurrentLogPath(logPath);
                setIsDefaultLogPath(!logPath);
                setAutoUpdateCheck(config?.autoUpdateCheck !== false);
            } catch (error) {
                if (cancelled) return;
                console.error('Failed to load config paths', error);
                setCurrentDataPath('');
                setIsDefaultDataPath(true);
                setCurrentLogPath('');
                setIsDefaultLogPath(true);
                setAutoUpdateCheck(true);
            }
        };

        void loadConfig();
        return () => {
            cancelled = true;
        };
    }, [isOpen]);

    const handleChangeLocation = async () => {
        try {
            const path = await window.ipcRenderer.invoke('config:select-folder') as string | null;
            if (!path) return;
            await window.ipcRenderer.invoke('config:set', { dataPath: path });
            setCurrentDataPath(path);
            setIsDefaultDataPath(false);
        } catch (error) {
            console.error('Failed to change data location', error);
            const message = error instanceof Error ? error.message : String(error);
            showToast('error', `Failed to change data location: ${message}`);
        }
    };

    const handleResetLocation = async () => {
        try {
            await window.ipcRenderer.invoke('config:set', { dataPath: null });
            setCurrentDataPath('');
            setIsDefaultDataPath(true);
        } catch (error) {
            console.error('Failed to reset data location', error);
            const message = error instanceof Error ? error.message : String(error);
            showToast('error', `Failed to reset data location: ${message}`);
        }
    };

    const handleChangeLogLocation = async () => {
        try {
            const path = await window.ipcRenderer.invoke('config:select-folder') as string | null;
            if (!path) return;
            await window.ipcRenderer.invoke('config:set', { logPath: path });
            setCurrentLogPath(path);
            setIsDefaultLogPath(false);
        } catch (error) {
            console.error('Failed to change log location', error);
            const message = error instanceof Error ? error.message : String(error);
            showToast('error', `Failed to change log location: ${message}`);
        }
    };

    const handleResetLogLocation = async () => {
        try {
            await window.ipcRenderer.invoke('config:set', { logPath: null });
            setCurrentLogPath('');
            setIsDefaultLogPath(true);
        } catch (error) {
            console.error('Failed to reset log location', error);
            const message = error instanceof Error ? error.message : String(error);
            showToast('error', `Failed to reset log location: ${message}`);
        }
    };

    const handleToggleAutoUpdate = async () => {
        const newValue = !autoUpdateCheck;
        setAutoUpdateCheck(newValue);
        try {
            await window.ipcRenderer.invoke('config:set', { autoUpdateCheck: newValue });
        } catch (error) {
            setAutoUpdateCheck(!newValue);
            console.error('Failed to update auto update preference', error);
            const message = error instanceof Error ? error.message : String(error);
            showToast('error', `Failed to update auto-check preference: ${message}`);
        }
    };

    return {
        currentDataPath,
        isDefaultDataPath,
        currentLogPath,
        isDefaultLogPath,
        autoUpdateCheck,
        handleChangeLocation,
        handleResetLocation,
        handleChangeLogLocation,
        handleResetLogLocation,
        handleToggleAutoUpdate,
    };
}
