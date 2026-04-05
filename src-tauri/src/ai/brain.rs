//! Brain — persistent session storage for agent runs.
//!
//! Each completed run is written to:
//!   {app_data_dir}/brain/{hostname}_{connection_id}/{YYYY-MM-DD_HH-mm}_{goal-slug}/
//!     meta.json        — run metadata (id, goal, model, success, timestamp)
//!     walkthrough.md   — human-readable narrative of what was done
//!     actions.json     — raw action log array

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use serde::{Deserialize, Serialize};

use crate::commands::get_data_dir;
use super::util::slugify;

// ── Types ──────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct Meta {
    #[serde(rename = "runId")]
    run_id: String,
    goal: String,
    connection: String,
    model: String,
    success: bool,
    summary: String,
    #[serde(rename = "actionCount")]
    action_count: usize,
    actions: Vec<String>,
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Write the session folder for a completed agent run.
/// Returns the absolute path to the session folder, or None if saving fails
/// (non-fatal — the agent run itself already completed).
pub fn save_session(
    app: &AppHandle,
    run_id: &str,
    goal: &str,
    connection_id: Option<&str>,
    connection_label: Option<&str>,
    model: &str,
    success: bool,
    summary: &str,
    actions: &[String],
) -> Option<PathBuf> {
    let data_dir = get_data_dir(app);
    if data_dir.as_os_str().is_empty() {
        return None;
    }
    let brain_dir = data_dir.join("brain");

    // ── Connection folder: {hostname}_{id}  or  "local" ──────────────────────
    let conn_folder = match (connection_label, connection_id) {
        (Some(label), Some(id)) => {
            let slug = slugify(label);
            format!("{}_{}", slug, id)
        }
        (None, Some(id)) => format!("local_{}", id),
        _ => "local".to_string(),
    };

    // ── Session folder: {YYYY-MM-DD_HH-mm}_{goal-slug} ───────────────────────
    let ts = format_now();
    let goal_slug = slugify(goal);
    let goal_slug = if goal_slug.is_empty() { "run".to_string() } else { goal_slug };
    let session_name = format!("{}_{}", ts, goal_slug);

    let session_dir = brain_dir.join(&conn_folder).join(&session_name);

    if let Err(e) = std::fs::create_dir_all(&session_dir) {
        eprintln!("[brain] failed to create session dir {:?}: {}", session_dir, e);
        return None;
    }

    write_meta(&session_dir, run_id, goal, connection_label, model, success, summary, actions);
    write_walkthrough(&session_dir, goal, connection_label, model, &ts, success, summary, actions);
    write_actions(&session_dir, actions);

    Some(session_dir)
}

// ── Writers ───────────────────────────────────────────────────────────────────

fn write_meta(
    dir: &Path,
    run_id: &str,
    goal: &str,
    connection: Option<&str>,
    model: &str,
    success: bool,
    summary: &str,
    actions: &[String],
) {
    let meta = Meta {
        run_id: run_id.to_string(),
        goal: goal.to_string(),
        connection: connection.unwrap_or("local").to_string(),
        model: model.to_string(),
        success,
        summary: summary.to_string(),
        action_count: actions.len(),
        actions: actions.to_vec(),
    };

    if let Ok(json) = serde_json::to_string_pretty(&meta) {
        let _ = std::fs::write(dir.join("meta.json"), json + "\n");
    }
}

fn write_walkthrough(
    dir: &Path,
    goal: &str,
    connection: Option<&str>,
    model: &str,
    timestamp: &str,
    success: bool,
    summary: &str,
    actions: &[String],
) {
    let status_icon = if success { "✓ Done" } else { "✗ Cancelled" };
    let conn_display = connection.unwrap_or("Local");
    // Convert timestamp from "YYYY-MM-DD_HH-mm" to "YYYY/MM/DD HH:mm"
    let readable_ts = if let Some((date, time)) = timestamp.split_once('_') {
        let date = date.replace('-', "/");
        let time = time.replace('-', ":");
        format!("{} {}", date, time)
    } else {
        timestamp.to_string()
    };

    let mut md = format!(
        "# {}\n\n**Connection:** {}  \n**Model:** {}  \n**Date:** {}  \n**Status:** {}\n\n",
        goal, conn_display, model, readable_ts, status_icon
    );

    if !actions.is_empty() {
        md.push_str("## Actions Taken\n\n");
        for (i, action) in actions.iter().enumerate() {
            md.push_str(&format!("{}. {}\n", i + 1, action));
        }
        md.push('\n');
    }

    if !summary.is_empty() && summary != "Done." {
        md.push_str("## Summary\n\n");
        md.push_str(summary);
        md.push('\n');
    }

    let _ = std::fs::write(dir.join("walkthrough.md"), md);
}

fn write_actions(dir: &Path, actions: &[String]) {
    let json = serde_json::to_string_pretty(actions).unwrap_or_else(|_| "[]".to_string());
    let _ = std::fs::write(dir.join("actions.json"), json + "\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Returns current UTC time as "YYYY-MM-DD_HH-mm".
/// Uses only std — no chrono dep needed.
fn format_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let (year, month, day, hour, min) = epoch_to_datetime(secs);
    format!("{:04}-{:02}-{:02}_{:02}-{:02}", year, month, day, hour, min)
}

fn epoch_to_datetime(secs: u64) -> (u32, u32, u32, u32, u32) {
    let min  = ((secs % 3600) / 60) as u32;
    let hour = ((secs % 86400) / 3600) as u32;

    let mut days = (secs / 86400) as u32;
    let mut year = 1970u32;

    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if days < days_in_year { break; }
        days -= days_in_year;
        year += 1;
    }

    let month_days: [u32; 12] = [
        31, if is_leap(year) { 29 } else { 28 },
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month = 1u32;
    for &m in &month_days {
        if days < m { break; }
        days -= m;
        month += 1;
    }

    (year, month, days + 1, hour, min)
}

fn is_leap(year: u32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_epoch_to_datetime() {
        // 2025-04-02 14:32:00 UTC  → 1743604320
        let (y, mo, d, h, m) = epoch_to_datetime(1743604320);
        assert_eq!((y, mo, d, h, m), (2025, 4, 2, 14, 32));
    }
}
