import { useEffect, useState } from 'react';

interface UseSettingsPathsOptions {
    isOpen: boolean;
}

interface AppConfig {
    dataPath?: string | null;
    logPath?: string | null;
    autoUpdateCheck?: boolean;
}

export function useSettingsPaths({ isOpen }: UseSettingsPathsOptions) {
    const [currentDataPath, setCurrentDataPath] = useState('');
    const [isDefaultDataPath, setIsDefaultDataPath] = useState(true);
    const [currentLogPath, setCurrentLogPath] = useState('');
    const [isDefaultLogPath, setIsDefaultLogPath] = useState(true);
    const [autoUpdateCheck, setAutoUpdateCheck] = useState(false);

    useEffect(() => {
        if (!isOpen) return;

        const loadConfig = async () => {
            try {
                const config = await window.ipcRenderer.invoke('config:get') as AppConfig | null;
                const dataPath = config?.dataPath || '';
                const logPath = config?.logPath || '';

                setCurrentDataPath(dataPath);
                setIsDefaultDataPath(!dataPath);
                setCurrentLogPath(logPath);
                setIsDefaultLogPath(!logPath);
                setAutoUpdateCheck(config?.autoUpdateCheck !== false);
            } catch (error) {
                console.error('Failed to load config paths', error);
                setCurrentDataPath('');
                setIsDefaultDataPath(true);
                setCurrentLogPath('');
                setIsDefaultLogPath(true);
                setAutoUpdateCheck(true);
            }
        };

        void loadConfig();
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
        }
    };

    const handleResetLocation = async () => {
        try {
            await window.ipcRenderer.invoke('config:set', { dataPath: null });
            setCurrentDataPath('');
            setIsDefaultDataPath(true);
        } catch (error) {
            console.error('Failed to reset data location', error);
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
        }
    };

    const handleResetLogLocation = async () => {
        try {
            await window.ipcRenderer.invoke('config:set', { logPath: null });
            setCurrentLogPath('');
            setIsDefaultLogPath(true);
        } catch (error) {
            console.error('Failed to reset log location', error);
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
