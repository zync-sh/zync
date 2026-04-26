# Changelog

All notable changes to Zync are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.15.0] - 2026-04-26

### Added
- **Shell Icon Pipeline**: Added reusable shell icon infrastructure across frontend and Tauri backend, including cache/types helpers, `ShellIcon` UI component, shell icon discovery backend module, and architecture notes for future maintenance. ([dd13dcf])

### Changed
- **Shell Picker & Dropdown UX**: Unified local/remote shell discovery flow and refreshed terminal dropdown UX by renaming the section to **Shells**, moving shortcut hints to tooltips, improving tooltip consistency for tabs/header controls, and keeping reload affordances aligned with the shell header row. ([dd13dcf])
- **Cross-Host Shell Handling**: Improved host-aware shell option normalization so local and SSH contexts return appropriate shell choices for Linux/macOS/Windows scenarios. ([dd13dcf])
- **Feature Dropdown Guard Redundancy**: Removed redundant `onOpenFeature` null checks inside already-gated feature/plugin sections to simplify click/disabled logic without changing behavior. ([dd13dcf])

### Fixed
- **Terminal Wakeup Shell Resolution**: Wakeup/restart paths now read fresh `windowsShell` settings from store state instead of closure-captured values, preventing stale shell selection after settings changes. ([dd13dcf])
- **Close Terminal Shortcut Reliability**: Fixed `Ctrl+Shift+W` / `Mod+Shift+W` terminal-tab close handling to always target the current active terminal tab by using the live ref in the event listener path. ([53aeb1f])
- **Shell Discovery, Caching, and Terminal Lifecycle Hardening**: Added timeout protection for remote Windows shell discovery, improved shell cache scoping/reset behavior, hardened shell-icon cache file handling, and included terminal exit codes in lifecycle events for clearer diagnostics. ([817ccb6])
- **UI Accessibility and Safety Refinements**: Made tooltip triggers keyboard-focusable, tightened feature-key filtering to own properties only, and made bundled shell icon URLs base-path aware. ([817ccb6])
- **WSL Startup Working Directory**: Fixed local WSL terminal startup so new WSL tabs open in Linux home (or saved Linux path) instead of inheriting the host Windows working directory. ([1c519b2])
- **Plugin View Restore, Tooltip Composition, and Shell Cache Invalidation**: Hardened restored plugin view validation against loaded plugin panels, improved tooltip trigger composition/dismiss behavior, invalidated cached shell lists after connection target edits/imports, preserved `plugin:*` views on restore, and tightened PTY shell parsing/interactivity checks while removing noisy recompute logs. ([8faf6ef])

## [2.14.1] - 2026-04-23

### Changed
- **Welcome Screen Layout**: Content is now vertically centered on large displays. Connection lists grow with available height (up to 40% of viewport) instead of a fixed cap. On wide screens the content area expands slightly (`max-w-3xl`). On narrow widths, Favorites and Recent stack vertically with a horizontal divider and tighter padding. ([cea3fa0])
- **Snippet Sidebar Shortcut**: Reassigned `Ctrl+Shift+S` to toggle the snippet sidebar (previously only `Ctrl+Shift+Backquote` triggered it). Both bindings remain active for compatibility. ([4104e34])
- **Snippet Picker Removed**: Removed the snippet picker modal in favour of the snippet sidebar, simplifying the snippets UX to a single surface. ([4104e34])
- **Global Snippets Tab Isolation**: Global snippets tab now uses `connectionId: 'global'` (no longer shares the `'local'` sentinel with the local terminal), preventing tab collision and incorrect snippet filtering. The tab now shows only globally-scoped snippets. ([4104e34])
- **`LOCAL_TERMINAL_CONNECTION_ID` Constant**: Exported named constant from `tabService` to mirror `GLOBAL_SNIPPETS_CONNECTION_ID` and eliminate bare `'local'` string literals. ([4104e34])

### Fixed
- **Ctrl+Shift+Backquote Cross-Platform**: Added `e.code === 'Backquote'` check so the snippet sidebar shortcut fires reliably on Windows keyboard layouts where `e.key` may not produce a backtick with Ctrl held. ([4104e34])
- **Jump Host / Bastion Auth Detection**: Fixed key-auth jump hosts failing with "Password is required" after app restart. Connections loaded from disk have `password: null` (Rust `Option<String>` serializes `None` as JSON `null`), which incorrectly satisfied the `password !== undefined` discriminator and routed key-auth connections into the password branch. Switched to `privateKeyPath` as the auth discriminator — matching `buildConnectConfig` — so `null`, `undefined`, and `''` all correctly resolve as "no key set". No connection data migration required. ([a5a25ef])

## [2.14.0] - 2026-04-21

### Added
- **In-App `settings.json` Editing Surface**: Added a full in-app editor workflow for global `settings.json` including load/save/reload/restore integration in the Settings experience. ([7f9c425])

### Changed
- **Settings Persistence Flow**: Moved `config:set` patch merge responsibility to backend `settings_set` so merge + validation happen in one canonical path. ([7f9c425])
- **Settings Editor UX**: Improved settings error/conflict handling and in-editor save/reload/restore reliability. ([7f9c425])
- **Settings Architecture Refactor**: Split Settings into modular tabs/hooks/common components and restored non-working settings + font control flows. ([da93f23], [bb42e1c])
- **Terminal Dependency Alignment**: Migrated terminal runtime packages to a consistent scoped `@xterm/*` stack. ([9958c44])
- **Shell/UI Loading Cleanup**: Stabilized modal loading paths and shell-level UI wiring across layout/sidebar/modal bridge points. ([e1d6109])
- **Settings Patch Persistence Safety**: Sub-slice settings writes now persist patch payloads with safer merge semantics, and accent reset semantics were normalized for clearer default-color behavior. ([8dfe727])
- **Settings/Update UX Robustness**: Improved settings runtime guards for plugin/update flows, UI-side effect gating, and terminal ligature state bookkeeping consistency. ([e70f7a0])
- **Connectivity & Copy Fallback Hardening**: Tightened quick-connect parsing/limits, improved Windows path normalization in file workflows, and hardened server-side copy fallback behavior. ([e7f4f02])

### Fixed
- **IPC Listener Cleanup Race**: Hardened Tauri IPC listener setup/teardown flow to avoid pending-listener unsubscribe edge cases. ([7f9c425])
- **Editor Search Focus Stability**: Prevented unintended focus jumps in `PlainFileEditor` during match recalculation. ([7f9c425])
- **Batch SFTP Copy Retry Guard**: Added retry caps for session-closed reconnect loops in batch copy paths to avoid unbounded retries. ([7f9c425])
- **Batch Rename Retry Idempotency**: Added remote existence probes before retry rename operations after reconnect to avoid duplicate/unsafe replays. ([7f9c425])
- **Settings Backup Promotion Safety**: Validate existing settings payload before promoting it to last-known-good backup. ([7f9c425])
- **Transfer Progress Accuracy**: Final transfer progress emit now reports real transferred/total values instead of hardcoded `100/100`. ([7f9c425])
- **Plugin Window HTML Transport**: Replaced large base64 data URL rendering with temp-file-backed `file://` webview loading for plugin HTML windows. ([7f9c425])
- **Blocking Folder Picker Call**: Offloaded blocking folder selection dialog invocation to blocking runtime executor. ([7f9c425])
- **Terminal Path Escaping Consistency**: Reused shared `shell_quote` helper for terminal navigation command construction. ([7f9c425])
- **SSH Config Import Redundant Read**: Removed unnecessary duplicate file open before parse. ([7f9c425])
- **Data Directory Resolution Cost**: Added cached data-dir resolution to avoid repeated blocking settings reads on hot paths. ([7f9c425])
- **AI Settings Parse Diagnostics**: Expanded debug logging to include actual settings path context for AI config parse/default fallback cases. ([7f9c425])
- **Settings Action Re-entry + Parser/Picker Consistency**: Added in-flight guards for update actions, switched welcome quick-connect helper parsing to shared canonical logic, and aligned theme color picker fallback with theme default accent when valid. ([c9e8345])
- **File Manager Interaction Stability**: Improved callback/effect stability, keyboard behavior, and quick-connect parsing edge-case handling. ([9f41e0f])
- **Plugin Temp HTML Lifecycle**: Hardened plugin temp-file registration and stale cache cleanup behavior. ([2ef1c90])

## [2.13.2] - 2026-04-18

### Changed
- **Welcome Screen & Quick Connect Rebuild**: Split the quick-connect area into focused auth, suggestions, and templates components, tightened keyboard/accessibility behavior, and hardened the welcome screen interactions. ([ad0aea5], [ef6f9eb])


## [2.13.1] - 2026-04-17

### Fixed
- **Terminal PTY Generation Guarding**: Added per-spawn generation tagging for terminal ready/output/exit events so stale PTY events from earlier reload/restart cycles are ignored cleanly. ([d049d01])
- **Session Persistence Snapshot Integrity**: Hardened persisted `activeTabId` and `activeTerminalIds` so saved session state cannot point to filtered tabs or terminals dropped by snapshot truncation. ([d049d01])

### Added
- **Session Persistence Test Coverage**: Added focused regression coverage for session snapshot serialization, tab filtering, terminal truncation, and active-terminal ID persistence. ([d049d01])

## [2.13.0] - 2026-04-16

### Removed
- **Status Bar Version Number**: Removed the app version display from the bottom status bar. ([648102c])

### Added
- **Session Persistence**: Zync now restores its full UI state across restarts. Open sidebar tabs (order, active tab, active connection), terminal tabs per connection, and last-known working directory are saved to `session.json` and restored on next launch. ([2de6066])
- **SSH Terminal Restore**: SSH terminal tabs are restored as metadata-only on launch and show a "Reconnect to resume" prompt; the live PTY is re-established when the user reconnects the connection. ([2de6066])
- **Passive CWD Tracking**: Working directory is captured via OSC 7 for shells that emit it natively (starship, oh-my-posh, fish, zsh with precmd) and surfaced to ghost suggestions and AI context. ([2de6066])

## [2.12.0] - 2026-04-15

### Added
- **Ghost Suggestion System (Inline + Popup)**: Introduced fish-style inline ghost text completions and a Tab-triggered popup list for all terminal sessions. Completions are driven by frecency-scored command history (scoped per connection) and live filesystem path listing via SFTP/local. ([b4e8078])
- **Ghost Suggestion Settings**: Added a Ghost Suggestions section in Settings with toggles for inline ghost text, Tab popup, context-menu actions, and per-provider controls (history / filesystem). ([dff03a1])
- **Frecency History Backend (Rust)**: Added a Rust `ghost` module with `GhostManager` for frecency-scored command history, scoped per SSH connection or local session. Includes `ghost_commit`, `ghost_accept`, `ghost_suggest`, and `ghost_candidates` Tauri commands. ([a20af8c])
- **Ghost Suggestion Test Suite**: Added `tests/ghostSuggestionsHelpers.test.mjs` covering tab behavior, popup state, input tracker, path completion, and runtime routing. ([f174726])

## [2.11.1] - 2026-04-12

### Fixed
- **Plugin Theme Payload Reliability**: Versioned the host → plugin theme payload, improved CSS variable resolution (body + root fallback), expanded rgb parsing, and fixed memoization so editor/panel plugins receive accurate theme updates. ([c87e3d7])


- **AI Tool Path Validation Hardening**: Updated backend AI file-tool path validation to block real traversal components (`..`) while allowing valid filenames containing double dots (for example, `config..bak`). ([5d4f87f])
- **AI Write Tool Output Capping**: Routed `write_file` tool status output through shared `cap_output()` so all AI tool outputs consistently respect truncation limits and artifact fallback behavior. ([5d4f87f])

## [2.11.0] - 2026-04-10

### Added
- **Connection Domain Test Suite**: Added focused tests for connection domain, transforms, lifecycle, tab services, and tunnel auto-start behavior to lock refactor parity. ([d2a50c3])
- **Connection Import Planning Module**: Added `importPlan` domain helpers to build deterministic import recommendations and apply decisions for create/update/skip flows. ([088fdf9])
- **Source-Based SSH Import (Phase 1)**: Added source-driven import support for default `~/.ssh/config`, custom SSH config files, and pasted SSH config text through a unified backend source command. ([64cb56a])
- **Connection Manual Smoke Checklist**: Added `tests/connectionManualSmokeChecklist.md` to standardize add/edit/import/cancellation release smoke validation. ([d0d56d7])
- **Connection Export/Import File Flows**: Added backend commands and UI plumbing for exporting/importing connections in `zync`, JSON, CSV, and SSH config formats. ([a2dffb7])
- **Scoped Export Modal**: Added `ExportConnectionsModal` with host selection, search, and format selection for connection/folder/all-hosts context exports. ([a2dffb7])

### Changed
- **Connection Flow Architecture**: Extracted connection logic into `src/features/connections` domain/application/infrastructure modules and routed store/modal flows through typed helpers. ([d2a50c3])
- **Add Connection Form UX**: Replaced multi-step manual entry with a compact single-scroll structure, mode chooser, validation-aware actions, and cleaner advanced options handling. ([088fdf9])
- **Shared Modal/Select Primitives**: Extended modal shell slots and reworked select dropdown positioning/escape handling for bounded modal-safe behavior. ([088fdf9])
- **Import SSH Modal UX**: Refined import modal density and hierarchy with header subtitle guidance, compact connection cards, sticky footer actions, and an extracted `ImportSummaryBar` for cleaner structure. ([fd1107c])
- **Import Conflict Resolution UX**: Reworked the import list into a compact table-style layout, added conflict bulk-decision controls, and added an in-modal import completion report summary. ([5c7afc3])
- **Import Modal State Handling**: Prevented open-session resets from store churn, removed index-based internalization fallback, and tightened stale async request handling for load/import actions. ([d0d56d7])
- **Sidebar Export Entry Points**: Moved export actions into sidebar context menus for connection rows, folder rows, and all-hosts header scope. ([a2dffb7])

### Fixed
- **Sidebar Host Drag-and-Drop**: Fixed root-folder drag/drop regressions so hosts can be moved reliably into folders and back to the main host area. ([d2a50c3])
- **Connection Import/Validation Edge Cases**: Hardened merge/id collision handling, normalization, field-level validation feedback, and null-safe feature pinning based on reviewed reliability findings. ([d2a50c3])
- **Import Modal Selection/Filter Behavior**: Updated Select All/Deselect All to operate on visible filtered rows and removed duplicated match-expression rendering paths for better readability and consistency. ([fd1107c])
- **Import Modal Reliability/Consistency**: Limited bulk conflict actions to selected conflicts, unified dropdown rendering with shared Select primitives, and aligned import payload typing in connection IPC helpers. ([5c7afc3])
- **Import Source Reliability & IPC Wiring**: Added request-shape mapping for unified source import IPC calls, centralized SSH import text-size guardrails, improved file-source validation, and tightened parser alias/quote handling for safer import behavior. ([64cb56a])
- **Connection Validation + Import Diagnostics**: Tightened host/username/key-path validation, added lightweight credential health hints in add/edit modal, and added source-level import diagnostics for clearer import troubleshooting feedback. ([636db7a])
- **Connection Reliability Hardening**: Added file-source import size guardrails, fixed nested import modal close state, preserved unmatched duplicate records during merge, refined local terminal close behavior, and hardened transfer cancel cleanup/error handling. ([d0d56d7])
- **Scoped Zync Export Integrity**: Filtered exported folder metadata to the selected connection scope and aligned SSH `ProxyJump` aliases with sanitized `Host` aliases in generated configs. ([a2dffb7])

## [2.10.1] - 2026-04-09

### Added
- **Sidebar Connection Search**: Added a top-of-sidebar connection search input that filters active hosts and the full host tree from a single query. ([1dfe5f3])

### Changed
- **Sidebar Structure Refactor**: Split the sidebar into focused subcomponents (`ConnectionItem`, `FolderItem`, `SidebarSection`, `FolderFormModal`) with shared tree/types helpers to improve maintainability without changing core workflows. ([2a16938])
- **Shared Connection Context Menu Ownership**: Lifted connection context-menu state to `Sidebar` and render a single shared menu instance instead of per-row menu state/rendering. ([bd73a72])

### Fixed
- **Smart Context Menu Positioning**: Reworked context menu/submenu placement with measured viewport-aware clamping so menus remain visible near edges and close reliably on escape/outside interactions. ([b9e726f])

## [2.10.0] - 2026-04-08

### Added
- **Plugin-Hosted Editor Runtime**: Introduced `FileEditorHost` with provider-aware rendering, built-in plain fallback, and CodeMirror default provider surfaces. ([a9afb01])
- **CodeMirror Helper Test Surface**: Added `tests/codeMirrorHelpers.test.mjs` to lock language mapping, comment shortcuts, status formatting, and provider helper behavior. ([a9afb01])
- **Editor Provider Quick Actions**: Added File Manager context menu actions for `Open With…` (per-open provider override) and `Set Default Editor` (global editor preference update). ([a332012])
- **Local Plugin Install Command**: Added `plugins_install_local` so provider/theme plugins can be installed from local ZIP or folder paths during pre-marketplace validation. ([5e86529])
- **Developer Plugin Testing Tab**: Added `Settings → Plugins → Developer` with dedicated local install actions for ZIP packages and unpacked folders. ([42c2b66])

### Changed
- **Editor Platform Migration**: Removed the legacy `light-editor` subsystem from active code paths and routed file editing through provider-hosted components (`CodeMirrorFileEditor`, `PlainFileEditor`, `EditorPluginFrame`). ([a9afb01])
- **Marketplace Filter UX**: Replaced ad-hoc category control with Zync's shared `Select` dropdown and aligned filter/category presentation with plugin category labels. ([a332012])
- **Editor Settings UX**: Added provider capability summary visibility and improved provider option ordering/metadata for default editor selection. ([a332012])
- **Editor Escape Behavior**: `Esc` now closes go-to-line/find overlays before any editor-close behavior. ([a9afb01])
- **Editor Dirty Baseline After Save**: Saving now updates editor baseline state so close confirmation no longer reports false unsaved changes. ([a332012])
- **Ctrl/Cmd+W Host Conflict**: While a file editor overlay is open, tab/host close shortcuts are blocked and `Ctrl/Cmd+W` is scoped to closing only the editor overlay. ([a332012])
- **Editor Overlay Focus Reliability**: Added stronger focus handoff on open so users can type immediately without requiring an extra click. ([a332012])
- **Go-to-Line Submit & Compact Bar**: Fixed go-to-line submit behavior and tightened the inline go-to-line bar layout. ([a332012])
- **Replace Input Focus Recovery**: Fixed focus interception that prevented typing in replace after opening find/replace. ([a332012])
- **Editor Completion Popup Styling**: Made autocomplete popup theme-aware for dark/light palette consistency. ([a332012])
- **Plugin Frame Messaging Reliability**: Updated editor iframe postMessage target handling for srcDoc scenarios and reduced false-fatal handler escalation on non-fatal parsing/runtime exceptions. ([a332012])
- **Plugins Settings Structure**: Refactored plugin tab rendering into dedicated subcomponents (`PluginsInstalledTab`, `PluginsMarketplaceTab`, `PluginsDeveloperTab`) for better readability and maintenance. ([42c2b66])

### Fixed
- **Runtime Blocking During Local Install**: Moved local plugin installation filesystem work into `spawn_blocking` to avoid blocking async runtime threads. ([5e86529])
- **Conflicting Local-Install Toasts**: Success toast is now gated by plugin-list reload success to avoid warning + success toast conflicts on refresh failure. ([42c2b66])

## [2.9.2] - 2026-04-06

### Added
- **Large Output Artifacts**: Tool outputs exceeding 8 KB are now automatically saved as text files within the session folder, preventing IPC bottlenecks and keeping the chat history lightweight. ([ece9793])
- **Reference-Aware Truncation**: Capped terminal outputs now include a clickable file path reference, allowing the agent to "remember" detailed logs without cluttering the prompt. ([ece9793])

### Changed
- **Thinking Architecture**: Reasoning bubbles are now treated as ephemeral; they are automatically cleared and replaced by the final DONE summary to prevent visual duplication during streaming. ([ece9793])
- **Prompt Privacy**: Tools now return relative `artifacts/` paths, shielding local user directory structures from AI exposure. ([4bd3e05])
- **Session Auditability**: Every AI run—even those that fail during planning or provider calls—now generates a complete session history, eliminating orphaned "ghost" directories. ([4bd3e05])
- **Reliable Checkpoints**: Refactored the "Always Allow" security handler to guarantee a response to the backend, preventing agent hangs if whitelisting fails. ([ece9793])

### Fixed
- **Summary Deduplication**: Eliminated the "echo" effect where streaming models (Groq/Mistral) would repeat their thinking text inside the final completion bubble. ([ece9793])
- **Timestamp Synchronization**: Synchronized `walkthrough.md` generation with the session directory timestamp to ensure log consistency. ([ece9793])
- **Robust IPC**: Added explicit error propagation and logging to `save_artifact` to prevent silent disk-write failures. ([ece9793])
- **Network Resilience**: Added `504 Gateway Timeout` to the list of retryable errors for transient API failures. ([ece9793])
- **Command Persistence**: Fixed a bug where background executors bypassed the truncation layer, potentially crashing the frontend with massive raw strings. ([ece9793])
- **Technical Formatting**: Frontend now automatically detects and highlights technical terms in single quotes (like 'file.js') as inline code. ([ece9793])
- **Done Bubble Alignment**: Fixed status icon positioning in completion bubbles to prevent it from floating in the middle of long summaries. ([ece9793])


## [2.9.1] - 2026-04-05

### Fixed

- **Agent Stop Button**: Wrapped `call_provider` calls in `tokio::select!` with the cancel flag so the Stop button works immediately during AI API calls instead of hanging until the response arrives. ([88bb61a])
- **Brain Session Cleanup**: Clear button now deletes only the current conversation's session folders instead of wiping the entire connection history, preserving other sessions for future history management. ([88bb61a])
- **Brain Path Resolution**: Fixed `ai_clear_brain_sessions` using `app_data_dir()` instead of `get_data_dir()`, which caused clearing to silently fail when a custom data path was configured. ([88bb61a])

### Changed

- **Path Traversal Hardening**: Added `std::fs::canonicalize` to brain session deletion to prevent directory traversal via crafted paths. ([88bb61a])
- **Shared Slug Utility**: Extracted `slugify` from `brain.rs` into a reusable `ai::util` module. ([88bb61a])
- **Agent Store Modularity**: Added `getSessionPaths(scope)` helper to `agentRunStore` to cleanly extract brain session paths from conversation messages. ([88bb61a])

## [2.9.0] - 2026-03-31

### Added

- **Cascading Icon System**: Implemented a 3-tier cascading resolution logic for file icons (Semantic ID → Category Fallback → Lucide) ensuring compatibility with future high-fidelity icon packs. ([ee88b22])
- **Success-Guarded Dynamic Icons**: Introduced an `isLoaded` state guard to hide `<img>` tags until SVG assets are confirmed, completely eliminating broken image placeholders (404s). ([ee88b22])
- **Optimized Batch Deletion**: Introduced localized `fs_delete_batch` with SSH command bundling and SFTP fallback, significantly improving multi-file removal performance. ([ee88b22])
- **Targeted UI Rollback**: Enhanced the File Manager to only restore specific items that failed during a batch operation, preventing unnecessary full-list reverts. ([ee88b22])

### Changed

- **Resilient Remote IPC**: Added 15-second `tokio` timeouts and automatic session reconnection logic to all batch file system operations. ([ee88b22])
- **Monaco Editor Integration**: Successfully migrated from CodeMirror 6 to Monaco Editor for all file editing operations. Features include managed model lifecycles for memory efficiency, URI-based model reuse, and robust dirty-state detection for a seamless "Pro" development experience. ([7f3480e])
- **Local Language Intelligence**: Integrated `@enjoys/context-engine` (v1.8.0) to provide local, zero-backend autocomplete, hover documentation, and definitions for 94+ languages, including improved detection for extensionless files like `Dockerfile` and `Makefile`. ([7f3480e])
- **Expanded AI Providers**: Added support for **Groq** and **Mistral** AI providers (OpenAI-compatible) for ultra-fast command generation and reasoning. ([7f3480e])
- **AI Agent Mode (v2.8.2)**: Introduced a new agentic reasoning engine with a step-by-step planning UI, a terminal feedback loop for automated diagnostics and fixes, and 35+ hardcoded safety rails. ([7f3480e])
- **Package Cleanup**: Removed legacy syntax highlighter and windowing type definitions from `package.json`. ([7f3480e])
- **"Sandwich" Layout Modernization**: Implemented a modern app architecture with a full-width `TabBar` header and a persistent `StatusBar` footer, consolidating global workspace controls into a unified header. ([9aa7d67])
- **Platform-Aware Workspace Shortcuts**: Dashboard search now automatically handles `⌘+P` (Mac) and `Ctrl+P` (Windows/Linux) based on the user's platform. ([9aa7d67])
- **AI Sidebar Migration**: Unified all AI interactions into a persistent, high-performance side panel. ([ad807aa])
- **Flicker-Free Terminal Transitions**: Implemented "Width Pinning" to completely eliminate visual shimmering and text-shaking during sidebar animations and manual resizing. ([ad807aa])

- **Unified AI Shortcut**: Reassigned `Mod+I` to the new sidebar and removed the legacy AI modal. ([ad807aa])
- **Header Layout Optimization**: Reorganized `TabBar` icons to a more logical grouping: `[Left Panel] [AI Assistant] | [Settings]`. ([ad807aa])
- **Technical Hardening & Reliability**: 
    - Refactored Dashboard metrics polling with live store state to prevent desynchronization during tab switching. ([9aa7d67])
    - Optimized React performance through memoization of expensive connection tree sets and event handlers. ([9aa7d67])
    - Hardened IPC robustness by replacing module-level assertions with safe optional chaining in the layout layer. ([9aa7d67])
    - Switched folder interaction logic to idiomatic React state management for consistent drag-and-drop feedback. ([9aa7d67])
- **Sidebar De-cluttering**: Optimized the sidebar by removing redundant footers, maximizing space for connection browsing. ([9aa7d67])
- **Tooltip Flexibility**: Added an optional `dismissOnClick` property for granular interaction control. ([9aa7d67])
- **Audit & Type Safety**: Addressed CodeRabbit findings regarding modal lifecycle guards and type safety in the Tab layer. ([9aa7d67])

## [2.8.1] - 2026-03-25

### Added

- **New File Support**: Added ability to create empty files locally and remotely via SFTP. ([ad0e116])
- **Cascading Context Menus**: Implemented recursive, nested context menus with smart edge-detection positioning. ([ad0e116])
- **File Manager Hardening**: Added pre-emptive existence checks for files/folders before creation or rename to provide clear user-friendly errors. ([ad0e116])

### Changed

- **Smart "Open Terminal Here" Optimization**: Refactored the context menu to check if a terminal is already open at the target path, switching focus without forcing a reload or clearing the terminal history. ([7d8809e])
- The `terminal:navigate` IPC command now only issues a `cd` command to the PTY instead of `cd && clear`. This prevents the entire terminal scroll-back buffer from being wiped out every time the user clicks a new folder in the File Manager while using Synced Mode. ([7d8809e])
- Refactored `initHomeDirectory` in `FileManager.tsx` to automatically supply the active home directory to `ensureTerminal` upon successful connection, improving the reliability of the terminal bootstrap process so it starts natively at the remote directory rather than requiring a post-launch `cd` command. ([7d8809e])
- Updated `ensureTerminal` in `terminalSlice` to return the new terminal ID, enabling better tracking of newly created tabs. ([ad0e116])

### Security & Technical Audit

- **SFTP Command Hardening**: Added 10-second request timeouts and automatic session recovery logic to remote `touch` and `mkdir` operations. ([ad0e116])
- **Audit Remediations**: Addressed all CodeRabbit findings around modal lifecycle management, case-sensitive collisions, and SFTP existence probe resilience. ([bb7f0d9])

### Fixed

- Fixed a bug where creating a new "Synced Terminal" from the background context menu failed to track its `lastKnownCwd`, breaking future path matching operations. ([7d8809e])
- Removed an unnecessary `connectionId` argument from the background context menu's `terminal:navigate` IPC call to align with the core backend signature. ([7d8809e])
- Fixed regression in `CombinedTabBar` dropdown positioning that caused it to overlap active tabs; re-aligned the menu to the left of the actions group so it opens to the right. ([e604f6f])
- **Terminal Navigation Race Condition**: Added `await` to `terminal:navigate` IPC calls in the file manager to prevent store/state sync desynchronization on failure. ([ad0e116])
- **Keyboard Shortcut Guarding**: Resolved issue where global keyboard shortcuts remained active while the "New File" modal was open. ([bb7f0d9])
- **Case-Sensitive Collision Logic**: Reverted to exact equality for local file collision checks to support case-distinct filenames on supported filesystems. ([bb7f0d9])


## [2.8.0] - 2026-03-24

### Added

- **Editor Polish Pass**: Enhanced `FileEditor.tsx` with high-performance "Pro" features.
- **Shell Script Support**: Added syntax highlighting for `.sh`, `.bash`, `.zsh`, and `.fish` files. ([8e7c173])
- **Interactive Status Bar**: Real-time Line/Column, Filesize, and Language tracking using direct DOM refs for zero-render performance. ([21ff87a])
- **Go to Line (Ctrl+G)**: Implementation of a modal and shortcut for fast line migration. ([21ff87a])
- **Search & Replace (Ctrl+F)**: Integrated CodeMirror search panels with a dedicated toolbar button. ([7c0035f])
- **Word Completion**: Buffer-based autocompletion for a lightweight "LSP-lite" typing experience. ([ddb0687])
- **Custom Deletion Modal**: Replaced native browser `confirm()` with a themed `ConfirmModal` in the sidebar, featuring highlighted host and folder names. ([f1aaa84])
- **Tab Bar Layout Refinement**: Fixed `CombinedTabBar` dropdown overlapping active tabs by aligning the menu to the left of the actions group, causing it to open to the right. ([86ea5db])
- **Terminal Enhancements**: Integrated "Open Terminal Here," Session Deduplication, and Synced Terminal mode (live path follow) for a unified CLI/GUI experience. ([c53fde6])

### Security & Technical Audit

- **Secure Terminal Navigation**: Replaced manual `cd` string interpolation with a robust backend-escaped `terminal:navigate` IPC to prevent command injection. ([0dd4487])
- **PTY Reliability**: Hardened error propagation in `pty.rs` to ensure transport failures correctly fail terminal session creation. ([0dd4487])
- **Editor UX Hardening**: Implemented save handler guards and debounced O(N) filesize recomputation for smooth performance in large files. ([0dd4487])
- **Memory Safety**: Added active timer cleanup for editor debounce cycles to prevent leaks on unmount. ([0dd4487])
- **Accessibility Compliance**: Programmatically linked "Go to Line" labels and added `aria-label` descriptors to search controls. ([0dd4487])
- **Type Safety**: Introduced strict interfaces for Sidebar connection items and eliminated `any` types across the layout layer. ([0dd4487])

### Fixed

- **Conflict Modal Guards**: Added re-entrancy protection to prevent duplicate operations during resolution. ([21ff87a])
- **Editor Focus Stability**: Fixed a regression that caused the cursor to disappear or focus to be lost when clicking or moving the pointer. ([21ff87a])
- **State Persistence**: Fixed a bug where the editor would reset to `initialContent` during rapid typing. ([21ff87a])
- **Event Propagation Shield**: Implemented `stopPropagation` on the editor container to prevent parent components from interfering with keyboard events. ([21ff87a])

## [2.7.0] - 2026-03-22

### Added

- **Pro Conflict Resolution Modal**: Implemented a professional collision handler for all file operations (move, copy, paste). Features clear choices (**Overwrite**, **Skip**, **Keep Both**) and native cross-connection support. ([d6f1928])
- **Batch Resolution ("Apply to All")**: Added a "Do this for all remaining conflicts" toggle to the Conflict Modal, allowing users to efficiently resolve multiple collisions in a single action. ([d6f1928])
- **Unified Operation Engine**: Refactored all file movement and duplication logic into a consolidated `executeFileOperations` helper, improving maintainability and ensuring consistent behavior across the entire File Manager. ([b62e613])

### Security

- **Drag-and-Drop Hardening**: Replaced `innerHTML` with `textContent` in drag previews to prevent DOM injection via malicious file names. ([61dc6e8])

### Fixed

- **Atomic Overwrite Protection**: Implemented a safe "Rename-to-Backup -> Move -> Delete-Backup" pattern for all overwrite operations, ensuring no data loss if a move or copy operation fails mid-way. ([82c1612])
- **Multi-File DND Stability**: Resolved a critical bug where drag-and-drop operations on the background or into subfolders would only process the first selected item. Selection-wide batch operations are now fully supported. ([3dc9898])
- **Parallel Collision Detection**: Optimized remote existence checks in the file manager using parallel execution (`Promise.all`), significantly improving performance on high-latency SFTP connections. ([82c1612])
- **Atomic SFTP Renaming**: Hardened the SFTP renaming logic with standard 10s timeout guards, automatic session reconnection, and a secondary backend-powered unique path generator. ([f28e04a])
- **Unique Name Loop Safety**: Prevented potential infinite loops in the duplicate name generator by implementing a 100-attempt safety bail-out with automated user notification and explicit error propagation. ([f28e04a])
- **DRY Refactor**: Extracted a unified `Conflict` type and grouped same-connection operations by `op` type for cleaner batch processing. ([82c1612])
- **Descendant Drop Prevention**: Refactored `onDrop` logic to block invalid move operations where a folder is dropped into its own subdirectory. ([61dc6e8])
- **Dotfile Renaming Truth**: Implemented `splitFileName` to correctly handle collisions for hidden files (e.g., `.env (1)` instead of `. (1).env`). ([61dc6e8])
- **Context Menu Selection**: Synchronized context menu behavior to ensure items are selected on right-click before the menu opens. ([61dc6e8])
- **Animation Polish**: Disabled "closure" layout animations during file movements to prevent visual artifacts and provide instant feedback. ([61dc6e8])

## [2.6.2] - 2026-03-21

### Fixed

- **Terminal Layout Overlap**: Resolved an issue where terminal text was obscured by the bottom status bar by implementing strict structural padding. ([d67c8a8])
- **Snippet Picker Focus Restoration**: Fixed a focus recovery failure when closing the snippet palette by implementing a synchronous blur-and-focus handoff mechanism. ([198b7bf])
- **DRY Refactor**: Consolidated repetitive focus restoration logic in the Snippet Picker into a single maintainable helper. ([198b7bf])
- **Snippet Sidebar Focus**: Aligned the snippet sidebar with the new synchronous focus handoff pattern for consistent reliability. ([4ab273a])

## [2.6.1] - 2026-03-21

### Fixed

- **Terminal Focus Restoration**: Refined snippet overlays to precisely restore keyboard focus back to the terminal shell when closed or when a snippet executes, utilizing transition tracking to eliminate ghost focus events. ([2846afa])

## [2.6.0] - 2026-03-20

### Added

- **Graceful SFTP Disconnect UI**: Replaced generic toasts with a dedicated "Connection Lost" overlay in the File Manager, featuring a prominent "Reconnect" button and stylized `Unplug` icon. ([3f73902])
- **Automated Terminal Recovery**: Implemented a seamless "wakeup" system where reconnecting an SFTP session automatically restarts any associated terminal sessions. ([3f73902])
- **SFTP Network Safeguards**: Added strict 10-second `tokio` timeouts to all remote file system commands (`ls`, `read`, `write`, `mkdir`, `rename`, `delete`, `copy`) to prevent UI hangs during silent network failures. ([3f73902])
- **Snippet Quick Access (`Ctrl+Shift+S`)**: Implemented a high-performance, command-palette-style picker for instant snippet execution with fuzzy search and auto-focus. ([4c923ce])
- **Snippet Sidebar (`Ctrl+Shift+``)**: Added a collapsible sidebar for managing and executing terminal snippets, featuring connection-scoped filtering and category grouping. ([4c923ce])
- **Compact UI Refinement**: Overhauled snippet overlays with a high-density, single-column design, featuring glassmorphism effects, scope-specific icons (Globe/Server), and real-time command previews. ([4c923ce])

### Fixed

- **Atomic SFTP Reconnection**: Eliminated TOCTOU (Time-Of-Check to Time-Of-Use) race conditions in the SFTP manager by consolidating session checks into atomic lock blocks. ([3f73902])
- **Robust Batch Copies**: Refactored the SFTP copy batch logic to use an index-based resume system, ensuring data integrity and preventing duplicate work if a connection drops mid-transfer. ([3f73902])
- **Terminal State Leak**: Added proper session cleanup (`clearPendingInput`, `lastResize`) during shell restarts to ensure fresh state after reconnection. ([3f73902])
- **UI Loading State Leak**: Fixed an issue where a failed SFTP download would leave the `FileManager` stuck in an infinite loading state. ([1dca207])
- **Cross-Platform Pathing**: Implemented strict Windows-to-POSIX path normalization (`\` to `/`) in the paste engine to prevent collision-detection failures. ([e3310ef], [1dca207])
- **SSH Command Deadlocks**: Added missing 10-second `tokio` timeouts to batch renaming and file existence checks, completely preventing UI hangs on dead SSH channels. ([1dca207])
- **Early Return Safety**: Added missing early returns in the `fileSystemSlice` catch blocks to prevent redundant file refresh attempts on disconnected sessions. ([3f73902])
- **Snippet Shortcut Reliability**: Resolved a conflict in `ShortcutManager` where the terminal textarea would block global snippet shortcuts (`Ctrl+Shift+S` and `Ctrl+Shift+``). ([4c923ce])
- **Snippet Scope Persistence**: Fixed a serialization mismatch in `snippets.rs` (CamelCase vs snake_case) that prevented snippet connection scope from persisting across application restarts. ([4c609d6])
- **Snippet Overlay Accessibility**: Added global "Escape" key listener and intelligent auto-focus to ensure snippet views are keyboard-navigable and quickly closable. ([4c923ce])
- **Window Corner & Edge Polish**: Implemented an internal portal root (`ZPortal`) and moved modals, tooltips, and dropdowns to absolute positioning. This preserves the anti-aliased rounded window corners without clipping issues. ([5003999])
- **Transparent Window Artifacts**: Removed the hardcoded black background color (`backgroundColor: "#09090b"`) from the Tauri window configuration, fixing a solid square wrapper appearing around transparent window edges. ([aaf246a])
- **Pointer Event Interactivity**: Fixed a stacking context mismatch in the `FileToolbar`, `SettingsModal`, and `TransferPanel` components by migrating to native click-away listeners and properly attaching refs, preventing invisible backdrops from blocking UI interactions. ([098b8c8])
- **SFTP Transfer Cancellation**: Added a local loading state to prevent concurrent cancellation requests and improved error handling to display descriptive toasts if a cancellation fails. ([9ce71b4])
- **ZPortal Dev Stability**: Removed redundant unmount cleanup in `ZPortal` to eliminate component flickering during React 18 Strict Mode development cycles. ([0d20343])
- **Dialog.Portal Safety**: Added a safe `document.body` fallback to `GlobalConfirmDialog` to prevent crashes when the modal root is not yet mounted. ([3ce4e78])
- **SSH Key File Filter**: Removed the `.pub` extension from the "Add Connection" private key file picker, preventing users from accidentally selecting public keys. ([b64f68d])
- **Toast Accessibility & UI**: Migrated toasts to Zustand state, restored the bottom-center position with rounded window corner compatibility, eliminated the generic `X` icon collision for error states, and added full ARIA live region support (`role="status/alert"`) for screen readers. ([19de065])

### Internal

- **SFTP Stability Audit**: Performed a comprehensive audit of all SFTP and terminal synchronization logic, addressing 7 potential stability failure points. ([3f73902])


## [2.5.5] - 2026-03-08

### Added

- **Atomic Plugin Installation**: Implemented atomic extraction using temporary folders to prevent corrupted states during installs or updates. ([f766ac2])
- **Collision-Free Plugin Naming**: Switched to Base64-hashed directory names to prevent filesystem ID collisions, with automatic legacy folder migration. ([f766ac2])
- **Lazy Loaded Modals**: Modals like `SettingsModal` and `AddTunnelModal` are now lazy-loaded, improving initial bundle size and application startup speed. ([f9e31f4])
- **Glass Empty States**: Improved terminal empty state legibility with high-blur glassmorphism (`backdrop-blur-xl`) when vibrancy is enabled. ([42eeb4c])

### Changed

- **Unified Sidebar Transition**: Overhauled sidebar animation to use a coordinated layout width transition, eliminating visual gaps and sub-pixel desync artifacts. ([bc4ec09])
- **Optimized Sidebar Duration**: Reduced sidebar toggle duration to 300ms for a snappier, more responsive user experience. ([bc4ec09])

### Security

- **Plugin ID Sanitization**: Implemented strict whitelist-based sanitization for plugin directory names to prevent directory traversal attacks. ([f766ac2])
- **Path Traversal Shield**: Hardened plugin asset loading with path canonicalization and strict root-directory validation. ([f766ac2])
- **Plugin Load Error Propagation**: Upgraded plugin loading to strictly propagate filesystem read errors, preventing partially failed plugins from entering an inconsistent active state. ([7048422])
- **SSH Key Decoding Fix**: Fixed a critical bug where encrypted private key passphrases were ignored; implemented robust decoding for all standard OpenSSH formats. ([3df9766])
- **Single-Pass Virtual Agent**: Optimized the virtual agent's key identification response to a single-pass loop, reducing performance overhead and potential timing side-channels. ([3df9766])

### Fixed

- **Terminal Listener Exhaustive Cleanup**: Updated the terminal manager to explicitly unlisten from all tauri event handlers before clearing cleanup timeouts, preventing potential listener leaks. ([7048422])
- **Throttled Terminal Resizing**: Implemented intelligent resize throttling for xterm.js instances to prevent layout thrashing and maintain 60FPS during UI transitions. ([bc4ec09])

### Internal

- **Code Polish**: Refined log macro imports, optimized SSH config helper scope, and unified terminal session refs per security audit feedback. ([7048422],[0b4e9f8])

## [2.5.4] - 2026-03-07

### Added

- **Terminal Startup Handshake**: Implemented a deterministic signal (`terminal-ready`) between Rust and React to ensure initial commands sent to new tabs (like PM2 logs) wait precisely for the PTY to be ready. ([#38])
- **Handshake Safety Timeout**: Added a 5-second automatic fallback and full listener cleanup to the terminal handshake to prevent stalled connections from leaking memory. ([#38])
- **Portalled Tooltips**: Migrated the `Tooltip` component to use React Portals, resolving all clipping and z-index overlap issues project-wide. ([#38])
- **Sidebar Header Redesign**: Polished the sidebar header and "+" dropdown menu with better spacing and clipping fixes. ([#38])
- **Dynamic Theme Accent Synchronization**: Implemented intelligent accent color reset logic—choosing a new theme now automatically updates the app accent to match the theme's default. ([#38])
- **Stable Theme Default Swatch**: Added a dedicated "Theme Default" swatch in settings that accurately reflects the original theme color even when a custom accent is active, using plugin manifest metadata. ([#38])

### Changed

- **Terminal-Only Transparency Scope**: Kept the full app shell opaque and limited transparency effects to the terminal viewport path so sidebars, chrome, and feature tabs remain stable. ([#38])
- **Terminal Opacity UX**: Updated appearance behavior so the terminal opacity slider is continuously applied instead of behaving like a binary on/off toggle below 100%. ([#38])
- **Accent-Aware Terminal Branding**: ANSI Yellow and Bright Yellow colors in the terminal now dynamically map to the active application accent color for a unified brand experience. ([#38])

### Security

- **Virtual Agent Key Registration**: Delayed SSH private key registration until after successful handshake to prevent pre-auth key leakage. ([#38])
- **OOM Protection**: Added a 256KB sanity cap to Virtual Agent packet frames to prevent malicious server-side memory exhaustion. ([#38])
- **Plugin ID Sanitization**: Implemented strict whitelist-based sanitization for plugin directory names to prevent directory traversal attacks. ([#38])
- **Path Traversal Shield**: Hardened plugin asset loading with path canonicalization and strict root-directory validation. ([#38])
- **SSH Key Decoding Fix**: Fixed a critical bug where encrypted private key passphrases were ignored; implemented robust decoding for all standard OpenSSH formats. ([#38])
- **Single-Pass Virtual Agent**: Optimized the virtual agent's key identification response to a single-pass loop, reducing performance overhead and potential timing side-channels. ([#38])

### Fixed

- **PTY Deadlock**: Fixed a critical backend deadlock in `pty.rs` where the global session mutex was being held across asynchronous I/O operations. ([#38])
- **Terminal Event Leak**: Resolved a memory leak in `Terminal.tsx` where Tauri event listeners were not being fully unregistered when closing tabs. ([#38])
- **Terminal Recreation**: Fixed logic errors that previously prevented terminal tabs from being "Restarted" after their backend session exited. ([#38])
- **Remote Exit Events**: Ensured SSH sessions correctly emit exit events so the frontend recognized remote channel terminations. ([#38])
- **Settings Toggle Accessibility**: Refactored the `Toggle` component to use semantic HTML specifically for keyboard and screen-reader compliance. ([#38])
- **Sidebar Resize Stale Closure**: Fixed a bug that caused outdated sidebar width values to be saved when resizing. ([#38])
- **Race Condition Safety**: Fixed potential double command execution if the terminal-ready signal and safety timeout collided. ([#38])
- **Terminal Interactivity Hot Path**: Reduced IPC/event burst pressure with short input and output batching so high-frequency typing and echo behavior feel smoother on remote sessions. ([#38])
- **Resize Event Noise**: Deduplicated repeated terminal resize sends when rows/cols are unchanged. ([#38])
- **Hidden Dashboard Polling**: Prevented background metric polling traffic while the dashboard tab is not visible. ([#38])
- **Window Edge Artifacts**: Removed bright edge bleed in dark themes after transparency path cleanup. ([#38])
- **Terminal Color Compatibility**: Replaced the CSS `color-mix()` function with a manual hex blending helper to ensure custom accent colors render correctly across all xterm.js renderers and Node.js environments. ([#38])
- **Transparency Over-Exposure**: Fixed a bug where terminal loading and error states inherited transparency; these states now maintain a solid background for readability until the session is active. ([#38])
- **spawn_blocking Handle Safety**: Fixed backend emit path to use the cloned app handle inside blocking closures. ([#38])
- **Tunnel State Synchronization**: Ensured remote tunnel entries are only removed if server-side cancellation succeeds, preventing stale "active" tunnels from polluting internal maps. ([#38])
- **Plugin State Robustness**: Implemented proper error propagation for plugin JSON loading to prevent silent state loss or over-writes during I/O failures. ([#38])
- **SSH Config Comment Parsing**: Added quote-aware and escape-aware inline comment stripping for `ssh_config` properties to prevent parsing errors on lines with trailing comments. ([#38])
- **Sidebar Resize Stale Context**: Synchronized `widthRef.current` updates to prevent stale sidebar settings during fast resizing or external sync events. ([#38])
- **Terminal Vibrancy Consistency**: Fixed empty terminal states where the background incorrectly remained opaque even when vibrancy was enabled. ([#38])
- **Tab-Switch Command Persistence**: Fixed a bug where switching tabs during a connection handshake could prematurely clear the `terminal-ready` signal. ([#38])
- **Tooltip Keyboard Accessibility**: Added focus and blur event handlers to tooltips for full keyboard navigation and screen-reader support. ([#38])

## [2.5.3] - 2026-03-06

### Added

- **AI Panel Draggability**: Made the AI Command Bar fully draggable so it can be repositioned across the window without obstructing terminal views.
- **Theme-Aware Boot Splash**: Added startup splash color persistence so boot visuals now match the active theme (including plugin-provided themes) instead of defaulting to built-in palettes.

### Changed

- **Prompt Restructuring**: Replaced the underlying JSON parsing model with a lightweight TOON prompt structure to prevent string escaping bugs and improve streaming animation performance.
- **Window Rendering Policy**: Switched to opaque-by-default shell rendering and applied translucency only when vibrancy is explicitly enabled.
- **Sidebar Header Refresh**: Refined the sidebar header hierarchy with a cleaner one-line title layout, compact action grouping, and host count metadata.
- **Release Notes Reader Polish**: Upgraded markdown rendering with GFM support, unified TOC/heading slug generation, and tighter content spacing for better readability.

### Fixed

- **Ollama Integration**: Fixed model name mappings causing selected Ollama local endpoint models to fail during AI invocation.
- **Transparent Edge Artifacts**: Removed window edge halo/bleed effects by tightening shell background behavior and frame styling.
- **Startup Black Flash**: Eliminated the pre-splash black frame by delaying main window visibility until the webview page load is ready.
- **Sidebar Toggle Alignment**: Fixed collapsed-sidebar toggle alignment and matched its control sizing/states with surrounding tab controls.
- **Theme Color Validation**: Hardened boot-splash theme color parsing to prevent invalid or malicious CSS injections from local storage (`index.html`).
- **Startup Splash Resilience**: Wrapped the boot splash removal in a `try...finally` block to guarantee fallback execution even if the global window function throws an error (`MainLayout.tsx`).
- **AI Response Consistency**: Made the TOON parser case-insensitive for `type` fields to better handle unpredictable LLM casing like "Chat" vs "chat" (`toon.rs`).
- **AI History Scoping**: Fixed a bug where clearing the AI command prompt history cleared all terminal tabs instead of just the active one, and fixed a deduplication flaw where differing explanations were dropped (`AiCommandBar.tsx`).
- **Accessibility**: Reverted `menu` and `menuitem` ARIA roles on the Sidebar "Add New" dropdown to native button semantics to prevent screen reader dead-ends since full keyboard navigation is not yet supported.


## [2.5.2] - 2026-03-04

### Fixed

- **Settings Integration**: Clicking the "What's New" button in the Settings > About panel now opens the dedicated in-app Release Notes tab instead of an inline markdown preview.
- **Release Notes Auto-Open**: Fixed a bug where the "What's New" tab failed to open after an update; now reliably detects updates using a trusted installation flag instead of cached disk settings.
- **TOC Scroll-Spy**: Corrected the placement of HTML IDs in the Release Notes viewer so the sidebar Table of Contents scroll-spy accurately highlights the active section.
- **Code Block Reliability**: Enhanced the markdown parser's block detection to prevent inline code fragments with newlines from being incorrectly rendered as expanding fenced code blocks.
- **Copy Button Leaks**: Resolved a React state unmount leak in the CodeBlock copy button by properly clearing timeouts and handling clipboard write errors.
- **Dropdown UX**: Added an outside-click listener to the version history dropdown so it automatically closes when clicking elsewhere on the screen.
- **AI Error Classification**: Improved error parsing logic so backend messages containing both "disabled" and "connection" are correctly categorized as Disabled rather than Connection Error.
- **AI Ollama Hints**: Added specific error classification and actionable "pull" hints when selected Ollama models are not found on the local host.
- **AI Streaming UX**: Implemented a real-time JSON streaming parser in the Command Bar to hide raw JSON boilerplate (keys/quotes) while the model is generating responses.
- **System Dashboard Metrics**: Fixed "missing terminator" errors on Windows Local by resolving redundant PowerShell wrapping and quote escaping desync.
- **UI Dragging**: Fixed the missing drag-and-drop overlay icon for the "What's New" tab.

## [2.5.1] - 2026-03-03

### Added

- **"What's New" Tab**: On first launch after an update, Zync automatically opens a dedicated "What's New" tab inside the main workspace — showing the current release notes formatted and fetched live from GitHub. The tab appears exactly once per version bump and never again after being seen.
- **Release Notes Viewer**: A built-in release notes reader featuring a version history dropdown (browse the 10 most recent releases), auto-generated sticky Table of Contents with scroll-spy, colorful section badges (`Added`, `Fixed`, `Security`, etc.), syntax-highlighted code blocks with one-click copy buttons, and a live hero header showing the version and release date.
- **Version History**: Users can browse and read release notes for any past version directly from within the app via the version dropdown in the "What's New" tab.

### Fixed

- **AI Setting Override**: Added strict backend validation to prevent AI command execution when AI is disabled in user settings.
- **AI UX**: Added a dedicated "Enable AI Features" toggle in Settings to control the feature, and replaced the raw "Error" alert with a friendly "AI is disabled" info box with a Settings shortcut.
- **AI Privacy Enforcement**: Prevented sensitive raw terminal output from leaking to third-party providers by implementing explicit opt-in blocks and aggressive redaction regex for tokens and passwords.
- **Keyboard Navigation**: Fixed modal arrow-key navigation desyncing from the sidebar by properly registering the 'plugins' and 'ai' tabs.
- **Code Quality**: Resolved Biome lint warnings (`useIterableCallbackReturn`) and trailing space MarkdownLint errors (`MD038`).

## [2.5.0] - 2026-03-01

### Added

- **AI Command Bar** (`Ctrl+I`): Natural-language to shell command translation powered by Ollama, Gemini, OpenAI, and Claude — press `Ctrl+I` in any terminal session, describe what you want, and the command is generated ready to execute
- **Streaming Responses**: AI responses stream token-by-token with a typewriter cursor instead of waiting for the full response
- **Dual-mode AI**: Automatically detects intent — command requests return an executable shell command; questions and explanations return a prose answer. No mode switching required
- **Chat Interface**: Full conversation history within each session; previous Q&A pairs are preserved above the current response with user bubbles (right) and AI responses (left)
- **Query History Navigation**: Arrow Up/Down cycles through past queries; position badge shows current index (N/M); recent queries appear as clickable chips when the input is focused and empty
- **Editable Commands**: AI-generated commands are editable inline in a terminal-style `$` block before executing; an "edited" indicator appears when the command has been modified
- **Safety Classification**: Each command is classified as `SAFE`, `MODERATE`, or `DANGEROUS` with a color-coded badge and explanation; dangerous commands require an explicit "Run anyway" confirmation
- **Save to Snippets**: Bookmark any AI-generated command directly to the Snippets panel under the "AI Generated" category
- **Retry & Make Safer**: Re-run the same query or re-submit with a safety-first instruction to get a less destructive alternative
- **Provider & Model Selection**: Switch AI provider (Ollama / Gemini / OpenAI / Claude) and model without leaving the command bar; unconfigured providers are shown with a setup indicator
- **Contextual Awareness**: Sends current OS, shell, working directory, and recent terminal output as context so commands are accurate for the active session

## [2.4.1] - 2026-02-28

### Fixed

- **Windows Port Forwarding**: Fixed tunnel add button not working on Windows — decorative grid overlay was missing `pointer-events-none`, intercepting all clicks in the modal's visual flow header on WebView2
- **Port Validation**: Added missing `isNaN(remotePort)` check that allowed invalid port values through silently
- **Modal Select Dropdown**: Target Server dropdown now uses portal mode to render above the Modal's stacking context, fixing z-index clipping on WebView2
- **Modal Background**: Increased overlay opacity and made panel fully opaque as fallback for WebView2 where `backdrop-blur` can fail silently
- **Button Types**: Added explicit `type="button"` to Cancel and Save buttons to prevent form submission edge cases

### Changed

- Migrated all repository URLs from personal repo to `zync-sh` GitHub organization
- Updated CI/CD workflow permissions for organization context

## [2.4.0] - 2026-02-27

### Added

- **Native OS Drag & Drop Upload**: File uploads now use Rust-level Tauri drag-drop events (`zync://file-drop`) instead of WebView HTML5 drops, providing reliable cross-platform behavior with deduplication guard
- **Download as Archive (.tar.gz)**: Select multiple remote files/directories and download them as a single `.tar.gz` archive streamed directly over SSH exec — no temp files on the server
- **Status Bar Transfer Indicator**: Nautilus/Finder-style circular pie progress in the status bar replaces the old floating overlay; click to expand a dropdown panel with full transfer details
- **Transfer Tooltips**: Brief contextual tooltips above the status bar indicator when transfers start or complete
- **Archive Button in Toolbar**: Quick-access toolbar button to download selected items as `.tar.gz`

### Changed

- Transfer progress moved from fixed bottom-right overlay (`TransferManager`) to an integrated status bar component with portaled dropdown panel
- Transfer notifications replaced with inline tooltips and panel feedback (no more toast spam during file operations)
- Speed calculation improved with EMA-smoothed windowed measurement using `speedBaseline` tracking for accurate throughput display
- Transfer completion uses two-phase animation (snap progress to 100%, then transition to completed state) for smooth visual feedback
- Drag-and-drop handler simplified: OS file drops routed through Tauri events, server-to-server drops handled via JSON data transfer

### Fixed

- Transfer speed jitter caused by using per-event byte deltas instead of windowed baseline measurement
- Upload progress reporting removed unused `file_size` / `file_metadata` / `file_transferred` variables in Rust backend
- Deprecated `substr` replaced with `substring` in transfer ID generation
- Removed stale `console.log` statements from transfer event handlers
- Added ARIA attributes (`aria-label`, `aria-expanded`) to transfer indicator for screen reader accessibility

- **Windows WSL terminal**: `-i` (interactive) flag no longer passed to `wsl.exe` which doesn't support it, fixing terminal launch failures on Windows with WSL shell (contributed by [@coderboyakashemertech](https://github.com/coderboyakashemertech))

## [2.3.1] - 2026-02-23

### Added
- **Official APT Repository**: Debian and Ubuntu users can now install and automatically update Zync alongside their system packages via our new APT repository (`apt-get install zync`), as an alternative to the built-in AppImage auto-updater. Read the [full installation guide here](https://zync.thesudoer.in/docs).
- **CI/CD Pipeline Integration**: The repository is fully automated via GitHub Actions using `reprepro`, securely mapping `.deb` binaries to the `gh-pages` branch with headless GPG batch signing.

## [2.3.0] - 2026-02-22

### Added

- **Plugin Panel API**: Sandboxed panel rendering engine; plugins can register HTML/JS/CSS payloads via `zync.panel.register` and render in isolated iframes with `postMessage` bridge
- **Dynamic Tab Routing**: Support for `plugin:<id>` view routes alongside standard SSH connection tabs
- **PM2 Monitor Plugin**: Process management dashboard with real-time telemetry, lifecycle actions (Stop/Start/Restart), bulk selections, and process inspector modal
- **Native Global Confirmation Dialog**: Theme-aware `GlobalConfirmDialog` replacing `window.confirm()`; accessible via Zustand state or `zync.ui.confirm`
- **Unified Settings & Marketplace**: Merged Plugins and Marketplace into a single compact view with deferred restart lifecycle (no forced reload during plugin install/update/uninstall)
- **Expanded Theme Library**: New dark themes (Synthwave, Nordic, Monokai Pro, Dracula, Tokyo Night) and refined light themes (Modern Light, Clean Light, Warm Light)
- **Marketplace Thumbnails**: Support for remote `thumbnailUrl` in registry with Lucide SVG fallback on load failure
- **Dedicated Extensions Repository**: [zync-extensions](https://github.com/zync-sh/zync-extensions) as central source and marketplace registry

### Changed

- Settings interface refactored for clearer plugin lifecycle and visual hierarchy
- Terminal copy/paste re-engineered to use Tauri native `plugin-clipboard-manager`, bypassing webview clipboard restrictions
- Extension manifest signatures standardized to reverse-DNS format (`com.zync.plugin.*`)
- `TerminalManager` refactored as centralized router for `zync:terminal:send` events

### Fixed

- Terminal IPC race conditions and `DataCloneError` during cross-context messaging
- Terminal commands from plugins now correctly routed to active connection instead of hidden panes
- Global shortcut collision: `Ctrl+Shift+C` / `Ctrl+Shift+V` no longer swallowed by xterm.js hidden textareas
- Z-index collisions between `GlobalConfirmDialog` and `SettingsModal`
- Light theme contrast and invisible text clipping in modals
- Extension registry detection mismatch (Marketplace prompting to install already-active extensions)

### Deprecated

- `window.confirm()` in favor of integrated `GlobalConfirmDialog`

---

## [2.2.1] - 2026-02-16

### Added

- SSH client with connection management
- SFTP file manager with drag-and-drop
- Local and remote SSH tunnel management
- Integrated terminal with xterm.js
- Command palette and keyboard shortcuts
- Auto-updates
- Multiple themes (Dark, Light, Dracula)

[Unreleased]: https://github.com/zync-sh/zync/compare/v2.15.0...HEAD
[#38]: https://github.com/zync-sh/zync/pull/38
[f766ac2]: https://github.com/zync-sh/zync/commit/f766ac2
[3df9766]: https://github.com/zync-sh/zync/commit/3df9766
[7048422]: https://github.com/zync-sh/zync/commit/7048422
[f9e31f4]: https://github.com/zync-sh/zync/commit/f9e31f4
[0b4e9f8]: https://github.com/zync-sh/zync/commit/0b4e9f8
[42eeb4c]: https://github.com/zync-sh/zync/commit/42eeb4c
[bc4ec09]: https://github.com/zync-sh/zync/commit/bc4ec09
[5003999]: https://github.com/zync-sh/zync/commit/5003999
[aaf246a]: https://github.com/zync-sh/zync/commit/aaf246a
[9ce71b4]: https://github.com/zync-sh/zync/commit/9ce71b4
[3ce4e78]: https://github.com/zync-sh/zync/commit/3ce4e78
[b64f68d]: https://github.com/zync-sh/zync/commit/b64f68d
[19de065]: https://github.com/zync-sh/zync/commit/19de065
[0d20343]: https://github.com/zync-sh/zync/commit/0d20343
[098b8c8]: https://github.com/zync-sh/zync/commit/098b8c8
[2846afa]: https://github.com/zync-sh/zync/commit/2846afa
[d6f1928]: https://github.com/zync-sh/zync/commit/d6f1928
[b62e613]: https://github.com/zync-sh/zync/commit/b62e613
[61dc6e8]: https://github.com/zync-sh/zync/commit/61dc6e8
[82c1612]: https://github.com/zync-sh/zync/commit/82c1612
[f28e04a]: https://github.com/zync-sh/zync/commit/f28e04a
[3dc9898]: https://github.com/zync-sh/zync/commit/3dc9898
[8e7c173]: https://github.com/zync-sh/zync/commit/8e7c173
[ddb0687]: https://github.com/zync-sh/zync/commit/ddb0687
[7c0035f]: https://github.com/zync-sh/zync/commit/7c0035f
[21ff87a]: https://github.com/zync-sh/zync/commit/21ff87a
[f1aaa84]: https://github.com/zync-sh/zync/commit/f1aaa84
[86ea5db]: https://github.com/zync-sh/zync/commit/86ea5db
[c53fde6]: https://github.com/zync-sh/zync/commit/c53fde6
[0dd4487]: https://github.com/zync-sh/zync/commit/0dd4487
[7d8809e]: https://github.com/zync-sh/zync/commit/7d8809e
[e604f6f]: https://github.com/zync-sh/zync/commit/e604f6f
[ad0e116]: https://github.com/zync-sh/zync/commit/ad0e116
[bb7f0d9]: https://github.com/zync-sh/zync/commit/bb7f0d9
[7f3480e]: https://github.com/zync-sh/zync/commit/7f3480e
[9aa7d67]: https://github.com/zync-sh/zync/commit/9aa7d67
[ad807aa]: https://github.com/zync-sh/zync/commit/ad807aa
[88bb61a]: https://github.com/zync-sh/zync/commit/88bb61a
[ece9793]: https://github.com/zync-sh/zync/commit/ece9793
[4bd3e05]: https://github.com/zync-sh/zync/commit/4bd3e05
[a9afb01]: https://github.com/zync-sh/zync/commit/a9afb01
[a332012]: https://github.com/zync-sh/zync/commit/a332012
[5e86529]: https://github.com/zync-sh/zync/commit/5e86529
[42c2b66]: https://github.com/zync-sh/zync/commit/42c2b66
[2a16938]: https://github.com/zync-sh/zync/commit/2a16938
[b9e726f]: https://github.com/zync-sh/zync/commit/b9e726f
[bd73a72]: https://github.com/zync-sh/zync/commit/bd73a72
[1dfe5f3]: https://github.com/zync-sh/zync/commit/1dfe5f3
[d2a50c3]: https://github.com/zync-sh/zync/commit/d2a50c3
[088fdf9]: https://github.com/zync-sh/zync/commit/088fdf9
[fd1107c]: https://github.com/zync-sh/zync/commit/fd1107c
[5c7afc3]: https://github.com/zync-sh/zync/commit/5c7afc3
[64cb56a]: https://github.com/zync-sh/zync/commit/64cb56a
[636db7a]: https://github.com/zync-sh/zync/commit/636db7a
[a2dffb7]: https://github.com/zync-sh/zync/commit/a2dffb7
[c87e3d7]: https://github.com/zync-sh/zync/commit/c87e3d7
[5d4f87f]: https://github.com/zync-sh/zync/commit/5d4f87f
[b4e8078]: https://github.com/zync-sh/zync/commit/b4e8078
[dff03a1]: https://github.com/zync-sh/zync/commit/dff03a1
[a20af8c]: https://github.com/zync-sh/zync/commit/a20af8c
[4e589d9]: https://github.com/zync-sh/zync/commit/4e589d9
[f174726]: https://github.com/zync-sh/zync/commit/f174726
[dae1856]: https://github.com/zync-sh/zync/commit/dae1856
[d049d01]: https://github.com/zync-sh/zync/commit/d049d01
[648102c]: https://github.com/zync-sh/zync/commit/648102c
[2de6066]: https://github.com/zync-sh/zync/commit/2de6066
[ad0aea5]: https://github.com/zync-sh/zync/commit/ad0aea5
[ef6f9eb]: https://github.com/zync-sh/zync/commit/ef6f9eb
[7f9c425]: https://github.com/zync-sh/zync/commit/7f9c425
[8dfe727]: https://github.com/zync-sh/zync/commit/8dfe727
[e70f7a0]: https://github.com/zync-sh/zync/commit/e70f7a0
[e7f4f02]: https://github.com/zync-sh/zync/commit/e7f4f02
[c9e8345]: https://github.com/zync-sh/zync/commit/c9e8345
[da93f23]: https://github.com/zync-sh/zync/commit/da93f23
[bb42e1c]: https://github.com/zync-sh/zync/commit/bb42e1c
[9958c44]: https://github.com/zync-sh/zync/commit/9958c44
[e1d6109]: https://github.com/zync-sh/zync/commit/e1d6109
[9f41e0f]: https://github.com/zync-sh/zync/commit/9f41e0f
[2ef1c90]: https://github.com/zync-sh/zync/commit/2ef1c90
[a5a25ef]: https://github.com/zync-sh/zync/commit/a5a25ef
[4104e34]: https://github.com/zync-sh/zync/commit/4104e34
[cea3fa0]: https://github.com/zync-sh/zync/commit/cea3fa0
[dd13dcf]: https://github.com/zync-sh/zync/commit/dd13dcf
[53aeb1f]: https://github.com/zync-sh/zync/commit/53aeb1f
[817ccb6]: https://github.com/zync-sh/zync/commit/817ccb6
[1c519b2]: https://github.com/zync-sh/zync/commit/1c519b2
[8faf6ef]: https://github.com/zync-sh/zync/commit/8faf6ef
[2.15.0]: https://github.com/zync-sh/zync/compare/v2.14.1...v2.15.0
[2.14.1]: https://github.com/zync-sh/zync/compare/v2.14.0...v2.14.1
[2.14.0]: https://github.com/zync-sh/zync/compare/v2.13.2...v2.14.0
[2.13.2]: https://github.com/zync-sh/zync/compare/v2.13.1...v2.13.2
[2.13.1]: https://github.com/zync-sh/zync/compare/v2.13.0...v2.13.1
[2.13.0]: https://github.com/zync-sh/zync/compare/v2.12.0...v2.13.0
[2.12.0]: https://github.com/zync-sh/zync/compare/v2.11.1...v2.12.0
[2.11.1]: https://github.com/zync-sh/zync/compare/v2.11.0...v2.11.1
[2.11.0]: https://github.com/zync-sh/zync/compare/v2.10.1...v2.11.0
[2.10.1]: https://github.com/zync-sh/zync/compare/v2.10.0...v2.10.1
[2.10.0]: https://github.com/zync-sh/zync/compare/v2.9.2...v2.10.0
[2.9.2]: https://github.com/zync-sh/zync/compare/v2.9.1...v2.9.2
[2.9.1]: https://github.com/zync-sh/zync/compare/v2.9.0...v2.9.1
[2.9.0]: https://github.com/zync-sh/zync/compare/v2.8.1...v2.9.0
[2.8.1]: https://github.com/zync-sh/zync/compare/v2.8.0...v2.8.1
[2.8.0]: https://github.com/zync-sh/zync/compare/v2.7.0...v2.8.0
[2.7.0]: https://github.com/zync-sh/zync/compare/v2.6.0...v2.7.0
[2.6.2]: https://github.com/zync-sh/zync/compare/v2.6.1...v2.6.2
[2.6.1]: https://github.com/zync-sh/zync/compare/v2.6.0...v2.6.1
[2.6.0]: https://github.com/zync-sh/zync/compare/v2.5.5...v2.6.0
[2.5.5]: https://github.com/zync-sh/zync/compare/v2.5.4...v2.5.5
[2.5.4]: https://github.com/zync-sh/zync/compare/v2.5.3...v2.5.4
[2.5.3]: https://github.com/zync-sh/zync/compare/v2.5.2...v2.5.3
[2.5.2]: https://github.com/zync-sh/zync/compare/v2.5.1...v2.5.2
[2.5.1]: https://github.com/zync-sh/zync/compare/v2.5.0...v2.5.1
[2.5.0]: https://github.com/zync-sh/zync/compare/v2.4.1...v2.5.0
[2.4.1]: https://github.com/zync-sh/zync/compare/v2.4.0...v2.4.1
[2.4.0]: https://github.com/zync-sh/zync/compare/v2.3.1...v2.4.0
[2.3.1]: https://github.com/zync-sh/zync/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/zync-sh/zync/compare/v2.2.1...v2.3.0
[2.2.1]: https://github.com/zync-sh/zync/releases/tag/v2.2.1

