import { useEffect, useRef, useState } from 'react';
import { Sparkles, X, Copy, Play, AlertTriangle, ShieldCheck, ShieldAlert, ChevronDown, ArrowRight, Bookmark, RotateCw, Shield, Clock, KeyRound, WifiOff, Settings, CreditCard } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../../lib/utils';
import { useAppStore } from '../../store/useAppStore';
import type { AiResult } from '../../store/aiSlice';
import { collectTerminalContext } from '../../lib/aiContext';

const PROVIDERS = [
    { value: 'ollama', label: 'Ollama', short: 'Ollama' },
    { value: 'gemini', label: 'Gemini', short: 'Gemini' },
    { value: 'openai', label: 'OpenAI', short: 'OpenAI' },
    { value: 'claude', label: 'Claude', short: 'Claude' },
] as const;

type ProviderValue = typeof PROVIDERS[number]['value'];

interface ModelOption { value: string; label: string; short: string }

// Fallback static models shown before dynamic fetch completes or if fetch fails
const FALLBACK_MODELS: Record<Exclude<ProviderValue, 'ollama'>, ModelOption[]> = {
    gemini: [
        { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', short: '2.0 Flash' },
        { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', short: '1.5 Flash' },
        { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', short: '1.5 Pro' },
    ],
    openai: [
        { value: 'gpt-4o', label: 'GPT-4o', short: 'GPT-4o' },
        { value: 'gpt-4o-mini', label: 'GPT-4o Mini', short: '4o Mini' },
    ],
    claude: [
        { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', short: 'Opus' },
        { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', short: 'Sonnet' },
        { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', short: 'Haiku' },
    ],
};

const DEFAULT_MODEL: Record<ProviderValue, string> = {
    ollama: '',
    gemini: 'gemini-2.0-flash',
    openai: 'gpt-4o-mini',
    claude: 'claude-sonnet-4-6',
};

interface AiCommandBarProps {
    connectionId?: string;
    activeTermId: string | null;
}

const SAFETY_CONFIG = {
    safe: {
        label: 'SAFE',
        icon: ShieldCheck,
        badgeClass: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20',
    },
    moderate: {
        label: 'MODERATE',
        icon: ShieldAlert,
        badgeClass: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20',
    },
    dangerous: {
        label: 'DANGEROUS',
        icon: AlertTriangle,
        badgeClass: 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20',
    },
} as const;

export function AiCommandBar({ connectionId, activeTermId }: AiCommandBarProps) {
    const isOpen = useAppStore(state => state.aiCommandBarOpen);
    const isLoading = useAppStore(state => state.aiLoading);
    const result = useAppStore(state => state.aiResult);
    const error = useAppStore(state => state.aiError);
    const streamingText = useAppStore(state => state.aiStreamingText);
    const closeAiCommandBar = useAppStore(state => state.closeAiCommandBar);
    const submitAiQuery = useAppStore(state => state.submitAiQuery);
    const clearAiResult = useAppStore(state => state.clearAiResult);
    const aiSettings = useAppStore(state => state.settings.ai);
    const updateAiSettings = useAppStore(state => state.updateAiSettings);
    const checkOllama = useAppStore(state => state.checkOllama);
    const getOllamaModels = useAppStore(state => state.getOllamaModels);
    const getProviderModels = useAppStore(state => state.getProviderModels);
    const pushAiHistory = useAppStore(state => state.pushAiHistory);
    const aiQueryHistory = useAppStore(state => state.aiQueryHistory);
    const aiHistoryIndex = useAppStore(state => state.aiHistoryIndex);
    const setAiHistoryIndex = useAppStore(state => state.setAiHistoryIndex);
    const addSnippet = useAppStore(state => state.addSnippet);
    const showToast = useAppStore(state => state.showToast);
    const openSettings = useAppStore(state => state.openSettings);

    const [query, setQuery] = useState('');
    const [copied, setCopied] = useState(false);
    const [providerOpen, setProviderOpen] = useState(false);
    const [modelOpen, setModelOpen] = useState(false);
    const [ollamaAvailable, setOllamaAvailable] = useState(true);
    const [ollamaModels, setOllamaModels] = useState<string[]>([]);
    const [dynamicModels, setDynamicModels] = useState<string[]>([]);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [editedCommand, setEditedCommand] = useState('');
    const [snippetSaved, setSnippetSaved] = useState(false);
    const [inputFocused, setInputFocused] = useState(false);
    const [submittedQuery, setSubmittedQuery] = useState('');
    const [chatHistory, setChatHistory] = useState<{ query: string; result: AiResult | null; error: string | null }[]>([]);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const providerRef = useRef<HTMLDivElement>(null);
    const modelRef = useRef<HTMLDivElement>(null);
    const chatContainerRef = useRef<HTMLDivElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const queryBeforeHistoryRef = useRef('');
    const modelFetchIdRef = useRef(0);

    const activeProvider = PROVIDERS.find(p => p.value === aiSettings?.provider) ?? PROVIDERS[0];
    const activeProviderValue = activeProvider.value as ProviderValue;

    // Helper: make dynamic model IDs into readable labels
    const makeModelOption = (id: string): ModelOption => {
        const label = id
            .replace('gemini-', 'Gemini ')
            .replace('gpt-', 'GPT-')
            .replace('claude-', 'Claude ')
            .replace(/-/g, ' ');
        const parts = id.split('-');
        const short = parts.length > 2 ? parts.slice(1).join(' ') : parts.join(' ');
        return { value: id, label, short };
    };

    // Build model list: dynamic (from API) → fallback static
    const currentModels: ModelOption[] = activeProviderValue === 'ollama'
        ? ollamaModels.map(m => ({ value: m, label: m, short: m }))
        : dynamicModels.length > 0
            ? dynamicModels.map(makeModelOption)
            : FALLBACK_MODELS[activeProviderValue as Exclude<ProviderValue, 'ollama'>] ?? [];

    const activeModel = aiSettings?.model || DEFAULT_MODEL[activeProviderValue];
    const activeModelOption = currentModels.find(m => m.value === activeModel);
    const modelShort = activeModelOption?.short ?? (activeModel || DEFAULT_MODEL[activeProviderValue] || '—');

    // Check if a provider has its API key configured
    const hasKey = (provider: string) => {
        return !!aiSettings?.keys?.[provider as keyof NonNullable<typeof aiSettings.keys>];
    };

    const needsSetup = (provider: string) => {
        if (provider === 'ollama') return !ollamaAvailable;
        return !hasKey(provider);
    };

    const activeProviderNeedsSetup = needsSetup(activeProvider.value);

    // Stable key reference for useEffect dependency (avoids re-firing on every render)
    const activeProviderKeyRef = aiSettings?.keys?.[activeProviderValue as keyof NonNullable<typeof aiSettings.keys>] || '';

    // Fetch models on open or when provider/apiKey changes
    useEffect(() => {
        if (!isOpen) return;

        const fetchId = ++modelFetchIdRef.current;

        if (activeProviderValue === 'ollama') {
            checkOllama().then(ok => {
                if (fetchId !== modelFetchIdRef.current) return; // stale
                setOllamaAvailable(ok);
                if (ok) getOllamaModels().then(models => {
                    if (fetchId === modelFetchIdRef.current) setOllamaModels(models);
                });
            });
        } else if (activeProviderKeyRef) {
            setModelsLoading(true);
            setDynamicModels([]);
            getProviderModels().then(models => {
                if (fetchId === modelFetchIdRef.current) setDynamicModels(models);
            }).finally(() => {
                if (fetchId === modelFetchIdRef.current) setModelsLoading(false);
            });
        }
    }, [isOpen, activeProviderValue, activeProviderKeyRef]);

    // Seed edited command from result
    useEffect(() => {
        if (result?.command) setEditedCommand(result.command);
    }, [result?.command]);

    // Focus input on open, reset state
    useEffect(() => {
        if (isOpen) {
            setQuery('');
            setEditedCommand('');
            setSnippetSaved(false);
            setSubmittedQuery('');
            setChatHistory([]);
            clearAiResult();
            queryBeforeHistoryRef.current = '';
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    }, [isOpen]);

    // Escape to close
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) { e.stopPropagation(); handleClose(); }
        };
        window.addEventListener('keydown', handler, { capture: true });
        return () => window.removeEventListener('keydown', handler, { capture: true });
    }, [isOpen]);

    // Scroll chat to bottom on new messages
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chatHistory.length, !!result, !!error, isLoading]);

    // Close dropdowns on outside click
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

    const handleClose = () => {
        closeAiCommandBar();
        setQuery('');
        setTimeout(() => window.dispatchEvent(new CustomEvent('ssh-ui:term-focus')), 50);
    };

    const handleSubmitWithQuery = async (q: string, saveToHistory = true) => {
        if (!q.trim() || isLoading || activeProviderNeedsSetup) return;
        // Archive current result/error before overwriting with the new query
        if (saveToHistory && submittedQuery && (result || error)) {
            setChatHistory(prev => [...prev, { query: submittedQuery, result, error }]);
        }
        setSubmittedQuery(q.trim());
        pushAiHistory(q.trim());
        setAiHistoryIndex(-1);
        const context = await collectTerminalContext(connectionId, activeTermId);
        await submitAiQuery(q.trim(), context);
    };

    const handleSubmit = () => {
        handleSubmitWithQuery(query);
        setQuery('');
        if (inputRef.current) inputRef.current.style.height = 'auto';
    };

    const handleExecute = () => {
        const cmd = editedCommand || result?.command;
        if (!cmd) return;
        window.dispatchEvent(new CustomEvent('zync:terminal:send', {
            detail: { connectionId, text: cmd + '\n' }
        }));
        handleClose();
    };

    const handleCopy = () => {
        const text = result?.answer ?? (editedCommand || result?.command);
        if (!text) return;
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    };

    const handleSaveSnippet = () => {
        const cmd = editedCommand || result?.command;
        if (!cmd) return;
        addSnippet({
            id: crypto.randomUUID(),
            name: submittedQuery.trim().slice(0, 60) || cmd.slice(0, 60),
            command: cmd,
            category: 'AI Generated',
            connectionId,
        });
        showToast('success', 'Saved to snippets');
        setSnippetSaved(true);
        setTimeout(() => setSnippetSaved(false), 2000);
    };

    const handleRetry = () => {
        clearAiResult();
        setEditedCommand('');
        setSnippetSaved(false);
        handleSubmitWithQuery(submittedQuery, false);
    };

    const handleMakeSafer = () => {
        clearAiResult();
        setEditedCommand('');
        setSnippetSaved(false);
        const safetySuffix = ' (use the safest approach, avoid destructive flags)';
        // Strip existing safety suffix to prevent accumulation on repeated clicks
        const baseQuery = submittedQuery.trim().replace(safetySuffix, '');
        const saferQuery = baseQuery + safetySuffix;
        setQuery(saferQuery);
        handleSubmitWithQuery(saferQuery, false);
    };

    const autoResize = (el: HTMLTextAreaElement) => {
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (query.trim()) {
                // User typed a new query → submit it (even if a result is already showing)
                handleSubmit();
            } else if (result && !result.answer && result.safety !== 'dangerous') {
                // Empty input + command result → execute
                handleExecute();
            }
        } else if (e.key === 'ArrowUp' && !result && !query.includes('\n')) {
            e.preventDefault();
            if (aiQueryHistory.length === 0) return;
            const newIndex = aiHistoryIndex < 0 ? 0 : Math.min(aiHistoryIndex + 1, aiQueryHistory.length - 1);
            if (aiHistoryIndex < 0) queryBeforeHistoryRef.current = query;
            setAiHistoryIndex(newIndex);
            setQuery(aiQueryHistory[newIndex]);
        } else if (e.key === 'ArrowDown' && !result && !query.includes('\n')) {
            e.preventDefault();
            if (aiHistoryIndex < 0) return;
            const newIndex = aiHistoryIndex - 1;
            if (newIndex < 0) {
                setAiHistoryIndex(-1);
                setQuery(queryBeforeHistoryRef.current);
            } else {
                setAiHistoryIndex(newIndex);
                setQuery(aiQueryHistory[newIndex]);
            }
        }
    };

    const selectProvider = (providerValue: string) => {
        updateAiSettings({ provider: providerValue as ProviderValue, model: DEFAULT_MODEL[providerValue as ProviderValue] ?? '' });
        setProviderOpen(false);
        inputRef.current?.focus();
    };

    const selectModel = (modelValue: string) => {
        updateAiSettings({ model: modelValue });
        setModelOpen(false);
        inputRef.current?.focus();
    };

    const sortedProviders = [...PROVIDERS].sort((a, b) =>
        (needsSetup(a.value) ? 1 : 0) - (needsSetup(b.value) ? 1 : 0)
    );

    const safetyInfo = result
        ? (SAFETY_CONFIG[result.safety as keyof typeof SAFETY_CONFIG] ?? SAFETY_CONFIG.moderate)
        : null;
    const SafetyIcon = safetyInfo?.icon;

    const isEdited = result && editedCommand !== result.command;

    type ErrorKind = 'rate-limit' | 'billing' | 'invalid-key' | 'no-key' | 'connection' | 'generic';
    const classifyError = (msg: string): ErrorKind => {
        const e = msg.toLowerCase();
        if (e.includes('billing error') || e.includes('credit balance') || e.includes('purchase credits') || e.includes('insufficient_quota')) return 'billing';
        if (e.includes('rate limit') || e.includes('quota') || e.includes('too many')) return 'rate-limit';
        if (e.includes('invalid') && e.includes('key')) return 'invalid-key';
        if (e.includes('not configured')) return 'no-key';
        if (e.includes('not running') || e.includes('econnrefused') || e.includes('connection')) return 'connection';
        return 'generic';
    };

    const ERROR_CONFIG: Record<ErrorKind, {
        icon: React.ElementType;
        color: string;
        bg: string;
        border: string;
        title?: string;
        hint: string;
        action?: { label: string; fn: () => void };
    }> = {
        'billing': {
            icon: CreditCard,
            color: 'text-orange-700 dark:text-orange-400',
            bg: 'bg-orange-500/10 dark:bg-orange-500/5',
            border: 'border-orange-500/30 dark:border-orange-500/15',
            title: 'Insufficient credits',
            hint: `Your ${activeProvider.label} account has no credits. Add credits in your provider's billing dashboard, or switch to a free provider like Gemini or Ollama.`,
            action: { label: 'Switch provider', fn: () => setProviderOpen(true) },
        },
        'rate-limit': {
            icon: Clock,
            color: 'text-yellow-700 dark:text-yellow-400',
            bg: 'bg-yellow-500/10 dark:bg-yellow-500/5',
            border: 'border-yellow-500/30 dark:border-yellow-500/15',
            hint: 'Free tier quota reached. Wait a minute or switch to a different model.',
            action: { label: 'Retry', fn: () => { clearAiResult(); handleSubmitWithQuery(submittedQuery, false); } },
        },
        'invalid-key': {
            icon: KeyRound,
            color: 'text-red-700 dark:text-red-400',
            bg: 'bg-red-500/10 dark:bg-red-500/5',
            border: 'border-red-500/30 dark:border-red-500/15',
            hint: 'The API key was rejected. Double-check it in Settings → AI.',
            action: { label: 'Open Settings', fn: () => { handleClose(); openSettings(); } },
        },
        'no-key': {
            icon: Settings,
            color: 'text-yellow-700 dark:text-yellow-400',
            bg: 'bg-yellow-500/10 dark:bg-yellow-500/5',
            border: 'border-yellow-500/30 dark:border-yellow-500/15',
            hint: `Add a ${activeProvider.label} API key in Settings → AI to use this provider.`,
            action: { label: 'Open Settings', fn: () => { handleClose(); openSettings(); } },
        },
        'connection': {
            icon: WifiOff,
            color: 'text-orange-700 dark:text-orange-400',
            bg: 'bg-orange-500/10 dark:bg-orange-500/5',
            border: 'border-orange-500/30 dark:border-orange-500/15',
            hint: activeProvider.value === 'ollama'
                ? "Ollama isn't running. Start it with 'ollama serve'."
                : 'Could not reach the API. Check your network connection.',
            action: { label: 'Retry', fn: () => { clearAiResult(); handleSubmitWithQuery(submittedQuery, false); } },
        },
        'generic': {
            icon: AlertTriangle,
            color: 'text-red-700 dark:text-red-400',
            bg: 'bg-red-500/10 dark:bg-red-500/5',
            border: 'border-red-500/30 dark:border-red-500/15',
            hint: '',
            action: { label: 'Retry', fn: () => { clearAiResult(); handleSubmitWithQuery(submittedQuery, false); } },
        },
    };

    const errorKind = error ? classifyError(error) : 'generic';
    const errorCfg = ERROR_CONFIG[errorKind];

    const dropdownMotion = {
        initial: { opacity: 0, y: -4, scale: 0.97 },
        animate: { opacity: 1, y: 0, scale: 1 },
        exit: { opacity: 0, y: -4, scale: 0.97 },
        transition: { duration: 0.1 },
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0, y: -8, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8, scale: 0.98 }}
                    transition={{ type: 'spring', duration: 0.2, bounce: 0.1 }}
                    className="absolute top-3 left-1/2 -translate-x-1/2 z-50 w-full max-w-xl px-3"
                >
                    <div className="bg-app-panel border border-app-border rounded-xl shadow-2xl ring-1 ring-black/10 dark:ring-white/5 flex flex-col">

                        {/* ── Header: icon + provider + model + close ── */}
                        <div className="flex items-center gap-2 px-3 py-2 border-b border-app-border/40">
                            <Sparkles className="w-3.5 h-3.5 text-app-accent shrink-0" />
                            <span className="text-[11px] font-medium text-app-muted mr-1">AI</span>

                            {/* Provider pill */}
                            <div ref={providerRef} className="relative">
                                <button
                                    type="button"
                                    onClick={() => { setProviderOpen(v => !v); setModelOpen(false); }}
                                    className={cn(
                                        'flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md border transition-all',
                                        activeProviderNeedsSetup
                                            ? 'bg-yellow-500/5 border-yellow-500/30 text-yellow-400/80 hover:border-yellow-500/50'
                                            : 'bg-app-surface border-app-border/60 text-app-muted hover:text-app-text hover:border-app-accent/40'
                                    )}
                                >
                                    {activeProvider.short}
                                    {activeProviderNeedsSetup && <AlertTriangle className="w-2.5 h-2.5" />}
                                    <ChevronDown className={cn('w-3 h-3 transition-transform', providerOpen && 'rotate-180')} />
                                </button>

                                <AnimatePresence>
                                    {providerOpen && (
                                        <motion.div
                                            {...dropdownMotion}
                                            className="absolute top-full left-0 mt-1 z-50 min-w-[190px] bg-app-panel border border-app-border rounded-lg shadow-xl overflow-hidden"
                                        >
                                            {sortedProviders.map((p, i) => {
                                                const isReady = !needsSetup(p.value);
                                                const isActive = activeProvider.value === p.value;
                                                const showDivider = i > 0
                                                    && !needsSetup(sortedProviders[i - 1].value)
                                                    && !isReady;
                                                return (
                                                    <div key={p.value}>
                                                        {showDivider && <div className="h-px bg-app-border/40 mx-2 my-1" />}
                                                        <button
                                                            type="button"
                                                            onClick={() => selectProvider(p.value)}
                                                            className={cn(
                                                                'w-full flex items-center justify-between px-3 py-2 text-xs transition-colors',
                                                                isActive
                                                                    ? 'text-app-accent bg-app-accent/10 font-medium'
                                                                    : 'text-app-muted hover:bg-app-surface hover:text-app-text'
                                                            )}
                                                        >
                                                            <span>{p.label}</span>
                                                            {!isReady && (
                                                                <span className="text-[10px] text-app-muted/50 ml-2">
                                                                    {p.value === 'ollama' ? '[Setup Required]' : '[No API Key]'}
                                                                </span>
                                                            )}
                                                        </button>
                                                    </div>
                                                );
                                            })}
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>

                            {/* Model pill */}
                            <div ref={modelRef} className="relative">
                                <button
                                    type="button"
                                    onClick={() => { setModelOpen(v => !v); setProviderOpen(false); }}
                                    className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md border bg-app-surface border-app-border/60 text-app-muted hover:text-app-text hover:border-app-accent/40 transition-all"
                                    title="Select model"
                                >
                                    <span className="max-w-[90px] truncate">{modelShort}</span>
                                    <ChevronDown className={cn('w-3 h-3 transition-transform', modelOpen && 'rotate-180')} />
                                </button>

                                <AnimatePresence>
                                    {modelOpen && (
                                        <motion.div
                                            {...dropdownMotion}
                                            className="absolute top-full left-0 mt-1 z-50 min-w-[220px] max-h-60 overflow-y-auto bg-app-panel border border-app-border rounded-lg shadow-xl"
                                        >
                                            {modelsLoading ? (
                                                <div className="px-3 py-3 text-xs text-app-muted/60 flex items-center gap-2">
                                                    <span className="flex gap-0.5">
                                                        {[0, 1, 2].map(i => (
                                                            <motion.span key={i} className="w-1 h-1 rounded-full bg-app-accent"
                                                                animate={{ opacity: [0.3, 1, 0.3] }}
                                                                transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.2 }} />
                                                        ))}
                                                    </span>
                                                    Fetching available models…
                                                </div>
                                            ) : currentModels.length === 0 ? (
                                                <div className="px-3 py-3 text-xs text-app-muted/60 text-center whitespace-pre-line">
                                                    {activeProviderValue === 'ollama'
                                                        ? ollamaAvailable
                                                            ? 'No models installed.\nRun: ollama pull llama3.2'
                                                            : 'Ollama not running'
                                                        : 'Add an API key in Settings → AI'}
                                                </div>
                                            ) : (
                                                currentModels.map(m => (
                                                    <button
                                                        key={m.value}
                                                        type="button"
                                                        onClick={() => selectModel(m.value)}
                                                        className={cn(
                                                            'w-full flex items-center justify-between px-3 py-2 text-xs transition-colors',
                                                            m.value === activeModel
                                                                ? 'text-app-accent bg-app-accent/10 font-medium'
                                                                : 'text-app-muted hover:bg-app-surface hover:text-app-text'
                                                        )}
                                                    >
                                                        <span>{m.label}</span>
                                                        {m.value === activeModel && (
                                                            <span className="text-[10px] opacity-50">active</span>
                                                        )}
                                                    </button>
                                                ))
                                            )}
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>

                            <div className="flex-1" />

                            <button
                                onClick={handleClose}
                                className="p-1 rounded text-app-muted hover:text-app-text hover:bg-app-surface transition-colors"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </div>

                        {/* ── Setup hint ── */}
                        {activeProviderNeedsSetup && (
                            <div className="px-4 py-2.5 flex items-start gap-2 bg-yellow-500/10 dark:bg-yellow-500/5 border-b border-yellow-500/30 dark:border-yellow-500/10">
                                <AlertTriangle className="w-3.5 h-3.5 text-yellow-600 dark:text-yellow-400/70 shrink-0 mt-0.5" />
                                <span className="text-xs text-yellow-700 dark:text-yellow-400/80">
                                    {activeProvider.value === 'ollama'
                                        ? "Ollama not detected. Install from ollama.com or run 'ollama serve'."
                                        : `No API key for ${activeProvider.label}. Go to Settings → AI to add it.`}
                                </span>
                            </div>
                        )}

                        {/* ── Chat area ── */}
                        <div
                            ref={chatContainerRef}
                            className="flex flex-col gap-3 px-4 py-3 min-h-[80px] max-h-[360px] overflow-y-auto border-b border-app-border/40"
                        >
                            {/* Empty state */}
                            {!submittedQuery && !isLoading && chatHistory.length === 0 && (
                                <div className="flex flex-col items-center justify-center py-6 gap-2">
                                    <Sparkles className="w-5 h-5 text-app-accent/30" />
                                    <p className="text-xs text-app-muted/40 text-center">Translate commands or ask anything about your terminal</p>
                                </div>
                            )}

                            {/* Archived Q&A pairs */}
                            {chatHistory.map((item, i) => (
                                <div key={i} className="flex flex-col gap-2">
                                    {/* User bubble */}
                                    <div className="flex justify-end">
                                        <div className="max-w-[82%] px-3 py-1.5 rounded-2xl rounded-tr-sm bg-app-accent/10 border border-app-accent/15 text-sm text-app-text/70">
                                            {item.query}
                                        </div>
                                    </div>
                                    {/* AI response (compact, no actions) */}
                                    <div className="flex gap-2">
                                        <div className="w-5 h-5 rounded-full bg-app-surface flex items-center justify-center shrink-0 mt-0.5">
                                            <Sparkles className="w-2.5 h-2.5 text-app-accent/50" />
                                        </div>
                                        <div className="flex-1 min-w-0 pt-0.5 opacity-60">
                                            {item.result?.answer && (
                                                <p className="text-sm text-app-text leading-relaxed line-clamp-3">{item.result.answer}</p>
                                            )}
                                            {item.result?.command && !item.result.answer && (
                                                <code className="text-sm font-mono text-app-text">$ {item.result.command}</code>
                                            )}
                                            {item.error && !item.result && (
                                                <p className="text-xs text-red-400/60">Error</p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}

                            {/* Current user message */}
                            {submittedQuery && (
                                <div className="flex justify-end">
                                    <div className="max-w-[82%] px-3 py-1.5 rounded-2xl rounded-tr-sm bg-app-accent/10 border border-app-accent/15 text-sm text-app-text">
                                        {submittedQuery}
                                    </div>
                                </div>
                            )}

                            {/* Loading */}
                            {isLoading && (
                                <div className="flex gap-2">
                                    <div className="w-5 h-5 rounded-full bg-app-surface flex items-center justify-center shrink-0 mt-0.5">
                                        <Sparkles className="w-2.5 h-2.5 text-app-accent" />
                                    </div>
                                    <div className="flex-1 pt-1.5">
                                        {streamingText ? (
                                            <code className="text-sm font-mono text-app-text/80 whitespace-pre-wrap break-all">
                                                {streamingText}
                                                <motion.span
                                                    className="inline-block w-1.5 h-3.5 bg-app-accent/60 ml-0.5 align-middle"
                                                    animate={{ opacity: [1, 0] }}
                                                    transition={{ duration: 0.6, repeat: Infinity }}
                                                />
                                            </code>
                                        ) : (
                                            <span className="flex gap-1 mt-0.5">
                                                {[0, 1, 2].map(j => (
                                                    <motion.span key={j} className="w-1.5 h-1.5 rounded-full bg-app-accent"
                                                        animate={{ opacity: [0.3, 1, 0.3] }}
                                                        transition={{ duration: 1, repeat: Infinity, delay: j * 0.2 }}
                                                    />
                                                ))}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Error */}
                            {error && !isLoading && (
                                <div className="flex gap-2">
                                    <div className={cn('w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5', errorCfg.bg)}>
                                        <errorCfg.icon className={cn('w-2.5 h-2.5', errorCfg.color)} />
                                    </div>
                                    <div className={cn('flex-1 rounded-xl px-3 py-2.5 border', errorCfg.bg, errorCfg.border)}>
                                        <p className={cn('text-sm font-medium', errorCfg.color)}>{errorCfg.title ?? error}</p>
                                        {errorCfg.hint && (
                                            <p className="mt-0.5 text-xs text-app-muted/70">{errorCfg.hint}</p>
                                        )}
                                        <div className="flex items-center gap-3 mt-2">
                                            {errorCfg.action && (
                                                <button
                                                    type="button"
                                                    onClick={errorCfg.action.fn}
                                                    className={cn('flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-md border transition-colors', errorCfg.color, 'border-current/30 hover:bg-current/10')}
                                                >
                                                    {errorKind === 'billing' ? <CreditCard className="w-3 h-3" />
                                                        : errorKind === 'invalid-key' || errorKind === 'no-key' ? <Settings className="w-3 h-3" />
                                                        : <RotateCw className="w-3 h-3" />}
                                                    {errorCfg.action.label}
                                                </button>
                                            )}
                                            <button type="button"
                                                onClick={() => { clearAiResult(); setQuery(''); inputRef.current?.focus(); }}
                                                className="text-xs text-app-muted/60 hover:text-app-muted transition-colors"
                                            >
                                                New query
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Current AI result */}
                            {result && !isLoading && (
                                <div className="flex gap-2">
                                    <div className="w-5 h-5 rounded-full bg-app-surface flex items-center justify-center shrink-0 mt-0.5">
                                        <Sparkles className="w-2.5 h-2.5 text-app-accent" />
                                    </div>
                                    <div className="flex-1 min-w-0 space-y-2">
                                        {/* Answer or command */}
                                        {result.answer ? (
                                            <p className="text-sm text-app-text leading-relaxed pt-0.5">{result.answer}</p>
                                        ) : (
                                            <>
                                                {/* Terminal-style editable command block */}
                                                <div className="rounded-lg bg-app-bg border border-app-border/60 px-3 py-2 flex items-center gap-2 group">
                                                    <span className="text-app-accent text-sm font-mono select-none shrink-0">$</span>
                                                    <input
                                                        type="text"
                                                        value={editedCommand}
                                                        onChange={e => setEditedCommand(e.target.value)}
                                                        className="flex-1 text-sm font-mono text-app-text bg-transparent focus:outline-none min-w-0"
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                                e.preventDefault();
                                                                if (result.safety !== 'dangerous') handleExecute();
                                                            }
                                                        }}
                                                    />
                                                    {isEdited && (
                                                        <span className="text-[10px] text-app-accent/50 shrink-0 opacity-0 group-focus-within:opacity-100 transition-opacity">edited</span>
                                                    )}
                                                </div>
                                                {/* Safety badge + explanation */}
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    {safetyInfo && SafetyIcon && (
                                                        <span className={cn('inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border', safetyInfo.badgeClass)}>
                                                            <SafetyIcon className="w-3 h-3" />
                                                            {safetyInfo.label}
                                                        </span>
                                                    )}
                                                    {result.explanation && <span className="text-xs text-app-muted">{result.explanation}</span>}
                                                </div>
                                            </>
                                        )}
                                        {/* Primary actions */}
                                        <div className="flex items-center gap-2">
                                            {!result.answer && (
                                                <button onClick={handleExecute}
                                                    className={cn('flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-all',
                                                        result.safety === 'dangerous'
                                                            ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20 hover:bg-amber-500/20'
                                                            : 'bg-app-accent text-white hover:opacity-90'
                                                    )}
                                                >
                                                    <Play className="w-3 h-3" />
                                                    {result.safety === 'dangerous' ? 'Run anyway' : <>Execute <span className="opacity-60 text-[10px]">↵</span></>}
                                                </button>
                                            )}
                                            <button onClick={handleCopy}
                                                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-app-surface text-app-muted hover:text-app-text transition-colors"
                                            >
                                                <Copy className="w-3 h-3" />
                                                {copied ? 'Copied!' : 'Copy'}
                                            </button>
                                            {!result.answer && (
                                                <button onClick={handleSaveSnippet} disabled={snippetSaved}
                                                    className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-app-surface text-app-muted hover:text-app-text disabled:opacity-50 transition-colors"
                                                >
                                                    <Bookmark className="w-3 h-3" />
                                                    {snippetSaved ? 'Saved!' : 'Save'}
                                                </button>
                                            )}
                                        </div>
                                        {/* Secondary actions */}
                                        <div className="flex items-center gap-3">
                                            <button onClick={handleRetry}
                                                className="flex items-center gap-1 text-xs text-app-muted hover:text-app-text transition-colors"
                                            >
                                                <RotateCw className="w-3 h-3" />
                                                Retry
                                            </button>
                                            {!result.answer && result.safety !== 'safe' && (
                                                <button onClick={handleMakeSafer}
                                                    className="flex items-center gap-1 text-xs text-app-muted hover:text-app-text transition-colors"
                                                >
                                                    <Shield className="w-3 h-3" />
                                                    Make safer
                                                </button>
                                            )}
                                            <button
                                                onClick={() => { clearAiResult(); setEditedCommand(''); setSnippetSaved(false); setQuery(''); inputRef.current?.focus(); }}
                                                className="text-xs text-app-muted hover:text-app-text transition-colors"
                                            >
                                                New query
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            <div ref={messagesEndRef} />
                        </div>

                        {/* ── Input (always at the bottom) ── */}
                        <div>
                            {/* History chips — shown when input is focused, empty, and history exists */}
                            <AnimatePresence>
                                {inputFocused && !query && !result && !error && !isLoading && aiQueryHistory.length > 0 && (
                                    <motion.div
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: 'auto' }}
                                        exit={{ opacity: 0, height: 0 }}
                                        transition={{ duration: 0.15 }}
                                        className="px-3 pt-2 pb-0 flex flex-wrap gap-1.5 overflow-hidden"
                                    >
                                        {aiQueryHistory.slice(0, 4).map((h, i) => (
                                            <button
                                                key={i}
                                                type="button"
                                                onMouseDown={e => {
                                                    // Use mousedown so blur doesn't hide the chips before click fires
                                                    e.preventDefault();
                                                    setQuery(h);
                                                    setTimeout(() => inputRef.current?.focus(), 0);
                                                }}
                                                className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-app-surface border border-app-border/60 text-app-muted hover:text-app-text hover:border-app-accent/40 transition-all max-w-[200px]"
                                            >
                                                <Clock className="w-2.5 h-2.5 shrink-0" />
                                                <span className="truncate">{h}</span>
                                            </button>
                                        ))}
                                    </motion.div>
                                )}
                            </AnimatePresence>

                            <div className="flex items-start gap-2 px-3 py-2.5">
                                <textarea
                                    ref={inputRef}
                                    rows={1}
                                    value={query}
                                    onChange={e => { setQuery(e.target.value); setAiHistoryIndex(-1); autoResize(e.target); }}
                                    onKeyDown={handleKeyDown}
                                    onFocus={() => setInputFocused(true)}
                                    onBlur={() => setInputFocused(false)}
                                    placeholder="Describe what you want to do…"
                                    className="flex-1 bg-transparent text-sm text-app-text placeholder:text-app-muted/40 focus:outline-none resize-none overflow-hidden leading-relaxed mt-0.5"
                                    disabled={isLoading}
                                />
                                {/* History position badge */}
                                {aiHistoryIndex >= 0 && (
                                    <span className="text-[10px] text-app-muted/50 shrink-0 self-center tabular-nums">
                                        {aiHistoryIndex + 1}/{aiQueryHistory.length}
                                    </span>
                                )}
                                <button
                                    onClick={handleSubmit}
                                    disabled={!query.trim() || isLoading}
                                    className="p-1.5 rounded-lg bg-app-accent/10 text-app-accent hover:bg-app-accent hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all shrink-0"
                                    title="Translate (Enter)"
                                >
                                    <ArrowRight className="w-3.5 h-3.5" />
                                </button>
                            </div>

                            {/* Keyboard hints */}
                            <div className="flex items-center gap-3 px-3 pb-2 -mt-1">
                                {!result && !error && (
                                    <span className="text-[10px] font-mono text-app-muted/30">↵ translate</span>
                                )}
                                {result && !result.answer && result.safety !== 'dangerous' && (
                                    <span className="text-[10px] font-mono text-app-muted/30">↵ execute</span>
                                )}
                                {!result && aiQueryHistory.length > 0 && (
                                    <span className="text-[10px] font-mono text-app-muted/30">↑↓ history</span>
                                )}
                                {!result && !error && (
                                    <span className="text-[10px] font-mono text-app-muted/30">⇧↵ newline</span>
                                )}
                                <span className="text-[10px] font-mono text-app-muted/30">Esc close</span>
                            </div>
                        </div>

                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
