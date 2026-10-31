//! Runtime checks preserve the real vault guard and Tauri's multi-thread Tokio precondition.

use super::*;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::time::timeout;

const DEADLINE: Duration = Duration::from_secs(5);
const PASSPHRASE: &str = "fixture vault passphrase";

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn blocking_vault_work_keeps_runtime_live_and_preserves_queued_lock_order() {
    let directory = tempfile::tempdir().unwrap();
    let vault = Arc::new(Mutex::new(VaultService::new(directory.path().into())));
    let owner = vault.clone();
    let (started, started_rx) = tokio::sync::oneshot::channel();
    let (release, release_rx) = std::sync::mpsc::channel();
    let task = tokio::spawn(async move {
        let mut guard = owner.lock().await;
        run_vault_blocking(|| {
            let status = guard.initialize(PASSPHRASE, false).unwrap();
            assert!(matches!(status, VaultStatus::Unlocked { .. }));
            let _ = started.send(());
            // Bound fixture cleanup even if the observing task panics.
            release_rx.recv_timeout(DEADLINE).unwrap();
            guard.status().unwrap()
        })
    });
    timeout(DEADLINE, started_rx).await.unwrap().unwrap();
    assert!(!task.is_finished());
    let tick_started = Instant::now();
    let tick = tokio::spawn(async { 42 });
    assert_eq!(
        timeout(Duration::from_secs(1), tick)
            .await
            .unwrap()
            .unwrap(),
        42
    );
    assert!(
        tick_started.elapsed() < Duration::from_secs(1),
        "a runtime worker must keep servicing other tasks"
    );

    // Queue Lock before a status request while initialization still owns the mutex.
    let mut queued_lock = Box::pin(vault.lock());
    assert!(futures_util::poll!(&mut queued_lock).is_pending());
    let mut queued_status = Box::pin(vault.lock());
    assert!(futures_util::poll!(&mut queued_status).is_pending());
    task.abort();
    assert!(
        vault.try_lock().is_err(),
        "cancellation cannot release a guard in active synchronous work"
    );
    release.send(()).unwrap();
    let mut guard = timeout(DEADLINE, queued_lock).await.unwrap();
    run_vault_blocking(|| guard.lock());
    drop(guard);
    let mut guard = timeout(DEADLINE, queued_status).await.unwrap();
    let status = run_vault_blocking(|| guard.status()).unwrap();
    assert!(
        matches!(status, VaultStatus::Locked { .. }),
        "queued Lock must win over the previous unlock owner"
    );
    drop(guard);
    let _ = timeout(DEADLINE, task).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn blocking_vault_errors_preserve_codes_and_allow_serialized_retry() {
    let directory = tempfile::tempdir().unwrap();
    let vault = Mutex::new(VaultService::new(directory.path().into()));
    let mut guard = vault.lock().await;
    run_vault_blocking(|| guard.initialize(PASSPHRASE, false)).unwrap();
    guard.lock();
    let failed: VaultResult<VaultStatus> = run_vault_blocking(|| {
        guard
            .unlock("wrong fixture passphrase", false)
            .map_err(Into::into)
    });
    assert_eq!(failed.unwrap_err().code, "wrong_passphrase");
    assert!(vault.try_lock().is_err());
    assert!(matches!(
        run_vault_blocking(|| guard.status()).unwrap(),
        VaultStatus::Locked { .. }
    ));
    drop(guard);
    let mut guard = vault.lock().await;
    assert!(matches!(
        run_vault_blocking(|| guard.unlock(PASSPHRASE, false)).unwrap(),
        VaultStatus::Unlocked { .. }
    ));
    let record =
        run_vault_blocking(|| guard.item_create("fixture", "secure-note", "fixture secret", None))
            .unwrap();
    assert_eq!(
        run_vault_blocking(|| guard.item_get(&record.id))
            .unwrap()
            .secret_values[crate::vault::credential::SECRET_FIELD],
        "fixture secret"
    );
    run_vault_blocking(|| guard.item_delete(&record.id)).unwrap();
    assert!(run_vault_blocking(|| guard.item_get(&record.id)).is_err());
}
