use std::sync::LazyLock;

static KEY_REGEX: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"[?&]key=[^&\s]*").unwrap());

pub fn sanitize_error(err: &str) -> String {
    KEY_REGEX.replace_all(err, "").to_string()
}

pub async fn read_error_body(response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
        // OpenAI / Groq / Claude format:  {"error": {"message": "..."}}
        if let Some(msg) = json
            .get("error")
            .and_then(|e| e.get("message").or(Some(e)))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            return sanitize_error(msg);
        }
        // Mistral format:  {"message": "...", "type": "..."}
        if let Some(msg) = json.get("message").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            return sanitize_error(msg);
        }
        // FastAPI / generic format:  {"detail": "..."}
        if let Some(msg) = json.get("detail").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            return sanitize_error(msg);
        }
    }

    if !body.is_empty() && body.len() <= 300 {
        sanitize_error(body.trim())
    } else {
        friendly_http_status(status.as_u16())
    }
}

/// Maps a raw HTTP status code to a human-readable description.
fn friendly_http_status(code: u16) -> String {
    match code {
        400 => "Bad request — the message format may be unsupported by this model.".into(),
        401 => "Unauthorised — check your API key in Settings → AI.".into(),
        403 => "Forbidden — your API key may not have access to this model.".into(),
        404 => "Model not found — it may have been removed or renamed.".into(),
        413 => "Request too large — the conversation context is too long.".into(),
        422 => "Invalid request — the model may not support tool calling or the input is malformed.".into(),
        429 => "Rate limit reached — too many requests. Wait a moment and try again.".into(),
        500 => "Provider server error — try again in a few seconds.".into(),
        502 | 503 => "Provider temporarily unavailable — try again shortly.".into(),
        _ => format!("HTTP {code}"),
    }
}

pub fn is_billing_error(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("credit balance")
        || m.contains("billing")
        || m.contains("purchase credits")
        || m.contains("payment")
        || m.contains("insufficient_quota")
        || m.contains("exceeded your current quota")
}
