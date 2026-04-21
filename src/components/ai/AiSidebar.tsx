import { useRef, useState, useEffect, useCallback, memo } from 'react';
import {
    Sparkles, X, Trash2,
    Terminal, FileCode, Send, Square,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '../../lib/utils';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { AiChatMessage } from './AiChatMessage';
import { AiProviderModelPicker } from './AiProviderModelPicker';
import { ConversationThread } from './ConversationThread';
import { AgentIcon } from './AgentIcon';
import {
    DEFAULT_MODEL,
    type ProviderValue,
} from './providerCatalog';
import { useAiProviderModels } from './useAiProviderModels';
import { collectAiRequestContext } from '../../lib/aiContext';
import { startAgentRun, stopAgentRun, clearBrainSessions } from '../../ai/services/aiClient';
import { useAgentRunStore } from '../../ai/store/agentRunStore';
import {
    shouldTreatAgentInputAsAsk,
    submitAgentGoal,
    submitAskQuery,
} from './sidebarSubmit';
import { useAiSidebarResize } from './useAiSidebarResize';

// ──────────────────────────────────────────────────────────────────────────
// Types & Constants
// ──────────────────────────────────────────────────────────────────────────

interface MessageListProps {
    connectionId: string | null;
    isLoading: boolean;
    streamingText: string;
    onRunCommand: (command: string) => void;
}

const MessageList = memo(function MessageList({
    connectionId, isLoading, streamingText, onRunCommand,
}: MessageListProps) {
    const history = useAppStore(
        useShallow(s => connectionId ? (s.aiDisplayHistory?.[connectionId] ?? []) : [])
    );
    const endRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [history, streamingText]);

    return (
        <div className="flex-1 overflow-y-auto min-h-0 py-2">
            {history.length === 0 && !isLoading && (
                <div className="flex flex-col items-center justify-center h-full gap-3 pb-8 px-4">
                    <div className="w-10 h-10 rounded-full bg-app-accent/10 flex items-center justify-center">
                        <Sparkles size={18} className="text-app-accent" />
                    </div>
                    <div className="text-center space-y-1">
                        <p className="text-[12px] font-medium text-app-text">AI Assistant</p>
                        <p className="text-[11px] text-app-muted leading-relaxed max-w-[200px]">
                            Ask about your connections, get help with SSH commands, or debug issues.
                        </p>
                    </div>
                </div>
            )}

            {history.map((entry, i) => (
                <AiChatMessage key={entry.id ?? i} entry={entry} onRunCommand={onRunCommand} />
            ))}

            {/* Streaming indicator */}
            {isLoading && (
                <div className="px-3 py-2 animate-in fade-in duration-200">
                    <div className="flex items-start gap-2 ml-1">
                        <div className="shrink-0 mt-1 w-5 h-5 rounded-full bg-purple-500/15 flex items-center justify-center">
                            <AgentIcon size={11} className="text-purple-400" />
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

            <div ref={endRef} className="h-2" />
        </div>
    );
});

// ──────────────────────────────────────────────────────────────────────────
// AiSidebar
// ──────────────────────────────────────────────────────────────────────────

interface AiSidebarProps {
    connectionId: string | null;
    activeTermId?: string | null;
    onRunCommand?: (connectionId: string, command: string) => void;
}

export function AiSidebar({ connectionId, activeTermId, onRunCommand }: AiSidebarProps) {

    // ── Store: UI & Ask ──────────────────────────────────────────────────
    const isOpen              = useAppStore(s => s.isAiSidebarOpen);
    const closeAiSidebar      = useAppStore(s => s.closeAiSidebar);
    const isLoading           = useAppStore(s => s.aiLoading);
    const streamingText       = useAppStore(s => s.aiStreamingText);
    const submitAiQuery       = useAppStore(s => s.submitAiQuery);
    const clearDisplayHistory = useAppStore(s => s.clearDisplayHistory);
    const addToDisplayHistory = useAppStore(s => s.addToDisplayHistory);
    const pushAiHistory       = useAppStore(s => s.pushAiHistory);
    const aiSettings          = useAppStore(s => s.settings.ai);
    const updateAiSettings    = useAppStore(s => s.updateAiSettings);
    const checkOllama         = useAppStore(s => s.checkOllama);
    const getOllamaModels     = useAppStore(s => s.getOllamaModels);
    const fetchProviderModels = useAppStore(s => s.getProviderModels);
    const attachedContext     = useAppStore(s => s.aiAttachedContext);
    const setAttachedContext  = useAppStore(s => s.setAiAttachedContext);
    const showToast           = useAppStore(s => s.showToast);

    // ── Store: Agent V2 ──────────────────────────────────────────────────
    const aiMode    = useAppStore(s => s.aiMode);
    const setAiMode = useAppStore(s => s.setAiMode);
    // Connection name for brain folder naming (e.g. "production-server")
    const connectionName = useAppStore(s =>
        connectionId ? s.connections.find(c => c.id === connectionId)?.name ?? null : null
    );

    const agentScope  = connectionId ?? 'global';
    // Use getState for mutations only — never subscribe to the whole store (causes infinite re-render).
    const agentAct    = useAgentRunStore.getState;
    const activeRunId = useAgentRunStore(s => s.activeRunIds[agentScope] ?? null);

    // ── Local state ──────────────────────────────────────────────────────
    const [query, setQuery] = useState('');
    const inputRef          = useRef<HTMLTextAreaElement>(null);

    const isAgentMode  = aiMode === 'agent';
    const agentRunning = activeRunId !== null;

    // ── Resize ───────────────────────────────────────────────────────────
    const {
        width,
        isAnimating,
        transition,
        sidebarOuterRef,
        sidebarInnerRef,
        handleMouseDown,
        handleAnimationStart,
        handleAnimationComplete,
    } = useAiSidebarResize();
    // Provider / Model
    const activeProviderValue = (aiSettings?.provider ?? 'ollama') as ProviderValue;
    const {
        activeProvider,
        currentModels,
        activeModel,
        modelShort,
        providerNeedsSetup,
        ollamaAvailable,
    } = useAiProviderModels({
        isOpen,
        provider: activeProviderValue,
        configuredModel: aiSettings?.model,
        checkOllama,
        getOllamaModels,
        fetchProviderModels,
    });

    /**
     * Auto-heal Ollama model selection:
     * - if provider is Ollama,
     * - Ollama is reachable,
     * - model list exists,
     * - current configured model is empty or no longer present,
     * then select the first available model so the user isn't stuck in a
     * permanent "No model selected" state.
     */
    useEffect(() => {
        if (!isOpen || activeProviderValue !== 'ollama' || !ollamaAvailable) return;
        if (currentModels.length === 0) return;

        const configuredModel = (aiSettings?.model ?? '').trim();
        const isConfiguredModelValid = configuredModel.length > 0
            && currentModels.some((model) => model.value === configuredModel);

        if (isConfiguredModelValid) return;

        const fallbackModel = currentModels[0]?.value;
        if (!fallbackModel) return;
        void updateAiSettings({ model: fallbackModel }).catch((error: unknown) => {
            console.error('Failed to auto-select fallback model', error);
            showToast('warning', 'Could not auto-select the fallback model. Please choose one manually.');
        });
    }, [
        isOpen,
        activeProviderValue,
        ollamaAvailable,
        currentModels,
        aiSettings?.model,
        updateAiSettings,
        showToast,
    ]);

    useEffect(() => {
        const h = (e: Event) => {
            setQuery((e as CustomEvent<string>).detail);
            inputRef.current?.focus();
        };
        window.addEventListener('ai-sidebar:suggestion', h);
        return () => window.removeEventListener('ai-sidebar:suggestion', h);
    }, []);

    // ── Handlers ─────────────────────────────────────────────────────────
    const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setQuery(e.target.value);
        const ta = e.target;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    }, []);

    const handleRunCommand = useCallback((cmd: string) => {
        if (connectionId && onRunCommand) onRunCommand(connectionId, cmd);
    }, [connectionId, onRunCommand]);

    const handleClearHistory = useCallback(() => {
        if (connectionId) clearDisplayHistory(connectionId);
    }, [connectionId, clearDisplayHistory]);

    // Ask mode
    const handleSubmitAsk = useCallback(async (trimmed: string) => {
        await submitAskQuery({
            trimmed,
            connectionId,
            resetInput: () => {
                setQuery('');
                if (inputRef.current) inputRef.current.style.height = 'auto';
            },
            collectContext: () => collectAiRequestContext(
                connectionId ?? undefined,
                activeTermId ?? null,
                attachedContext,
                { includeRecentOutput: true },
            ),
            submitAiQuery,
        });
    }, [connectionId, activeTermId, attachedContext, submitAiQuery]);

    // ── Agent V2 handlers ────────────────────────────────────────────────

    /** Collect terminal context snapshot (redaction always on) */
    const getCtx = useCallback(async (): Promise<Record<string, unknown>> => {
        return collectAiRequestContext(
            connectionId ?? undefined,
            activeTermId ?? null,
            attachedContext,
            { includeRecentOutput: true },
        );
    }, [connectionId, activeTermId, attachedContext]);

    const handleSubmitAgent = useCallback(async (goal: string) => {
        await submitAgentGoal({
            goal,
            agentRunning,
            agentScope,
            connectionId,
            connectionLabel: connectionName,
            resetInput: () => {
                setQuery('');
                if (inputRef.current) inputRef.current.style.height = 'auto';
            },
            collectContext: getCtx,
            agentActions: agentAct(),
            startAgentRun,
        });
    }, [agentRunning, agentScope, connectionId, connectionName, getCtx]);

    const handleStopAgent = useCallback(async () => {
        if (!activeRunId) return;
        try {
            await stopAgentRun(activeRunId);
        } catch (error) {
            console.error('[AiSidebar] Failed to stop agent run', { activeRunId, error });
            showToast('error', `Failed to stop agent run ${activeRunId}. Please try again.`);
        }
    }, [activeRunId, showToast]);

    const handleSubmit = useCallback(async () => {
        const trimmed = query.trim();
        if (!trimmed || isLoading || agentRunning) return;
        pushAiHistory(trimmed);

        if (providerNeedsSetup) {
            const setupMessage = activeProviderValue === 'ollama'
                ? (!ollamaAvailable
                    ? 'Ollama is not running. Start Ollama or switch to another provider.'
                    : 'No Ollama model found. Pull a model (for example: ollama pull llama3.2) or switch provider.')
                : 'No model selected for the current provider. Please select a model and try again.';

            if (isAgentMode) {
                agentAct().addError(agentScope, setupMessage);
            } else if (connectionId) {
                addToDisplayHistory(connectionId, {
                    id: crypto.randomUUID(),
                    query: trimmed,
                    result: null,
                    error: setupMessage,
                    contextSnapshot: attachedContext?.content ?? null,
                    timestamp: Date.now(),
                });
            } else {
                showToast('warning', setupMessage);
            }
            return;
        }

        if (isAgentMode) {
            if (shouldTreatAgentInputAsAsk(trimmed)) {
                setAiMode('ask');
                await handleSubmitAsk(trimmed);
            } else {
                await handleSubmitAgent(trimmed);
            }
        } else {
            await handleSubmitAsk(trimmed);
        }
    }, [
        query,
        isLoading,
        agentRunning,
        isAgentMode,
        pushAiHistory,
        providerNeedsSetup,
        activeProviderValue,
        ollamaAvailable,
        agentScope,
        connectionId,
        attachedContext,
        addToDisplayHistory,
        showToast,
        handleSubmitAgent,
        handleSubmitAsk,
        setAiMode,
    ]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
    }, [handleSubmit]);

    const handleClearAgentThread = useCallback(async () => {
        const sessionPaths = agentAct().getSessionPaths(agentScope);
        agentAct().clearConversation(agentScope);

        if (sessionPaths.length > 0) {
            try {
                await clearBrainSessions(sessionPaths);
            } catch (err) {
                console.error('[AiSidebar] Failed to clear brain sessions:', err);
            }
        }
    }, [agentScope]);

    // ── Render ───────────────────────────────────────────────────────────
    return (
        <AnimatePresence>
            {isOpen && (
                <motion.aside
                    key="ai-sidebar"
                    ref={sidebarOuterRef as React.RefObject<HTMLElement>}
                    initial={{ width: 0 }}
                    animate={{ width }}
                    exit={{ width: 0 }}
                    transition={transition}
                    onAnimationStart={handleAnimationStart}
                    onAnimationComplete={handleAnimationComplete}
                    className={cn('relative flex shrink-0', isAnimating && 'overflow-hidden')}
                    style={{ minWidth: 0 }}
                >
                    {/* Drag handle */}
                    <div
                        className="absolute top-0 bottom-0 left-0 w-1 cursor-col-resize z-[60] hover:bg-app-accent/60 transition-colors"
                        onMouseDown={handleMouseDown}
                    />

                        {/* Inner panel */}
                        <div
                            ref={sidebarInnerRef}
                            className="flex flex-col shrink-0 border-l border-app-border/40 bg-app-bg h-full"
                            style={{ width }}
                        >
                            {/* ── Header (clean & minimalist) ── */}
                            <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-3 bg-app-bg z-10 w-full relative">
                                <div className="flex items-center gap-2 min-w-0">
                                    <Sparkles size={14} className="text-app-accent shrink-0" />
                                    <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-app-text/40 truncate">
                                        Assistant
                                    </span>
                                </div>
                            <div className="flex items-center gap-0.5">
                                <button
                                    onClick={isAgentMode ? handleClearAgentThread : handleClearHistory}
                                    className="p-1 rounded hover:bg-app-surface/60 text-app-muted hover:text-app-danger transition-colors"
                                    title="Clear"
                                >
                                    <Trash2 size={13} />
                                </button>
                                <button
                                    onClick={closeAiSidebar}
                                    className="p-1 rounded hover:bg-app-surface/60 text-app-muted hover:text-app-text transition-colors"
                                    title="Close"
                                >
                                    <X size={13} />
                                </button>
                            </div>
                        </div>

                        {/* ── Content area — chat OR agent feed ── */}
                        <AnimatePresence mode="wait" initial={false}>
                            {!isAgentMode ? (
                                <motion.div
                                    key="ask-content"
                                    className="flex-1 min-h-0 flex flex-col"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    transition={{ duration: 0.15 }}
                                >
                                    <MessageList
                                        connectionId={connectionId}
                                        isLoading={isLoading}
                                        streamingText={streamingText}
                                        onRunCommand={handleRunCommand}
                                    />
                                </motion.div>
                            ) : (
                                <motion.div
                                    key="agent-content"
                                    className="flex-1 min-h-0 flex flex-col"
                                    initial={{ opacity: 0, y: 8 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: 8 }}
                                    transition={{ duration: 0.18, ease: 'easeOut' }}
                                >
                                    <ConversationThread
                                        scope={agentScope}
                                        activeRunId={activeRunId}
                                        isLocal={connectionId === null}
                                    />
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {/* ── Input area (Restored & Refined) ── */}
                        <div className="shrink-0 border-t border-app-border/40 bg-app-panel/30 p-2.5 space-y-2">
                            {/* Attached context pill */}
                            {attachedContext && (
                                <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-app-accent/8 border border-app-accent/20 text-[10px] text-app-accent">
                                    {attachedContext.type === 'terminal' ? <Terminal size={9} /> : <FileCode size={9} />}
                                    <span className="truncate flex-1">{attachedContext.label}</span>
                                    <button onClick={() => setAttachedContext(null)} className="shrink-0 hover:text-app-danger transition-colors">
                                        <X size={9} />
                                    </button>
                                </div>
                            )}

                            {/* Textarea + send (Restored Bounding Box for Chat Consistency) */}
                            <div className="relative flex items-end gap-1.5 p-1 bg-app-surface/30 border border-app-border/40 rounded-xl focus-within:border-app-accent/40 focus-within:bg-app-surface/50 focus-within:ring-2 focus-within:ring-app-accent/10 transition-all shadow-sm">
                                <textarea
                                    ref={inputRef}
                                    value={query}
                                    onChange={handleInput}
                                    onKeyDown={handleKeyDown}
                                    placeholder={isAgentMode ? 'Describe a task for the agent…' : 'Ask anything…'}
                                    disabled={isLoading || agentRunning}
                                    rows={1}
                                    className={cn(
                                        'flex-1 resize-none bg-transparent border-none px-2.5 py-1.5 text-[12px] text-app-text placeholder:text-app-muted/50 outline-none focus:ring-0 leading-[1.6]',
                                        'min-h-[32px] max-h-[120px] overflow-y-auto',
                                        (isLoading || agentRunning) && 'opacity-60 cursor-not-allowed',
                                    )}
                                />
                                {agentRunning ? (
                                    <button
                                        onClick={handleStopAgent}
                                        className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg bg-app-danger/10 text-app-danger hover:bg-app-danger/20 active:scale-95 transition-all outline-none"
                                        title="Stop Agent"
                                    >
                                        <Square size={12} fill="currentColor" />
                                    </button>
                                ) : (
                                    <button
                                        onClick={handleSubmit}
                                        disabled={isLoading || !query.trim()}
                                        className={cn(
                                            'shrink-0 flex items-center justify-center w-8 h-8 rounded-lg transition-all outline-none',
                                            isLoading
                                                ? 'bg-app-surface/60 text-app-accent animate-pulse cursor-not-allowed'
                                                : query.trim()
                                                    ? 'bg-gradient-to-r from-app-accent to-purple-500 text-white shadow shadow-app-accent/20 hover:brightness-110 active:scale-95'
                                                    : 'bg-app-surface/60 text-app-muted/50 cursor-not-allowed',
                                        )}
                                    >
                                        {isLoading ? <Square size={12} fill="currentColor" /> : <Send size={13} className="-ml-0.5" />}
                                    </button>
                                )}
                            </div>

                            {/* Bottom bar: Agent toggle pill + provider/model pickers */}
                            <div className="flex items-center gap-2 px-0.5">

                                {/* ── Sliding Mode Toggle ── */}
                                <div className="relative flex items-center bg-app-surface/60 rounded-full p-0.5 border border-app-border/40">
                                    <motion.div
                                        className="absolute h-5 bg-app-bg border border-app-border/40 shadow-sm rounded-full"
                                        initial={false}
                                        animate={{
                                            x: isAgentMode ? 46 : 0,
                                            width: isAgentMode ? 52 : 46
                                        }}
                                        transition={{ type: "spring", stiffness: 500, damping: 40 }}
                                    />
                                    <button
                                        onClick={() => setAiMode('ask')}
                                        className={cn(
                                            "relative z-10 px-3 py-0.5 text-[10px] font-bold transition-colors",
                                            !isAgentMode ? "text-app-text" : "text-app-muted/50 hover:text-app-muted"
                                        )}
                                    >
                                        ASK
                                    </button>
                                    <button
                                        onClick={() => setAiMode('agent')}
                                        className={cn(
                                            "relative z-10 px-3 py-0.5 text-[10px] font-bold transition-colors",
                                            isAgentMode ? "text-app-accent" : "text-app-muted/50 hover:text-app-muted"
                                        )}
                                    >
                                        AGENT
                                    </button>
                                </div>

                                {/* Spacer */}
                                <div className="flex-1" />

                                {/* Provider / Model */}
                                <AiProviderModelPicker
                                    activeProvider={activeProvider}
                                    activeProviderValue={activeProviderValue}
                                    activeModel={activeModel}
                                    modelShort={modelShort}
                                    currentModels={currentModels}
                                    onSelectProvider={(provider) => {
                                        updateAiSettings({
                                            provider,
                                            model: DEFAULT_MODEL[provider] ?? '',
                                        });
                                    }}
                                    onSelectModel={(model) => {
                                        updateAiSettings({ model });
                                    }}
                                />
                            </div>
                        </div>
                    </div>
                </motion.aside>
            )}
        </AnimatePresence>
    );
}
