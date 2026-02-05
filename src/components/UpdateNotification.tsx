import { useEffect, useState } from 'react';
import { RefreshCw, Download, AlertTriangle, X, ExternalLink } from 'lucide-react';
import { Button } from './ui/Button';
import { useAppStore } from '../store/useAppStore';
// Imports updated

export function UpdateNotification() {
    // Global State
    const status = useAppStore(state => state.updateStatus);
    const updateInfo = useAppStore(state => state.updateInfo);
    const progress = useAppStore(state => state.downloadProgress);

    // Actions
    const setUpdateStatus = useAppStore(state => state.setUpdateStatus);
    const setUpdateInfo = useAppStore(state => state.setUpdateInfo);
    const setDownloadProgress = useAppStore(state => state.setDownloadProgress);

    // Local Visibility
    const [isVisible, setIsVisible] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        let isCancelled = false;

        // Listen for progress events from IPC
        const handleProgress = (e: any) => {
            const { detail } = e;
            if (detail.status === 'started') {
                setUpdateStatus('downloading');
                setDownloadProgress(0);
            } else if (detail.status === 'progress') {
                setDownloadProgress(detail.percent);
            } else if (detail.status === 'finished') {
                setDownloadProgress(100);
                setUpdateStatus('ready');
            }
        };

        window.addEventListener('zync:update-progress', handleProgress);

        const checkForUpdates = async () => {
            try {
                setUpdateStatus('checking');
                // Use IPC wrapper to ensure shared state
                const result = await window.ipcRenderer.invoke('update:check');

                if (isCancelled) return;

                if (result && result.updateInfo) {
                    console.log('Update available:', result.updateInfo.version);
                    setUpdateInfo(result.updateInfo);
                    setUpdateStatus('available');
                    setIsVisible(true);
                } else {
                    setUpdateStatus('not-available');
                }
            } catch (err: any) {
                if (isCancelled) return;
                console.error('Update check failed:', err);
                setUpdateStatus('error');
                setError(String(err));
            }
        };

        checkForUpdates();

        // Check for updates every 4 hours
        const interval = setInterval(checkForUpdates, 4 * 60 * 60 * 1000);

        return () => {
            isCancelled = true;
            clearInterval(interval);
            window.removeEventListener('zync:update-progress', handleProgress);
        };
    }, []);

    // Auto-hide when idle
    useEffect(() => {
        if (status === 'idle' || status === 'not-available') {
            setIsVisible(false);
        }
    }, [status]);

    const startDownload = async () => {
        try {
            setUpdateStatus('downloading');
            setDownloadProgress(0);
            await window.ipcRenderer.invoke('update:download');
        } catch (err: any) {
            console.error('Download failed:', err);
            setUpdateStatus('error');
            setError(String(err));
        }
    };

    const installUpdate = async () => {
        try {
            await window.ipcRenderer.invoke('update:install');
        } catch (err) {
            console.error('Failed to launch installer:', err);
            // Fallback: just tell them to restart manually
            setUpdateStatus('ready');
        }
    };

    const dismiss = () => {
        setIsVisible(false);
    };

    if (!isVisible || status === 'idle' || status === 'checking' || status === 'not-available') return null;

    return (
        <div className="fixed bottom-6 right-6 z-50 max-w-sm w-full animate-in slide-in-from-bottom-5 duration-300">
            <div className="bg-app-panel border border-app-border rounded-xl shadow-2xl p-4 backdrop-blur-xl bg-opacity-95 ring-1 ring-black/5">
                <div className="flex items-start gap-4">
                    <div className="p-2.5 bg-app-accent/10 rounded-xl text-app-accent shrink-0">
                        {status === 'downloading' ? <Download size={24} className="animate-bounce" /> :
                            status === 'ready' ? <RefreshCw size={24} className="animate-spin-slow" /> :
                                status === 'error' ? <AlertTriangle size={24} className="text-red-500" /> :
                                    <Download size={24} />}
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between mb-1">
                            <h4 className="text-sm font-bold text-app-text">
                                {status === 'available' && `Update Available ${updateInfo?.version ? `(v${updateInfo.version})` : ''}`}
                                {status === 'downloading' && 'Downloading Update...'}
                                {status === 'ready' && 'Ready to Install'}
                                {status === 'error' && 'Update Failed'}
                            </h4>
                            <button onClick={dismiss} className="text-app-muted hover:text-app-text transition-colors p-0.5 rounded-md hover:bg-app-surface">
                                <span className="sr-only">Dismiss</span>
                                <X size={16} />
                            </button>
                        </div>

                        <p className="text-xs text-app-muted mb-3 leading-relaxed">
                            {status === 'available' && (window.electronUtils.platform === 'darwin'
                                ? 'A new version of Zync is available. Download it manually to update.'
                                : 'A new version of Zync is available. Do you want to download it now?')}
                            {status === 'downloading' && `${Math.round(progress)}% downloaded. You can keep working while we prepare the update.`}
                            {status === 'ready' && 'Totally downloaded. Restart Zync to apply the latest features and fixes.'}
                            {status === 'error' && (error || 'Something went wrong. Please try downloading manually.')}
                        </p>

                        {status === 'downloading' && (
                            <div className="h-1.5 w-full bg-app-surface rounded-full overflow-hidden mb-1">
                                <div
                                    className="h-full bg-app-accent transition-all duration-300 ease-out"
                                    style={{ width: `${progress}%` }}
                                />
                            </div>
                        )}

                        <div className="flex justify-end gap-2 mt-2">
                            {status === 'available' && (
                                <>
                                    <Button variant="ghost" size="sm" onClick={dismiss} className="text-app-muted hover:text-app-text">
                                        Later
                                    </Button>
                                    <Button size="sm" onClick={startDownload} className="bg-app-accent hover:bg-app-accent/90 text-white border-0 shadow-lg shadow-app-accent/20">
                                        {window.electronUtils.platform === 'darwin' ? 'Download from GitHub' : 'Download'}
                                    </Button>
                                </>
                            )}
                            {status === 'ready' && (
                                <Button size="sm" onClick={installUpdate} className="w-full bg-app-accent hover:bg-app-accent/90 text-white border-0 shadow-lg shadow-app-accent/20">
                                    Restart & Install
                                </Button>
                            )}
                            {status === 'error' && (
                                <Button size="sm" onClick={startDownload} className="w-full bg-app-surface hover:bg-app-surface-hover text-app-text border border-app-border">
                                    <ExternalLink size={14} className="mr-2" />
                                    Download Manually
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
