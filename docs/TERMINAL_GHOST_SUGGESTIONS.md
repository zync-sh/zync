# Terminal Ghost Suggestions

**Last updated:** 2026-07-06  
**Applies to:** Zync v2.19.2+

Fish-style **inline** command completion for Zync terminals:

- Faded ghost text suffix while typing
- Per-scope history ranking (local or connection-specific)
- Filesystem path completion (local + remote via `fs_list`)

**Parked / future work:** smarter ranking, robustness hardening, popup v2 — see [TERMINAL_GHOST_ROADMAP.md](./TERMINAL_GHOST_ROADMAP.md).

For the overall terminal stack (PTY, IPC, renderer, tab lifecycle), see [TERMINAL.md](./TERMINAL.md).

---

## Overview

Ghost suggestions run **inside the terminal input pipeline**. Handlers are serialized through `inputQueue.ts` so fast typing cannot reorder keystrokes relative to the shell.

| Surface | Component / module |
|---------|------------------|
| Inline suffix | `GhostSuggestionOverlay.tsx` |
| Input wiring | `useTerminalGhost.ts` (called from `Terminal.tsx`) |
| Settings | **Settings → Terminal → Ghost suggestions** (`settings.ghostSuggestions`) |

**Visibility:** Ghost IPC is skipped when the shell tab is hidden (`isVisibleRef`).

**Tab popup:** Removed in v2.19.2 (`336d54d`). Tab always goes to the shell (P0). Popup v2 is planned in the roadmap.

---

## File structure

### Frontend UI (terminal overlays)

| File | Role |
|------|------|
| `src/components/terminal/Terminal.tsx` | Mounts `useTerminalGhost`; passes ghost state into `TerminalHost` |
| `src/components/terminal/useTerminalGhost.ts` | Binds xterm input to ghost runtime |
| `src/components/terminal/GhostSuggestionOverlay.tsx` | Inline ghost suffix at cursor; theme via CSS variables |
| `src/components/terminal/TerminalHost.tsx` | Host layout + overlay mount |
| `src/components/terminal/TerminalContextMenu.tsx` | Optional inline accept from right-click menu |

### Frontend logic (`src/lib/ghostSuggestions/`)

| File | Role |
|------|------|
| `types.ts` | Request and inline suggestion types |
| `client.ts` | IPC: suggest / commit / accept; inline provider orchestration |
| `inputTracker.ts` | Line buffer from `onData`; accept/dismiss; history commit callback |
| `runtime.ts` | Tracker callbacks, debounce, stale-request guards, input routing |
| `pathCompletion.ts` | Path engine + command-aware heuristics + cache |
| `cursorPosition.ts` | Cell → pixel coords via `.xterm-char-measure-element` (xterm 6) |
| `suggestionEngine.ts` | Provider scaffold (legacy) |
| `providers/historyProvider.ts` | Legacy ring-buffer scaffold; **runtime uses Rust history via IPC** |

### Backend Rust (`src-tauri/src/ghost/`)

| File | Role |
|------|------|
| `mod.rs` | Module exports |
| `types.rs` | Frecency/history models and constants |
| `parser.rs` | Prefix extraction from shell input segments |
| `ranking.rs` | Frecency + suffix scoring |
| `manager.rs` | In-memory state, persistence, suggest/candidates/commit/accept |
| `commands.rs` | Tauri: `ghost_commit`, `ghost_accept`, `ghost_suggest`, `ghost_candidates` |
| `src-tauri/src/commands.rs` | `AppState` owns `ghost_manager` |
| `src-tauri/src/fs.rs` | `fs_list` type normalization for path completion |

`ghost_candidates` remains in Rust for a future popup v2; not used by the inline UI today.

### Settings + tests

| File | Role |
|------|------|
| `src/store/settingsSlice.ts` | `ghostSuggestions` schema |
| `src/components/settings/tabs/TerminalTab.tsx` | Ghost toggles (inline, context menu, providers) |
| `tests/ghostSuggestionsHelpers.test.mjs` | Runtime/path/inputTracker behavior |
| `tsconfig.agent-tests.json` | Compiles ghost helpers for agent tests |

---

## Event / data flow

```
xterm.onData
  → inputQueue (serialized)
    → useTerminalGhost / handleGhostInputEvent
      → inputTracker (inline buffer + accept keys)
        → runtime debounce → client.ts
          → history: ghost_suggest IPC (Rust manager)
          → filesystem: fs_list
      → GhostSuggestionOverlay
      → ghost_accept / ghost_commit on accept
```

1. User types in the terminal.
2. `InputTracker` updates line state; runtime debounces inline fetch.
3. `client.ts` merges history + filesystem into one suffix.
4. Overlay renders inline suffix.
5. Accept/commit updates backend frecency history.

---

## Key bindings

| Key | Behavior |
|-----|----------|
| **→** (Right arrow) | Accept full ghost suffix (when visible) |
| **Tab** | Always passes to shell; dismisses ghost and pauses suggestions until Enter/Ctrl+C/Ctrl+U |
| **Alt+→** / **Alt+F** | Accept next word of suffix |
| **Ctrl+→** | Accept next path component of suffix |
| **Enter** | Commit command; history score updated; clears desync |

---

## Settings (`settings.ghostSuggestions`)

**Settings → Terminal → Ghost suggestions**

| Toggle | Default | Purpose |
|--------|---------|---------|
| Inline ghost text | on | Gray suffix at cursor |
| Context menu actions | off | Accept inline suggestion from terminal context menu |
| Provider: history | on | Rust frecency history |
| Provider: filesystem | on | `fs_list` path completion |

---

## Known gaps

See [TERMINAL_GHOST_ROADMAP.md](./TERMINAL_GHOST_ROADMAP.md) for the full parked plan. Highlights:

- Line buffer desync after shell Tab completion
- Aggressive escape-sequence reset in `InputTracker`
- Narrower escape handling (P2): arrow keys still hard-reset buffer today
- Prefix-only matching; no fuzzy shorthand
- Cold start on new SSH connections
- fish/zsh autosuggest coexistence policy not implemented

---

## Notes for changes

- Keep overlay colors **CSS-variable-based** for theme compatibility.
- Parser/ranking changes → update `parser.rs`, `ranking.rs`, `manager.rs` and TS tests.
- Key routing changes → update `inputTracker.ts` and `tests/ghostSuggestionsHelpers.test.mjs`.
- Do not add terminal key buffering unless a reproducible xterm sequence-split bug is proven.
- When rebuilding popup, follow popup v2 constraints in the roadmap (non-Tab trigger).

---

## Related documents

- [TERMINAL_GHOST_ROADMAP.md](./TERMINAL_GHOST_ROADMAP.md) — parked robustness + intelligence + popup v2 plan
- [TERMINAL.md](./TERMINAL.md) — integrated terminal architecture
- [SESSION_PERSISTENCE.md](./SESSION_PERSISTENCE.md) — tab restore (ghost history is per connection scope)