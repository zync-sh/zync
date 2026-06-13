use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

pub(crate) static SNIPPETS_MUTATION_LOCK: LazyLock<Mutex<()>> =
    LazyLock::new(|| Mutex::new(()));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
    // alias allows loading old snippets saved with snake_case key
    #[serde(alias = "connection_id")]
    pub connection_id: Option<String>, // if scoped to a specific connection, or global
    #[serde(default)]
    pub created_at: Option<u64>,
    #[serde(default)]
    pub updated_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnippetsData {
    pub snippets: Vec<Snippet>,
}

pub struct SnippetsManager {
    file_path: PathBuf,
}

impl SnippetsManager {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let file_path = app_data_dir.join("snippets.json");
        Self { file_path }
    }

    pub async fn list(&self) -> Result<Vec<Snippet>, String> {
        let _guard = SNIPPETS_MUTATION_LOCK
            .lock()
            .map_err(|error| error.to_string())?;
        self.list_from_disk()
    }

    fn list_from_disk(&self) -> Result<Vec<Snippet>, String> {
        Ok(read_snippets_data(self.file_path.as_path())?.snippets)
    }

    pub async fn save(&self, snippet: Snippet) -> Result<(), String> {
        let _guard = SNIPPETS_MUTATION_LOCK
            .lock()
            .map_err(|error| error.to_string())?;
        let mut snippets = self.list_from_disk()?;
        let now = current_unix_millis();

        if let Some(pos) = snippets.iter().position(|s| s.id == snippet.id) {
            let created_at = snippets[pos].created_at.or(snippet.created_at).or(Some(now));
            snippets[pos] = Snippet {
                created_at,
                updated_at: Some(now),
                ..snippet
            };
        } else {
            snippets.push(Snippet {
                created_at: snippet.created_at.or(Some(now)),
                updated_at: Some(now),
                ..snippet
            });
        }

        self.save_to_disk(snippets)
    }

    pub async fn delete(&self, id: String) -> Result<(), String> {
        let _guard = SNIPPETS_MUTATION_LOCK
            .lock()
            .map_err(|error| error.to_string())?;
        let mut snippets = self.list_from_disk()?;
        snippets.retain(|s| s.id != id);
        self.save_to_disk(snippets)
    }

    fn save_to_disk(&self, snippets: Vec<Snippet>) -> Result<(), String> {
        let data = SnippetsData { snippets };
        write_snippets_atomic(self.file_path.as_path(), &data)
    }
}

fn read_snippets_data(path: &Path) -> Result<SnippetsData, String> {
    if !path.exists() {
        let temp_path = path.with_extension("tmp");
        let backup_path = path.with_extension("bak");
        for candidate in [&temp_path, &backup_path] {
            if let Some(data) = parse_snippets_candidate(candidate) {
                fs::rename(candidate, path).map_err(|e| {
                    format!("Failed to promote recovered snippets file: {e}")
                })?;
                return Ok(data);
            }
        }
        return Ok(SnippetsData { snippets: Vec::new() });
    }
    parse_snippets_file(path)
}

fn parse_snippets_candidate(path: &Path) -> Option<SnippetsData> {
    parse_snippets_file(path).ok()
}

fn parse_snippets_file(path: &Path) -> Result<SnippetsData, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

fn write_snippets_atomic(path: &Path, data: &SnippetsData) -> Result<(), String> {
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    crate::atomic_io::durable_replace(path, json.as_bytes())
        .map_err(|e| format!("Failed to write snippets file: {e}"))
}

fn current_unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}