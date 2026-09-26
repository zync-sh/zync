# Keyboard shortcuts — routing & catalog

**Last updated:** 2026-09-03  
**Status:** landed — catalog + dispatcher + PTY table. Issue [#104](https://github.com/zync-sh/zync/issues/104) is the first PTY-table row.

This is the canonical design for **where a key goes** in Zync: terminal PTY vs Zync command vs native field. Terminal emulator internals stay in [TERMINAL.md](./TERMINAL.md). User-facing Settings rows stay generated from the catalog (today: `ShortcutsTab.tsx` + `settings.keybindings`).

---

## 1. Why this exists

Zync is a **terminal host**. Most keystrokes in a focused xterm must become **bytes on a PTY**. A smaller set are **named Zync commands** (palette, find, new tab). Mixing those in `if (ctrl && key)` listeners is how shortcuts steal from nano/vim and how xterm holes (Ctrl+/) look like “Zync dropped the key.”

**Permanent rule:** one keypress has **one owner**, chosen **before** dispatch. There is no “send to the terminal, then fall back to Zync if unused.” Once bytes are on the PTY they cannot be taken back; once Zync `preventDefault`s, the PTY never sees the event.

---

## 2. Two kinds of keys (never mix)

| Kind | Meaning | Remappable in Settings? | Example |
|------|---------|-------------------------|---------|
| **Zync command** | Named app action | **Yes** | `commandPalette` (`Mod+P`), `termFind` (`Mod+F`) |
| **PTY mapping** | VT bytes xterm.js does not emit | **No** | Ctrl+/ → `^_` (`0x1F`) for nano go-to-line |

Do **not** register shell/nano/vim chords as Zync actions (`terminal.interrupt`, `terminal.clearLine`). Ctrl+C is `0x03` on the PTY; the kernel/shell does SIGINT. Ctrl+/ is `0x1F`; nano does go-to-line.

Do **not** put PTY mappings in Settings. A user remapping “interrupt” would break every remote program in ways that look like a Zync bug.

---

## 3. Dispatch (the whole runtime)

```text
keydown
  → focus: xterm | field | app
  → if xterm and PTY table matches     → write bytes to PTY, stop
  → if a Zync command matches
       AND its `when` allows this focus → run command, stop
  → else                               → do nothing
                                         (xterm or the focused field handles it)
```

**Default while the terminal is focused is pass-through.** Zync only consumes a chord when that command’s `when` says so.

```text
                    KeyboardEvent
                          │
                          ▼
                 ┌─────────────────┐
                 │    Dispatcher     │
                 └────────┬────────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
         PTY table   Command catalog  Pass-through
         (frozen)    (`when` + keys)  (xterm / input)
```

---

## 4. Focus

Derived from the event target (DOM already “claims” keyboard). No `keyboard.claim()` API.

| Focus | When |
|-------|------|
| `xterm` | Target is xterm’s helper textarea or inside `.xterm` (`isXtermKeyboardTarget`) |
| `field` | `<input>`, `<textarea>` (not xterm), or `contentEditable` |
| `app` | Everything else |
| `files` | File Manager has its own bindings today; treat as a `when` value, not a fourth global listener forever |

Command palette / settings / search **open** are still `field` or `app` via real focus. Do not invent ModeManager for this.

---

## 5. `when` clauses (Zync commands only)

Small, closed set:

| `when` | Runs if |
|--------|---------|
| `always` | Even with xterm focused. Includes Zync chrome Ctrl+B / Ctrl+P / Ctrl+I (sidebar, palette, AI), plus Shift chords, tab switch, and settings. |
| `xterm` | Only while the terminal is focused (unused for defaults; available for future chrome) |
| `app` | **Not** xterm under shell-first — PTY gets the chord. Use for Ctrl+W / F / T / N. |
| `field` | **Never steal** — leave to the editor (CodeMirror Ctrl+/ etc.) |
| `files` | File Manager surface only (`fm*`); never handled by the global dispatcher |

**Default ownership (Win/Linux `Mod` = Ctrl)**

| Chord | Owner in terminal | Command |
|-------|-------------------|---------|
| Ctrl+/ | PTY (`^_`) | nano go-to-line ([#104](https://github.com/zync-sh/zync/issues/104)) |
| Ctrl+W / F / T / N | PTY when shell-first | nano where-is, forward, … |
| Ctrl+C / K / U / … | PTY | not in catalog |
| Mod+B / P / I | Zync (`always`) | sidebar, palette, AI — still work in the terminal |
| Mod+Shift+C / V | Zync | terminal copy / paste |
| Mod+Shift+W / T / P | Zync | close terminal tab, new host terminal, command palette (commands) |
| Ctrl+Shift+Left / Right | Zync (`always`) | split the focused pane side by side |
| Ctrl+Shift+Up / Down | Zync (`always`) | split the focused pane stacked |
| Ctrl+Alt+Arrows | Zync (`always`) | move focus to the neighboring pane (consumed only when a split exists) |
| — | — | Unsplit is on the owner tab’s context menu |
| Ctrl+Tab, Mod+1–9 | Zync | tab switch |
| Mod+, | Zync | settings |
| Mod+= / - | terminal font (xterm) or app zoom (`when: app`) | |

Close-tab / new local terminal / buffer find stay **app only** under shell-first. In a terminal use Mod+Shift+W to close the terminal tab.

If Ctrl+Alt+arrows never reach the app, an OS or GPU utility may own that chord — rebind **Focus pane in direction** in Settings.

Adding a command is adding a row with a `when`. That **is** the “skip if terminal focused” rule. No extra `if (xtermFocused) return` in a capture listener.

### Terminal-focus policy (Settings → Shortcuts)

`settings.keyboard.terminalFocusPolicy`:

| Value | Default | While xterm is focused |
|-------|---------|------------------------|
| `shell` | **yes** | `when: 'app'` commands do **not** run. Ctrl+W / F / T / N go to the PTY. Ctrl+B / P / I stay Zync (`always`). |
| `app` | | `when: 'app'` is treated like `always`. Remaining Zync shortcuts also win in the terminal. |

This is a **policy**, not a keymap. New `when: 'app'` commands pick it up automatically. It does **not** change:

- `when: 'always'` (sidebar, palette, AI, Shift chords, Ctrl+Tab, tab numbers)
- PTY translations (Ctrl+/ → `^_` still runs if Zync did not consume the event)
- File Manager (`when: 'files'`)

Invalid or missing values normalize to `shell`.

---

## 6. Command catalog

One module is the source of truth: **id, default keys, `when`, action**.

`settings.keybindings` stores **user overrides** only (same keys as today: `commandPalette`, `termFind`, …). Shortcuts UI is generated from the catalog, not a parallel handwritten list.

Conceptual row:

```ts
{
  id: 'commandPalette',
  defaultKeys: 'Mod+P',
  when: 'always',
  run: { type: 'event', name: 'zync:open-command-palette' },
}
```

Handlers stay ordinary: `CustomEvent`s already used (`zync:open-command-palette`, `ssh-ui:term-find`, …) or a small `actions` map. **Do not** put Ctrl+C / Ctrl+K / Ctrl+/ in this catalog.

**How to add a Zync shortcut later**

1. Add one catalog row (`id`, default keys, `when`, `run`).
2. If the action is new, add one handler (or emit an existing event).
3. It appears in Settings automatically.

No new `else if` in `ShortcutManager`. No “remember to skip xterm.”

---

## 7. PTY translation table

Second module, **not** Settings. Frozen list of chords **xterm.js drops** that real terminals send.

| Chord | Bytes | Why |
|-------|-------|-----|
| Ctrl+/ (`event.key === '/'` or `NumpadDivide`, no Shift/Alt/Meta) | `0x1F` (`US` / `^_`) | xterm maps Ctrl+_ only; nano go-to-line expects this. Match the produced `/`, not the US physical `Slash` key. [#104](https://github.com/zync-sh/zync/issues/104) |

Later emulator holes are **one row** here. Same dispatch path: match → `queueTerminalInput(sessionId, bytes)` → stop xterm default.

This is emulator completeness (like Enter → `\r`), not a product shortcut.

---

## 8. What we do not build

These solve an IDE keybinding **platform**, not a terminal host:

- `KeyboardManager` / `ModeManager` / `ConflictResolver` with priority 100/80/60
- `keyboard.claim("terminal")` and confidence scores
- Configurable `terminal.interrupt` / `terminal.clearLine`
- Fallback “terminal didn’t use it → Zync”
- AI that guesses the shortcut

Priorities hide the one-owner rule. A claim API duplicates DOM focus and desyncs. Registering readline/nano keys as Zync commands means maintaining every program’s keymap forever.

**Optional later (not required for this design):** VS Code-style “Ctrl+C copies when the terminal has a selection, else interrupt.” Zync already copies with `Mod+Shift+C`, so Ctrl+C can stay PTY. Do not build modes for [#104](https://github.com/zync-sh/zync/issues/104).

---

## 9. Implementation

Plugin panes are opaque-origin iframes, so their key events do not bubble to the host.
`pluginShortcuts.ts` injects a shared chrome-navigation bridge into every plugin pane.
It uses the catalog and current user overrides, leaves editing/copy/paste and plugin-local
keys alone, and ignores composition/repeated/synthetic key events. The host validates the
focused frame and re-matches the key against its current navigation-only allowlist.
This channel does not grant terminal input, SSH/session creation or filesystem authority.
The iframe sandbox remains unchanged.

| Path | Role |
|------|------|
| `src/lib/shortcuts.ts` | Match / format / `isXtermKeyboardTarget` |
| `src/features/shortcuts/catalog.ts` | Zync command rows (`id`, defaults, `when`, Settings key) |
| `src/features/shortcuts/policy.ts` | `shell` / `app` terminal-focus policy + `allowsWhen` |
| `src/features/shortcuts/dispatch.ts` | Focus + `when` + policy + match → run or ignore |
| `src/features/shortcuts/actions.ts` | Command handlers |
| `src/lib/terminal/ptyKeyTranslations.ts` | Frozen VT mappings (Ctrl+/ → `0x1F`) |
| `src/components/managers/ShortcutManager.tsx` | Window capture → `dispatchAppShortcut` |
| `src/components/terminal/useTerminalKeybindings.ts` | PTY table, then `defaultPrevented`, then terminal font zoom / search Escape |
| `src/components/settings/tabs/ShortcutsTab.tsx` | Generated from catalog |
| File Manager | Own `fm*` matching (`when: 'files'` is never global) |

**Zoom:** `zoomIn` / `zoomOut` use `when: 'app'`. With xterm focused, `Mod+-` / `Mod+=` change **terminal font**, not app zoom.

**Close tab:** dispatcher emits `zync:close-active-tab`; TabBar owns the confirm modal. If the file editor overlay is open, the command is not consumed.

Capture on `window` stays. The dispatcher **returns immediately** unless catalog + `when` match. PTY mappings never go through the catalog.
