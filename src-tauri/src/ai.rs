use tauri::AppHandle;

pub mod agent_loop;
mod agent_loop_support;
mod agent_planning;
pub(crate) mod brain;
mod config;
mod context;
mod model_catalog;
mod policy;
mod prompts;
mod providers;
mod tool_command_exec;
mod tool_exec_support;
mod tool_file_ops;
mod tool_schemas;
pub mod tools;
mod translate;
mod transport;
mod types;
pub(crate) mod util;

pub use crate::utils::toon::{AiTranslateResponse, ChatMessage};
pub(crate) use config::{
    delete_api_key, get_api_key, is_local_only_credential_logical_id, migrate_legacy_api_keys,
    save_api_key,
};
pub use model_catalog::{get_ollama_models, get_provider_models};
pub use translate::{check_ollama, translate, translate_stream};
pub use types::{AgentRunRequest, AiConfig, AiStreamChunk, AiStreamDone, TerminalContext};

#[cfg(test)]
pub(crate) use tool_file_ops::write_remote_file;

/// Read AI config from settings.json.
pub fn read_ai_config(app: &AppHandle, vault: &crate::vault::store::VaultService) -> AiConfig {
    config::read_ai_config(app, vault)
}

pub(crate) use prompts::SYSTEM_PROMPT;

pub(crate) fn build_user_prompt(
    query: &str,
    context: &TerminalContext,
    history: &[ChatMessage],
) -> String {
    prompts::build_user_prompt(query, context, history)
}

pub(crate) fn build_single_prompt(
    query: &str,
    context: &TerminalContext,
    history: &[ChatMessage],
) -> String {
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
