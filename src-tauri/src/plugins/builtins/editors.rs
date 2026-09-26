use super::super::{EditorManifest, Manifest, ManifestExtensions, Plugin};

pub(crate) fn builtin_plain_editor_provider() -> Plugin {
    Plugin {
        path: "builtin://plain-editor-provider".to_string(),
        manifest: Manifest {
            id: "com.zync.editor.plain-plugin".to_string(),
            name: "Plugin Editor (Bridge Demo)".to_string(),
            version: "1.0.0".to_string(),
            main: None,
            style: None,
            mode: None,
            preview_bg: None,
            preview_accent: None,
            icon: None,
            manifest_type: Some("editor-provider".to_string()),
            icons_path: None,
            editor: Some(EditorManifest {
                entry: Some("editor.html".to_string()),
                display_name: Some("Plugin Editor (Bridge Demo)".to_string()),
                priority: Some(10),
                default_for: Some(vec!["text/*".to_string()]),
                supports: vec![
                    "save".to_string(),
                ],
                file_extensions: None,
                large_file_limit_mb: None,
            }),
            extensions: ManifestExtensions::default(),
        },
        script: None,
        style: None,
        editor_html: Some(
            r#"
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
:root {
  color-scheme: dark;
  --bg: #0f111a;
  --panel: #1a1d2e;
  --border: rgba(255,255,255,0.08);
  --text: #e2e8f0;
  --muted: #94a3b8;
  --accent: #6366f1;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font-family: Inter, system-ui, sans-serif; }
body { display: flex; flex-direction: column; }
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel) 92%, transparent);
}
.meta { font-size: 12px; color: var(--muted); }
.actions { display: flex; gap: 8px; }
button {
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  border-radius: 8px;
  padding: 8px 10px;
  cursor: pointer;
  font-size: 12px;
}
button.primary {
  background: var(--accent);
  color: white;
  border-color: transparent;
}
textarea {
  flex: 1;
  width: 100%;
  border: 0;
  outline: 0;
  resize: none;
  background: var(--bg);
  color: var(--text);
  padding: 16px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.55;
}
  </style>
</head>
<body>
  <div class="toolbar">
<div class="meta" id="meta">Loading editor…</div>
<div class="actions">
  <button id="closeBtn" type="button">Close</button>
  <button id="saveBtn" class="primary" type="button">Save</button>
</div>
  </div>
  <textarea id="editor" spellcheck="false" aria-label="Plugin editor"></textarea>
  <script>
const editor = document.getElementById('editor');
const meta = document.getElementById('meta');
const saveBtn = document.getElementById('saveBtn');
const closeBtn = document.getElementById('closeBtn');
let currentDoc = null;
let initialContent = '';

function updateMeta() {
  if (!currentDoc) {
    meta.textContent = 'Loading editor…';
    return;
  }
  const dirty = editor.value !== initialContent;
  const lineCount = editor.value.length === 0 ? 1 : editor.value.split('\n').length;
  meta.textContent = `${currentDoc.filename} · ${lineCount} lines${dirty ? ' · Modified' : ''}`;
  window.zyncEditor.emitDirtyChange(dirty);
}

editor.addEventListener('input', () => {
  updateMeta();
  window.zyncEditor.emitChange({ docId: currentDoc?.docId, content: editor.value });
});

saveBtn.addEventListener('click', () => {
  window.zyncEditor.requestSave(editor.value);
  initialContent = editor.value;
  updateMeta();
});

closeBtn.addEventListener('click', () => {
  window.zyncEditor.requestClose();
});

window.zyncEditor.onMessage((message) => {
  const { type, payload } = message || {};
  if (type === 'zync:editor:open-document') {
    currentDoc = payload;
    initialContent = payload.content || '';
    editor.value = initialContent;
    updateMeta();
    setTimeout(() => editor.focus(), 0);
  }

  if (type === 'zync:editor:update-document') {
    initialContent = payload.content || '';
    editor.value = initialContent;
    updateMeta();
  }

  if (type === 'zync:editor:set-theme') {
    const colors = payload?.colors || {};
    document.documentElement.style.setProperty('--bg', colors.background || '#0f111a');
    document.documentElement.style.setProperty('--panel', colors.surface || '#1a1d2e');
    document.documentElement.style.setProperty('--border', colors.border || 'rgba(255,255,255,0.08)');
    document.documentElement.style.setProperty('--text', colors.text || '#e2e8f0');
    document.documentElement.style.setProperty('--muted', colors.muted || '#94a3b8');
    document.documentElement.style.setProperty('--accent', colors.primary || '#6366f1');
  }

  if (type === 'zync:editor:focus') {
    editor.focus();
  }
});

window.zyncEditor.emitReady({ supports: ['save'] });
  </script>
</body>
</html>
            "#.to_string()
        ),
        enabled: true,
    }
}

pub(crate) fn builtin_codemirror_editor_provider() -> Plugin {
    Plugin {
        path: "builtin://codemirror-editor-provider".to_string(),
        manifest: Manifest {
            id: "com.zync.editor.codemirror".to_string(),
            name: "CodeMirror Editor".to_string(),
            version: "1.0.0".to_string(),
            main: None,
            style: None,
            mode: None,
            preview_bg: None,
            preview_accent: None,
            icon: None,
            manifest_type: Some("editor-provider".to_string()),
            icons_path: None,
            editor: Some(EditorManifest {
                entry: None,
                display_name: Some("CodeMirror".to_string()),
                priority: Some(100),
                default_for: Some(vec!["text/*".to_string()]),
                supports: vec![
                    "search".to_string(),
                    "replace".to_string(),
                    "goto-line".to_string(),
                    "syntax-highlight".to_string(),
                    "folding".to_string(),
                    "multi-selection".to_string(),
                ],
                file_extensions: None,
                large_file_limit_mb: None,
            }),
            extensions: ManifestExtensions::default(),
        },
        script: None,
        style: None,
        editor_html: None,
        enabled: true,
    }
}
