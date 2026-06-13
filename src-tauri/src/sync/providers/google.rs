use super::super::profiles::now_secs;
use super::super::provider::{ProviderUploadRecord, VaultProviderV1};
use super::super::types::{
    EncryptionMode, ProviderCapabilities, ProviderCredentialObject, ProviderIdentity,
    ProviderStatusSnapshot, SyncError, SyncProviderKind, SyncResult,
};
use async_trait::async_trait;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Loaded from .env at build time (src-tauri/.env → GOOGLE_CLIENT_ID=...).
const GOOGLE_CLIENT_ID: &str = match option_env!("GOOGLE_CLIENT_ID") {
    Some(v) => v,
    None => "",
};
const GOOGLE_CLIENT_SECRET: Option<&str> = option_env!("GOOGLE_CLIENT_SECRET");

const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_TOKENINFO_URL: &str = "https://oauth2.googleapis.com/tokeninfo";
const GOOGLE_REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
/// drive.appdata = hidden app folder, not visible in user's Drive.
const GOOGLE_DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.appdata";
const GOOGLE_SCOPE: &str = "https://www.googleapis.com/auth/drive.appdata email";
const GDRIVE_API: &str = "https://www.googleapis.com/drive/v3";
const GDRIVE_UPLOAD_API: &str = "https://www.googleapis.com/upload/drive/v3";
const APPDATA_SPACE: &str = "appDataFolder";
const VAULT_FILENAME: &str = "vault.redb";

const GOOGLE_TOKENS_KEY: &str = "google-tokens";
const SYNC_TOKEN_KEYRING_SERVICE: &str = "Zync Sync Refresh Tokens";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredTokens {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    access_token: Option<String>,
    #[serde(default, skip_serializing)]
    refresh_token: Option<String>,
    #[serde(default)]
    has_refresh_token: bool,
    #[serde(default)]
    expires_at: u64,
    last_sync: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    avatar_url: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct GoogleUserIdentity {
    email: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct DriveFile {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[allow(dead_code)]
    #[serde(rename = "modifiedTime")]
    modified_time: Option<String>,
}

#[derive(Deserialize)]
struct DriveFileList {
    files: Vec<DriveFile>,
    #[serde(default, rename = "nextPageToken")]
    next_page_token: Option<String>,
}

fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    crate::commands::get_data_dir(app)
}

fn sync_err(code: &'static str, message: impl Into<String>) -> SyncError {
    SyncError::new(code, message)
}

fn gen_random_base64url() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    b64url_no_pad(&bytes)
}

fn code_challenge_s256(verifier: &str) -> String {
    let hash = Sha256::digest(verifier.as_bytes());
    b64url_no_pad(&hash)
}

fn b64url_no_pad(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn http_client() -> SyncResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| sync_err("http_client_init_failed", e.to_string()))
}

fn http_upload_client() -> SyncResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| sync_err("http_client_init_failed", e.to_string()))
}

fn bind_redirect_listener() -> Option<(u16, std::net::TcpListener)> {
    for port in 7357u16..7400 {
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", port)) {
            return Some((port, listener));
        }
    }
    None
}

async fn wait_for_auth_code(listener: std::net::TcpListener) -> SyncResult<(String, String)> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    listener.set_nonblocking(true).map_err(|e| {
        sync_err(
            "oauth_redirect_listener_error",
            format!("failed to configure redirect listener: {e}"),
        )
    })?;
    let listener = TcpListener::from_std(listener).map_err(|e| {
        sync_err(
            "oauth_redirect_listener_error",
            format!("failed to convert redirect listener: {e}"),
        )
    })?;

    let (mut stream, _) =
        tokio::time::timeout(std::time::Duration::from_secs(300), listener.accept())
            .await
            .map_err(|_| {
                sync_err(
                    "oauth_timeout",
                    "OAuth timed out — no browser redirect received within 5 minutes",
                )
            })?
            .map_err(|e| sync_err("oauth_redirect_listener_error", e.to_string()))?;

    let mut buf = vec![0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| sync_err("oauth_redirect_parse_failed", e.to_string()))?;
    let request = String::from_utf8_lossy(&buf[..n]);

    let parse_result = parse_code_and_state(&request);
    let is_success = parse_result.is_ok();

    let html = if is_success {
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n\
<!DOCTYPE html>\
<html lang=\"en\">\
<head>\
<meta charset=\"UTF-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>Zync - Connected</title>\
<style>\
*{box-sizing:border-box;margin:0;padding:0}\
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:radial-gradient(1100px 700px at 50% -200px,#1a1833 0%,#0c0c0f 45%);color:#e2e2e5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}\
.card{background:rgba(22,22,26,.9);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:2.2rem 2rem;text-align:center;max-width:390px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.5)}\
.icon{width:56px;height:56px;border-radius:50%;background:rgba(124,106,247,.15);display:flex;align-items:center;justify-content:center;margin:0 auto 1.1rem}\
.icon svg{width:28px;height:28px;stroke:#7c6af7;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round}\
.check-circle{stroke-dasharray:60;stroke-dashoffset:60;animation:draw .5s .1s ease forwards}\
@keyframes draw{to{stroke-dashoffset:0}}\
h1{font-size:1.2rem;font-weight:600;color:#f0f0f3;margin-bottom:.5rem}\
p{font-size:.88rem;color:rgba(226,226,229,.72);line-height:1.55}\
.badge{display:inline-block;margin-top:1rem;padding:.3rem .85rem;border-radius:99px;background:rgba(124,106,247,.12);border:1px solid rgba(124,106,247,.25);font-size:.75rem;color:#a89ef5;letter-spacing:.04em}\
.muted{margin-top:.65rem;font-size:.76rem;color:rgba(226,226,229,.5)}\
</style>\
</head>\
<body>\
<div class=\"card\">\
<div class=\"icon\">\
<svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><polyline class=\"check-circle\" points=\"7 13 10.5 16.5 17 9\"/></svg>\
</div>\
<h1>Authorization Received</h1>\
<p>Return to Zync to finish connecting Google Drive sync. If Drive access was not granted, Zync will reject this connection for safety.</p>\
<div class=\"badge\">Zync Vault Sync</div>\
<p class=\"muted\">You can close this tab now.</p>\
</div>\
</body>\
</html>"
    } else {
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n\
<!DOCTYPE html>\
<html lang=\"en\">\
<head>\
<meta charset=\"UTF-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>Zync - Authorization not completed</title>\
<style>\
*{box-sizing:border-box;margin:0;padding:0}\
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:radial-gradient(1100px 700px at 50% -200px,#1a1833 0%,#0c0c0f 45%);color:#e2e2e5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}\
.card{background:rgba(22,22,26,.9);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:2.2rem 2rem;text-align:center;max-width:420px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.5)}\
h1{font-size:1.1rem;font-weight:600;color:#f0f0f3;margin-bottom:.5rem}\
p{font-size:.88rem;color:rgba(226,226,229,.72);line-height:1.55}\
.muted{margin-top:.7rem;font-size:.76rem;color:rgba(226,226,229,.5)}\
</style>\
</head>\
<body>\
<div class=\"card\">\
<h1>Authorization not completed</h1>\
<p>Google sign-in was canceled or denied. Return to Zync and click Connect Google Sync again to retry.</p>\
<p class=\"muted\">You can close this tab now.</p>\
</div>\
</body>\
</html>"
    };
    let _ = stream.write_all(html.as_bytes()).await;

    parse_result
}

fn parse_code_and_state(request: &str) -> SyncResult<(String, String)> {
    let line = request.lines().next().unwrap_or("");
    let query = line
        .split('?')
        .nth(1)
        .unwrap_or("")
        .split_whitespace()
        .next()
        .unwrap_or("");

    let mut code = None;
    let mut state = None;
    for (key, val) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "code" => code = Some(val.into_owned()),
            "state" => state = Some(val.into_owned()),
            "error" => {
                return Err(sync_err(
                    "oauth_access_denied",
                    format!("Google authorization was not completed: {val}"),
                ))
            }
            _ => {}
        }
    }

    match (code, state) {
        (Some(c), Some(s)) => Ok((c, s)),
        _ => Err(sync_err(
            "oauth_redirect_parse_failed",
            "OAuth redirect missing code or state parameter",
        )),
    }
}

fn tokens_path(data_dir: &Path, key: &str) -> PathBuf {
    data_dir.join(format!("sync-{key}.json"))
}

fn refresh_token_entry(key: &str) -> SyncResult<keyring::Entry> {
    keyring::Entry::new(SYNC_TOKEN_KEYRING_SERVICE, key)
        .map_err(|e| sync_err("keyring_access_failed", e.to_string()))
}

fn save_refresh_token(key: &str, refresh_token: &str) -> SyncResult<()> {
    refresh_token_entry(key)?
        .set_password(refresh_token)
        .map_err(|e| sync_err("keyring_write_failed", e.to_string()))
}

fn load_refresh_token(key: &str) -> Option<String> {
    refresh_token_entry(key).ok()?.get_password().ok()
}

fn delete_refresh_token(key: &str) {
    if let Ok(entry) = refresh_token_entry(key) {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => eprintln!("[sync] Failed to delete refresh token from keyring: {error}"),
        }
    }
}

fn tokens_for_disk(tokens: &StoredTokens) -> StoredTokens {
    let mut safe = tokens.clone();
    safe.access_token = None;
    safe.refresh_token = None;
    if tokens.refresh_token.is_some() {
        safe.has_refresh_token = true;
    }
    safe
}

async fn save_tokens(data_dir: &Path, key: &str, tokens: &StoredTokens) -> SyncResult<()> {
    if let Some(refresh_token) = tokens.refresh_token.as_deref() {
        save_refresh_token(key, refresh_token)?;
    } else if !tokens.has_refresh_token {
        delete_refresh_token(key);
    }
    let safe = tokens_for_disk(tokens);
    let json = serde_json::to_string(&safe)
        .map_err(|e| sync_err("token_store_write_failed", e.to_string()))?;
    tokio::fs::write(tokens_path(data_dir, key), json)
        .await
        .map_err(|e| sync_err("token_store_write_failed", e.to_string()))
}

fn load_tokens(data_dir: &Path, key: &str) -> Option<StoredTokens> {
    let json = std::fs::read_to_string(tokens_path(data_dir, key)).ok()?;
    let mut tokens: StoredTokens = serde_json::from_str(&json).ok()?;
    if let Some(refresh_token) = tokens.refresh_token.clone() {
        if save_refresh_token(key, &refresh_token).is_ok() {
            tokens.has_refresh_token = true;
            if let Ok(json) = serde_json::to_string(&tokens_for_disk(&tokens)) {
                let _ = std::fs::write(tokens_path(data_dir, key), json);
            }
        }
    } else if tokens.has_refresh_token {
        tokens.refresh_token = load_refresh_token(key);
        tokens.has_refresh_token = tokens.refresh_token.is_some();
    }
    Some(tokens)
}

fn delete_tokens(data_dir: &Path, key: &str) {
    delete_refresh_token(key);
    let _ = std::fs::remove_file(tokens_path(data_dir, key));
}

async fn refresh_google_access_token(tokens: &mut StoredTokens) -> SyncResult<()> {
    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| sync_err("provider_not_connected", "No refresh token stored — please reconnect."))?;

    let mut form_fields = vec![
        ("client_id", GOOGLE_CLIENT_ID.to_string()),
        ("refresh_token", refresh_token.clone()),
        ("grant_type", "refresh_token".to_string()),
    ];
    if let Some(secret) = GOOGLE_CLIENT_SECRET.filter(|s| !s.trim().is_empty()) {
        form_fields.push(("client_secret", secret.to_string()));
    }

    let resp: serde_json::Value = http_client()?
        .post(GOOGLE_TOKEN_URL)
        .form(&form_fields)
        .send()
        .await
        .map_err(|e| sync_err("provider_http_failed", e.to_string()))?
        .json()
        .await
        .map_err(|e| sync_err("provider_http_failed", e.to_string()))?;

    if let Some(err) = resp["error"].as_str() {
        return Err(sync_err(
            "oauth_token_refresh_failed",
            format!(
                "Token refresh failed: {err} — {}",
                resp["error_description"].as_str().unwrap_or("")
            ),
        ));
    }

    tokens.access_token = Some(
        resp["access_token"]
            .as_str()
            .ok_or_else(|| sync_err("oauth_token_refresh_failed", "No access_token in refresh response"))?
            .to_string(),
    );
    let expires_in = resp["expires_in"].as_u64().unwrap_or(3600);
    tokens.expires_at = now_secs() + expires_in.saturating_sub(60);
    Ok(())
}

async fn get_valid_google_token(data_dir: &Path) -> SyncResult<String> {
    let mut tokens = load_tokens(data_dir, GOOGLE_TOKENS_KEY).ok_or_else(|| {
        sync_err(
            "provider_not_connected",
            "Not connected to Google Drive. Please connect first.",
        )
    })?;

    if tokens.access_token.is_none() || now_secs() >= tokens.expires_at {
        refresh_google_access_token(&mut tokens).await?;
        save_tokens(data_dir, GOOGLE_TOKENS_KEY, &tokens).await?;
    }

    tokens.access_token.clone().ok_or_else(|| {
        sync_err(
            "oauth_token_refresh_failed",
            "No access token available after refresh.",
        )
    })
}

fn token_has_scope(scope_value: Option<&str>, required_scope: &str) -> bool {
    scope_value
        .unwrap_or_default()
        .split_whitespace()
        .any(|scope| scope == required_scope)
}

async fn reject_google_connect(access_token: &str, reason: impl Into<String>) -> SyncResult<ProviderIdentity> {
    let reason = reason.into();
    match revoke_google_token(access_token).await {
        Ok(()) => Err(sync_err("oauth_scope_missing", reason)),
        Err(revoke_error) => Err(sync_err(
            "oauth_scope_missing",
            format!(
                "{reason} Zync tried to revoke the partial Google authorization but Google returned: {}",
                revoke_error.message
            ),
        )),
    }
}

async fn verify_google_drive_scope(
    access_token: &str,
    token_response: &serde_json::Value,
) -> SyncResult<()> {
    if token_has_scope(token_response["scope"].as_str(), GOOGLE_DRIVE_SCOPE) {
        return Ok(());
    }

    let token_info: serde_json::Value = http_client()?
        .get(GOOGLE_TOKENINFO_URL)
        .query(&[("access_token", access_token)])
        .send()
        .await
        .map_err(|e| sync_err("provider_http_failed", e.to_string()))?
        .error_for_status()
        .map_err(|e| sync_err("provider_http_failed", e.to_string()))?
        .json()
        .await
        .map_err(|e| sync_err("provider_http_failed", e.to_string()))?;

    if token_has_scope(token_info["scope"].as_str(), GOOGLE_DRIVE_SCOPE) {
        Ok(())
    } else {
        Err(sync_err(
            "oauth_scope_missing",
            "Google Drive permission was not granted. Reconnect and allow Drive appdata access so Zync can back up the encrypted vault.",
        ))
    }
}

async fn find_vault_file(token: &str) -> SyncResult<Option<String>> {
    find_file_by_name(token, VAULT_FILENAME).await
}

async fn find_file_by_name(token: &str, file_name: &str) -> SyncResult<Option<String>> {
    let escaped_name = file_name.replace('\'', "\\'");
    let resp: DriveFileList = http_client()?
        .get(format!("{GDRIVE_API}/files"))
        .query(&[
            ("spaces", APPDATA_SPACE),
            ("fields", "files(id,modifiedTime)"),
            ("q", &format!("name='{escaped_name}' and trashed=false")),
            ("orderBy", "modifiedTime desc"),
            ("pageSize", "1"),
        ])
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| sync_err("provider_http_failed", e.to_string()))?
        .error_for_status()
        .map_err(|e| sync_err("provider_http_failed", e.to_string()))?
        .json()
        .await
        .map_err(|e| sync_err("provider_http_failed", e.to_string()))?;

    Ok(resp.files.into_iter().next().map(|f| f.id))
}

async fn find_files_by_name_prefix(
    token: &str,
    prefix: &str,
) -> SyncResult<Vec<ProviderCredentialObject>> {
    let escaped_prefix = prefix.replace('\'', "\\'");
    let mut page_token: Option<String> = None;
    let mut results: Vec<ProviderCredentialObject> = Vec::new();

    loop {
        let mut request = http_client()?.get(format!("{GDRIVE_API}/files")).query(&[
            ("spaces", APPDATA_SPACE),
            ("fields", "nextPageToken,files(id,name,modifiedTime)"),
            ("q", &format!("name contains '{escaped_prefix}' and trashed=false")),
            ("orderBy", "modifiedTime desc"),
            ("pageSize", "1000"),
        ]);

        if let Some(token_value) = page_token.as_deref() {
            request = request.query(&[("pageToken", token_value)]);
        }

        let resp: DriveFileList = request
            .header("Authorization", format!("Bearer {token}"))
            .send()
            .await
            .map_err(|e| sync_err("provider_http_failed", e.to_string()))?
            .error_for_status()
            .map_err(|e| sync_err("provider_http_failed", e.to_string()))?
            .json()
            .await
            .map_err(|e| sync_err("provider_http_failed", e.to_string()))?;

        #[cfg(debug_assertions)]
        eprintln!(
            "[sync][google] list files prefix='{}' page={} returned {} raw file(s)",
            prefix,
            page_token.as_deref().unwrap_or("<first>"),
            resp.files.len()
        );

        results.extend(resp.files.into_iter().filter_map(|file| {
            let name = file.name?;
            if !name.starts_with(prefix) {
                return None;
            }
            Some(ProviderCredentialObject {
                object_name: name,
                object_id: Some(file.id),
            })
        }));

        if let Some(next_token) = resp.next_page_token {
            if next_token.trim().is_empty() {
                break;
            }
            page_token = Some(next_token);
        } else {
            break;
        }
    }

    #[cfg(debug_assertions)]
    {
        let names = results
            .iter()
            .take(12)
            .map(|object| object.object_name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        eprintln!(
            "[sync][google] list files prefix='{}' matched {} object(s) [{}{}]",
            prefix,
            results.len(),
            names,
            if results.len() > 12 { ", ..." } else { "" }
        );
    }

    Ok(results)
}

fn provider_collection_prefix_from_object_name(object_name: &str) -> Option<String> {
    let markers = [
        "-credential-",
        "-hosts-",
        "-tunnels-",
        "-snippets-",
        "-settings-",
    ];
    let mut best_idx: Option<usize> = None;
    for marker in markers {
        if let Some(idx) = object_name.rfind(marker) {
            if best_idx.map_or(true, |current| idx > current) {
                best_idx = Some(idx);
            }
        }
    }
    best_idx.map(|idx| object_name[..idx + 1].to_string())
}

fn provider_collection_id_from_object_name(object_name: &str) -> Option<String> {
    let prefix = provider_collection_prefix_from_object_name(object_name)?;
    prefix
        .strip_prefix("zync-sync-")
        .and_then(|value| value.strip_suffix('-'))
        .map(str::to_string)
}

async fn existing_file_ids_for_upload(
    token: &str,
    records: &[ProviderUploadRecord],
) -> SyncResult<HashMap<String, String>> {
    let target_names: HashSet<String> = records
        .iter()
        .map(|record| record.object_name.clone())
        .collect();
    let prefixes: HashSet<String> = records
        .iter()
        .filter_map(|record| provider_collection_prefix_from_object_name(&record.object_name))
        .collect();

    if prefixes.len() == 1 {
        let prefix = prefixes.iter().next().expect("single prefix");
        match find_files_by_name_prefix(token, prefix).await {
            Ok(objects) => {
                let mut result = HashMap::new();
                for object in objects {
                    if !target_names.contains(&object.object_name) {
                        continue;
                    }
                    if let Some(id) = object.object_id {
                        // Drive results are sorted newest-first; keep the first id if
                        // older duplicate names exist from previous interrupted writes.
                        result.entry(object.object_name).or_insert(id);
                    }
                }
                return Ok(result);
            }
            Err(error) => {
                #[cfg(debug_assertions)]
                eprintln!(
                    "[sync] Prefix listing failed for upload lookup; falling back to per-file lookup: {}",
                    error.message
                );
            }
        }
    }

    let mut result = HashMap::new();
    for name in target_names {
        if let Some(id) = find_file_by_name(token, &name).await? {
            result.insert(name, id);
        }
    }
    Ok(result)
}

async fn revoke_google_token(token: &str) -> SyncResult<()> {
    http_client()?
        .post(GOOGLE_REVOKE_URL)
        .form(&[("token", token)])
        .send()
        .await
        .map_err(|e| sync_err("provider_http_failed", e.to_string()))?
        .error_for_status()
        .map_err(|e| sync_err("provider_http_failed", e.to_string()))?;
    Ok(())
}

async fn upload_vault_bytes(token: &str, file_bytes: Vec<u8>, existing_id: Option<String>) -> SyncResult<()> {
    upload_named_bytes(token, VAULT_FILENAME, file_bytes, existing_id).await
}

async fn upload_named_bytes(
    token: &str,
    file_name: &str,
    file_bytes: Vec<u8>,
    existing_id: Option<String>,
) -> SyncResult<()> {
    let client = http_upload_client()?;

    if let Some(file_id) = existing_id {
        client
            .patch(format!("{GDRIVE_UPLOAD_API}/files/{file_id}?uploadType=media"))
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/octet-stream")
            .body(file_bytes)
            .send()
            .await
            .map_err(|e| sync_err("provider_http_failed", e.to_string()))?
            .error_for_status()
            .map_err(|e| sync_err("provider_http_failed", e.to_string()))?;
    } else {
        let boundary = "zync_vault_mp_boundary";
        let metadata = serde_json::json!({
            "name": file_name,
            "parents": [APPDATA_SPACE]
        })
        .to_string();

        let body = build_multipart_related(&metadata, &file_bytes, boundary);

        client
            .post(format!("{GDRIVE_UPLOAD_API}/files?uploadType=multipart"))
            .header("Authorization", format!("Bearer {token}"))
            .header(
                "Content-Type",
                format!("multipart/related; boundary={boundary}"),
            )
            .body(body)
            .send()
            .await
            .map_err(|e| sync_err("provider_http_failed", e.to_string()))?
            .error_for_status()
            .map_err(|e| sync_err("provider_http_failed", e.to_string()))?;
    }

    Ok(())
}

fn build_multipart_related(metadata: &str, content: &[u8], boundary: &str) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend(format!("--{boundary}\r\n").as_bytes());
    body.extend(b"Content-Type: application/json; charset=UTF-8\r\n\r\n");
    body.extend(metadata.as_bytes());
    body.extend(b"\r\n");
    body.extend(format!("--{boundary}\r\n").as_bytes());
    body.extend(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend(content);
    body.extend(b"\r\n");
    body.extend(format!("--{boundary}--\r\n").as_bytes());
    body
}

async fn download_vault_bytes(token: &str, file_id: &str) -> SyncResult<Vec<u8>> {
    let bytes = http_client()?
        .get(format!("{GDRIVE_API}/files/{file_id}?alt=media"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| sync_err("provider_http_failed", e.to_string()))?
        .error_for_status()
        .map_err(|e| sync_err("provider_http_failed", e.to_string()))?
        .bytes()
        .await
        .map_err(|e| sync_err("provider_http_failed", e.to_string()))?;

    Ok(bytes.to_vec())
}

async fn download_named_bytes(
    token: &str,
    object: &ProviderCredentialObject,
) -> SyncResult<Vec<u8>> {
    let file_id = match object.object_id.as_deref() {
        Some(id) if !id.trim().is_empty() => id.to_string(),
        _ => find_file_by_name(token, &object.object_name)
            .await?
            .ok_or_else(|| {
                sync_err(
                    "provider_object_not_found",
                    format!("Provider object not found: {}", object.object_name),
                )
            })?,
    };
    download_vault_bytes(token, &file_id).await
}

async fn fetch_google_identity(token: &str) -> GoogleUserIdentity {
    let Ok(client) = http_client() else {
        return GoogleUserIdentity::default();
    };
    let Ok(response) = client
        .get("https://www.googleapis.com/oauth2/v3/userinfo")
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
    else {
        return GoogleUserIdentity::default();
    };
    let Ok(resp) = response.json::<serde_json::Value>().await else {
        return GoogleUserIdentity::default();
    };

    GoogleUserIdentity {
        email: resp["email"].as_str().map(str::to_string),
        avatar_url: resp["picture"].as_str().map(str::to_string),
    }
}

#[derive(Default)]
pub struct GoogleVaultProvider;

#[async_trait]
impl VaultProviderV1 for GoogleVaultProvider {
    fn kind(&self) -> SyncProviderKind {
        SyncProviderKind::Google
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            supports_autosync: false,
            supports_incremental: true,
            supports_etag: false,
            supports_domains: true,
            max_object_size: None,
            encryption_mode: EncryptionMode::AppEncryptedOnly,
        }
    }

    async fn connect(&self, app: &tauri::AppHandle) -> SyncResult<ProviderIdentity> {
        if GOOGLE_CLIENT_ID.is_empty() {
            return Err(sync_err(
                "oauth_client_not_configured",
                "Google OAuth client ID is not configured. Open the Vault tab → Google Drive Sync to set up your own OAuth app.",
            ));
        }

        let verifier = gen_random_base64url();
        let challenge = code_challenge_s256(&verifier);
        let state = gen_random_base64url();

        let (port, listener) = bind_redirect_listener().ok_or_else(|| {
            sync_err(
                "oauth_redirect_listener_error",
                "No free port available in range 7357–7399",
            )
        })?;
        let redirect_uri = format!("http://127.0.0.1:{port}/callback");

        let auth_url = format!(
            "{GOOGLE_AUTH_URL}?client_id={GOOGLE_CLIENT_ID}\
        &redirect_uri={redir}\
        &response_type=code\
        &scope={scope}\
        &code_challenge={challenge}\
        &code_challenge_method=S256\
        &state={state}\
        &access_type=offline\
        &prompt=consent",
            redir = url::form_urlencoded::byte_serialize(redirect_uri.as_bytes())
                .collect::<String>(),
            scope = url::form_urlencoded::byte_serialize(GOOGLE_SCOPE.as_bytes())
                .collect::<String>(),
        );

        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(auth_url, None::<String>)
            .map_err(|e| sync_err("oauth_browser_open_failed", e.to_string()))?;

        let (code, returned_state) = wait_for_auth_code(listener).await?;
        if returned_state != state {
            return Err(sync_err(
                "oauth_state_mismatch",
                "OAuth state mismatch — possible CSRF attack.",
            ));
        }

        let mut form_fields = vec![
            ("code", code.to_string()),
            ("client_id", GOOGLE_CLIENT_ID.to_string()),
            ("redirect_uri", redirect_uri.clone()),
            ("grant_type", "authorization_code".to_string()),
            ("code_verifier", verifier.to_string()),
        ];
        if let Some(secret) = GOOGLE_CLIENT_SECRET.filter(|s| !s.trim().is_empty()) {
            form_fields.push(("client_secret", secret.to_string()));
        }

        let resp: serde_json::Value = http_client()?
            .post(GOOGLE_TOKEN_URL)
            .form(&form_fields)
            .send()
            .await
            .map_err(|e| sync_err("provider_http_failed", e.to_string()))?
            .json()
            .await
            .map_err(|e| sync_err("provider_http_failed", e.to_string()))?;

        if let Some(err) = resp["error"].as_str() {
            return Err(sync_err(
                "oauth_token_exchange_failed",
                format!(
                    "Token exchange failed: {err} — {}",
                    resp["error_description"].as_str().unwrap_or("")
                ),
            ));
        }

        let access_token = resp["access_token"]
            .as_str()
            .ok_or_else(|| sync_err("oauth_token_exchange_failed", "No access_token in response"))?
            .to_string();
        let refresh_token = resp["refresh_token"].as_str().map(str::to_string);
        let expires_in = resp["expires_in"].as_u64().unwrap_or(3600);

        if let Err(error) = verify_google_drive_scope(&access_token, &resp).await {
            return reject_google_connect(&access_token, error.message).await;
        }

        if refresh_token.is_none() {
            return reject_google_connect(
                &access_token,
                "Google did not provide an offline refresh token. Disconnect Zync from your Google Account permissions, then reconnect and allow Drive access.",
            )
            .await;
        }

        let identity = fetch_google_identity(&access_token).await;

        let tokens = StoredTokens {
            access_token: Some(access_token),
            refresh_token: refresh_token.clone(),
            has_refresh_token: true,
            expires_at: now_secs() + expires_in.saturating_sub(60),
            last_sync: None,
            email: identity.email.clone(),
            avatar_url: identity.avatar_url.clone(),
        };
        let provider_data_dir = data_dir(app);
        save_tokens(&provider_data_dir, GOOGLE_TOKENS_KEY, &tokens).await?;

        Ok(ProviderIdentity { email: identity.email, avatar_url: identity.avatar_url })
    }

    async fn disconnect(&self, app: &tauri::AppHandle) -> SyncResult<()> {
        let provider_data_dir = data_dir(app);
        let tokens = load_tokens(&provider_data_dir, GOOGLE_TOKENS_KEY);
        let revoke_token = tokens.as_ref().and_then(|t| t.refresh_token.clone());
        let revoke_result = if let Some(token) = revoke_token.as_deref() {
            revoke_google_token(token).await
        } else {
            Err(sync_err(
                "provider_not_connected",
                "No local Google token was available to revoke Google Account access.",
            ))
        };

        delete_tokens(&provider_data_dir, GOOGLE_TOKENS_KEY);

        if let Err(error) = revoke_result {
            return Err(sync_err(
                "LOCAL_DISCONNECT_ONLY",
                format!(
                    "Disconnected locally, but Google-side access could not be revoked automatically: {} Remove Zync manually from your Google Account third-party access page.",
                    error.message
                ),
            ));
        }

        Ok(())
    }

    async fn status(&self, app: &tauri::AppHandle) -> SyncResult<ProviderStatusSnapshot> {
        let provider_data_dir = data_dir(app);
        let tokens = load_tokens(&provider_data_dir, GOOGLE_TOKENS_KEY);
        let connected = tokens
            .as_ref()
            .map(|t| t.refresh_token.is_some() || t.has_refresh_token)
            .unwrap_or(false);

        Ok(ProviderStatusSnapshot {
            connected,
            email: tokens.as_ref().and_then(|t| t.email.clone()),
            avatar_url: tokens.as_ref().and_then(|t| t.avatar_url.clone()),
            last_sync: tokens.as_ref().and_then(|t| t.last_sync),
        })
    }

    async fn upload_vault_blob(&self, app: &tauri::AppHandle, payload: Vec<u8>) -> SyncResult<u64> {
        let provider_data_dir = data_dir(app);
        let token = get_valid_google_token(&provider_data_dir).await?;
        let existing_id = find_vault_file(&token).await?;
        upload_vault_bytes(&token, payload, existing_id).await?;

        let ts = now_secs();
        if let Some(mut tokens) = load_tokens(&provider_data_dir, GOOGLE_TOKENS_KEY) {
            tokens.last_sync = Some(ts);
            save_tokens(&provider_data_dir, GOOGLE_TOKENS_KEY, &tokens).await?;
        }
        Ok(ts)
    }

    async fn download_vault_blob(&self, app: &tauri::AppHandle) -> SyncResult<(Vec<u8>, u64)> {
        let provider_data_dir = data_dir(app);
        let token = get_valid_google_token(&provider_data_dir).await?;
        let file_id = find_vault_file(&token)
            .await?
            .ok_or_else(|| sync_err("provider_vault_not_found", "No vault backup found in Google Drive."))?;
        let bytes = download_vault_bytes(&token, &file_id).await?;

        let ts = now_secs();
        if let Some(mut tokens) = load_tokens(&provider_data_dir, GOOGLE_TOKENS_KEY) {
            tokens.last_sync = Some(ts);
            save_tokens(&provider_data_dir, GOOGLE_TOKENS_KEY, &tokens).await?;
        }
        Ok((bytes, ts))
    }

    async fn upload_credential_record(
        &self,
        app: &tauri::AppHandle,
        object_name: &str,
        payload: Vec<u8>,
    ) -> SyncResult<u64> {
        let provider_data_dir = data_dir(app);
        let token = get_valid_google_token(&provider_data_dir).await?;
        let existing_id = find_file_by_name(&token, object_name).await?;
        upload_named_bytes(&token, object_name, payload, existing_id).await?;

        let ts = now_secs();
        if let Some(mut tokens) = load_tokens(&provider_data_dir, GOOGLE_TOKENS_KEY) {
            tokens.last_sync = Some(ts);
            save_tokens(&provider_data_dir, GOOGLE_TOKENS_KEY, &tokens).await?;
        }
        Ok(ts)
    }

    async fn upload_credential_records(
        &self,
        app: &tauri::AppHandle,
        records: Vec<ProviderUploadRecord>,
    ) -> SyncResult<u64> {
        if records.is_empty() {
            return Ok(0);
        }

        let provider_data_dir = data_dir(app);
        let token = get_valid_google_token(&provider_data_dir).await?;
        let existing_ids = existing_file_ids_for_upload(&token, &records).await?;
        let mut latest_synced_at = 0;

        for record in records {
            let existing_id = existing_ids.get(&record.object_name).cloned();
            upload_named_bytes(&token, &record.object_name, record.payload, existing_id).await?;
            latest_synced_at = now_secs();
        }

        if let Some(mut tokens) = load_tokens(&provider_data_dir, GOOGLE_TOKENS_KEY) {
            tokens.last_sync = Some(latest_synced_at);
            save_tokens(&provider_data_dir, GOOGLE_TOKENS_KEY, &tokens).await?;
        }
        Ok(latest_synced_at)
    }

    async fn list_credential_records(
        &self,
        app: &tauri::AppHandle,
        sync_collection_id: &str,
    ) -> SyncResult<Vec<ProviderCredentialObject>> {
        let provider_data_dir = data_dir(app);
        let token = get_valid_google_token(&provider_data_dir).await?;
        let prefix = format!("zync-sync-{sync_collection_id}-credential-");
        #[cfg(debug_assertions)]
        eprintln!(
            "[sync][google] list_credential_records collection_id='{}' prefix='{}'",
            sync_collection_id, prefix
        );
        find_files_by_name_prefix(&token, &prefix).await
    }

    async fn discover_sync_collection_ids(
        &self,
        app: &tauri::AppHandle,
    ) -> SyncResult<Vec<String>> {
        let provider_data_dir = data_dir(app);
        let token = get_valid_google_token(&provider_data_dir).await?;
        let mut ids = find_files_by_name_prefix(&token, "zync-sync-")
            .await?
            .into_iter()
            .filter_map(|object| provider_collection_id_from_object_name(&object.object_name))
            .collect::<Vec<_>>();
        ids.sort();
        ids.dedup();
        #[cfg(debug_assertions)]
        eprintln!(
            "[sync][google] discovered remote sync collection ids: {:?}",
            ids
        );
        Ok(ids)
    }

    async fn read_credential_record(
        &self,
        app: &tauri::AppHandle,
        object: &ProviderCredentialObject,
    ) -> SyncResult<Vec<u8>> {
        let provider_data_dir = data_dir(app);
        let token = get_valid_google_token(&provider_data_dir).await?;
        download_named_bytes(&token, object).await
    }
}

pub fn legacy_google_token_snapshot(data_dir: &Path) -> Option<ProviderStatusSnapshot> {
    let tokens = load_tokens(data_dir, GOOGLE_TOKENS_KEY)?;
    Some(ProviderStatusSnapshot {
        connected: tokens.refresh_token.is_some() || tokens.has_refresh_token,
        email: tokens.email.clone(),
        avatar_url: tokens.avatar_url.clone(),
        last_sync: tokens.last_sync,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::provider::validate_provider_contract;

    #[test]
    fn tokens_for_disk_strips_access_and_refresh_tokens() {
        let tokens = StoredTokens {
            access_token: Some("access-abc".into()),
            refresh_token: Some("refresh-xyz".into()),
            has_refresh_token: false,
            expires_at: 123,
            last_sync: Some(456),
            email: Some("user@example.com".into()),
            avatar_url: Some("https://example.com/avatar.png".into()),
        };

        let safe = tokens_for_disk(&tokens);
        let on_disk = serde_json::to_string(&safe).expect("token file json should serialize");
        assert!(
            !on_disk.contains("access-abc"),
            "access_token must not be persisted to disk"
        );
        assert!(
            !on_disk.contains("refresh-xyz"),
            "refresh_token must not be persisted in plaintext"
        );

        assert!(safe.access_token.is_none());
        assert!(safe.refresh_token.is_none());
        assert!(safe.has_refresh_token);
        assert_eq!(safe.expires_at, 123);
        assert_eq!(safe.last_sync, Some(456));
    }

    #[test]
    fn token_scope_check_requires_exact_drive_scope() {
        assert!(token_has_scope(
            Some("email https://www.googleapis.com/auth/drive.appdata"),
            GOOGLE_DRIVE_SCOPE
        ));
        assert!(!token_has_scope(
            Some("email https://www.googleapis.com/auth/drive.file"),
            GOOGLE_DRIVE_SCOPE
        ));
        assert!(!token_has_scope(None, GOOGLE_DRIVE_SCOPE));
    }

    #[test]
    fn google_provider_conforms_to_v1_contract() {
        let provider = GoogleVaultProvider;
        validate_provider_contract(&provider).expect("google provider contract should validate");
    }

    #[test]
    fn provider_collection_prefix_handles_domain_object_names() {
        assert_eq!(
            provider_collection_prefix_from_object_name(
                "zync-sync-123e4567-e89b-12d3-a456-426614174000-hosts-host1.zhost",
            ),
            Some("zync-sync-123e4567-e89b-12d3-a456-426614174000-".to_string()),
        );
        assert_eq!(
            provider_collection_prefix_from_object_name(
                "zync-sync-123e4567-e89b-12d3-a456-426614174000-credential-key1.zcred",
            ),
            Some("zync-sync-123e4567-e89b-12d3-a456-426614174000-".to_string()),
        );
        assert_eq!(
            provider_collection_prefix_from_object_name("vault.redb"),
            None,
        );
    }

    #[test]
    fn provider_collection_id_extracts_collection_id_from_domain_object_names() {
        assert_eq!(
            provider_collection_id_from_object_name(
                "zync-sync-123e4567-e89b-12d3-a456-426614174000-hosts-host1.zhost",
            ),
            Some("123e4567-e89b-12d3-a456-426614174000".to_string()),
        );
        assert_eq!(
            provider_collection_id_from_object_name(
                "zync-sync-123e4567-e89b-12d3-a456-426614174000-credential-key1.zcred",
            ),
            Some("123e4567-e89b-12d3-a456-426614174000".to_string()),
        );
        assert_eq!(provider_collection_id_from_object_name("vault.redb"), None);
    }
}
