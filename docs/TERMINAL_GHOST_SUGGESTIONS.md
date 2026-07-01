# Terminal Ghost Suggestions

**Last updated:** 2026-06-29  
**Applies to:** Zync v2.19.1+

Fish-style command completion for Zync shells:

- Inline ghost text suffix while typing
- Tab-triggered suggestion popup list
- Per-scope history ranking (local or connection-specific)
- Filesystem path completion (local + remote via `fs_list`)

For the overall terminal stack (PTY, IPC, renderer, tab lifecycle), see [TERMINAL.md](./TERMINAL.md).

---

## Overview

Ghost suggestions run **inside the terminal input pipeline**. Handlers are serialized through `inputQueue.ts` so fast typing and Tab resolution cannot reorder keystrokes relative to the shell.

| Surface | Component / module |
|---------|------------------|
| Inline suffix | `GhostSuggestionOverlay.tsx` |
| Popup list | `GhostSuggestionListOverlay.tsx` (portal to `document.body`) |
| Input wiring | `useTerminalGhost.ts` (called from `Terminal.tsx`) |
| Settings | **Settings → Terminal → Ghost suggestions** (`settings.ghostSuggestions`) |

**Visibility:** Ghost IPC is skipped when the shell tab is hidden (`isVisibleRef`).

---

## Naming clarification

- `ContextMenu` (`src/components/ui/ContextMenu.tsx`) — generic right-click menu UI.
- `GhostSuggestion*` — completion overlays powered by the ghost engine.
- The suggestion popup is **not** the generic context menu, even if both look menu-like.

---

## File structure

### Frontend UI (terminal overlays)

| File | Role |
|------|------|
| `src/components/terminal/Terminal.tsx` | Mounts `useTerminalGhost`; passes ghost state into `TerminalHost` |
| `src/components/terminal/useTerminalGhost.ts` | Binds xterm input to ghost runtime; Tab/arrow routing |
| `src/components/terminal/GhostSuggestionOverlay.tsx` | Inline ghost suffix at cursor; theme via CSS variables |
| `src/components/terminal/GhostSuggestionListOverlay.tsx` | Popup portal; cursor tracking; flips above near viewport bottom |

### Frontend logic (`src/lib/ghostSuggestions/`)

| File | Role |
|------|------|
| `types.ts` | Request, popup, tab state, outcome types |
| `client.ts` | IPC: suggest / candidates / commit / accept; provider orchestration |
| `inputTracker.ts` | Line buffer from `onData`; accept/dismiss; history commit callback |
| `runtime.ts` | Tracker callbacks, debounce, stale-request guards |
| `controller.ts` | Popup key decisions (next/prev/accept/dismiss/close-pass) |
| `behavior.ts` | Tab policy: single candidate, shared prefix, double-tab list |
| `pathCompletion.ts` | Path engine + command-aware heuristics + cache |
| `popupState.ts` | Pure popup open/close/selection helpers |
| `tabState.ts` | Tab interaction defaults/reset |
| `uiState.ts` | React hook for popup state + ref sync |
| `cursorPosition.ts` | Cell → pixel coords via `.xterm-char-measure-element` (xterm 6; no private APIs) |
| `suggestionEngine.ts` | Provider scaffold for sync/debounced suggestions |
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

### Settings + tests

| File | Role |
|------|------|
| `src/store/settingsSlice.ts` | `ghostSuggestions` schema |
| `src/components/settings/tabs/TerminalTab.tsx` | Ghost toggles (inline, popup, context menu, providers) |
| `tests/ghostSuggestionsHelpers.test.mjs` | Controller/runtime/path/tab behavior |
| `tsconfig.agent-tests.json` | Compiles ghost helpers for agent tests |

---

## Event / data flow

```
xterm.onData
  → inputQueue (serialized)
    → useTerminalGhost / handleGhostInputEvent
      → popup navigation OR inputTracker (inline)
        → runtime debounce → client.ts
          → history: ghost_* IPC (Rust manager)
          → filesystem: fs_list
      → GhostSuggestionOverlay / GhostSuggestionListOverlay
      → ghost_accept / ghost_commit on accept
```

1. User types in the terminal.
2. Keystrokes route to popup handling or inline tracker.
3. `InputTracker` updates line state; runtime debounces inline fetch.
4. `client.ts` merges history + filesystem candidates.
5. Overlays render inline suffix and/or popup list.
6. Accept/commit updates backend frecency history.

---

## Key bindings

| Key | Behavior |
|-----|----------|
| **Tab** | Accept single/shared-prefix suggestion, or open popup; falls back to shell tab completion if no candidates |
| **Arrow keys** (popup open) | Move selection; popup stays open |
| **Esc** (popup open) | Dismiss popup |
| **Enter** | Commit command; history score updated |

---

## Settings (`settings.ghostSuggestions`)

**Settings → Terminal → Ghost suggestions**

| Toggle | Default | Purpose |
|--------|---------|---------|
| Inline ghost text | on | Gray suffix at cursor |
| Tab popup | on | List on Tab when multiple candidates |
| Context menu actions | off | Accept candidates from terminal context menu |
| Provider: history | on | Rust frecency history |
| Provider: filesystem | on | `fs_list` path completion |

---

## Known gaps

- Fish-like parity edge cases (behavior tuning, not missing architecture).
- Deeper manual smoke coverage for remote path completion edge paths.

---

## Notes for changes

- Keep popup **portal-based** to avoid parent clipping.
- Keep overlay colors **CSS-variable-based** for theme compatibility.
- Key routing changes → update `controller.ts` and `tests/ghostSuggestionsHelpers.test.mjs`.
- Parser/ranking changes → update `parser.rs`, `ranking.rs`, `manager.rs` tests.
- Do not add terminal key buffering unless a reproducible xterm sequence-split bug is proven.

---

## Related documents

- [TERMINAL.md](./TERMINAL.md) — integrated terminal architecture (PTY, renderer, input pipeline)
- [SESSION_PERSISTENCE.md](./SESSION_PERSISTENCE.md) — tab restore (ghost history is per connection scope)