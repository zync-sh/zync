#![allow(dead_code)]

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::ai::AiTranslateResponse;

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub provider: String,
    pub keys: Option<HashMap<String, String>>,
    pub model: Option<String>,
    pub ollama_url: Option<String>,
    pub enabled: bool,
}

impl AiConfig {
    pub(crate) fn api_key(&self) -> Option<&str> {
        self.keys
            .as_ref()
            .and_then(|k| k.get(&self.provider))
            .map(|s| s.as_str())
            .filter(|k| !k.is_empty())
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalContext {
    pub os: Option<String>,
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub recent_output: Option<String>,
    pub connection_type: String,
    pub attached_content: Option<String>,
    pub attached_label: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamChunk {
    pub request_id: String,
    pub chunk: String,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamDone {
    pub request_id: String,
    pub result: Option<AiTranslateResponse>,
    pub error: Option<String>,
}


fn default_step_status() -> String { "pending".to_string() }

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlanStep {
    pub id: String,
    pub title: String,
    pub reason: String,
    pub command: Option<String>,
    pub expected_impact: Option<String>,
    pub risk: String,
    #[serde(default = "default_step_status")]
    pub status: String,
    pub requires_approval: bool,
}

// Agent v2: tool-use loop types

/// A single tool call emitted by the AI during an agentic loop iteration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
    /// Gemini thinking models attach a thought_signature to each function call.
    /// We round-trip it back verbatim so Gemini doesn't reject the next turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought_signature: Option<String>,
}

/// Internal representation of a message in the agent conversation.
/// Not serialized directly — each provider converts this to its own wire format.
#[derive(Debug, Clone)]
pub enum AgentMessage {
    User(String),
    Assistant {
        text: Option<String>,
        tool_calls: Vec<ToolCall>,
    },
    ToolResult {
        tool_call_id: String,
        tool_name: String,
        content: String,
    },
}

/// Parsed response from a provider call inside the agent loop.
#[derive(Debug, Clone)]
pub struct AssistantResponse {
    pub text: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    /// True when the provider already emitted `ai:agent-thinking` events
    /// during streaming — the loop should skip its own thinking emit.
    pub thinking_streamed: bool,
}

/// A single turn in the prior conversation, sent from the frontend so the
/// agent has context across multiple runs in the same session.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentHistoryEntry {
    /// "user" or "assistant"
    pub role: String,
    pub text: String,
}

/// Tauri command input for starting an agent run.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRequest {
    pub run_id: String,
    pub goal: String,
    pub context: TerminalContext,
    pub connection_id: Option<String>,
    /// Human-readable connection name used as the brain folder prefix (e.g. "production-server").
    #[serde(default)]
    pub connection_label: Option<String>,
    /// Previous turns (user goals + agent summaries) for multi-turn context.
    #[serde(default)]
    pub history: Vec<AgentHistoryEntry>,
    /// If set, skip the planning phase and use these steps directly.
    #[serde(default)]
    pub approved_plan: Option<Vec<AgentPlanStep>>,
}

// ── Frontend event payloads ────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentThinkingEvent {
    pub run_id: String,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolStartEvent {
    pub run_id: String,
    pub tool_call_id: String,
    pub name: String,
    pub input: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutputEvent {
    pub run_id: String,
    pub tool_call_id: String,
    pub chunk: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolDiffEvent {
    pub run_id: String,
    pub tool_call_id: String,
    pub path: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolDoneEvent {
    pub run_id: String,
    pub tool_call_id: String,
    pub name: String,
    pub success: bool,
    pub output: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentCheckpointEvent {
    pub run_id: String,
    pub checkpoint_id: String,
    pub question: String,
    /// The exact command being approved, if this checkpoint is for a run_command call.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentDoneEvent {
    pub run_id: String,
    pub success: bool,
    pub summary: String,
    /// Structured log of actions taken: "▶ ls -la", "✎ Wrote: /etc/nginx.conf", etc.
    #[serde(default)]
    pub actions: Vec<String>,
    /// Absolute path to the brain session folder written at run completion.
    #[serde(default)]
    pub session_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentPlanEvent {
    pub run_id: String,
    /// Used as the response-channel key — same map as agent_checkpoints.
    pub plan_id: String,
    pub summary: String,
    pub steps: Vec<AgentPlanStep>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentErrorEvent {
    pub run_id: String,
    pub message: String,
}
