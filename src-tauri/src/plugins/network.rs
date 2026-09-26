use super::broker::PluginNetworkGrant;
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose, Engine as _};
use futures_util::StreamExt;
use reqwest::header::{HeaderValue, ACCEPT, CONTENT_LENGTH, CONTENT_TYPE, LOCATION};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;
use url::{Host, Url};

const MAX_URL_CHARS: usize = 2_048;
const MAX_ACCEPT_CHARS: usize = 256;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_REDIRECTS: usize = 3;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginNetworkFetchRequest {
    pub url: String,
    #[serde(default)]
    pub accept: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginNetworkFetchResponse {
    pub status: u16,
    pub final_url: String,
    pub content_type: Option<String>,
    pub body: String,
    pub body_encoding: &'static str,
}

pub async fn fetch(
    grant: &PluginNetworkGrant,
    request: PluginNetworkFetchRequest,
) -> Result<PluginNetworkFetchResponse> {
    let accept = validate_accept(request.accept.as_deref())?;
    let mut url = validate_url(&request.url, grant)?;

    for redirect_count in 0..=MAX_REDIRECTS {
        let (host, address) = resolve_public_destination(&url).await?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(REQUEST_TIMEOUT)
            .user_agent(concat!("Zync-Plugin-Broker/", env!("CARGO_PKG_VERSION")))
            // Pin this request to the addresses that passed SSRF checks. Redirects build a
            // fresh client and repeat validation for their own destination.
            .resolve(&host, address)
            .build()
            .context("Failed to create plugin network client")?;
        let mut outgoing = client.get(url.clone());
        if let Some(value) = accept.clone() {
            outgoing = outgoing.header(ACCEPT, value);
        }
        let response = outgoing
            .send()
            .await
            .context("Plugin network request failed")?;

        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err(anyhow!("Plugin network request exceeded redirect limit"));
            }
            let location = response
                .headers()
                .get(LOCATION)
                .ok_or_else(|| anyhow!("Plugin network redirect is missing Location"))?
                .to_str()
                .context("Plugin network redirect Location is invalid")?;
            let redirected = url
                .join(location)
                .context("Plugin network redirect URL is invalid")?;
            url = validate_url(redirected.as_str(), grant)?;
            continue;
        }

        if response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
            .is_some_and(|length| length > MAX_RESPONSE_BYTES)
        {
            return Err(anyhow!("Plugin network response exceeds 2 MiB"));
        }
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("Failed to read plugin network response")?;
            let next_size = bytes
                .len()
                .checked_add(chunk.len())
                .ok_or_else(|| anyhow!("Plugin network response size overflow"))?;
            if next_size > MAX_RESPONSE_BYTES {
                return Err(anyhow!("Plugin network response exceeds 2 MiB"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let (body, body_encoding) = match String::from_utf8(bytes) {
            Ok(text) => (text, "utf8"),
            Err(error) => (
                general_purpose::STANDARD.encode(error.into_bytes()),
                "base64",
            ),
        };
        return Ok(PluginNetworkFetchResponse {
            status,
            final_url: url.to_string(),
            content_type,
            body,
            body_encoding,
        });
    }

    Err(anyhow!("Plugin network request did not complete"))
}

fn validate_url(raw: &str, grant: &PluginNetworkGrant) -> Result<Url> {
    if raw.chars().count() > MAX_URL_CHARS {
        return Err(anyhow!("Plugin network URL is too long"));
    }
    let mut url = Url::parse(raw).context("Plugin network URL is invalid")?;
    if url.scheme() != "https" {
        return Err(anyhow!("Plugin network requests require HTTPS"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(anyhow!("Plugin network URLs cannot contain credentials"));
    }
    if url.port_or_known_default() != Some(443) {
        return Err(anyhow!("Plugin network requests require HTTPS port 443"));
    }
    let host = match url.host() {
        Some(Host::Domain(host)) => host.trim_end_matches('.').to_ascii_lowercase(),
        _ => return Err(anyhow!("Plugin network requests require a domain name")),
    };
    if !grant.allows_host(&host) {
        return Err(anyhow!("Plugin network host is not granted: {host}"));
    }
    url.set_fragment(None);
    Ok(url)
}

fn validate_accept(value: Option<&str>) -> Result<Option<HeaderValue>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.chars().count() > MAX_ACCEPT_CHARS {
        return Err(anyhow!("Plugin network Accept header is too long"));
    }
    Ok(Some(
        HeaderValue::from_str(value).context("Plugin network Accept header is invalid")?,
    ))
}

async fn resolve_public_destination(url: &Url) -> Result<(String, SocketAddr)> {
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("Plugin network URL has no host"))?
        .to_string();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| anyhow!("Plugin network URL has no port"))?;
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .context("Failed to resolve plugin network host")?
        .collect();
    if addresses.is_empty() {
        return Err(anyhow!("Plugin network host did not resolve"));
    }
    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(anyhow!(
            "Plugin network host resolves to a private or reserved address"
        ));
    }
    Ok((host, addresses[0]))
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, d] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224
        || (a == 255 && b == 255 && c == 255 && d == 255))
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_public_ipv4(mapped);
    }
    let segments = ip.segments();
    (segments[0] & 0xe000) == 0x2000 && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_private_reserved_and_metadata_addresses() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "192.0.2.1",
            "::1",
            "fe80::1",
            "fc00::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!is_public_ip(address.parse().expect("test address")));
        }
        assert!(is_public_ip("1.1.1.1".parse().expect("public IPv4")));
        assert!(is_public_ip(
            "2606:4700:4700::1111".parse().expect("public IPv6")
        ));
    }

    #[test]
    fn accept_header_rejects_injection_and_excessive_values() {
        assert!(validate_accept(Some("application/json")).is_ok());
        assert!(validate_accept(Some("text/plain\r\nx-secret: value")).is_err());
        assert!(validate_accept(Some(&"x".repeat(MAX_ACCEPT_CHARS + 1))).is_err());
    }

    #[test]
    fn url_policy_requires_granted_public_https_destinations() {
        let grant = PluginNetworkGrant {
            allowed_hosts: vec!["api.example.com".into(), "*.allowed.example".into()],
        };
        let normalized = validate_url("https://api.example.com/data#ignored", &grant)
            .expect("approved HTTPS URL");
        assert!(normalized.fragment().is_none());
        assert!(validate_url("https://one.allowed.example/data", &grant).is_ok());
        assert!(validate_url("http://api.example.com/data", &grant).is_err());
        assert!(validate_url("https://api.example.com:8443/data", &grant).is_err());
        assert!(validate_url("https://user:secret@api.example.com/data", &grant).is_err());
        assert!(validate_url("https://allowed.example/data", &grant).is_err());
        assert!(validate_url("https://other.example/data", &grant).is_err());
        assert!(validate_url("https://127.0.0.1/data", &grant).is_err());
    }
}
