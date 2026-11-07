//! Loopback-only SSH tests. No real host, command, credential or app window.
use super::*;
use russh::{client, server, ChannelId};
use tokio::sync::Notify;

struct TestClient;
impl client::Handler for TestClient {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        _: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

struct TestServer {
    opened: Arc<Notify>,
    allow: Arc<Notify>,
    closed: Option<oneshot::Sender<()>>,
}

impl server::Handler for TestServer {
    type Error = anyhow::Error;
    async fn auth_none(&mut self, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        _: russh::Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.opened.notify_one();
        self.allow.notified().await;
        reply.accept().await;
        Ok(())
    }
    async fn channel_close(
        &mut self,
        _: ChannelId,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if let Some(closed) = self.closed.take() {
            let _ = closed.send(());
        }
        Ok(())
    }
}

async fn setup() -> (
    Arc<tokio::sync::Mutex<Arc<client::Handle<TestClient>>>>,
    Arc<Notify>,
    Arc<Notify>,
    oneshot::Receiver<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let opened = Arc::new(Notify::new());
    let allow = Arc::new(Notify::new());
    let (closed_tx, closed_rx) = oneshot::channel();
    let handler = TestServer {
        opened: opened.clone(),
        allow: allow.clone(),
        closed: Some(closed_tx),
    };
    let config = Arc::new(server::Config {
        keys: vec![russh::keys::PrivateKey::random(
            &mut russh::keys::key::safe_rng(),
            russh::keys::Algorithm::Ed25519,
        )
        .expect("generate fixture key")],
        ..Default::default()
    });
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let running = server::run_stream(config, stream, handler).await.unwrap();
        let _ = running.await;
    });
    let mut client = client::connect(Arc::new(client::Config::default()), address, TestClient)
        .await
        .unwrap();
    assert!(client.authenticate_none("test").await.unwrap().success());
    (
        Arc::new(tokio::sync::Mutex::new(Arc::new(client))),
        opened,
        allow,
        closed_rx,
        server,
    )
}

fn reservation() -> (Arc<Reservation>, watch::Receiver<bool>) {
    let (done, receiver) = watch::channel(false);
    (
        Arc::new(Reservation {
            registry: PluginTerminals::default(),
            id: "test".into(),
            done,
        }),
        receiver,
    )
}

#[tokio::test]
async fn canceled_open_closes_the_late_real_ssh_channel() {
    let (session, opened, allow, closed, server) = setup().await;
    let (reservation, mut done) = reservation();
    let handoff = open_channel(session, reservation.clone());
    tokio::time::timeout(Duration::from_secs(3), opened.notified())
        .await
        .unwrap();
    drop(handoff);
    drop(reservation);
    assert!(!*done.borrow());
    allow.notify_one();
    tokio::time::timeout(Duration::from_secs(3), closed)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !*done.borrow_and_update() {
            done.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    server.abort();
    let _ = server.await;
}

#[tokio::test]
async fn abandoned_successful_handoff_also_closes_its_real_ssh_channel() {
    let (session, opened, allow, closed, server) = setup().await;
    let (reservation, mut done) = reservation();
    let mut handoff = open_channel(session, reservation.clone());
    tokio::time::timeout(Duration::from_secs(3), opened.notified())
        .await
        .unwrap();
    allow.notify_one();
    // try_recv transfers the owned channel without using its inner handle. This
    // exercises the guard for a successful send followed by caller abandonment.
    let result = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Ok(value) = handoff.try_recv() {
                break value;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
    .ok()
    .unwrap();
    drop(reservation);
    assert!(!*done.borrow());
    drop(result);
    tokio::time::timeout(Duration::from_secs(3), closed)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !*done.borrow_and_update() {
            done.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    server.abort();
    let _ = server.await;
}
