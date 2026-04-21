import { AlertTriangle, Check, ChevronRight, Download, Gift, RefreshCw, Star } from 'lucide-react';
import type { ReactNode } from 'react';
import type { UpdateInfo, UpdateStatus } from '../../../store/updateSlice';
import type { Contributor } from '../hooks/useAboutStats';

interface AboutTabProps {
    appVersion: string;
    platformLabel: string;
    updateStatus: UpdateStatus;
    updateInfo: UpdateInfo | null;
    canAutoUpdate: boolean;
    stars: number | null;
    contributors: Contributor[];
    onUpdateAction: () => void;
    onOpenReleaseNotes: () => void;
    openExternal: (url: string) => void;
    hero: ReactNode;
}

function LinkButton({
    onClick,
    children,
}: {
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button
            onClick={onClick}
            className="px-3 py-1.5 rounded-full text-xs font-medium text-[var(--color-app-muted)] hover:text-[var(--color-app-text)] bg-[var(--color-app-surface)]/50 hover:bg-[var(--color-app-surface)] border border-[var(--color-app-border)]/50 transition-all"
        >
            {children}
        </button>
    );
}

export function AboutTab({
    appVersion,
    platformLabel,
    updateStatus,
    updateInfo,
    canAutoUpdate,
    stars,
    contributors,
    onUpdateAction,
    onOpenReleaseNotes,
    openExternal,
    hero
}: AboutTabProps) {
    return (
        <div className="flex flex-col items-center justify-start min-h-full pt-12 pb-10 px-4 animate-in fade-in duration-300">
            <div className="mb-8">{hero}</div>

            <div className="w-full max-w-[280px] rounded-xl border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/30 p-4 shadow-sm">
                <div className="flex items-center justify-center gap-2 mb-4">
                    <span className="text-sm font-mono font-medium text-[var(--color-app-text)]">v{appVersion}</span>
                    <span className="w-1 h-1 rounded-full bg-[var(--color-app-muted)]/60" />
                    <span className="text-xs text-[var(--color-app-muted)]">{platformLabel}</span>
                </div>
                <button
                    onClick={onUpdateAction}
                    disabled={updateStatus === 'checking' || (canAutoUpdate && updateStatus === 'downloading')}
                    className={`
                        flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg text-sm font-medium transition-all
                        ${updateStatus === 'available'
                            ? 'bg-[var(--color-app-accent)] text-white hover:opacity-90 shadow-md shadow-[var(--color-app-accent)]/25'
                            : 'bg-[var(--color-app-bg)] text-[var(--color-app-text)] border border-[var(--color-app-border)] hover:border-[var(--color-app-accent)]/50'
                        }
                        disabled:opacity-50 disabled:cursor-not-allowed
                    `}
                >
                    <div className={`shrink-0 ${updateStatus === 'checking' ? 'animate-spin' : ''}`}>
                        {updateStatus === 'checking' && <RefreshCw size={14} />}
                        {updateStatus === 'idle' && <RefreshCw size={14} />}
                        {updateStatus === 'available' && <Download size={14} />}
                        {updateStatus === 'downloading' && <RefreshCw size={14} className="animate-spin" />}
                        {updateStatus === 'ready' && <Download size={14} />}
                        {updateStatus === 'not-available' && <Check size={14} />}
                        {updateStatus === 'error' && <AlertTriangle size={14} />}
                    </div>
                    <span>
                        {updateStatus === 'idle' && 'Check for Updates'}
                        {updateStatus === 'checking' && 'Checking...'}
                        {updateStatus === 'available' && 'Download Update'}
                        {updateStatus === 'downloading' && 'Downloading...'}
                        {updateStatus === 'ready' && 'Install & Restart'}
                        {updateStatus === 'not-available' && 'Up to date'}
                        {updateStatus === 'error' && 'Check Failed'}
                    </span>
                </button>
                {updateStatus === 'available' && updateInfo?.version && (
                    <p className="text-center text-xs text-[var(--color-app-accent)] font-medium mt-2">
                        v{updateInfo.version} available
                    </p>
                )}
                <button
                    onClick={onOpenReleaseNotes}
                    className="mt-3 w-full flex items-center justify-center gap-1.5 py-2 text-xs text-[var(--color-app-muted)] hover:text-[var(--color-app-accent)] transition-colors rounded-md hover:bg-[var(--color-app-surface)]/50"
                >
                    <Gift size={12} />
                    <span>What&apos;s New in v{appVersion}?</span>
                    <ChevronRight size={12} className="transition-transform duration-200" />
                </button>
            </div>

            <div className="w-full max-w-[320px] mt-6">
                <p className="text-[10px] uppercase tracking-widest text-[var(--color-app-muted)]/80 mb-3 text-center font-medium">Links</p>
                <div className="flex flex-wrap justify-center gap-2">
                    <button
                        onClick={() => openExternal('https://github.com/zync-sh/zync')}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-[var(--color-app-muted)] hover:text-[var(--color-app-text)] bg-[var(--color-app-surface)]/50 hover:bg-[var(--color-app-surface)] border border-[var(--color-app-border)]/50 transition-all"
                    >
                        <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>
                        GitHub
                        {stars !== null && (
                            <span className="inline-flex items-center gap-0.5 bg-[var(--color-app-bg)]/80 px-1.5 py-0.5 rounded-full text-[10px] border border-[var(--color-app-border)]/50">
                                <Star size={8} fill="currentColor" className="text-amber-400 shrink-0" />
                                {stars > 1000 ? `${(stars / 1000).toFixed(1)}k` : stars}
                            </span>
                        )}
                    </button>
                    <LinkButton onClick={() => openExternal('https://zync.thesudoer.in')}>Website</LinkButton>
                    <LinkButton onClick={() => openExternal('https://github.com/zync-sh/zync/blob/main/CHANGELOG.md')}>Changelog</LinkButton>
                    <LinkButton onClick={() => openExternal('https://github.com/zync-sh/zync/blob/main/PLUGIN_CATALOG.md')}>Extensions</LinkButton>
                    <LinkButton onClick={() => openExternal('https://opensource.org/licenses/MIT')}>License</LinkButton>
                    <LinkButton onClick={() => openExternal('https://github.com/zync-sh/zync/issues/new')}>Report Issue</LinkButton>
                </div>
            </div>

            <div className="mt-8 w-full max-w-[300px] rounded-xl border border-[var(--color-app-border)]/40 bg-[var(--color-app-surface)]/20 p-4">
                <p className="text-[10px] uppercase tracking-widest text-[var(--color-app-muted)]/80 mb-3 text-center font-medium">Contributors</p>
                <div className="flex flex-wrap justify-center gap-2">
                    {contributors.map((c) => (
                        <a
                            key={c.id}
                            href={c.html_url}
                            onClick={(e) => { e.preventDefault(); openExternal(c.html_url); }}
                            className="relative block rounded-full ring-2 ring-transparent hover:ring-[var(--color-app-accent)]/50 transition-all hover:scale-110 focus:outline-none focus:ring-2 focus:ring-[var(--color-app-accent)]/50"
                            title={c.login}
                        >
                            <img
                                src={c.avatar_url}
                                alt={c.login}
                                className="w-9 h-9 rounded-full border border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)] object-cover grayscale hover:grayscale-0 transition-all"
                            />
                        </a>
                    ))}
                </div>
            </div>

            <p className="mt-8 text-[11px] text-[var(--color-app-muted)]/50 font-medium">© 2026 Zync - MIT License</p>
        </div>
    );
}
