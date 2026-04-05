/**
 * Agent Run Store — Zustand store for the V2 conversation-based agent UI.
 *
 * Conversations are keyed by `connectionId ?? 'global'` so each SSH target
 * has its own independent thread.
 *
 * Message mutations are designed to be called directly from Tauri event
 * listeners — each handler is a simple setState call.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { nanoid } from 'nanoid';
import type {
  ConversationMessage,
  ToolCallStatus,
  AgentPlanStep,
} from '../types/agent';

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

  // ── Mutations ───────────────────────────────────────────────────────────────
  /** Add the user's goal as the first message of a new run. */
  startRun: (scope: string, runId: string, goal: string) => void;
  /** Mark the run as no longer active (done or errored). */
  endRun: (scope: string) => void;

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
  setToolStatus: (scope: string, toolCallId: string, status: ToolCallStatus) => void;
  addCheckpoint: (
    scope: string,
    checkpointId: string,
    question: string,
    command?: string,
  ) => void;
  answerCheckpoint: (
    scope: string,
    checkpointId: string,
    response: 'continue' | 'stop',
  ) => void;
  addDone: (scope: string, success: boolean, summary: string, actions: string[], sessionPath?: string) => void;
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
            return { ...m, response: m.response === null ? ('stop' as const) : m.response };
          }
          if (m.type === 'plan') {
            return { ...m, response: m.response === null ? ('rejected' as const) : m.response };
          }
          if (m.type === 'done' && !('actions' in m)) {
            return { ...m, actions: [] };
          }
          return m;
        }),
    ]),
  );
}

function getOrInit(
  conversations: Record<string, ConversationMessage[]>,
  scope: string,
): ConversationMessage[] {
  return conversations[scope] ?? [];
}

function updateMessage<T extends ConversationMessage>(
  msgs: ConversationMessage[],
  predicate: (m: ConversationMessage) => m is T,
  updater: (m: T) => T,
): ConversationMessage[] {
  return msgs.map((m) => (predicate(m) ? updater(m) : m));
}

// ── Store ──────────────────────────────────────────────────────────────────────

export const useAgentRunStore = create<AgentRunStore>()(
  persist(
    (set, get) => ({
  conversations: {},
  activeRunIds: {},

  getMessages(scope) {
    return get().conversations[scope] ?? [];
  },

  getActiveRunId(scope) {
    return get().activeRunIds[scope] ?? null;
  },

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
        const completedActions = doneActions.filter(a => !a.startsWith('✗'));
        const actionsText = completedActions.length
          ? ` Completed steps: ${completedActions.join(', ')}`
          : '';
        entries.push({ role: 'assistant', text: `${msg.summary}${status}${actionsText}` });
      }
    }
    // Keep the last 10 exchanges (20 entries) to avoid bloating the context
    return entries.slice(-20);
  },

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

  startRun(scope, runId, goal) {
    set((s) => ({
      activeRunIds: { ...s.activeRunIds, [scope]: runId },
      conversations: {
        ...s.conversations,
        [scope]: [
          ...getOrInit(s.conversations, scope),
          { type: 'user', id: nanoid(), text: goal } satisfies ConversationMessage,
        ],
      },
    }));
  },

  endRun(scope) {
    set((s) => ({
      activeRunIds: { ...s.activeRunIds, [scope]: null },
    }));
  },

  appendThinking(scope, runId, text) {
    set((s) => {
      const msgs = getOrInit(s.conversations, scope);
      const last = msgs[msgs.length - 1];
      // Accumulate into an existing thinking bubble for this run
      if (last?.type === 'thinking' && last.id.startsWith(runId)) {
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

  appendToolOutput(scope, toolCallId, output) {
    set((s) => ({
      conversations: {
        ...s.conversations,
        [scope]: updateMessage(
          getOrInit(s.conversations, scope),
          (m): m is Extract<ConversationMessage, { type: 'tool-call' }> =>
            m.type === 'tool-call' && m.toolCallId === toolCallId,
          (m) => ({ ...m, output: m.output + output }),
        ),
      },
    }));
  },

  setToolDiff(scope, toolCallId, before, after, path) {
    set((s) => ({
      conversations: {
        ...s.conversations,
        [scope]: updateMessage(
          getOrInit(s.conversations, scope),
          (m): m is Extract<ConversationMessage, { type: 'tool-call' }> =>
            m.type === 'tool-call' && m.toolCallId === toolCallId,
          (m) => ({ ...m, diff: { before, after, path } }),
        ),
      },
    }));
  },

  setToolStatus(scope, toolCallId, status) {
    set((s) => ({
      conversations: {
        ...s.conversations,
        [scope]: updateMessage(
          getOrInit(s.conversations, scope),
          (m): m is Extract<ConversationMessage, { type: 'tool-call' }> =>
            m.type === 'tool-call' && m.toolCallId === toolCallId,
          (m) => ({ ...m, status }),
        ),
      },
    }));
  },

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
      partialize: (s) => ({ conversations: partializeConversations(s.conversations) }),
    },
  ),
);
