use super::config::ShareConfig;
use super::err;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct SessionTokens {
    pub access_token: String,
    pub refresh_token: String,
    #[serde(default)]
    pub expires_in: u64,
}

#[derive(Debug, Deserialize)]
struct OAuthStartResponse {
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct OAuthStart {
    pub url: String,
}

#[derive(Debug, Deserialize)]
struct ApiErrorBody {
    error: ApiErrorDetail,
}

#[derive(Debug, Deserialize)]
struct ApiErrorDetail {
    code: String,
    message: String,
}

#[derive(Debug, Deserialize)]
struct MeRaw {
    user: Option<MeUser>,
    entitlement: Option<MeEntitlement>,
}

#[derive(Debug, Deserialize)]
struct MeUser {
    id: Option<String>,
    email: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MeEntitlement {
    max_active_shares: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct MeResponse {
    pub email: Option<String>,
    pub user_id: Option<String>,
    pub avatar_url: Option<String>,
    pub quota_max: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareRecord {
    pub id: String,
    pub slug: String,
    pub status: String,
    pub target_kind: String,
    pub target_host: String,
    pub target_port: i32,
    #[serde(default)]
    pub public_url: Option<String>,
    #[serde(default)]
    pub public_host: Option<String>,
    #[serde(default)]
    pub has_password: bool,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ListSharesResponse {
    shares: Vec<ShareRecord>,
}

#[derive(Debug, Deserialize)]
pub struct TicketResponse {
    pub token: String,
    /// Present on the API response; reserved for future expiry UX.
    #[serde(default)]
    #[allow(dead_code)]
    pub expires_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CreateShareBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub target_kind: String,
    pub target_host: String,
    pub target_port: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub basic_auth_password: Option<String>,
}

pub struct ApiClient {
    config: ShareConfig,
    http: reqwest::Client,
}

impl ApiClient {
    pub fn new(config: ShareConfig) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { config, http }
    }

    pub async fn oauth_start(
        &self,
        provider: &str,
        redirect_uri: &str,
        device_name: &str,
    ) -> Result<OAuthStart, String> {
        let url = format!(
            "{}/v1/auth/{}/start?redirect_uri={}&device_name={}",
            self.config.api_base,
            provider,
            urlencoding(redirect_uri),
            urlencoding(device_name)
        );
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| err("oauth_start_failed", e.to_string()))?;
        if !resp.status().is_success() {
            return Err(read_error(resp).await);
        }
        let body: OAuthStartResponse = resp
            .json()
            .await
            .map_err(|e| err("oauth_start_failed", e.to_string()))?;
        Ok(OAuthStart { url: body.url })
    }

    pub async fn exchange_code(&self, code: &str) -> Result<SessionTokens, String> {
        self.post_json(
            "/v1/auth/exchange",
            &serde_json::json!({ "code": code }),
            None,
        )
        .await
    }

    pub async fn refresh(&self, refresh_token: &str) -> Result<SessionTokens, String> {
        self.post_json(
            "/v1/auth/refresh",
            &serde_json::json!({ "refresh_token": refresh_token }),
            None,
        )
        .await
    }

    pub async fn logout(&self, refresh_token: &str) -> Result<(), String> {
        let _ = self
            .http
            .post(self.config.api_url("/v1/auth/logout"))
            .json(&serde_json::json!({ "refresh_token": refresh_token }))
            .send()
            .await;
        Ok(())
    }

    pub async fn me(&self, access_token: &str) -> Result<MeResponse, String> {
        let resp = self
            .http
            .get(self.config.api_url("/v1/me"))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| err("me_failed", e.to_string()))?;
        if !resp.status().is_success() {
            return Err(read_error(resp).await);
        }
        let raw: MeRaw = resp
            .json()
            .await
            .map_err(|e| err("me_failed", e.to_string()))?;
        Ok(MeResponse {
            email: raw.user.as_ref().and_then(|u| u.email.clone()),
            user_id: raw.user.as_ref().and_then(|u| u.id.clone()),
            avatar_url: raw
                .user
                .as_ref()
                .and_then(|u| u.avatar_url.clone())
                .filter(|s| !s.trim().is_empty()),
            quota_max: normalize_quota_max(raw.entitlement.and_then(|e| e.max_active_shares)),
        })
    }

    pub async fn list_shares(&self, access_token: &str) -> Result<Vec<ShareRecord>, String> {
        let resp = self
            .http
            .get(self.config.api_url("/v1/shares"))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| err("shares_list_failed", e.to_string()))?;
        if !resp.status().is_success() {
            return Err(read_error(resp).await);
        }
        let body: ListSharesResponse = resp
            .json()
            .await
            .map_err(|e| err("shares_list_failed", e.to_string()))?;
        Ok(body.shares)
    }

    pub async fn create_share(
        &self,
        access_token: &str,
        body: &CreateShareBody,
    ) -> Result<ShareRecord, String> {
        self.post_json("/v1/shares", body, Some(access_token)).await
    }

    pub async fn stop_share(&self, access_token: &str, id: &str) -> Result<ShareRecord, String> {
        self.post_json(
            &format!("/v1/shares/{id}/stop"),
            &serde_json::json!({}),
            Some(access_token),
        )
        .await
    }

    pub async fn start_share(&self, access_token: &str, id: &str) -> Result<ShareRecord, String> {
        self.post_json(
            &format!("/v1/shares/{id}/start"),
            &serde_json::json!({}),
            Some(access_token),
        )
        .await
    }

    pub async fn delete_share(&self, access_token: &str, id: &str) -> Result<ShareRecord, String> {
        let resp = self
            .http
            .delete(self.config.api_url(&format!("/v1/shares/{id}")))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| err("share_delete_failed", e.to_string()))?;
        if !resp.status().is_success() {
            return Err(read_error(resp).await);
        }
        resp.json()
            .await
            .map_err(|e| err("share_delete_failed", e.to_string()))
    }

    pub async fn create_ticket(
        &self,
        access_token: &str,
        id: &str,
    ) -> Result<TicketResponse, String> {
        self.post_json(
            &format!("/v1/shares/{id}/ticket"),
            &serde_json::json!({}),
            Some(access_token),
        )
        .await
    }

    async fn post_json<T: serde::de::DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        body: &B,
        access_token: Option<&str>,
    ) -> Result<T, String> {
        let mut req = self.http.post(self.config.api_url(path)).json(body);
        if let Some(token) = access_token {
            req = req.bearer_auth(token);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| err("request_failed", e.to_string()))?;
        if !resp.status().is_success() {
            return Err(read_error(resp).await);
        }
        resp.json()
            .await
            .map_err(|e| err("invalid_json", e.to_string()))
    }
}

async fn read_error(resp: reqwest::Response) -> String {
    let status = resp.status();
    if let Ok(body) = resp.json::<ApiErrorBody>().await {
        let message = body.error.message.trim();
        let message = if message.is_empty() && body.error.code == "share_quota_exceeded" {
            "3 of 3 Public URLs in use. Delete one to add another.".to_string()
        } else if message.is_empty() {
            body.error.code.clone()
        } else {
            message.to_string()
        };
        return err(&body.error.code, message);
    }
    err(
        "http_error",
        format!("Public URLs request failed ({status})"),
    )
}

fn urlencoding(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// Beta default is 3. Legacy single-slot default (1) remaps to 3.
/// 0 is preserved so a revoked entitlement stays disabled.
pub fn normalize_quota_max(max: Option<i32>) -> i32 {
    match max {
        Some(0) => 0,
        Some(1) => 3,
        Some(n) if n > 1 => n,
        _ => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_quota_max;

    #[test]
    fn old_single_slot_default_is_beta_three() {
        assert_eq!(normalize_quota_max(Some(1)), 3);
        assert_eq!(normalize_quota_max(Some(0)), 0);
        assert_eq!(normalize_quota_max(None), 3);
        assert_eq!(normalize_quota_max(Some(3)), 3);
        assert_eq!(normalize_quota_max(Some(10)), 10);
    }
}
