use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::ai::AiStreamChunk;

static REQUEST_CLIENT: Mutex<Option<reqwest::Client>> = Mutex::new(None);
static STREAM_CLIENT: Mutex<Option<reqwest::Client>> = Mutex::new(None);
pub(super) const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub(super) const STREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Initialize a pool once after success; a failed initialization remains retryable.
pub(super) fn pooled_client(
    cache: &Mutex<Option<reqwest::Client>>,
    builder: impl FnOnce() -> reqwest::ClientBuilder,
) -> Result<reqwest::Client, String> {
    let mut cached = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(client) = cached.as_ref() {
        return Ok(client.clone());
    }
    let client = builder().build().map_err(|error| error.to_string())?;
    *cached = Some(client.clone());
    Ok(client)
}

/// Reuse connection pools while retaining the existing finite non-streaming request timeout.
pub async fn make_client() -> Result<reqwest::Client, String> {
    pooled_client(&REQUEST_CLIENT, || {
        reqwest::Client::builder().timeout(REQUEST_TIMEOUT)
    })
}

/// Share streaming connections without adding a total timeout to long model responses.
pub async fn make_stream_client() -> Result<reqwest::Client, String> {
    pooled_client(&STREAM_CLIENT, || {
        reqwest::Client::builder().connect_timeout(STREAM_CONNECT_TIMEOUT)
    })
}

/// Keep request URLs out of provider errors returned to the renderer.
pub(super) fn error_without_url(error: reqwest::Error) -> String {
    error.without_url().to_string()
}

fn emit_stream_chunk(app: &AppHandle, request_id: &str, token: String) {
    let _ = app.emit(
        "ai:stream-chunk",
        AiStreamChunk {
            request_id: request_id.to_string(),
            chunk: token,
            done: false,
            error: None,
        },
    );
}

/// Call `f` with each `data:` value from an SSE response stream.
/// Skips `[DONE]` and comment lines. Returns when the stream ends.
pub async fn for_each_sse_data<F>(mut response: reqwest::Response, mut f: F) -> Result<(), String>
where
    F: FnMut(&str),
{
    let mut byte_buf: Vec<u8> = Vec::new();

    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        byte_buf.extend_from_slice(&chunk);
        let valid_len = match std::str::from_utf8(&byte_buf) {
            Ok(_) => byte_buf.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid_len == 0 {
            continue;
        }
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
                    if data != "[DONE]" {
                        f(data);
                    }
                }
            } else {
                line_buf.push(ch);
            }
        }
        let consumed = processed_to.min(valid_len);
        let remaining = &byte_buf[consumed..valid_len];
        let trailing = &byte_buf[valid_len..];
        let mut new_buf = Vec::with_capacity(remaining.len() + trailing.len());
        new_buf.extend_from_slice(remaining);
        new_buf.extend_from_slice(trailing);
        byte_buf = new_buf;
    }
    // Flush any remaining partial line
    if let Ok(s) = std::str::from_utf8(&byte_buf) {
        let line = s.trim();
        if let Some(data) = line.strip_prefix("data: ") {
            if data != "[DONE]" {
                f(data);
            }
        }
    }
    Ok(())
}

pub async fn read_sse_stream(
    app: &AppHandle,
    request_id: &str,
    mut response: reqwest::Response,
    extract_token: fn(&str) -> Option<String>,
) -> Result<String, String> {
    let mut accumulated = String::new();
    let mut byte_buf: Vec<u8> = Vec::new();

    while let Some(chunk) = response.chunk().await.map_err(error_without_url)? {
        byte_buf.extend_from_slice(&chunk);

        let valid_len = match std::str::from_utf8(&byte_buf) {
            Ok(_) => byte_buf.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid_len == 0 {
            continue;
        }

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
                            emit_stream_chunk(app, request_id, token);
                        }
                    }
                }
            } else {
                line_buf.push(ch);
            }
        }

        let consumed = processed_to.min(valid_len);
        let remaining_text = &byte_buf[consumed..valid_len];
        let trailing = &byte_buf[valid_len..];
        let mut new_buf = Vec::with_capacity(remaining_text.len() + trailing.len());
        new_buf.extend_from_slice(remaining_text);
        new_buf.extend_from_slice(trailing);
        byte_buf = new_buf;
    }

    if let Ok(remaining) = std::str::from_utf8(&byte_buf) {
        let line = remaining.trim();
        if !line.is_empty() && !line.starts_with(':') {
            if let Some(data) = line.strip_prefix("data: ") {
                if data != "[DONE]" {
                    if let Some(token) = extract_token(data) {
                        if !token.is_empty() {
                            accumulated.push_str(&token);
                            emit_stream_chunk(app, request_id, token);
                        }
                    }
                }
            }
        }
    }

    Ok(accumulated)
}
