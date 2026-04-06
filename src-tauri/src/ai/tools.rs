//! Agent tool definitions, JSON schemas for each provider, safety checks,
//! and tool execution logic.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::ai::types::ToolCall;
use crate::commands::ConnectionHandle;
use crate::ai::tool_exec_support::{
    is_dangerous_command,
    validate_command,
    validate_path,
};
use crate::ai::tool_schemas::{
    planning_tool_schemas_claude,
    planning_tool_schemas_gemini,
    planning_tool_schemas_openai,
    tool_schemas_claude,
    tool_schemas_gemini,
    tool_schemas_openai,
};

// ── Tool schemas ──────────────────────────────────────────────────────────────

pub fn execution_tool_schemas(config: &crate::ai::AiConfig) -> serde_json::Value {
    match config.provider.as_str() {
        "gemini" => tool_schemas_gemini(),
        "claude"  => tool_schemas_claude(),
        _ => tool_schemas_openai(),
    }
}

pub fn planning_tool_schemas(config: &crate::ai::AiConfig) -> serde_json::Value {
    match config.provider.as_str() {
        "gemini" => planning_tool_schemas_gemini(),
        "claude"  => planning_tool_schemas_claude(),
        _ => planning_tool_schemas_openai(),
    }
}

/// Borrowed context passed into every tool execution call.
/// 
/// Note: `session_dir` tracks the active session path, allowing heavily verbose
/// tool outputs (like large read_file or command actions) to automatically stream
/// artifacts to disk to circumvent AI buffer overruns.
pub struct ToolContext<'a> {
    pub app: &'a AppHandle,
    pub connections: &'a Arc<Mutex<HashMap<String, ConnectionHandle>>>,
    pub connection_id: Option<&'a str>,
    pub run_id: &'a str,
    pub session_dir: Option<PathBuf>,
}

pub async fn execute_tool(ctx: &ToolContext<'_>, tool_call: &ToolCall) -> Result<String, String> {
    match tool_call.name.as_str() {
        "run_command" => {
            let cmd = tool_call
                .input
                .get("command")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'command' parameter")?;

            validate_command(cmd)?;
            if is_dangerous_command(cmd) {
                return Err(format!(
                    "Blocked by safety policy. Use ask_user to request manual approval: {}",
                    cmd
                ));
            }
            exec_command(ctx, cmd, &tool_call.id).await
        }

        "read_file" => {
            let path = tool_call
                .input
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'path' parameter")?;
            validate_path(path)?;
            read_file(ctx, path, &tool_call.id).await
        }

        "write_file" => {
            let path = tool_call
                .input
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'path' parameter")?;
            let content = tool_call
                .input
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'content' parameter")?;
            validate_path(path)?;
            if content.len() > 512_000 {
                return Err(format!(
                    "Content is too large ({} bytes, max 512 KB). Write the file in smaller chunks.",
                    content.len()
                ));
            }
            write_file(ctx, path, content, &tool_call.id).await
        }

        "list_files" => {
            let path = tool_call
                .input
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("Missing 'path' parameter")?;
            validate_path(path)?;
            list_files(ctx, path, &tool_call.id).await
        }

        name => Err(format!("Unknown tool: {}", name)),
    }
}

// ── run_command ───────────────────────────────────────────────────────────────

async fn exec_command(ctx: &ToolContext<'_>, cmd: &str, tool_call_id: &str) -> Result<String, String> {
    crate::ai::tool_command_exec::exec_command(ctx, cmd, tool_call_id).await
}

async fn read_file(ctx: &ToolContext<'_>, path: &str, tool_call_id: &str) -> Result<String, String> {
    crate::ai::tool_file_ops::read_file(ctx, path, tool_call_id).await
}

async fn write_file(
    ctx: &ToolContext<'_>,
    path: &str,
    content: &str,
    tool_call_id: &str,
) -> Result<String, String> {
    crate::ai::tool_file_ops::write_file(ctx, path, content, tool_call_id).await
}

async fn list_files(ctx: &ToolContext<'_>, path: &str, tool_call_id: &str) -> Result<String, String> {
    crate::ai::tool_file_ops::list_files(ctx, path, tool_call_id).await
}

pub async fn file_exists(
    app: &AppHandle,
    connections: &Arc<Mutex<HashMap<String, ConnectionHandle>>>,
    connection_id: Option<&str>,
    path: &str,
) -> bool {
    crate::ai::tool_file_ops::file_exists(app, connections, connection_id, path).await
}
