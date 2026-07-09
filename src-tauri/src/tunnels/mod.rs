//! Tunnel subsystem — runtime engine, IPC commands, and shared helpers.
//!
//! Persistence/sync: `crate::sync::domain_tunnels`

pub mod commands;
pub mod dynamic;
pub mod manager;
pub(crate) mod session_failure;
pub(crate) mod socks5;

pub use manager::{remote_forward_map_key, tunnel_runtime_id, TunnelManager};

pub(crate) use commands::stop_tunnels_for_connections;