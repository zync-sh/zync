use tauri::{AppHandle, Emitter};

use crate::ai::{
    build_single_prompt, make_client, make_stream_client, read_error_body, AiConfig,
    AiStreamChunk, ChatMessage, TerminalContext,
};

pub async fn call(
    query: &str,
    context: &TerminalContext,
    config: &AiConfig,
    history: &[ChatMessage],
) -> Result<String, String> {
    let base_url = config
        .ollama_url
        .as_deref()
        .unwrap_or("http://localhost:11434");
    let model = config.model.as_deref().unwrap_or("llama3.2");
    let prompt = build_single_prompt(query, context, history);
    let client = make_client().await?;

    let body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
        "options": { "temperature": 0.0 }
    });

    let response = client
        .post(format!("{}/api/generate", base_url))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Ollama not running. Install from ollama.com or run 'ollama serve'. ({})",
                e
            )
        })?;

    if !response.status().is_success() {
        let detail = read_error_body(response).await;
        return Err(format!("Ollama error: {}", detail));
    }

    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    Ok(json
        .get("response")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

pub async fn stream(
    app: &AppHandle,
    request_id: &str,
    query: &str,
    context: &TerminalContext,
    config: &AiConfig,
    history: &[ChatMessage],
) -> Result<String, String> {
    let base_url = config
        .ollama_url
        .as_deref()
        .unwrap_or("http://localhost:11434");
    let model = config.model.as_deref().unwrap_or("llama3.2");
    let prompt = build_single_prompt(query, context, history);
    let client = make_stream_client().await?;

    let body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": true,
        "options": { "temperature": 0.0 }
    });

    let response = client
        .post(format!("{}/api/generate", base_url))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Ollama not running. Install from ollama.com or run 'ollama serve'. ({})",
                e
            )
        })?;

    if !response.status().is_success() {
        let detail = read_error_body(response).await;
        return Err(format!("Ollama error: {}", detail));
    }

    let mut accumulated = String::new();
    let mut byte_buf: Vec<u8> = Vec::new();
    let mut resp = response;

    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        byte_buf.extend_from_slice(&chunk);

        let valid_len = match std::str::from_utf8(&byte_buf) {
            Ok(_) => byte_buf.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid_len == 0 {
            continue;
        }

        let text = std::str::from_utf8(&byte_buf[..valid_len]).unwrap();
        let mut processed_to = 0;
        let mut line_start = 0;

        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                let line = text[line_start..i].trim();
                line_start = i + 1;
                processed_to = i + 1;

                if line.is_empty() {
                    continue;
                }
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
                    if let Some(err_msg) = json.get("error").and_then(|v| v.as_str()) {
                        return Err(format!("Ollama error: {}", err_msg));
                    }
                    if let Some(token) = json.get("response").and_then(|v| v.as_str()) {
                        if !token.is_empty() {
                            accumulated.push_str(token);
                            let _ = app.emit(
                                "ai:stream-chunk",
                                AiStreamChunk {
                                    request_id: request_id.to_string(),
                                    chunk: token.to_string(),
                                    done: false,
                                    error: None,
                                },
                            );
                        }
                    }
                }
            }
        }

        let remaining = &byte_buf[processed_to.min(valid_len)..valid_len];
        let trailing = &byte_buf[valid_len..];
        let mut new_buf = Vec::with_capacity(remaining.len() + trailing.len());
        new_buf.extend_from_slice(remaining);
        new_buf.extend_from_slice(trailing);
        byte_buf = new_buf;
    }

    Ok(accumulated)
}

// ── Agent tool-use call ───────────────────────────────────────────────────────

/// Tool-use call via the Ollama `/api/chat` endpoint.
/// Supported by llama3.1+ and other capable models. Falls back to a
/// JSON-prompted approach for older models.
pub async fn call_agent(
    _app: &AppHandle,
    _run_id: &str,
    system: &str,
    messages: &[crate::ai::types::AgentMessage],
    config: &AiConfig,
    tool_schemas: serde_json::Value,
) -> Result<crate::ai::types::AssistantResponse, String> {
    use crate::ai::types::{AgentMessage, AssistantResponse, ToolCall};

    let base_url = config.ollama_url.as_deref().unwrap_or("http://localhost:11434");
    let model = config.model.as_deref().unwrap_or("llama3.2");
    let client = make_client().await?;

    // Build OpenAI-compatible messages (Ollama /api/chat accepts this format)
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
                let mut msg = serde_json::json!({
                    "role": "assistant",
                    "content": text.as_deref().unwrap_or("")
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
        "stream": false,
        "options": { "temperature": 0.0 }
    });

    let response = client
        .post(format!("{base_url}/api/chat"))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Ollama not running. Install from ollama.com or run 'ollama serve'. ({})",
                e
            )
        })?;

    if !response.status().is_success() {
        let detail = read_error_body(response).await;
        return Err(format!("Ollama error: {detail}"));
    }

    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    let message = json
        .get("message")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let text = message
        .get("content")
        .and_then(|c| c.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let tool_calls = message
        .get("tool_calls")
        .and_then(|tc| tc.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|tc| {
            // Prefer the ID Ollama provided (if any) so ToolResult messages can match it.
            let id = tc.get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let name = tc.get("function")?.get("name")?.as_str()?.to_string();
            let args_val = tc.get("function").and_then(|f| f.get("arguments"));
            let input = match args_val {
                Some(serde_json::Value::String(s)) => {
                    serde_json::from_str(s).unwrap_or(serde_json::json!({}))
                }
                Some(v) => v.clone(),
                None => serde_json::json!({}),
            };
            Some(ToolCall { id, name, input, thought_signature: None })
        })
        .collect();

    Ok(AssistantResponse { text, tool_calls, thinking_streamed: false })
}

pub async fn get_models(config: &AiConfig) -> Result<Vec<String>, String> {
    let base_url = config
        .ollama_url
        .as_deref()
        .unwrap_or("http://localhost:11434");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(format!("{}/api/tags", base_url))
        .send()
        .await
        .map_err(|_| "Ollama not available".to_string())?;

    if !response.status().is_success() {
        return Err(format!("Ollama error: {}", response.status()));
    }

    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    let mut models: Vec<String> = json["models"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["name"].as_str())
                .map(|s| {
                    if s.ends_with(":latest") {
                        s.split(':').next().unwrap_or(s).to_string()
                    } else {
                        s.to_string()
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    models.sort();
    models.dedup();
    Ok(models)
}
