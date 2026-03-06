use serde::{Deserialize, Serialize};

/// Parsed AI response returned to the frontend after a translation or chat query.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiTranslateResponse {
    /// The shell command suggested by the AI (empty if in chat mode).
    pub command: String,
    /// A brief explanation of the command or the response.
    pub explanation: String,
    /// Safety level of the command: "safe", "moderate", or "dangerous".
    pub safety: String,
    /// The concise answer provided by the AI (present if in chat mode).
    #[serde(default)]
    pub answer: Option<String>,
}

/// A single exchange in the AI conversation history, sent from the frontend.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    /// The role of the messenger: "user" or "assistant".
    pub role: String,
    /// The actual content of the message.
    pub content: String,
}

/// Encode conversation history into a compact TOON tabular format.
///
/// This format is optimized for token efficiency by using a CSV-like structure
/// inside a TOON block. Only the last 6 exchanges (12 messages) are included.
///
/// # Arguments
/// * `history` - A slice of [`ChatMessage`] representing the conversation history.
///
/// # Returns
/// An `Option<String>` containing the formatted TOON block, or `None` if history is empty.
pub fn encode_history_toon(history: &[ChatMessage]) -> Option<String> {
    if history.is_empty() {
        return None;
    }
    // Keep last 12 entries (6 turns: user + assistant each)
    let skip_count = history.len().saturating_sub(12);
    let window: Vec<&ChatMessage> = history.iter().skip(skip_count).collect();
    let n = window.len();
    let mut block = format!("history[{}]{{role,content}}:\n", n);
    for msg in &window {
        // Sanitize role to ensure valid encoding ("user" or "assistant")
        let safe_role = match msg.role.to_lowercase().as_str() {
            "user" => "user",
            "assistant" => "assistant",
            _ => "user", // fallback
        };
        // Use proper escaping instead of destructive replacement
        let safe_content = msg.content
            .replace('\\', "\\\\")
            .replace('\n', "\\n")
            .replace(',', "\\,");
        block.push_str(&format!("{},{}\n", safe_role, safe_content));
    }
    Some(block)
}

/// Parse a string response from an AI provider into an [`AiTranslateResponse`].
///
/// This function attempts to parse the response in the following order:
/// 1.  **TOON format**: Looks for key-value pairs separated by colons (e.g., `type: command`).
/// 2.  **JSON format**: Falls back to parsing JSON if the AI ignored the TOON instruction.
/// 3.  **Raw text**: If all parsing fails, treats the entire response as a chat answer.
///
/// # Arguments
/// * `text` - The raw string response from the AI.
pub fn parse_response(text: &str) -> AiTranslateResponse {
    // 1. Strip whitespace and any accidental markdown fences (```toon ... ```)
    let text = text.trim();
    let owned_text: String;
    let text = if text.starts_with("```") {
        owned_text = text.lines()
            .skip(1)
            .take_while(|l| !l.starts_with("```"))
            .collect::<Vec<_>>()
            .join("\n");
        owned_text.trim()
    } else {
        text
    };

    // 2. Extract key-value fields while handling aliases
    let mut fields: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for line in text.lines() {
        if let Some(colon_pos) = line.find(':') {
            let key = line[..colon_pos].trim().to_lowercase();
            let val = line[colon_pos + 1..].trim().to_string();
            if !key.is_empty() && !val.is_empty() {
                // Normalize keys (handle common AI shorthands)
                let normalized_key = match key.as_str() {
                    "cmd" | "shell" | "script" => "command",
                    "ans" | "msg" | "text" | "reply" | "message" => "answer",
                    "expl" | "explanation" | "desc" => "explanation",
                    _ => &key,
                };
                fields.entry(normalized_key.to_string()).or_insert(val);
            }
        }
    }

    // 3. Construct response based on extracted fields
    if !fields.is_empty() {
        let response_type = fields.get("type").map(|s| s.as_str()).unwrap_or("");
        
        // Priority 1: Check for explicit "answer" or "chat" type
        if response_type.eq_ignore_ascii_case("chat") || fields.contains_key("answer") {
            if let Some(answer) = fields.get("answer") {
                if !answer.is_empty() {
                    return AiTranslateResponse {
                        command: String::new(),
                        explanation: fields.get("explanation").cloned().unwrap_or_default(),
                        safety: "safe".to_string(),
                        answer: Some(answer.clone()),
                    };
                }
            }
        }

        // Priority 2: Check for explicit "command"
        if let Some(command) = fields.get("command") {
            if !command.is_empty() {
                let explanation = fields.get("explanation").cloned().unwrap_or_default();
                let safety = fields.get("safety").map(|s| s.to_lowercase()).unwrap_or_else(|| "moderate".to_string());
                let safety = match safety.as_str() {
                    "safe" | "moderate" | "dangerous" => safety,
                    _ => "moderate".to_string(),
                };
                return AiTranslateResponse { command: command.clone(), explanation, safety, answer: None };
            }
        }
    }

    // 4. Fallback: JSON (if model completely ignored TOON)
    if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            let json_str = &text[start..=end];
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                let safety = val.get("safety").and_then(|v| v.as_str()).unwrap_or("moderate").to_lowercase();
                let safety = match safety.as_str() {
                    "safe" | "moderate" | "dangerous" => safety,
                    _ => "moderate".to_string(),
                };
                let mut resp = AiTranslateResponse {
                    command: val.get("command").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    explanation: val.get("explanation").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    safety,
                    answer: val.get("answer").and_then(|v| v.as_str()).map(|s| s.to_string()),
                };
                
                // If it's explicitly a chat type in JSON
                if val.get("type").and_then(|t| t.as_str()).map(|s| s.eq_ignore_ascii_case("chat")).unwrap_or(false) && resp.answer.is_none() {
                    resp.answer = Some(resp.explanation.clone()); // models sometimes put the answer in explanation
                }

                if !resp.command.is_empty() || resp.answer.is_some() {
                    return resp;
                }
            }
        }
    }

    // 5. Final Fallback: Treat raw text as an answer
    AiTranslateResponse {
        command: String::new(),
        explanation: String::new(),
        safety: "safe".to_string(),
        answer: Some(text.to_string()),
    }
}
