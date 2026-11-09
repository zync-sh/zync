use std::{sync::Mutex, time::Duration};

use reqwest::{header::HeaderValue, Client, Method, RequestBuilder, Url};
use tauri::AppHandle;

use crate::ai::transport::{
    error_without_url, pooled_client, REQUEST_TIMEOUT, STREAM_CONNECT_TIMEOUT,
};
use crate::ai::{
    build_single_prompt, is_billing_error, read_error_body, read_sse_stream, AiConfig, ChatMessage,
    TerminalContext,
};

const MODELS_ENDPOINT: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const API_KEY_HEADER: &str = "x-goog-api-key";

#[cfg(test)]
mod tests;

/// Keep Gemini pools separate because reqwest may forward custom headers on redirects.
fn gemini_client(streaming: bool) -> Result<Client, String> {
    static REQUEST_CLIENT: Mutex<Option<Client>> = Mutex::new(None);
    static STREAM_CLIENT: Mutex<Option<Client>> = Mutex::new(None);
    let cache = if streaming {
        &STREAM_CLIENT
    } else {
        &REQUEST_CLIENT
    };
    pooled_client(cache, || {
        let builder = Client::builder().redirect(reqwest::redirect::Policy::none());
        if streaming {
            builder.connect_timeout(STREAM_CONNECT_TIMEOUT)
        } else {
            builder.timeout(REQUEST_TIMEOUT)
        }
    })
}

/// Encode the model as one path segment and leave only the SSE format in the query.
fn generation_url(model: &str, streaming: bool) -> Url {
    let mut url = Url::parse(MODELS_ENDPOINT).expect("valid Gemini models URL");
    let operation = if streaming {
        "streamGenerateContent"
    } else {
        "generateContent"
    };
    url.path_segments_mut()
        .expect("Gemini models URL supports path segments")
        .push(&format!("{model}:{operation}"));
    if streaming {
        url.query_pairs_mut().append_pair("alt", "sse");
    }
    url
}

/// Use the same header value for authentication and redaction of echoed keys.
fn gemini_api_key(config: &AiConfig) -> Option<&str> {
    config
        .api_key()
        .map(str::trim)
        .filter(|key| !key.is_empty())
}

/// Attach a key to one request without putting it in URLs or debug output.
fn authenticated_request(
    client: &Client,
    method: Method,
    url: Url,
    api_key: &str,
) -> Result<RequestBuilder, String> {
    let mut value = HeaderValue::from_str(api_key)
        .map_err(|_| "Invalid Gemini API key format. Check Settings -> AI.".to_string())?;
    value.set_sensitive(true);
    Ok(client.request(method, url).header(API_KEY_HEADER, value))
}

/// Keep provider error details useful if the server echoes the supplied key.
async fn gemini_error_detail(response: reqwest::Response, api_key: &str) -> String {
    read_error_body(response)
        .await
        .replace(api_key, "[REDACTED]")
}

pub async fn call(
    query: &str,
    context: &TerminalContext,
    config: &AiConfig,
    history: &[ChatMessage],
) -> Result<String, String> {
    let api_key = gemini_api_key(config)
        .ok_or_else(|| "Gemini API key not configured. Go to Settings -> AI.".to_string())?;
    let model = config.model.as_deref().unwrap_or("gemini-2.0-flash");
    let prompt = build_single_prompt(query, context, history);
    let client = gemini_client(false)?;

    let body = serde_json::json!({
        "contents": [{ "parts": [{ "text": prompt }] }],
        "generationConfig": { "temperature": 0.0 }
    });

    let response =
        authenticated_request(&client, Method::POST, generation_url(model, false), api_key)?
            .json(&body)
            .send()
            .await
            .map_err(error_without_url)?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("Invalid Gemini API key. Check Settings -> AI.".to_string());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(format!(
            "Rate limit reached for '{}'. Switch to 'gemini-2.0-flash' or wait a moment.",
            model
        ));
    }
    if !status.is_success() {
        let detail = gemini_error_detail(response, api_key).await;
        if is_billing_error(&detail) {
            return Err(format!("Gemini billing error: {}", detail));
        }
        return Err(format!("Gemini ({}): {}", model, detail));
    }

    let json: serde_json::Value = response.json().await.map_err(error_without_url)?;
    let text = json
        .get("candidates")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.get(0))
        .and_then(|p| p.get("text"))
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
    let api_key = gemini_api_key(config)
        .ok_or_else(|| "Gemini API key not configured. Go to Settings -> AI.".to_string())?;
    let model = config.model.as_deref().unwrap_or("gemini-2.0-flash");
    let prompt = build_single_prompt(query, context, history);
    let client = gemini_client(true)?;

    let body = serde_json::json!({
        "contents": [{ "parts": [{ "text": prompt }] }],
        "generationConfig": { "temperature": 0.0 }
    });

    let response =
        authenticated_request(&client, Method::POST, generation_url(model, true), api_key)?
            .json(&body)
            .send()
            .await
            .map_err(error_without_url)?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("Invalid Gemini API key. Check Settings -> AI.".to_string());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(format!(
            "Model '{}' is rate limited. Switch to 'gemini-2.0-flash'.",
            model
        ));
    }
    if !status.is_success() {
        let detail = gemini_error_detail(response, api_key).await;
        if is_billing_error(&detail) {
            return Err(format!("Gemini billing error: {detail}"));
        }
        return Err(format!("Gemini error for '{}': {}", model, detail));
    }

    fn extract_gemini_token(data: &str) -> Option<String> {
        serde_json::from_str::<serde_json::Value>(data)
            .ok()
            .and_then(|v| {
                v.get("candidates")?
                    .get(0)?
                    .get("content")?
                    .get("parts")?
                    .get(0)?
                    .get("text")?
                    .as_str()
                    .map(|s| s.to_string())
            })
    }

    read_sse_stream(app, request_id, response, extract_gemini_token).await
}

// ── Agent tool-use call ───────────────────────────────────────────────────────

/// Non-streaming call with function_declarations support for the agentic loop.
pub async fn call_agent(
    _app: &AppHandle,
    _run_id: &str,
    system: &str,
    messages: &[crate::ai::types::AgentMessage],
    config: &AiConfig,
    tool_schemas: serde_json::Value,
) -> Result<crate::ai::types::AssistantResponse, String> {
    use crate::ai::types::{AgentMessage, ToolCall};

    let api_key = gemini_api_key(config)
        .ok_or_else(|| "Gemini API key not configured. Go to Settings -> AI.".to_string())?;
    let model = config.model.as_deref().unwrap_or("gemini-2.0-flash");
    let client = gemini_client(false)?;

    // Convert messages to Gemini `contents` format
    // Gemini uses "user" / "model" roles and does not have a separate "system" role in contents.
    let mut contents: Vec<serde_json::Value> = Vec::new();

    for m in messages {
        match m {
            AgentMessage::User(text) => {
                contents.push(serde_json::json!({
                    "role": "user",
                    "parts": [{ "text": text }]
                }));
            }
            AgentMessage::Assistant { text, tool_calls } => {
                let mut parts: Vec<serde_json::Value> = Vec::new();
                if let Some(t) = text {
                    if !t.is_empty() {
                        parts.push(serde_json::json!({ "text": t }));
                    }
                }
                for tc in tool_calls {
                    let fc = serde_json::json!({
                        "name": tc.name,
                        "args": tc.input
                    });
                    // Round-trip thoughtSignature at the part level — that is where Gemini
                    // thinking models expect to find it when replaying history.
                    let mut part = serde_json::json!({ "functionCall": fc });
                    if let Some(ts) = &tc.thought_signature {
                        part["thoughtSignature"] = serde_json::Value::String(ts.clone());
                    }
                    parts.push(part);
                }
                contents.push(serde_json::json!({ "role": "model", "parts": parts }));
            }
            AgentMessage::ToolResult {
                tool_call_id: _,
                tool_name,
                content,
            } => {
                // Gemini tool results go back as user-role functionResponse parts
                contents.push(serde_json::json!({
                    "role": "user",
                    "parts": [{
                        "functionResponse": {
                            "name": tool_name,
                            "response": { "output": content }
                        }
                    }]
                }));
            }
        }
    }

    let url = generation_url(model, false);

    let body = serde_json::json!({
        "systemInstruction": { "parts": [{ "text": system }] },
        "contents": contents,
        "tools": tool_schemas,
        "generationConfig": { "temperature": 0.0 }
    });

    // Retry up to 2× on rate-limit with back-off.
    let mut last_err = String::new();
    let response = 'retry: {
        for (attempt, &wait) in std::iter::once(&0u64).chain([5u64, 15].iter()).enumerate() {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
            }
            let resp = authenticated_request(&client, Method::POST, url.clone(), api_key)?
                .json(&body)
                .send()
                .await
                .map_err(error_without_url)?;
            let status = resp.status();
            if status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN
            {
                return Err("Invalid Gemini API key. Check Settings -> AI.".to_string());
            }
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let reset_hint = resp
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .map(|raw| {
                        if let Ok(s) = raw.trim().parse::<u64>() {
                            if s < 60 {
                                format!(" — resets in {s}s")
                            } else {
                                format!(" — resets in {}m {}s", s / 60, s % 60)
                            }
                        } else {
                            String::new()
                        }
                    })
                    .unwrap_or_default();
                last_err = format!("Gemini rate limit for '{model}'{reset_hint}. Retrying…");
                continue;
            }
            break 'retry resp;
        }
        return Err(last_err.replace("Retrying…", "Please wait and try again."));
    };
    let _ = last_err;

    let status = response.status();
    if !status.is_success() {
        let detail = gemini_error_detail(response, api_key).await;
        if is_billing_error(&detail) {
            return Err(format!("Gemini billing error: {detail}"));
        }
        return Err(format!("Gemini ({model}): {detail}"));
    }

    let json: serde_json::Value = response.json().await.map_err(error_without_url)?;

    let parts = json
        .get("candidates")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();

    let mut text_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();

    for part in &parts {
        // Skip internal thought parts (thinking models) — they must not appear in text output.
        if part
            .get("thought")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            continue;
        }

        if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
            if !text.is_empty() {
                text_parts.push(text.to_string());
            }
        }
        if let Some(fc) = part.get("functionCall") {
            let name = fc
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let input = fc
                .get("args")
                .cloned()
                .unwrap_or(serde_json::Value::Object(Default::default()));
            // Gemini doesn't give tool_call IDs — generate one.
            let id = uuid::Uuid::new_v4().to_string();
            // Preserve thoughtSignature so the next turn is accepted by thinking models.
            // It can appear inside `functionCall` OR at the part level — check both.
            let thought_signature = fc
                .get("thoughtSignature")
                .or_else(|| part.get("thoughtSignature"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            tool_calls.push(ToolCall {
                id,
                name,
                input,
                thought_signature,
            });
        }
    }

    Ok(crate::ai::types::AssistantResponse {
        text: if text_parts.is_empty() {
            None
        } else {
            Some(text_parts.join("\n"))
        },
        tool_calls,
        thinking_streamed: false,
    })
}

pub async fn get_models(config: &AiConfig) -> Result<Vec<String>, String> {
    let api_key = gemini_api_key(config).ok_or_else(|| "No API key configured".to_string())?;

    let client = gemini_client(false)?;
    let url = Url::parse(MODELS_ENDPOINT).expect("valid Gemini models URL");
    let resp = authenticated_request(&client, Method::GET, url, api_key)?
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(error_without_url)?;
    if !resp.status().is_success() {
        return Err(format!("Gemini API error: {}", resp.status()));
    }

    let json: serde_json::Value = resp.json().await.map_err(error_without_url)?;
    let mut models: Vec<String> = json["models"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter(|m| {
            m["supportedGenerationMethods"]
                .as_array()
                .map(|arr| arr.iter().any(|v| v.as_str() == Some("generateContent")))
                .unwrap_or(false)
        })
        .filter_map(|m| {
            m["name"]
                .as_str()
                .map(|n| n.trim_start_matches("models/").to_string())
        })
        .filter(|id| {
            id.starts_with("gemini-")
                && !id.contains("-exp")
                && !id.contains("-preview")
                && !id.contains("experimental")
                && !id.contains("-tuning")
                && !id.contains("-thinking")
                && !id.contains("aqa")
                // Drop versioned snapshots (-001, -002, etc.) — prefer the base model name
                && !id.ends_with("-001")
                && !id.ends_with("-002")
                // Drop -latest alias variants — they duplicate the base model
                && !id.ends_with("-latest")
                // Drop specialised modality variants
                && !id.contains("-image")
                && !id.contains("-audio")
                // Drop legacy 1.0 / gemini-pro (replaced by 1.5 / 2.x)
                && !id.starts_with("gemini-1.0")
                && id != "gemini-pro"
        })
        .collect();

    models.sort_by(|a, b| b.cmp(a));
    Ok(models)
}
