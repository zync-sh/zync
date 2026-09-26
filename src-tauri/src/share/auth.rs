use super::api::{ApiClient, MeResponse, SessionTokens};
use super::config::ShareConfig;
use super::err;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener as TokioTcpListener;
use tokio::sync::Mutex as AsyncMutex;

const KEYRING_SERVICE: &str = "Zync Public URLs";
const KEYRING_ACCOUNT: &str = "refresh-token";
const ACCOUNT_FILE: &str = "share-account.json";
const LOOPBACK_PORTS: std::ops::Range<u16> = 7457..7500;
const OAUTH_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareAccountFile {
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ShareAuthStatus {
    pub signed_in: bool,
    pub email: Option<String>,
    pub user_id: Option<String>,
    pub avatar_url: Option<String>,
    pub quota_max: i32,
}

#[derive(Clone)]
struct LiveSession {
    access_token: String,
    refresh_token: String,
    expires_at: Instant,
    email: Option<String>,
    user_id: Option<String>,
    avatar_url: Option<String>,
    quota_max: i32,
}

pub struct AuthStore {
    data_dir: PathBuf,
    live: Mutex<Option<LiveSession>>,
    login_cancel: Mutex<Option<tokio::sync::watch::Sender<bool>>>,
    refresh_lock: AsyncMutex<()>,
}

impl AuthStore {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            live: Mutex::new(None),
            login_cancel: Mutex::new(None),
            refresh_lock: AsyncMutex::new(()),
        }
    }

    /// Abort an in-flight browser OAuth wait so the UI can retry.
    pub fn cancel_login(&self) -> bool {
        let Ok(mut guard) = self.login_cancel.lock() else {
            return false;
        };
        if let Some(tx) = guard.take() {
            let _ = tx.send(true);
            true
        } else {
            false
        }
    }

    fn arm_login_cancel(&self) -> Result<tokio::sync::watch::Receiver<bool>, String> {
        let (tx, rx) = tokio::sync::watch::channel(false);
        let mut guard = self
            .login_cancel
            .lock()
            .map_err(|_| err("share_auth", "lock"))?;
        if let Some(prev) = guard.take() {
            let _ = prev.send(true);
        }
        *guard = Some(tx);
        Ok(rx)
    }

    fn clear_login_cancel(&self) {
        if let Ok(mut guard) = self.login_cancel.lock() {
            let _ = guard.take();
        }
    }

    fn account_path(&self) -> PathBuf {
        self.data_dir.join(ACCOUNT_FILE)
    }

    pub fn cached_status(&self) -> ShareAuthStatus {
        if let Some(live) = self.live.lock().ok().and_then(|g| g.clone()) {
            return ShareAuthStatus {
                signed_in: true,
                email: live.email,
                user_id: live.user_id,
                avatar_url: live.avatar_url,
                quota_max: live.quota_max,
            };
        }
        let file = read_account_file(&self.account_path());
        let signed_in = refresh_token_entry()
            .ok()
            .and_then(|e| e.get_password().ok())
            .is_some_and(|p| !p.is_empty());
        ShareAuthStatus {
            signed_in,
            email: file.as_ref().and_then(|a| a.email.clone()),
            user_id: file.as_ref().and_then(|a| a.user_id.clone()),
            avatar_url: file.as_ref().and_then(|a| a.avatar_url.clone()),
            quota_max: 3,
        }
    }

    pub async fn ensure_access_token(&self, config: &ShareConfig) -> Result<String, String> {
        {
            let guard = self.live.lock().map_err(|_| err("share_auth", "lock"))?;
            if let Some(live) = guard.as_ref() {
                if Instant::now() + Duration::from_secs(30) < live.expires_at {
                    return Ok(live.access_token.clone());
                }
            }
        }
        self.refresh(config).await
    }

    pub async fn restore(&self, config: &ShareConfig) -> Result<ShareAuthStatus, String> {
        match self.refresh(config).await {
            Ok(_) => Ok(self.cached_status()),
            Err(e) => {
                if e.contains("invalid_refresh")
                    || e.contains("not_signed_in")
                    || e.contains("no_refresh_token")
                {
                    Ok(ShareAuthStatus {
                        signed_in: false,
                        email: None,
                        user_id: None,
                        avatar_url: None,
                        quota_max: 3,
                    })
                } else {
                    Err(e)
                }
            }
        }
    }

    pub async fn login(
        &self,
        app: &AppHandle,
        config: &ShareConfig,
        provider: &str,
    ) -> Result<ShareAuthStatus, String> {
        if provider != "github" && provider != "google" {
            return Err(err("invalid_provider", "Use GitHub or Google"));
        }
        let (port, listener) = bind_redirect_listener()
            .ok_or_else(|| err("oauth_bind_failed", "Could not bind a local redirect port"))?;
        let redirect_uri = format!("http://127.0.0.1:{port}/cb");
        let device_name = format!(
            "Zync desktop ({})",
            whoami::fallible::hostname().unwrap_or_else(|_| "this device".into())
        );
        let client = ApiClient::new(config.clone());
        let start = client
            .oauth_start(provider, &redirect_uri, &device_name)
            .await?;
        app.opener()
            .open_url(&start.url, None::<String>)
            .map_err(|e| err("oauth_browser_open_failed", e.to_string()))?;
        // Keep refresh_lock released during browser wait so logout/refresh are not blocked for minutes.
        let mut cancel_rx = self.arm_login_cancel()?;
        let code = match wait_for_login_code(listener, &mut cancel_rx).await {
            Ok(code) => {
                self.clear_login_cancel();
                code
            }
            Err(e) => {
                self.clear_login_cancel();
                return Err(e);
            }
        };
        let tokens = client.exchange_code(&code).await?;
        // Serialize with refresh/logout so a stale refresh cannot overwrite this session.
        let _guard = self.refresh_lock.lock().await;
        self.apply_tokens(config, tokens).await
    }

    pub async fn logout(&self, config: &ShareConfig) -> Result<(), String> {
        // Hold refresh_lock for the whole clear so an in-flight refresh cannot
        // re-apply tokens after live/keyring are wiped.
        let _guard = self.refresh_lock.lock().await;
        let refresh = {
            let mut guard = self.live.lock().map_err(|_| err("share_auth", "lock"))?;
            let token = guard.as_ref().map(|s| s.refresh_token.clone());
            *guard = None;
            token
        };
        let refresh = match refresh {
            Some(t) => Some(t),
            None => refresh_token_entry()
                .ok()
                .and_then(|e| e.get_password().ok()),
        };
        let _ = delete_refresh_token();
        let _ = std::fs::remove_file(self.account_path());
        if let Some(token) = refresh {
            let client = ApiClient::new(config.clone());
            let _ = client.logout(&token).await;
        }
        Ok(())
    }

    async fn refresh(&self, config: &ShareConfig) -> Result<String, String> {
        let _refresh_guard = self.refresh_lock.lock().await;
        // Another task may have refreshed / logged in while we waited for the lock.
        {
            let guard = self.live.lock().map_err(|_| err("share_auth", "lock"))?;
            if let Some(live) = guard.as_ref() {
                if Instant::now() + Duration::from_secs(30) < live.expires_at {
                    return Ok(live.access_token.clone());
                }
            }
        }
        let refresh = {
            let guard = self.live.lock().map_err(|_| err("share_auth", "lock"))?;
            if let Some(live) = guard.as_ref() {
                Some(live.refresh_token.clone())
            } else {
                None
            }
        };
        let refresh = match refresh {
            Some(t) => t,
            None => {
                // Cold start / restore. If logout cleared state under this lock,
                // keyring is already empty and this fails cleanly.
                refresh_token_entry()
                    .ok()
                    .and_then(|e| e.get_password().ok())
                    .filter(|t| !t.is_empty())
                    .ok_or_else(|| err("not_signed_in", "Not signed in to Zync"))?
            }
        };
        let client = ApiClient::new(config.clone());
        let tokens = client.refresh(&refresh).await?;
        let status = self.apply_tokens(config, tokens).await?;
        let guard = self.live.lock().map_err(|_| err("share_auth", "lock"))?;
        guard
            .as_ref()
            .map(|s| s.access_token.clone())
            .ok_or_else(|| err("share_auth", "session missing after refresh"))
            .map(|t| {
                let _ = status;
                t
            })
    }

    async fn apply_tokens(
        &self,
        config: &ShareConfig,
        tokens: SessionTokens,
    ) -> Result<ShareAuthStatus, String> {
        store_refresh_token(&tokens.refresh_token)?;
        let client = ApiClient::new(config.clone());
        let me = client.me(&tokens.access_token).await.unwrap_or(MeResponse {
            email: None,
            user_id: None,
            avatar_url: None,
            quota_max: 3,
        });
        // Treat missing/zero lifetime as the API default (~15m), not one second.
        let lifetime = if tokens.expires_in == 0 {
            900
        } else {
            tokens.expires_in
        };
        let expires_in = if lifetime > 30 {
            lifetime - 15
        } else {
            lifetime.max(1)
        };
        let live = LiveSession {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: Instant::now() + Duration::from_secs(expires_in),
            email: me.email.clone(),
            user_id: me.user_id.clone(),
            avatar_url: me.avatar_url.clone(),
            quota_max: super::api::normalize_quota_max(Some(me.quota_max)),
        };
        write_account_file(
            &self.account_path(),
            &ShareAccountFile {
                email: live.email.clone(),
                user_id: live.user_id.clone(),
                avatar_url: live.avatar_url.clone(),
            },
        );
        let status = ShareAuthStatus {
            signed_in: true,
            email: live.email.clone(),
            user_id: live.user_id.clone(),
            avatar_url: live.avatar_url.clone(),
            quota_max: live.quota_max,
        };
        let mut guard = self.live.lock().map_err(|_| err("share_auth", "lock"))?;
        *guard = Some(live);
        Ok(status)
    }
}

fn refresh_token_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| err("keyring", e.to_string()))
}

fn store_refresh_token(token: &str) -> Result<(), String> {
    refresh_token_entry()?
        .set_password(token)
        .map_err(|e| err("keyring", e.to_string()))
}

fn delete_refresh_token() -> Result<(), String> {
    match refresh_token_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(err("keyring", e.to_string())),
    }
}

fn read_account_file(path: &Path) -> Option<ShareAccountFile> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_account_file(path: &Path, account: &ShareAccountFile) {
    if let Ok(raw) = serde_json::to_string_pretty(account) {
        let _ = std::fs::write(path, raw);
    }
}

fn bind_redirect_listener() -> Option<(u16, std::net::TcpListener)> {
    for port in LOOPBACK_PORTS {
        if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", port)) {
            return Some((port, listener));
        }
    }
    None
}

async fn wait_for_login_code(
    listener: std::net::TcpListener,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| err("oauth_redirect_listener_error", e.to_string()))?;
    let listener = TokioTcpListener::from_std(listener)
        .map_err(|e| err("oauth_redirect_listener_error", e.to_string()))?;

    let accept = async {
        tokio::time::timeout(OAUTH_TIMEOUT, listener.accept())
            .await
            .map_err(|_| {
                err(
                    "oauth_timeout",
                    "Sign-in timed out - no browser redirect received within 5 minutes",
                )
            })?
            .map_err(|e| err("oauth_redirect_listener_error", e.to_string()))
    };

    let (mut stream, _) = tokio::select! {
        _ = cancel_rx.wait_for(|canceled| *canceled) => {
            return Err(err("oauth_canceled", "Sign-in canceled"));
        }
        accepted = accept => accepted?,
    };

    let mut buf = vec![0u8; 4096];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| err("oauth_redirect_parse_failed", e.to_string()))?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let code = parse_code(&request);
    let html = if code.is_some() {
        SUCCESS_HTML
    } else {
        FAIL_HTML
    };
    let _ = stream.write_all(html.as_bytes()).await;
    let _ = stream.shutdown().await;
    code.ok_or_else(|| {
        err(
            "oauth_denied",
            "Sign-in was canceled or did not return a login code",
        )
    })
}

fn parse_code(request: &str) -> Option<String> {
    let line = request.lines().next()?;
    let path = line.split_whitespace().nth(1)?;
    let query = path.split_once('?')?.1;
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        if k == "code" && !v.is_empty() {
            return Some(v.into_owned());
        }
    }
    None
}

const SUCCESS_HTML: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n\
<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>Zync - Signed in</title><style>\
*{box-sizing:border-box;margin:0;padding:0}\
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:radial-gradient(1100px 700px at 50% -200px,#1a1833 0%,#0c0c0f 45%);color:#e2e2e5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}\
.card{background:rgba(22,22,26,.9);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:2.2rem 2rem;text-align:center;max-width:390px;width:100%}\
h1{font-size:1.2rem;font-weight:600;margin-bottom:.5rem}\
p{font-size:.88rem;color:rgba(226,226,229,.72);line-height:1.55}\
.badge{display:inline-block;margin-top:1rem;padding:.3rem .85rem;border-radius:99px;background:rgba(124,106,247,.12);border:1px solid rgba(124,106,247,.25);font-size:.75rem;color:#a89ef5}\
</style></head><body><div class=\"card\">\
<h1>Signed in to Zync</h1>\
<p>Return to Zync to continue. This is your Zync account - not Google Drive Sync.</p>\
<div class=\"badge\">Zync account</div>\
<p style=\"margin-top:.65rem;font-size:.76rem;color:rgba(226,226,229,.5)\">You can close this tab now.</p>\
</div></body></html>";

const FAIL_HTML: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n\
<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\"><title>Zync - Sign-in not completed</title></head>\
<body style=\"font-family:sans-serif;background:#0c0c0f;color:#e2e2e5;display:flex;align-items:center;justify-content:center;min-height:100vh\">\
<div style=\"text-align:center;max-width:24rem\"><h1>Sign-in not completed</h1>\
<p>Return to Zync and try Continue with GitHub or Google again.</p></div></body></html>";
