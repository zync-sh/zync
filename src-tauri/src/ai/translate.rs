use tauri::{AppHandle, Emitter};

use crate::utils::toon::{parse_response, AiTranslateResponse, ChatMessage};

use super::{providers, transport, AiConfig, AiStreamChunk, AiStreamDone, TerminalContext};

async fn call_ollama(
    query: &str,
    context: &TerminalContext,
    config: &AiConfig,
    history: &[ChatMessage],
) -> Result<String, String> {
    providers::ollama::call(query, context, config, history).await
}

async fn call_gemini(
    query: &str,
    context: &TerminalContext,
    config: &AiConfig,
    history: &[ChatMessage],
) -> Result<String, String> {
    providers::gemini::call(query, context, config, history).await
}

async fn call_openai(
    query: &str,
    context: &TerminalContext,
    config: &AiConfig,
    history: &[ChatMessage],
) -> Result<String, String> {
    providers::openai_compat::call(
        "OpenAI",
        "https://api.openai.com/v1",
        "gpt-4o-mini",
        query,
        context,
        config,
        history,
    )
    .await
}

async fn call_claude(
    query: &str,
    context: &TerminalContext,
    config: &AiConfig,
    history: &[ChatMessage],
) -> Result<String, String> {
    providers::claude::call(query, context, config, history).await
}

pub async fn translate(
    app: &AppHandle,
    query: String,
    context: TerminalContext,
    request_id: String,
    config: AiConfig,
) -> Result<AiTranslateResponse, String> {
    let raw = match config.provider.as_str() {
        "ollama" => call_ollama(&query, &context, &config, &[]).await,
        "gemini" => call_gemini(&query, &context, &config, &[]).await,
        "openai" => call_openai(&query, &context, &config, &[]).await,
        "claude" => call_claude(&query, &context, &config, &[]).await,
        "groq" => providers::openai_compat::call(
            "Groq",
            "https://api.groq.com/openai/v1",
            "llama-3.3-70b-versatile",
            &query,
            &context,
            &config,
            &[],
        )
        .await,
        "mistral" => providers::openai_compat::call(
            "Mistral",
            "https://api.mistral.ai/v1",
            "mistral-large-latest",
            &query,
            &context,
            &config,
            &[],
        )
        .await,
        other => Err(format!("Unknown AI provider: {}", other)),
    };

    match raw {
        Ok(text) => {
            let result = parse_response(&text);
            let _ = app.emit(
                "ai:stream-chunk",
                AiStreamChunk {
                    request_id,
                    chunk: text,
                    done: true,
                    error: None,
                },
            );
            Ok(result)
        }
        Err(error) => {
            let _ = app.emit(
                "ai:stream-chunk",
                AiStreamChunk {
                    request_id,
                    chunk: String::new(),
                    done: true,
                    error: Some(error.clone()),
                },
            );
            Err(error)
        }
    }
}

pub(crate) async fn read_sse_stream(
    app: &AppHandle,
    request_id: &str,
    response: reqwest::Response,
    extract_token: fn(&str) -> Option<String>,
) -> Result<String, String> {
    transport::read_sse_stream(app, request_id, response, extract_token).await
}

async fn stream_ollama(
    app: &AppHandle,
    request_id: &str,
    query: &str,
    context: &TerminalContext,
    config: &AiConfig,
    history: &[ChatMessage],
) -> Result<String, String> {
    providers::ollama::stream(app, request_id, query, context, config, history).await
}

async fn stream_openai(
    app: &AppHandle,
    request_id: &str,
    query: &str,
    context: &TerminalContext,
    config: &AiConfig,
    history: &[ChatMessage],
) -> Result<String, String> {
    providers::openai_compat::stream(
        app,
        "OpenAI",
        "https://api.openai.com/v1",
        "gpt-4o-mini",
        request_id,
        query,
        context,
        config,
        history,
    )
    .await
}

async fn stream_claude(
    app: &AppHandle,
    request_id: &str,
    query: &str,
    context: &TerminalContext,
    config: &AiConfig,
    history: &[ChatMessage],
) -> Result<String, String> {
    providers::claude::stream(app, request_id, query, context, config, history).await
}

async fn stream_gemini(
    app: &AppHandle,
    request_id: &str,
    query: &str,
    context: &TerminalContext,
    config: &AiConfig,
    history: &[ChatMessage],
) -> Result<String, String> {
    providers::gemini::stream(app, request_id, query, context, config, history).await
}

pub async fn translate_stream(
    app: AppHandle,
    query: String,
    context: TerminalContext,
    request_id: String,
    config: AiConfig,
    history: Vec<ChatMessage>,
) {
    let raw = match config.provider.as_str() {
        "ollama" => stream_ollama(&app, &request_id, &query, &context, &config, &history).await,
        "gemini" => stream_gemini(&app, &request_id, &query, &context, &config, &history).await,
        "openai" => stream_openai(&app, &request_id, &query, &context, &config, &history).await,
        "claude" => stream_claude(&app, &request_id, &query, &context, &config, &history).await,
        "groq" => providers::openai_compat::stream(
            &app,
            "Groq",
            "https://api.groq.com/openai/v1",
            "llama-3.3-70b-versatile",
            &request_id,
            &query,
            &context,
            &config,
            &history,
        )
        .await,
        "mistral" => providers::openai_compat::stream(
            &app,
            "Mistral",
            "https://api.mistral.ai/v1",
            "mistral-large-latest",
            &request_id,
            &query,
            &context,
            &config,
            &history,
        )
        .await,
        other => Err(format!("Unknown AI provider: {}", other)),
    };

    match raw {
        Ok(text) => {
            let result = parse_response(&text);
            let _ = app.emit(
                "ai:stream-done",
                AiStreamDone {
                    request_id,
                    result: Some(result),
                    error: None,
                },
            );
        }
        Err(error) => {
            let _ = app.emit(
                "ai:stream-done",
                AiStreamDone {
                    request_id,
                    result: None,
                    error: Some(error),
                },
            );
        }
    }
}

pub async fn check_ollama(ollama_url: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            #[cfg(debug_assertions)]
            eprintln!("[zync/ai] failed to build Ollama healthcheck client: {error}");
            return false;
        }
    };

    client
        .get(format!("{}/api/tags", ollama_url))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}
