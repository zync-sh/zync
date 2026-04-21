# Settings System (Global + Local Scope)

This document explains how Zync currently manages settings and how local scope is intended to fit in.

## Current Source of Truth

- Zync currently uses **one canonical global settings file**:
  - **Windows**: `%APPDATA%/Zync/User/settings.json`
  - **Linux**: `~/.config/Zync/User/settings.json`
  - **macOS**: `~/Library/Application Support/Zync/User/settings.json` (via native config dir resolution)
- Backend ownership:
  - `src-tauri/src/commands.rs`
  - `get_native_settings_path`, `read_effective_settings`, `settings_set`, `settings_read_raw`, `settings_write_raw`

## Why Global First

- Matches the familiar VS Code-style **user-level settings** model.
- Keeps behavior stable across sessions/connections.
- Lets UI and backend read from one validated file.

## In-App `settings.json` Editing

- Settings modal now has a dedicated **settings.json editor tab**.
- Editor behavior:
  - Full-screen in-app editing surface.
  - Save (`Ctrl/Cmd+S`) writes via `settings_write_raw`.
  - Reload refreshes current disk content.
  - Restore reverts to `settings.last-known-good.json`.
  - Detects external file changes and warns before save.

## Safety + Recovery Guarantees

- Atomic writes (temp file + rename) to avoid partial corruption.
- Optimistic concurrency check using file modified timestamp.
- Lightweight schema validation on managed settings paths.
- Last-known-good backup promotion is guarded by parse/shape validation.

## Legacy Migration

- If native settings are missing, backend performs one-time migration from legacy candidates:
  - old app-data path
  - `~/.zync/settings.json`

## Local Scope (Planned / Not Active Yet)

- **Current status:** local/project settings are **not active** as a runtime override layer.
- Planned direction:
  - Keep global settings as base.
  - Add local/workspace scope as an optional, explicit overlay.
  - Preserve predictable precedence (`global -> local`) only when local scope is enabled.

## Key Files

- Frontend:
  - `src/components/settings/SettingsModal.tsx`
  - `src/components/settings/SettingsJsonEditorPanel.tsx`
  - `src/store/settingsSlice.ts`
- Backend:
  - `src-tauri/src/commands.rs`
