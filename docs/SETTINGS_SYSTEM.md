# Settings System (Global + Local Scope)

This document defines the current settings model in Zync, the global `settings.json` workflow, and how local scope is treated today.

## Scope Model at a Glance

| Scope | Status | Source | Notes |
|---|---|---|---|
| Global/User | **Active (source of truth)** | Native user path `Zync/User/settings.json` | Used by frontend + backend as canonical persisted configuration |
| Local/Workspace override | **Not active yet** | N/A | Planned as optional overlay, not currently applied at runtime |

## Canonical Global Settings Path

Zync uses one canonical user settings file:

- **Windows**: `%APPDATA%/Zync/User/settings.json`
- **Linux**: `~/.config/Zync/User/settings.json`
- **macOS**: `~/Library/Application Support/Zync/User/settings.json`

Backend path ownership and resolution live in `src-tauri/src/commands.rs` (`get_native_settings_path`, `read_effective_settings`, `settings_set`, `settings_read_raw`, `settings_write_raw`).

## Write Paths (Managed vs Raw)

### Managed writes (recommended)

- Frontend writes patches through `config:set` (`src/lib/tauri-ipc.ts`).
- Backend applies merge + validation through `settings_set`.
- This is the canonical path for regular settings UI controls.

### Raw file writes (JSON editor tab)

- In-app `settings.json` editor writes full JSON content through `settings_write_raw`.
- Used for advanced/manual edits where exact JSON control is required.

## In-App `settings.json` Editor Behavior

Zync provides an in-app editor tab (not external VS Code handoff) for global settings:

- full in-app editing surface
- Save (`Ctrl/Cmd+S`) to write file contents
- Reload to refresh from disk
- Restore from `settings.last-known-good.json`
- external-file-change awareness and conflict-safe save behavior

## Safety and Recovery Guarantees

- atomic writes (temp + rename) to prevent partial/corrupt saves
- optimistic concurrency checks using file metadata
- validation before promoting backups as last-known-good
- invalid patch inputs blocked before backend invocation
- invalid patch logging is metadata-only (no raw patch payload emission)

## Current Local vs Global Behavior

### What is currently global

- app-wide appearance preferences (theme, global font family/size, accent)
- persisted feature/settings configuration in user `settings.json`
- update/config toggles and system-level options

### What is currently “local” in UI terms (but not local override file scope)

- local terminal behavior/settings sections in the Settings UI
- per-connection/per-tab runtime state in store/session flows

These are not implemented as a separate workspace `settings.json` override layer yet.

## Local Scope Plan (Not Active Yet)

Planned direction:

1. keep global settings as stable base
2. optionally enable local/workspace settings overlay
3. apply explicit precedence only when enabled (`global -> local`)

No local override file should be assumed active unless explicitly implemented in runtime resolution.

## Migration and Compatibility

If canonical native settings are missing, backend performs one-time migration from legacy candidates (for example old app-data path or `~/.zync/settings.json`).

## Key Files

### Frontend

- `src/components/settings/SettingsModal.tsx`
- `src/components/settings/SettingsJsonEditorPanel.tsx`
- `src/components/settings/tabs/AppearanceTab.tsx`
- `src/components/settings/hooks/useSettingsUpdateFlow.ts`
- `src/store/settingsSlice.ts`
- `src/lib/tauri-ipc.ts`

### Backend

- `src-tauri/src/commands.rs`
