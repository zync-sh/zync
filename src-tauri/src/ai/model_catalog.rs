use tauri::AppHandle;

use super::{providers, read_ai_config, AiConfig};

pub async fn get_provider_models(app: &AppHandle) -> Result<Vec<String>, String> {
    let config = read_ai_config(app);
    match config.provider.as_str() {
        "ollama" => get_ollama_models_internal(&config).await,
        "gemini" => get_gemini_models(&config).await,
        "openai" => get_openai_models(&config).await,
        "claude" => get_claude_models(&config).await,
        "groq" => providers::openai_compat::get_models(
            "Groq",
            "https://api.groq.com/openai/v1",
            &config,
            |id| {
                !id.contains('/')
                    && !id.contains("whisper")
                    && !id.contains("tts")
                    && !id.contains("guard")
                    && !id.contains("vision")
                    && !id.contains("allam")
                    && !id.contains("deepseek-r1")
                    && !id.contains("playai")
            },
        )
        .await,
        "mistral" => providers::openai_compat::get_models(
            "Mistral",
            "https://api.mistral.ai/v1",
            &config,
            |id| {
                !id.contains("embed")
                    && !id.contains("moderation")
                    && !id.contains("voix")
                    && !id.starts_with("ft:")
            },
        )
        .await,
        _ => Ok(vec![]),
    }
}

async fn get_ollama_models_internal(config: &AiConfig) -> Result<Vec<String>, String> {
    providers::ollama::get_models(config).await
}

async fn get_gemini_models(config: &AiConfig) -> Result<Vec<String>, String> {
    providers::gemini::get_models(config).await
}

async fn get_openai_models(config: &AiConfig) -> Result<Vec<String>, String> {
    providers::openai_compat::get_models(
        "OpenAI",
        "https://api.openai.com/v1",
        config,
        |id| {
            (id.starts_with("gpt-")
                || id == "o1"
                || id.starts_with("o1-")
                || id == "o3"
                || id.starts_with("o3-")
                || id == "o4"
                || id.starts_with("o4-"))
                && !id.contains("instruct")
                && !id.contains("embedding")
                && !id.contains("tts")
                && !id.contains("whisper")
                && !id.contains("realtime")
                && !id.contains("audio")
                && !id.contains("search")
                && !id.contains("-base")
        },
    )
    .await
}

async fn get_claude_models(config: &AiConfig) -> Result<Vec<String>, String> {
    providers::claude::get_models(config).await
}

pub async fn get_ollama_models(app: &AppHandle) -> Result<Vec<String>, String> {
    let config = read_ai_config(app);
    get_ollama_models_internal(&config).await
}
