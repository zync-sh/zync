# Changelog

All notable changes to Zync are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Pro Conflict Resolution Modal**: Implemented a professional collision handler for all file operations (move, copy, paste). Features clear choices (**Overwrite**, **Skip**, **Keep Both**) and native cross-connection support. ([unreleased])
- **Batch Resolution ("Apply to All")**: Added a "Do this for all remaining conflicts" toggle to the Conflict Modal, allowing users to efficiently resolve multiple collisions in a single action. ([unreleased])
- **Unified Operation Engine**: Refactored all file movement and duplication logic into a consolidated `executeFileOperations` helper, improving maintainability and ensuring consistent behavior across the entire File Manager. ([unreleased])

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

[Unreleased]: https://github.com/zync-sh/zync/compare/v2.6.1...HEAD
[2.6.1]: https://github.com/zync-sh/zync/compare/v2.6.0...v2.6.1
[2.6.0]: https://github.com/zync-sh/zync/compare/v2.5.5...v2.6.0
[2.5.5]: https://github.com/zync-sh/zync/compare/v2.5.4...v2.5.5
[2.5.4]: https://github.com/zync-sh/zync/compare/v2.5.3...v2.5.4
[2.5.3]: https://github.com/zync-sh/zync/compare/v2.5.2...v2.5.3
[#38]: https://github.com/zync-sh/zync/pull/38
[f766ac2]: https://github.com/zync-sh/zync/commit/f766ac2
[3df9766]: https://github.com/zync-sh/zync/commit/3df9766
[7048422]: https://github.com/zync-sh/zync/commit/7048422
[f9e31f4]: https://github.com/zync-sh/zync/commit/f9e31f4
[0b4e9f8]: https://github.com/zync-sh/zync/commit/0b4e9f8
[42eeb4c]: https://github.com/zync-sh/zync/commit/42eeb4c
[bc4ec09]: https://github.com/zync-sh/zync/commit/bc4ec09
[2.5.2]: https://github.com/zync-sh/zync/compare/v2.5.1...v2.5.2
[2.5.1]: https://github.com/zync-sh/zync/compare/v2.5.0...v2.5.1
[2.5.0]: https://github.com/zync-sh/zync/compare/v2.4.1...v2.5.0
[2.4.1]: https://github.com/zync-sh/zync/compare/v2.4.0...v2.4.1
[2.4.0]: https://github.com/zync-sh/zync/compare/v2.3.1...v2.4.0
[2.3.1]: https://github.com/zync-sh/zync/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/zync-sh/zync/compare/v2.2.1...v2.3.0
[2.2.1]: https://github.com/zync-sh/zync/releases/tag/v2.2.1
[5003999]: https://github.com/zync-sh/zync/commit/5003999
[aaf246a]: https://github.com/zync-sh/zync/commit/aaf246a
[9ce71b4]: https://github.com/zync-sh/zync/commit/9ce71b4
[3ce4e78]: https://github.com/zync-sh/zync/commit/3ce4e78
[b64f68d]: https://github.com/zync-sh/zync/commit/b64f68d
[19de065]: https://github.com/zync-sh/zync/commit/19de065
[0d20343]: https://github.com/zync-sh/zync/commit/0d20343
[098b8c8]: https://github.com/zync-sh/zync/commit/098b8c8
[2846afa]: https://github.com/zync-sh/zync/commit/2846afa


