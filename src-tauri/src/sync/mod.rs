/// Sync module layout:
/// - `provider` defines the provider contract (trait + shared validation).
/// - `providers` contains concrete provider implementations (e.g., Google).
pub mod collection;
pub mod commands;
pub mod domain_hosts;
pub mod domain_settings;
pub mod domain_snippets;
pub mod domain_tunnels;
pub mod domains;
pub mod profiles;
pub mod provider;
pub mod providers;
pub mod types;
