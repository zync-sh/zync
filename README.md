<div align="center">
  <br />
  <img src="assets/banner.svg" alt="Zync Banner" width="800" />
  <br /><br />

  <p>
    <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>&nbsp;
    <a href="https://github.com/zync-sh/zync/releases"><img src="https://img.shields.io/github/v/release/zync-sh/zync?include_prereleases" alt="Version" /></a>&nbsp;
    <a href="https://github.com/zync-sh/zync/releases"><img src="https://img.shields.io/badge/platform-Linux%20%7C%20Windows%20%7C%20macOS-lightgrey" alt="Platform" /></a>&nbsp;
    <a href="https://github.com/zync-sh/zync"><img src="https://img.shields.io/github/stars/zync-sh/zync?style=social" alt="GitHub Stars" /></a>
  </p>

  <p>
    <a href="https://zync.thesudoer.in">Website</a>&nbsp;&nbsp;•&nbsp;&nbsp;
    <a href="https://github.com/zync-sh/zync/releases">Releases</a>&nbsp;&nbsp;•&nbsp;&nbsp;
    <a href="#installation">Installation</a>&nbsp;&nbsp;•&nbsp;&nbsp;
    <a href="#development">Development</a>&nbsp;&nbsp;•&nbsp;&nbsp;
    <a href="#extensions">Extensions</a>&nbsp;&nbsp;•&nbsp;&nbsp;
    <a href="#contributing">Contributing</a>&nbsp;&nbsp;•&nbsp;&nbsp;
    <a href="#changelog">Changelog</a>
  </p>
  <br />
</div>

---

Zync is a powerful, cross-platform SSH client built for speed, security, and aesthetics. Rebuilt from the ground up using **Rust** and **Tauri**, it delivers a native desktop experience with minimal resource usage and maximum performance—ideal for developers, system administrators, and power users who demand a reliable SSH workflow.

## Key Features

| Feature | Description |
|---------|-------------|
| **Native Performance** | Blazing-fast startup, low memory footprint, and efficient resource utilization |
| **SSH Tunneling** | Manage local and remote SSH tunnels with an intuitive, visual interface |
| **SFTP File Manager** | Full SFTP support with drag-and-drop, CRUD operations, and remote file handling |
| **Integrated Terminal** | Built-in xterm.js-based terminal with syntax highlighting for multiple languages |
| **Productivity** | System-level keyboard shortcuts and command palette (⌘K / Ctrl+K) for rapid navigation |
| **Auto-Updates** | Seamless background updates to keep you on the latest version |
| **Cross-Platform** | Linux (.deb, .rpm, .AppImage), Windows (.exe), macOS (.dmg) |
| **Theming** | Multiple themes (Dark, Light, Dracula) with persistence across restarts |

## Installation

Download the latest release for your platform from the [Releases Page](https://github.com/zync-sh/zync/releases).

| Platform | Format |
|----------|--------|
| Linux | `.deb`, `.rpm`, `.AppImage` |
| Windows | `.exe` |
| macOS | `.dmg` |

## Tech Stack

| Layer | Technologies |
|-------|--------------|
| **Desktop Shell** | [Tauri](https://tauri.app/) 2.x |
| **Backend** | [Rust](https://www.rust-lang.org/) |
| **Frontend** | [React](https://reactjs.org/) 19 + [TypeScript](https://www.typescriptlang.org/) |
| **Build Tool** | [Vite](https://vitejs.dev/) 7 |
| **Styling** | [Tailwind CSS](https://tailwindcss.com/) 4 |
| **State Management** | [Zustand](https://github.com/pmndrs/zustand) |

## Architecture

Zync follows a layered architecture with clear separation between the native backend and web-based frontend:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Tauri Application                         │
├─────────────────────────────────────────────────────────────────┤
│  Frontend (React + TypeScript)                                   │
│  ├── UI Components (Sidebar, FileManager, Terminal, Tunnels)     │
│  ├── State (Zustand stores: connections, fileSystem, settings)   │
│  └── IPC Layer (invoke) ──────────────────────┐                  │
├───────────────────────────────────────────────┼──────────────────┤
│  Backend (Rust)                               │                  │
│  ├── Tauri Commands (ssh_*, fs_*, tunnel_*,   │                  │
│  │   terminal_*, sftp_*, settings_*, etc.)    │                  │
│  ├── russh / russh-sftp (SSH & SFTP client)   │                  │
│  ├── portable-pty (terminal emulation)        │                  │
│  └── Plugins (opener, store, dialog, updater) │                  │
└───────────────────────────────────────────────┼──────────────────┘
                                                │
                         invoke("command", args)│
```

| Layer | Responsibility |
|-------|----------------|
| **React UI** | Renders the interface; handles user input, routing, and local state |
| **Zustand** | Persists connection data, file paths, settings, and tunnel configs |
| **Tauri IPC** | `invoke()` calls bridge the frontend to Rust commands |
| **Rust commands** | SSH connections, PTY management, file I/O, tunnel lifecycle |
| **Tauri plugins** | Dialog, clipboard, auto-updater, persistent store |

## Dependencies

### Frontend (npm)

| Package | Purpose |
|---------|---------|
| **@tauri-apps/api** | Tauri API bindings for the webview |
| **@tauri-apps/plugin-\*** | Clipboard, dialog, opener, process, updater |
| **@uiw/react-codemirror** | Code editor with syntax highlighting |
| **xterm** + addons | Terminal emulation (fit, search, web links, WebGL) |
| **framer-motion** | Animations and transitions |
| **cmdk** | Command palette UI |
| **recharts** | Charts and data visualization |
| **lucide-react** | Icon set |
| **react-window** | Virtualized lists for performance |
| **@dnd-kit/core** | Drag-and-drop for file manager |
| **zustand** | State management |

### Backend (Rust)

| Crate | Purpose |
|-------|---------|
| **tauri** | Desktop application framework |
| **russh** / **russh-keys** / **russh-sftp** | SSH and SFTP client implementation |
| **portable-pty** | Cross-platform pseudo-terminal (PTY) |
| **tokio** | Async runtime |
| **serde** / **serde_json** | Serialization |
| **reqwest** | HTTP client for updates |
| **tauri-plugin-store** | Persistent key-value store |
| **tauri-plugin-updater** | Auto-update functionality |

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS recommended)
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- **Linux (Ubuntu/Debian):**
  ```bash
  sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
  ```

### Quick Start

```bash
# Clone the repository
git clone https://github.com/zync-sh/zync.git
cd zync

# Install dependencies
npm install

# Run in development mode
npm run tauri dev
```

### Build for Production

```bash
npm run tauri build
```

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm run tauri dev` | Start development server with hot reload |
| `npm run tauri build` | Build production binaries |
| `npm run build` | Build frontend only (TypeScript + Vite) |
| `npm run type-check` | Run TypeScript type checking |
| `npm run preview` | Preview production frontend build |

## Extensions

Zync supports plugins and themes through the built-in Marketplace. Browse the [Plugin Catalog](PLUGIN_CATALOG.md) for available extensions, or visit [zync-extensions](https://github.com/zync-sh/zync-extensions) to develop and submit your own.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to get started, including development setup, code conventions, and pull request guidelines.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a list of changes in each release.

## License

MIT © [Zync](https://github.com/zync-sh/zync)

---

<p align="center">
  <a href="https://zync.thesudoer.in">zync.thesudoer.in</a>
</p>
