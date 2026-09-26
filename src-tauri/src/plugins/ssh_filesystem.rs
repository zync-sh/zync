use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSshFilesystemEntry {
    pub name: String,
    pub kind: &'static str,
    pub size: Option<u64>,
}

impl From<crate::fs::FileEntry> for PluginSshFilesystemEntry {
    fn from(entry: crate::fs::FileEntry) -> Self {
        let (kind, size) = match entry.r#type.as_str() {
            "d" => ("directory", None),
            "-" => ("file", Some(entry.size)),
            _ => ("unavailable", None),
        };
        Self {
            name: entry.name,
            kind,
            size,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_entries_hide_links_and_special_files() {
        let entry = crate::fs::FileEntry {
            name: "shortcut".into(),
            path: "/home/demo/shortcut".into(),
            r#type: "l".into(),
            size: 12,
            last_modified: 0,
            permissions: "777".into(),
            owner: String::new(),
            group: String::new(),
        };
        let exposed = PluginSshFilesystemEntry::from(entry);
        assert_eq!(exposed.kind, "unavailable");
        assert_eq!(exposed.size, None);
    }
}
