import React, { useEffect, useState } from 'react';
import { X, Gift } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useAppStore } from '../../store/useAppStore';

const ReleaseNotesModal: React.FC = () => {
    const isReleaseNotesModalOpen = useAppStore(state => state.isReleaseNotesModalOpen);
    const setReleaseNotesModalOpen = useAppStore(state => state.setReleaseNotesModalOpen);

    // We get the app version that we just updated to
    const [appVersion, setAppVersion] = useState<string>('');
    const [releaseNotes, setReleaseNotes] = useState<string>('');
    const [isLoading, setIsLoading] = useState<boolean>(true);

    useEffect(() => {
        if (!isReleaseNotesModalOpen) return;

        const loadContent = async () => {
            setIsLoading(true);
            try {
                // Fetch current app version
                const ver = await window.ipcRenderer.invoke('app:getVersion');
                setAppVersion(ver);

                // Fetch release notes from GitHub
                const response = await fetch(`https://api.github.com/repos/zync-sh/zync/releases/tags/v${ver}`);
                if (!response.ok) throw new Error('Release not found');

                const data = await response.json();
                if (data.body) {
                    setReleaseNotes(data.body);
                } else {
                    setReleaseNotes('No release notes available for this version.');
                }
            } catch (error) {
                console.error('Failed to load release notes:', error);
                setReleaseNotes('Could not load release notes from GitHub. Please check your internet connection or visit the repository directly.');
            } finally {
                setIsLoading(false);
            }
        };

        loadContent();
    }, [isReleaseNotesModalOpen]);


    if (!isReleaseNotesModalOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="w-[800px] h-[80vh] bg-[var(--color-app-bg)]/95 border border-[var(--color-app-border)] shadow-2xl rounded-xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
                {/* Header */}
                <div className="flex justify-between items-center px-6 py-4 border-b border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)]">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-[var(--color-app-accent)]/20 flex items-center justify-center text-[var(--color-app-accent)]">
                            <Gift size={20} />
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-[var(--color-app-text)]">What&apos;s New in Zync</h2>
                            {appVersion && <p className="text-xs text-[var(--color-app-muted)]">Version {appVersion}</p>}
                        </div>
                    </div>
                    <button
                        onClick={() => setReleaseNotesModalOpen(false)}
                        className="p-2 -mr-2 text-[var(--color-app-muted)] hover:text-red-400 hover:bg-red-400/10 rounded-md transition-colors"
                        title="Close (Esc)"
                    >
                        <X size={20} />
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-8 bg-[var(--color-app-bg)]">
                    <div className="max-w-prose mx-auto">
                        {isLoading ? (
                            <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-[var(--color-app-muted)] gap-4">
                                <div className="w-6 h-6 border-2 border-[var(--color-app-accent)] border-t-transparent flex-shrink-0 rounded-full animate-spin"></div>
                                <span className="text-sm font-medium animate-pulse">Loading release notes...</span>
                            </div>
                        ) : (
                            <div className="prose prose-invert prose-sm max-w-none text-[var(--color-app-text)] 
                                [&>ul]:list-disc [&>ul]:pl-5 [&>ul>li]:mb-1 [&>ol]:list-decimal [&>ol]:pl-5 [&>ol>li]:mb-1 
                                [&>h1]:text-2xl [&>h1]:font-bold [&>h1]:mb-6 [&>h1]:text-[var(--color-app-text)]
                                [&>h2]:text-lg [&>h2]:font-bold [&>h2]:mt-8 [&>h2]:mb-4 [&>h2]:text-[var(--color-app-text)]
                                [&>h3]:text-base [&>h3]:font-semibold [&>h3]:mt-6 [&>h3]:mb-3 [&>h3]:text-[var(--color-app-text)]
                                [&>p]:mb-4 [&>p]:leading-relaxed
                                [&>a]:text-[var(--color-app-accent)] [&>a]:no-underline hover:[&>a]:underline
                                [&>blockquote]:border-l-4 [&>blockquote]:border-[var(--color-app-accent)]/50 [&>blockquote]:pl-4 [&>blockquote]:italic [&>blockquote]:text-[var(--color-app-muted)]
                                [&_code]:bg-[var(--color-app-surface)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded text-[13px]
                                [&>hr]:border-[var(--color-app-border)] [&>hr]:my-8">
                                <ReactMarkdown>{releaseNotes}</ReactMarkdown>
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="px-6 py-4 border-t border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)] flex justify-end">
                    <button
                        onClick={() => setReleaseNotesModalOpen(false)}
                        className="px-6 py-2 bg-[var(--color-app-accent)] hover:bg-[var(--color-app-accent-hover)] text-white text-sm font-medium rounded-md transition-colors"
                    >
                        Awesome, let&apos;s go!
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ReleaseNotesModal;
