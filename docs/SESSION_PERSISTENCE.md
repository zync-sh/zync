# Session Persistence

This document describes how Zync saves and restores workspace state across app restarts.

## Overview

Session persistence covers three layers:

- **Sidebar tabs** — open tabs, order, active tab, and active connection
- **Terminal tabs** — all terminal tabs per connection scope, active terminal per scope, and synced terminal
- **CWD tracking** — last known working directory per terminal, captured passively via OSC 7

State is serialised to `session.json` in the app data directory after every meaningful change and restored on next launch before the UI is shown.

---

## Current Status (2026-04-16)

- Shipped in `v2.13.0` and active in current app code.
- Frontend restore order is enforced: connections/settings load first, then session restore.
- Save data is dirty-checked and serialised through a pending-save chain to avoid interleaved writes.
- `setTerminalCwd` writes are debounced (1s) to avoid frequent disk writes.
- SSH tabs restore as metadata-only and require reconnect before PTY spawn.
- Frontend unit coverage now exists in `tests/sessionPersistence.test.mjs` for snapshot serialisation and tab-cap behavior.

---

## File Structure And Responsibilities

### Frontend (TypeScript)

- `src/store/sessionPersistence.ts`
  - Pure session snapshot helpers shared by save logic and tests

- `src/store/sessionSlice.ts`
  - `loadSession()` — reads session from disk, restores sidebar tabs then terminal tabs; gates UI on `sessionLoaded`
  - `saveSession()` — serialises current store state, dirty-checks against last snapshot, chains writes through `_pendingSave` to prevent interleaved IPC calls
  - `scheduleSaveSession()` — debounced wrapper (1 s) used by `setTerminalCwd` to avoid flooding disk on rapid `cd`
  - `resetSessionDebounce()` — exported helper for test/HMR cleanup of module-level timer and snapshot state

- `src/store/connectionSlice.ts`
  - `restoreTabState()` — validates snapshots against loaded connections, filters deleted connections, resolves active tab and connection
  - Calls `saveSession()` after every tab mutation: `openTab`, `openPortForwardingTab`, `openReleaseNotesTab`, `openSnippetsTab`, `closeTab`, `activateTab`, `reorderTabs`

- `src/store/terminalSlice.ts`
  - `restoreTerminalTabs()` — rebuilds terminal tabs from snapshots; sets `pendingRestore: true` on SSH tabs; restores `syncedTerminalId`
  - `clearPendingRestore()` — called after a successful SSH reconnect to mark tabs as live

- `src/components/Terminal.tsx`
  - Registers an OSC 7 handler on new terminal instances to capture CWD from shells that emit it natively

- `src/components/layout/MainLayout.tsx`
  - Blocks render and `hideBootSplash` until `sessionLoaded` is true, preventing a flash of empty tab bar

- `src/App.tsx`
  - Init order: `loadConnections` + `loadSettings` → `loadSession`; `loadSession` always runs even if preceding steps fail

- `tests/sessionPersistence.test.mjs`
  - Dedicated regression coverage for snapshot serialisation, terminal capping, and null active-terminal filtering

### Backend (Rust)

- `src-tauri/src/session.rs`
  - `session_load` — reads `session.json`, deserialises into `SessionData`, runs `migrate()`; returns `None` on missing or corrupt file
  - `session_save` — enforces `MAX_TABS_PER_SCOPE`, stamps version, writes atomically via tmp → rename using `tokio::fs`
  - `migrate()` — stamps v0 files as v1; logs a warning if file version is newer than `SESSION_VERSION`

---

## Data Shape

```
SessionData
├── version: u32
├── activeTabId: Option<String>
├── activeConnectionId: Option<String>
├── tabs: Vec<TabSnapshot>
│   ├── id, tabType, title, connectionId, view
├── terminals: HashMap<scopeId, Vec<TerminalTabSnapshot>>
│   ├── id, title, cwd, initialPath, isSynced
└── activeTerminalIds: HashMap<scopeId, String>
```

Rust structs use `#[serde(rename_all = "camelCase", default)]` so all fields are optional on deserialise — missing fields from older session files default gracefully.

---

## Restorable Tab Types

Only the following tab types are restored on launch:

| Type | Notes |
|---|---|
| `connection` | Validated against loaded connections; `'local'` is always valid |
| `port-forwarding` | Always restored |
| `release-notes` | Always restored |

`settings` tabs are excluded from restore/save intent as transient UI state.

`snippets` tabs are currently **not restorable** (filtered out by `restoreTabState`), even if serialised in a previous snapshot. Treat snippets tabs as transient for restore behavior.

The `view` field is validated against the allowed `Tab['view']` union on restore; invalid persisted values fall back to `'terminal'`.

---

## SSH Terminal Restore

SSH terminal tabs set `pendingRestore: true` on restore. This drives the "Reconnect to resume" UI in `Terminal.tsx` and prevents premature PTY spawning. The flag is cleared by `clearPendingRestore()` after a successful connection in `connect()`.

Orphaned SSH scopes (connection deleted since last session) are skipped entirely during restore.

---

## CWD Tracking

CWD is captured **passively** via OSC 7 (`\x1b]7;file://hostname/path\x07`). No shell configuration is injected. Shells that emit OSC 7 natively include:

- starship
- oh-my-posh
- fish
- zsh with `precmd` / `chpwd`

The handler in `Terminal.tsx` strips the `file://hostname` prefix, percent-decodes the path, and strips the leading `/` from Windows paths (`/C:/Users/...` → `C:/Users/...`).

CWD is stored in the session for use by ghost suggestions and AI context. It is **not** used to reopen terminals in the saved directory on restore.

---

## Atomic Writes

`session_save` writes via a tmp file then renames:

```
session.tmp  →  session.json
```

`tokio::fs::rename` on Windows replaces an existing destination atomically on the same volume. A crash mid-write leaves `session.tmp` behind but never corrupts `session.json`.

---

## Dirty Check and Concurrency

`saveSession` serialises the current state to JSON and compares against `_lastSavedSnapshot`. If the snapshot is unchanged the IPC call is skipped entirely.

Concurrent calls are serialised through `_pendingSave`:

```ts
_pendingSave = _pendingSave.then(async () => {
    if (snapshot === _lastSavedSnapshot) return; // deduplicate if batched
    await invoke('session_save', { data });
    _lastSavedSnapshot = snapshot;
});
```

`_lastSavedSnapshot` is only updated after a successful invoke so a failed write always retries on the next call.

---

## Schema Versioning

`SESSION_VERSION` is currently `1`. The `migrate()` function handles forward-only migrations:

- v0 → v1: stamps the version field (no structural changes)
- v > SESSION_VERSION: logs a warning, keeps data as-is (serde `default` handles unknown fields safely)

Bump `SESSION_VERSION` and add a migration branch whenever the schema changes in a breaking way.
