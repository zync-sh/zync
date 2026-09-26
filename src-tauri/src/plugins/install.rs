mod review;

pub use review::{PluginActivationTransaction, PluginInstallInspection};

use super::package::MAX_PACKAGE_DOWNLOAD_BYTES;
use super::PluginScanner;
use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use std::fs;
use std::time::Duration;
use tauri::{AppHandle, Manager};

impl PluginScanner {
    pub fn uninstall_plugin(app: &AppHandle, plugin_id: &str) -> Result<()> {
        let config_dir = app
            .path()
            .app_config_dir()
            .context("Failed to resolve app config directory")?;
        let plugins_dir = config_dir.join("plugins");

        let dir_name = sanitize_plugin_dir_name(plugin_id)?;
        let target_dir = plugins_dir.join(&dir_name);

        // Legacy Check
        let legacy_name = legacy_sanitize_id(plugin_id);
        let legacy_dir = plugins_dir.join(&legacy_name);

        if !target_dir.exists() && !legacy_dir.exists() {
            return Err(anyhow::anyhow!(
                "Plugin directory not found for ID: {}",
                plugin_id
            ));
        }

        // Revoke approval before touching package files. If removal is interrupted, the
        // remaining package stays disabled until it goes through review again.
        super::grants::remove_approval(app, plugin_id)?;

        if target_dir.exists() {
            fs::remove_dir_all(target_dir)?;
            if legacy_dir.exists() {
                let _ = fs::remove_dir_all(legacy_dir);
            }
            Ok(())
        } else if legacy_dir.exists() {
            fs::remove_dir_all(legacy_dir)?;
            Ok(())
        } else {
            unreachable!("plugin directory existence checked above")
        }
    }
}

pub(super) async fn download_plugin_archive(url: &str) -> Result<Vec<u8>> {
    let requested_url = url::Url::parse(url).context("Invalid plugin download URL")?;
    if requested_url.scheme() != "https"
        || requested_url.host_str().is_none()
        || !requested_url.username().is_empty()
        || requested_url.password().is_some()
        || requested_url.fragment().is_some()
    {
        return Err(anyhow!(
            "Marketplace plugins must use HTTPS without credentials or fragments"
        ));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("Failed to create plugin download client")?;
    let response = client.get(requested_url).send().await?;
    if !response.status().is_success() {
        return Err(anyhow!(
            "Failed to download plugin: status {}",
            response.status()
        ));
    }
    let final_url = response.url();
    if final_url.scheme() != "https"
        || final_url.host_str().is_none()
        || !final_url.username().is_empty()
        || final_url.password().is_some()
        || final_url.fragment().is_some()
    {
        return Err(anyhow!("Plugin download redirected to an unsafe URL"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PACKAGE_DOWNLOAD_BYTES)
    {
        return Err(anyhow!("Plugin download exceeds 25 MiB"));
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        let next_size = bytes
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| anyhow!("Plugin download size overflow"))?;
        if next_size as u64 > MAX_PACKAGE_DOWNLOAD_BYTES {
            return Err(anyhow!("Plugin download exceeds 25 MiB"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Collision-free sanitizer for plugin directory names.
/// Uses URL-safe Base64 of the plugin ID to ensure uniqueness.
pub(super) fn sanitize_plugin_dir_name(id: &str) -> Result<String> {
    use base64::{engine::general_purpose, Engine as _};
    let encoded = general_purpose::URL_SAFE_NO_PAD.encode(id);

    if encoded.is_empty() || encoded == "." || encoded == ".." {
        return Err(anyhow::anyhow!(
            "Invalid plugin ID for directory naming: {}",
            id
        ));
    }

    Ok(encoded)
}

/// Legacy sanitizer used in earlier versions (v2.5.4 early rollout).
/// Replaced by Base64 encoding to prevent collisions.
fn legacy_sanitize_id(id: &str) -> String {
    let sanitized: String = id
        .trim()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    sanitized
}
