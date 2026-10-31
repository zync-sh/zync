//! Zync Public URLs — desktop client for the private `zync-share` SaaS.
//!
//! This is not SSH port forwarding. Protocol is mirrored from
//! `zync-share/internal/protocol`; do not import that private repo.

mod agent;
mod api;
mod auth;
mod commands;
mod config;
mod outbound;
mod protocol;
mod proxy;
mod stream;

pub use commands::*;
pub use config::ShareConfig;

use log::warn;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::AppHandle;

use crate::share::agent::AgentManager;
use crate::share::auth::AuthStore;

#[derive(Clone)]
pub struct ShareState {
    #[allow(dead_code)]
    pub app: AppHandle,
    #[allow(dead_code)]
    pub data_dir: PathBuf,
    pub config: ShareConfig,
    pub auth: Arc<AuthStore>,
    pub agents: Arc<AgentManager>,
}

impl ShareState {
    pub fn new(app: AppHandle, data_dir: PathBuf) -> Self {
        let config = ShareConfig::from_env();
        if !config.is_configured() {
            warn!(
                "[share] Public URLs is unconfigured in this build. Set ZYNC_SHARE_API_BASE and ZYNC_SHARE_RELAY_URL at compile time for release builds."
            );
        }
        let auth = Arc::new(AuthStore::new(data_dir.clone()));
        let agents = Arc::new(AgentManager::new(
            app.clone(),
            data_dir.clone(),
            config.clone(),
            auth.clone(),
        ));
        Self {
            app,
            data_dir,
            config,
            auth,
            agents,
        }
    }
}

pub fn err(code: &str, message: impl Into<String>) -> String {
    format!("[{code}] {}", message.into())
}
