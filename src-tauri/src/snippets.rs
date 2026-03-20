use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

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
        if !self.file_path.exists() {
            return Ok(vec![]);
        }
        let content = fs::read_to_string(&self.file_path).map_err(|e| e.to_string())?;
        let data: SnippetsData = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        Ok(data.snippets)
    }

    pub async fn save(&self, snippet: Snippet) -> Result<(), String> {
        let mut snippets = self.list().await?;

        if let Some(pos) = snippets.iter().position(|s| s.id == snippet.id) {
            snippets[pos] = snippet;
        } else {
            snippets.push(snippet);
        }

        self.save_to_disk(snippets).await
    }

    pub async fn delete(&self, id: String) -> Result<(), String> {
        let mut snippets = self.list().await?;
        snippets.retain(|s| s.id != id);
        self.save_to_disk(snippets).await
    }

    async fn save_to_disk(&self, snippets: Vec<Snippet>) -> Result<(), String> {
        let data = SnippetsData { snippets };
        let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
        fs::write(&self.file_path, json).map_err(|e| e.to_string())
    }
}
