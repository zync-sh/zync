use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

fn key(path: &str) -> ListingKey {
    ListingKey {
        backend: BackendKey::Local,
        path: path.into(),
    }
}

fn entries(name: &str) -> Vec<FileEntry> {
    vec![FileEntry {
        name: name.into(),
        path: name.into(),
        r#type: "file".into(),
        size: 0,
        last_modified: 0,
        permissions: String::new(),
        owner: String::new(),
        group: String::new(),
    }]
}

#[tokio::test]
async fn expired_values_are_reclaimed_on_access_even_below_the_count_limit() {
    let cache = ListingCache::default();
    let old: Arc<[FileEntry]> = entries("old").into();
    let retained = Arc::downgrade(&old);
    cache.publish(key("expired"), old);
    cache
        .entries
        .lock()
        .unwrap()
        .entries
        .get_mut(&key("expired"))
        .unwrap()
        .at = Instant::now() - Duration::from_millis(FS_LIST_CACHE_TTL_MS + 1);
    assert!(cache.fresh(&key("unrelated")).is_none());
    assert!(retained.upgrade().is_none());
    assert_eq!(cache.entries.lock().unwrap().bytes(), 0);
}

#[tokio::test]
async fn idle_expiry_releases_payload_and_restarts_for_a_later_listing() {
    let cache = ListingCache::default();
    let listing: Arc<[FileEntry]> = entries("idle").into();
    let retained = Arc::downgrade(&listing);
    cache.publish(key("idle"), listing);
    let first_worker = cache.entries.lock().unwrap().sweeper.clone();
    // Observe only the weak payload; no cache lookup or publication can trigger pruning.
    tokio::time::timeout(Duration::from_millis(FS_LIST_CACHE_TTL_MS + 2000), async {
        while retained.upgrade().is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(cache.entries.lock().unwrap().entries.is_empty());
    cache.publish(key("later"), entries("later").into());
    let later_worker = cache.entries.lock().unwrap().sweeper.clone();
    assert!(later_worker.upgrade().is_some());
    assert!(!first_worker.ptr_eq(&later_worker));
}

#[tokio::test]
async fn payload_budget_counts_string_capacity_and_evicts_least_recently_used() {
    let cache = ListingCache::default();
    for path in ["first", "second"] {
        let mut rows = entries(path);
        rows[0].name.reserve_exact(MAX_CACHE_BYTES / 3);
        cache.publish(key(path), rows.into());
    }
    let evicted = {
        let mut cache = cache.entries.lock().unwrap();
        cache.entries.get_mut(&key("second")).unwrap().last_used =
            Instant::now() - Duration::from_millis(10);
        Arc::downgrade(&cache.entries[&key("second")].entries)
    };
    assert!(cache.fresh(&key("first")).is_some());
    let mut rows = entries("third");
    rows[0].name.reserve_exact(MAX_CACHE_BYTES / 3);
    cache.publish(key("third"), rows.into());
    let state = cache.entries.lock().unwrap();
    assert!(state.bytes() <= MAX_CACHE_BYTES);
    assert_eq!(state.entries.len(), 2);
    assert!(state.entries.contains_key(&key("first")));
    assert!(state.entries.contains_key(&key("third")));
    assert!(evicted.upgrade().is_none());
}

#[tokio::test]
async fn oversized_results_remain_complete_and_shared_without_evicting_cached_results() {
    let cache = ListingCache::default();
    cache.publish(key("small"), entries("small").into());
    let count = MAX_CACHE_BYTES / std::mem::size_of::<FileEntry>() + 1;
    let release = tokio::sync::Notify::new();
    let mut first = Box::pin(cache.list(key("large"), async {
        release.notified().await;
        Ok(vec![entries("complete").pop().unwrap(); count])
    }));
    let mut follower = Box::pin(cache.list(key("large"), async {
        panic!("oversized concurrent results must still share acquisition")
    }));
    assert!(futures_util::poll!(&mut first).is_pending());
    assert!(futures_util::poll!(&mut follower).is_pending());
    release.notify_one();
    let first = first.await.unwrap();
    let follower = follower.await.unwrap();
    assert_eq!(first.len(), count);
    assert_eq!(first.last().unwrap().name, "complete");
    assert!(Arc::ptr_eq(&first, &follower));
    assert!(!cache
        .entries
        .lock()
        .unwrap()
        .entries
        .contains_key(&key("large")));
    assert!(cache.fresh(&key("small")).is_some());
    assert_eq!(
        cache
            .list(key("large"), async { Ok(entries("reread")) })
            .await
            .unwrap()[0]
            .name,
        "reread"
    );
}

#[tokio::test]
async fn rejected_remote_generation_releases_all_its_paths_without_touching_replacement_or_flights()
{
    let cache = ListingCache::default();
    let owner = Arc::new(tokio::sync::Mutex::new(()));
    let remote = |generation| BackendKey::Remote {
        id: "host".into(),
        identity: GhostConnectionIdentity::from_owner(&owner, generation),
    };
    let old = ListingKey {
        backend: remote(0),
        path: "one".into(),
    };
    let other = ListingKey {
        backend: remote(0),
        path: "two".into(),
    };
    let replacement = ListingKey {
        backend: remote(1),
        path: "one".into(),
    };
    cache.publish(old.clone(), entries("old").into());
    cache.publish(other.clone(), entries("other").into());
    cache.publish(replacement.clone(), entries("replacement").into());
    let lease = cache.lease(old.clone()).unwrap();
    assert!(cache
        .list_if_current(
            old.clone(),
            async { panic!("rejected binding must not issue I/O") },
            || async { false }
        )
        .await
        .is_err());
    let state = cache.entries.lock().unwrap();
    assert!(!state.entries.contains_key(&old));
    assert!(!state.entries.contains_key(&other));
    assert!(state.entries.contains_key(&replacement));
    assert_eq!(cache.flights.lock().unwrap().len(), 1);
    drop(state);
    drop(lease);
}

#[tokio::test]
async fn one_expiry_worker_uses_weak_cache_ownership() {
    let cache = ListingCache::default();
    cache.publish(key("first"), entries("first").into());
    let worker = cache.entries.lock().unwrap().sweeper.clone();
    cache.publish(key("second"), entries("second").into());
    assert!(worker.ptr_eq(&cache.entries.lock().unwrap().sweeper));
    let state = Arc::downgrade(&cache.entries);
    assert_eq!(Arc::strong_count(&cache.entries), 1);
    drop(cache);
    assert!(state.upgrade().is_none());
}

#[tokio::test]
async fn concurrent_misses_share_one_request_and_immutable_result_without_extending_ttl() {
    let cache = ListingCache::default();
    let calls = AtomicUsize::new(0);
    let release = tokio::sync::Notify::new();
    let first = cache.list(key("same"), async {
        calls.fetch_add(1, Ordering::SeqCst);
        release.notified().await;
        Ok(entries("shared"))
    });
    let second = cache.list(key("same"), async {
        panic!("a concurrent follower must not issue I/O")
    });
    tokio::pin!(first, second);
    assert!(futures_util::poll!(&mut first).is_pending());
    assert!(futures_util::poll!(&mut second).is_pending());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    release.notify_one();
    let first = first.await.unwrap();
    let at = cache.entries.lock().unwrap().entries[&key("same")].at;
    let second = second.await.unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(cache.entries.lock().unwrap().entries[&key("same")].at, at);
    assert!(cache.flights.lock().unwrap().is_empty());
    let hit = cache
        .list(key("same"), async { panic!("fresh hit must avoid I/O") })
        .await
        .unwrap();
    assert!(Arc::ptr_eq(&first, &hit));
}

#[tokio::test]
async fn cancelled_initializer_allows_waiter_takeover_and_last_cancel_removes_membership() {
    let cache = ListingCache::default();
    let mut first = Box::pin(cache.list(key("same"), std::future::pending()));
    let mut second = Box::pin(cache.list(key("same"), async { Ok(entries("takeover")) }));
    assert!(futures_util::poll!(&mut first).is_pending());
    assert!(futures_util::poll!(&mut second).is_pending());
    drop(first);
    assert_eq!(second.await.unwrap()[0].name, "takeover");
    assert!(cache.flights.lock().unwrap().is_empty());

    let mut first = Box::pin(cache.list(key("abandoned"), std::future::pending()));
    let mut second = Box::pin(cache.list(key("abandoned"), std::future::pending()));
    assert!(futures_util::poll!(&mut first).is_pending());
    assert!(futures_util::poll!(&mut second).is_pending());
    drop(first);
    assert_eq!(cache.flights.lock().unwrap().len(), 1);
    drop(second);
    assert!(cache.flights.lock().unwrap().is_empty());
}

#[test]
fn simultaneous_final_lease_drops_remove_the_registered_flight() {
    let cache = ListingCache::default();
    for _ in 0..40 {
        let first = cache.lease(key("drop")).unwrap();
        let second = cache.lease(key("drop")).unwrap();
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                barrier.wait();
                drop(first);
            });
            scope.spawn(|| {
                barrier.wait();
                drop(second);
            });
        });
        assert!(cache.flights.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn waiting_for_another_initializer_is_part_of_each_callers_deadline() {
    let cache = ListingCache::default();
    let mut first = Box::pin(cache.list(key("slow"), std::future::pending()));
    assert!(futures_util::poll!(&mut first).is_pending());
    let timed_out = tokio::time::timeout(
        Duration::from_millis(10),
        cache.list(key("slow"), async {
            panic!("waiting behind live I/O must not submit duplicate I/O")
        }),
    )
    .await;
    assert!(timed_out.is_err());
    assert_eq!(cache.flights.lock().unwrap().len(), 1);
    drop(first);
    assert!(cache.flights.lock().unwrap().is_empty());
}

#[tokio::test]
async fn expired_success_is_not_error_evidence_and_errors_are_immediately_retryable() {
    let cache = ListingCache::default();
    let listing = key("expired");
    cache.publish(listing.clone(), entries("old").into());
    cache
        .entries
        .lock()
        .unwrap()
        .entries
        .get_mut(&listing)
        .unwrap()
        .at = Instant::now() - Duration::from_millis(FS_LIST_CACHE_TTL_MS + 1);
    assert_eq!(
        cache
            .list(listing.clone(), async { Err("session closed".into()) })
            .await
            .unwrap_err(),
        "session closed"
    );
    assert!(cache.flights.lock().unwrap().is_empty());
    assert_eq!(
        cache
            .list(listing, async { Ok(entries("new")) })
            .await
            .unwrap()[0]
            .name,
        "new"
    );
    let empty = cache
        .list(key("empty"), async { Ok(Vec::new()) })
        .await
        .unwrap();
    assert!(empty.is_empty());
}

#[tokio::test]
async fn failed_request_uses_only_a_fresh_concurrently_published_success() {
    let cache = ListingCache::default();
    let entries = cache
        .list(key("concurrent"), async {
            cache.publish(key("concurrent"), entries("fresh").into());
            Err("failed".into())
        })
        .await
        .unwrap();
    assert_eq!(entries[0].name, "fresh");
}

#[tokio::test]
async fn backend_paths_distro_choices_and_actual_remote_owners_never_share_entries() {
    let cache = ListingCache::default();
    let owner = Arc::new(tokio::sync::Mutex::new(()));
    let replacement = Arc::new(tokio::sync::Mutex::new(()));
    let remote = |owner: &Arc<tokio::sync::Mutex<()>>, generation| BackendKey::Remote {
        id: "host::id".into(),
        identity: GhostConnectionIdentity::from_owner(owner, generation),
    };
    let keys = [
        key("same"),
        key("other"),
        ListingKey {
            backend: BackendKey::Wsl(None),
            path: "same".into(),
        },
        ListingKey {
            backend: BackendKey::Wsl(Some("default".into())),
            path: "same".into(),
        },
        ListingKey {
            backend: remote(&owner, 0),
            path: "same".into(),
        },
        ListingKey {
            backend: remote(&owner, 1),
            path: "same".into(),
        },
        ListingKey {
            backend: remote(&replacement, 0),
            path: "same".into(),
        },
    ];
    for (index, key) in keys.iter().enumerate() {
        let name = index.to_string();
        assert_eq!(
            cache
                .list(key.clone(), async { Ok(entries(&name)) })
                .await
                .unwrap()[0]
                .name,
            name
        );
    }
    assert_eq!(cache.entries.lock().unwrap().entries.len(), keys.len());
    assert_eq!(
        Arc::strong_count(&owner),
        1,
        "retained keys must not own connection lifetime"
    );
}

#[tokio::test]
async fn count_cleanup_keeps_existing_bounds_and_never_evicts_an_active_flight() {
    let cache = ListingCache::default();
    let lease = cache.lease(key("active")).unwrap();
    for index in 0..129 {
        cache.publish(key(&index.to_string()), entries("file").into());
    }
    assert_eq!(
        cache.entries.lock().unwrap().entries.len(),
        CACHE_TRIM_ENTRIES
    );
    assert_eq!(cache.flights.lock().unwrap().len(), 1);
    drop(lease);
    assert!(cache.flights.lock().unwrap().is_empty());
}

#[tokio::test]
async fn changed_binding_rejects_cache_hits_and_never_submits_or_publishes_old_work() {
    let cache = ListingCache::default();
    let current = AtomicBool::new(false);
    let check = || async { current.load(Ordering::SeqCst) };
    let calls = AtomicUsize::new(0);
    assert!(cache
        .list_if_current(
            key("old"),
            async {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(entries("unexpected"))
            },
            check
        )
        .await
        .is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    cache.publish(key("cached"), entries("previous-generation").into());
    assert!(cache
        .list_if_current(
            key("cached"),
            async { panic!("no I/O on cache hit") },
            check
        )
        .await
        .is_err());
    current.store(true, Ordering::SeqCst);
    assert!(cache
        .list_if_current(
            key("late"),
            async {
                current.store(false, Ordering::SeqCst);
                Ok(entries("late-old-result"))
            },
            check
        )
        .await
        .is_err());
    assert!(!cache
        .entries
        .lock()
        .unwrap()
        .entries
        .contains_key(&key("late")));

    // A follower can resume only after another caller's old work completed.
    current.store(true, Ordering::SeqCst);
    let release = tokio::sync::Notify::new();
    let mut first = Box::pin(cache.list_if_current(
        key("follower"),
        async {
            release.notified().await;
            Ok(entries("finished"))
        },
        check,
    ));
    let mut follower = Box::pin(cache.list_if_current(
        key("follower"),
        async { panic!("follower must share initialized result") },
        check,
    ));
    assert!(futures_util::poll!(&mut first).is_pending());
    assert!(futures_util::poll!(&mut follower).is_pending());
    release.notify_one();
    first.await.unwrap();
    current.store(false, Ordering::SeqCst);
    assert!(follower.await.is_err());
}
