//! Memory-only Google access tokens, serialized refresh and account-generation fences.

use super::{now_secs, sync_err, StoredTokens, SyncError, SyncResult};
use std::future::Future;
use std::sync::{Mutex, MutexGuard};

pub(super) struct AccessToken {
    value: String,
    expires_at: u64,
}

impl AccessToken {
    /// Copies only the short-lived access token; refresh credentials stay out of the cache.
    pub(super) fn from_tokens(tokens: &StoredTokens) -> SyncResult<Self> {
        Ok(Self {
            value: tokens.access_token.clone().ok_or_else(|| {
                sync_err(
                    "oauth_token_refresh_failed",
                    "No access token available after refresh.",
                )
            })?,
            expires_at: tokens.expires_at,
        })
    }
}

#[derive(Default)]
struct CachedState {
    generation: u64,
    attempt: u64,
    token: Option<AccessToken>,
    failure: Option<SyncError>,
}

#[derive(Default)]
pub(super) struct TokenCache {
    state: Mutex<CachedState>,
    pub(super) refresh: tokio::sync::Mutex<()>,
}

/// Reports a superseded operation without silently switching its connected account.
fn superseded() -> SyncError {
    sync_err(
        "provider_connection_changed",
        "Google connection changed during this operation. Please retry.",
    )
}

impl TokenCache {
    /// Recovers the small metadata state after poisoning without exposing credential values.
    fn state(&self) -> MutexGuard<'_, CachedState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Captures the account generation before beginning an interactive connection flow.
    pub(super) fn generation(&self) -> u64 {
        self.state().generation
    }

    /// Clears cached authentication and invalidates work from the previous connection.
    pub(super) fn invalidate(&self) {
        let mut state = self.state();
        state.generation = state.generation.wrapping_add(1);
        state.token = None;
        state.failure = None;
    }

    /// Starts replacement publication atomically against disconnect and other OAuth flows.
    pub(super) fn replace(&self, generation: u64) -> SyncResult<u64> {
        let mut state = self.state();
        if state.generation != generation {
            return Err(superseded());
        }
        state.generation = state.generation.wrapping_add(1);
        state.token = None;
        state.failure = None;
        Ok(state.generation)
    }

    /// Stores an accepted token only while its captured account generation is still current.
    pub(super) fn publish(&self, generation: u64, token: AccessToken) -> SyncResult<String> {
        let mut state = self.state();
        if state.generation != generation {
            return Err(superseded());
        }
        let value = token.value.clone();
        state.token = Some(token);
        state.failure = None;
        Ok(value)
    }

    /// Removes a rejected token without allowing an older 401 to evict its replacement.
    pub(super) fn reject(&self, token: &str) {
        let mut state = self.state();
        if state
            .token
            .as_ref()
            .is_some_and(|cached| cached.value == token)
        {
            state.token = None;
        }
    }

    /// Shares refresh results and errors among callers queued behind the same attempt.
    pub(super) async fn token<F, Fut>(&self, refresh: F) -> SyncResult<String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = SyncResult<AccessToken>>,
    {
        let (generation, attempt) = {
            let state = self.state();
            if let Some(token) = state
                .token
                .as_ref()
                .filter(|token| now_secs() < token.expires_at)
            {
                return Ok(token.value.clone());
            }
            (state.generation, state.attempt)
        };
        let _gate = self.refresh.lock().await;
        {
            let state = self.state();
            if state.generation != generation {
                return Err(superseded());
            }
            if let Some(token) = state
                .token
                .as_ref()
                .filter(|token| now_secs() < token.expires_at)
            {
                return Ok(token.value.clone());
            }
            if state.attempt != attempt {
                if let Some(error) = &state.failure {
                    return Err(error.clone());
                }
            }
        }
        let result = refresh().await;
        let mut state = self.state();
        if state.generation != generation {
            return Err(superseded());
        }
        state.attempt = state.attempt.wrapping_add(1);
        match result {
            Ok(token) => {
                let value = token.value.clone();
                state.token = Some(token);
                state.failure = None;
                Ok(value)
            }
            Err(error) => {
                state.token = None;
                state.failure = Some(error.clone());
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Notify;

    fn access(value: &str, expires_at: u64) -> AccessToken {
        AccessToken {
            value: value.into(),
            expires_at,
        }
    }

    #[tokio::test]
    async fn reuses_fresh_tokens_and_refreshes_expired_tokens() {
        let cache = TokenCache::default();
        let fresh = || async { Ok(access("fresh", now_secs() + 3600)) };
        assert_eq!(cache.token(fresh).await.unwrap(), "fresh");
        assert_eq!(
            cache
                .token(|| async { panic!("cache hit must skip credential loading") })
                .await
                .unwrap(),
            "fresh"
        );
        cache
            .publish(cache.generation(), access("expired", 0))
            .unwrap();
        assert_eq!(
            cache
                .token(|| async { Ok(access("replacement", now_secs() + 3600)) })
                .await
                .unwrap(),
            "replacement"
        );
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_successful_refresh() {
        let cache = TokenCache::default();
        let count = AtomicUsize::new(0);
        let release = Notify::new();
        let first = cache.token(|| async {
            count.fetch_add(1, Ordering::SeqCst);
            release.notified().await;
            Ok(access("shared", now_secs() + 3600))
        });
        tokio::pin!(first);
        assert!(futures_util::poll!(&mut first).is_pending());
        let mut waiting = Vec::new();
        for _ in 0..8 {
            let mut call = Box::pin(cache.token(|| async {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(access("duplicate", now_secs() + 3600))
            }));
            assert!(futures_util::poll!(&mut call).is_pending());
            waiting.push(call);
        }
        release.notify_one();
        assert_eq!(first.await.unwrap(), "shared");
        for call in waiting {
            assert_eq!(call.await.unwrap(), "shared");
        }
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn concurrent_refresh_failure_is_shared_but_a_new_attempt_can_retry() {
        let cache = TokenCache::default();
        let release = Notify::new();
        let first = cache.token(|| async {
            release.notified().await;
            Err(sync_err("oauth_token_refresh_failed", "fixture refusal"))
        });
        tokio::pin!(first);
        assert!(futures_util::poll!(&mut first).is_pending());
        let waiting = cache.token(|| async { panic!("queued caller must share failure") });
        tokio::pin!(waiting);
        assert!(futures_util::poll!(&mut waiting).is_pending());
        release.notify_one();
        assert_eq!(first.await.unwrap_err().code, "oauth_token_refresh_failed");
        assert_eq!(
            waiting.await.unwrap_err().code,
            "oauth_token_refresh_failed"
        );
        assert_eq!(
            cache
                .token(|| async { Ok(access("retry", now_secs() + 3600)) })
                .await
                .unwrap(),
            "retry"
        );
    }

    #[tokio::test]
    async fn disconnect_fences_in_flight_refresh_and_waiters() {
        let cache = TokenCache::default();
        let release = Notify::new();
        let first = cache.token(|| async {
            release.notified().await;
            Ok(access("old account", now_secs() + 3600))
        });
        tokio::pin!(first);
        assert!(futures_util::poll!(&mut first).is_pending());
        let waiting =
            cache.token(|| async { panic!("old waiter must not reload a different account") });
        tokio::pin!(waiting);
        assert!(futures_util::poll!(&mut waiting).is_pending());
        cache.invalidate();
        release.notify_one();
        assert_eq!(first.await.unwrap_err().code, "provider_connection_changed");
        assert_eq!(
            waiting.await.unwrap_err().code,
            "provider_connection_changed"
        );
        assert!(cache.state().token.is_none());
        let generation = cache.replace(cache.generation()).unwrap();
        cache
            .publish(generation, access("new account", now_secs() + 3600))
            .unwrap();
        assert_eq!(
            cache
                .token(|| async { panic!("new account is cached") })
                .await
                .unwrap(),
            "new account"
        );
    }

    #[tokio::test]
    async fn disconnect_clears_refresh_published_after_its_initial_fence() {
        let cache = TokenCache::default();
        cache.invalidate();
        // This caller begins after disconnect's initial fence and wins the gate.
        assert_eq!(
            cache
                .token(|| async { Ok(access("intervening refresh", now_secs() + 3600)) })
                .await
                .unwrap(),
            "intervening refresh"
        );
        {
            let _gate = cache.refresh.lock().await;
            // Disconnect re-fences while owning the gate before deleting credentials.
            cache.invalidate();
        }
        let result = cache
            .token(|| async {
                Err(sync_err(
                    "provider_not_connected",
                    "fixture credentials deleted",
                ))
            })
            .await;
        assert_eq!(result.unwrap_err().code, "provider_not_connected");
    }

    #[test]
    fn stale_connect_and_old_unauthorized_responses_cannot_replace_new_account() {
        let cache = TokenCache::default();
        let old_generation = cache.generation();
        let generation = cache.replace(old_generation).unwrap();
        cache
            .publish(generation, access("new", now_secs() + 3600))
            .unwrap();
        assert!(cache.replace(old_generation).is_err());
        assert!(cache
            .publish(old_generation, access("old", now_secs() + 3600))
            .is_err());
        cache.reject("old");
        assert_eq!(cache.state().token.as_ref().unwrap().value, "new");
        cache.reject("new");
        assert!(cache.state().token.is_none());
    }

    #[tokio::test]
    async fn dropped_refresh_releases_gate_for_a_retry() {
        let cache = TokenCache::default();
        let mut first = Box::pin(cache.token(|| async { std::future::pending().await }));
        assert!(futures_util::poll!(&mut first).is_pending());
        drop(first);
        assert_eq!(
            cache
                .token(|| async { Ok(access("retry", now_secs() + 3600)) })
                .await
                .unwrap(),
            "retry"
        );
    }
}
