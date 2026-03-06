import React, { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Gift, ExternalLink, ChevronDown, Check, Copy, Tag } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useAppStore } from '../../store/useAppStore';

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
    level: 1 | 2 | 3;
}

const SECTION_BADGES: Record<string, { label: string; color: string }> = {
    added: { label: '+ Added', color: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
    fixed: { label: '! Fixed', color: 'bg-red-500/15 text-red-400 border-red-500/30' },
    changed: { label: '* Changed', color: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
    security: { label: 'Security', color: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' },
    enhancements: { label: 'Enhancements', color: 'bg-purple-500/15 text-purple-400 border-purple-500/30' },
    deprecated: { label: 'Deprecated', color: 'bg-orange-500/15 text-orange-400 border-orange-500/30' },
    removed: { label: 'Removed', color: 'bg-red-700/15 text-red-500 border-red-700/30' }
};

function normalizeHeadingText(text: string): string {
    return text
        .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function headingKey(text: string): string {
    return normalizeHeadingText(text).toLowerCase().replace(/[^a-z]/g, '');
}

function slugify(text: string, usedSlugs: Map<string, number>): string {
    const normalized = normalizeHeadingText(text)
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    const baseSlug = normalized || 'section';

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
    const usedSlugs = new Map<string, number>();
    const entries: TocEntry[] = [];
    let inFence = false;

    for (const line of lines) {
        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;

        const m = line.match(/^(#{1,3})\s+(.+)/);
        if (!m) continue;

        const level = m[1].length as 1 | 2 | 3;
        const text = normalizeHeadingText(m[2]);
        if (!text) continue;

        entries.push({
            level,
            text,
            id: slugify(text, usedSlugs)
        });
    }

    return entries;
}

function formatDate(iso: string): string {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

function getNodeText(node: ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(getNodeText).join('');
    if (React.isValidElement<{ children?: ReactNode }>(node)) return getNodeText(node.props.children);
    return '';
}

function CodeBlock({ language, children, isLightTheme }: { language?: string; children: string; isLightTheme: boolean }) {
    const [copied, setCopied] = useState(false);
    const timeoutRef = useRef<number | null>(null);

    useEffect(() => {
        return () => {
            if (timeoutRef.current !== null) {
                window.clearTimeout(timeoutRef.current);
            }
        };
    }, []);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(children);
            setCopied(true);
            if (timeoutRef.current !== null) {
                window.clearTimeout(timeoutRef.current);
            }
            timeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy code to clipboard:', err);
        }
    };

    return (
        <div className="relative my-4 overflow-hidden rounded-lg border border-[var(--color-app-border)]/50">
            <div className="flex items-center justify-between border-b border-[var(--color-app-border)]/60 bg-[var(--color-app-surface)]/70 px-3 py-1.5">
                <span className="text-[10px] font-mono uppercase tracking-widest text-[var(--color-app-muted)]">
                    {language || 'code'}
                </span>
                <button
                    onClick={copy}
                    className="flex items-center gap-1 text-[10px] text-[var(--color-app-muted)] transition-colors hover:text-[var(--color-app-text)]"
                >
                    {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                    {copied ? 'Copied!' : 'Copy'}
                </button>
            </div>

            <SyntaxHighlighter
                language={language}
                style={isLightTheme ? oneLight : oneDark}
                customStyle={{
                    margin: 0,
                    borderRadius: 0,
                    background: 'var(--color-app-panel)',
                    fontSize: '13px',
                    padding: '14px 16px'
                }}
                codeTagProps={{
                    style: { fontFamily: 'var(--font-mono)' }
                }}
                showLineNumbers={children.split('\n').length > 4}
                lineNumberStyle={{ color: 'var(--color-app-muted)', minWidth: '2.5em', opacity: 0.6 }}
                wrapLongLines
            >
                {children}
            </SyntaxHighlighter>
        </div>
    );
}

const ReleaseNotesTab: React.FC = () => {
    const [releases, setReleases] = useState<GithubRelease[]>([]);
    const [selected, setSelected] = useState<GithubRelease | null>(null);
    const [isLoadingList, setIsLoadingList] = useState(true);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [appVersion, setAppVersion] = useState('');
    const [activeSection, setActiveSection] = useState('');

    const contentRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    const closeTab = useAppStore(state => state.closeTab);
    const tabs = useAppStore(state => state.tabs);
    const themeSetting = useAppStore(state => state.settings.theme);
    const thisTab = tabs.find(t => t.type === 'release-notes');

    const resolvedTheme = useMemo(() => {
        if (themeSetting !== 'system') return themeSetting;
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }, [themeSetting]);

    const isLightTheme = resolvedTheme === 'light' || resolvedTheme === 'light-warm';

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsDropdownOpen(false);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

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
                const match = data.find(r => r.tag_name === `v${ver}`) || data[0] || null;
                setSelected(match);
            } catch (err: any) {
                if (err.name === 'AbortError') return;
                console.error('Failed to fetch releases:', err);
                if (mounted) {
                    setSelected({
                        tag_name: '',
                        name: 'Offline',
                        published_at: '',
                        body: 'Could not load release notes. Please check your internet connection or visit the [Releases page](https://github.com/zync-sh/zync/releases) directly.',
                        html_url: 'https://github.com/zync-sh/zync/releases'
                    });
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

    const currentRelease = selected;
    const markdownBody = currentRelease?.body || '';

    const toc = useMemo(() => extractToc(markdownBody), [markdownBody]);

    useEffect(() => {
        setActiveSection('');
    }, [markdownBody]);

    useEffect(() => {
        if (!contentRef.current) return;

        const headings = contentRef.current.querySelectorAll('h1, h2, h3');
        const observer = new IntersectionObserver(
            entries => {
                for (const e of entries) {
                    if (e.isIntersecting) {
                        setActiveSection(e.target.id);
                        break;
                    }
                }
            },
            { rootMargin: '-20px 0px -80% 0px' }
        );

        headings.forEach(h => observer.observe(h));
        return () => observer.disconnect();
    }, [markdownBody, toc]);

    const scrollToSection = useCallback((id: string) => {
        const target =
            contentRef.current?.querySelector<HTMLElement>(`[id="${id}"]`) ??
            document.getElementById(id);

        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, []);

    let headingRenderIndex = 0;
    const fallbackSlugMap = new Map<string, number>();

    const resolveHeadingId = (level: 1 | 2 | 3, text: string): string => {
        while (headingRenderIndex < toc.length) {
            const entry = toc[headingRenderIndex];
            headingRenderIndex += 1;
            if (entry.level === level) {
                return entry.id;
            }
        }

        return slugify(text, fallbackSlugMap);
    };

    const renderHeading = (level: 1 | 2 | 3, children: ReactNode) => {
        const text = getNodeText(children);
        const id = resolveHeadingId(level, text);
        const badge = SECTION_BADGES[headingKey(text)];

        const inner = (
            <span className="group flex items-center gap-2.5 scroll-mt-6">
                {badge ? (
                    <span className={`inline-flex items-center rounded-md border px-2.5 py-1 text-sm font-semibold tracking-tight ${badge.color}`}>
                        {badge.label}
                    </span>
                ) : (
                    <span className="text-[var(--color-app-text)]">{children}</span>
                )}
                <a
                    href={`#${id}`}
                    className="select-none text-sm text-[var(--color-app-muted)] opacity-0 transition-opacity hover:opacity-80 group-hover:opacity-40"
                >
                    #
                </a>
            </span>
        );

        if (level === 1) return <h1 id={id} className="mb-3 mt-6 text-2xl font-bold first:mt-0">{inner}</h1>;
        if (level === 2) return <h2 id={id} className="mb-3 mt-6 text-xl font-bold first:mt-0">{inner}</h2>;
        return <h3 id={id} className="mb-2 mt-4 text-lg font-semibold first:mt-0">{inner}</h3>;
    };

    return (
        <div className="flex h-full flex-col bg-[var(--color-app-bg)]">
            <div className="shrink-0 border-b border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)] px-6 py-3.5">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-app-accent)]/20 text-[var(--color-app-accent)]">
                            <Gift size={16} />
                        </div>
                        <div>
                            <h1 className="text-sm font-semibold leading-none text-[var(--color-app-text)]">What's New in Zync</h1>
                            {currentRelease?.published_at && (
                                <p className="mt-0.5 text-[10px] text-[var(--color-app-muted)]">{formatDate(currentRelease.published_at)}</p>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <div className="relative" ref={dropdownRef}>
                            <button
                                onClick={() => setIsDropdownOpen(v => !v)}
                                disabled={isLoadingList}
                                className="flex items-center gap-2 rounded-md border border-[var(--color-app-border)] bg-[var(--color-app-bg)] px-3 py-1.5 text-xs transition-colors hover:border-[var(--color-app-accent)]/50 disabled:opacity-50"
                            >
                                <Tag size={11} className="text-[var(--color-app-accent)]" />
                                <span className="font-mono text-[var(--color-app-text)]">
                                    {currentRelease?.tag_name || (isLoadingList ? 'Loading...' : 'Select')}
                                </span>
                                <ChevronDown size={11} className={`text-[var(--color-app-muted)] transition-transform duration-200 ${isDropdownOpen ? 'rotate-180' : ''}`} />
                            </button>

                            {isDropdownOpen && (
                                <div className="animate-in slide-in-from-top-1 absolute right-0 top-full z-50 mt-1.5 w-44 overflow-hidden rounded-lg border border-[var(--color-app-border)] bg-[var(--color-app-surface)] shadow-2xl fade-in duration-150">
                                    {releases.map(r => (
                                        <button
                                            key={r.tag_name}
                                            onClick={() => {
                                                setSelected(r);
                                                setIsDropdownOpen(false);
                                                contentRef.current?.scrollTo(0, 0);
                                            }}
                                            className={`w-full px-3 py-2 text-xs transition-colors hover:bg-[var(--color-app-bg)] ${r.tag_name === currentRelease?.tag_name ? 'text-[var(--color-app-accent)]' : 'text-[var(--color-app-text)]'}`}
                                        >
                                            <div className="flex items-center justify-between">
                                                <span className="font-mono">{r.tag_name}</span>
                                                {r.tag_name === `v${appVersion}` && (
                                                    <span className="rounded-full bg-[var(--color-app-accent)]/20 px-1.5 py-0.5 text-[9px] text-[var(--color-app-accent)]">
                                                        current
                                                    </span>
                                                )}
                                            </div>
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
                                className="flex items-center gap-1.5 rounded-md border border-[var(--color-app-border)] px-3 py-1.5 text-xs text-[var(--color-app-muted)] transition-colors hover:border-[var(--color-app-border)]/70 hover:text-[var(--color-app-text)]"
                            >
                                <ExternalLink size={11} />
                                GitHub
                            </a>
                        )}

                        {thisTab && (
                            <button
                                onClick={() => closeTab(thisTab.id)}
                                className="rounded-md bg-[var(--color-app-accent)] px-4 py-1.5 text-xs font-medium text-white transition-all hover:brightness-110"
                            >
                                Got it!
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <div className="flex flex-1 overflow-hidden">
                {toc.length > 1 && (
                    <aside className="custom-scrollbar hidden w-52 shrink-0 overflow-y-auto border-r border-[var(--color-app-border)]/40 bg-[var(--color-app-surface)]/40 px-3 py-5 md:block">
                        <p className="mb-3 px-1 text-[9px] font-semibold uppercase tracking-widest text-[var(--color-app-muted)]/60">
                            On this page
                        </p>
                        {toc.map(entry => (
                            <button
                                key={entry.id}
                                onClick={() => scrollToSection(entry.id)}
                                className={`block w-full truncate rounded-md px-2 py-1 text-left text-xs leading-snug transition-colors ${entry.level === 1 ? 'font-semibold' : entry.level === 2 ? 'pl-3 font-medium' : 'pl-5 text-[11px]'} ${activeSection === entry.id ? 'bg-[var(--color-app-accent)]/10 text-[var(--color-app-accent)]' : 'text-[var(--color-app-muted)] hover:bg-[var(--color-app-bg)]/70 hover:text-[var(--color-app-text)]'}`}
                            >
                                {entry.text}
                            </button>
                        ))}
                    </aside>
                )}

                <div ref={contentRef} className="custom-scrollbar flex-1 overflow-y-auto">
                    {isLoadingList ? (
                        <div className="flex h-full flex-col items-center justify-center gap-4 text-[var(--color-app-muted)]">
                            <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--color-app-accent)] border-t-transparent" />
                            <span className="text-sm animate-pulse">Fetching release notes...</span>
                        </div>
                    ) : (
                        <div className="mx-auto max-w-2xl px-8 py-6">
                            <div className="mb-8 border-b border-[var(--color-app-border)]/40 pb-6">
                                <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[var(--color-app-accent)]/20 bg-[var(--color-app-accent)]/10 px-2.5 py-1">
                                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-app-accent)]">Release</span>
                                    <span className="font-mono text-[10px] text-[var(--color-app-accent)]">{currentRelease?.tag_name}</span>
                                </div>
                                <h2 className="mb-1 text-3xl font-bold text-[var(--color-app-text)]">{currentRelease?.name || currentRelease?.tag_name}</h2>
                                {currentRelease?.published_at && (
                                    <p className="text-sm text-[var(--color-app-muted)]">{formatDate(currentRelease.published_at)}</p>
                                )}
                            </div>

                            <div className="text-sm leading-7 text-[var(--color-app-text)]/90">
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    skipHtml
                                    components={{
                                        h1: ({ children }) => renderHeading(1, children),
                                        h2: ({ children }) => renderHeading(2, children),
                                        h3: ({ children }) => renderHeading(3, children),
                                        code({ className, children }) {
                                            const language = /language-([\w-]+)/.exec(className || '')?.[1];
                                            const codeContent = String(children).replace(/\n$/, '');
                                            const isBlock = Boolean(language) || codeContent.includes('\n');

                                            return isBlock ? (
                                                <CodeBlock language={language} isLightTheme={isLightTheme}>
                                                    {codeContent}
                                                </CodeBlock>
                                            ) : (
                                                <code className="rounded border border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--color-app-accent)]">
                                                    {children}
                                                </code>
                                            );
                                        },
                                        p: ({ children }) => <p className="mb-3 leading-7">{children}</p>,
                                        ul: ({ children }) => <ul className="mb-3 list-disc space-y-0.5 pl-5">{children}</ul>,
                                        ol: ({ children }) => <ol className="mb-3 list-decimal space-y-0.5 pl-5">{children}</ol>,
                                        li: ({ children }) => <li className="text-[var(--color-app-text)]/90 leading-7">{children}</li>,
                                        a: ({ href, children }) => {
                                            if (!href) return <span>{children}</span>;
                                            const internal = href.startsWith('#');
                                            return (
                                                <a
                                                    href={href}
                                                    target={internal ? undefined : '_blank'}
                                                    rel={internal ? undefined : 'noreferrer'}
                                                    className="text-[var(--color-app-accent)] hover:underline"
                                                >
                                                    {children}
                                                </a>
                                            );
                                        },
                                        blockquote: ({ children }) => (
                                            <blockquote className="my-3 border-l-2 border-[var(--color-app-accent)]/50 pl-4 italic text-[var(--color-app-muted)]">
                                                {children}
                                            </blockquote>
                                        ),
                                        hr: () => <hr className="my-5 border-[var(--color-app-border)]/40" />,
                                        table: ({ children }) => (
                                            <div className="my-3 overflow-x-auto rounded-lg border border-[var(--color-app-border)]/50">
                                                <table className="w-full text-sm">{children}</table>
                                            </div>
                                        ),
                                        th: ({ children }) => (
                                            <th className="border-b border-[var(--color-app-border)]/50 bg-[var(--color-app-surface)] px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-[var(--color-app-muted)]">
                                                {children}
                                            </th>
                                        ),
                                        td: ({ children }) => (
                                            <td className="border-b border-[var(--color-app-border)]/30 px-4 py-2.5 text-[var(--color-app-text)]/90">
                                                {children}
                                            </td>
                                        )
                                    }}
                                >
                                    {markdownBody}
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