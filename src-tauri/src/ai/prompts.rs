#![allow(dead_code)]

use crate::ai::{ChatMessage, TerminalContext};
use crate::utils::toon::encode_history_toon;

pub const SYSTEM_PROMPT: &str = "\
You are a terminal assistant. Analyze the user's request and pick one of two response modes.\n\
\n\
MODE 1 — Shell command: the user wants to DO something in a terminal.\n\
Respond ONLY in TOON format (no markdown, no backticks, no JSON, no extra text):\n\
type: command\n\
command: <the shell command>\n\
explanation: <brief explanation>\n\
safety: safe|moderate|dangerous\n\
\n\
Safety: safe=read-only, moderate=reversible changes, dangerous=destructive/irreversible.\n\
\n\
MODE 2 — Answer: the user asks a question or wants an explanation.\n\
Respond ONLY in TOON format:\n\
type: chat\n\
answer: <concise answer in 1-3 sentences>\n\
\n\
IMPORTANT: Respond ONLY in TOON key-value format. No JSON, no markdown, no backticks.";

pub fn build_user_prompt(query: &str, context: &TerminalContext, history: &[ChatMessage]) -> String {
    let mut prompt = format!(
        "OS: {os}\nShell: {shell}\nCWD: {cwd}\nConnection: {conn}",
        os = context.os.as_deref().unwrap_or("Linux"),
        shell = context.shell.as_deref().unwrap_or("bash"),
        cwd = context.cwd.as_deref().unwrap_or("~"),
        conn = context.connection_type,
    );

    if let Some(toon_history) = encode_history_toon(history) {
        prompt.push_str(&format!("\n\nConversation history:\n{}", toon_history));
    }

    if let Some(output) = context.recent_output.as_deref() {
        if !output.is_empty() {
            let trimmed = if output.len() > 500 {
                let start = output.len() - 500;
                let safe_start = output
                    .char_indices()
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

    if let Some(attached) = context.attached_content.as_deref() {
        if !attached.is_empty() {
            let label = context.attached_label.as_deref().unwrap_or("attached context");
            let trimmed = if attached.len() > 1200 {
                let safe_end = attached
                    .char_indices()
                    .map(|(i, _)| i)
                    .find(|&i| i >= 1200)
                    .unwrap_or(attached.len());
                &attached[..safe_end]
            } else {
                attached
            };
            prompt.push_str(&format!("\n\nAttached context ({label}):\n{trimmed}"));
        }
    }

    prompt.push_str(&format!("\n\nRequest: {}", query));
    prompt
}

pub fn build_single_prompt(query: &str, context: &TerminalContext, history: &[ChatMessage]) -> String {
    format!("{}\n\n{}", SYSTEM_PROMPT, build_user_prompt(query, context, history))
}
