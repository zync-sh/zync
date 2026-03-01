use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;
use tauri::{AppHandle, Emitter, Manager};

/// Compiled regex for stripping `?key=...` / `&key=...` from URLs in error messages.
static KEY_REGEX: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"[?&]key=[^&\s]*").unwrap()
});

/// AI provider configuration stored in `settings.json` under the `"ai"` key.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub provider: String,
    /// Per-provider API keys: { "gemini": "...", "openai": "...", "claude": "..." }
    pub keys: Option<HashMap<String, String>>,
    pub model: Option<String>,
    pub ollama_url: Option<String>,
    pub enabled: bool,
}

impl AiConfig {
    /// Get the API key for the current provider
    fn api_key(&self) -> Option<&str> {
        self.keys.as_ref()
            .and_then(|k| k.get(&self.provider))
            .map(|s| s.as_str())
            .filter(|k| !k.is_empty())
    }
}

/// Terminal session context sent with every AI query for accurate, environment-aware responses.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TerminalContext {
    pub os: Option<String>,
    pub shell: Option<String>,
    pub cwd: Option<String>,
    pub recent_output: Option<String>,
    pub connection_type: String,
}

/// Payload emitted on the `ai:stream-chunk` event for each token received from the provider.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamChunk {
    pub request_id: String,
    pub chunk: String,
    pub done: bool,
    pub error: Option<String>,
}

/// Parsed AI response returned to the frontend after a translation or chat query.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiTranslateResponse {
    pub command: String,
    pub explanation: String,
    pub safety: String,
    #[serde(default)]
    pub answer: Option<String>,
}

/// Payload emitted on the `ai:stream-done` event once the full response has been streamed and parsed.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamDone {
    pub request_id: String,
    pub result: Option<AiTranslateResponse>,
    pub error: Option<String>,
}

/// Read AI config from settings.json
pub fn read_ai_config(app: &AppHandle) -> AiConfig {
    let data_dir = app.path().app_data_dir().unwrap_or_default();
    let settings_path = data_dir.join("settings.json");

    if let Ok(data) = std::fs::read_to_string(settings_path) {
        match serde_json::from_str::<serde_json::Value>(&data) {
            Ok(settings) => {
                if let Some(ai) = settings.get("ai") {
                    match serde_json::from_value::<AiConfig>(ai.clone()) {
                        Ok(config) => return config,
                        #[cfg(debug_assertions)]
                        Err(e) => eprintln!("[zync/ai] Failed to parse AI config: {e}"),
                        #[cfg(not(debug_assertions))]
                        Err(_) => {}
                    }
                } else {
                    #[cfg(debug_assertions)]
                    eprintln!("[zync/ai] settings.json has no 'ai' key — using defaults");
                }
            }
            #[cfg(debug_assertions)]
            Err(e) => eprintln!("[zync/ai] settings.json is not valid JSON: {e}"),
            #[cfg(not(debug_assertions))]
            Err(_) => {}
        }
    }

    AiConfig {
        provider: "ollama".to_string(),
        keys: None,
        model: None,
        ollama_url: Some("http://localhost:11434".to_string()),
        enabled: true,
    }
}

// ── Prompt building ──

const SYSTEM_PROMPT: &str = "\
You are a terminal assistant. Analyze the user's request and pick one of two response modes.\n\
\n\
MODE 1 — Shell command: the user wants to DO something in a terminal (run, install, find, check, kill, list, copy, move, compress, monitor, etc.).\n\
Respond with: {\"command\": \"the shell command\", \"explanation\": \"brief explanation\", \"safety\": \"safe|moderate|dangerous\"}\n\
For multi-step tasks chain commands with &&.\n\
Safety: safe=read-only (ls,cat,ps,df), moderate=modifying but reversible (mkdir,cp,git commit), dangerous=destructive/irreversible (rm -rf,dd,DROP TABLE,kill -9,mkfs).\n\
\n\
MODE 2 — Answer: the user is asking a question or wants an explanation (what is, how does, explain, tell me, describe, why, difference between, etc.).\n\
Respond with: {\"type\": \"chat\", \"answer\": \"clear concise answer in 1-3 sentences\"}\n\
\n\
Respond ONLY with valid JSON (no markdown, no backticks, no extra text).";

/// Build the user-facing portion of the prompt, injecting OS/shell/CWD context and
/// up to 500 characters of recent terminal output before the user's query.
fn build_user_prompt(query: &str, context: &TerminalContext) -> String {
    let mut prompt = format!(
        "OS: {os}\nShell: {shell}\nCWD: {cwd}\nConnection: {conn}",
        os = context.os.as_deref().unwrap_or("Linux"),
        shell = context.shell.as_deref().unwrap_or("bash"),
        cwd = context.cwd.as_deref().unwrap_or("~"),
        conn = context.connection_type,
    );

    if let Some(output) = context.recent_output.as_deref() {
        if !output.is_empty() {
            // Limit to last 500 chars to avoid bloating the prompt (find safe UTF-8 boundary)
            let trimmed = if output.len() > 500 {
                let start = output.len() - 500;
                let safe_start = output.char_indices()
                    .map(|(i, _)| i)
                    .find(|&i| i >= start)
                    .unwrap_or(start);
                &output[safe_start..]
            } else {
                output
            };
            prompt.push_str(&format!("\n\nRecent terminal output:\n{}", trimmed));
        }
    }

    prompt.push_str(&format!("\n\nRequest: {}", query));
    prompt
}

/// Combined prompt for providers that don't support system messages (Ollama, Gemini)
fn build_single_prompt(query: &str, context: &TerminalContext) -> String {
    format!("{}\n\n{}", SYSTEM_PROMPT, build_user_prompt(query, context))
}

// ── Response parsing ──

/// Strip markdown code fences and extract the first `{...}` JSON object from model output.
/// Handles providers that wrap responses in triple-backtick blocks despite being told not to.
fn extract_json(text: &str) -> String {
    let text = text.trim();
    let text = if text.starts_with("```") {
        text.lines()
            .skip(1)
            .take_while(|l| !l.starts_with("```"))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        text.to_string()
    };

    if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            return text[start..=end].to_string();
        }
    }
    text
}

/// Parse raw model output into an [`AiTranslateResponse`].
///
/// Handles both command mode (`{"command": "...", "safety": "..."}`) and
/// chat mode (`{"type": "chat", "answer": "..."}`). Falls back to a
/// `dangerous` sentinel if the JSON is missing or malformed.
fn parse_response(text: &str) -> AiTranslateResponse {
    let cleaned = extract_json(text);
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&cleaned) {
        // Chat / answer mode
        if val.get("type").and_then(|t| t.as_str()) == Some("chat") {
            let answer = val.get("answer").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !answer.is_empty() {
                return AiTranslateResponse {
                    command: String::new(),
                    explanation: String::new(),
                    safety: "safe".to_string(),
                    answer: Some(answer),
                };
            }
        }

        let command = val.get("command").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let explanation = val.get("explanation").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let safety = val.get("safety").and_then(|v| v.as_str()).unwrap_or("moderate").to_string();

        // Validate: command must be non-empty
        if command.is_empty() {
            return AiTranslateResponse {
                command: String::new(),
                explanation: "AI returned an empty command. Try rephrasing your query.".to_string(),
                safety: "dangerous".to_string(),
                answer: None,
            };
        }

        let safety = match safety.as_str() {
            "safe" | "moderate" | "dangerous" => safety,
            _ => "moderate".to_string(),
        };

        return AiTranslateResponse { command, explanation, safety, answer: None };
    }

    // Fallback: could not parse JSON — mark as dangerous to prevent auto-execute
    AiTranslateResponse {
        command: String::new(),
        explanation: "AI response was not valid JSON. Try again.".to_string(),
        safety: "dangerous".to_string(),
        answer: None,
    }
}

// ── HTTP client ──

/// Build a standard HTTP client with a 30-second total timeout for non-streaming requests.
async fn make_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

/// Client for streaming requests — only connect timeout, no total timeout
/// (streaming responses can take much longer than 30s)
async fn make_stream_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

/// Strip API keys from URLs in error messages to prevent leaking secrets.
fn sanitize_error(err: &str) -> String {
    KEY_REGEX.replace_all(err, "").to_string()
}

/// Extract a clean, human-readable message from an API error response.
/// Returns just the message text — no HTTP status codes or raw bodies.
async fn read_error_body(response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    // Try to extract just the message from a JSON error object
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
        if let Some(msg) = json.get("error")
            .and_then(|e| e.get("message").or(Some(e)))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            return msg.to_string();
        }
    }
    // Fallback: short body text or just the status
    if !body.is_empty() && body.len() <= 200 {
        body.trim().to_string()
    } else {
        format!("HTTP {}", status.as_u16())
    }
}

/// Check if an error message indicates a billing / credit issue
fn is_billing_error(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("credit balance") || m.contains("billing") || m.contains("purchase credits")
        || m.contains("payment") || m.contains("insufficient_quota") || m.contains("exceeded your current quota")
}

// ── Provider implementations ──

/// Send a single (non-streaming) request to a local Ollama instance and return the raw text response.
async fn call_ollama(query: &str, context: &TerminalContext, config: &AiConfig) -> Result<String, String> {
    let base_url = config.ollama_url.as_deref().unwrap_or("http://localhost:11434");
    let model = config.model.as_deref().unwrap_or("llama3.2");
    let prompt = build_single_prompt(query, context);
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
        .map_err(|e| format!("Ollama not running. Install from ollama.com or run 'ollama serve'. ({})", e))?;

    if !response.status().is_success() {
        let detail = read_error_body(response).await;
        return Err(format!("Ollama error: {}", detail));
    }

    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    Ok(json.get("response").and_then(|v| v.as_str()).unwrap_or("").to_string())
}

/// Send a single (non-streaming) request to the Gemini API and return the raw text response.
async fn call_gemini(query: &str, context: &TerminalContext, config: &AiConfig) -> Result<String, String> {
    let api_key = config.api_key()
        .ok_or_else(|| "Gemini API key not configured. Go to Settings → AI.".to_string())?;
    let model = config.model.as_deref().unwrap_or("gemini-2.0-flash");
    let prompt = build_single_prompt(query, context);
    let client = make_client().await?;

    let body = serde_json::json!({
        "contents": [{ "parts": [{ "text": prompt }] }],
        "generationConfig": { "temperature": 0.0 }
    });

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        model, api_key
    );

    let response = client.post(&url).json(&body).send().await.map_err(|e| sanitize_error(&e.to_string()))?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("Invalid Gemini API key. Check Settings → AI.".to_string());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(format!(
            "Rate limit reached for '{}'. Switch to 'gemini-2.0-flash' or wait a moment.",
            model
        ));
    }
    if !status.is_success() {
        let detail = read_error_body(response).await;
        if is_billing_error(&detail) {
            return Err(format!("Gemini billing error: {}", detail));
        }
        return Err(format!("Gemini ({}): {}", model, detail));
    }

    let json: serde_json::Value = response.json().await.map_err(|e| sanitize_error(&e.to_string()))?;
    let text = json
        .get("candidates").and_then(|c| c.get(0))
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.get(0))
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("");

    Ok(text.to_string())
}

/// Send a single (non-streaming) request to the OpenAI Chat Completions API and return the raw text response.
async fn call_openai(query: &str, context: &TerminalContext, config: &AiConfig) -> Result<String, String> {
    let api_key = config.api_key()
        .ok_or_else(|| "OpenAI API key not configured. Go to Settings → AI.".to_string())?;
    let model = config.model.as_deref().unwrap_or("gpt-4o-mini");
    let user_prompt = build_user_prompt(query, context);
    let client = make_client().await?;

    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": user_prompt }
        ],
        "max_completion_tokens": 1024,
        "temperature": 0.0
    });

    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("Invalid OpenAI API key. Check Settings → AI.".to_string());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(format!("Rate limit reached for '{}'. Wait a moment or switch models.", model));
    }
    if !status.is_success() {
        let detail = read_error_body(response).await;
        if is_billing_error(&detail) {
            return Err(format!("OpenAI billing error: {}", detail));
        }
        return Err(format!("OpenAI ({}): {}", model, detail));
    }

    let json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    let text = json
        .get("choices").and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("");

    Ok(text.to_string())
}

/// Send a single (non-streaming) request to the Anthropic Messages API and return the raw text response.
async fn call_claude(query: &str, context: &TerminalContext, config: &AiConfig) -> Result<String, String> {
    let api_key = config.api_key()
        .ok_or_else(|| "Claude API key not configured. Go to Settings → AI.".to_string())?;
    let model = config.model.as_deref().unwrap_or("claude-haiku-4-5-20251001");
    let user_prompt = build_user_prompt(query, context);
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
        return Err("Invalid Claude API key. Check Settings → AI.".to_string());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(format!("Rate limit reached for '{}'. Wait a moment or switch models.", model));
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
        .get("content").and_then(|c| c.get(0))
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("");

    Ok(text.to_string())
}

// ── Main translate entry point (non-streaming, kept as fallback) ──

/// Non-streaming translate entry point (kept as fallback).
///
/// Calls the configured provider synchronously, then emits a single `ai:stream-chunk`
/// event with `done: true` so the frontend streaming path still works correctly.
pub async fn translate(
    app: &AppHandle,
    query: String,
    context: TerminalContext,
    request_id: String,
    config: AiConfig,
) -> Result<AiTranslateResponse, String> {
    let raw = match config.provider.as_str() {
        "ollama" => call_ollama(&query, &context, &config).await,
        "gemini" => call_gemini(&query, &context, &config).await,
        "openai" => call_openai(&query, &context, &config).await,
        "claude" => call_claude(&query, &context, &config).await,
        other => Err(format!("Unknown AI provider: {}", other)),
    };

    match raw {
        Ok(text) => {
            let result = parse_response(&text);
            let _ = app.emit("ai:stream-chunk", AiStreamChunk {
                request_id,
                chunk: text,
                done: true,
                error: None,
            });
            Ok(result)
        }
        Err(e) => {
            let _ = app.emit("ai:stream-chunk", AiStreamChunk {
                request_id,
                chunk: String::new(),
                done: true,
                error: Some(e.clone()),
            });
            Err(e)
        }
    }
}

// ── Streaming provider implementations ──

/// Helper: read SSE lines from a streaming response, emit chunks, return accumulated text
async fn read_sse_stream(
    app: &AppHandle,
    request_id: &str,
    mut response: reqwest::Response,
    extract_token: fn(&str) -> Option<String>,
) -> Result<String, String> {
    let mut accumulated = String::new();
    let mut byte_buf: Vec<u8> = Vec::new();

    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        byte_buf.extend_from_slice(&chunk);

        // Find the last valid UTF-8 boundary to avoid splitting multi-byte chars
        let valid_len = match std::str::from_utf8(&byte_buf) {
            Ok(_) => byte_buf.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid_len == 0 { continue; }

        let text = std::str::from_utf8(&byte_buf[..valid_len]).unwrap();
        let mut line_buf = String::new();
        let mut processed_to = 0;

        for (i, ch) in text.char_indices() {
            if ch == '\n' {
                let line = line_buf.trim().to_string();
                line_buf.clear();
                processed_to = i + 1;

                if line.is_empty() || line.starts_with(':') {
                    continue;
                }

                if let Some(data) = line.strip_prefix("data: ") {
                    if data == "[DONE]" {
                        continue;
                    }
                    if let Some(token) = extract_token(data) {
                        if !token.is_empty() {
                            accumulated.push_str(&token);
                            let _ = app.emit("ai:stream-chunk", AiStreamChunk {
                                request_id: request_id.to_string(),
                                chunk: token,
                                done: false,
                                error: None,
                            });
                        }
                    }
                }
            } else {
                line_buf.push(ch);
            }
        }

        // Keep only unprocessed bytes (incomplete line + any trailing incomplete UTF-8)
        let consumed = processed_to.min(valid_len);
        // Rebuild: remaining valid text (incomplete line) + incomplete UTF-8 bytes
        let remaining_text = &byte_buf[consumed..valid_len];
        let trailing = &byte_buf[valid_len..];
        let mut new_buf = Vec::with_capacity(remaining_text.len() + trailing.len());
        new_buf.extend_from_slice(remaining_text);
        new_buf.extend_from_slice(trailing);
        byte_buf = new_buf;
    }

    // Process any remaining complete line in the buffer
    if let Ok(remaining) = std::str::from_utf8(&byte_buf) {
        let line = remaining.trim();
        if !line.is_empty() && !line.starts_with(':') {
            if let Some(data) = line.strip_prefix("data: ") {
                if data != "[DONE]" {
                    if let Some(token) = extract_token(data) {
                        if !token.is_empty() {
                            accumulated.push_str(&token);
                            let _ = app.emit("ai:stream-chunk", AiStreamChunk {
                                request_id: request_id.to_string(),
                                chunk: token,
                                done: false,
                                error: None,
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(accumulated)
}

/// Stream a response from Ollama using newline-delimited JSON (`{"response":"token","done":false}`).
/// Emits `ai:stream-chunk` events for each token and returns the full accumulated text.
async fn stream_ollama(
    app: &AppHandle, request_id: &str, query: &str, context: &TerminalContext, config: &AiConfig,
) -> Result<String, String> {
    let base_url = config.ollama_url.as_deref().unwrap_or("http://localhost:11434");
    let model = config.model.as_deref().unwrap_or("llama3.2");
    let prompt = build_single_prompt(query, context);
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
        .map_err(|e| format!("Ollama not running. Install from ollama.com or run 'ollama serve'. ({})", e))?;

    if !response.status().is_success() {
        let detail = read_error_body(response).await;
        return Err(format!("Ollama error: {}", detail));
    }

    // Ollama streams newline-delimited JSON: {"response": "token", "done": false}
    let mut accumulated = String::new();
    let mut byte_buf: Vec<u8> = Vec::new();
    let mut resp = response;

    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        byte_buf.extend_from_slice(&chunk);

        // Find valid UTF-8 boundary
        let valid_len = match std::str::from_utf8(&byte_buf) {
            Ok(_) => byte_buf.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid_len == 0 { continue; }

        let text = std::str::from_utf8(&byte_buf[..valid_len]).unwrap();
        let mut processed_to = 0;
        let mut line_start = 0;

        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                let line = text[line_start..i].trim();
                line_start = i + 1;
                processed_to = i + 1;

                if line.is_empty() { continue; }
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
                    // Handle Ollama error objects in stream
                    if let Some(err_msg) = json.get("error").and_then(|v| v.as_str()) {
                        return Err(format!("Ollama error: {}", err_msg));
                    }
                    if let Some(token) = json.get("response").and_then(|v| v.as_str()) {
                        if !token.is_empty() {
                            accumulated.push_str(token);
                            let _ = app.emit("ai:stream-chunk", AiStreamChunk {
                                request_id: request_id.to_string(),
                                chunk: token.to_string(),
                                done: false,
                                error: None,
                            });
                        }
                    }
                }
            }
        }

        // Keep unprocessed bytes
        let remaining = &byte_buf[processed_to.min(valid_len)..valid_len];
        let trailing = &byte_buf[valid_len..];
        let mut new_buf = Vec::with_capacity(remaining.len() + trailing.len());
        new_buf.extend_from_slice(remaining);
        new_buf.extend_from_slice(trailing);
        byte_buf = new_buf;
    }

    Ok(accumulated)
}

/// Stream a response from OpenAI Chat Completions using SSE (`data: {...}` lines).
/// Emits `ai:stream-chunk` events for each token and returns the full accumulated text.
async fn stream_openai(
    app: &AppHandle, request_id: &str, query: &str, context: &TerminalContext, config: &AiConfig,
) -> Result<String, String> {
    let api_key = config.api_key()
        .ok_or_else(|| "OpenAI API key not configured. Go to Settings → AI.".to_string())?;
    let model = config.model.as_deref().unwrap_or("gpt-4o-mini");
    let user_prompt = build_user_prompt(query, context);
    let client = make_stream_client().await?;

    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": user_prompt }
        ],
        "max_completion_tokens": 1024,
        "temperature": 0.0,
        "stream": true
    });

    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("Invalid OpenAI API key. Check Settings → AI.".to_string());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(format!("OpenAI rate limit reached for '{}'. Wait a moment or switch models.", model));
    }
    if !status.is_success() {
        let detail = read_error_body(response).await;
        return Err(format!("OpenAI error for '{}': {}", model, detail));
    }

    fn extract_openai_token(data: &str) -> Option<String> {
        serde_json::from_str::<serde_json::Value>(data).ok()
            .and_then(|v| v.get("choices")?.get(0)?.get("delta")?.get("content")?.as_str().map(|s| s.to_string()))
    }

    read_sse_stream(app, request_id, response, extract_openai_token).await
}

/// Stream a response from the Anthropic Messages API using SSE (`data: {...}` lines).
/// Emits `ai:stream-chunk` events for each `content_block_delta` token.
async fn stream_claude(
    app: &AppHandle, request_id: &str, query: &str, context: &TerminalContext, config: &AiConfig,
) -> Result<String, String> {
    let api_key = config.api_key()
        .ok_or_else(|| "Claude API key not configured. Go to Settings → AI.".to_string())?;
    let model = config.model.as_deref().unwrap_or("claude-haiku-4-5-20251001");
    let user_prompt = build_user_prompt(query, context);
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
        return Err("Invalid Claude API key. Check Settings → AI.".to_string());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(format!("Rate limit reached for '{}'. Wait a moment or switch models.", model));
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

/// Stream a response from the Gemini API using its SSE endpoint (`streamGenerateContent?alt=sse`).
/// Emits `ai:stream-chunk` events for each candidate text delta.
async fn stream_gemini(
    app: &AppHandle, request_id: &str, query: &str, context: &TerminalContext, config: &AiConfig,
) -> Result<String, String> {
    let api_key = config.api_key()
        .ok_or_else(|| "Gemini API key not configured. Go to Settings → AI.".to_string())?;
    let model = config.model.as_deref().unwrap_or("gemini-2.0-flash");
    let prompt = build_single_prompt(query, context);
    let client = make_stream_client().await?;

    let body = serde_json::json!({
        "contents": [{ "parts": [{ "text": prompt }] }],
        "generationConfig": { "temperature": 0.0 }
    });

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
        model, api_key
    );

    let response = client.post(&url).json(&body).send().await.map_err(|e| sanitize_error(&e.to_string()))?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("Invalid Gemini API key. Check Settings → AI.".to_string());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(format!("Model '{}' is rate limited. Switch to 'gemini-2.0-flash'.", model));
    }
    if !status.is_success() {
        let detail = read_error_body(response).await;
        return Err(format!("Gemini error for '{}': {}", model, detail));
    }

    fn extract_gemini_token(data: &str) -> Option<String> {
        serde_json::from_str::<serde_json::Value>(data).ok()
            .and_then(|v| v.get("candidates")?.get(0)?.get("content")?.get("parts")?.get(0)?.get("text")?.as_str().map(|s| s.to_string()))
    }

    read_sse_stream(app, request_id, response, extract_gemini_token).await
}

// ── Streaming translate entry point ──

/// Streaming translate entry point called by the `ai_translate_stream` Tauri command.
///
/// Dispatches to the appropriate provider stream function, then emits `ai:stream-done`
/// with the parsed [`AiTranslateResponse`] on success or an error string on failure.
pub async fn translate_stream(
    app: AppHandle,
    query: String,
    context: TerminalContext,
    request_id: String,
    config: AiConfig,
) {
    let raw = match config.provider.as_str() {
        "ollama" => stream_ollama(&app, &request_id, &query, &context, &config).await,
        "gemini" => stream_gemini(&app, &request_id, &query, &context, &config).await,
        "openai" => stream_openai(&app, &request_id, &query, &context, &config).await,
        "claude" => stream_claude(&app, &request_id, &query, &context, &config).await,
        other => Err(format!("Unknown AI provider: {}", other)),
    };

    match raw {
        Ok(text) => {
            let result = parse_response(&text);
            let _ = app.emit("ai:stream-done", AiStreamDone {
                request_id,
                result: Some(result),
                error: None,
            });
        }
        Err(e) => {
            let _ = app.emit("ai:stream-done", AiStreamDone {
                request_id,
                result: None,
                error: Some(e),
            });
        }
    }
}

// ── Utility: check Ollama availability ──

/// Ping the Ollama `/api/tags` endpoint with a 3-second timeout.
/// Returns `true` if Ollama is reachable and responding with a successful status.
pub async fn check_ollama(ollama_url: &str) -> bool {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap_or_default();

    client
        .get(format!("{}/api/tags", ollama_url))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

// ── Model listing per provider ──

/// Fetch the available model list for the currently configured AI provider.
/// Routes to the provider-specific listing function based on `config.provider`.
pub async fn get_provider_models(app: &AppHandle) -> Result<Vec<String>, String> {
    let config = read_ai_config(app);
    match config.provider.as_str() {
        "ollama" => get_ollama_models_internal(&config).await,
        "gemini" => get_gemini_models(&config).await,
        "openai" => get_openai_models(&config).await,
        "claude" => get_claude_models(&config).await,
        _ => Ok(vec![]),
    }
}

/// Internal Ollama model listing (takes config, no AppHandle needed)
async fn get_ollama_models_internal(config: &AiConfig) -> Result<Vec<String>, String> {
    let base_url = config.ollama_url.as_deref().unwrap_or("http://localhost:11434");
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
                .map(|s| s.split(':').next().unwrap_or(s).to_string())
                .collect()
        })
        .unwrap_or_default();

    models.sort();
    models.dedup();
    Ok(models)
}

/// Fetch available Gemini models from the Google AI API, filtered to stable
/// `generateContent`-capable models (excludes experimental, preview, and tuning variants).
async fn get_gemini_models(config: &AiConfig) -> Result<Vec<String>, String> {
    let api_key = config.api_key()
        .ok_or_else(|| "No API key configured".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models?key={}",
        api_key
    );
    let resp = client.get(&url).send().await.map_err(|e| sanitize_error(&e.to_string()))?;
    if !resp.status().is_success() {
        return Err(format!("Gemini API error: {}", resp.status()));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| sanitize_error(&e.to_string()))?;
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
            m["name"].as_str().map(|n| n.trim_start_matches("models/").to_string())
        })
        .filter(|id| {
            id.starts_with("gemini-")
                && !id.contains("-exp")
                && !id.contains("-preview")
                && !id.contains("experimental")
                && !id.contains("-tuning")
                && !id.contains("-thinking")
                && !id.contains("aqa")
        })
        .collect();

    models.sort_by(|a, b| b.cmp(a));
    Ok(models)
}

/// Fetch available OpenAI models, filtered to GPT and reasoning (o-series) chat models
/// and excluding embeddings, TTS, Whisper, realtime, audio, search, and base variants.
async fn get_openai_models(config: &AiConfig) -> Result<Vec<String>, String> {
    let api_key = config.api_key()
        .ok_or_else(|| "No API key configured".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get("https://api.openai.com/v1/models")
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("OpenAI API error: {}", resp.status()));
    }

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut models: Vec<String> = json["data"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
        .filter(|id| {
            (id.starts_with("gpt-") || id == "o1" || id.starts_with("o1-") || id == "o3" || id.starts_with("o3-") || id == "o4" || id.starts_with("o4-"))
                && !id.contains("instruct")
                && !id.contains("embedding")
                && !id.contains("tts")
                && !id.contains("whisper")
                && !id.contains("realtime")
                && !id.contains("audio")
                && !id.contains("search")
                && !id.contains("-base")
        })
        .collect();

    models.sort_by(|a, b| b.cmp(a));
    models.dedup();
    Ok(models)
}

/// Fetch available Claude models from the Anthropic API.
/// Falls back to a hardcoded list of known stable models if the API call fails or returns empty.
async fn get_claude_models(config: &AiConfig) -> Result<Vec<String>, String> {
    let api_key = config.api_key()
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

    if models.is_empty() { Ok(fallback) } else { Ok(models) }
}

/// Public entry point for listing Ollama models, called from the `ai_get_ollama_models` Tauri command.
/// Reads config from the app store and delegates to [`get_ollama_models_internal`].
pub async fn get_ollama_models(app: &AppHandle) -> Result<Vec<String>, String> {
    let config = read_ai_config(app);
    get_ollama_models_internal(&config).await
}
