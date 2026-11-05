//! Shared immutable listings with cancellation-owned, weakly registered refreshes.

use super::FS_LIST_CACHE_TTL_MS;
use crate::commands::GhostConnectionIdentity;
use crate::fs::FileEntry;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
use tokio::sync::OnceCell;

const MAX_CACHE_ENTRIES: usize = 128;
const CACHE_TRIM_ENTRIES: usize = 112;
const MAX_CACHE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) enum BackendKey {
    Local,
    Wsl(Option<String>),
    Remote {
        id: String,
        identity: GhostConnectionIdentity,
    },
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) struct ListingKey {
    pub backend: BackendKey,
    pub path: String,
}

struct CachedEntries {
    at: Instant,
    last_used: Instant,
    bytes: usize,
    entries: Arc<[FileEntry]>,
}

#[derive(Default)]
struct CacheState {
    entries: HashMap<ListingKey, CachedEntries>,
    sweeper: Weak<()>,
}

impl CacheState {
    /// Reclaims expired values independently of cache count without extending freshness on hits.
    fn prune(&mut self, now: Instant) {
        self.entries.retain(|_, entry| {
            now.saturating_duration_since(entry.at) < Duration::from_millis(FS_LIST_CACHE_TTL_MS)
        });
    }

    /// Accounts retained payload allocations; hash buckets and allocator overhead are separate.
    fn bytes(&self) -> usize {
        self.entries
            .values()
            .fold(0usize, |total, entry| total.saturating_add(entry.bytes))
    }
}

/// Counts owned string capacities, entry storage, cache metadata and shared-allocation counters.
fn listing_bytes(key: &ListingKey, entries: &[FileEntry]) -> usize {
    let backend_bytes = match &key.backend {
        BackendKey::Local | BackendKey::Wsl(None) => 0,
        BackendKey::Wsl(Some(distro)) => distro.capacity(),
        BackendKey::Remote { id, .. } => id.capacity(),
    };
    let base = std::mem::size_of::<(ListingKey, CachedEntries)>()
        .saturating_add(2 * std::mem::size_of::<usize>())
        .saturating_add(key.path.capacity())
        .saturating_add(backend_bytes)
        .saturating_add(std::mem::size_of_val(entries));
    entries.iter().fold(base, |total, entry| {
        [
            &entry.name,
            &entry.path,
            &entry.r#type,
            &entry.permissions,
            &entry.owner,
            &entry.group,
        ]
        .iter()
        .fold(total, |bytes, value| bytes.saturating_add(value.capacity()))
    })
}

#[derive(Default)]
struct Flight {
    result: OnceCell<Result<Arc<[FileEntry]>, String>>,
}

#[derive(Default)]
pub(super) struct ListingCache {
    entries: Arc<Mutex<CacheState>>,
    flights: Mutex<HashMap<ListingKey, Weak<Flight>>>,
}

struct FlightLease<'a> {
    cache: &'a ListingCache,
    key: ListingKey,
    flight: Option<Arc<Flight>>,
}

impl ListingCache {
    /// Fences cache hits, submission and publication with the request's captured backend.
    pub(super) async fn list_if_current<C, F>(
        &self,
        key: ListingKey,
        request: impl Future<Output = Result<Vec<FileEntry>, String>>,
        current: C,
    ) -> Result<Arc<[FileEntry]>, String>
    where
        C: Fn() -> F,
        F: Future<Output = bool>,
    {
        if !current().await {
            self.invalidate(&key.backend);
            return Err("Connection changed before ghost listing".into());
        }
        let backend = key.backend.clone();
        let entries = self
            .list(key, async {
                if !current().await {
                    self.invalidate(&backend);
                    return Err("Connection changed before ghost listing".into());
                }
                let entries = request.await?;
                if !current().await {
                    self.invalidate(&backend);
                    return Err("Connection changed during ghost listing".into());
                }
                Ok(entries)
            })
            .await?;
        if !current().await {
            self.invalidate(&backend);
            return Err("Connection changed during ghost listing".into());
        }
        Ok(entries)
    }

    /// Shares a fresh immutable listing without copying its filenames or metadata.
    fn fresh(&self, key: &ListingKey) -> Option<Arc<[FileEntry]>> {
        let mut cache = self.entries.lock().ok()?;
        let now = Instant::now();
        cache.prune(now);
        let entry = cache.entries.get_mut(key)?;
        entry.last_used = now;
        Some(entry.entries.clone())
    }

    /// Removes only the rejected backend identity; replacement generations and active flights survive.
    fn invalidate(&self, backend: &BackendKey) {
        if let Ok(mut cache) = self.entries.lock() {
            cache.entries.retain(|key, _| &key.backend != backend);
        }
    }

    /// Registers callers under one lock so last-lease removal cannot race an upgrade.
    fn lease(&self, key: ListingKey) -> Result<FlightLease<'_>, String> {
        let mut flights = self.flights.lock().map_err(|e| e.to_string())?;
        let flight = flights
            .get(&key)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| {
                let flight = Arc::new(Flight::default());
                flights.insert(key.clone(), Arc::downgrade(&flight));
                flight
            });
        Ok(FlightLease {
            cache: self,
            key,
            flight: Some(flight),
        })
    }

    /// Admits complete listings within the payload/count budgets, evicting least recently used values.
    fn publish(&self, key: ListingKey, entries: Arc<[FileEntry]>) {
        let bytes = listing_bytes(&key, &entries);
        let owner = if let Ok(mut cache) = self.entries.lock() {
            let now = Instant::now();
            cache.prune(now);
            cache.entries.remove(&key);
            // Oversized results still reach every waiter, without displacing useful cached values.
            if bytes > MAX_CACHE_BYTES {
                return;
            }
            cache.entries.insert(
                key,
                CachedEntries {
                    at: now,
                    last_used: now,
                    bytes,
                    entries,
                },
            );
            let count_limit = if cache.entries.len() > MAX_CACHE_ENTRIES {
                CACHE_TRIM_ENTRIES
            } else {
                MAX_CACHE_ENTRIES
            };
            while cache.entries.len() > count_limit || cache.bytes() > MAX_CACHE_BYTES {
                let oldest = cache
                    .entries
                    .iter()
                    .min_by_key(|(_, entry)| entry.last_used)
                    .map(|(key, _)| key.clone());
                if let Some(oldest) = oldest {
                    cache.entries.remove(&oldest);
                } else {
                    break;
                }
            }
            if cache.sweeper.upgrade().is_some() {
                return;
            }
            let owner = Arc::new(());
            cache.sweeper = Arc::downgrade(&owner);
            owner
        } else {
            return;
        };
        tokio::spawn(Self::expire(Arc::downgrade(&self.entries), owner));
    }

    /// Sleeps until the earliest expiry; weak state ownership releases idle caches on disposal.
    async fn expire(state: Weak<Mutex<CacheState>>, _owner: Arc<()>) {
        loop {
            let delay = {
                let Some(state) = state.upgrade() else { return };
                let Ok(mut cache) = state.lock() else { return };
                let now = Instant::now();
                cache.prune(now);
                let delay = cache
                    .entries
                    .values()
                    .map(|entry| {
                        Duration::from_millis(FS_LIST_CACHE_TTL_MS)
                            .saturating_sub(now.saturating_duration_since(entry.at))
                    })
                    .min();
                let Some(delay) = delay else {
                    cache.sweeper = Weak::new();
                    return;
                };
                delay
            };
            tokio::time::sleep(delay).await;
        }
    }

    /// Coalesces refreshes without retaining errors or extending TTL for followers.
    pub(super) async fn list(
        &self,
        key: ListingKey,
        request: impl Future<Output = Result<Vec<FileEntry>, String>>,
    ) -> Result<Arc<[FileEntry]>, String> {
        if let Some(hit) = self.fresh(&key) {
            return Ok(hit);
        }
        let lease = self.lease(key.clone())?;
        let flight = lease.flight.as_ref().expect("a live lease owns its flight");
        let result = flight
            .result
            .get_or_init(|| async {
                // Another initializer may have published between our first lookup
                // and registering this flight.
                if let Some(hit) = self.fresh(&key) {
                    return Ok(hit);
                }
                let entries: Arc<[FileEntry]> = request.await?.into();
                self.publish(key.clone(), entries.clone());
                Ok(entries)
            })
            .await
            .clone();
        // Current waiters retain the completed result, while a later request can
        // retry an error immediately. Never detach a replacement flight.
        if let Ok(mut flights) = self.flights.lock() {
            if flights
                .get(&key)
                .is_some_and(|registered| registered.ptr_eq(&Arc::downgrade(flight)))
            {
                flights.remove(&key);
            }
        }
        result.or_else(|error| self.fresh(&key).ok_or(error))
    }
}

impl Drop for FlightLease<'_> {
    /// Removes abandoned membership even when every caller times out or is cancelled.
    fn drop(&mut self) {
        let Some(flight) = self.flight.take() else {
            return;
        };
        if let Ok(mut flights) = self.cache.flights.lock() {
            if Arc::strong_count(&flight) == 1
                && flights
                    .get(&self.key)
                    .is_some_and(|registered| registered.ptr_eq(&Arc::downgrade(&flight)))
            {
                flights.remove(&self.key);
            }
            // The decrement must happen under this lock: otherwise two concurrent
            // final drops can both observe another lease and leave dead membership.
            drop(flight);
        }
    }
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;
