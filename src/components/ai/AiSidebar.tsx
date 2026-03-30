import { useRef, useState, useEffect, useCallback, memo } from 'react';
import {
    Sparkles, X, ChevronDown, Trash2,
    Terminal, FileCode, Send, Square, Bot, CreditCard
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../../lib/utils';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { AiChatMessage } from './AiChatMessage';
import { collectTerminalContext } from '../../lib/aiContext';

// ──────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────

const PROVIDERS = [
    { value: 'ollama', label: 'Ollama', short: 'Ollama' },
    { value: 'gemini', label: 'Gemini', short: 'Gemini' },
    { value: 'openai', label: 'OpenAI', short: 'OpenAI' },
    { value: 'claude', label: 'Claude', short: 'Claude' },
    { value: 'groq', label: 'Groq', short: 'Groq' },
    { value: 'mistral', label: 'Mistral', short: 'Mistral' },
] as const;

type ProviderValue = typeof PROVIDERS[number]['value'];

interface ModelOption { value: string; label: string; short: string; }

const FALLBACK_MODELS: Partial<Record<ProviderValue, ModelOption[]>> = {
    gemini: [
        { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', short: '2.0 Flash' },
        { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', short: '1.5 Pro' },
    ],
    openai: [
        { value: 'gpt-4o', label: 'GPT-4o', short: 'GPT-4o' },
        { value: 'gpt-4o-mini', label: 'GPT-4o Mini', short: '4o Mini' },
    ],
    claude: [
        { value: 'claude-3-7-sonnet-20250219', label: 'Claude 3.7 Sonnet', short: '3.7 Sonnet' },
        { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', short: '3.5 Sonnet' },
        { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku', short: '3.5 Haiku' },
    ],
    groq: [
        { value: 'llama-3.3-70b-versatile', label: 'LLaMA 3.3 70B', short: 'LLaMA 3.3' },
        { value: 'llama-3.1-8b-instant', label: 'LLaMA 3.1 8B', short: 'LLaMA 3.1' },
    ],
    mistral: [
        { value: 'mistral-large-latest', label: 'Mistral Large', short: 'Large' },
        { value: 'mistral-small-latest', label: 'Mistral Small', short: 'Small' },
    ],
};

const DEFAULT_MODEL: Record<ProviderValue, string> = {
    ollama: '',
    gemini: 'gemini-2.0-flash',
    openai: 'gpt-4o-mini',
    claude: 'claude-3-7-sonnet-20250219',
    groq: 'llama-3.3-70b-versatile',
    mistral: 'mistral-large-latest',
};

// ──────────────────────────────────────────────────────────────────────────
// Sub-components (separated for memoization performance)
// ──────────────────────────────────────────────────────────────────────────

/** The scrolling message list — isolated to prevent re-renders from input changes */
const MessageList = memo(function MessageList({
    connectionId,
    isLoading,
    streamingText,
    onRunCommand,
}: {
    connectionId: string | null;
    isLoading: boolean;
    streamingText: string;
    onRunCommand: (cmd: string) => void;
}) {
    const entries = useAppStore(
        useShallow(state => connectionId ? (state.aiDisplayHistory[connectionId] || []) : [])
    );
    const messagesEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [entries.length, isLoading, streamingText]);

    return (
        <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-app-border/30 hover:[&::-webkit-scrollbar-thumb]:bg-app-border/50 [&::-webkit-scrollbar-thumb]:rounded-full">
            {entries.length === 0 && !isLoading ? (
                <div className="flex flex-col items-center justify-center h-full gap-5 px-6 text-center animate-in fade-in duration-500 zoom-in-95">
                    <div className="relative">
                        <div className="absolute inset-0 bg-app-accent blur-xl opacity-20" />
                        <div className="relative w-12 h-12 rounded-2xl bg-gradient-to-br from-app-accent to-purple-500 shadow-lg shadow-app-accent/20 flex items-center justify-center border border-white/10">
                            <Sparkles size={22} className="text-white drop-shadow-sm" />
                        </div>
                    </div>
                    <div>
                        <p className="text-[14px] font-semibold text-app-text mb-1.5 tracking-tight">How can I help you today?</p>
                        <p className="text-[11px] text-app-muted leading-relaxed max-w-[200px]">
                            Generate commands, debug errors, or explain code. Context from your active workspace is automatically attached.
                        </p>
                    </div>
                    <div className="flex flex-col gap-2 w-full text-left mt-2">
                        {[
                            'How do I check disk usage?',
                            'Explain the last terminal error',
                            'Show running docker containers',
                        ].map(suggestion => (
                            <button
                                key={suggestion}
                                className="px-3.5 py-2.5 rounded-xl text-[11px] font-medium text-app-muted/80 bg-app-surface/40 border border-transparent hover:border-app-accent/20 hover:text-app-text hover:bg-app-surface/80 hover:shadow-sm transition-all text-left group"
                                onClick={() => {
                                    window.dispatchEvent(new CustomEvent('ai-sidebar:suggestion', { detail: suggestion }));
                                }}
                            >
                                <span className="group-hover:text-app-accent transition-colors mr-1.5">›</span>
                                {suggestion}
                            </button>
                        ))}
                    </div>
                </div>
            ) : (
                <div className="py-2">
                    {entries.map(entry => (
                        <AiChatMessage
                            key={entry.id}
                            entry={entry}
                            onRunCommand={onRunCommand}
                        />
                    ))}

                    {/* Streaming indicator */}
                    {isLoading && (
                        <div className="px-3 py-2 animate-in fade-in duration-200">
                            <div className="flex items-start gap-2 ml-1">
                                <div className="shrink-0 mt-1 w-5 h-5 rounded-full bg-purple-500/15 flex items-center justify-center">
                                    <Bot size={11} className="text-purple-400" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    {streamingText ? (
                                        <p className="text-[12px] text-app-text leading-relaxed whitespace-pre-wrap break-words">
                                            {streamingText}
                                            <span className="inline-block w-0.5 h-3.5 ml-0.5 bg-app-accent animate-pulse rounded-sm" />
                                        </p>
                                    ) : (
                                        <div className="flex items-center gap-1.5 py-1">
                                            <div className="w-1.5 h-1.5 rounded-full bg-app-accent/60 animate-bounce [animation-delay:0ms]" />
                                            <div className="w-1.5 h-1.5 rounded-full bg-app-accent/60 animate-bounce [animation-delay:150ms]" />
                                            <div className="w-1.5 h-1.5 rounded-full bg-app-accent/60 animate-bounce [animation-delay:300ms]" />
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    <div ref={messagesEndRef} className="h-2" />
                </div>
            )}
        </div>
    );
});

// ──────────────────────────────────────────────────────────────────────────
// Main AiSidebar Component
// ──────────────────────────────────────────────────────────────────────────

interface AiSidebarProps {
    connectionId: string | null;
    activeTermId?: string | null;
    onRunCommand?: (connectionId: string, command: string) => void;
}

export function AiSidebar({ connectionId, activeTermId, onRunCommand }: AiSidebarProps) {
    const isOpen = useAppStore(state => state.isAiSidebarOpen);
    const closeAiSidebar = useAppStore(state => state.closeAiSidebar);
    const isLoading = useAppStore(state => state.aiLoading);
    const streamingText = useAppStore(state => state.aiStreamingText);
    const submitAiQuery = useAppStore(state => state.submitAiQuery);
    const clearDisplayHistory = useAppStore(state => state.clearDisplayHistory);
    const pushAiHistory = useAppStore(state => state.pushAiHistory);
    const aiSettings = useAppStore(state => state.settings.ai);
    const updateAiSettings = useAppStore(state => state.updateAiSettings);
    const checkOllama = useAppStore(state => state.checkOllama);
    const getOllamaModels = useAppStore(state => state.getOllamaModels);
    const getProviderModels = useAppStore(state => state.getProviderModels);
    const openSettings = useAppStore(state => state.openSettings);
    const attachedContext = useAppStore(state => state.aiAttachedContext);
    const setAttachedContext = useAppStore(state => state.setAiAttachedContext);

    // Input state
    const [query, setQuery] = useState('');
    const inputRef = useRef<HTMLTextAreaElement>(null);

    // Resize — use direct DOM mutation to avoid framer-motion spring fighting the drag
    const [width, setWidth] = useState(() => parseInt(localStorage.getItem('zync-ai-sidebar-width') || '300', 10));
    const sidebarOuterRef = useRef<HTMLElement>(null);
    const sidebarInnerRef = useRef<HTMLDivElement>(null);
    // True while open/close animation runs — we clip overflow only then so dropdowns can escape when stable
    const [isAnimating, setIsAnimating] = useState(false);
    // True for one tick after drag ends — prevents framer-motion from spring-bouncing to the synced value
    const [skipAnimation, setSkipAnimation] = useState(false);

    const dragMoveRef = useRef<((e: MouseEvent) => void) | null>(null);
    const dragUpRef = useRef<(() => void) | null>(null);

    // Ensure listeners are cleaned up if component unmounts mid-drag
    useEffect(() => {
        return () => {
            if (dragMoveRef.current) document.removeEventListener('mousemove', dragMoveRef.current);
            if (dragUpRef.current) document.removeEventListener('mouseup', dragUpRef.current);
        };
    }, []);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = width;
        let liveWidth = startWidth;

        const onMove = (mv: MouseEvent) => {
            const delta = startX - mv.clientX;
            liveWidth = Math.max(250, Math.min(800, startWidth + delta));
            // Mutate DOM directly — zero React re-renders, zero spring oscillation
            if (sidebarOuterRef.current) sidebarOuterRef.current.style.width = liveWidth + 'px';
            if (sidebarInnerRef.current) sidebarInnerRef.current.style.width = liveWidth + 'px';
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            dragMoveRef.current = null;
            dragUpRef.current = null;
            
            // Disable the spring for this single state-sync so framer-motion doesn't bounce
            setSkipAnimation(true);
            setWidth(liveWidth);
            localStorage.setItem('zync-ai-sidebar-width', liveWidth.toString());
            // Re-enable spring after one paint so open/close still animates
            requestAnimationFrame(() => setSkipAnimation(false));
            // Trigger layout end to ensure terminal fits perfectly after resize
            window.dispatchEvent(new CustomEvent('zync:layout-transition-end'));
        };

        dragMoveRef.current = onMove;
        dragUpRef.current = onUp;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }, [width]);

    // Provider / Model dropdowns
    const [providerOpen, setProviderOpen] = useState(false);
    const [modelOpen, setModelOpen] = useState(false);
    const [ollamaModels, setOllamaModels] = useState<string[]>([]);
    const [dynamicModels, setDynamicModels] = useState<string[]>([]);
    const [ollamaAvailable, setOllamaAvailable] = useState(true);
    const modelFetchIdRef = useRef(0);

    const providerRef = useRef<HTMLDivElement>(null);
    const modelRef = useRef<HTMLDivElement>(null);

    const activeProviderValue = (aiSettings?.provider ?? 'ollama') as ProviderValue;
    const activeProvider = PROVIDERS.find(p => p.value === activeProviderValue) ?? PROVIDERS[0];
    const activeProviderKeyRef = aiSettings?.keys?.[activeProviderValue as keyof NonNullable<typeof aiSettings.keys>] || '';

    const makeModelOption = (id: string): ModelOption => {
        const label = id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const parts = id.split('-');
        const short = parts.slice(-2).join(' ');
        return { value: id, label, short };
    };

    const currentModels: ModelOption[] = activeProviderValue === 'ollama'
        ? ollamaModels.map(m => ({ value: m, label: m, short: m }))
        : dynamicModels.length > 0 ? dynamicModels.map(makeModelOption)
            : FALLBACK_MODELS[activeProviderValue] ?? [];

    const activeModel = aiSettings?.model || DEFAULT_MODEL[activeProviderValue];
    const activeModelOption = currentModels.find(m => m.value === activeModel);
    const modelShort = activeModelOption?.short ?? (activeModel || '—');

    const hasKey = (provider: string) =>
        !!aiSettings?.keys?.[provider as keyof NonNullable<typeof aiSettings.keys>];

    const providerNeedsSetup = activeProviderValue === 'ollama' ? !ollamaAvailable : !hasKey(activeProviderValue);

    useEffect(() => {
        if (!isOpen) return;
        const fetchId = ++modelFetchIdRef.current;

        if (activeProviderValue === 'ollama') {
            checkOllama().then(ok => {
                if (fetchId !== modelFetchIdRef.current) return;
                setOllamaAvailable(ok);
                if (ok) getOllamaModels().then(models => {
                    if (fetchId === modelFetchIdRef.current) setOllamaModels(models);
                });
            });
        } else if (activeProviderKeyRef) {
            setDynamicModels([]);
            getProviderModels().then(models => {
                if (fetchId === modelFetchIdRef.current) setDynamicModels(models);
            });
        }
    }, [isOpen, activeProviderValue, activeProviderKeyRef]);

    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as string;
            setQuery(detail);
            inputRef.current?.focus();
        };
        window.addEventListener('ai-sidebar:suggestion', handler);
        return () => window.removeEventListener('ai-sidebar:suggestion', handler);
    }, []);

    useEffect(() => {
        if (!providerOpen && !modelOpen) return;
        const handler = (e: MouseEvent) => {
            if (providerOpen && providerRef.current && !providerRef.current.contains(e.target as Node))
                setProviderOpen(false);
            if (modelOpen && modelRef.current && !modelRef.current.contains(e.target as Node))
                setModelOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [providerOpen, modelOpen]);

    const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setQuery(e.target.value);
        const ta = e.target;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    }, []);

    const handleSubmit = useCallback(async () => {
        const trimmed = query.trim();
        if (!trimmed || isLoading) return;

        pushAiHistory(trimmed);
        setQuery('');
        if (inputRef.current) {
            inputRef.current.style.height = 'auto';
        }

        let context: Record<string, any> = {};
        if (connectionId || activeTermId) {
            try {
                const termCtx = await collectTerminalContext(connectionId ?? undefined, activeTermId ?? null, { includeRecentOutput: true });
                context = { ...termCtx };
            } catch {
                // optional
            }
        }

        if (attachedContext) {
            context.attachedContent = attachedContext.content;
            context.attachedLabel = attachedContext.label;
        }

        await submitAiQuery(trimmed, context, connectionId);
    }, [query, isLoading, connectionId, activeTermId, attachedContext, submitAiQuery, pushAiHistory]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    }, [handleSubmit]);

    const handleRunCommand = useCallback((command: string) => {
        if (connectionId && onRunCommand) onRunCommand(connectionId, command);
    }, [connectionId, onRunCommand]);

    const handleClearHistory = useCallback(() => {
        if (connectionId) clearDisplayHistory(connectionId);
    }, [connectionId, clearDisplayHistory]);

    // The motion.aside ONLY handles the initial open/exit animation (width: 0 → width).
    // During user resize we mutate the DOM directly (sidebarOuterRef / sidebarInnerRef),
    // so framer-motion never fights the drag and can't spring-flash.
    return (
        <AnimatePresence>
            {isOpen && (
                <motion.aside
                    key="ai-sidebar"
                    ref={sidebarOuterRef as React.RefObject<HTMLElement>}
                    initial={{ width: 0 }}
                    animate={{ width }}
                    exit={{ width: 0 }}
                    transition={
                        skipAnimation
                            ? { duration: 0 }  // instant — no bounce after drag
                            : { type: 'spring', stiffness: 400, damping: 40, mass: 0.7 }
                    }
                    onAnimationStart={() => {
                        setIsAnimating(true);
                        window.dispatchEvent(new CustomEvent('zync:layout-transition-start'));
                    }}
                    onAnimationComplete={() => {
                        setIsAnimating(false);
                        window.dispatchEvent(new CustomEvent('zync:layout-transition-end'));
                    }}
                    // Clip overflow ONLY while animating open/close so absolutely-positioned
                    // dropdowns can escape the container boundary when the sidebar is stable.
                    className={cn(
                        'relative flex shrink-0',
                        isAnimating && 'overflow-hidden'
                    )}
                    style={{ minWidth: 0 }}
                >
                    {/* Drag Handle — invisible until hover, sits on left edge */}
                    <div
                        className="absolute top-0 bottom-0 left-0 w-1 cursor-col-resize z-[60] hover:bg-app-accent/60 transition-colors"
                        onMouseDown={handleMouseDown}
                    />

                    {/* Inner panel — always fully opaque, width matches outer via ref */}
                    <div
                        ref={sidebarInnerRef}
                        className="flex flex-col shrink-0 border-l border-app-border/40 bg-app-bg h-full"
                        style={{ width }}
                    >

                        {/* ── Header ────────────────────────────────────── */}
                        <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 bg-app-bg/80 backdrop-blur-md border-b border-app-border/30 z-10 w-full relative">
                            <Sparkles size={14} className="text-app-accent shrink-0" />
                            <span className="text-[12px] font-semibold text-app-text flex-1 truncate">AI Assistant</span>

                            <button
                                onClick={handleClearHistory}
                                className="p-1 rounded hover:bg-app-surface/60 text-app-muted hover:text-red-400 transition-colors"
                                title="Clear chat history"
                            >
                                <Trash2 size={13} />
                            </button>
                            <button
                                onClick={closeAiSidebar}
                                className="p-1 rounded hover:bg-app-surface/60 text-app-muted hover:text-app-text transition-colors"
                                title="Close AI sidebar"
                            >
                                <X size={13} />
                            </button>
                        </div>

                        {/* ── Message Area ──────────────────────────────── */}
                        <MessageList
                            connectionId={connectionId}
                            isLoading={isLoading}
                            streamingText={streamingText}
                            onRunCommand={handleRunCommand}
                        />

                        {/* ── Input Area (Cursor-style: model at bottom) ── */}
                        <div className="shrink-0 border-t border-app-border/40 bg-app-panel/30 p-2.5 space-y-2">
                            {/* Attached context pill */}
                            {attachedContext && (
                                <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-app-accent/8 border border-app-accent/20 text-[10px] text-app-accent">
                                    {attachedContext.type === 'terminal' ? <Terminal size={9} /> : <FileCode size={9} />}
                                    <span className="truncate flex-1">{attachedContext.label}</span>
                                    <button onClick={() => setAttachedContext(null)} className="shrink-0 hover:text-red-400 transition-colors">
                                        <X size={9} />
                                    </button>
                                </div>
                            )}

                            {/* Input Container — acts as the unified inner border/glow */}
                            <div className="relative flex items-end gap-1.5 p-1 bg-app-surface/30 border border-app-border/40 rounded-xl focus-within:border-app-accent/40 focus-within:bg-app-surface/50 focus-within:ring-2 focus-within:ring-app-accent/10 transition-all shadow-sm">
                                <textarea
                                    ref={inputRef}
                                    value={query}
                                    onChange={handleInput}
                                    onKeyDown={handleKeyDown}
                                    placeholder="Ask anything…"
                                    disabled={isLoading}
                                    rows={1}
                                    className={cn(
                                        "flex-1 resize-none bg-transparent border-none px-2.5 py-1.5 text-[12px] text-app-text placeholder:text-app-muted/50 outline-none focus:ring-0 leading-[1.6]",
                                        "min-h-[32px] max-h-[120px] overflow-y-auto [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:bg-app-border/40 [&::-webkit-scrollbar-thumb]:rounded-full",
                                        isLoading && "opacity-60 cursor-not-allowed"
                                    )}
                                />
                                <button
                                    onClick={isLoading ? undefined : handleSubmit}
                                    disabled={isLoading || !query.trim()}
                                    className={cn(
                                        "shrink-0 flex items-center justify-center w-8 h-8 rounded-lg transition-all",
                                        isLoading
                                            ? "bg-app-surface/60 text-app-accent animate-pulse cursor-not-allowed"
                                            : query.trim()
                                                ? "bg-gradient-to-r from-app-accent to-purple-500 text-white shadow shadow-app-accent/20 hover:brightness-110 active:scale-95"
                                                : "bg-app-surface/60 text-app-muted/50 cursor-not-allowed"
                                    )}
                                >
                                    {isLoading ? <Square size={12} fill="currentColor" /> : <Send size={13} className="-ml-0.5" />}
                                </button>
                            </div>

                            {/* FIX 2: Model + Provider selector at the bottom (Cursor-style) */}
                            <div className="flex items-center justify-between gap-2 px-0.5">
                                {providerNeedsSetup ? (
                                    <button
                                        onClick={() => openSettings()}
                                        className="flex items-center gap-1 text-[10px] text-yellow-400 hover:text-yellow-300 transition-colors"
                                    >
                                        <CreditCard size={9} />
                                        {activeProviderValue === 'ollama' ? 'Ollama not running' : 'Configure API key →'}
                                    </button>
                                ) : (
                                    <div className="flex items-center gap-1.5">
                                        {/* Provider picker */}
                                        <div ref={providerRef} className="relative">
                                            <button
                                                onClick={() => { setProviderOpen(v => !v); setModelOpen(false); }}
                                                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-app-muted hover:text-app-text hover:bg-app-surface/60 transition-colors"
                                            >
                                                {activeProvider.short}
                                                <ChevronDown size={8} />
                                            </button>
                                            <AnimatePresence>
                                                {providerOpen && (
                                                    <motion.div
                                                        initial={{ opacity: 0, y: 4 }}
                                                        animate={{ opacity: 1, y: 0 }}
                                                        exit={{ opacity: 0, y: 4 }}
                                                        transition={{ duration: 0.12 }}
                                                        className="absolute left-0 bottom-full mb-1.5 min-w-[140px] w-max max-w-[220px] max-h-[250px] overflow-y-auto rounded-lg shadow-xl border border-app-border/60 bg-app-panel z-[100] flex flex-col"
                                                    >
                                                        {PROVIDERS.map(p => (
                                                            <button
                                                                key={p.value}
                                                                onClick={() => { updateAiSettings({ provider: p.value as any }); setProviderOpen(false); }}
                                                                className={cn(
                                                                    "w-full text-left px-3 py-2 text-[11px] transition-colors truncate",
                                                                    p.value === activeProviderValue ? "bg-app-accent/10 text-app-accent" : "text-app-text hover:bg-app-surface/60"
                                                                )}
                                                            >
                                                                {p.label}
                                                            </button>
                                                        ))}
                                                    </motion.div>
                                                )}
                                            </AnimatePresence>
                                        </div>

                                        <div className="w-[1px] h-3 bg-app-border/50 hidden sm:block"></div>

                                        {/* Model picker */}
                                        <div ref={modelRef} className="relative">
                                            <button
                                                onClick={() => { setModelOpen(v => !v); setProviderOpen(false); }}
                                                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-app-muted hover:text-app-text hover:bg-app-surface/60 transition-colors"
                                            >
                                                <span className="truncate max-w-[120px]">{modelShort}</span>
                                                <ChevronDown size={8} />
                                            </button>
                                            <AnimatePresence>
                                                {modelOpen && currentModels.length > 0 && (
                                                    <motion.div
                                                        initial={{ opacity: 0, y: 4 }}
                                                        animate={{ opacity: 1, y: 0 }}
                                                        exit={{ opacity: 0, y: 4 }}
                                                        transition={{ duration: 0.1 }}
                                                        className="absolute right-0 bottom-full mb-1.5 min-w-[180px] w-max max-w-[240px] max-h-[250px] overflow-y-auto rounded-lg shadow-xl border border-app-border/60 bg-app-panel z-[100] flex flex-col"
                                                    >
                                                        {currentModels.map(m => (
                                                            <button
                                                                key={m.value}
                                                                onClick={() => { updateAiSettings({ model: m.value }); setModelOpen(false); }}
                                                                className={cn(
                                                                    "w-full text-left px-3 py-2 text-[11px] transition-colors truncate",
                                                                    m.value === activeModel ? "bg-app-accent/10 text-app-accent" : "text-app-text hover:bg-app-surface/60"
                                                                )}
                                                            >
                                                                {m.label}
                                                            </button>
                                                        ))}
                                                    </motion.div>
                                                )}
                                            </AnimatePresence>
                                        </div>
                                    </div>
                                )}
                                <span className="ml-auto text-[9px] text-app-muted/40">Enter to send</span>
                            </div>
                        </div>
                    </div>
                </motion.aside>
            )}
        </AnimatePresence>
    );
}
