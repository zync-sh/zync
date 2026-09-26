use super::protocol::{header_get, is_websocket, AgentOut, Open, MODE_TCP};
use super::stream::{is_cancelled, StreamReaders};
use bytes::Bytes;
use futures_util::StreamExt;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

const CHUNK_SIZE: usize = 24 * 1024;
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);

fn http_proxy_client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(DIAL_TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .build()
                .expect("share http proxy client")
        })
        .clone()
}

fn loopback_socket_addr(host: &str, port: u16) -> SocketAddr {
    let ip = if loopback_host(host) == "::1" {
        IpAddr::V6(Ipv6Addr::LOCALHOST)
    } else {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    };
    SocketAddr::new(ip, port)
}

/// Pin `localhost` to a known loopback IP so reqwest skips Happy Eyeballs
/// (~300ms) trying the dead family on every request.
fn http_proxy_client_for(addr: SocketAddr) -> reqwest::Client {
    static CLIENTS: OnceLock<Mutex<HashMap<SocketAddr, reqwest::Client>>> = OnceLock::new();
    let cache = CLIENTS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(client) = cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&addr)
        .cloned()
    {
        return client;
    }
    let client = reqwest::Client::builder()
        .connect_timeout(DIAL_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .resolve("localhost", addr)
        .build()
        .expect("share http proxy client");
    cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(addr, client.clone());
    client
}

pub struct FrameWriter {
    stream_id: i64,
    write: Box<dyn Fn(AgentOut) -> Result<(), String> + Send + Sync>,
    sent_end: bool,
    sent_close: bool,
}

impl FrameWriter {
    pub fn new(
        stream_id: i64,
        write: impl Fn(AgentOut) -> Result<(), String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            stream_id,
            write: Box::new(write),
            sent_end: false,
            sent_close: false,
        }
    }

    pub fn end(
        &mut self,
        status: u16,
        headers: HashMap<String, Vec<String>>,
    ) -> Result<(), String> {
        self.sent_end = true;
        (self.write)(AgentOut::Json(serde_json::json!({
            "type": "end",
            "stream_id": self.stream_id,
            "status": status,
            "headers": headers,
        })))
    }

    pub fn data(&self, chunk: &[u8]) -> Result<(), String> {
        if chunk.is_empty() {
            return Ok(());
        }
        (self.write)(AgentOut::Data {
            stream_id: self.stream_id,
            chunk: chunk.to_vec(),
        })
    }

    pub fn close(&mut self) -> Result<(), String> {
        if self.sent_close {
            return Ok(());
        }
        self.sent_close = true;
        (self.write)(AgentOut::Json(serde_json::json!({
            "type": "close",
            "stream_id": self.stream_id,
        })))
    }

    pub fn has_sent_end(&self) -> bool {
        self.sent_end
    }
}

pub async fn handle_open(
    target: &str,
    open: Open,
    readers: StreamReaders,
    write: impl Fn(AgentOut) -> Result<(), String> + Send + Sync + Clone + 'static,
) {
    let mut w = FrameWriter::new(open.stream_id, write);
    let result = if open.mode == MODE_TCP {
        proxy_tcp(target, readers, &mut w).await
    } else if is_websocket(&open) {
        proxy_websocket(target, &open, readers, &mut w).await
    } else {
        proxy_http(target, &open, readers, &mut w).await
    };
    if result.is_err() && !w.has_sent_end() {
        let mut headers = HashMap::new();
        headers.insert("Content-Type".into(), vec!["text/plain".into()]);
        headers.insert("X-Zync-Error".into(), vec!["dial".into()]);
        let _ = w.end(502, headers);
        let _ = w.data(b"bad gateway");
    }
    let _ = w.close();
}

async fn proxy_http(
    target: &str,
    open: &Open,
    readers: StreamReaders,
    w: &mut FrameWriter,
) -> Result<(), String> {
    let target_url = resolve_http_loopback_url(parse_target_url(target)?).await;
    let mut req_url = target_url.clone();
    let path = if open.path.is_empty() {
        "/"
    } else {
        open.path.as_str()
    };
    req_url.set_path(path);
    req_url.set_query(if open.query.is_empty() {
        None
    } else {
        Some(open.query.as_str())
    });

    let method = if open.method.is_empty() {
        reqwest::Method::GET
    } else {
        reqwest::Method::from_bytes(open.method.as_bytes()).unwrap_or(reqwest::Method::GET)
    };

    let port = target_port(&target_url);
    let client = if is_loopback_url(&target_url) {
        if cached_loopback_host(port).is_none() {
            let _ = race_loopback_connect(port).await;
        }
        match cached_loopback_host(port) {
            Some(host) => http_proxy_client_for(loopback_socket_addr(host, port)),
            None => http_proxy_client(),
        }
    } else {
        http_proxy_client()
    };

    let no_body = method == reqwest::Method::GET
        || method == reqwest::Method::HEAD
        || method == reqwest::Method::OPTIONS;
    // Unpinned localhost client: retry GET/HEAD/OPTIONS once if a pinned
    // loopback family was stale. Streamed bodies cannot be replayed.
    let retry_builder = if no_body && is_loopback_url(&target_url) {
        Some(apply_share_http_headers(
            http_proxy_client().request(method.clone(), req_url.clone()),
            open,
            &target_url,
        ))
    } else {
        None
    };

    let mut builder =
        apply_share_http_headers(client.request(method.clone(), req_url), open, &target_url);
    if !no_body {
        let stream = futures_util::stream::unfold(readers.req_rx, |mut rx| async move {
            rx.recv()
                .await
                .map(|chunk| (Ok::<Bytes, std::io::Error>(chunk), rx))
        });
        builder = builder.body(reqwest::Body::wrap_stream(stream));
    } else {
        drop(readers.req_rx);
    }

    let resp = match builder.send().await {
        Ok(resp) => resp,
        Err(err) => {
            if !is_loopback_url(&target_url) {
                return Err(err.to_string());
            }
            forget_loopback_host(port);
            let Some(retry) = retry_builder else {
                return Err(err.to_string());
            };
            retry.send().await.map_err(|e| e.to_string())?
        }
    };
    let status = resp.status().as_u16();
    let mut headers: HashMap<String, Vec<String>> = HashMap::new();
    for (key, value) in resp.headers() {
        if hop_header(key.as_str()) {
            continue;
        }
        headers
            .entry(key.to_string())
            .or_default()
            .push(String::from_utf8_lossy(value.as_bytes()).into_owned());
    }
    w.end(status, headers)?;

    let mut body = resp.bytes_stream();
    while let Some(next) = body.next().await {
        if is_cancelled(&readers.cancel_rx) {
            break;
        }
        let chunk = next.map_err(|e| e.to_string())?;
        for piece in chunk.chunks(CHUNK_SIZE) {
            w.data(piece)?;
        }
    }
    Ok(())
}

async fn proxy_websocket(
    target: &str,
    open: &Open,
    mut readers: StreamReaders,
    w: &mut FrameWriter,
) -> Result<(), String> {
    let target_url = parse_target_url(target)?;
    let mut stream = connect_target(&target_url).await?;

    let host = localhost_http_host(&target_url);
    let path = if open.path.is_empty() {
        "/"
    } else {
        open.path.as_str()
    };
    let request_line = if open.query.is_empty() {
        format!("GET {path} HTTP/1.1\r\n")
    } else {
        format!("GET {path}?{} HTTP/1.1\r\n", open.query)
    };
    let mut req = request_line.into_bytes();
    req.extend_from_slice(format!("Host: {host}\r\n").as_bytes());
    req.extend_from_slice(b"Connection: Upgrade\r\nUpgrade: websocket\r\n");
    for (key, values) in &open.headers {
        if hop_header(key)
            || key.eq_ignore_ascii_case("Host")
            || key.eq_ignore_ascii_case("Connection")
        {
            continue;
        }
        if key.eq_ignore_ascii_case("Origin") && is_loopback_url(&target_url) {
            req.extend_from_slice(
                format!(
                    "Origin: {}\r\n",
                    loopback_origin(target_url.scheme(), &host)
                )
                .as_bytes(),
            );
            continue;
        }
        for value in values {
            req.extend_from_slice(format!("{key}: {value}\r\n").as_bytes());
        }
    }
    req.extend_from_slice(b"\r\n");
    stream.write_all(&req).await.map_err(|e| e.to_string())?;

    let (status, headers, leftover) = read_http_headers(&mut stream).await?;
    w.end(status, headers)?;
    if !leftover.is_empty() {
        w.data(&leftover)?;
    }

    let (mut read_half, mut write_half) = stream.into_split();

    // Drain the HTTP-body channel fully before post-close uplink so TYPE_DATA
    // before the first TYPE_CLOSE stays ahead of later frames.
    let uplink = async {
        write_ordered_uplink(readers.req_rx, readers.extra_rx, &mut write_half).await;
        let _ = write_half.shutdown().await;
    };
    let downlink = async {
        let mut buf = vec![0u8; CHUNK_SIZE];
        loop {
            match read_half.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if w.data(&buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
    };
    tokio::select! {
        _ = uplink => {}
        _ = downlink => {}
        _ = readers.cancel_rx.changed() => {}
    }
    Ok(())
}

async fn proxy_tcp(
    target: &str,
    mut readers: StreamReaders,
    w: &mut FrameWriter,
) -> Result<(), String> {
    let target_url = parse_target_url(target)?;
    let stream = connect_target(&target_url).await?;
    let mut headers = HashMap::new();
    headers.insert(
        "Content-Type".into(),
        vec!["application/octet-stream".into()],
    );
    w.end(200, headers)?;

    let (mut read_half, mut write_half) = stream.into_split();
    let uplink = async {
        loop {
            tokio::select! {
                chunk = readers.req_rx.recv() => {
                    match chunk {
                        Some(c) => { if write_half.write_all(&c).await.is_err() { break; } }
                        None => break,
                    }
                }
                chunk = readers.extra_rx.recv() => {
                    match chunk {
                        Some(c) => { if write_half.write_all(&c).await.is_err() { break; } }
                        None => break,
                    }
                }
            }
        }
        let _ = write_half.shutdown().await;
    };
    let downlink = async {
        let mut buf = vec![0u8; CHUNK_SIZE];
        loop {
            match read_half.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if w.data(&buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
    };
    tokio::select! {
        _ = uplink => {}
        _ = downlink => {}
        _ = readers.cancel_rx.changed() => {}
    }
    Ok(())
}

fn parse_target_url(target: &str) -> Result<url::Url, String> {
    let raw = if target.contains("://") {
        target.to_string()
    } else {
        format!("http://{target}")
    };
    let mut u = url::Url::parse(&raw).map_err(|e| e.to_string())?;
    if u.host_str().is_none() {
        return Err(format!("invalid target {target}"));
    }
    if u.scheme().is_empty() {
        let _ = u.set_scheme("http");
    }
    Ok(u)
}

fn target_port(target: &url::Url) -> u16 {
    target
        .port()
        .unwrap_or(if target.scheme() == "https" { 443 } else { 80 })
}

fn loopback_host(host: &str) -> &str {
    host.trim().trim_matches(|c| c == '[' || c == ']')
}

fn set_loopback_host(target: url::Url, host: &str) -> url::Url {
    let host = loopback_host(host);
    let port = target_port(&target);
    // Rebuild the URL. set_host("::1") fails (leading colon) and set_host("[::1]")
    // can be stored as a domain, so reqwest would not dial IPv6 loopback.
    let authority = if host.parse::<std::net::Ipv6Addr>().is_ok() {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut serialized = format!("{}://{}", target.scheme(), authority);
    let path = target.path();
    if !path.is_empty() {
        serialized.push_str(path);
    }
    if let Some(query) = target.query() {
        serialized.push('?');
        serialized.push_str(query);
    }
    url::Url::parse(&serialized).unwrap_or(target)
}

async fn try_connect(host: &str, port: u16) -> Result<TcpStream, String> {
    let host = loopback_host(host);
    tokio::time::timeout(DIAL_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .map_err(|_| "dial timeout".to_string())?
        .map_err(|e| e.to_string())
}

fn loopback_pref_cache() -> &'static Mutex<HashMap<u16, &'static str>> {
    static CACHE: OnceLock<Mutex<HashMap<u16, &'static str>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_loopback_host(port: u16) -> Option<&'static str> {
    loopback_pref_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&port)
        .copied()
}

fn remember_loopback_host(port: u16, host: &'static str) {
    loopback_pref_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(port, host);
}

fn forget_loopback_host(port: u16) {
    loopback_pref_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&port);
}

/// Race IPv4 and IPv6 so a hanging refused `127.0.0.1` on Windows (~2s) does
/// not delay `[::1]` (typical Node/Vite bind). Cache the winner per port.
async fn race_loopback_connect(port: u16) -> Result<(TcpStream, &'static str), String> {
    if let Some(host) = cached_loopback_host(port) {
        match try_connect(host, port).await {
            Ok(stream) => return Ok((stream, host)),
            Err(_) => forget_loopback_host(port),
        }
    }
    let v4 = async {
        try_connect("127.0.0.1", port)
            .await
            .map(|stream| (stream, "127.0.0.1"))
    };
    let v6 = async { try_connect("::1", port).await.map(|stream| (stream, "::1")) };
    tokio::pin!(v4, v6);
    let mut v4_err = None;
    let mut v6_err = None;
    let winner = loop {
        tokio::select! {
            result = &mut v4, if v4_err.is_none() => match result {
                Ok(pair) => break Ok(pair),
                Err(err) => v4_err = Some(err),
            },
            result = &mut v6, if v6_err.is_none() => match result {
                Ok(pair) => break Ok(pair),
                Err(err) => v6_err = Some(err),
            },
            else => break Err(v4_err.or(v6_err).unwrap_or_else(|| "dial failed".into())),
        }
    };
    if let Ok((_, host)) = &winner {
        remember_loopback_host(port, host);
    }
    winner
}

/// Dial loopback by racing `::1` and `127.0.0.1`. Do not use the `localhost`
/// name here: Windows often tries `127.0.0.1` first and stalls.
async fn connect_target(target: &url::Url) -> Result<TcpStream, String> {
    let port = target_port(target);
    if is_loopback_url(target) {
        return race_loopback_connect(port).await.map(|(stream, _)| stream);
    }
    let host = loopback_host(target.host_str().unwrap_or("localhost"));
    try_connect(host, port).await
}

/// Keep the HTTP client on the `localhost` hostname so reqwest/hyper Happy
/// Eyeballs can try `::1` and `127.0.0.1`, matching the browser and ngrok.
async fn resolve_http_loopback_url(target: url::Url) -> url::Url {
    if !is_loopback_url(&target) {
        return target;
    }
    set_loopback_host(target, "localhost")
}

fn apply_share_http_headers(
    mut builder: reqwest::RequestBuilder,
    open: &Open,
    target_url: &url::Url,
) -> reqwest::RequestBuilder {
    let loopback = is_loopback_url(target_url);
    for (key, values) in &open.headers {
        if hop_header(key) {
            continue;
        }
        if loopback && loopback_rewrite_header(key) {
            continue;
        }
        for value in values {
            builder = builder.header(key, value);
        }
    }

    let host = localhost_http_host(target_url);
    builder = builder.header("Host", &host);
    if loopback {
        if header_get(&open.headers, "Origin").is_some() {
            builder = builder.header("Origin", loopback_origin(target_url.scheme(), &host));
        }
        if let Some(referer) = header_get(&open.headers, "Referer") {
            if let Ok(mut u) = url::Url::parse(&referer) {
                let _ = u.set_scheme(if target_url.scheme().is_empty() {
                    "http"
                } else {
                    target_url.scheme()
                });
                let _ = u.set_host(Some("localhost"));
                if let Ok(port) = host.rsplit(':').next().unwrap_or("").parse::<u16>() {
                    let _ = u.set_port(Some(port));
                }
                builder = builder.header("Referer", u.as_str());
            }
        }
        builder = builder.header("X-Forwarded-Host", &host);
    }
    builder
}

fn hop_header(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "host"
            | "content-length"
            | "transfer-encoding"
            | "connection"
            | "keep-alive"
            | "te"
            | "trailers"
            | "upgrade"
            | "proxy-connection"
    )
}

fn loopback_rewrite_header(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "origin" | "referer" | "x-forwarded-host"
    )
}

pub fn localhost_http_host(target: &url::Url) -> String {
    if !is_loopback_url(target) {
        return target.host_str().unwrap_or("localhost").to_string();
    }
    let port = target
        .port()
        .unwrap_or(if target.scheme() == "https" { 443 } else { 80 });
    if (port == 80 && (target.scheme() == "http" || target.scheme().is_empty()))
        || (port == 443 && target.scheme() == "https")
    {
        "localhost".into()
    } else {
        format!("localhost:{port}")
    }
}

fn loopback_origin(scheme: &str, host: &str) -> String {
    let scheme = if scheme.is_empty() { "http" } else { scheme };
    format!("{scheme}://{host}")
}

fn is_loopback_url(target: &url::Url) -> bool {
    target.host_str().is_some_and(|host| {
        let host = loopback_host(host);
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    })
}

async fn write_ordered_uplink<W: AsyncWriteExt + Unpin>(
    mut req_rx: mpsc::Receiver<Bytes>,
    mut extra_rx: mpsc::Receiver<Bytes>,
    write: &mut W,
) {
    while let Some(chunk) = req_rx.recv().await {
        if write.write_all(&chunk).await.is_err() {
            return;
        }
    }
    while let Some(chunk) = extra_rx.recv().await {
        if write.write_all(&chunk).await.is_err() {
            return;
        }
    }
}

async fn read_http_headers(
    stream: &mut TcpStream,
) -> Result<(u16, HashMap<String, Vec<String>>, Vec<u8>), String> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    loop {
        let n = tokio::time::timeout(DIAL_TIMEOUT, stream.read(&mut tmp))
            .await
            .map_err(|_| "timed out waiting for response headers".to_string())?
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("connection closed before headers".into());
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find_double_crlf(&buf) {
            let header = std::str::from_utf8(&buf[..pos]).map_err(|e| e.to_string())?;
            let leftover = buf[pos + 4..].to_vec();
            return parse_status_headers(header, leftover);
        }
        if buf.len() > 64 * 1024 {
            return Err("response headers too large".into());
        }
    }
}

fn find_double_crlf(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_status_headers(
    header: &str,
    leftover: Vec<u8>,
) -> Result<(u16, HashMap<String, Vec<String>>, Vec<u8>), String> {
    let mut lines = header.split("\r\n");
    let status_line = lines.next().ok_or("empty response")?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(502);
    let mut headers: HashMap<String, Vec<String>> = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers
                .entry(k.trim().to_string())
                .or_default()
                .push(v.trim().to_string());
        }
    }
    Ok((status, headers, leftover))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn loopback_host_includes_port() {
        let u = url::Url::parse("http://127.0.0.1:3000").unwrap();
        assert_eq!(localhost_http_host(&u), "localhost:3000");
    }

    #[test]
    fn loopback_socket_addr_picks_family() {
        assert_eq!(
            loopback_socket_addr("::1", 9100),
            SocketAddr::from((Ipv6Addr::LOCALHOST, 9100))
        );
        assert_eq!(
            loopback_socket_addr("[::1]", 9100),
            SocketAddr::from((Ipv6Addr::LOCALHOST, 9100))
        );
        assert_eq!(
            loopback_socket_addr("127.0.0.1", 3000),
            SocketAddr::from((Ipv4Addr::LOCALHOST, 3000))
        );
    }

    #[tokio::test]
    async fn uplink_writes_req_channel_before_extra() {
        let (req_tx, req_rx) = mpsc::channel(8);
        let (extra_tx, extra_rx) = mpsc::channel(8);
        extra_tx.send(Bytes::from_static(b"B")).await.unwrap();
        req_tx.send(Bytes::from_static(b"A")).await.unwrap();
        drop(req_tx);
        drop(extra_tx);

        let mut buf = Vec::new();
        write_ordered_uplink(req_rx, extra_rx, &mut buf).await;
        assert_eq!(&buf, b"AB");
    }

    #[test]
    fn loopback_url_treats_bracketed_ipv6_as_loopback() {
        let u = url::Url::parse("http://[::1]:9100").unwrap();
        assert!(is_loopback_url(&u));
        assert_eq!(loopback_host(u.host_str().unwrap()), "::1");
    }

    #[test]
    fn set_loopback_host_switches_v4_url_to_ipv6() {
        let u = url::Url::parse("http://127.0.0.1:9100/").unwrap();
        let got = set_loopback_host(u, "::1");
        assert_eq!(got.as_str(), "http://[::1]:9100/");
        assert!(is_loopback_url(&got));
        assert_eq!(loopback_host(got.host_str().unwrap()), "::1");
        assert!(got.host().is_some_and(|h| matches!(h, url::Host::Ipv6(_))));
    }

    #[tokio::test]
    async fn connect_reaches_ipv4_listener_from_ipv6_url() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        forget_loopback_host(port);
        tokio::spawn(async move {
            let _ = listener.accept().await;
        });
        let u = url::Url::parse(&format!("http://[::1]:{port}")).unwrap();
        connect_target(&u)
            .await
            .expect("dial IPv6 loopback URL against an IPv4 localhost listener");
    }

    #[tokio::test]
    async fn resolve_http_loopback_uses_localhost_hostname() {
        let u = url::Url::parse("http://127.0.0.1:9100/").unwrap();
        let resolved = resolve_http_loopback_url(u).await;
        assert_eq!(resolved.host_str(), Some("localhost"));
        assert_eq!(resolved.port(), Some(9100));
        let v6 = url::Url::parse("http://[::1]:9100/").unwrap();
        let resolved_v6 = resolve_http_loopback_url(v6).await;
        assert_eq!(resolved_v6.host_str(), Some("localhost"));
    }

    #[tokio::test]
    async fn http_loopback_url_reaches_ipv4_listener_from_ipv6_url() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        forget_loopback_host(port);
        tokio::spawn(async move {
            loop {
                if listener.accept().await.is_err() {
                    break;
                }
            }
        });
        let u = url::Url::parse(&format!("http://[::1]:{port}")).unwrap();
        let resolved = resolve_http_loopback_url(u).await;
        connect_target(&resolved)
            .await
            .expect("HTTP loopback resolve should reach the IPv4 listener");
    }

    #[tokio::test]
    async fn loopback_race_does_not_wait_for_refused_family() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                if listener.accept().await.is_err() {
                    break;
                }
            }
        });
        forget_loopback_host(port);
        let started = std::time::Instant::now();
        race_loopback_connect(port)
            .await
            .expect("race should reach the IPv4 listener");
        assert!(
            started.elapsed() < Duration::from_millis(750),
            "loopback race took {:?}",
            started.elapsed()
        );
        assert_eq!(cached_loopback_host(port), Some("127.0.0.1"));
    }
}
