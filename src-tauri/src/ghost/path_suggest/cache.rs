//! Shared immutable listings with cancellation-owned, weakly registered refreshes.

use super::FS_LIST_CACHE_TTL_MS;
use crate::commands::GhostConnectionIdentity;
use crate::fs::FileEntry;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
use tokio::sync::OnceCell;

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
    entries: Arc<[FileEntry]>,
}

#[derive(Default)]
struct Flight {
    result: OnceCell<Result<Arc<[FileEntry]>, String>>,
}

#[derive(Default)]
pub(super) struct ListingCache {
    entries: Mutex<HashMap<ListingKey, CachedEntries>>,
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
            return Err("Connection changed before ghost listing".into());
        }
        let entries = self
            .list(key, async {
                if !current().await {
                    return Err("Connection changed before ghost listing".into());
                }
                let entries = request.await?;
                if !current().await {
                    return Err("Connection changed during ghost listing".into());
                }
                Ok(entries)
            })
            .await?;
        if !current().await {
            return Err("Connection changed during ghost listing".into());
        }
        Ok(entries)
    }

    /// Shares a fresh immutable listing without copying its filenames or metadata.
    fn fresh(&self, key: &ListingKey) -> Option<Arc<[FileEntry]>> {
        let cache = self.entries.lock().ok()?;
        let entry = cache.get(key)?;
        (entry.at.elapsed() < Duration::from_millis(FS_LIST_CACHE_TTL_MS))
            .then(|| entry.entries.clone())
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

    /// Starts successful TTL once, preserving the existing count-based cleanup policy.
    fn publish(&self, key: ListingKey, entries: Arc<[FileEntry]>) {
        if let Ok(mut cache) = self.entries.lock() {
            cache.insert(
                key,
                CachedEntries {
                    at: Instant::now(),
                    entries,
                },
            );
            if cache.len() > 128 {
                cache.retain(|_, entry| {
                    entry.at.elapsed() < Duration::from_millis(FS_LIST_CACHE_TTL_MS)
                });
                while cache.len() > 112 {
                    if let Some(key) = cache.keys().next().cloned() {
                        cache.remove(&key);
                    } else {
                        break;
                    }
                }
            }
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
