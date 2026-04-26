# Shell Icons Architecture

Goal: match Windows Terminal quality — real icons for all shells including WSL distros.

---

## What Was Built

All three phases are complete (design, implementation, and rollout). Below is the actual implementation, not the original plan.

---

## Icon Resolution Chain

```text
Rust (backend):
  WSL distro  → shortcut.ico exists + has PNG frame  → Base64Png { data }
              → shortcut.ico exists, BMP-only         → Base64Icon { data }
              → no shortcut.ico (e.g. custom distro)  → Bundled { name: "wsl.png" }
  Known shell → Bundled { name: "{shell}.svg/png" }
  Unknown     → icon: None

Frontend (ShellIcon.tsx):
  base64Png  → <img src="data:image/png;base64,..." />   ─┐
  base64Icon → <img src="data:image/x-icon;base64,..." /> ─┤ onError → ShellBadge
  bundled    → <img src="/shell-icons/{name}" />          ─┘
  absent     → ShellBadge (CSS letter/colour badge, always renders)
```

---

## WSL Icon Extraction

**Why not AppX / WinRT `PackageManager`:**
- `FindPackages()` requires elevation (0x80070005).
- `FindPackagesByUserSecurityId("")` only returns traditional AppX packages.
- Ubuntu on Windows 11 22H2+ uses a new storage model — installed at `%LOCALAPPDATA%\wsl\{GUID}`, not as an AppX package. No `CanonicalGroupLimited.Ubuntu` package exists.

**Actual approach — registry + `shortcut.ico`:**

Every WSL distro writes its metadata to `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Lxss\{GUID}`:
- `DistributionName` — the name shown by `wsl.exe -l`
- `BasePath` — the directory where the distro lives (custom install paths included)

Each distro directory contains `shortcut.ico`, placed by the WSL installer. This ICO file holds the distro's official logo.

**ICO → PNG extraction:**

Modern WSL distros (Ubuntu, Kali, Alpine…) embed PNG-compressed frames inside the ICO. We extract the largest PNG frame and serve it as `Base64Png`.

Older distros (Debian) use BMP-only ICOs. We serve the raw ICO bytes as `Base64Icon` — browsers render `data:image/x-icon` in `<img>` tags fine.

---

## Caching Strategy

Two-layer cache to avoid redundant I/O:

### Memory cache (`AppState.shell_icon_cache`)
- `Arc<RwLock<HashMap<String, Option<String>>>>` — lives for the app session.
- Key: `DistributionName.to_lowercase()`
- Value: `Some("png:{base64}")` / `Some("ico:{base64}")` / `None` (no icon found)

### Disk cache (`{data_dir}/shell-icon-cache.json`)
- JSON file, same format as the memory cache.
- Loaded into memory on first call; avoids re-reading `shortcut.ico` on every launch.
- Re-saved (fire-and-forget) whenever new distros are resolved.
- Distro names filtered by the Docker Distro Filtering step (prefix `docker-`) are removed.
- This happens before icon resolution, so those entries never produce memory or disk cache entries.

**Flow on shell picker open:**

```text
First ever launch:
  memory empty → disk missing → read registry → read shortcut.ico for each distro
  → write memory → write disk

Subsequent launches:
  memory empty → disk hit → populate memory
  → registry read (fast) → no new distros → done immediately

New distro installed:
  memory has existing distros → registry finds new one not in memory
  → read shortcut.ico for new distro only → update memory → re-save disk
```

---

## Docker Distro Filtering

Docker Desktop registers `docker-desktop` and `docker-desktop-data` as WSL distros. These are internal Docker components, not user shells. They are excluded by filtering any distro name starting with `docker-` before icon resolution and shell list construction.

---

## Files Changed

| File | What changed |
|------|-------------|
| `src-tauri/src/shell_icons.rs` | Created — registry read, shortcut.ico extraction, PNG/ICO detection, disk cache load/save |
| `src-tauri/src/commands.rs` | Added `ShellIconData` enum (`Bundled`, `Base64Png`, `Base64Icon`), `icon` field on `DetectedShell`, `shell_icon_cache` + `shell_icon_cache_path` on `AppState`, docker filter, `prefetch_all_wsl_icons` call |
| `src-tauri/src/lib.rs` | Added `mod shell_icons` |
| `src-tauri/Cargo.toml` | Added `winreg = "0.52"` (Windows-only) |
| `src/lib/shells/types.ts` | Added `base64Icon` variant to `ShellIconData` |
| `src/components/icons/ShellIcon.tsx` | Added `base64Icon` rendering (`image/x-icon`), updated resolution order doc |

---

## What Was NOT Done (and Why)

| Rejected approach | Reason |
|-------------------|--------|
| WinRT `PackageManager` | Requires elevation or only returns non-WSL packages |
| Bundled per-distro PNGs | Doesn't scale; can't cover every distro variant; `shortcut.ico` is authoritative |
| `ExtractIconEx` Win32 | HICON→PNG requires unsafe GDI code; `shortcut.ico` is already a file |
| Scanning `Assets/` subdirs | Ubuntu 22H2+ has no `Assets/` — wrong storage model |
