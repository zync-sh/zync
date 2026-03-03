import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Gift, ExternalLink, ChevronDown, Check, Copy, Tag } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useAppStore } from '../../store/useAppStore';

// ----- Types -----
interface GithubRelease {
    tag_name: string;
    name: string;
    published_at: string;
    body: string;
    html_url: string;
}

interface TocEntry {
    id: string;
    text: string;
    level: number;
}

// ----- Helpers -----
const SECTION_BADGES: Record<string, { label: string; color: string }> = {
    added: { label: '✦ Added', color: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
    fixed: { label: '⬤ Fixed', color: 'bg-red-500/15 text-red-400 border-red-500/30' },
    changed: { label: '◆ Changed', color: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
    security: { label: '🛡 Security', color: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' },
    enhancements: { label: '▲ Enhancements', color: 'bg-purple-500/15 text-purple-400 border-purple-500/30' },
    deprecated: { label: '⊘ Deprecated', color: 'bg-orange-500/15 text-orange-400 border-orange-500/30' },
    removed: { label: '✖ Removed', color: 'bg-red-700/15 text-red-500 border-red-700/30' },
};

function slugify(text: string, usedSlugs?: Map<string, number>) {
    const baseSlug = text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    if (!usedSlugs) return baseSlug;
    if (usedSlugs.has(baseSlug)) {
        const count = usedSlugs.get(baseSlug)! + 1;
        usedSlugs.set(baseSlug, count);
        return `${baseSlug}-${count}`;
    }
    usedSlugs.set(baseSlug, 0);
    return baseSlug;
}

function extractToc(markdown: string): TocEntry[] {
    const lines = markdown.split('\n');
    const entries: TocEntry[] = [];
    const usedSlugs = new Map<string, number>();
    let inFence = false;
    for (const line of lines) {
        if (/^\s*
}

function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ----- Code block with copy -----
function CodeBlock({ language, children }: { language?: string; children: string }) {
    const [copied, setCopied] = useState(false);
    const timeoutRef = useRef<number | null>(null);

    useEffect(() => {
        return () => {
            if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
        };
    }, []);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(children);
            setCopied(true);
            if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
            timeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy code to clipboard:', err);
        }
    };

    return (
        <div className="relative group my-4 rounded-lg overflow-hidden border border-[var(--color-app-border)]/50">
            <div className="flex items-center justify-between px-3 py-1.5 bg-[#1a1d23] border-b border-white/5">
                <span className="text-[10px] font-mono text-white/30 uppercase tracking-widest">{language || 'code'}</span>
                <button
                    onClick={copy}
                    className="flex items-center gap-1 text-[10px] text-white/40 hover:text-white/80 transition-colors"
                >
                    {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                    {copied ? 'Copied!' : 'Copy'}
                </button>
            </div>
            {language ? (
                <SyntaxHighlighter
                    language={language}
                    style={oneDark}
                    customStyle={{ margin: 0, borderRadius: 0, background: '#1a1d23', fontSize: '13px', padding: '16px' }}
                    showLineNumbers={children.split('\n').length > 4}
                    lineNumberStyle={{ color: '#ffffff20', minWidth: '2.5em' }}
                >
                    {children}
                </SyntaxHighlighter>
            ) : (
                <pre className="p-4 bg-[#1a1d23] text-sm font-mono text-white/70 overflow-x-auto">{children}</pre>
            )}
        </div>
    );
}

// ----- Markdown heading with badge override -----
function HeadingWithBadge({ level, children, slugMap }: { level: number; children: React.ReactNode; slugMap?: Map<string, number> }) {
    const text = (typeof children === 'string' ? children : '')
        || (Array.isArray(children) ? children.map(c => (typeof c === 'string' ? c : '')).join('') : '');
    const key = text.toLowerCase().replace(/[^a-z]/g, '');
    const badge = SECTION_BADGES[key];
    const id = slugify(text, slugMap);

    const inner = (
        <span className="flex items-center gap-2.5 scroll-mt-6 group">
            {badge ? (
                <span className={`inline-flex items-center px-2.5 py-1 rounded-md border text-sm font-semibold tracking-tight ${badge.color}`}>
                    {badge.label}
                </span>
            ) : (
                <span className="text-[var(--color-app-text)]">{children}</span>
            )}
            <a href={`#${id}`} className="opacity-0 group-hover:opacity-40 text-sm select-none hover:opacity-80 transition-opacity text-[var(--color-app-muted)]">#</a>
        </span>
    );

    if (level === 1) return <h1 id={id} className="text-2xl font-bold mt-8 mb-4">{inner}</h1>;
    if (level === 2) return <h2 id={id} className="text-lg font-bold mt-8 mb-4">{inner}</h2>;
    return <h3 id={id} className="text-base font-semibold mt-6 mb-3">{inner}</h3>;
}

// ----- Main Component -----
const ReleaseNotesTab: React.FC = () => {
    const [releases, setReleases] = useState<GithubRelease[]>([]);
    const [selected, setSelected] = useState<GithubRelease | null>(null);
    const [isLoadingList, setIsLoadingList] = useState(true);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [appVersion, setAppVersion] = useState('');
    const [toc, setToc] = useState<TocEntry[]>([]);
    const [activeSection, setActiveSection] = useState('');
    const contentRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const closeTab = useAppStore(state => state.closeTab);
    const tabs = useAppStore(state => state.tabs);
    const thisTab = tabs.find(t => t.type === 'release-notes');

    // Fetch release list & current app version
    useEffect(() => {
        const controller = new AbortController();
        const signal = controller.signal;
        let mounted = true;

        const run = async () => {
            setIsLoadingList(true);
            try {
                const [ver, res] = await Promise.all([
                    window.ipcRenderer.invoke('app:getVersion'),
                    fetch('https://api.github.com/repos/zync-sh/zync/releases?per_page=10', { signal })
                ]);
                if (!mounted) return;
                setAppVersion(ver);
                if (!res.ok) throw new Error('GitHub API error');
                const data: GithubRelease[] = await res.json();
                if (!mounted) return;
                setReleases(data);

                // Auto-select current version if available, else latest
                const match = data.find(r => r.tag_name === `v${ver}`) || data[0] || null;
                setSelected(match);
                if (match?.body) setToc(extractToc(match.body));
            } catch (err: any) {
                if (err.name === 'AbortError') return;
                console.error('Failed to fetch releases:', err);
                if (mounted) {
                    setSelected({ tag_name: '', name: 'Offline', published_at: '', body: 'Could not load release notes. Please check your internet connection or visit the [Releases page](https://github.com/zync-sh/zync/releases) directly.', html_url: 'https://github.com/zync-sh/zync/releases' });
                }
            } finally {
                if (mounted) setIsLoadingList(false);
            }
        };
        run();
        return () => {
            mounted = false;
            controller.abort();
        };
    }, []);

    // Update TOC when release changes
    useEffect(() => {
        setActiveSection('');
        setToc(selected?.body ? extractToc(selected.body) : []);
    }, [selected]);

    // Intersection observer for active TOC item
    useEffect(() => {
        if (!contentRef.current) return;
        const headings = contentRef.current.querySelectorAll('h1, h2, h3');
        const observer = new IntersectionObserver(
            entries => {
                for (const e of entries) {
                    if (e.isIntersecting) { setActiveSection(e.target.id); break; }
                }
            },
            { rootMargin: '-20px 0px -80% 0px' }
        );
        headings.forEach(h => { observer.observe(h); });
        return () => observer.disconnect();
    }, [selected]);

    const scrollToSection = useCallback((id: string) => {
        const target =
            contentRef.current?.querySelector<HTMLElement>(`[id="${id}"]`) ??
            document.getElementById(id);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, []);

    const currentRelease = selected;
    const headingSlugsMap = new Map<string, number>();

    return (
        <div className="flex flex-col h-full bg-[var(--color-app-bg)]">
            {/* ── Header ── */}
            <div className="flex items-center justify-between px-6 py-3.5 border-b border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)] shrink-0">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-[var(--color-app-accent)]/20 flex items-center justify-center text-[var(--color-app-accent)]">
                        <Gift size={16} />
                    </div>
                    <div>
                        <h1 className="text-sm font-semibold text-[var(--color-app-text)] leading-none">What&apos;s New in Zync</h1>
                        {currentRelease?.published_at && (
                            <p className="text-[10px] text-[var(--color-app-muted)] mt-0.5">{formatDate(currentRelease.published_at)}</p>
                        )}
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    {/* Version Dropdown */}
                    <div className="relative" ref={dropdownRef}>
                        <button
                            onClick={() => setIsDropdownOpen(v => !v)}
                            disabled={isLoadingList}
                            className="flex items-center gap-2 px-3 py-1.5 text-xs bg-[var(--color-app-bg)] border border-[var(--color-app-border)] rounded-md hover:border-[var(--color-app-accent)]/50 transition-colors disabled:opacity-50"
                        >
                            <Tag size={11} className="text-[var(--color-app-accent)]" />
                            <span className="text-[var(--color-app-text)] font-mono">{currentRelease?.tag_name || (isLoadingList ? 'Loading…' : 'Select')}</span>
                            <ChevronDown size={11} className={`text-[var(--color-app-muted)] transition-transform duration-200 ${isDropdownOpen ? 'rotate-180' : ''}`} />
                        </button>
                        {isDropdownOpen && (
                            <div className="absolute right-0 top-full mt-1.5 w-44 bg-[var(--color-app-surface)] border border-[var(--color-app-border)] rounded-lg shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
                                {releases.map(r => (
                                    <button
                                        key={r.tag_name}
                                        onClick={() => { setSelected(r); setIsDropdownOpen(false); contentRef.current?.scrollTo(0, 0); }}
                                        className={`w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-[var(--color-app-bg)] transition-colors ${r.tag_name === currentRelease?.tag_name ? 'text-[var(--color-app-accent)]' : 'text-[var(--color-app-text)]'}`}
                                    >
                                        <span className="font-mono">{r.tag_name}</span>
                                        {r.tag_name === `v${appVersion}` && (
                                            <span className="text-[9px] bg-[var(--color-app-accent)]/20 text-[var(--color-app-accent)] px-1.5 py-0.5 rounded-full">current</span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {currentRelease?.html_url && (
                        <a
                            href={currentRelease.html_url}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-[var(--color-app-muted)] hover:text-[var(--color-app-text)] border border-[var(--color-app-border)] hover:border-[var(--color-app-border)]/70 rounded-md transition-colors"
                        >
                            <ExternalLink size={11} />
                            GitHub
                        </a>
                    )}

                    {thisTab && (
                        <button
                            onClick={() => closeTab(thisTab.id)}
                            className="px-4 py-1.5 bg-[var(--color-app-accent)] hover:brightness-110 text-white text-xs font-medium rounded-md transition-all"
                        >
                            Got it!
                        </button>
                    )}
                </div>
            </div>

            {/* ── Body ── */}
            <div className="flex-1 flex overflow-hidden">
                {/* TOC Sidebar */}
                {toc.length > 1 && (
                    <aside className="w-52 shrink-0 border-r border-[var(--color-app-border)]/40 bg-[var(--color-app-surface)]/40 overflow-y-auto custom-scrollbar py-5 px-3 hidden md:block">
                        <p className="text-[9px] uppercase tracking-widest text-[var(--color-app-muted)]/60 font-semibold mb-3 px-1">On this page</p>
                        {toc.map(entry => (
                            <button
                                key={entry.id}
                                onClick={() => scrollToSection(entry.id)}
                                className={`block w-full text-left text-xs leading-snug py-1 px-2 rounded-md transition-colors truncate
                                    ${entry.level === 1 ? 'font-semibold' : entry.level === 2 ? 'pl-3 font-medium' : 'pl-5 text-[11px]'}
                                    ${activeSection === entry.id
                                        ? 'text-[var(--color-app-accent)] bg-[var(--color-app-accent)]/10'
                                        : 'text-[var(--color-app-muted)] hover:text-[var(--color-app-text)] hover:bg-[var(--color-app-bg)]/70'}`}
                            >
                                {entry.text}
                            </button>
                        ))}
                    </aside>
                )}

                {/* Content */}
                <div ref={contentRef} className="flex-1 overflow-y-auto custom-scrollbar">
                    {isLoadingList ? (
                        <div className="flex flex-col items-center justify-center h-full gap-4 text-[var(--color-app-muted)]">
                            <div className="w-6 h-6 border-2 border-[var(--color-app-accent)] border-t-transparent rounded-full animate-spin" />
                            <span className="text-sm animate-pulse">Fetching release notes…</span>
                        </div>
                    ) : (
                        <div className="max-w-2xl mx-auto px-8 py-8">
                            {/* Hero */}
                            <div className="mb-8 pb-6 border-b border-[var(--color-app-border)]/40">
                                <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[var(--color-app-accent)]/10 border border-[var(--color-app-accent)]/20 mb-3">
                                    <span className="text-[10px] font-semibold text-[var(--color-app-accent)] uppercase tracking-wider">Release</span>
                                    <span className="text-[10px] font-mono text-[var(--color-app-accent)]">{currentRelease?.tag_name}</span>
                                </div>
                                <h2 className="text-3xl font-bold text-[var(--color-app-text)] mb-1">{currentRelease?.name || currentRelease?.tag_name}</h2>
                                {currentRelease?.published_at && (
                                    <p className="text-sm text-[var(--color-app-muted)]">{formatDate(currentRelease.published_at)}</p>
                                )}
                            </div>

                            {/* Markdown body */}
                            <div className="text-sm leading-relaxed text-[var(--color-app-text)]/90">
                                <ReactMarkdown
                                    components={{
                                        h1: ({ children }) => <HeadingWithBadge level={1} slugMap={headingSlugsMap}>{children}</HeadingWithBadge>,
                                        h2: ({ children }) => <HeadingWithBadge level={2} slugMap={headingSlugsMap}>{children}</HeadingWithBadge>,
                                        h3: ({ children }) => <HeadingWithBadge level={3} slugMap={headingSlugsMap}>{children}</HeadingWithBadge>,
                                        code({ node, className, children, ...props }) {
                                            const match = /language-(\w+)/.exec(className || '');
                                            const isParentPre = (node as any)?.parent?.type === 'element' && (node as any)?.parent?.tagName === 'pre';
                                            return isParentPre || match ? (
                                                <CodeBlock language={match?.[1]}>{String(children).replace(/\n$/, '')}</CodeBlock>
                                            ) : (
                                                <code className="bg-[var(--color-app-surface)] border border-[var(--color-app-border)]/50 px-1.5 py-0.5 rounded text-[12px] font-mono text-[var(--color-app-accent)]" {...props}>{children}</code>
                                            );
                                        },
                                        p: ({ children }) => <p className="mb-3.5 leading-relaxed">{children}</p>,
                                        ul: ({ children }) => <ul className="list-disc pl-5 mb-4 space-y-1.5">{children}</ul>,
                                        ol: ({ children }) => <ol className="list-decimal pl-5 mb-4 space-y-1.5">{children}</ol>,
                                        li: ({ children }) => <li className="text-[var(--color-app-text)]/85">{children}</li>,
                                        a: ({ href, children }) => (
                                            <a href={href} target="_blank" rel="noreferrer" className="text-[var(--color-app-accent)] hover:underline">{children}</a>
                                        ),
                                        blockquote: ({ children }) => (
                                            <blockquote className="border-l-2 border-[var(--color-app-accent)]/50 pl-4 my-4 italic text-[var(--color-app-muted)]">{children}</blockquote>
                                        ),
                                        hr: () => <hr className="border-[var(--color-app-border)]/40 my-8" />,
                                        table: ({ children }) => (
                                            <div className="overflow-x-auto my-4 rounded-lg border border-[var(--color-app-border)]/50">
                                                <table className="w-full text-sm">{children}</table>
                                            </div>
                                        ),
                                        th: ({ children }) => <th className="text-left py-2.5 px-4 bg-[var(--color-app-surface)] font-semibold text-[var(--color-app-muted)] text-xs uppercase tracking-wide border-b border-[var(--color-app-border)]/50">{children}</th>,
                                        td: ({ children }) => <td className="py-2.5 px-4 border-b border-[var(--color-app-border)]/30 text-[var(--color-app-text)]/85">{children}</td>,
                                    }}
                                >
                                    {currentRelease?.body || ''}
                                </ReactMarkdown>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ReleaseNotesTab;
