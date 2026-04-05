use tauri::AppHandle;

pub(crate) mod brain;
mod agent_loop_support;
mod config;
mod context;
mod agent_planning;
mod model_catalog;
mod policy;
mod providers;
mod prompts;
mod tool_command_exec;
mod tool_exec_support;
mod tool_file_ops;
mod tool_schemas;
mod translate;
mod transport;
mod types;
pub(crate) mod util;
pub mod tools;
pub mod agent_loop;

pub use crate::utils::toon::{
    AiTranslateResponse, ChatMessage,
};
pub use model_catalog::{get_ollama_models, get_provider_models};
pub use translate::{check_ollama, translate, translate_stream};
pub use types::{
    AiConfig, AiStreamChunk, AiStreamDone,
    TerminalContext,
    AgentRunRequest,
};

/// Read AI config from settings.json.
pub fn read_ai_config(app: &AppHandle) -> AiConfig {
    config::read_ai_config(app)
}

pub(crate) use prompts::SYSTEM_PROMPT;

pub(crate) fn build_user_prompt(query: &str, context: &TerminalContext, history: &[ChatMessage]) -> String {
    prompts::build_user_prompt(query, context, history)
}

pub(crate) fn build_single_prompt(query: &str, context: &TerminalContext, history: &[ChatMessage]) -> String {
    prompts::build_single_prompt(query, context, history)
}

pub(crate) async fn read_sse_stream(
    app: &AppHandle,
    request_id: &str,
    response: reqwest::Response,
    extract_token: fn(&str) -> Option<String>,
) -> Result<String, String> {
    translate::read_sse_stream(app, request_id, response, extract_token).await
}

pub(crate) async fn make_client() -> Result<reqwest::Client, String> {
    transport::make_client().await
}

pub(crate) async fn make_stream_client() -> Result<reqwest::Client, String> {
    transport::make_stream_client().await
}

pub(crate) fn sanitize_error(err: &str) -> String {
    policy::errors::sanitize_error(err)
}

pub(crate) async fn read_error_body(response: reqwest::Response) -> String {
    policy::errors::read_error_body(response).await
}

pub(crate) fn is_billing_error(msg: &str) -> bool {
    policy::errors::is_billing_error(msg)
}
