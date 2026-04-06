/**
 * ConversationThread — the V2 agent conversation UI.
 *
 * Mounts Tauri event listeners for the running agent run and updates the
 * agentRunStore in real time. Renders the message list and handles
 * checkpoint interactions.
 *
 * Drop this in place of <AgentActivityFeed /> in AiSidebar.tsx.
 */

import { useEffect, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sparkles, CheckCircle2, XCircle, Loader2, AlertTriangle, FolderOpen } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { AgentIcon } from './AgentIcon';
import { cn } from '../../lib/utils';
import { useAgentRunStore } from '../../ai/store/agentRunStore';
import { ToolCallBlock } from './ToolCallBlock';
import { CheckpointBlock } from './CheckpointBlock';
import { PlanBubble } from './PlanBubble';
import { respondToCheckpoint, whitelistCommand } from '../../ai/services/aiClient';
import type {
  AgentThinkingEvent,
  ToolStartEvent,
  ToolOutputEvent,
  ToolDiffEvent,
  ToolDoneEvent,
  AgentCheckpointEvent,
  AgentPlanEvent,
  AgentDoneEvent,
  AgentErrorEvent,
  ConversationMessage,
} from '../../ai/types/agent';

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

// ── Empty state ────────────────────────────────────────────────────────────────

function LocalWarningBanner() {
  return (
    <div className="mx-3 mt-3 flex items-start gap-2 px-3 py-2.5 rounded-lg border border-yellow-500/20 bg-yellow-500/5">
      <AlertTriangle size={12} className="shrink-0 mt-px text-yellow-400/70" />
      <p className="text-[11px] text-yellow-300/70 leading-relaxed">
        No SSH connection selected. Commands will run on <span className="font-medium text-yellow-300/90">your local machine</span>.
      </p>
    </div>
  );
}

function EmptyState({ isLocal }: { isLocal?: boolean }) {
  return (
    <div className="flex flex-col flex-1">
      {isLocal && <LocalWarningBanner />}
      <div className="flex flex-col items-center justify-center flex-1 gap-3 px-6 py-12 text-center">
        <div className="w-10 h-10 rounded-full bg-app-accent/10 border border-app-accent/20 flex items-center justify-center">
          <Sparkles size={16} className="text-app-accent" />
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
  if (!text) return text;
  // Match 'something' where 'something' has no spaces and at least one character
  return text.replace(/'([^'\s]+)'/g, '`$1`');
}

// ── Message renderers ──────────────────────────────────────────────────────────

function ThinkingBubble({ text, isActive }: { text: string; isActive: boolean }) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="shrink-0 mt-0.5 w-6 h-6 rounded-full bg-gradient-to-br from-purple-500/20 to-app-accent/20 border border-purple-500/30 flex items-center justify-center">
        <AgentIcon size={12} className="text-purple-400" />
      </div>
      <div className="flex-1 min-w-0 pt-0.5 text-[12px] text-app-text/85 leading-relaxed
        [&_p]:mb-1.5 [&_p:last-child]:mb-0
        [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:mb-1.5
        [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:mb-1.5
        [&_li]:mb-0.5
        [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-app-surface/60 [&_code]:border [&_code]:border-app-border/40 [&_code]:font-mono [&_code]:text-[11px] [&_code]:text-app-accent/90
        [&_pre]:p-2 [&_pre]:rounded-lg [&_pre]:bg-black/20 [&_pre]:overflow-x-auto [&_pre]:mb-1.5
        [&_pre_code]:bg-transparent [&_pre_code]:border-0 [&_pre_code]:p-0 [&_pre_code]:text-app-text/80
        [&_strong]:text-app-text [&_em]:text-app-text/70">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {formatTechnicalTerms(text)}
        </ReactMarkdown>
        {isActive && (
          <span className="inline-block w-[2px] h-[13px] ml-0.5 bg-app-accent/70 align-bottom animate-pulse" />
        )}
      </div>
    </div>
  );
}

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

function DoneBubble({ success, summary, actions = [], sessionPath }: { success: boolean; summary: string; actions?: string[]; sessionPath?: string }) {
  const revealSession = () => {
    if (sessionPath) {
      invoke('shell_open', { path: sessionPath }).catch((error) => {
        console.error('[DoneBubble] Failed to open session folder:', { sessionPath, error });
      });
    }
  };

  const failed  = actions.filter(a => a.startsWith('✗'));
  const succeeded = actions.filter(a => !a.startsWith('✗'));
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
          <CheckCircle2 size={14} className="shrink-0 text-emerald-400 mt-0.5" />
        ) : (
          <XCircle size={14} className="shrink-0 text-app-muted mt-0.5" />
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
            <div className="text-[12px] text-app-text/80 leading-relaxed
              [&_p]:mb-0 [&_strong]:text-app-text [&_em]:text-app-text/70
              [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:bg-app-surface/60
              [&_code]:border [&_code]:border-app-border/30 [&_code]:font-mono [&_code]:text-[11px]">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
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
            <span className="truncate font-mono">{sessionPath.split(/[\\/]/).slice(-2).join('/')}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function ErrorBubble({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl border bg-red-500/5 border-red-500/20">
      <XCircle size={14} className="shrink-0 text-red-400 mt-0.5" />
      <p className="text-[12px] text-red-300/80 leading-relaxed">{message}</p>
    </div>
  );
}

// ── Inline running status ──────────────────────────────────────────────────────

const TOOL_STATUS_LABELS: Record<string, string> = {
  run_command: 'Running command...',
  read_file:   'Reading file...',
  write_file:  'Editing file...',
  list_files:  'Listing files...',
  ask_user:    'Waiting for input...',
};

function RunningStatusBar({ messages }: { messages: ConversationMessage[] }) {
  // Find the most informative current status from the last few messages
  let label = 'Thinking...';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === 'tool-call' && msg.status === 'running') {
      label = TOOL_STATUS_LABELS[msg.toolName] ?? 'Running...';
      break;
    }
    if (msg.type === 'thinking') break; // still in thinking phase
  }

  return (
    <div className="flex items-center gap-1.5 px-1 py-1.5 text-[11px] text-app-accent/60 font-medium">
      <Loader2 size={10} className="animate-spin shrink-0 text-app-accent/70" />
      <span>{label}</span>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function ConversationThread({ scope, activeRunId, isLocal }: ConversationThreadProps) {
  // Only subscribe to the messages slice. Use stable NO_MESSAGES fallback — a new [] on every
  // getSnapshot call causes React's concurrent mode to detect a false "change" and loop infinitely.
  const messages     = useAgentRunStore((s) => s.conversations[scope] ?? NO_MESSAGES);
  const bottomRef    = useRef<HTMLDivElement>(null);
  const unlistenRefs = useRef<Array<() => void>>([]);

  // Helper: access store actions without subscribing (avoids re-render loops).
  const act = useAgentRunStore.getState;

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  // ── Mount Tauri event listeners ────────────────────────────────────────────
  useEffect(() => {
    if (!activeRunId) return;

    const runId = activeRunId;
    const unlisten: Array<() => void> = [];
    // Guard against rapid activeRunId changes: if cleanup runs before the async
    // IIFE finishes registering all listeners, immediately unsubscribe any that
    // were registered and don't store them in the ref.
    let cancelled = false;

    (async () => {
      unlisten.push(
        await listen<AgentThinkingEvent>('ai:agent-thinking', ({ payload }) => {
          if (payload.runId !== runId) return;
          act().appendThinking(scope, runId, payload.text);
        }),

        await listen<ToolStartEvent>('ai:tool-start', ({ payload }) => {
          if (payload.runId !== runId) return;
          act().addToolCall(scope, payload.toolCallId, payload.name, payload.input);
        }),

        await listen<ToolOutputEvent>('ai:tool-output', ({ payload }) => {
          if (payload.runId !== runId) return;
          act().appendToolOutput(scope, payload.toolCallId, payload.chunk);
        }),

        await listen<ToolDiffEvent>('ai:tool-diff', ({ payload }) => {
          if (payload.runId !== runId) return;
          act().setToolDiff(scope, payload.toolCallId, payload.before, payload.after, payload.path);
        }),

        await listen<ToolDoneEvent>('ai:tool-done', ({ payload }) => {
          if (payload.runId !== runId) return;
          act().setToolStatus(scope, payload.toolCallId, payload.success ? 'done' : 'error');
        }),

        await listen<AgentCheckpointEvent>('ai:agent-checkpoint', ({ payload }) => {
          if (payload.runId !== runId) return;
          act().addCheckpoint(scope, payload.checkpointId, payload.question, payload.command);
        }),

        await listen<AgentPlanEvent>('ai:agent-plan', ({ payload }) => {
          if (payload.runId !== runId) return;
          act().addPlan(scope, payload.planId, payload.summary, payload.steps);
        }),

        await listen<AgentDoneEvent>('ai:agent-done', ({ payload }) => {
          if (payload.runId !== runId) return;
          act().clearThinking(scope, runId);
          act().addDone(scope, payload.success, payload.summary, payload.actions ?? [], payload.sessionPath);
          act().endRun(scope);
        }),

        await listen<AgentErrorEvent>('ai:agent-error', ({ payload }) => {
          if (payload.runId !== runId) return;
          act().addError(scope, payload.message);
          act().endRun(scope);
        }),
      );

      if (cancelled) {
        // Effect was cleaned up while we were awaiting — immediately unsubscribe.
        unlisten.forEach((fn) => fn());
        return;
      }
      unlistenRefs.current = unlisten;
    })();

    return () => {
      cancelled = true;
      unlistenRefs.current.forEach((fn) => fn());
      unlistenRefs.current = [];
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
    <div className="flex-1 min-h-0 overflow-y-auto scroll-smooth px-3 py-3 space-y-3">
      {isLocal && <LocalWarningBanner />}
      {messages.map((msg: ConversationMessage, idx: number) => {
        switch (msg.type) {
          case 'user':
            return <UserBubble key={msg.id} text={msg.text} />;

          case 'thinking':
            // Cursor blinks only on the last thinking bubble while run is active
            return (
              <ThinkingBubble
                key={msg.id}
                text={msg.text}
                isActive={isRunning && idx === lastMsgIdx}
              />
            );

          case 'tool-call':
            return <ToolCallBlock key={msg.id} message={msg} />;

          case 'checkpoint':
            return (
              <CheckpointBlock
                key={msg.id}
                message={msg}
                onContinue={() => handleCheckpointContinue(msg.checkpointId)}
                onStop={() => handleCheckpointStop(msg.checkpointId)}
                onAlwaysAllow={msg.command ? () => handleCheckpointAlwaysAllow(msg.checkpointId, msg.command!) : undefined}
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
            return <DoneBubble key={msg.id} success={msg.success} summary={msg.summary} actions={msg.actions} sessionPath={msg.sessionPath} />;

          case 'error':
            return <ErrorBubble key={msg.id} message={msg.message} />;

          default:
            return null;
        }
      })}
      {isRunning && <RunningStatusBar messages={messages} />}
      <div ref={bottomRef} />
    </div>
  );
}

// ── Running indicator (used by AiSidebar in the header area) ─────────────────

export function AgentRunningIndicator({ isRunning }: { isRunning: boolean }) {
  if (!isRunning) return null;
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-app-accent/70 font-medium">
      <Loader2 size={10} className="animate-spin" />
      <span>Running</span>
    </div>
  );
}
