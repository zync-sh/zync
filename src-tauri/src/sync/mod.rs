/// Sync module layout:
/// - `provider` defines the provider contract (trait + shared validation).
/// - `providers` contains concrete provider implementations (e.g., Google).
pub mod collection;
pub mod commands;
pub mod profiles;
pub mod provider;
pub mod providers;
pub mod types;
