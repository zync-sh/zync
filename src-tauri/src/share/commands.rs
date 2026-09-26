use super::api::{ApiClient, CreateShareBody, ShareRecord};
use super::auth::ShareAuthStatus;
use super::ShareState;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize)]
pub struct ShareStatusPayload {
    pub auth: ShareAuthStatus,
    pub shares: Vec<ShareRecord>,
    pub agents: Vec<super::agent::AgentSnapshot>,
    pub quota_used: i32,
    pub quota_max: i32,
}

/// Fast local peek (keyring + account file). No network — used to avoid signed-out flash.
#[tauri::command]
pub fn share_auth_peek(state: State<'_, ShareState>) -> ShareAuthStatus {
    state.auth.cached_status()
}

fn require_share_config(state: &ShareState) -> Result<(), String> {
    if state.config.is_configured() {
        Ok(())
    } else {
        Err(super::err(
            "share_unconfigured",
            "Public URLs is not configured in this build. Release builds must set ZYNC_SHARE_API_BASE and ZYNC_SHARE_RELAY_URL at compile time.",
        ))
    }
}

#[tauri::command]
pub async fn share_status(state: State<'_, ShareState>) -> Result<ShareStatusPayload, String> {
    let cached = state.auth.cached_status();
    let auth = if cached.signed_in {
        match state.auth.restore(&state.config).await {
            Ok(status) => status,
            // Transient errors (network, etc.): keep the local signed-in hint.
            // restore() already returns Ok(signed-out) for invalid/missing refresh.
            Err(_) => cached,
        }
    } else {
        cached
    };
    let (shares, quota_used) = if auth.signed_in {
        match load_shares(&state).await {
            Ok(list) => {
                let used = list
                    .iter()
                    .filter(|s| {
                        s.status == "reserved" || s.status == "active" || s.status == "stopped"
                    })
                    .count() as i32;
                (list, used)
            }
            Err(_) => (Vec::new(), 0),
        }
    } else {
        (Vec::new(), 0)
    };
    Ok(ShareStatusPayload {
        quota_max: super::api::normalize_quota_max(Some(auth.quota_max)),
        auth,
        shares,
        agents: state.agents.snapshots().await,
        quota_used,
    })
}

#[tauri::command]
pub async fn share_login(
    app: AppHandle,
    state: State<'_, ShareState>,
    provider: String,
) -> Result<ShareStatusPayload, String> {
    require_share_config(&state)?;
    state.auth.login(&app, &state.config, &provider).await?;
    let payload = share_status(state.clone()).await?;
    let _ = app.emit("share://auth", &payload.auth);
    Ok(payload)
}

#[tauri::command]
pub async fn share_login_cancel(state: State<'_, ShareState>) -> Result<bool, String> {
    Ok(state.auth.cancel_login())
}

#[tauri::command]
pub async fn share_logout(
    app: AppHandle,
    state: State<'_, ShareState>,
) -> Result<ShareStatusPayload, String> {
    state.agents.stop_all().await;
    state.auth.logout(&state.config).await?;
    let payload = ShareStatusPayload {
        auth: ShareAuthStatus {
            signed_in: false,
            email: None,
            user_id: None,
            avatar_url: None,
            quota_max: 3,
        },
        shares: Vec::new(),
        agents: Vec::new(),
        quota_used: 0,
        quota_max: 3,
    };
    let _ = app.emit("share://auth", &payload.auth);
    Ok(payload)
}

#[tauri::command]
pub async fn share_list(state: State<'_, ShareState>) -> Result<Vec<ShareRecord>, String> {
    require_share_config(&state)?;
    load_shares(&state).await
}

#[tauri::command]
pub async fn share_create(
    state: State<'_, ShareState>,
    port: i32,
    name: Option<String>,
    password: Option<String>,
) -> Result<ShareRecord, String> {
    require_share_config(&state)?;
    if !(1..=65535).contains(&port) {
        return Err(super::err(
            "invalid_port",
            "Local port must be between 1 and 65535",
        ));
    }
    let access = state.auth.ensure_access_token(&state.config).await?;
    let client = ApiClient::new(state.config.clone());
    let name = name.and_then(|n| {
        let t = n.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    let password = password.and_then(|p| {
        let t = p.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    let share = client
        .create_share(
            &access,
            &CreateShareBody {
                name,
                target_kind: "localhost".into(),
                target_host: "127.0.0.1".into(),
                target_port: port,
                basic_auth_password: password,
            },
        )
        .await?;
    if share.status != "stopped" && share.status != "disabled" {
        state.agents.start(share.clone()).await;
    }
    Ok(share)
}

#[tauri::command]
pub async fn share_stop(state: State<'_, ShareState>, id: String) -> Result<ShareRecord, String> {
    require_share_config(&state)?;
    let access = state.auth.ensure_access_token(&state.config).await?;
    let client = ApiClient::new(state.config.clone());
    let share = client.stop_share(&access, &id).await?;
    state.agents.stop(&id).await;
    Ok(share)
}

#[tauri::command]
pub async fn share_start(state: State<'_, ShareState>, id: String) -> Result<ShareRecord, String> {
    require_share_config(&state)?;
    let access = state.auth.ensure_access_token(&state.config).await?;
    let client = ApiClient::new(state.config.clone());
    let share = client.start_share(&access, &id).await?;
    state.agents.start(share.clone()).await;
    Ok(share)
}

#[tauri::command]
pub async fn share_delete(state: State<'_, ShareState>, id: String) -> Result<ShareRecord, String> {
    require_share_config(&state)?;
    let access = state.auth.ensure_access_token(&state.config).await?;
    let client = ApiClient::new(state.config.clone());
    let share = client.delete_share(&access, &id).await?;
    state.agents.stop(&id).await;
    Ok(share)
}

#[tauri::command]
pub async fn share_agent_start(
    state: State<'_, ShareState>,
    id: Option<String>,
) -> Result<(), String> {
    require_share_config(&state)?;
    let shares = load_shares(&state).await?;
    let targets: Vec<ShareRecord> = match id {
        Some(id) => shares.into_iter().filter(|s| s.id == id).collect(),
        None => shares
            .into_iter()
            .filter(|s| s.status == "reserved" || s.status == "active")
            .collect(),
    };
    if targets.is_empty() {
        return Ok(());
    }
    for share in targets {
        if share.status == "stopped" || share.status == "disabled" || share.status == "deleted" {
            continue;
        }
        state.agents.start(share).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn share_agent_stop(
    state: State<'_, ShareState>,
    id: Option<String>,
) -> Result<(), String> {
    if let Some(id) = id {
        state.agents.stop(&id).await;
    } else {
        state.agents.stop_all().await;
    }
    Ok(())
}

async fn load_shares(state: &ShareState) -> Result<Vec<ShareRecord>, String> {
    let access = state.auth.ensure_access_token(&state.config).await?;
    let client = ApiClient::new(state.config.clone());
    client.list_shares(&access).await
}
