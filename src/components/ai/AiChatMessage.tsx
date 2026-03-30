import { memo, useCallback } from 'react';
import { Copy, Play, ShieldCheck, ShieldAlert, AlertTriangle, Terminal, Bot, User, AlertCircle } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { AiDisplayEntry } from '../../store/aiSlice';

interface AiChatMessageProps {
    entry: AiDisplayEntry;
    onRunCommand?: (command: string) => void;
}

const SAFETY_CONFIG = {
    safe: {
        label: 'SAFE',
        icon: ShieldCheck,
        cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    },
    moderate: {
        label: 'MODERATE',
        icon: ShieldAlert,
        cls: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
    },
    dangerous: {
        label: 'DANGEROUS',
        icon: AlertTriangle,
        cls: 'text-red-400 bg-red-500/10 border-red-500/20',
    },
} as const;

function CopyButton({ text }: { text: string }) {
    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // Fallback for non-secure contexts
            const el = document.createElement('textarea');
            el.value = text;
            document.body.appendChild(el);
            el.select();
            document.execCommand('copy');
            document.body.removeChild(el);
        }
    }, [text]);

    return (
        <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium text-app-muted hover:text-app-text hover:bg-app-surface/60 transition-colors"
            title="Copy to clipboard"
        >
            <Copy size={10} />
            Copy
        </button>
    );
}

/** Renders plain text with inline code detection */
function FormattedText({ text }: { text: string }) {
    if (!text) return null;
    // Split on backtick-wrapped inline code
    const parts = text.split(/(`[^`]+`)/g);
    return (
        <span>
            {parts.map((part, i) =>
                part.startsWith('`') && part.endsWith('`') ? (
                    <code key={i} className="px-1 py-0.5 rounded bg-app-surface/80 font-mono text-app-accent text-[11px]">
                        {part.slice(1, -1)}
                    </code>
                ) : (
                    <span key={i}>{part}</span>
                )
            )}
        </span>
    );
}

export const AiChatMessage = memo(function AiChatMessage({ entry, onRunCommand }: AiChatMessageProps) {
    const { query, result, error, contextSnapshot, timestamp } = entry;
    const time = new Date(timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

    return (
        <div className="group flex flex-col gap-2 px-3 py-2 animate-in fade-in slide-in-from-bottom-2 duration-200">
            {/* User Query */}
            <div className="flex items-start gap-2.5">
                <div className="shrink-0 mt-0.5 w-6 h-6 rounded-full bg-app-surface/80 border border-app-border/60 shadow-sm flex items-center justify-center">
                    <User size={12} className="text-app-muted" />
                </div>
                <div className="flex-1 min-w-0 pt-0.5">
                    <p className="text-[12.5px] font-medium text-app-text/90 leading-relaxed whitespace-pre-wrap break-words">
                        <FormattedText text={query} />
                    </p>
                    {/* Context Snapshot Badge */}
                    {contextSnapshot && (
                        <div className="mt-1.5 flex items-center gap-1 text-[10px] text-app-muted/70">
                            <Terminal size={9} />
                            <span>terminal context attached</span>
                        </div>
                    )}
                </div>
                <span className="shrink-0 text-[10px] text-app-muted/50 mt-0.5">{time}</span>
            </div>

            {/* AI Response */}
            <div className="flex items-start gap-2.5 ml-1 mt-1">
                <div className="shrink-0 mt-0 w-6 h-6 rounded-full bg-gradient-to-br from-purple-500/20 to-app-accent/20 border border-purple-500/30 shadow-sm flex items-center justify-center relative">
                    <div className="absolute inset-0 bg-purple-500/10 blur-sm rounded-full" />
                    <Bot size={13} className="text-purple-400 relative z-10" />
                </div>
                <div className="flex-1 min-w-0 space-y-3 pt-0.5">
                    {error ? (
                        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-500/8 border border-red-500/15 text-red-400">
                            <AlertCircle size={12} className="shrink-0 mt-0.5" />
                            <p className="text-[11px] leading-relaxed">{error}</p>
                        </div>
                    ) : result ? (
                        <>
                            {/* Main Answer (for conversational / Q&A responses) */}
                            {result.answer && (
                                <p className="text-[12px] text-app-text leading-relaxed whitespace-pre-wrap break-words">
                                    <FormattedText text={result.answer} />
                                </p>
                            )}

                            {/* Command Block */}
                            {result.command && (
                                <div className="rounded-xl bg-app-surface/30 border border-app-border/30 overflow-hidden shadow-sm">
                                    <div className="flex items-center justify-between px-3 py-2 bg-app-surface/60 backdrop-blur-sm border-b border-app-border/20">
                                        <div className="flex items-center gap-1.5 text-[10px] text-app-muted">
                                            <Terminal size={11} className="text-app-accent/80" />
                                            <span className="font-mono font-medium tracking-wide">COMMAND</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            {/* Safety badge */}
                                            {result.safety && (() => {
                                                const cfg = SAFETY_CONFIG[result.safety];
                                                if (!cfg) return null;
                                                const Icon = cfg.icon;
                                                return (
                                                    <span className={cn("flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[9px] font-bold tracking-wider", cfg.cls)}>
                                                        <Icon size={8} />
                                                        {cfg.label}
                                                    </span>
                                                );
                                            })()}
                                            <CopyButton text={result.command} />
                                        </div>
                                    </div>
                                    <div className="relative">
                                        <pre className="px-3.5 py-3 text-[12px] font-mono text-app-text/90 leading-relaxed overflow-x-auto whitespace-pre-wrap break-all [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-app-border/30">
                                            {result.command}
                                        </pre>
                                    </div>
                                    {onRunCommand && (
                                        <div className="px-3 py-2 border-t border-app-border/20 bg-app-surface/40">
                                            <button
                                                onClick={() => onRunCommand(result.command)}
                                                className="group flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold tracking-wide bg-app-accent/10 text-app-accent border border-app-accent/20 hover:bg-app-accent hover:text-white transition-all w-fit shadow-sm shadow-app-accent/5"
                                            >
                                                <Play size={10} className="group-hover:text-white transition-colors" fill="currentColor" />
                                                RUN IN TERMINAL
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Explanation */}
                            {result.explanation && (
                                <p className="text-[11px] text-app-muted leading-relaxed whitespace-pre-wrap break-words">
                                    <FormattedText text={result.explanation} />
                                </p>
                            )}
                        </>
                    ) : null}
                </div>
            </div>

            {/* Subtle divider */}
            <div className="mt-1 border-b border-app-border/20 group-last:border-transparent" />
        </div>
    );
});
