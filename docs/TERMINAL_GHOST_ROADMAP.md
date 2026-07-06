# Terminal Ghost Suggestions — Roadmap (Parked)

**Status:** In progress (P0/P1 shipped in unreleased)  
**Last updated:** 2026-07-06  
**Applies from:** Zync v2.19.2+ (inline ghost only; Tab popup removed in `336d54d`)

This document captures the agreed direction for making ghost suggestions **smarter and more robust**.  
For current architecture and file map, see [TERMINAL_GHOST_SUGGESTIONS.md](./TERMINAL_GHOST_SUGGESTIONS.md).

---

## Current state (baseline)

After popup removal, ghost suggestions are **inline only**:

| Surface | Status |
|---------|--------|
| Inline faded suffix while typing | Shipped |
| History provider (Rust frecency, per scope) | Shipped |
| Filesystem path provider (`fs_list`, local + SSH) | Shipped |
| Accept via → / word / path keys (Tab is shell-owned) | Shipped (P0) |
| Tab dismiss + desync until line reset | Shipped (P1) |
| Context-menu inline accept (optional setting) | Shipped |
| Tab popup list | **Removed** — rebuild later as popup v2 |
| Tab interception for Zync lists | **Removed** — Tab always goes to shell (P0) |

**Intentionally kept for later:** Rust `ghost_candidates` IPC and ranking helpers (reuse for popup v2).

---

## Design principles

1. **Accuracy before intelligence** — wrong ghost text is worse than no ghost text.
2. **Shell owns Tab** — fish/zsh/bash completion must not be fought; Zync owns → for inline accept.
3. **Complement native shells** — disable or suppress Zync ghost when fish/zsh autosuggest is active.
4. **Backend-first decisions** — move ranking/suppression into Rust; TS renders and routes keys only.
5. **Per-connection scope** — history and paths stay scoped to local vs each SSH connection.

---

## Known weaknesses (priority order)

| # | Problem | Impact |
|---|---------|--------|
| W1 | **Line buffer desync** after shell Tab completion | Ghost suffix no longer matches visible line |
| W2 | **Aggressive escape reset** — any `\x1b` clears buffer | Ghost dies after arrows, history search |
| W3 | **Tab still accepts ghost** when suffix is visible | Conflicts with shell Tab completion habits |
| W4 | **Prefix-only matching** | `gc` cannot suggest `git commit` |
| W5 | **Cold start** on new SSH hosts | Empty Zync history until commands are committed |
| W6 | **No shell awareness** | Duplicate/conflicting ghost on fish/zsh with autosuggest |
| W7 | **Pipeline / multisegment lines** | `\|`, `;`, `&&` not handled; conservative resets |
| W8 | **vi/emacs readline modes** | `bindkey -v` etc. break `InputTracker` assumptions |

---

## Strategy: three layers

```
Layer 1 — Robustness     → fix wrong/missing ghost (buffer sync, suppression, keys)
Layer 2 — Smarter        → better ranking, context, history seeding
Layer 3 — Popup v2       → lists later, non-Tab trigger, shell-safe
```

Do not start Layer 3 until Layer 1 exit criteria are met.

---

## Layer 1 — Robustness (do first)

### P0 — Shell-safe keys

- **Tab always passes to PTY** (never opens Zync UI).
- **→ (Right arrow) only** accepts inline ghost when suffix is visible.
- Remove Tab from `acceptFull` in `inputTracker.ts`.

**Exit:** fish/zsh users can Tab-complete without Zync intercepting.

### P1 — Dismiss on shell edit

When Tab is sent to the shell (no Zync accept), enter **desynced** mode until Enter/Ctrl+C/Ctrl+U:

- Suppress new ghost fetches while desynced (partially exists today).
- Do not show stale suffix after shell rewrote the line.

**Exit:** No ghost text visible after native Tab completion.

### P2 — Narrower escape handling

Replace blanket `\x1b` reset with categorized handling:

| Input class | Behavior |
|-------------|----------|
| Left/Right/Home/End | Desync + dismiss ghost; do not blindly wipe buffer |
| Ctrl+R / Up (history) | Desync until line reset |
| Ctrl+C / Ctrl+U / Enter | Hard reset (current behavior) |

**Exit:** Arrow keys inside a line do not permanently kill ghost until Enter.

### P3 — Suppression rules

Do not show inline ghost when:

- `InputTracker.desynced === true`
- Shell is fish, or zsh with detected autosuggest (via `shellOverride` / `$SHELL`)
- Unmatched quoting on active token
- Optional: cursor not at end of line (when detectable)

Add setting: **Auto** (recommended) | Always on | Off for native-shell sessions.

**Exit:** No double-gray-text on fish; no ghost during bad tracker state.

### P4 — Active-segment parsing

For `cmd1 | cmd2`, `a && b`, `a; b` — parse and suggest only the **tail segment** under the cursor, not the full line.

**Exit:** Pipelines get useful ghost on the active command.

---

## Layer 2 — Smarter suggestions

### P5 — Backend-first `ghost_suggest` v2

Extend Rust request/response:

```rust
// Request
{ prefix, scope, cwd?, shell_id?, recent_commands?: string[] }

// Response
{ suffix: string, confidence: f32, suppress_reason?: string }
```

TS (`client.ts`) becomes thin: one IPC call, render suffix, honor `suppress_reason`.

**Exit:** No duplicated parser/ranker logic across TS and Rust.

### P6 — Context-aware ranking

Weight suggestions using data already available in the app:

- `lastKnownCwd` — boost paths under current directory for `cd`/`ls`/file commands
- Recent terminal lines (`getTerminalRecentLines`) — boost repeated command families in-session
- Keep per-scope isolation (no cross-host leak by default)

**Exit:** `cd Doc` in `~/projects` prefers `Documents` there, not another server's path.

### P7 — Shell history import (SSH connect)

On connect, optionally read `~/.zsh_history` / `~/.bash_history` via SFTP, parse formats, seed frecency pool.

- Opt-in toggle (privacy)
- Never log raw history lines
- Display-only seeding into scoped store

**Exit:** Useful suggestions on first SSH session without waiting for Zync commits.

### P8 — Fuzzy matching (conservative)

Keep **strict prefix** for default inline ghost. Allow fuzzy/subsequence only when confidence is high (frecency + long shared subsequence).

Example: `gc` → `git commit` only when `git commit` dominates history.

**Exit:** Fewer false-positive jumps while typing.

---

## Layer 3 — Popup v2 (parked — rebuild later)

Do **not** repeat Tab ownership conflict. Constraints for v2:

| Rule | Rationale |
|------|-----------|
| Trigger: **Ctrl+Space** or **double-Tab** only | Tab stays with shell |
| Default off; opt-in per user | Power-user feature |
| Auto-off when fish/zsh detected | Native completion is better |
| Reuse `ghost_candidates` Rust IPC | Already implemented |
| Portal overlay (previous `GhostSuggestionListOverlay` pattern) | Avoid clipping |
| List shows `anchorLine + suffix` rows | Same candidate model as before removal |

Removed in `336d54d` (reference for rebuild): `GhostSuggestionListOverlay.tsx`, `behavior.ts`, `controller.ts`, `popupState.ts`, `tabState.ts`, `uiState.ts`, `popupEnabled` setting.

---

## Phased delivery summary

| Phase | Focus | User-visible outcome |
|-------|-------|-------------------|
| **P0** | Tab → shell; → accepts ghost | No Tab war with fish/zsh |
| **P1** | Desync on shell Tab | No stale ghost after completion |
| **P2** | Escape categorization | Ghost survives arrow keys |
| **P3** | Suppression + shell detect | No duplicate fish autosuggest |
| **P4** | Pipeline segments | Ghost on `\|` / `;` tails |
| **P5** | Rust suggest v2 contract | Single decision engine |
| **P6** | cwd + session context ranking | Smarter path/history picks |
| **P7** | SSH history seed | Day-one suggestions |
| **P8** | Conservative fuzzy | Shorthand without jitter |
| **P9** | Popup v2 | Optional list UI, shell-safe |

---

## Quick wins (can ship independently)

1. P0 — Tab never accepts ghost (→ only) — `inputTracker.ts`
2. P1 — Dismiss + desync when Tab forwarded to PTY — `useTerminalGhost.ts`
3. P3 — Auto-disable inline on fish shell id — settings + `useTerminalGhost.ts`
4. P6 (partial) — pass `cwd` into Rust ranking for `cd` path bonus — `ranking.rs`

---

## Test / exit checklist (when resuming)

- [ ] `npm run test:ghost-helpers` — extend for P0–P4 fixtures
- [ ] Manual: local bash, local fish, SSH zsh, SSH high-latency path `cd`
- [ ] Tab always reaches shell when no ghost suffix
- [ ] → accepts ghost; no duplicate characters
- [ ] After shell Tab completion, no stale ghost until typing resumes
- [ ] Server A history does not appear on server B
- [ ] `cargo check` + Rust unit tests for parser/ranking changes

Manual smoke reference: `mdfiles_and_doc/ghost-suggestions/MANUAL_SMOKE_CHECKLIST.md` (update popup sections when P9 starts).

---

## Related documents

- [TERMINAL_GHOST_SUGGESTIONS.md](./TERMINAL_GHOST_SUGGESTIONS.md) — current inline architecture
- [TERMINAL.md](./TERMINAL.md) — terminal stack, input queue, CWD capture
- [SESSION_PERSISTENCE.md](./SESSION_PERSISTENCE.md) — tab restore (ghost history is per scope)
- `mdfiles_and_doc/ghost-suggestions/` — older planning hub (tracker predates popup removal)

---

## Resume pointer

When picking this up again:

1. Read this roadmap and [TERMINAL_GHOST_SUGGESTIONS.md](./TERMINAL_GHOST_SUGGESTIONS.md).
2. Start with **P0** (smallest diff, highest UX impact).
3. Update `tests/ghostSuggestionsHelpers.test.mjs` for each phase.
4. Update TERMINAL_GHOST_SUGGESTIONS.md when behavior changes.