use super::*;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    task::JoinHandle,
};

const DUMMY_KEY: &str = "dummy-gemini-test-key";

/// Serve one response and capture the request headers for assertions.
async fn serve_once(response: String) -> (Url, JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!("http://{}/models", listener.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = BufReader::new(socket);
        let mut headers = String::new();
        loop {
            let start = headers.len();
            let n = socket.read_line(&mut headers).await.unwrap();
            if n == 0 || &headers[start..] == "\r\n" {
                break;
            }
        }
        socket
            .get_mut()
            .write_all(response.as_bytes())
            .await
            .unwrap();
        headers
    });
    (url, server)
}

#[test]
fn requests_keep_keys_in_sensitive_headers_and_preserve_endpoints() {
    for (method, url, path, query) in [
        (
            Method::GET,
            Url::parse(MODELS_ENDPOINT).unwrap(),
            "/v1beta/models",
            None,
        ),
        (
            Method::POST,
            generation_url("gemini-test", false),
            "/v1beta/models/gemini-test:generateContent",
            None,
        ),
        (
            Method::POST,
            generation_url("gemini-test", true),
            "/v1beta/models/gemini-test:streamGenerateContent",
            Some("alt=sse"),
        ),
    ] {
        let request = authenticated_request(&gemini_client(false).unwrap(), method, url, DUMMY_KEY)
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(request.url().scheme(), "https");
        assert_eq!(
            request.url().host_str(),
            Some("generativelanguage.googleapis.com")
        );
        assert_eq!(request.url().path(), path);
        assert_eq!(request.url().query(), query);
        assert_eq!(request.headers()[API_KEY_HEADER], DUMMY_KEY);
        assert!(request.headers()[API_KEY_HEADER].is_sensitive());
        assert!(!format!("{request:?}").contains(DUMMY_KEY));
    }

    let url = generation_url("gemini-test/?key=unexpected#fragment", false);
    assert!(url.query().is_none());
    assert!(url.fragment().is_none());
    assert_eq!(url.path_segments().unwrap().count(), 3);
}

#[tokio::test]
async fn authenticated_clients_stop_redirects_before_forwarding_the_header() {
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    for streaming in [false, true] {
        let (url, server) = serve_once(format!(
            "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{}/other\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            target.local_addr().unwrap()
        ))
        .await;
        let response = authenticated_request(
            &gemini_client(streaming).unwrap(),
            Method::GET,
            url,
            DUMMY_KEY,
        )
        .unwrap()
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
        let headers = server.await.unwrap();
        assert!(headers.starts_with("GET /models HTTP/1.1\r\n"));
        assert!(headers.contains(&format!("{API_KEY_HEADER}: {DUMMY_KEY}\r\n")));
    }
}

#[tokio::test]
async fn padded_keys_are_normalized_for_authentication_and_redaction() {
    let mut config = AiConfig {
        provider: "gemini".into(),
        keys: Some(std::collections::HashMap::from([(
            "gemini".into(),
            format!(" \t{DUMMY_KEY}  "),
        )])),
        ..Default::default()
    };
    let key = gemini_api_key(&config).unwrap();
    let body = format!(r#"{{"error":{{"message":"Billing error for {DUMMY_KEY}"}}}}"#);
    let (url, server) = serve_once(format!(
        "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    ))
    .await;
    let client = gemini_client(false).unwrap();
    let response = authenticated_request(&client, Method::GET, url, key)
        .unwrap()
        .send()
        .await
        .unwrap();
    let headers = server.await.unwrap();
    assert!(headers.contains(&format!("{API_KEY_HEADER}: {DUMMY_KEY}\r\n")));
    assert_eq!(
        gemini_error_detail(response, key).await,
        "Billing error for [REDACTED]"
    );

    config
        .keys
        .as_mut()
        .unwrap()
        .insert("gemini".into(), " \t ".into());
    assert!(gemini_api_key(&config).is_none());
}

#[tokio::test]
async fn broken_stream_errors_hide_request_urls() {
    let client = gemini_client(false).unwrap();
    let (url, _) = serve_once(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 100\r\nConnection: close\r\n\r\ndata: x\n\n".into(),
    )
    .await;
    let mut response = client.get(url.clone()).send().await.unwrap();
    let error = loop {
        match response.chunk().await {
            Ok(Some(_)) => continue,
            Ok(None) => panic!("truncated response should fail"),
            Err(error) => break error,
        }
    };
    let detail = error_without_url(error.with_url(url.clone()));
    assert!(!detail.contains(url.as_str()));
}
