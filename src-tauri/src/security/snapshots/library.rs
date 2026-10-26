//! Explicit, bounded report history. Metadata and report bytes commit in the same local transaction.
use super::{current_time, decode_package, encode_package, ReportPackage, SnapshotSubject};
use redb::{Database, ReadableTable, ReadableTableMetadata, TableDefinition};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
};

const REPORTS: TableDefinition<&str, &[u8]> = TableDefinition::new("security_reports_v1");
const INDEX: TableDefinition<&str, &[u8]> = TableDefinition::new("security_report_index_v1");
const MAX_RECORDS: u64 = 50;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
const MAX_INDEX_BYTES: usize = 4096;

pub(crate) mod risks;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub name: String,
    pub revision: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub completed_at: u64,
    pub host: String,
    pub username: String,
    pub port: u16,
    pub fingerprint: Option<String>,
    pub baseline: String,
    pub findings: usize,
    pub attention: usize,
    pub bytes: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Revision {
    id: String,
    revision: u64,
}

#[derive(Serialize)]
pub struct SavedReport {
    pub summary: Summary,
    #[serde(flatten)]
    pub package: ReportPackage,
}

pub struct ReportLibrary {
    path: PathBuf,
    database: OnceLock<Result<Arc<Database>, String>>,
}

impl ReportLibrary {
    /// The library follows the existing redb journal pattern and opens only on an explicit history action.
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            database: OnceLock::new(),
        }
    }

    /// All database work occurs on blocking workers; corrupt history is never silently discarded.
    fn database(&self) -> Result<Arc<Database>, String> {
        self.database
            .get_or_init(|| {
                let parent = self
                    .path
                    .parent()
                    .ok_or("Invalid report storage location.")?;
                std::fs::create_dir_all(parent).map_err(|_| "Could not create report storage.")?;
                // The library needs a small bounded cache, not redb's default 1 GiB allowance.
                let database = Database::builder()
                    .set_cache_size(8 * 1024 * 1024)
                    .create(&self.path)
                    .map_err(|_| "Saved reports could not be opened.")?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))
                        .map_err(|_| "Could not protect report storage.")?;
                }
                let tx = database.begin_write().map_err(storage_error)?;
                tx.open_table(REPORTS).map_err(storage_error)?;
                tx.open_table(INDEX).map_err(storage_error)?;
                risks::initialize(&tx)?;
                tx.commit().map_err(storage_error)?;
                Ok(Arc::new(database))
            })
            .clone()
    }

    /// List small summaries, not report bodies, so browsing history does not retain every finding in memory.
    fn list(&self, subject: &SnapshotSubject) -> Result<Vec<Summary>, String> {
        self.list_matching(Some(subject))
    }

    /// Global history uses the same bounded metadata index and never expands report bodies or risk notes.
    fn list_all(&self) -> Result<Vec<Summary>, String> {
        self.list_matching(None)
    }

    /// Optional endpoint/account filtering does not weaken the required scope of load or delete operations.
    fn list_matching(&self, subject: Option<&SnapshotSubject>) -> Result<Vec<Summary>, String> {
        let database = self.database()?;
        let tx = database.begin_read().map_err(storage_error)?;
        let table = tx.open_table(INDEX).map_err(storage_error)?;
        if table.len().map_err(storage_error)? > MAX_RECORDS {
            return Err("Saved report history exceeds its limit.".into());
        }
        let mut rows = Vec::new();
        for row in table.iter().map_err(storage_error)? {
            let (_, value) = row.map_err(storage_error)?;
            let item = decode_summary(value.value())?;
            if subject.is_none_or(|subject| same_subject(&item, subject)) {
                rows.push(item);
            }
        }
        rows.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(rows)
    }

    /// Fetch one validated report; no SSH operation is involved, including while disconnected.
    fn load(&self, id: &str, subject: &SnapshotSubject) -> Result<SavedReport, String> {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid saved report ID.")?;
        let database = self.database()?;
        let tx = database.begin_read().map_err(storage_error)?;
        let index = tx.open_table(INDEX).map_err(storage_error)?;
        let summary = index
            .get(id)
            .map_err(storage_error)?
            .ok_or("This saved report no longer exists.")?;
        let summary = decode_summary(summary.value())?;
        if !same_subject(&summary, subject) {
            return Err("Choose a report for this host and account.".into());
        }
        let reports = tx.open_table(REPORTS).map_err(storage_error)?;
        let body = reports
            .get(id)
            .map_err(storage_error)?
            .ok_or("The saved report is incomplete.")?;
        let package = decode_package(body.value(), current_time()?)?;
        if !same_subject(&summary, &package.result.subject)
            || summary.fingerprint != package.result.report.transport_fingerprint
        {
            return Err("The saved report identity is inconsistent.".into());
        }
        Ok(SavedReport { summary, package })
    }

    /// Save explicitly with optimistic replacement; another pane's changes cannot be overwritten silently.
    fn save(
        &self,
        payload: &str,
        name: &str,
        replace: Option<Revision>,
    ) -> Result<Summary, String> {
        let now = current_time()?;
        let package = decode_package(payload.as_bytes(), now)?;
        let name = super::report::text(name.trim(), 81);
        if name.trim().is_empty() || name.chars().count() > 80 {
            return Err("Use a report name between 1 and 80 characters.".into());
        }
        let body = encode_package(&package)?;
        if body.len() > super::MAX_REPORT_BYTES + super::MAX_ANNOTATION_BYTES {
            return Err("The normalized report exceeds the save limit.".into());
        }
        let database = self.database()?;
        let tx = database.begin_write().map_err(storage_error)?;
        let mut index = tx.open_table(INDEX).map_err(storage_error)?;
        let previous = if let Some(replace) = replace.as_ref() {
            let saved = index
                .get(replace.id.as_str())
                .map_err(storage_error)?
                .ok_or("The report was deleted. Save as new instead.")?;
            let saved = decode_summary(saved.value())?;
            if saved.revision != replace.revision {
                return Err(
                    "This report changed in another pane. Reopen it before replacing it.".into(),
                );
            }
            if !same_subject(&saved, &package.result.subject)
                || saved.fingerprint != package.result.report.transport_fingerprint
            {
                return Err("A replacement must belong to the same SSH host and account.".into());
            }
            Some(saved)
        } else {
            None
        };
        let mut total = 0u64;
        if index.len().map_err(storage_error)? > MAX_RECORDS {
            return Err("Saved report history exceeds its limit.".into());
        }
        for row in index.iter().map_err(storage_error)? {
            let (_, value) = row.map_err(storage_error)?;
            total = total
                .checked_add(decode_summary(value.value())?.bytes)
                .ok_or("Invalid storage size.")?;
        }
        if previous.is_none() && index.len().map_err(storage_error)? >= MAX_RECORDS
            || total
                .saturating_sub(previous.as_ref().map_or(0, |item| item.bytes))
                .saturating_add(body.len() as u64)
                > MAX_BYTES
        {
            return Err("Report storage is full (50 reports or 64 MiB). Delete a saved report or replace one.".into());
        }
        let summary = Summary {
            id: previous
                .as_ref()
                .map_or_else(|| uuid::Uuid::new_v4().to_string(), |item| item.id.clone()),
            name,
            revision: previous
                .as_ref()
                .map_or(1, |item| item.revision.saturating_add(1)),
            created_at: previous.as_ref().map_or(now, |item| item.created_at),
            updated_at: now,
            completed_at: package.result.completed_at,
            host: package.result.subject.host.clone(),
            username: package.result.subject.username.clone(),
            port: package.result.subject.port,
            fingerprint: package.result.report.transport_fingerprint.clone(),
            baseline: package.result.report.version.clone(),
            findings: package.result.report.findings.len(),
            attention: package
                .result
                .report
                .findings
                .iter()
                .filter(|finding| finding.status == "attention")
                .count(),
            bytes: body.len() as u64,
        };
        let metadata = serde_json::to_vec(&summary).map_err(storage_error)?;
        index
            .insert(summary.id.as_str(), metadata.as_slice())
            .map_err(storage_error)?;
        let mut reports = tx.open_table(REPORTS).map_err(storage_error)?;
        reports
            .insert(summary.id.as_str(), body.as_slice())
            .map_err(storage_error)?;
        drop(reports);
        drop(index);
        tx.commit().map_err(storage_error)?;
        Ok(summary)
    }

    /// Deletion is explicit and revision-checked; report bytes and index disappear atomically.
    fn delete(&self, revision: Revision, subject: &SnapshotSubject) -> Result<(), String> {
        self.delete_with_risks(revision, subject, Vec::new())
    }

    /// Preserve independent acceptances unless their exact selected revisions are explicitly removed.
    fn delete_with_risks(
        &self,
        revision: Revision,
        subject: &SnapshotSubject,
        risk_revisions: Vec<Revision>,
    ) -> Result<(), String> {
        let database = self.database()?;
        risks::migrate(&database)?;
        let tx = database.begin_write().map_err(storage_error)?;
        let mut index = tx.open_table(INDEX).map_err(storage_error)?;
        let saved = {
            let entry = index
                .get(revision.id.as_str())
                .map_err(storage_error)?
                .ok_or("This report was already deleted.")?;
            decode_summary(entry.value())?
        };
        if saved.revision != revision.revision || !same_subject(&saved, subject) {
            return Err("This report changed. Refresh saved reports before deleting it.".into());
        }
        if !risk_revisions.is_empty() {
            let reports = tx.open_table(REPORTS).map_err(storage_error)?;
            let body = reports
                .get(revision.id.as_str())
                .map_err(storage_error)?
                .ok_or("The saved report is incomplete.")?;
            let package = decode_package(body.value(), current_time()?)?;
            if !same_subject(&saved, &package.result.subject)
                || saved.fingerprint != package.result.report.transport_fingerprint
            {
                return Err("The saved report identity is inconsistent.".into());
            }
            risks::remove_report_risks(&tx, &package, &risk_revisions)?;
        }
        index.remove(revision.id.as_str()).map_err(storage_error)?;
        tx.open_table(REPORTS)
            .map_err(storage_error)?
            .remove(revision.id.as_str())
            .map_err(storage_error)?;
        drop(index);
        tx.commit().map_err(storage_error)
    }
}

/// Database diagnostics deliberately omit paths and report contents from renderer errors.
fn storage_error(_: impl std::fmt::Display) -> String {
    "Could not read or update saved reports.".into()
}
/// Bound untrusted local database values before deserializing small history metadata.
fn decode_summary(bytes: &[u8]) -> Result<Summary, String> {
    if bytes.len() > MAX_INDEX_BYTES {
        return Err("Invalid saved report metadata.".into());
    }
    let item: Summary = serde_json::from_slice(bytes).map_err(storage_error)?;
    if uuid::Uuid::parse_str(&item.id).is_err()
        || item.bytes > (super::MAX_REPORT_BYTES + super::MAX_ANNOTATION_BYTES) as u64
    {
        return Err("Invalid saved report metadata.".into());
    }
    Ok(item)
}
/// Saved connection IDs can change after an import; endpoint and account still identify the history scope.
fn same_subject(item: &Summary, subject: &SnapshotSubject) -> bool {
    item.host == subject.host && item.username == subject.username && item.port == subject.port
}

/// A missing subject lists device-wide summaries; history is main-window-only and executes no assessment commands.
#[tauri::command]
pub async fn security_assessment_saved_reports(
    window: tauri::WebviewWindow,
    library: tauri::State<'_, Arc<ReportLibrary>>,
    subject: Option<SnapshotSubject>,
) -> Result<Vec<Summary>, String> {
    super::super::runner::main_window(&window)?;
    let store = library.inner().clone();
    tokio::task::spawn_blocking(move || match subject {
        Some(subject) => store.list(&subject),
        None => store.list_all(),
    })
    .await
    .map_err(storage_error)?
}
/// Load a single report under its captured endpoint/account scope.
#[tauri::command]
pub async fn security_assessment_load_report(
    window: tauri::WebviewWindow,
    library: tauri::State<'_, Arc<ReportLibrary>>,
    id: String,
    subject: SnapshotSubject,
) -> Result<SavedReport, String> {
    super::super::runner::main_window(&window)?;
    let store = library.inner().clone();
    tokio::task::spawn_blocking(move || store.load(&id, &subject))
        .await
        .map_err(storage_error)?
}
/// Explicit report saving records historical evidence and notes; reusable acceptances have their own lifecycle.
#[tauri::command]
pub async fn security_assessment_save_report(
    window: tauri::WebviewWindow,
    library: tauri::State<'_, Arc<ReportLibrary>>,
    payload: String,
    name: String,
    replace: Option<Revision>,
) -> Result<Summary, String> {
    super::super::runner::main_window(&window)?;
    let store = library.inner().clone();
    tokio::task::spawn_blocking(move || store.save(&payload, &name, replace))
        .await
        .map_err(storage_error)?
}
/// Delete only the explicitly selected saved revision, without touching the current host.
#[tauri::command]
pub async fn security_assessment_delete_report(
    window: tauri::WebviewWindow,
    library: tauri::State<'_, Arc<ReportLibrary>>,
    revision: Revision,
    subject: SnapshotSubject,
    risk_revisions: Option<Vec<Revision>>,
) -> Result<(), String> {
    super::super::runner::main_window(&window)?;
    let store = library.inner().clone();
    tokio::task::spawn_blocking(move || match risk_revisions {
        Some(risks) => store.delete_with_risks(revision, &subject, risks),
        None => store.delete(revision, &subject),
    })
    .await
    .map_err(storage_error)?
}

#[cfg(test)]
mod tests;
