//! Optional Linux metadata scan on the existing SSH transport. Fixed Python
//! source only; all target data travels on stdin. Unsupported servers use SFTP.
use super::{scan, Report};
use russh::{client, Channel, ChannelMsg};
use russh_sftp::client::RawSftpSession;
use serde::Deserialize;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, Weak},
};
use tokio::{
    sync::Mutex as AsyncMutex,
    time::{timeout, Duration, Instant},
};

type Session<H> = Arc<AsyncMutex<Arc<client::Handle<H>>>>;
const MAX_OUTPUT: usize = 8192;
const MAX_REQUEST: usize = 131072;
const MAX_CACHED: usize = 64;

/// Only a canonical Linux kernel probe enables exec; distro IDs are not evidence.
pub fn supports_kernel(kernel: Option<&str>) -> bool {
    kernel == Some("linux")
}

pub struct SupportCache<H: client::Handler = crate::ssh::Client> {
    // Weak owners prevent reconnects, pointer reuse or a closed session from
    // inheriting old support decisions. Only unsupported transports are cached.
    blocked: Mutex<VecDeque<Weak<AsyncMutex<Arc<client::Handle<H>>>>>>,
}

impl<H: client::Handler> Default for SupportCache<H> {
    /// Empty, connection-bound capability decisions; no persisted cache.
    fn default() -> Self {
        Self {
            blocked: Mutex::new(VecDeque::new()),
        }
    }
}

impl<H: client::Handler> SupportCache<H> {
    /// A failed/unconfirmed exec is not repeated for every folder in a listing.
    pub fn allows(&self, session: &Session<H>) -> bool {
        let mut blocked = self.blocked.lock().unwrap();
        blocked.retain(|owner| owner.strong_count() > 0);
        blocked.len() < MAX_CACHED
            && !blocked
                .iter()
                .any(|owner| owner.ptr_eq(&Arc::downgrade(session)))
    }

    /// Reserve a provisional block before opening. Never evict a live blocked
    /// transport: that could repeat an unconfirmed channel open indefinitely.
    pub fn block(&self, session: &Session<H>) -> bool {
        let mut blocked = self.blocked.lock().unwrap();
        blocked.retain(|owner| owner.strong_count() > 0);
        if blocked.len() == MAX_CACHED
            || blocked
                .iter()
                .any(|owner| owner.ptr_eq(&Arc::downgrade(session)))
        {
            return false;
        }
        blocked.push_back(Arc::downgrade(session));
        true
    }

    /// Successful execution also clears the provisional pre-open block.
    pub fn allow(&self, session: &Session<H>) {
        self.blocked
            .lock()
            .unwrap()
            .retain(|owner| !owner.ptr_eq(&Arc::downgrade(session)));
    }
}

/// Static source is shell-quoted with the existing transfer utility. Paths never
/// appear in this command; isolated Python disables startup/user-site hooks.
pub(super) fn command() -> String {
    format!(
        "exec /usr/bin/python3 -I -S -c {}",
        crate::commands::shell_quote(include_str!("remote_scan.py"))
    )
}

/// Use SFTP evidence to reject common chroot/forced-shell namespace mismatches.
/// This is consistency evidence, not confinement against a malicious SSH server.
pub async fn request(raw: &RawSftpSession, path: &str, nonce: &str) -> Option<Vec<u8>> {
    let attrs = raw.lstat(path).await.ok()?.attrs;
    if !attrs.file_type().is_dir() {
        return None;
    }
    let canonical = raw
        .realpath(path)
        .await
        .ok()?
        .files
        .into_iter()
        .next()?
        .filename;
    let home = raw
        .realpath(".")
        .await
        .ok()?
        .files
        .into_iter()
        .next()?
        .filename;
    if !canonical.starts_with('/') || !home.starts_with('/') {
        return None;
    }
    let request = serde_json::json!({
        "nonce": nonce, "path": path, "canonical": canonical, "home": home,
        "snapshot": [attrs.permissions?, attrs.size?, attrs.uid?, attrs.gid?, attrs.mtime?],
        "limits": { "entries": scan::MAX_ENTRIES, "depth": scan::MAX_DEPTH,
            "pendingBytes": scan::MAX_PENDING_BYTES, "pendingFolders": scan::MAX_PENDING_FOLDERS,
            "pathBytes": scan::MAX_PATH_BYTES, "seconds": scan::TIME_LIMIT.as_secs() }
    });
    let mut bytes = serde_json::to_vec(&request).ok()?;
    bytes.push(b'\n');
    (bytes.len() <= MAX_REQUEST).then_some(bytes)
}

/// The caller retains the channel outside its cancellable future and explicitly
/// closes it before releasing scan permits. No retry follows an uncertain scan.
pub async fn calculate<H: client::Handler + 'static>(
    session: &Session<H>,
    request: &[u8],
    nonce: &str,
    owned: &mut Option<Channel<client::Msg>>,
) -> Result<Option<Report>, String> {
    let start = Instant::now();
    let opened = timeout(Duration::from_secs(5), async {
        session.lock().await.channel_open_session().await
    })
    .await;
    // An unconfirmed channel has never received exec. The caller provisionally
    // blocks this transport, so queued folders cannot accumulate open requests.
    let channel = match opened {
        Ok(Ok(channel)) => channel,
        _ => return Ok(None),
    };
    *owned = Some(channel);
    let channel = owned.as_mut().unwrap();
    timeout(scan::TIME_LIMIT + Duration::from_secs(10), async {
        channel
            .exec(true, command())
            .await
            .map_err(|_| "Folder-size command could not start")?;
        channel
            .data(request)
            .await
            .map_err(|_| "Folder-size request could not be sent")?;
        // Keep stdin open: EOF is the remote program's cancellation signal.
        let mut output = Vec::new();
        let mut total = 0usize;
        let mut exit = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    total = bounded_total(total, data.len())?;
                    output.extend_from_slice(&data);
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    total = bounded_total(total, data.len())?;
                }
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                ChannelMsg::Failure => return Ok(None),
                ChannelMsg::ExitSignal { .. } => {
                    return Err("Folder-size command ended before returning a result".into())
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        if exit == Some(127) || (exit.is_some_and(|code| code != 0) && output.is_empty()) {
            return Ok(None); // Confirmed exit, e.g. Python missing; no scan survives.
        }
        if exit != Some(0) {
            return Err("Folder-size command completion was not confirmed".into());
        }
        if output.is_empty() {
            return Ok(None);
        } // Runtime/platform unsupported.
          // A confirmed exit cannot leave this scan running. Invalid/banner output
          // is unsupported, not a result; keep the provisional block and use SFTP.
        let Ok(mut report) = decode(&output, nonce) else {
            return Ok(None);
        };
        if let Some(report) = report.as_mut() {
            report.elapsed_ms = start.elapsed().as_millis() as u64;
        }
        Ok(report)
    })
    .await
    .map_err(|_| {
        "Folder-size command timed out; its server-side deadline remains active".to_string()
    })?
}

/// Limits stdout plus discarded stderr before retaining response bytes.
fn bounded_total(total: usize, incoming: usize) -> Result<usize, String> {
    if incoming > MAX_OUTPUT.saturating_sub(total) {
        Err("Folder-size command output exceeded its safety limit".into())
    } else {
        Ok(total + incoming)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Frame {
    protocol: u32,
    nonce: String,
    status: String,
    report: Option<WireReport>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireReport {
    bytes: String,
    entries: u64,
    files: u64,
    folders: u64,
    skipped: u64,
    errors: u64,
    complete: bool,
    reason: String,
}

/// Validate untrusted output before it can become a complete size or UI reason.
fn decode(output: &[u8], nonce: &str) -> Result<Option<Report>, String> {
    let invalid = || "Invalid folder-size command response".to_string();
    let frame: Frame = serde_json::from_slice(output).map_err(|_| invalid())?;
    if frame.protocol != 1 || frame.nonce != nonce {
        return Err(invalid());
    }
    if frame.status == "mismatch" && frame.report.is_none() {
        return Ok(None);
    }
    let value = frame.report.ok_or_else(invalid)?;
    let bytes = value.bytes.parse::<u64>().map_err(|_| invalid())?;
    if frame.status != "report"
        || value.entries > scan::MAX_ENTRIES
        || value
            .files
            .saturating_add(value.folders)
            .saturating_add(value.skipped)
            > value.entries
        || value.errors > scan::MAX_ENTRIES + scan::MAX_PENDING_FOLDERS as u64 + 1
        || value.complete != (value.reason == "finished" && value.errors == 0)
        || (value.reason == "finished" && !value.complete)
        || (value.complete && value.files + value.folders + value.skipped != value.entries)
        || (value.files == 0 && bytes != 0)
    {
        return Err(invalid());
    }
    let reason = match value.reason.as_str() {
        "finished" => "Traversal finished",
        "errors" if value.errors > 0 => {
            "Some entries were inaccessible, changed or had unavailable metadata"
        }
        "entries" => "Entry limit reached (100,000)",
        "depth" => "Depth limit reached (64)",
        "pending" => "Pending-folder limit reached (4,096)",
        "memory" => "Pending-folder memory limit reached (1 MiB of paths)",
        "path" => "Path-length safety limit reached",
        "bytes" => "Byte-total limit reached",
        "time" => "Time limit reached (30 seconds)",
        _ => return Err(invalid()),
    };
    Ok(Some(Report {
        bytes: bytes.to_string(),
        entries: value.entries,
        files: value.files,
        folders: value.folders,
        skipped: value.skipped,
        errors: value.errors,
        elapsed_ms: 0,
        complete: value.complete,
        reason: reason.into(),
    }))
}

/// EOF is observed by the fixed program; TERM/close are additional best-effort
/// cleanup on this channel only. Its independent alarm survives a lost client.
pub async fn close(owned: Option<Channel<client::Msg>>) {
    if let Some(channel) = owned {
        let _ = timeout(Duration::from_secs(1), async {
            let _ = channel.eof().await;
            let _ = channel.signal(russh::Sig::TERM).await;
            channel.close().await
        })
        .await;
    }
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod tests;
