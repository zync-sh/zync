/**
 * ConversationThread — the V2 agent conversation UI.
 *
 * Mounts Tauri event listeners for the running agent run and updates the
 * agentRunStore in real time. Renders the message list and handles
 * checkpoint interactions.
 *
 * Drop this in place of <AgentActivityFeed /> in AiSidebar.tsx.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AlertTriangle, CheckCircle2, FolderOpen, Loader2, Sparkles, XCircle } from 'lucide-react';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { respondToCheckpoint, whitelistCommand } from '../../ai/services/aiClient';
import { useAgentRunStore } from '../../ai/store/agentRunStore';
import { createAgentEventScope, createAgentStreamBuffer } from '../../ai/store/agentStreamRuntime';
import type {
    AgentCheckpointEvent,
    AgentDoneEvent,
    AgentErrorEvent,
    AgentPlanEvent,
    AgentThinkingEvent,
    ConversationMessage,
    ToolDiffEvent,
    ToolDoneEvent,
    ToolOutputEvent,
    ToolStartEvent,
} from '../../ai/types/agent';
import { cn } from '../../lib/utils';
import { AgentIcon } from './AgentIcon';
import { AiSetupErrorCard } from './AiSetupErrorCard';
import { CheckpointBlock } from './CheckpointBlock';
import {
    CONVERSATION_PAGE_SIZE,
    type ConversationPageAnchor,
    resolveConversationPage,
} from './conversationPage';
import { PlanBubble } from './PlanBubble';
import { ToolCallBlock } from './ToolCallBlock';

// ── Props ──────────────────────────────────────────────────────────────────────

interface ConversationThreadProps {
    /** Scope key — connectionId or null (→ "global"). */
    scope: string;
    /** The run_id the sidebar just started, if any. Used to filter events. */
    activeRunId: string | null;
    /** Whether this agent is running against the local machine (no SSH). */
    isLocal?: boolean;
}

// Stable fallback so the Zustand selector never returns a new [] reference on every snapshot call.
const NO_MESSAGES: ConversationMessage[] = [];
const MARKDOWN_PLUGINS = [remarkGfm];

// ── Empty state ────────────────────────────────────────────────────────────────

/** Explains the elevated impact of agent actions executed on the user's own machine. */
function LocalWarningBanner() {
    return (
        <div className="mx-3 mt-3 flex items-start gap-2 px-3 py-2.5 rounded-lg border border-yellow-500/20 bg-yellow-500/5">
            <AlertTriangle
                size={12}
                className="shrink-0 mt-px text-yellow-400/70"
            />
            <p className="text-[11px] text-yellow-300/70 leading-relaxed">
                No SSH connection selected. Commands will run on{' '}
                <span className="font-medium text-yellow-300/90">your local machine</span>.
            </p>
        </div>
    );
}

/** Presents initial agent guidance with local execution context when applicable. */
function EmptyState({ isLocal }: { isLocal?: boolean }) {
    return (
        <div className="flex flex-col flex-1">
            {isLocal && <LocalWarningBanner />}
            <div className="flex flex-col items-center justify-center flex-1 gap-3 px-6 py-12 text-center">
                <div className="w-10 h-10 rounded-full bg-app-accent/10 border border-app-accent/20 flex items-center justify-center">
                    <Sparkles
                        size={16}
                        className="text-app-accent"
                    />
                </div>
                <div className="space-y-1">
                    <p className="text-[12px] font-semibold text-app-text/60">Agent ready</p>
                    <p className="text-[11px] text-app-muted/50 leading-relaxed max-w-[180px]">
                        Describe a task and the agent will plan and execute it autonomously.
                    </p>
                </div>
            </div>
        </div>
    );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Converts technical-looking terms wrapped in single quotes (e.g. 'index.js')
 * into markdown backticks so they render with the proper monospace styling.
 */
function formatTechnicalTerms(text: string): string {
    if (!text) {
        return text;
    }
    // Match 'something' where 'something' has no spaces and at least one character
    return text.replace(/'([^'\s]+)'/g, '`$1`');
}

// ── Message renderers ──────────────────────────────────────────────────────────

/** Renders streamed reasoning and an activity cursor while its run is active. */
function ThinkingBubble({ text, isActive }: { text: string; isActive: boolean }) {
    const deferredText = useDeferredValue(text);
    const displayedText = isActive ? deferredText : text;
    return (
        <div className="flex items-start gap-2.5">
            <div className="shrink-0 mt-0.5 w-6 h-6 rounded-full bg-gradient-to-br from-purple-500/20 to-app-accent/20 border border-purple-500/30 flex items-center justify-center">
                <AgentIcon
                    size={12}
                    className="text-purple-400"
                />
            </div>
            <div
                className="flex-1 min-w-0 pt-0.5 text-[12px] text-app-text/85 leading-relaxed
        [&_p]:mb-1.5 [&_p:last-child]:mb-0
        [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:mb-1.5
        [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:mb-1.5
        [&_li]:mb-0.5
        [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-app-surface/60 [&_code]:border [&_code]:border-app-border/40 [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-app-accent/90
        [&_pre]:p-2 [&_pre]:rounded-lg [&_pre]:bg-black/20 [&_pre]:overflow-x-auto [&_pre]:mb-1.5
        [&_pre_code]:bg-transparent [&_pre_code]:border-0 [&_pre_code]:p-0 [&_pre_code]:text-app-text/80
        [&_strong]:text-app-text [&_em]:text-app-text/70"
            >
                <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>
                    {formatTechnicalTerms(displayedText)}
                </ReactMarkdown>
                {isActive && (
                    <span className="inline-block w-[2px] h-[13px] ml-0.5 bg-app-accent/70 align-bottom animate-pulse" />
                )}
            </div>
        </div>
    );
}

/** Displays the user goal that initiated an agent turn. */
function UserBubble({ text }: { text: string }) {
    return (
        <div className="flex justify-end">
            <div className="max-w-[85%] px-3 py-2 rounded-2xl rounded-tr-sm bg-app-accent/10 border border-app-accent/20">
                <p className="text-[12px] text-app-text/90 leading-relaxed whitespace-pre-wrap break-words">
                    {text}
                </p>
            </div>
        </div>
    );
}

/** Shows the final run summary, action outcomes and optional saved-session link. */
function DoneBubble({
    success,
    summary,
    actions = [],
    sessionPath,
}: {
    success: boolean;
    summary: string;
    actions?: string[];
    sessionPath?: string;
}) {
    /** Opens the saved session location through the application's existing file reveal command. */
    const revealSession = () => {
        if (sessionPath) {
            invoke('shell_open', { path: sessionPath }).catch((error) => {
                console.error('[DoneBubble] Failed to open session folder:', {
                    sessionPath,
                    error,
                });
            });
        }
    };

    const failed = actions.filter((a) => a.startsWith('✗'));
    const succeeded = actions.filter((a) => !a.startsWith('✗'));
    const hasMixed = failed.length > 0 && succeeded.length > 0;

    return (
        <div
            className={cn(
                'rounded-xl border overflow-hidden',
                success
                    ? 'bg-emerald-500/5 border-emerald-500/20'
                    : 'bg-app-surface/20 border-app-border/20',
            )}
        >
            {/* Header row */}
            <div className="flex items-start gap-2 px-3 py-2.5">
                {success ? (
                    <CheckCircle2
                        size={14}
                        className="shrink-0 text-emerald-400 mt-0.5"
                    />
                ) : (
                    <XCircle
                        size={14}
                        className="shrink-0 text-app-muted mt-0.5"
                    />
                )}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                        <p className="text-[11px] font-bold tracking-widest uppercase text-app-muted/60">
                            {success ? 'Done' : 'Cancelled'}
                        </p>
                        {/* Stats badge */}
                        {actions.length > 0 && (
                            <span className="text-[10px] text-app-muted/40">
                                {hasMixed
                                    ? `${succeeded.length} ok · ${failed.length} failed`
                                    : `${actions.length} step${actions.length !== 1 ? 's' : ''}`}
                            </span>
                        )}
                    </div>
                    {summary && (
                        <div
                            className="text-[12px] text-app-text/80 leading-relaxed
              [&_p]:mb-0 [&_strong]:text-app-text [&_em]:text-app-text/70
              [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-app-surface/60
              [&_code]:border [&_code]:border-app-border/30 [&_code]:font-mono [&_code]:text-[11px]"
                        >
                            <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>
                                {formatTechnicalTerms(summary)}
                            </ReactMarkdown>
                        </div>
                    )}
                </div>
            </div>

            {/* Action log */}
            {actions.length > 0 && (
                <div className="border-t border-app-border/20 px-3 py-2 space-y-0.5">
                    {actions.map((action, i) => {
                        const isFailed = action.startsWith('✗');
                        return (
                            <p
                                key={`${action}-${i}`}
                                className={cn(
                                    'text-[11px] font-mono leading-relaxed truncate',
                                    isFailed ? 'text-red-400/70' : 'text-app-muted/60',
                                )}
                            >
                                {action}
                            </p>
                        );
                    })}
                </div>
            )}

            {/* Brain session link */}
            {sessionPath && (
                <div className="border-t border-app-border/20 px-3 py-1.5">
                    <button
                        type="button"
                        onClick={revealSession}
                        aria-label={`Open session folder: ${sessionPath}`}
                        className="flex items-center gap-1.5 text-[10px] text-app-muted/50 hover:text-app-accent/70 transition-colors"
                    >
                        <FolderOpen size={10} />
                        <span className="truncate font-mono">
                            {sessionPath.split(/[\\/]/).slice(-2).join('/')}
                        </span>
                    </button>
                </div>
            )}
        </div>
    );
}

/** Presents terminal run errors using the shared actionable AI setup-error surface. */
function ErrorBubble({ message }: { message: string }) {
    return (
        <div className="px-1">
            <AiSetupErrorCard
                message={message}
                className="flex flex-col gap-2 px-3 py-2.5 rounded-xl border bg-red-500/5 border-red-500/20 text-red-300/90"
            />
        </div>
    );
}

// ── Inline running status ──────────────────────────────────────────────────────

const TOOL_STATUS_LABELS: Record<string, string> = {
    run_command: 'Running command...',
    read_file: 'Reading file...',
    write_file: 'Editing file...',
    list_files: 'Listing files...',
    ask_user: 'Waiting for input...',
};

/** Derives current execution feedback from the newest running tool or reasoning bubble. */
function RunningStatusBar({ messages }: { messages: ConversationMessage[] }) {
    // Find the most informative current status from the last few messages
    let label = 'Thinking...';
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.type === 'tool-call' && msg.status === 'running') {
            label = TOOL_STATUS_LABELS[msg.toolName] ?? 'Running...';
            break;
        }
        if (msg.type === 'thinking') {
            break; // still in thinking phase
        }
    }

    return (
        <div className="flex items-center gap-1.5 px-1 py-1.5 text-[11px] text-app-accent/60 font-medium">
            <Loader2
                size={10}
                className="animate-spin shrink-0 text-app-accent/70"
            />
            <span>{label}</span>
        </div>
    );
}

// ── Main Component ─────────────────────────────────────────────────────────────

/** Owns scoped agent event subscriptions and applies authoritative terminal tool snapshots. */
export function ConversationThread({ scope, activeRunId, isLocal }: ConversationThreadProps) {
    // Only subscribe to the messages slice. Use stable NO_MESSAGES fallback — a new [] on every
    // getSnapshot call causes React's concurrent mode to detect a false "change" and loop infinitely.
    const messages = useAgentRunStore((s) => s.conversations[scope] ?? NO_MESSAGES);
    const bottomRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const [pageAnchor, setPageAnchor] = useState<ConversationPageAnchor | null>(null);
    const hasMultiplePages = messages.length > CONVERSATION_PAGE_SIZE;
    const page = resolveConversationPage(messages, pageAnchor);
    const toolExpansions = useMemo(() => new Map<string, boolean>(), [scope]);
    const getToolExpansion = useCallback((id: string) => toolExpansions.get(id), [toolExpansions]);
    const setToolExpansion = useCallback(
        (id: string, expanded: boolean) => {
            toolExpansions.set(id, expanded);
        },
        [toolExpansions],
    );
    useEffect(() => {
        setPageAnchor(null);
    }, [scope, hasMultiplePages]);
    useEffect(() => {
        if (!messages.length) {
            toolExpansions.clear();
        }
    }, [messages.length, toolExpansions]);
    useEffect(() => {
        if (pageAnchor) {
            scrollRef.current?.scrollTo({ top: 0 });
        }
    }, [pageAnchor]);

    // Helper: access store actions without subscribing (avoids re-render loops).
    const act = useAgentRunStore.getState;

    // Auto-scroll to bottom on new messages
    useEffect(() => {
        if (!pageAnchor) {
            bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
        }
    }, [messages.length, pageAnchor]);

    // ── Mount Tauri event listeners ────────────────────────────────────────────
    useEffect(() => {
        if (!activeRunId) {
            return;
        }

        const runId = activeRunId;
        let cancelled = false;
        /** A cleared thread or replacement run must never receive this effect's delayed chunks. */
        const ownsRun = () => act().getActiveRunId(scope) === runId;
        const events = createAgentEventScope(runId, ownsRun);
        const stream = createAgentStreamBuffer({
            isCurrent: ownsRun,
            /** Applies one joined reasoning batch through the transient store boundary. */
            appendThinking: (text) => act().appendThinking(scope, runId, text),
            /** Applies one joined tool batch while the store retains final-result ownership guards. */
            appendToolOutput: (toolCallId, text) => act().appendToolOutput(scope, toolCallId, text),
        });

        /** Installs independent native events while the scope owns each eventual unlisten callback. */
        function register<T extends { runId: string }>(
            event: string,
            handle: (payload: T) => void,
        ) {
            return events.register<T>(
                (forward) => listen<T>(event, ({ payload }) => forward(payload)),
                handle,
            );
        }

        void Promise.all([
            register<AgentThinkingEvent>('ai:agent-thinking', (payload) => {
                stream.appendThinking(payload.text);
            }),
            register<ToolStartEvent>('ai:tool-start', (payload) => {
                stream.flush();
                act().addToolCall(scope, payload.toolCallId, payload.name, payload.input);
            }),
            register<ToolOutputEvent>('ai:tool-output', (payload) => {
                stream.appendToolOutput(payload.toolCallId, payload.chunk);
            }),
            register<ToolDiffEvent>('ai:tool-diff', (payload) => {
                stream.flush();
                act().setToolDiff(
                    scope,
                    payload.toolCallId,
                    payload.before,
                    payload.after,
                    payload.path,
                );
            }),
            register<ToolDoneEvent>('ai:tool-done', (payload) => {
                stream.flush();
                act().setToolStatus(
                    scope,
                    payload.toolCallId,
                    payload.success ? 'done' : 'error',
                    payload.output,
                );
            }),
            register<AgentCheckpointEvent>('ai:agent-checkpoint', (payload) => {
                stream.flush();
                act().addCheckpoint(scope, payload.checkpointId, payload.question, payload.command);
            }),
            register<AgentPlanEvent>('ai:agent-plan', (payload) => {
                stream.flush();
                act().addPlan(scope, payload.planId, payload.summary, payload.steps);
            }),
            register<AgentDoneEvent>('ai:agent-done', (payload) => {
                stream.flush();
                act().clearThinking(scope, runId);
                act().addDone(
                    scope,
                    payload.success,
                    payload.summary,
                    payload.actions ?? [],
                    payload.sessionPath,
                );
                act().endRun(scope);
            }),
            register<AgentErrorEvent>('ai:agent-error', (payload) => {
                stream.flush();
                act().addError(scope, payload.message);
                act().endRun(scope);
            }),
        ]).catch((error) => {
            stream.dispose();
            if (!cancelled && ownsRun()) {
                console.error('[AI] Failed to register agent event listeners:', error);
            }
        });

        return () => {
            cancelled = true;
            events.dispose();
            stream.dispose();
        };
    }, [activeRunId, scope]);

    // ── Checkpoint handlers ────────────────────────────────────────────────────
    const handleCheckpointContinue = useCallback(
        async (checkpointId: string) => {
            act().answerCheckpoint(scope, checkpointId, 'continue');
            try {
                await respondToCheckpoint(checkpointId, true);
            } catch {
                // backend already cleaned up on error
            }
        },
        [scope],
    );

    const handleCheckpointStop = useCallback(
        async (checkpointId: string) => {
            act().answerCheckpoint(scope, checkpointId, 'stop');
            try {
                await respondToCheckpoint(checkpointId, false);
            } catch {
                // backend already cleaned up on error
            }
        },
        [scope],
    );

    const handleCheckpointAlwaysAllow = useCallback(
        async (checkpointId: string, command: string) => {
            act().answerCheckpoint(scope, checkpointId, 'continue');
            try {
                // Optimistically attempt to whitelist, but dont let failure here
                // block the final response to the backend agent.
                await whitelistCommand(scope, command).catch((e) => {
                    console.warn('[ConversationThread] Failed to whitelist command:', e);
                });
                await respondToCheckpoint(checkpointId, true);
            } catch (error) {
                console.error('[ConversationThread] Failed to respond to checkpoint:', error);
            }
        },
        [scope],
    );

    const handlePlanApprove = useCallback(
        async (planId: string) => {
            act().answerPlan(scope, planId, 'approved');
            try {
                await respondToCheckpoint(planId, true);
            } catch {
                // backend already cleaned up on error
            }
        },
        [scope],
    );

    const handlePlanReject = useCallback(
        async (planId: string) => {
            act().answerPlan(scope, planId, 'rejected');
            try {
                await respondToCheckpoint(planId, false);
            } catch {
                // backend already cleaned up on error
            }
        },
        [scope],
    );

    // ── Render ─────────────────────────────────────────────────────────────────
    if (messages.length === 0) {
        return <EmptyState isLocal={isLocal} />;
    }

    const isRunning = activeRunId !== null;
    const lastMsgIdx = messages.length - 1;

    return (
        <div
            ref={scrollRef}
            className="flex-1 min-h-0 overflow-y-auto scroll-smooth px-3 py-3 space-y-3"
        >
            {isLocal && <LocalWarningBanner />}
            {hasMultiplePages && (
                <nav
                    aria-label="Conversation pages"
                    className="flex flex-wrap items-center gap-2 text-[11px] text-app-muted"
                >
                    <button
                        type="button"
                        disabled={page.start === 0}
                        onClick={() => {
                            const index = Math.max(0, page.start - CONVERSATION_PAGE_SIZE);
                            setPageAnchor({ id: messages[index].id, index });
                        }}
                        className="rounded px-2 py-1 hover:bg-app-surface disabled:opacity-40"
                    >
                        Older messages
                    </button>
                    <span>
                        {page.start + 1}–{page.end} of {messages.length}
                    </span>
                    <button
                        type="button"
                        disabled={page.end === messages.length}
                        onClick={() => {
                            const index = page.start + CONVERSATION_PAGE_SIZE;
                            setPageAnchor(
                                index >= messages.length - CONVERSATION_PAGE_SIZE
                                    ? null
                                    : { id: messages[index].id, index },
                            );
                        }}
                        className="rounded px-2 py-1 hover:bg-app-surface disabled:opacity-40"
                    >
                        Newer messages
                    </button>
                    {pageAnchor && (
                        <button
                            type="button"
                            onClick={() => setPageAnchor(null)}
                            className="rounded px-2 py-1 text-app-accent hover:bg-app-surface"
                        >
                            Latest
                        </button>
                    )}
                </nav>
            )}
            {messages.slice(page.start, page.end).map((msg, idx) => (
                <ConversationMessageRow
                    key={msg.id}
                    msg={msg}
                    isActiveThinking={isRunning && page.start + idx === lastMsgIdx}
                    getToolExpansion={getToolExpansion}
                    setToolExpansion={setToolExpansion}
                    handleCheckpointContinue={handleCheckpointContinue}
                    handleCheckpointStop={handleCheckpointStop}
                    handleCheckpointAlwaysAllow={handleCheckpointAlwaysAllow}
                    handlePlanApprove={handlePlanApprove}
                    handlePlanReject={handlePlanReject}
                />
            ))}
            {isRunning && <RunningStatusBar messages={messages} />}
            <div ref={bottomRef} />
        </div>
    );
}

interface ConversationMessageRowProps {
    msg: ConversationMessage;
    isActiveThinking: boolean;
    handleCheckpointContinue: (id: string) => Promise<void>;
    handleCheckpointStop: (id: string) => Promise<void>;
    handleCheckpointAlwaysAllow: (id: string, command: string) => Promise<void>;
    handlePlanApprove: (id: string) => Promise<void>;
    handlePlanReject: (id: string) => Promise<void>;
    getToolExpansion: (id: string) => boolean | undefined;
    setToolExpansion: (id: string, expanded: boolean) => void;
}

/** Keep completed Markdown/tool rows stable while the one live message receives stream updates. */
const ConversationMessageRow = memo(function ConversationMessageRow({
    msg,
    isActiveThinking,
    handleCheckpointContinue,
    handleCheckpointStop,
    handleCheckpointAlwaysAllow,
    handlePlanApprove,
    handlePlanReject,
    getToolExpansion,
    setToolExpansion,
}: ConversationMessageRowProps) {
    return (
        <div
            className="[contain:layout_paint]"
            data-agent-message-id={msg.id}
        >
            {renderMessage()}
        </div>
    );

    /** Preserve every message type and its existing approval handlers within one memo boundary. */
    function renderMessage() {
        switch (msg.type) {
            case 'user':
                return (
                    <UserBubble
                        key={msg.id}
                        text={msg.text}
                    />
                );

            case 'thinking':
                // Cursor blinks only on the last thinking bubble while run is active
                return (
                    <ThinkingBubble
                        key={msg.id}
                        text={msg.text}
                        isActive={isActiveThinking}
                    />
                );

            case 'tool-call':
                return (
                    <ToolCallBlock
                        key={msg.id}
                        message={msg}
                        initialExpanded={getToolExpansion(msg.id)}
                        onExpansionChange={(expanded) => setToolExpansion(msg.id, expanded)}
                    />
                );

            case 'checkpoint':
                return (
                    <CheckpointBlock
                        key={msg.id}
                        message={msg}
                        onContinue={() => handleCheckpointContinue(msg.checkpointId)}
                        onStop={() => handleCheckpointStop(msg.checkpointId)}
                        onAlwaysAllow={
                            msg.command
                                ? () => handleCheckpointAlwaysAllow(msg.checkpointId, msg.command!)
                                : undefined
                        }
                    />
                );

            case 'plan':
                return (
                    <PlanBubble
                        key={msg.id}
                        message={msg}
                        onApprove={() => handlePlanApprove(msg.planId)}
                        onReject={() => handlePlanReject(msg.planId)}
                    />
                );

            case 'done':
                return (
                    <DoneBubble
                        key={msg.id}
                        success={msg.success}
                        summary={msg.summary}
                        actions={msg.actions}
                        sessionPath={msg.sessionPath}
                    />
                );

            case 'error':
                return (
                    <ErrorBubble
                        key={msg.id}
                        message={msg.message}
                    />
                );

            default:
                return null;
        }
    }
});

// ── Running indicator (used by AiSidebar in the header area) ─────────────────

/** Displays the compact activity indicator only while a backend agent run remains active. */
export function AgentRunningIndicator({ isRunning }: { isRunning: boolean }) {
    if (!isRunning) {
        return null;
    }
    return (
        <div className="flex items-center gap-1.5 text-[10px] text-app-accent/70 font-medium">
            <Loader2
                size={10}
                className="animate-spin"
            />
            <span>Running</span>
        </div>
    );
}
