/**
 * Agent V2 — TypeScript types matching the Rust backend event schema.
 *
 * Events emitted by Tauri via `app.emit(...)` during an agent run:
 *   ai:agent-thinking       — AI is "thinking" / streaming text
 *   ai:tool-start           — tool call began
 *   ai:tool-output          — incremental stdout/stderr from a tool
 *   ai:tool-diff            — write_file diff (before/after)
 *   ai:tool-done            — tool call finished
 *   ai:agent-checkpoint     — ask_user paused the loop
 *   ai:agent-done           — run finished (success or cancelled)
 *   ai:agent-error          — run aborted with an error
 */

// ── Backend Event Payloads ─────────────────────────────────────────────────────

// All fields are camelCase — Rust structs use #[serde(rename_all = "camelCase")].

export interface AgentThinkingEvent {
  runId: string;
  text: string;
}

export interface ToolStartEvent {
  runId: string;
  toolCallId: string;
  name: string;        // Rust field is `name`, not `tool_name`
  input: Record<string, unknown>;
}

export interface ToolOutputEvent {
  runId: string;
  toolCallId: string;
  chunk: string;       // Rust field is `chunk`, not `output`
}

export interface ToolDiffEvent {
  runId: string;
  toolCallId: string;
  before: string;
  after: string;
  path: string;
}

export interface ToolDoneEvent {
  runId: string;
  toolCallId: string;
  name: string;
  success: boolean;
  output: string;
}

export interface AgentCheckpointEvent {
  runId: string;
  checkpointId: string;
  question: string;
  /** The exact command being approved, if this is a run_command safety gate. */
  command?: string;
}

export interface AgentPlanStep {
  id: string;
  title: string;
  reason: string;
  command?: string;
  expectedImpact?: string;
  risk: 'low' | 'medium' | 'high';
  requiresApproval: boolean;
}

export interface AgentPlanEvent {
  runId: string;
  planId: string;
  summary: string;
  steps: AgentPlanStep[];
}

export interface AgentDoneEvent {
  runId: string;
  success: boolean;
  summary: string;
  /** Structured log of actions taken during the run. */
  actions?: string[];
  /** Absolute path to the brain session folder. */
  sessionPath?: string;
}

export interface AgentErrorEvent {
  runId: string;
  message: string;
}

// ── Conversation Message Types ─────────────────────────────────────────────────

export type ToolCallStatus = 'running' | 'done' | 'error';

export interface UserMessage {
  type: 'user';
  id: string;
  text: string;
}

export interface ThinkingMessage {
  type: 'thinking';
  id: string;
  /** Accumulated text streamed from the AI. */
  text: string;
}

export interface ToolCallMessage {
  type: 'tool-call';
  id: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Accumulated stdout/stderr from the tool. */
  output: string;
  /** Present for write_file calls. */
  diff?: { before: string; after: string; path: string };
  status: ToolCallStatus;
}

export interface CheckpointMessage {
  type: 'checkpoint';
  id: string;
  checkpointId: string;
  question: string;
  /** The exact command being approved — present for run_command safety gates. */
  command?: string;
  /** null = awaiting response */
  response: 'continue' | 'stop' | null;
}

export interface PlanMessage {
  type: 'plan';
  id: string;
  planId: string;
  summary: string;
  steps: AgentPlanStep[];
  /** null = awaiting user decision */
  response: 'approved' | 'rejected' | null;
}

export interface DoneMessage {
  type: 'done';
  id: string;
  success: boolean;
  summary: string;
  actions?: string[];
  sessionPath?: string;
}

export interface ErrorMessage {
  type: 'error';
  id: string;
  message: string;
}

export type ConversationMessage =
  | UserMessage
  | ThinkingMessage
  | ToolCallMessage
  | CheckpointMessage
  | PlanMessage
  | DoneMessage
  | ErrorMessage;
