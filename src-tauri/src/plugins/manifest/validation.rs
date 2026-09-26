use super::{
    PluginContributions, PluginPermissionDeclarations, PluginPermissionRequest,
    PluginSurfaceContribution,
};
use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Component, Path};
use std::sync::OnceLock;

#[derive(Deserialize)]
struct PermissionCatalogEntry {
    id: String,
}

fn known_permission_ids() -> &'static HashSet<String> {
    static IDS: OnceLock<HashSet<String>> = OnceLock::new();
    IDS.get_or_init(|| {
        let entries: Vec<PermissionCatalogEntry> =
            serde_json::from_str(include_str!("../../../../plugin-api/permissions.json"))
                .expect("plugin-api/permissions.json must be valid");
        entries.into_iter().map(|entry| entry.id).collect()
    })
}

pub(super) fn is_known_permission_id(permission_id: &str) -> bool {
    known_permission_ids().contains(permission_id)
}

pub(super) fn validate_permissions(
    declarations: Option<&PluginPermissionDeclarations>,
) -> Result<()> {
    let Some(declarations) = declarations else {
        return Ok(());
    };
    let mut seen = HashSet::new();
    if declarations.required.len() + declarations.optional.len() > 64 {
        return Err(anyhow!("A plugin may declare at most 64 permissions"));
    }

    for permission in &declarations.required {
        validate_permission(permission, true, &mut seen)?;
    }
    for permission in &declarations.optional {
        validate_permission(permission, false, &mut seen)?;
    }
    Ok(())
}

fn validate_permission(
    permission: &PluginPermissionRequest,
    required: bool,
    seen: &mut HashSet<String>,
) -> Result<()> {
    validate_identifier(&permission.id, "permission id")?;
    validate_text(&permission.reason, "permission reason", 240)?;
    validate_optional_text(permission.scope.as_deref(), "permission scope", 80)?;

    if !seen.insert(permission.id.clone()) {
        return Err(anyhow!(
            "Permission {} is declared more than once",
            permission.id
        ));
    }
    if required && !is_known_permission_id(&permission.id) {
        return Err(anyhow!("Unknown required permission: {}", permission.id));
    }
    if !permission.hosts.is_empty()
        && permission.id != "network.fetch"
        && permission.id != "network.local"
    {
        return Err(anyhow!(
            "Permission {} cannot declare network hosts",
            permission.id
        ));
    }
    if permission.hosts.len() > 32 {
        return Err(anyhow!(
            "Permission {} declares too many hosts",
            permission.id
        ));
    }
    if permission.id == "network.fetch" && permission.hosts.is_empty() {
        return Err(anyhow!("network.fetch requires at least one host"));
    }
    let mut seen_hosts = HashSet::new();
    for host in &permission.hosts {
        validate_network_host(host)?;
        if !seen_hosts.insert(host.to_ascii_lowercase()) {
            return Err(anyhow!("Permission {} repeats host {host}", permission.id));
        }
    }
    Ok(())
}

pub(super) fn validate_contributions(contributions: &PluginContributions) -> Result<()> {
    if contributions.commands.len() > 128
        || contributions.pane_kinds.len() > 64
        || contributions.dashboard_cards.len() > 64
    {
        return Err(anyhow!("Plugin contribution limit exceeded"));
    }
    let mut command_ids = HashSet::new();
    for command in &contributions.commands {
        validate_identifier(&command.id, "command id")?;
        validate_text(&command.title, "command title", 120)?;
        if !command_ids.insert(&command.id) {
            return Err(anyhow!("Command {} is declared more than once", command.id));
        }
    }

    validate_surface_contributions("pane kind", &contributions.pane_kinds)?;
    validate_surface_contributions("dashboard card", &contributions.dashboard_cards)
}

pub(super) fn validate_contribution_permissions(
    contributions: &PluginContributions,
    declarations: Option<&PluginPermissionDeclarations>,
) -> Result<()> {
    let declared: HashSet<&str> = declarations
        .into_iter()
        .flat_map(|permissions| {
            permissions
                .required
                .iter()
                .chain(permissions.optional.iter())
        })
        .map(|permission| permission.id.as_str())
        .collect();

    if !contributions.commands.is_empty() && !declared.contains("ui.commands.register") {
        return Err(anyhow!(
            "Command contributions require ui.commands.register"
        ));
    }
    if !contributions.pane_kinds.is_empty() && !declared.contains("ui.pane.register") {
        return Err(anyhow!("Pane contributions require ui.pane.register"));
    }
    if !contributions.dashboard_cards.is_empty() && !declared.contains("ui.dashboard.register") {
        return Err(anyhow!(
            "Dashboard card contributions require ui.dashboard.register"
        ));
    }
    Ok(())
}

fn validate_surface_contributions(
    label: &str,
    contributions: &[PluginSurfaceContribution],
) -> Result<()> {
    let mut ids = HashSet::new();
    for contribution in contributions {
        validate_identifier(&contribution.id, &format!("{label} id"))?;
        validate_text(&contribution.title, &format!("{label} title"), 120)?;
        validate_asset_path(&contribution.entry, &format!("{label} entry"))?;
        if !ids.insert(&contribution.id) {
            return Err(anyhow!(
                "{} {} is declared more than once",
                capitalize(label),
                contribution.id
            ));
        }
    }
    Ok(())
}

fn validate_network_host(host: &str) -> Result<()> {
    if host.contains('*') && !host.starts_with("*.") {
        return Err(anyhow!("Invalid permission host: {host}"));
    }
    let normalized = host.strip_prefix("*.").unwrap_or(host);
    if normalized.is_empty()
        || normalized.contains('/')
        || normalized.contains(':')
        || normalized.contains('@')
        || normalized.parse::<std::net::IpAddr>().is_ok()
    {
        return Err(anyhow!("Invalid permission host: {host}"));
    }
    url::Host::parse(normalized).with_context(|| format!("Invalid permission host: {host}"))?;
    Ok(())
}

pub(super) fn validate_identifier(value: &str, label: &str) -> Result<()> {
    validate_text(value, label, 128)?;
    if value.starts_with('.')
        || value.ends_with('.')
        || value.contains("..")
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err(anyhow!("Invalid {label}: {value}"));
    }
    Ok(())
}

pub(super) fn validate_required_text(
    value: Option<&str>,
    label: &str,
    max_len: usize,
) -> Result<()> {
    let value = value.ok_or_else(|| anyhow!("Manifest v2 requires {label}"))?;
    validate_text(value, label, max_len)
}

pub(super) fn validate_optional_text(
    value: Option<&str>,
    label: &str,
    max_len: usize,
) -> Result<()> {
    if let Some(value) = value {
        validate_text(value, label, max_len)?;
    }
    Ok(())
}

pub(super) fn validate_optional_https_url(value: Option<&str>, label: &str) -> Result<()> {
    let Some(value) = value else {
        return Ok(());
    };
    validate_text(value, label, 2048)?;
    let parsed = url::Url::parse(value).with_context(|| format!("Invalid {label} URL"))?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() || parsed.username() != "" {
        return Err(anyhow!(
            "{label} must be an HTTPS URL without embedded credentials"
        ));
    }
    Ok(())
}

pub(super) fn validate_text(value: &str, label: &str, max_len: usize) -> Result<()> {
    let length = value.chars().count();
    if value.trim().is_empty() || length > max_len || value.chars().any(char::is_control) {
        return Err(anyhow!("Invalid {label}"));
    }
    Ok(())
}

pub(super) fn validate_optional_asset(value: Option<&str>, label: &str) -> Result<()> {
    if let Some(value) = value {
        validate_asset_path(value, label)?;
    }
    Ok(())
}

fn validate_asset_path(value: &str, label: &str) -> Result<()> {
    validate_text(value, label, 260)?;
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(anyhow!("{label} must stay inside the plugin package"));
    }
    Ok(())
}

fn capitalize(value: &str) -> String {
    let mut characters = value.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().collect::<String>() + characters.as_str(),
        None => String::new(),
    }
}
