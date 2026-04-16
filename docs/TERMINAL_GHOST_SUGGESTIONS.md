# Terminal Ghost Suggestions

This document describes the fish-style terminal suggestion system in Zync:

- Inline ghost text suffix while typing
- Tab-triggered suggestion popup list
- Per-scope history ranking (local or connection-specific)
- Filesystem path completion (local + remote via `fs_list`)

## Status Snapshot (2026-04-16)

- Backend-first modular ghost engine is active under `src-tauri/src/ghost/*` (parser, ranking, manager, commands, types).
- Frontend routing has been decomposed from `Terminal.tsx` into helper modules (`client`, `runtime`, `controller`, `behavior`, `uiState`, `pathCompletion`).
- Popup/context-menu/inline toggles are live in settings (`ghostSuggestions.*` + provider toggles).
- Remaining work is parity tuning/polish (fish-like edge behavior, deeper smoke coverage), not baseline architecture setup.

## Naming Clarification

- `ContextMenu` (`src/components/ui/ContextMenu.tsx`) is the generic right-click menu UI.
- `GhostSuggestion*` components are completion overlays powered by the ghost suggestion engine.
- The suggestion popup is not the generic context menu, even if both look menu-like.

## File Structure And Responsibilities

### Frontend UI (terminal overlays)

- `src/components/Terminal.tsx`
  - Integrates xterm input handling with ghost runtime.
  - Accepts/dismisses suggestions, opens popup, routes Tab/arrow keys.
  - Wires right-click menu actions to accept ghost candidates.
- `src/components/terminal/GhostSuggestionOverlay.tsx`
  - Renders inline ghost suffix at cursor position.
  - Theme-aware text color via CSS variables.
- `src/components/terminal/GhostSuggestionListOverlay.tsx`
  - Renders suggestion list popup in a `document.body` portal.
  - Tracks cursor position and auto-flips above when near viewport bottom.
  - Keeps popup window stable while scrolling selection.

### Frontend Logic (behavior + input routing)

- `src/lib/ghostSuggestions/types.ts`
  - Shared frontend types for requests, popup state, tab state, and outcomes.
- `src/lib/ghostSuggestions/client.ts`
  - IPC client calls: suggest/candidates/commit/accept.
  - Provider orchestration (history + filesystem) and tab completion outcome.
- `src/lib/ghostSuggestions/inputTracker.ts`
  - Maintains local line buffer from xterm `onData`.
  - Handles accept keys, dismiss/reset behavior, and history commit callback.
- `src/lib/ghostSuggestions/runtime.ts`
  - Binds tracker callbacks, debounce, stale request protection.
  - Dispatches input events to popup/tracker routing.
- `src/lib/ghostSuggestions/controller.ts`
  - Key-level popup interaction decisions (next/prev/accept/dismiss/close-pass).
- `src/lib/ghostSuggestions/behavior.ts`
  - Tab action policy (single candidate, shared prefix, double-tab list behavior).
- `src/lib/ghostSuggestions/pathCompletion.ts`
  - Filesystem suggestion engine with command-aware path heuristics and cache.
- `src/lib/ghostSuggestions/popupState.ts`
  - Pure helpers for popup open/close/selection movement.
- `src/lib/ghostSuggestions/tabState.ts`
  - Tab interaction state defaults/reset.
- `src/lib/ghostSuggestions/uiState.ts`
  - React hook for popup state + ref synchronization.
- `src/lib/ghostSuggestions/cursorPosition.ts`
  - Converts xterm cursor cell coordinates to pixel coordinates.
- `src/lib/ghostSuggestions/suggestionEngine.ts`
  - Provider engine scaffold for sync/debounced suggestions.
- `src/lib/ghostSuggestions/providers/historyProvider.ts`
  - Legacy helper scaffold (`CommandHistory` ring-buffer). Current runtime uses backend history via IPC (`ghost_*` commands).

### Backend Rust (history + ranking + commands)

- `src-tauri/src/ghost/mod.rs`
  - Ghost module exports and wiring.
- `src-tauri/src/ghost/types.rs`
  - Persisted frecency/history models and constants.
- `src-tauri/src/ghost/parser.rs`
  - Prefix extraction from shell input segments.
- `src-tauri/src/ghost/ranking.rs`
  - Candidate ranking heuristics (frecency + suffix scoring).
- `src-tauri/src/ghost/manager.rs`
  - In-memory state, persistence, commit/accept/suggest/candidates APIs.
- `src-tauri/src/ghost/commands.rs`
  - Tauri commands: `ghost_commit`, `ghost_accept`, `ghost_suggest`, `ghost_candidates`.
- `src-tauri/src/commands.rs`
  - `AppState` owns shared `ghost_manager`.
- `src-tauri/src/lib.rs`
  - Registers ghost commands with Tauri invoke handler.
- `src-tauri/src/fs.rs`
  - `fs_list` type normalization used by path completion (`file`/`directory`/`symlink` mapping).

### Settings + Tests

- `src/store/settingsSlice.ts`
  - `ghostSuggestions` settings (inline/popup/context menu + provider toggles).
- `src/components/settings/SettingsModal.tsx`
  - Ghost Suggestions settings UI section.
- `tests/ghostSuggestionsHelpers.test.mjs`
  - Behavior tests for controller/runtime/path helpers/tab behavior.
- `tsconfig.agent-tests.json`
  - Includes ghost helper modules in agent test compilation.

## Event/Data Flow

1. User types in terminal (`xterm.onData` in `Terminal.tsx`).
2. `handleGhostInputEvent` routes keystrokes:
   - Popup navigation/accept/dismiss, or
   - Tracker feed for inline flow.
3. `InputTracker` updates line state; runtime debounces inline suggestion fetch.
4. `client.ts` resolves providers:
   - History (Rust ghost manager via IPC)
   - Filesystem path candidates (`fs_list`)
5. UI overlays render:
   - Inline suffix (`GhostSuggestionOverlay`)
   - Popup list (`GhostSuggestionListOverlay`, portal, flip-aware)
6. Accept/commit sends `ghost_accept` / `ghost_commit` to backend manager.

## Commands and Expected Behavior

- `Tab`
  - Accept single/shared-prefix suggestion, or show popup list.
  - Falls back to shell-native tab completion if no custom candidates.
- Arrow keys while popup open
  - Move selection without collapsing popup.
- `Esc` while popup open
  - Dismiss popup.
- `Enter`
  - Commits command; history score updated.

## Notes For Future Changes

- Keep popup rendering portal-based to avoid parent clipping.
- Keep theme colors CSS-variable-based for dark/light compatibility.
- If key routing changes, update both:
  - `src/lib/ghostSuggestions/controller.ts`
  - `tests/ghostSuggestionsHelpers.test.mjs`
- If parser/ranking behavior changes, update backend unit tests in:
  - `src-tauri/src/ghost/parser.rs`
  - `src-tauri/src/ghost/ranking.rs`
  - `src-tauri/src/ghost/manager.rs`
- Avoid adding terminal key buffering unless a reproducible xterm sequence split is proven.
