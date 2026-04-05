use tauri::AppHandle;

use tauri::Emitter;

use crate::ai::{
    build_user_prompt, is_billing_error, make_client, make_stream_client, read_error_body,
    read_sse_stream, AiConfig, ChatMessage, TerminalContext, SYSTEM_PROMPT,
};
use crate::ai::types::AgentThinkingEvent;

const DEFAULT_MODEL: &str = "claude-haiku-4-5-20251001";

pub async fn call(
    query: &str,
    context: &TerminalContext,
    config: &AiConfig,
    history: &[ChatMessage],
) -> Result<String, String> {
    let api_key = config
        .api_key()
        .ok_or_else(|| "Claude API key not configured. Go to Settings -> AI.".to_string())?;
    let model = config.model.as_deref().unwrap_or(DEFAULT_MODEL);
    let user_prompt = build_user_prompt(query, context, history);
    let client = make_client().await?;

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1024,
        "temperature": 0.0,
        "system": SYSTEM_PROMPT,
        "messages": [{ "role": "user", "content": user_prompt }]
    });

    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("Invalid Claude API key. Check Settings -> AI.".to_string());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(format!(
            "Rate limit reached for '{}'. Wait a moment or switch models.",
            model
        ));
    }
    if !status.is_success() {
        let detail = read_error_body(response).await;
        if is_billing_error(&detail) {
            return Err(format!("Claude billing error: {}", detail));
        }
        return Err(format!("Claude ({}): {}", model, detail));
    }

    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    let text = json
        .get("content")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("");

    Ok(text.to_string())
}

pub async fn stream(
    app: &AppHandle,
    request_id: &str,
    query: &str,
    context: &TerminalContext,
    config: &AiConfig,
    history: &[ChatMessage],
) -> Result<String, String> {
    let api_key = config
        .api_key()
        .ok_or_else(|| "Claude API key not configured. Go to Settings -> AI.".to_string())?;
    let model = config.model.as_deref().unwrap_or(DEFAULT_MODEL);
    let user_prompt = build_user_prompt(query, context, history);
    let client = make_stream_client().await?;

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1024,
        "temperature": 0.0,
        "system": SYSTEM_PROMPT,
        "messages": [{ "role": "user", "content": user_prompt }],
        "stream": true
    });

    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("Invalid Claude API key. Check Settings -> AI.".to_string());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(format!(
            "Rate limit reached for '{}'. Wait a moment or switch models.",
            model
        ));
    }
    if !status.is_success() {
        let detail = read_error_body(response).await;
        if is_billing_error(&detail) {
            return Err(format!("Claude billing error: {}", detail));
        }
        return Err(format!("Claude ({}): {}", model, detail));
    }

    fn extract_claude_token(data: &str) -> Option<String> {
        let v = serde_json::from_str::<serde_json::Value>(data).ok()?;
        if v.get("type")?.as_str()? == "content_block_delta" {
            v.get("delta")?.get("text")?.as_str().map(|s| s.to_string())
        } else {
            None
        }
    }

    read_sse_stream(app, request_id, response, extract_claude_token).await
}

// ── Agent tool-use call ───────────────────────────────────────────────────────

/// Streaming agent call — emits `ai:agent-thinking` events as text arrives,
/// accumulates tool calls, and returns the full AssistantResponse.
pub async fn call_agent(
    app: &AppHandle,
    run_id: &str,
    system: &str,
    messages: &[crate::ai::types::AgentMessage],
    config: &AiConfig,
    tool_schemas: serde_json::Value,
) -> Result<crate::ai::types::AssistantResponse, String> {
    use std::collections::HashMap;
    use crate::ai::types::{AgentMessage, AssistantResponse, ToolCall};

    let api_key = config
        .api_key()
        .ok_or_else(|| "Claude API key not configured. Go to Settings -> AI.".to_string())?;
    let model = config.model.as_deref().unwrap_or(DEFAULT_MODEL);
    let client = make_stream_client().await?;

    let wire_messages: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| match m {
            AgentMessage::User(text) => serde_json::json!({ "role": "user", "content": text }),
            AgentMessage::Assistant { text, tool_calls } => {
                let mut parts: Vec<serde_json::Value> = Vec::new();
                if let Some(t) = text {
                    if !t.is_empty() {
                        parts.push(serde_json::json!({ "type": "text", "text": t }));
                    }
                }
                for tc in tool_calls {
                    parts.push(serde_json::json!({
                        "type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.input
                    }));
                }
                serde_json::json!({ "role": "assistant", "content": parts })
            }
            AgentMessage::ToolResult { tool_call_id, content, .. } => {
                serde_json::json!({
                    "role": "user",
                    "content": [{ "type": "tool_result", "tool_use_id": tool_call_id, "content": content }]
                })
            }
        })
        .collect();

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 4096,
        "temperature": 0.0,
        "system": system,
        "messages": wire_messages,
        "tools": tool_schemas,
        "stream": true
    });

    // Retry up to 2× on rate-limit with back-off (same pattern as openai_compat).
    let mut last_err = String::new();
    let response = 'retry: {
        for (attempt, &wait) in std::iter::once(&0u64).chain([5u64, 15].iter()).enumerate() {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
            }
            let resp = client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = resp.status();
            if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
                return Err("Invalid Claude API key. Check Settings -> AI.".to_string());
            }
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let reset_hint = resp.headers()
                    .get("retry-after")
                    .or_else(|| resp.headers().get("anthropic-ratelimit-requests-reset"))
                    .or_else(|| resp.headers().get("anthropic-ratelimit-tokens-reset"))
                    .and_then(|v| v.to_str().ok())
                    .map(format_rate_limit_hint)
                    .unwrap_or_default();
                last_err = format!("Claude rate limit for '{model}'{reset_hint}. Retrying…");
                continue;
            }
            break 'retry resp;
        }
        return Err(last_err.replace("Retrying…", "Please wait and try again."));
    };
    let _ = last_err;

    let status = response.status();
    if !status.is_success() {
        let detail = read_error_body(response).await;
        if is_billing_error(&detail) {
            return Err(format!("Claude billing error: {detail}"));
        }
        return Err(format!("Claude ({model}): {detail}"));
    }

    // ── Parse streaming response ──────────────────────────────────────────────
    // block_types[index] = "text" | "tool_use"
    let mut block_types: HashMap<usize, String> = HashMap::new();
    // tool_buffers[index] = (id, name, partial_json)
    let mut tool_buffers: HashMap<usize, (String, String, String)> = HashMap::new();
    let mut text_acc = String::new();

    crate::ai::transport::for_each_sse_data(response, |data| {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else { return };
        match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "content_block_start" => {
                let idx = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                if let Some(block) = v.get("content_block") {
                    let kind = block.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string();
                    if kind == "tool_use" {
                        let id   = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        tool_buffers.insert(idx, (id, name, String::new()));
                    }
                    block_types.insert(idx, kind);
                }
            }
            "content_block_delta" => {
                let idx = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                if let Some(delta) = v.get("delta") {
                    match delta.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                        "text_delta" => {
                            if let Some(chunk) = delta.get("text").and_then(|t| t.as_str()) {
                                if !chunk.is_empty() {
                                    text_acc.push_str(chunk);
                                    if !text_acc.trim_start().starts_with('[') {
                                        let _ = app.emit("ai:agent-thinking", AgentThinkingEvent {
                                            run_id: run_id.to_string(),
                                            text: chunk.to_string(),
                                        });
                                    }
                                }
                            }
                        }
                        "input_json_delta" => {
                            if let Some(partial) = delta.get("partial_json").and_then(|p| p.as_str()) {
                                if let Some(buf) = tool_buffers.get_mut(&idx) {
                                    buf.2.push_str(partial);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }).await?;

    // Build final tool calls in index order
    let mut indices: Vec<usize> = tool_buffers.keys().cloned().collect();
    indices.sort_unstable();
    let tool_calls: Vec<ToolCall> = indices
        .into_iter()
        .filter_map(|idx| {
            let (id, name, json_str) = tool_buffers.remove(&idx)?;
            let input = serde_json::from_str(&json_str).unwrap_or(serde_json::json!({}));
            Some(ToolCall { id, name, input, thought_signature: None })
        })
        .collect();

    Ok(AssistantResponse {
        text: if text_acc.is_empty() { None } else { Some(text_acc) },
        tool_calls,
        thinking_streamed: true,
    })
}

pub async fn get_models(config: &AiConfig) -> Result<Vec<String>, String> {
    let api_key = config
        .api_key()
        .ok_or_else(|| "No API key configured".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get("https://api.anthropic.com/v1/models")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let fallback = vec![
        "claude-opus-4-6".to_string(),
        "claude-sonnet-4-6".to_string(),
        "claude-haiku-4-5-20251001".to_string(),
    ];

    if !resp.status().is_success() {
        return Ok(fallback);
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let models: Vec<String> = json["data"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
        .filter(|id| id.starts_with("claude-"))
        .collect();

    if models.is_empty() {
        Ok(fallback)
    } else {
        Ok(models)
    }
}

fn format_rate_limit_hint(raw: &str) -> String {
    let raw = raw.trim();
    if let Ok(secs) = raw.parse::<u64>() {
        return if secs == 0 { " — resets momentarily".into() }
               else if secs < 60 { format!(" — resets in {secs}s") }
               else { format!(" — resets in {}m {}s", secs / 60, secs % 60) };
    }
    if raw.contains('m') || raw.contains('s') { return format!(" — resets in {raw}"); }
    String::new()
}
