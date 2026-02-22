# Changelog

All notable changes to Zync are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Plugin Panel API**: Sandboxed panel rendering engine; plugins can register HTML/JS/CSS payloads via `zync.panel.register` and render in isolated iframes with `postMessage` bridge
- **Dynamic Tab Routing**: Support for `plugin:<id>` view routes alongside standard SSH connection tabs
- **PM2 Monitor Plugin**: Process management dashboard with real-time telemetry, lifecycle actions (Stop/Start/Restart), bulk selections, and process inspector modal
- **Native Global Confirmation Dialog**: Theme-aware `GlobalConfirmDialog` replacing `window.confirm()`; accessible via Zustand state or `zync.ui.confirm`
- **Unified Settings & Marketplace**: Merged Plugins and Marketplace into a single compact view with deferred restart lifecycle (no forced reload during plugin install/update/uninstall)
- **Expanded Theme Library**: New dark themes (Synthwave, Nordic, Monokai Pro, Dracula, Tokyo Night) and refined light themes (Modern Light, Clean Light, Warm Light)
- **Marketplace Thumbnails**: Support for remote `thumbnailUrl` in registry with Lucide SVG fallback on load failure
- **Dedicated Extensions Repository**: [zync-extensions](https://github.com/gajendraxdev/zync-extensions) as central source and marketplace registry

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

[Unreleased]: https://github.com/gajendraxdev/zync/compare/v2.2.1...HEAD
[2.2.1]: https://github.com/gajendraxdev/zync/releases/tag/v2.2.1
