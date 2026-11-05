/**
 * Agent Run Store — Zustand store for the V2 conversation-based agent UI.
 *
 * Conversations are keyed by `connectionId ?? 'global'` so each SSH target
 * has its own independent thread.
 *
 * Message mutations are designed to be called directly from Tauri event
 * listeners — each handler is a simple setState call.
 */

import { nanoid } from 'nanoid';
import { create, type StateCreator } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import type { AgentPlanStep, ConversationMessage, ToolCallStatus } from '../types/agent';

/** Max messages kept per scope in localStorage to avoid unbounded growth. */
const MAX_PERSISTED_MESSAGES = 60;

// ── Store Shape ────────────────────────────────────────────────────────────────

export interface AgentHistoryEntry {
    role: 'user' | 'assistant';
    text: string;
}

interface AgentRunStore {
    /** Keyed by scope (connectionId or "global"). */
    conversations: Record<string, ConversationMessage[]>;
    /** Currently running run_id per scope, or null when idle. */
    activeRunIds: Record<string, string | null>;

    // ── Scoped helpers ──────────────────────────────────────────────────────────
    getMessages: (scope: string) => ConversationMessage[];
    getActiveRunId: (scope: string) => string | null;
    /**
     * Returns a compact history of prior turns (user goals + agent summaries)
     * for the given scope, capped at the last 10 exchanges.
     */
    getHistory: (scope: string) => AgentHistoryEntry[];
    /**
     * Returns the steps of the last approved plan in this scope, or null.
     * Used to skip re-planning when the user retries after a failed run.
     */
    getLastApprovedPlan: (scope: string) => import('../types/agent').AgentPlanStep[] | null;
    /** Returns brain session folder paths from all done messages in this scope. */
    getSessionPaths: (scope: string) => string[];

    // ── Mutations ───────────────────────────────────────────────────────────────
    /** Add the user's goal as the first message of a new run. */
    startRun: (scope: string, runId: string, goal: string) => void;
    /** Mark the run as no longer active (done or errored). */
    endRun: (scope: string) => void;

    clearThinking: (scope: string, runId: string) => void;
    appendThinking: (scope: string, runId: string, text: string) => void;
    addToolCall: (
        scope: string,
        toolCallId: string,
        toolName: string,
        input: Record<string, unknown>,
    ) => void;
    appendToolOutput: (scope: string, toolCallId: string, output: string) => void;
    setToolDiff: (
        scope: string,
        toolCallId: string,
        before: string,
        after: string,
        path: string,
    ) => void;
    setToolStatus: (
        scope: string,
        toolCallId: string,
        status: ToolCallStatus,
        output?: string,
    ) => void;
    addCheckpoint: (
        scope: string,
        checkpointId: string,
        question: string,
        command?: string,
    ) => void;
    answerCheckpoint: (scope: string, checkpointId: string, response: 'continue' | 'stop') => void;
    addDone: (
        scope: string,
        success: boolean,
        summary: string,
        actions: string[],
        sessionPath?: string,
    ) => void;
    addError: (scope: string, message: string) => void;
    addPlan: (scope: string, planId: string, summary: string, steps: AgentPlanStep[]) => void;
    answerPlan: (scope: string, planId: string, response: 'approved' | 'rejected') => void;

    clearConversation: (scope: string) => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Pure transformation used by the Zustand persist partialize callback.
 * Exported for unit tests — do not use in production code.
 */
export function partializeConversations(
    conversations: Record<string, ConversationMessage[]>,
): Record<string, ConversationMessage[]> {
    return Object.fromEntries(
        Object.entries(conversations).map(([scope, msgs]) => [
            scope,
            msgs
                .slice(-MAX_PERSISTED_MESSAGES)
                // Drop thinking messages — ephemeral reasoning, large, not useful after a run.
                .filter((m) => m.type !== 'thinking')
                .map((m): ConversationMessage => {
                    if (m.type === 'tool-call') {
                        // Strip raw output and file diffs — they may contain secrets and can be
                        // large. Persist only the structural fields needed to render the UI.
                        const { output: _o, diff: _d, ...safe } = m;
                        return {
                            ...safe,
                            // output is intentionally omitted from persistence. The type cast is
                            // safe here — the UI handles missing output gracefully after reload.
                            output: '',
                            // Ensure nothing looks stuck after restart.
                            status: safe.status === 'running' ? ('done' as const) : safe.status,
                        };
                    }
                    // Backfill `actions` for done messages persisted before this field existed.
                    // Reset pending decisions so reloads never show a stale interactive UI.
                    if (m.type === 'checkpoint') {
                        // A pending checkpoint can never be answered after restart — auto-decline it.
                        return {
                            ...m,
                            response: m.response === null ? ('stop' as const) : m.response,
                        };
                    }
                    if (m.type === 'plan') {
                        return {
                            ...m,
                            response: m.response === null ? ('rejected' as const) : m.response,
                        };
                    }
                    if (m.type === 'done' && !('actions' in m)) {
                        return { ...m, actions: [] };
                    }
                    return m;
                }),
        ]),
    );
}

/** Supplies an empty thread for a scope that has not received its first message. */
function getOrInit(
    conversations: Record<string, ConversationMessage[]>,
    scope: string,
): ConversationMessage[] {
    return conversations[scope] ?? [];
}

/** Replaces matching typed messages while retaining every unrelated message unchanged. */
function updateMessage<T extends ConversationMessage>(
    msgs: ConversationMessage[],
    predicate: (m: ConversationMessage) => m is T,
    updater: (m: T) => T,
): ConversationMessage[] {
    return msgs.map((m) => (predicate(m) ? updater(m) : m));
}

/** Provider tool IDs can repeat across runs; only the newest block owns subsequent events. */
function updateLatestTool(
    messages: ConversationMessage[],
    toolCallId: string,
    update: (
        message: Extract<ConversationMessage, { type: 'tool-call' }>,
    ) => Extract<ConversationMessage, { type: 'tool-call' }>,
): ConversationMessage[] {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message.type === 'tool-call' && message.toolCallId === toolCallId) {
            const updated = update(message);
            if (updated === message) {
                return messages;
            }
            const next = messages.slice();
            next[index] = updated;
            return next;
        }
    }
    return messages;
}

// ── Store ──────────────────────────────────────────────────────────────────────

type PersistedConversations = Pick<AgentRunStore, 'conversations'>;
type AgentRunCreator = StateCreator<
    AgentRunStore,
    [],
    [['zustand/persist', PersistedConversations]]
>;

/** Captures vanilla updates before persist wraps them, separating transient text from durable history. */
const initializeAgentRunStore: AgentRunCreator = (transientSet, get, api) =>
    persist<AgentRunStore, [], [], PersistedConversations>(
        (set, get) => ({
            conversations: {},
            activeRunIds: {},

            /** Reads the current scope's conversation without mixing messages from other hosts. */
            getMessages(scope) {
                return get().conversations[scope] ?? [];
            },

            /** Resolves the live backend run associated with one conversation scope. */
            getActiveRunId(scope) {
                return get().activeRunIds[scope] ?? null;
            },

            /** Builds bounded follow-up context from user goals and completed or interrupted summaries. */
            getHistory(scope) {
                const msgs = get().conversations[scope] ?? [];
                const entries: AgentHistoryEntry[] = [];
                for (const msg of msgs) {
                    if (msg.type === 'user') {
                        entries.push({ role: 'user', text: msg.text });
                    } else if (msg.type === 'done') {
                        // Include both successful and interrupted runs so the AI knows what was already done.
                        const status = msg.success ? '' : ' (interrupted — did not complete)';
                        const doneActions = msg.actions ?? [];
                        const completedActions = doneActions.filter((a) => !a.startsWith('✗'));
                        const actionsText = completedActions.length
                            ? ` Completed steps: ${completedActions.join(', ')}`
                            : '';
                        entries.push({
                            role: 'assistant',
                            text: `${msg.summary}${status}${actionsText}`,
                        });
                    }
                }
                // Keep the last 10 exchanges (20 entries) to avoid bloating the context
                return entries.slice(-20);
            },

            /** Finds the latest approved plan so retries can retain the user's prior decision. */
            getLastApprovedPlan(scope) {
                const msgs = get().conversations[scope] ?? [];
                for (let i = msgs.length - 1; i >= 0; i--) {
                    const msg = msgs[i];
                    if (msg.type === 'plan' && msg.response === 'approved') {
                        return msg.steps;
                    }
                }
                return null;
            },

            /** Collects saved session locations from completed messages in the selected scope. */
            getSessionPaths(scope) {
                const msgs = get().conversations[scope] ?? [];
                return msgs
                    .filter(
                        (m): m is Extract<ConversationMessage, { type: 'done' }> =>
                            m.type === 'done',
                    )
                    .map((m) => m.sessionPath)
                    .filter((p): p is string => !!p);
            },

            /** Marks a backend run active and appends its initiating user goal. */
            startRun(scope, runId, goal) {
                set((s) => ({
                    activeRunIds: { ...s.activeRunIds, [scope]: runId },
                    conversations: {
                        ...s.conversations,
                        [scope]: [
                            ...getOrInit(s.conversations, scope),
                            {
                                type: 'user',
                                id: nanoid(),
                                text: goal,
                            } satisfies ConversationMessage,
                        ],
                    },
                }));
            },

            /** Clears active execution without removing the conversation's completed results. */
            endRun(scope) {
                transientSet((s) => ({
                    activeRunIds: { ...s.activeRunIds, [scope]: null },
                }));
            },

            /** Removes only the ephemeral reasoning bubbles belonging to the finished run. */
            clearThinking(scope, runId) {
                transientSet((s) => {
                    const msgs = getOrInit(s.conversations, scope);
                    const next = msgs.filter(
                        (m) => !(m.type === 'thinking' && m.id.startsWith(`${runId}-`)),
                    );
                    if (next.length === msgs.length) {
                        return s;
                    }
                    return {
                        conversations: {
                            ...s.conversations,
                            [scope]: next,
                        },
                    };
                });
            },

            /** Extends the current reasoning bubble or starts one after an intervening message. */
            appendThinking(scope, runId, text) {
                if (!text) {
                    return;
                }
                transientSet((s) => {
                    const msgs = getOrInit(s.conversations, scope);
                    const last = msgs[msgs.length - 1];
                    // Accumulate into an existing thinking bubble for this run
                    if (last?.type === 'thinking' && last.id.startsWith(`${runId}-`)) {
                        return {
                            conversations: {
                                ...s.conversations,
                                [scope]: updateMessage(
                                    msgs,
                                    (m): m is Extract<ConversationMessage, { type: 'thinking' }> =>
                                        m.type === 'thinking' && m.id === last.id,
                                    (m) => ({ ...m, text: m.text + text }),
                                ),
                            },
                        };
                    }
                    // Start a new thinking bubble
                    return {
                        conversations: {
                            ...s.conversations,
                            [scope]: [
                                ...msgs,
                                {
                                    type: 'thinking',
                                    id: `${runId}-${nanoid()}`,
                                    text,
                                } satisfies ConversationMessage,
                            ],
                        },
                    };
                });
            },

            /** Creates a running tool block before its streamed output or terminal result arrives. */
            addToolCall(scope, toolCallId, toolName, input) {
                set((s) => ({
                    conversations: {
                        ...s.conversations,
                        [scope]: [
                            ...getOrInit(s.conversations, scope),
                            {
                                type: 'tool-call',
                                id: nanoid(),
                                toolCallId,
                                toolName,
                                input,
                                output: '',
                                status: 'running',
                            } satisfies ConversationMessage,
                        ],
                    },
                }));
            },

            /** Appends live text only while the tool is running; terminal snapshots are immutable to late chunks. */
            appendToolOutput(scope, toolCallId, output) {
                if (!output) {
                    return;
                }
                transientSet((s) => {
                    const messages = getOrInit(s.conversations, scope);
                    const next = updateLatestTool(messages, toolCallId, (m) =>
                        m.status === 'running' ? { ...m, output: m.output + output } : m,
                    );
                    return next === messages
                        ? s
                        : {
                              conversations: { ...s.conversations, [scope]: next },
                          };
                });
            },

            /** Attaches an available file-diff preview to its matching tool block. */
            setToolDiff(scope, toolCallId, before, after, path) {
                transientSet((s) => {
                    const messages = getOrInit(s.conversations, scope);
                    const next = updateLatestTool(messages, toolCallId, (m) =>
                        m.status === 'running' ? { ...m, diff: { before, after, path } } : m,
                    );
                    return next === messages
                        ? s
                        : {
                              conversations: { ...s.conversations, [scope]: next },
                          };
                });
            },

            /** Replaces partial output with the authoritative final preview when the backend supplies one. */
            setToolStatus(scope, toolCallId, status, output) {
                const state = get();
                const messages = getOrInit(state.conversations, scope);
                const next = updateLatestTool(messages, toolCallId, (m) =>
                    m.status === 'running' ? { ...m, status, output: output ?? m.output } : m,
                );
                if (next === messages) {
                    return;
                }
                set({ conversations: { ...state.conversations, [scope]: next } });
            },

            /** Records a pending backend approval question and its optional command context. */
            addCheckpoint(scope, checkpointId, question, command) {
                set((s) => ({
                    conversations: {
                        ...s.conversations,
                        [scope]: [
                            ...getOrInit(s.conversations, scope),
                            {
                                type: 'checkpoint',
                                id: nanoid(),
                                checkpointId,
                                question,
                                command,
                                response: null,
                            } satisfies ConversationMessage,
                        ],
                    },
                }));
            },

            /** Reflects the user's checkpoint decision without changing other approval prompts. */
            answerCheckpoint(scope, checkpointId, response) {
                set((s) => ({
                    conversations: {
                        ...s.conversations,
                        [scope]: updateMessage(
                            getOrInit(s.conversations, scope),
                            (m): m is Extract<ConversationMessage, { type: 'checkpoint' }> =>
                                m.type === 'checkpoint' && m.checkpointId === checkpointId,
                            (m) => ({ ...m, response }),
                        ),
                    },
                }));
            },

            /** Appends the authoritative run summary and any saved session location. */
            addDone(scope, success, summary, actions, sessionPath) {
                set((s) => ({
                    conversations: {
                        ...s.conversations,
                        [scope]: [
                            ...getOrInit(s.conversations, scope),
                            {
                                type: 'done',
                                id: nanoid(),
                                success,
                                summary,
                                actions,
                                sessionPath,
                            } satisfies ConversationMessage,
                        ],
                    },
                }));
            },

            /** Adds an unrecoverable run error to the conversation that owns it. */
            addError(scope, message) {
                set((s) => ({
                    conversations: {
                        ...s.conversations,
                        [scope]: [
                            ...getOrInit(s.conversations, scope),
                            {
                                type: 'error',
                                id: nanoid(),
                                message,
                            } satisfies ConversationMessage,
                        ],
                    },
                }));
            },

            /** Stores a pending execution plan until the user approves or rejects it. */
            addPlan(scope, planId, summary, steps) {
                set((s) => ({
                    conversations: {
                        ...s.conversations,
                        [scope]: [
                            ...getOrInit(s.conversations, scope),
                            {
                                type: 'plan',
                                id: nanoid(),
                                planId,
                                summary,
                                steps,
                                response: null,
                            } satisfies ConversationMessage,
                        ],
                    },
                }));
            },

            /** Updates one plan's decision while preserving its proposed steps for history. */
            answerPlan(scope, planId, response) {
                set((s) => ({
                    conversations: {
                        ...s.conversations,
                        [scope]: updateMessage(
                            getOrInit(s.conversations, scope),
                            (m): m is Extract<ConversationMessage, { type: 'plan' }> =>
                                m.type === 'plan' && m.planId === planId,
                            (m) => ({ ...m, response }),
                        ),
                    },
                }));
            },

            /** Clears one scope's history and active-run marker without affecting other hosts. */
            clearConversation(scope) {
                set((s) => ({
                    conversations: { ...s.conversations, [scope]: [] },
                    activeRunIds: { ...s.activeRunIds, [scope]: null },
                }));
            },
        }),
        {
            name: 'zync-agent-conversations',
            storage: createJSONStorage(() => localStorage),
            // Only persist conversations — activeRunIds must reset on every app start.
            /** Excludes runtime execution markers and strips transient content from durable history. */
            partialize: (s) => ({ conversations: partializeConversations(s.conversations) }),
        },
    )(transientSet, get, api);

export const useAgentRunStore = create<AgentRunStore>()(initializeAgentRunStore);
