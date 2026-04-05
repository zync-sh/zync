use tauri::{AppHandle, Emitter};

use crate::ai::{
    build_user_prompt, is_billing_error, make_client, make_stream_client, read_error_body,
    read_sse_stream, AiConfig, ChatMessage, SYSTEM_PROMPT, TerminalContext,
};
use crate::ai::types::AgentThinkingEvent;

pub async fn call(
    provider_name: &str,
    base_url: &str,
    default_model: &str,
    query: &str,
    context: &TerminalContext,
    config: &AiConfig,
    history: &[ChatMessage],
) -> Result<String, String> {
    let api_key = config
        .api_key()
        .ok_or_else(|| format!("{provider_name} API key not configured. Go to Settings -> AI."))?;
    let model = config.model.as_deref().unwrap_or(default_model);
    let user_prompt = build_user_prompt(query, context, history);
    let client = make_client().await?;

    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": user_prompt }
        ],
        "max_tokens": 1024,
        "temperature": 0.0
    });

    let response = client
        .post(format!("{base_url}/chat/completions"))
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(format!("Invalid {provider_name} API key. Check Settings -> AI."));
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(format!(
            "{provider_name} rate limit reached for '{model}'. Wait a moment or switch models."
        ));
    }
    if !status.is_success() {
        let detail = read_error_body(response).await;
        if is_billing_error(&detail) {
            return Err(format!("{provider_name} billing error: {detail}"));
        }
        return Err(format!("{provider_name} ({model}): {detail}"));
    }

    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    Ok(json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string())
}

pub async fn stream(
    app: &AppHandle,
    provider_name: &str,
    base_url: &str,
    default_model: &str,
    request_id: &str,
    query: &str,
    context: &TerminalContext,
    config: &AiConfig,
    history: &[ChatMessage],
) -> Result<String, String> {
    let api_key = config
        .api_key()
        .ok_or_else(|| format!("{provider_name} API key not configured. Go to Settings -> AI."))?;
    let model = config.model.as_deref().unwrap_or(default_model);
    let user_prompt = build_user_prompt(query, context, history);
    let client = make_stream_client().await?;

    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": user_prompt }
        ],
        "max_tokens": 1024,
        "temperature": 0.0,
        "stream": true
    });

    let response = client
        .post(format!("{base_url}/chat/completions"))
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(format!("Invalid {provider_name} API key. Check Settings -> AI."));
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(format!(
            "{provider_name} rate limit reached for '{model}'. Wait a moment or switch models."
        ));
    }
    if !status.is_success() {
        let detail = read_error_body(response).await;
        if is_billing_error(&detail) {
            return Err(format!("{provider_name} billing error: {detail}"));
        }
        return Err(format!("{provider_name} ({model}): {detail}"));
    }

    fn extract_token(data: &str) -> Option<String> {
        serde_json::from_str::<serde_json::Value>(data)
            .ok()
            .and_then(|v| {
                v.get("choices")?
                    .get(0)?
                    .get("delta")?
                    .get("content")?
                    .as_str()
                    .map(|s| s.to_string())
            })
    }

    read_sse_stream(app, request_id, response, extract_token).await
}

// ── Agent tool-use call ───────────────────────────────────────────────────────

/// Non-streaming call with function_calling support for the agentic loop.
/// Works for OpenAI, Groq, and Mistral (all share the same wire format).
#[allow(clippy::too_many_arguments)]
pub async fn call_agent(
    app: &AppHandle,
    provider_name: &str,
    base_url: &str,
    default_model: &str,
    run_id: &str,
    system: &str,
    messages: &[crate::ai::types::AgentMessage],
    config: &AiConfig,
    tool_schemas: serde_json::Value,
) -> Result<crate::ai::types::AssistantResponse, String> {
    use crate::ai::types::{AgentMessage, AssistantResponse, ToolCall};

    let api_key = config
        .api_key()
        .ok_or_else(|| format!("{provider_name} API key not configured. Go to Settings -> AI."))?;
    let model = config.model.as_deref().unwrap_or(default_model);
    // Use the streaming client — call_agent uses "stream": true so it needs the
    // no-read-timeout client that make_stream_client() provides.
    let client = make_stream_client().await?;

    // System message is always first
    let mut wire: Vec<serde_json::Value> =
        vec![serde_json::json!({ "role": "system", "content": system })];

    for m in messages {
        match m {
            AgentMessage::User(text) => {
                wire.push(serde_json::json!({ "role": "user", "content": text }));
            }
            AgentMessage::Assistant { text, tool_calls } => {
                let tc_wire: Vec<serde_json::Value> = tool_calls
                    .iter()
                    .map(|tc| {
                        serde_json::json!({
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": tc.input.to_string()
                            }
                        })
                    })
                    .collect();

                // When the turn contains tool calls, Mistral (and OpenAI) require
                // content to be null — an empty string "" causes multi-turn confusion
                // where the model falls back to outputting tool calls as raw JSON text.
                let content: Option<&str> = text.as_deref().filter(|s| !s.is_empty());
                let mut msg = serde_json::json!({
                    "role": "assistant",
                    "content": content   // None → null, Some(s) → "s"
                });
                if !tc_wire.is_empty() {
                    msg["tool_calls"] = serde_json::json!(tc_wire);
                }
                wire.push(msg);
            }
            AgentMessage::ToolResult { tool_call_id, content, .. } => {
                wire.push(serde_json::json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": content
                }));
            }
        }
    }

    let body = serde_json::json!({
        "model": model,
        "messages": wire,
        "tools": tool_schemas,
        "max_tokens": 4096,
        "temperature": 0.0,
        "stream": true
    });

    // Retry up to 2× on rate-limit with back-off.
    let mut last_err = String::new();
    let wait_secs = [5u64, 15];
    let response = 'retry: {
        for (attempt, &wait) in std::iter::once(&0u64).chain(wait_secs.iter()).enumerate() {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
            }
            let resp = client
                .post(format!("{base_url}/chat/completions"))
                .header("Authorization", format!("Bearer {api_key}"))
                .json(&body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = resp.status();
            if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
                return Err(format!("Invalid {provider_name} API key. Check Settings -> AI."));
            }
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let reset_hint = resp.headers()
                    .get("retry-after")
                    .or_else(|| resp.headers().get("x-ratelimit-reset-requests"))
                    .or_else(|| resp.headers().get("x-ratelimit-reset-tokens"))
                    .and_then(|v| v.to_str().ok())
                    .map(format_rate_limit_reset)
                    .unwrap_or_default();
                last_err = format!("{provider_name} rate limit for '{model}'{reset_hint}. Retrying…");
                continue;
            }
            if !status.is_success() {
                let detail = read_error_body(resp).await;
                if is_billing_error(&detail) {
                    return Err(format!("{provider_name} billing error: {detail}"));
                }
                return Err(format!("{provider_name} ({model}): {detail}"));
            }
            break 'retry resp;
        }
        return Err(last_err.replace("Retrying…", "Please wait and try again."));
    };
    let _ = last_err;

    // ── Parse streaming response ──────────────────────────────────────────────
    // tool_buffers[index] = (id, name, partial_args)
    let mut tool_buffers: std::collections::HashMap<usize, (String, String, String)> =
        std::collections::HashMap::new();
    let mut text_acc = String::new();

    crate::ai::transport::for_each_sse_data(response, |data| {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else { return };
        let Some(delta) = v.get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("delta")) else { return };

        // Text chunk
        if let Some(chunk) = delta.get("content").and_then(|c| c.as_str()) {
            if !chunk.is_empty() {
                text_acc.push_str(chunk);
                // If the accumulating text looks like a JSON tool-call array,
                // don't emit it as thinking — the fallback parser will handle it
                // silently so the user never sees raw JSON in the chat.
                if !text_acc.trim_start().starts_with('[') {
                    let _ = app.emit("ai:agent-thinking", AgentThinkingEvent {
                        run_id: run_id.to_string(),
                        text: chunk.to_string(),
                    });
                }
            }
        }

        // Tool call chunks
        if let Some(tc_arr) = delta.get("tool_calls").and_then(|t| t.as_array()) {
            for tc_delta in tc_arr {
                let idx = tc_delta.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                // First chunk for this tool call carries id + name
                if let Some(id) = tc_delta.get("id").and_then(|v| v.as_str()) {
                    let name = tc_delta.get("function")
                        .and_then(|f| f.get("name")).and_then(|n| n.as_str())
                        .unwrap_or("").to_string();
                    tool_buffers.entry(idx).or_insert((id.to_string(), name, String::new()));
                }
                // Accumulate partial JSON arguments
                if let Some(partial) = tc_delta.get("function")
                    .and_then(|f| f.get("arguments")).and_then(|a| a.as_str())
                {
                    if let Some(buf) = tool_buffers.get_mut(&idx) {
                        buf.2.push_str(partial);
                    }
                }
            }
        }
    }).await?;

    let mut indices: Vec<usize> = tool_buffers.keys().cloned().collect();
    indices.sort_unstable();
    let tool_calls: Vec<ToolCall> = indices
        .into_iter()
        .filter_map(|idx| {
            let (id, name, args) = tool_buffers.remove(&idx)?;
            let input = serde_json::from_str(&args).unwrap_or(serde_json::json!({}));
            Some(ToolCall { id, name, input, thought_signature: None })
        })
        .collect();

    Ok(AssistantResponse {
        text: if text_acc.is_empty() { None } else { Some(text_acc) },
        tool_calls,
        thinking_streamed: true,
    })
}

/// Parses a `retry-after` or `x-ratelimit-reset-*` header value into a
/// human-readable reset hint, e.g. " — resets in 1m 30s".
fn format_rate_limit_reset(raw: &str) -> String {
    let raw = raw.trim();
    // Numeric seconds (e.g. "retry-after: 90")
    if let Ok(secs) = raw.parse::<u64>() {
        return if secs == 0 {
            " — resets momentarily".into()
        } else if secs < 60 {
            format!(" — resets in {secs}s")
        } else {
            format!(" — resets in {}m {}s", secs / 60, secs % 60)
        };
    }
    // Already human-readable (e.g. "2m30s", "1m0s")
    if raw.contains('m') || raw.contains('s') {
        return format!(" — resets in {raw}");
    }
    String::new()
}

pub async fn get_models(
    provider_name: &str,
    base_url: &str,
    config: &AiConfig,
    include_model: fn(&str) -> bool,
) -> Result<Vec<String>, String> {
    let api_key = config
        .api_key()
        .ok_or_else(|| format!("No {provider_name} API key configured"))?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(format!("{base_url}/models"))
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("{provider_name} API error: {}", resp.status()));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut models: Vec<String> = json["data"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
        .filter(|id| include_model(id))
        .collect();

    models.sort_by(|a, b| b.cmp(a));
    models.dedup();
    Ok(models)
}
