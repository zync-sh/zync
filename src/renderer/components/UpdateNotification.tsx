import { useEffect, useState } from 'react';
import { RefreshCw, Download, AlertTriangle } from 'lucide-react';
import { Button } from './ui/Button';

export function UpdateNotification() {
    const [status, setStatus] = useState<'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'>('idle');
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState('');
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        const onUpdateAvailable = () => {
            setStatus('available');
            setIsVisible(true);
        };
        const onUpdateProgress = (_: any, p: any) => {
            setStatus('downloading');
            setProgress(p.percent);
            setIsVisible(true);
        };
        const onUpdateDownloaded = () => {
            setStatus('ready');
            setIsVisible(true);
        };
        const onUpdateError = (_: any, message: string) => {
            setStatus('error');
            setError(message);
            setIsVisible(true);
        };

        window.ipcRenderer.on('update:available', onUpdateAvailable);
        window.ipcRenderer.on('update:progress', onUpdateProgress);
        window.ipcRenderer.on('update:downloaded', onUpdateDownloaded);
        window.ipcRenderer.on('update:error', onUpdateError);

        return () => {
            window.ipcRenderer.off('update:available', onUpdateAvailable);
            window.ipcRenderer.off('update:progress', onUpdateProgress);
            window.ipcRenderer.off('update:downloaded', onUpdateDownloaded);
            window.ipcRenderer.off('update:error', onUpdateError);
        };
    }, []);

    const installUpdate = () => {
        window.ipcRenderer.invoke('update:install');
    };

    const dismiss = () => {
        setIsVisible(false);
    };

    if (!isVisible || status === 'idle' || status === 'checking') return null;

    return (
        <div className="fixed bottom-6 right-6 z-100 max-w-sm w-full animate-in slide-in-from-bottom-5 duration-300">
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
                                {status === 'available' && 'Update Available'}
                                {status === 'downloading' && 'Downloading Update...'}
                                {status === 'ready' && 'Ready to Install'}
                                {status === 'error' && 'Update Failed'}
                            </h4>
                            <button onClick={dismiss} className="text-app-muted hover:text-app-text transition-colors p-0.5 rounded-md hover:bg-app-surface">
                                <span className="sr-only">Dismiss</span>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                            </button>
                        </div>

                        <p className="text-xs text-app-muted mb-3 leading-relaxed">
                            {status === 'available' && 'A new version of Zync is available. Downloading now in the background.'}
                            {status === 'downloading' && `${Math.round(progress)}% downloaded. You can keep working while we prepare the update.`}
                            {status === 'ready' && 'Create a fresh start. Restart Zync to apply the latest features and fixes.'}
                            {status === 'error' && (error || 'Something went wrong while updating. Please try again later.')}
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
                            {status === 'ready' && (
                                <Button size="sm" onClick={installUpdate} className="w-full bg-app-accent hover:bg-app-accent/90 text-white border-0 shadow-lg shadow-app-accent/20">
                                    Restart & Install
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
