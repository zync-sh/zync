//! Private ghost binding checks use disposable in-memory SFTP transports only.

use super::*;

#[test]
fn ghost_command_futures_fit_windows_main_thread_stack() {
    const MAIN_FUTURE_BUDGET: usize = 16 * 1024;
    const LOOKUP_FUTURE_BUDGET: usize = 64 * 1024;
    const WINDOWS_MAIN_STACK: usize = 1024 * 1024;

    // The crash was in two by-value Tauri invocation/responder frames. Probe
    // equivalent moves without constructing app state or polling native I/O.
    #[inline(never)]
    fn response_frame<F>(future: std::mem::MaybeUninit<F>) {
        std::hint::black_box(&future);
    }
    #[inline(never)]
    fn invoke_frame<F>() {
        response_frame::<F>(std::mem::MaybeUninit::uninit());
    }
    fn main_future<F: std::future::Future + 'static>(name: &str) -> usize {
        let bytes = std::mem::size_of::<F>();
        assert!(
            bytes <= MAIN_FUTURE_BUDGET,
            "{name} future uses {bytes} bytes; keep IPC control state indirect"
        );
        std::thread::Builder::new()
            .name(format!("{name}-main-stack-probe"))
            .stack_size(WINDOWS_MAIN_STACK)
            .spawn(invoke_frame::<F>)
            .unwrap()
            .join()
            .expect("command layout fits the unchanged Windows main-stack budget");
        bytes
    }
    fn size1<A, F: std::future::Future>(_: impl FnOnce(A) -> F) -> usize {
        std::mem::size_of::<F>()
    }
    fn size2<A, B, F: std::future::Future>(_: impl FnOnce(A, B) -> F) -> usize {
        std::mem::size_of::<F>()
    }
    fn size3<A, B, C, F: std::future::Future>(_: impl FnOnce(A, B, C) -> F) -> usize {
        std::mem::size_of::<F>()
    }
    fn main2<A, B, F: std::future::Future + 'static>(
        name: &str,
        _: impl FnOnce(A, B) -> F,
    ) -> usize {
        main_future::<F>(name)
    }
    fn main3<A, B, C, F: std::future::Future + 'static>(
        name: &str,
        _: impl FnOnce(A, B, C) -> F,
    ) -> usize {
        main_future::<F>(name)
    }

    let command = main2("ghost_suggest_v2", crate::ghost::commands::ghost_suggest_v2);
    let engine = main3("suggest_v2", crate::ghost::suggest_engine::suggest_v2);
    let listing = main3("fs_list", fs_list);
    let lookup = size1(crate::ghost::path_suggest::path_suggestion);
    assert!(
        lookup <= LOOKUP_FUTURE_BUDGET,
        "path lookup retains {lookup} bytes of async control state"
    );
    eprintln!(
        "FUTURE_BYTES ghost_suggest_v2={command} engine={engine} fs_list={listing} \
         path_suggestion={lookup} sftp_resolver={} sftp_wrapper={}",
        size3(get_sftp_for_binding),
        size2(get_sftp_or_reconnect),
    );
}

struct SftpServer;

impl russh_sftp::server::Handler for SftpServer {
    type Error = russh_sftp::protocol::StatusCode;
    fn unimplemented(&self) -> Self::Error {
        russh_sftp::protocol::StatusCode::OpUnsupported
    }
}

async fn sftp() -> Arc<russh_sftp::client::SftpSession> {
    let (client, server) = tokio::io::duplex(16 * 1024);
    russh_sftp::server::run(server, SftpServer).await;
    Arc::new(
        tokio::time::timeout(
            Duration::from_secs(3),
            russh_sftp::client::SftpSession::new(client),
        )
        .await
        .unwrap()
        .unwrap(),
    )
}

fn connection(
    owner: Arc<Mutex<()>>,
    generation: u64,
    sftp: Arc<russh_sftp::client::SftpSession>,
) -> ConnectionHandle {
    ConnectionHandle {
        config: serde_json::from_value(serde_json::json!({
            "id":"ghost-fixture", "name":"Ghost fixture", "host":"memory.fixture.invalid", "port":22,
            "username":"fixture", "auth_method":{"type":"Password", "password":"fixture-only-secret"}
        })).unwrap(),
        session: None, sftp_session: Some(sftp), file_permission_session: "fixture".into(),
        sftp_identity_maps: Arc::new(tokio::sync::OnceCell::new()), detected_os: None, detected_kernel_os: None,
        detected_shell: None, auth_banner: None, host_key_fingerprint:"fixture-only".into(), uses_vault_auth:false,
        reconnect_generation:generation, reconnect_lock:owner,
    }
}

#[tokio::test]
async fn stale_ghost_errors_never_clear_replacement_owner_generation_or_sftp_channel() {
    let old = sftp().await;
    let replacement = sftp().await;
    let owner = Arc::new(Mutex::new(()));
    let expected = GhostConnectionIdentity::from_owner(&owner, 7);
    let registry = Mutex::new(HashMap::new());
    for (current_owner, generation, selected) in [
        (Arc::new(Mutex::new(())), 7, old.clone()),
        (owner.clone(), 8, old.clone()),
        (owner.clone(), 7, replacement.clone()),
    ] {
        registry.lock().await.insert(
            "ghost-fixture".into(),
            connection(current_owner, generation, selected.clone()),
        );
        assert!(
            clear_ghost_sftp_if_current(&registry, "ghost-fixture", &expected, &old)
                .await
                .is_err()
        );
        assert!(Arc::ptr_eq(
            registry.lock().await["ghost-fixture"]
                .sftp_session
                .as_ref()
                .unwrap(),
            &selected
        ));
    }
    registry
        .lock()
        .await
        .insert("ghost-fixture".into(), connection(owner, 7, old.clone()));
    clear_ghost_sftp_if_current(&registry, "ghost-fixture", &expected, &old)
        .await
        .unwrap();
    assert!(registry.lock().await["ghost-fixture"]
        .sftp_session
        .is_none());
    old.close().await.unwrap();
    replacement.close().await.unwrap();
}

#[tokio::test]
async fn disconnected_identity_cannot_match_a_new_connection_with_the_same_generation() {
    let channel = sftp().await;
    let owner = Arc::new(Mutex::new(()));
    let expected = GhostConnectionIdentity::from_owner(&owner, 0);
    let mut current = connection(owner.clone(), 0, channel.clone());
    assert!(expected.matches(&current));
    assert_eq!(Arc::strong_count(&owner), 2, "identity must be weak");
    current.reconnect_generation = 1;
    assert!(!expected.matches(&current));
    drop(current);
    drop(owner);
    let replacement = connection(Arc::new(Mutex::new(())), 0, channel.clone());
    assert!(!expected.matches(&replacement));
    channel.close().await.unwrap();
}
