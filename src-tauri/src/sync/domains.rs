#![allow(dead_code)]

use super::types::{SyncDomain, SyncResult};

/// Phase 3 scaffold: each app-data domain plugs into this adapter surface.
/// Domain implementations will own serialization, restore, and conflict identity.
pub trait SyncDomainAdapter {
    fn domain(&self) -> SyncDomain;
    fn enabled_by_default(&self) -> bool {
        true
    }
}

/// Initial registry for Phase 3 rollout ordering.
/// Implementations will be added incrementally (hosts -> tunnels -> snippets -> settings).
pub fn planned_domain_order() -> &'static [SyncDomain] {
    &[
        SyncDomain::Vault,
        SyncDomain::Hosts,
        SyncDomain::Tunnels,
        SyncDomain::Snippets,
        SyncDomain::Settings,
    ]
}

/// Validation helper used by future domain-policy wiring.
pub fn ensure_supported_domain(domain: SyncDomain) -> SyncResult<SyncDomain> {
    if planned_domain_order().contains(&domain) {
        Ok(domain)
    } else {
        Err(super::types::SyncError::new(
            "sync_domain_not_supported",
            format!("Unsupported sync domain '{}'", domain.as_str()),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planned_domain_order_starts_with_vault() {
        assert_eq!(planned_domain_order().first(), Some(&SyncDomain::Vault));
    }

    #[test]
    fn ensure_supported_domain_accepts_hosts() {
        let result = ensure_supported_domain(SyncDomain::Hosts);
        assert!(result.is_ok());
    }
}
