# Changelog

All notable changes to Zync are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/zync-sh/zync/compare/v2.4.0...HEAD
[2.4.0]: https://github.com/zync-sh/zync/compare/v2.3.1...v2.4.0
[2.3.1]: https://github.com/zync-sh/zync/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/zync-sh/zync/compare/v2.2.1...v2.3.0
[2.2.1]: https://github.com/zync-sh/zync/releases/tag/v2.2.1
