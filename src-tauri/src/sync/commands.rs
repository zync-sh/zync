use crate::vault::store::VaultService;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tauri::State;
use tokio::sync::Mutex;

// ── Constants ─────────────────────────────────────────────────────────────────

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

// ── Types ─────────────────────────────────────────────────────────────────────

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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProviderStatus {
    pub connected: bool,
    pub email: Option<String>,
    pub last_sync: Option<u64>,
}

#[derive(Deserialize)]
struct DriveFile {
    id: String,
}

#[derive(Deserialize)]
struct DriveFileList {
    files: Vec<DriveFile>,
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────

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

// ── Local redirect server ─────────────────────────────────────────────────────

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

fn http_upload_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())
}

fn bind_redirect_listener() -> Option<(u16, std::net::TcpListener)> {
    for port in 7357u16..7400 {
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", port)) {
            return Some((port, listener));
        }
    }
    None
}

async fn wait_for_auth_code(listener: std::net::TcpListener) -> Result<(String, String), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    listener
        .set_nonblocking(true)
        .map_err(|e| format!("failed to configure redirect listener: {e}"))?;
    let listener = TcpListener::from_std(listener)
        .map_err(|e| format!("failed to convert redirect listener: {e}"))?;

    let (mut stream, _) =
        tokio::time::timeout(std::time::Duration::from_secs(300), listener.accept())
            .await
            .map_err(|_| "OAuth timed out — no browser redirect received within 5 minutes")?
            .map_err(|e| e.to_string())?;

    let mut buf = vec![0u8; 4096];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let request = String::from_utf8_lossy(&buf[..n]);

    let (code, state) = parse_code_and_state(&request)?;

    let html = b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n\
<!DOCTYPE html>\
<html lang=\"en\">\
<head>\
<meta charset=\"UTF-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>Zync \xe2\x80\x94 Connected</title>\
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
</html>";
    let _ = stream.write_all(html).await;

    Ok((code, state))
}

fn parse_code_and_state(request: &str) -> Result<(String, String), String> {
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
            _ => {}
        }
    }

    match (code, state) {
        (Some(c), Some(s)) => Ok((c, s)),
        _ => Err("OAuth redirect missing code or state parameter".into()),
    }
}

// ── Token storage (file-based) ────────────────────────────────────────────────

fn tokens_path(data_dir: &std::path::Path, key: &str) -> std::path::PathBuf {
    data_dir.join(format!("sync-{key}.json"))
}

fn refresh_token_entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SYNC_TOKEN_KEYRING_SERVICE, key).map_err(|e| e.to_string())
}

fn save_refresh_token(key: &str, refresh_token: &str) -> Result<(), String> {
    refresh_token_entry(key)?
        .set_password(refresh_token)
        .map_err(|e| e.to_string())
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
    safe.access_token = None; // Never persist short-lived bearer tokens.
    safe.refresh_token = None; // Never persist long-lived OAuth refresh tokens in plaintext.
    if tokens.refresh_token.is_some() {
        safe.has_refresh_token = true;
    }
    safe
}

async fn save_tokens(data_dir: &std::path::Path, key: &str, tokens: &StoredTokens) -> Result<(), String> {
    if let Some(refresh_token) = tokens.refresh_token.as_deref() {
        save_refresh_token(key, refresh_token)?;
    } else if !tokens.has_refresh_token {
        delete_refresh_token(key);
    }
    let safe = tokens_for_disk(tokens);
    let json = serde_json::to_string(&safe).map_err(|e| e.to_string())?;
    tokio::fs::write(tokens_path(data_dir, key), json)
        .await
        .map_err(|e| e.to_string())
}

fn load_tokens(data_dir: &std::path::Path, key: &str) -> Option<StoredTokens> {
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

fn delete_tokens(data_dir: &std::path::Path, key: &str) {
    delete_refresh_token(key);
    let _ = std::fs::remove_file(tokens_path(data_dir, key));
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ── Google Drive API ──────────────────────────────────────────────────────────

async fn refresh_google_access_token(tokens: &mut StoredTokens) -> Result<(), String> {
    let refresh_token = tokens
        .refresh_token
        .clone()
        .ok_or("No refresh token stored — please reconnect.")?;

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
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(err) = resp["error"].as_str() {
        return Err(format!(
            "Token refresh failed: {err} — {}",
            resp["error_description"].as_str().unwrap_or("")
        ));
    }

    tokens.access_token = Some(
        resp["access_token"]
            .as_str()
            .ok_or("No access_token in refresh response")?
            .to_string(),
    );
    tokens.expires_at = now_secs() + resp["expires_in"].as_u64().unwrap_or(3600) - 60;
    Ok(())
}

async fn get_valid_google_token(data_dir: &std::path::Path) -> Result<String, String> {
    let mut tokens = load_tokens(data_dir, GOOGLE_TOKENS_KEY)
        .ok_or("Not connected to Google Drive. Please connect first.")?;

    if tokens.access_token.is_none() || now_secs() >= tokens.expires_at {
        refresh_google_access_token(&mut tokens).await?;
        save_tokens(data_dir, GOOGLE_TOKENS_KEY, &tokens).await?;
    }

    tokens
        .access_token
        .clone()
        .ok_or("No access token available after refresh.".into())
}

fn token_has_scope(scope_value: Option<&str>, required_scope: &str) -> bool {
    scope_value
        .unwrap_or_default()
        .split_whitespace()
        .any(|scope| scope == required_scope)
}

async fn reject_google_connect(
    access_token: &str,
    reason: impl Into<String>,
) -> Result<SyncProviderStatus, String> {
    let reason = reason.into();
    match revoke_google_token(access_token).await {
        Ok(()) => Err(reason),
        Err(revoke_error) => Err(format!(
            "{reason} Zync tried to revoke the partial Google authorization but Google returned: {revoke_error}"
        )),
    }
}

async fn verify_google_drive_scope(
    access_token: &str,
    token_response: &serde_json::Value,
) -> Result<(), String> {
    if token_has_scope(token_response["scope"].as_str(), GOOGLE_DRIVE_SCOPE) {
        return Ok(());
    }

    let token_info: serde_json::Value = http_client()?
        .get(GOOGLE_TOKENINFO_URL)
        .query(&[("access_token", access_token)])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if token_has_scope(token_info["scope"].as_str(), GOOGLE_DRIVE_SCOPE) {
        Ok(())
    } else {
        Err("Google Drive permission was not granted. Reconnect and allow Drive appdata access so Zync can back up the encrypted vault.".into())
    }
}

async fn find_vault_file(token: &str) -> Result<Option<String>, String> {
    let resp: DriveFileList = http_client()?
        .get(format!("{GDRIVE_API}/files"))
        .query(&[
            ("spaces", APPDATA_SPACE),
            ("fields", "files(id,name)"),
            ("q", &format!("name='{VAULT_FILENAME}'")),
        ])
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    Ok(resp.files.into_iter().next().map(|f| f.id))
}

async fn revoke_google_token(token: &str) -> Result<(), String> {
    http_client()?
        .post(GOOGLE_REVOKE_URL)
        .form(&[("token", token)])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn upload_vault_bytes(
    token: &str,
    file_bytes: Vec<u8>,
    existing_id: Option<String>,
) -> Result<(), String> {
    let client = http_upload_client()?;

    if let Some(file_id) = existing_id {
        client
            .patch(format!(
                "{GDRIVE_UPLOAD_API}/files/{file_id}?uploadType=media"
            ))
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/octet-stream")
            .body(file_bytes)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
    } else {
        let boundary = "zync_vault_mp_boundary";
        let metadata = serde_json::json!({
            "name": VAULT_FILENAME,
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
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
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

async fn download_vault_bytes(token: &str, file_id: &str) -> Result<Vec<u8>, String> {
    let bytes = http_client()?
        .get(format!("{GDRIVE_API}/files/{file_id}?alt=media"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;

    Ok(bytes.to_vec())
}

async fn fetch_google_email(token: &str) -> Option<String> {
    let resp: serde_json::Value = http_client()
        .ok()?
        .get("https://www.googleapis.com/oauth2/v3/userinfo")
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;

    resp["email"].as_str().map(str::to_string)
}

// ── OAuth connect flow ────────────────────────────────────────────────────────

async fn connect_google(app: tauri::AppHandle) -> Result<SyncProviderStatus, String> {
    if GOOGLE_CLIENT_ID.is_empty() {
        return Err("Google OAuth client ID is not configured. \
             Open the Vault tab → Google Drive Sync to set up your own OAuth app."
            .into());
    }

    let verifier = gen_random_base64url();
    let challenge = code_challenge_s256(&verifier);
    let state = gen_random_base64url();

    let (port, listener) =
        bind_redirect_listener().ok_or("No free port available in range 7357–7399")?;
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
        redir = url::form_urlencoded::byte_serialize(redirect_uri.as_bytes()).collect::<String>(),
        scope = url::form_urlencoded::byte_serialize(GOOGLE_SCOPE.as_bytes()).collect::<String>(),
    );

    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(auth_url, None::<String>)
        .map_err(|e| e.to_string())?;

    let (code, returned_state) = wait_for_auth_code(listener).await?;
    if returned_state != state {
        return Err("OAuth state mismatch — possible CSRF attack.".into());
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
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(err) = resp["error"].as_str() {
        return Err(format!(
            "Token exchange failed: {err} — {}",
            resp["error_description"].as_str().unwrap_or("")
        ));
    }

    let access_token = resp["access_token"]
        .as_str()
        .ok_or("No access_token in response")?
        .to_string();
    let refresh_token = resp["refresh_token"].as_str().map(str::to_string);
    let expires_in = resp["expires_in"].as_u64().unwrap_or(3600);

    if let Err(error) = verify_google_drive_scope(&access_token, &resp).await {
        return reject_google_connect(&access_token, error).await;
    }

    if refresh_token.is_none() {
        return reject_google_connect(
            &access_token,
            "Google did not provide an offline refresh token. Disconnect Zync from your Google Account permissions, then reconnect and allow Drive access.",
        )
        .await;
    }

    let email = fetch_google_email(&access_token).await;

    let tokens = StoredTokens {
        access_token: Some(access_token),
        refresh_token: refresh_token.clone(),
        has_refresh_token: true,
        expires_at: now_secs() + expires_in - 60,
        last_sync: None,
    };
    let data_dir = crate::commands::get_data_dir(&app);
    save_tokens(&data_dir, GOOGLE_TOKENS_KEY, &tokens).await?;

    Ok(SyncProviderStatus {
        connected: true,
        email,
        last_sync: None,
    })
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn sync_status(
    app: tauri::AppHandle,
    provider: String,
) -> Result<SyncProviderStatus, String> {
    let data_dir = crate::commands::get_data_dir(&app);
    match provider.as_str() {
        "google" => {
            let tokens = load_tokens(&data_dir, GOOGLE_TOKENS_KEY);
            let connected = tokens
                .as_ref()
                .map(|t| t.refresh_token.is_some() || t.has_refresh_token)
                .unwrap_or(false);
            Ok(SyncProviderStatus {
                connected,
                email: None,
                last_sync: tokens.as_ref().and_then(|t| t.last_sync),
            })
        }
        _ => Err(format!("Unknown provider: {provider}")),
    }
}

#[tauri::command]
pub async fn sync_connect(
    app: tauri::AppHandle,
    provider: String,
) -> Result<SyncProviderStatus, String> {
    match provider.as_str() {
        "google" => connect_google(app).await,
        _ => Err(format!("Unknown provider: {provider}")),
    }
}

#[tauri::command]
pub async fn sync_disconnect(app: tauri::AppHandle, provider: String) -> Result<(), String> {
    let data_dir = crate::commands::get_data_dir(&app);
    match provider.as_str() {
        "google" => {
            let tokens = load_tokens(&data_dir, GOOGLE_TOKENS_KEY);
            let revoke_token = tokens.as_ref().and_then(|t| t.refresh_token.clone());
            let revoke_result = if let Some(token) = revoke_token.as_deref() {
                revoke_google_token(token).await
            } else {
                Err("No local Google token was available to revoke Google Account access.".into())
            };

            delete_tokens(&data_dir, GOOGLE_TOKENS_KEY);

            if let Err(error) = revoke_result {
                return Err(format!(
                    "Disconnected locally, but Google-side access could not be revoked automatically: {error} Remove Zync manually from your Google Account third-party access page."
                ));
            }

            Ok(())
        }
        _ => Err(format!("Unknown provider: {provider}")),
    }
}

#[tauri::command]
pub async fn sync_upload(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
    provider: String,
) -> Result<u64, String> {
    let data_dir = crate::commands::get_data_dir(&app);
    let tmp_path = data_dir.join("vault.redb.sync-tmp");

    // Export via the vault (closes + reopens the DB to release the file lock).
    {
        let mut svc = vault.lock().await;
        svc.export_vault(&tmp_path).map_err(|e| e.to_string())?;
    }

    let file_bytes = tokio::fs::read(&tmp_path).await.map_err(|e| e.to_string())?;
    let _ = tokio::fs::remove_file(&tmp_path).await;

    match provider.as_str() {
        "google" => {
            let token = get_valid_google_token(&data_dir).await?;
            let existing_id = find_vault_file(&token).await?;
            upload_vault_bytes(&token, file_bytes, existing_id).await?;

            let ts = now_secs();
            if let Some(mut tokens) = load_tokens(&data_dir, GOOGLE_TOKENS_KEY) {
                tokens.last_sync = Some(ts);
                save_tokens(&data_dir, GOOGLE_TOKENS_KEY, &tokens).await?;
            }
            Ok(ts)
        }
        _ => Err(format!("Unknown provider: {provider}")),
    }
}

#[tauri::command]
pub async fn sync_download(
    app: tauri::AppHandle,
    vault: State<'_, Mutex<VaultService>>,
    provider: String,
) -> Result<(), String> {
    let data_dir = crate::commands::get_data_dir(&app);

    match provider.as_str() {
        "google" => {
            let token = get_valid_google_token(&data_dir).await?;
            let file_id = find_vault_file(&token)
                .await?
                .ok_or("No vault backup found in Google Drive.")?;
            let bytes = download_vault_bytes(&token, &file_id).await?;
            let tmp_path = data_dir.join("vault.redb.download-tmp");
            tokio::fs::write(&tmp_path, &bytes).await.map_err(|e| e.to_string())?;

            // Validate + replace through VaultService so we don't overwrite an active DB
            // handle and we keep pre-import backup behavior centralized.
            {
                let mut svc = vault.lock().await;
                if let Err(e) = svc.import_vault(&tmp_path) {
                    let _ = tokio::fs::remove_file(&tmp_path).await;
                    return Err(e.to_string());
                }
            }
            let _ = tokio::fs::remove_file(&tmp_path).await;

            let ts = now_secs();
            if let Some(mut tokens) = load_tokens(&data_dir, GOOGLE_TOKENS_KEY) {
                tokens.last_sync = Some(ts);
                save_tokens(&data_dir, GOOGLE_TOKENS_KEY, &tokens).await?;
            }
            Ok(())
        }
        _ => Err(format!("Unknown provider: {provider}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_for_disk_strips_access_and_refresh_tokens() {
        let tokens = StoredTokens {
            access_token: Some("access-abc".into()),
            refresh_token: Some("refresh-xyz".into()),
            has_refresh_token: false,
            expires_at: 123,
            last_sync: Some(456),
        };

        let safe = tokens_for_disk(&tokens);
        let on_disk = serde_json::to_string(&safe).expect("token file json should serialize");
        assert!(!on_disk.contains("access-abc"), "access_token must not be persisted");
        assert!(!on_disk.contains("refresh-xyz"), "refresh_token must not be persisted in plaintext");

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
}
