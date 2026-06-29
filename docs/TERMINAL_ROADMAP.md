# Zync Terminal — Optimization & Robustness Roadmap

**Last updated:** 2026-06-29 (§14 release-gate items complete; ready for v2.19.0 QA)
**Audit basis:** Full-stack review of `terminal/Terminal.tsx`, `TerminalManager.tsx`, `pty.rs`, `terminalSlice.ts`, ghost suggestions, and terminal IPC.

Plans and prioritized work for terminal performance, reliability, and code quality. For ghost-suggestion architecture, see [TERMINAL_GHOST_SUGGESTIONS.md](./TERMINAL_GHOST_SUGGESTIONS.md). For session/tab restore behavior, see [SESSION_PERSISTENCE.md](./SESSION_PERSISTENCE.md).

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [What Is Already Solid](#2-what-is-already-solid)
3. [Resize Behavior (Expected vs Buggy)](#3-resize-behavior-expected-vs-buggy)
4. [P0 — Highest Impact](#4-p0--highest-impact)
5. [P1 — Robustness & Code Quality](#5-p1--robustness--code-quality)
6. [P2 — Polish & Longer-Term](#6-p2--polish--longer-term)
7. [Quick Wins vs Larger Refactors](#7-quick-wins-vs-larger-refactors)
8. [Suggested Implementation Order](#8-suggested-implementation-order)
9. [Key File Map](#9-key-file-map)
10. [Exit Criteria](#10-exit-criteria)
11. [GPU Acceleration (WebGL Renderer)](#11-gpu-acceleration-webgl-renderer)
12. [Phase 6 — xterm 6.x Terminal Milestone](#12-phase-6--xterm-6x-terminal-milestone)
13. [Phase 7 — Maintainability & Scale](#13-phase-7--maintainability--scale)
14. [Next Action Items](#14-next-action-items)

---

## 1. Executive Summary

The terminal stack has strong foundations: generation-gated lifecycle events, frontend input batching, remote output coalescing, remote resize coalescing, and a module-level xterm cache for tab persistence.

**Refactor and optimization (P0–P1 + maintainability milestone):** **complete** as of post-2.18.0 work — lazy PTY spawn, input queue, ready gating, local/remote output batching, resize scheduler, lifecycle modules, xterm 6 + DOM fallback, `Terminal.tsx` split (~260 lines), `terminalService`, opt-in idle-host PTY suspend. See [§10](#10-exit-criteria), [§12](#12-phase-6--xterm-6x-terminal-milestone), [§13](#13-phase-7--maintainability--scale).

**§14 release-gate items:** **complete** (2026-06-29) — `terminal-exit` on kill, process-aware idle suspend, Tauri `Channel` PTY output streaming, multi-host shared idle timer (remote only). See [§14](#14-next-action-items).

**Release plan:** **v2.19.0** is unblocked pending manual QA sign-off on Windows WebView2.

---

## 2. What Is Already Solid

- **Generation-gated events** — stale output/exit ignored after restart (`Terminal.tsx` listeners filter on `generation`)
- **Frontend input batching** — 4ms window, 64-byte threshold, immediate flush for control chars (`INPUT_BATCH_MS`, `INPUT_FLUSH_THRESHOLD`)
- **Remote output batching** — 8ms / 4KB coalescing in `pty.rs` (`REMOTE_OUTPUT_BATCH_MS`, `REMOTE_OUTPUT_FLUSH_THRESHOLD`)
- **Remote resize coalescing** — latest cols/rows wins in SSH reader task (`pty.rs` resize channel drain)
- **xterm cache** — `terminalCache` preserves scrollback across tab reorder/remount
- **Layout transition hardening** — visual fit during animation; PTY IPC deferred until settle; 500ms safety timeout
- **Ghost stale-result guards** — line-buffer checks and request sequencing in ghost runtime
- **OSC 7 CWD tracking** — passive shell-integration path, no injection
- **Remote SSH flush on exit** — avoids truncated tail output before `terminal-exit`

---

## 3. Resize Behavior (Expected vs Buggy)

**Expected (all terminals, including Windows PowerShell):**

- Historical scrollback does **not** reflow when the window is resized or maximized
- Lines written at a narrow width stay wrapped at those break points
- **New** commands after resize use the new column count

**Regression watchlist (Zync-specific — mitigated, not open roadmap work):**

These were real bugs during the resize/GPU refactors. The fixes below are **shipped**; this list is kept so QA knows what to re-check after layout or renderer changes — not a backlog of missing items.

| Symptom | Mitigation (shipped) |
|---------|----------------------|
| xterm render surface not filling the host (black margins) | `terminal-container` fill CSS, `safeFitTerminal`, layout-transition fit |
| Duplicate framebuffer / double-draw | Unified resize scheduler (§5.2); single active renderer path (WebGL or DOM — **not** canvas; `@xterm/addon-canvas` removed in xterm 6, v2.18.0) |
| Garbled/overlapping text after resize | Trailing-edge resize scheduler + post-fit screen refresh |
| Backend PTY cols/rows out of sync with xterm | Hidden-tab resize gate (§5.1); PTY IPC deferred until layout settle |

xterm on Windows ConPTY disables scrollback reflow by design (`windowsPty` compatibility). Do not treat “old output stays narrow” as a bug.

---

## 4. P0 — Highest Impact

### 4.1 Lazy PTY spawn (active tab only) — **shipped**

**Label note:** Earlier drafts said “partial” because Zync **intentionally** keeps PTYs alive on sidebar-host and internal shell-tab switches (scrollback + running processes). That is policy, not incomplete work. Opt-in idle-host suspend (§7.2, §14) adds a separate background-kill path.

**Shipped behavior (2026-06):**

- Defer PTY spawn until a shell tab is first selected (`isActiveTab`).
- Keep PTYs alive when switching **sidebar hosts** or **internal shell tabs** (scrollback + running shells preserved).
- Suspend only the **active** shell PTY when leaving **Terminal view** for Files/Dashboard within the same workspace (`isTerminalView === false`). The terminal panel stays **laid out** under the Files overlay (`invisible`, not `display:none`) so xterm scrollback and GPU context are preserved.
- Modules: `ptyLifecycle.ts` (`spawnTerminalSession`, `suspendTerminalPty`), `spawnContext.ts`.

**Idle-host suspend — shipped:** Opt-in via Settings → Terminal → “Suspend idle host shells” (default **off**). Background host PTYs suspend after the configured idle timeout; scrollback stays; user presses **Enter** to resume. Busy shells (recent output/input) are deferred until quiet.

---

### 4.2 Serialize async `onData` (input reorder fix) — **done**

**Shipped:** `inputQueue.ts` — `enqueueTerminalInputTask` with per-session epoch bump on `clearTerminalInputQueue` (suspend/destroy). Ghost handlers run inside the queue worker.

---

### 4.3 Gate input on `terminal-ready` — **done**

**Shipped:** `inputPipeline.ts` — buffer while `starting` or `!spawned`; `handleTerminalReady` flushes on matching `generation`. `TerminalManager` snippet/plugin writes use `queueTerminalInput`.

---

### 4.4 Batch local PTY output — **done**

**Shipped:** Local reader uses shared `OUTPUT_BATCH_MS` (8ms) / `OUTPUT_FLUSH_THRESHOLD` (4KB) coalescing in `pty.rs`, mirroring the remote path.

---

## 5. P1 — Robustness & Code Quality

| # | Item | Issue | Proposal |
|---|------|-------|------------|
| 5.1 | Hidden-tab resize | ~~`ResizeObserver` runs when `!isVisible`~~ | **Done:** skip fit + IPC unless `isVisibleRef.current` |
| 5.2 | Resize path overlap | 5 mechanisms trigger fit/sync | **Done:** `createResizeScheduler` (60ms trailing) + safeFit/sync primitives; ResizeObserver, window, layout, visibility, renderer now all funnel through unified scheduler |
| 5.3 | Spawn duplication | ~~3 copies of spawn/restart boilerplate~~ | **Done:** `spawnTerminalSession`, `spawnTerminalFromStoreContext`, `attachTerminalLifecycleListeners`, `resolveLazyPtyAction`, `syncTerminalResize` |
| 5.4 | Dead `connection-wakeup` | ~~Listener in `terminal/Terminal.tsx`; nothing dispatches event~~ | **Done:** `dispatchTerminalConnectionWakeup` from `connectionSlice` on SSH reconnect; `tryWakeTerminalOnReconnect` in `terminalConnectionWakeup.ts` |
| 5.5 | Store ↔ UI coupling | ~~`terminalSlice` imported lifecycle from React component~~ | **Done:** lifecycle, cache, renderer, and service APIs live in `src/lib/terminal/`. `Terminal.tsx` wires hooks; `TerminalHost.tsx` is the connected-state presentation shell. `LOCAL_TERMINAL_CONNECTION_ID` is canonical in `connectionIds.ts` (re-exported from `tabService.ts`). |
| 5.6 | Split write paths | ~~`TerminalManager` sends `terminal:write` directly~~ | **Done:** route through `queueTerminalInput` |
| 5.7 | Child cleanup | Local `close()` aborts reader; child kill relies on `Drop` | **Done:** explicit `child.kill()` in PtyManager::close / close_by_connection (see src-tauri/src/pty.rs) |
| 5.8 | Input batch encoding | Full `pendingInput` re-encoded each keystroke | **Done:** track `pendingInputBytes` incrementally (encode only delta) |
| 5.9 | Disconnect tab wipe | `clearTerminals` on disconnect destroys cache + PTYs | **Done:** clearTerminals supports preservePendingRestore; on SSH disconnect we now set pendingRestore on tabs; UX documented in comments (tabs preserved for reconnect, local clears fully) |

---

## 6. P2 — Polish & Longer-Term

**Fix-related P2 items:** all shipped. What remains below is **optional polish** or tracked in other docs (ghost parity).

- **xterm 6.x upgrade (Phase 6)** — **shipped v2.18.0**; DOM fallback, addon bumps, ghost/cursor API fixes. See [§12](#12-phase-6--xterm-6x-terminal-milestone).
- **GPU acceleration (WebGL renderer)** — implemented; see [§11](#11-gpu-acceleration-webgl-renderer)
- Skip ghost suggestion IPC when tab is hidden — **done** (guarded behind `isVisibleRef`)
- Binary Tauri / Channel output — **done**; PTY output streams via Tauri `Channel` (raw `u32` generation header + bytes) from `terminalOutputStream.ts` / `pty.rs`. Legacy base64 event decode kept in `terminalOutputPayload.ts` for dev safety.
- Integration tests: spawn → resize → generation → close — **done** (`terminalLifecycleIntegration.test.mjs`)
- `Terminal.tsx` split — **done:** hooks + `TerminalHost.tsx` presentation shell (`useTerminalLifecycle`, `useTerminalTheme`, `useTerminalSearch`, `useTerminalGhost`, `useTerminalKeybindings`, dedicated subcomponents).
- Central terminal service API — **done:** `terminalService.ts` (`destroy`, `suspendAllForConnection`, `getRecentLines`); `terminalSlice` routes through it.
- Replace private xterm `_core._renderService` in `cursorPosition.ts` — **done** (Phase 6, v2.18.0)

**Deferred (optional — not terminal bug fixes):**

- `reflowCursorLine` / `windowsPty` tuning for rare Windows ConPTY edge cases (defaults are set in `xtermOptions.ts`; change only if QA finds a repro)
- Ghost fish-like parity tuning — see [TERMINAL_GHOST_SUGGESTIONS.md](./TERMINAL_GHOST_SUGGESTIONS.md) (separate from this roadmap)

---

## 7. Quick Wins vs Larger Refactors

### Quick wins (hours – 1 day each)

1. Gate `ResizeObserver` on `isVisibleRef`
2. Read `starting` / gate flush on `terminal-ready`
3. Local output batching in `pty.rs`
4. Extract `spawnTerminalSession()` helper
5. Remove or implement `connection-wakeup`
6. Track `pendingInputBytes` in input batcher
7. Route `TerminalManager` snippet writes through batching helper

### Larger refactors (multi-day)

1. **Lazy tab activation model** — biggest perf win
2. **Split `Terminal.tsx`** — maintainability
3. **Input pipeline module** — serial queue + ghost as middleware
4. **Central resize coordinator** — one subscriber for layout/window/visibility
5. **Terminal service layer** — decouple Zustand from React component exports

---

## 8. Suggested Implementation Order

```
Phase 1 — **shipped** (see §10 exit criteria)
  - Input queue (4.2) ✓
  - Ready gating (4.3) ✓
  - Hidden-tab resize gate (5.1) ✓
  - Local output batching (4.4) ✓
  - TerminalManager writes via queueTerminalInput (5.6) ✓

Phase 2 — **shipped** (see §10 exit criteria)
  - Lazy PTY policy (4.1) ✓
  - Spawn/lifecycle extraction (5.3) ✓
  - Integration tests (spawn/resize/close/generation) ✓
  - connection-wakeup wired (5.4) ✓

Phase 3 (2–3 days)
  - ~~terminalCache module extraction (5.5)~~ — done (cache, ligatures, instance API, renderer setup)

Phase 4 — **done**
  - ~~Resize unification (5.2)~~ — done via createResizeScheduler + call site consolidation
  - ~~Child kill (5.7)~~ — done with explicit `child.kill()`
  - ~~Input batch encoding (5.8)~~ — done
  - ~~Disconnect tab wipe (5.9)~~ — done (clearTerminals preserve option + set pendingRestore on disconnect)
  - ~~Integration tests~~ — done (terminalLifecycleIntegration, terminalPtyLifecycle, terminalReconnect*, terminalSpawn*, etc.)

Phase 5 — **done**
  - WebGL renderer with canvas fallback (§11) — fallback path to be replaced in Phase 6
  - Settings toggle + context-loss recovery + renderer status panel

Phase 6 — **shipped v2.18.0** (see §12)
  - xterm 6.x + DOM fallback ✓
  - Ghost/cursor API fixes ✓
  - Renderer policy, diagnostics, tests ✓
  - Manual QA signed off (Windows WebView2)

Phase 7 — **complete** (see §13)
  - Terminal service layer (`terminalService.ts`) ✓
  - Idle-host PTY suspend (opt-in) ✓
  - `Terminal.tsx` split ✓
  - xterm 6 options (`xtermOptions.ts`) ✓
```

---

## 9. Key File Map

| File | Responsibility |
|------|----------------|
| `src/components/terminal/Terminal.tsx` | xterm UI shell: resize, IPC, ghost integration, theme |
| `src/components/terminal/TerminalManager.tsx` | Multi-tab shell; mounts all tabs |
| `src/store/terminalSlice.ts` | Tab CRUD; calls `destroyTerminalInstance` from `lib/terminal` |
| `src-tauri/src/pty.rs` | PTY spawn, read/write, resize, local + remote paths |
| `src-tauri/src/commands.rs` | `terminal_create`, `terminal_write`, `terminal_resize` |
| `src/lib/tauri-ipc.ts` | Channel mapping; fire-and-forget `send()` |
| `src/lib/ghostSuggestions/*` | Input tracking, inline/popup suggestions |
| `src/index.css` | `.terminal-container` sizing overrides |
| `src/lib/terminal/terminalCache.ts` | Module-level xterm instance cache |
| `src/lib/terminal/ligatures.ts` | `LigaturesAddon` load/dispose |
| `src/lib/terminal/rendererSetup.ts` | GPU + ligatures activation orchestration |
| `src/lib/terminal/instanceApi.ts` | `destroyTerminalInstance`, `getTerminalRecentLines` |
| `src/lib/terminal/renderer*.ts` | GPU policy, WebGL load, DOM fallback, diagnostics |
| `src/lib/terminal/terminalService.ts` | Store-facing destroy/suspend API (Phase 7) |
| `src/lib/terminal/terminalIdlePty.ts` | Idle-host PTY suspend scheduler (`MainLayout` when setting enabled) |
| `src/lib/terminal/xtermOptions.ts` | Central `ITerminalOptions` builder for xterm 6 (Phase 7.4) |
| `src/lib/terminal/inputPipeline.ts` | Input batching, ready gating, flush |
| `src/lib/terminal/inputQueue.ts` | Serialized async onData / ghost middleware |
| `src/lib/terminal/ptyLifecycle.ts` | `spawnTerminalSession`, `suspendTerminalPty` |
| `src/lib/terminal/spawnContext.ts` | CWD/shell resolution for spawn |
| `src/lib/terminal/terminalSpawn.ts` | Store-aware `spawnTerminalFromStoreContext` |
| `src/lib/terminal/terminalLazyPty.ts` | Lazy PTY visibility policy (`resolveLazyPtyAction`) |
| `src/lib/terminal/terminalConnectionWakeup.ts` | Reconnect wakeup dispatch + handler |
| `src/lib/terminal/terminalLifecycleListeners.ts` | Generation-gated output/ready/exit listeners |
| `src/lib/terminal/terminalResizeSync.ts` | Deduped PTY resize IPC |
| `src/lib/terminal/index.ts` | Public API for UI + store |
| `@xterm/addon-webgl` | Loaded lazily by `rendererController.ts` |
| `src/lib/ghostSuggestions/cursorPosition.ts` | Char-measure element sizing (xterm 6; no private `_core` APIs) |

---

## 10. Exit Criteria

Terminal optimization work can be considered **Phase 1 complete** when:

- [x] Keystrokes cannot reorder under fast typing + ghost Tab resolution (`inputQueue.ts` + agent tests)
- [x] No silent `"Session not found"` on input immediately after tab open (`inputPipeline.ts` ready/suspend gating)
- [x] Hidden tabs do not trigger fit or PTY resize IPC (`isVisibleRef` gate on `ResizeObserver`)
- [x] Local fast output does not saturate IPC (batched comparable to remote)

**Phase 2 complete** when:

- [x] Lazy PTY policy finalized (defer spawn + view suspend; idle-host suspend deferred)
- [x] `Terminal.tsx` spawn/lifecycle extracted to `lib/terminal/` (`terminalSpawn`, `terminalLazyPty`, `terminalConnectionWakeup`, `terminalLifecycleListeners`, `terminalResizeSync`)
- [x] `connection-wakeup` wired from `connectionSlice` on SSH reconnect
- [x] Basic integration tests cover spawn/resize/close/generation (`terminalLifecycleIntegration.test.mjs`)

**Phase 2 shipped modules:**

- [x] Core lifecycle modules (`ptyLifecycle`, `spawnContext`, `inputPipeline`, `inputQueue`)
- [x] Defer spawn + view suspend; host/shell tab switches keep PTYs alive
- [x] `resolveLazyPtyAction`, `dispatchTerminalConnectionWakeup`, `tryWakeTerminalOnReconnect`

**GPU acceleration (Phase 5) complete** when:

- [x] WebGL renderer active by default on supported Tauri/WebView2 targets (`gpuAcceleration: true`)
- [x] Automatic fallback when WebGL init or context loss occurs (DOM on xterm 6)
- [x] Ligatures + GPU compatible (WebGL → ligatures → WebGL reactivate)
- [x] WebGL2 probe before load; init failure vs context-loss split
- [x] Renderer session ownership in `lib/terminal/rendererSession.ts`
- [x] Automated tests: policy, capability, session, controller sync
- [x] Manual QA: transparency + resize/fit under WebGL on Windows WebView2 (signed off v2.18.0)

**Phase 6 (xterm 6.x) complete** when:

- [x] All `@xterm/*` packages on xterm 6–compatible versions; `@xterm/addon-canvas` removed (v2.18.0)
- [x] WebGL primary; DOM fallback on GPU off / init failure / context loss
- [x] Ghost cursor positioning uses layout-derived cell dimensions (no `_core._renderService`)
- [x] Tab switch perf not regressed vs 2.17.0 (single active workspace mount unchanged)
- [x] `npm run test:terminal-renderer` + terminal agent tests pass
- [x] Manual QA matrix signed off on Windows WebView2 (theme/transparency, Shell 1↔2 GPU restore, DOM fallback)

---

## 11. GPU Acceleration (WebGL Renderer)

### Status: implemented on xterm 6.x (v2.18.0)

GPU rendering is implemented via `src/lib/terminal/` and wired from `terminal/Terminal.tsx`. Non-WebGL paths use xterm's built-in **DOM renderer** (canvas addon removed in xterm 6.0).

| Module | Role |
|--------|------|
| `types.ts` | `TerminalRendererKind`, `TerminalRendererState` |
| `rendererPolicy.ts` | Pure policy: WebGL vs DOM from settings + context-loss blocks |
| `webglCapability.ts` | Cached WebGL2 probe before attempting load |
| `rendererLifecycle.ts` | Dispose / explicit DOM fallback + screen refresh |
| `rendererSession.ts` | Per-`sessionId` renderer state ownership |
| `rendererController.ts` | Lazy WebGL load, init vs context-loss failure paths |
| `rendererDiagnostics.ts` | Renderer health summaries for settings UI |
| `terminalCache.ts` | Shared xterm instance cache |
| `ligatures.ts` | Ligatures addon load/dispose |
| `rendererSetup.ts` | Applies GPU + ligatures in xterm-recommended order |
| `instanceApi.ts` | Tab destroy + AI context line export |
| `index.ts` | Public API surface for UI, store, and tests |

**Settings:** `settings.terminal.gpuAcceleration` (default `true`). Toggle in Settings → Terminal. Compatible with font ligatures. **Renderer status** panel shows active renderer for the focused tab.

**Tests:** `npm run test:terminal-renderer` (policy, WebGL probe, session, controller, diagnostics)

### Previous state (pre-implementation)

| Layer | Renderer | GPU? |
|-------|----------|------|
| **Before** | xterm 5 default **Canvas** (2D CPU) | No |
| **Package installed** | `@xterm/addon-webgl` ^0.19.0 | Was not loaded |
| **Also installed** | `@xterm/addon-canvas` ^0.7.0 | Loaded on WebGL dispose / GPU off |

`terminal/Terminal.tsx` loads `FitAddon`, `SearchAddon`, `WebLinksAddon`. GPU and ligatures load via `lib/terminal`.

```765:772:zync/src/components/terminal/Terminal.tsx
      fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();
      searchAddon = new SearchAddon();

      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);
      term.loadAddon(searchAddon);
```

### Why enable it

WebGL2 moves glyph atlas rendering to the GPU. Benefits for Zync:

- **Fast output** — `npm install`, log tailing, build output (pairs well with local output batching §4.4)
- **Large scrollback** — smoother scroll and refresh with deep buffers
- **Resize** — fewer canvas repaint stalls during `fit()` on maximize/sidebar drag
- **Multi-tab** — lower CPU per tab once lazy PTY spawn (§4.1) limits active shells

WebGL does **not** fix scrollback reflow on maximize (that remains correct terminal semantics per §3).

### Constraints and conflicts

| Concern | Detail |
|---------|--------|
| **Font ligatures** | `LigaturesAddon` uses character joiners; WebGL renderer handles joined ranges. Activation order: WebGL → ligatures → WebGL reactivate (texture atlas picks up `font-feature-settings`). |
| **Transparency** | Zync uses `allowTransparency: true` and host-level `color-mix` backgrounds. Test WebGL + transparent host on Windows WebView2; fall back if alpha compositing glitches. |
| **Context loss** | Browser/GPU can drop WebGL context (OOM, sleep/resume, driver reset). Must handle `webglcontextlost` — dispose `WebglAddon`, fall back to DOM (Phase 6; today canvas addon), optionally retry on next focus. |
| **Tauri WebView2** | WebGL2 is generally available on Windows 10+; still probe at runtime and never assume success. |
| **Ghost overlays** | `GhostSuggestionOverlay` reads cell metrics from xterm internals — re-test pixel alignment under WebGL. |

### Recommended implementation

Mirror the existing lazy `LigaturesAddon` pattern in `Terminal.tsx`:

1. **Settings** — add `settings.terminal.gpuAcceleration: boolean` (default `true` on desktop).
2. **Load order** — after `term.open(container)`, before heavy output:
   ```ts
   import { WebglAddon } from '@xterm/addon-webgl';
   const addon = new WebglAddon();
   addon.onContextLoss(() => { /* dispose, mark cache webgl=false, canvas fallback */ });
   term.loadAddon(addon);
   ```
3. **Fallback chain** — `WebGL → DOM` (Phase 6 target; shipped as `WebGL → @xterm/addon-canvas` on 5.5); never brick the terminal.
4. **Ligatures gate** — if `fontLigatures && gpuAcceleration`, prefer ligatures and skip WebGL (document in Settings UI).
5. **Cache fields** — extend `TerminalCache` with `webglAddon?`, `renderer: 'webgl' | 'canvas'`, `webglLoadPromise?`.
6. **Dispose** — `destroyTerminalInstance` must dispose WebGL addon before `term.dispose()`.
7. **Refit** — after WebGL load, call existing `refitTerminal()` + `refreshTerminalScreen()`.

### Settings UI (TerminalTab)

Add toggle under Typography or a new "Performance" group:

- **GPU acceleration (WebGL)** — default on; tooltip: "Faster rendering for large output. Disable if you see visual glitches. Incompatible with font ligatures."

### Testing matrix

| Scenario | Pass criteria |
|----------|---------------|
| Windows WebView2, default font | WebGL active; fast `cat` of large file stays responsive |
| Maximize / sidebar resize | No renderer duplication; fit still correct |
| Enable ligatures | WebGL off; ligatures render |
| Enable terminal transparency | No double-alpha or black flash |
| Sleep / resume laptop | Context loss recovers or falls back without blank terminal |
| Integrated GPU + remote desktop | Graceful DOM fallback (Phase 6) |

### Priority

**Shipped** as modular Phase 5 foundation. `terminalCache` and the service layer already live under `src/lib/terminal/` (Phase 7); non-WebGL fallback is xterm's **DOM renderer** (canvas addon removed with xterm 6).

### Future-proofing notes

- Policy is pure (`rendererPolicy.ts`) — easy to unit test; non-WebGL kind is `dom` in types/diagnostics (canvas addon and aliases removed in Phase 6).
- `webglContextLossBlocked` prevents retry loops after GPU context loss only; init/probe failures remain retryable.
- `isWebgl2Available()` probes before loading the addon.
- Renderer state lives in `rendererSession.ts`, not on `TerminalCache`.
- Ligatures and WebGL remain mutually exclusive by policy, not ad-hoc UI checks.
- `clearTerminalRendererSession` is called from `destroyTerminalInstance` to avoid GPU leaks on tab close.

### References

- [@xterm/addon-webgl README](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl) — context loss handling
- [@xterm/addon-ligatures README](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-ligatures) — ligatures use DOM renderer when GPU is off
- `package.json` — `@xterm/addon-webgl` only; `@xterm/addon-canvas` removed (xterm 6.0, §12)

---

## 12. Phase 6 — xterm 6.x Terminal Milestone

**Status:** **shipped** (v2.18.0, 2026-06-28)  
**Current:** `@xterm/xterm` ^6.0.0, `@xterm/addon-webgl` ^0.19.0 — `@xterm/addon-canvas` removed

### Goal

Single focused milestone: upgrade to **xterm 6.x**, remove deprecated canvas addon, keep WebGL as primary renderer with **DOM fallback**, and re-validate ghost overlays + tab-switch perf on Windows WebView2.

### Why one milestone (not canvas-on-5.5 first)

- xterm **6.0** removed `@xterm/addon-canvas` — DOM or WebGL only.
- Bumping 5.5 → 6.x and swapping canvas → DOM in one pass avoids duplicate renderer migration work.
- P0/P1/P2 lifecycle and perf work (2.17.0) is shipped; renderer stack is modular enough to absorb the bump.

### xterm 6 breaking changes to handle

| Area | Detail |
|------|--------|
| **Canvas addon** | Removed — WebGL → **DOM** fallback only |
| **Viewport / scrollbar** | Reworked — re-test fit, resize, Files ↔ Terminal overlay |
| **`ITerminalOptions.overviewRuler`** | Moved under `overviewRuler` object (if used) |
| **Alt+arrow → Ctrl+arrow hack** | Removed — add explicit keybindings if Zync relied on it |
| **`windowsMode` / `fastScrollModifier`** | Removed from options |
| **Private APIs** | `cursorPosition.ts`, `GhostSuggestionListOverlay.tsx` use `_core._renderService` — fix or replace on 6.x |

### Target renderer behavior (unchanged intent)

| Situation | Renderer |
|-----------|----------|
| GPU on, WebGL2 available | `@xterm/addon-webgl` |
| GPU off, WebGL unavailable, context lost, inactive-tab GPU release | xterm **DOM renderer** |

**Fallback chain:** `WebGL → DOM → log warning` — never blank the terminal.

### Work packages

**1. Dependencies** (`package.json`, lockfile)

- Bump `@xterm/xterm` to **^6.0.0**
- Bump all `@xterm/addon-*` to versions peer-compatible with xterm 6 (install together, one `npm install`)
- **Remove** `@xterm/addon-canvas`

**2. Renderer stack** (`src/lib/terminal/renderer*.ts`, `useTerminalLifecycle.ts`)

- Delete `CanvasAddon` load/dispose paths
- `activateCanvasRenderer` → DOM fallback (dispose WebGL + `refreshTerminalScreen`)
- Rename types/diagnostics: `canvas` → `dom` where user-facing
- Re-run context-loss + inactive-tab GPU release paths

**3. Ghost / cursor overlays**

- `src/lib/ghostSuggestions/cursorPosition.ts` — stop depending on `_core._renderService` if 6.x moves it; prefer public APIs or documented dimensions
- `GhostSuggestionListOverlay.tsx` — same for cell width
- Re-test inline + popup ghost alignment under WebGL and DOM

**4. Terminal options audit**

- Grep for removed options (`windowsMode`, `fastScrollModifier`, old `overviewRulerWidth`)
- Review `Terminal.tsx` / `useTerminalLifecycle.ts` `ITerminalOptions` for 6.x compatibility

**5. Tests + QA**

- `npm run build`
- `npm run test:terminal-renderer`
- `npm run test:all-agent` (terminal-related)
- Manual matrix (§11 testing table): WebGL default, GPU off, ligatures, transparency, resize/maximize, context loss, Files ↔ Terminal, tab switch perf, large `cat`

### Exit criteria

- [x] All `@xterm/*` packages on xterm 6–compatible versions; `@xterm/addon-canvas` removed
- [x] WebGL primary; DOM fallback on GPU off / init failure / context loss
- [x] Ghost cursor positioning uses layout-derived cell dimensions (no `_core._renderService`)
- [x] Tab switch perf not regressed vs 2.17.0 (~65–115ms Shell ↔ Files)
- [x] `npm run test:terminal-renderer` + terminal agent tests pass
- [x] Manual QA matrix (§11) signed off on Windows WebView2

---

## 13. Phase 7 — Maintainability & Scale

**Status:** **complete**  
**Shipped:** post-2.18.0 (refactor, xterm 6 options, opt-in idle-host suspend)

### Goal

Reduce terminal module coupling, reclaim resources from background workspace hosts, and optionally adopt xterm 6 maintainability features — without regressing 2.17.0/2.18.0 tab-switch perf or scrollback preservation.

### Work packages

| # | Item | Status | Detail |
|---|------|--------|--------|
| 7.1 | Terminal service layer | **done** | `terminalService.ts` — `destroy`, `getRecentLines`, `suspendAllForConnection`; `terminalSlice` routes through service |
| 7.2 | Idle-host PTY suspend | **done** | Opt-in (`suspendIdleHostPtys`, default off); manual Enter-to-resume; idle message instead of auto SSH respawn |
| 7.3 | `Terminal.tsx` split | **done** | `Terminal.tsx` (hooks/wiring) + `TerminalHost.tsx` (connected shell); `useTerminalSearch`, `useTerminalGhost`, `useTerminalKeybindings`, `TerminalSearchBar`, `TerminalDisconnectedView`, `TerminalContextMenu` |
| 7.4 | xterm 6 options | **done** | `xtermOptions.ts` — `reflowCursorLine: false` (§3), `scrollback: 5000`, `windowsPty.conpty` for local Windows only; synchronized output is runtime DECSET (no init option) |
| 7.5 | Legacy canvas aliases | **done** | Removed `activateCanvasRenderer` / `ensureCanvasRenderer*` re-exports |

### Idle-host suspend behavior

| Event | Action |
|-------|--------|
| User selects another sidebar host | Schedule PTY suspend for previous host's shell tabs (default 2 min) |
| User returns within idle window | Cancel timer; PTYs still live |
| Idle timer fires | `suspendAllTerminalsForConnection` — kills backend PTY, preserves `terminalCache` scrollback |
| User returns after suspend | Lazy spawn on active shell tab selection (existing 4.1 policy) |

### Exit criteria

- [x] `terminalService` is the store-facing destroy/suspend entry point
- [x] Idle-host suspend wired in app + unit tests (`terminalIdlePty.test.mjs`, `terminalIdleHostSuspend.test.mjs`)
- [x] Idle-host suspend: opt-in setting + Enter-to-resume (no auto-respawn on return)
- [x] `Terminal.tsx` under ~500 lines with search/ghost in dedicated modules (~270 lines)
- [x] `npm run test:terminal-renderer` green including `terminalIdlePty.test.mjs`

---

## 14. Next Action Items

**Status:** **complete** (2026-06-29). All four items shipped; v2.19.0 awaits manual QA.

| # | Item | Status | Detail |
|---|------|--------|--------|
| 1 | **`terminal-exit` on explicit kill** | **done** | Natural shell exit (local reader / remote SSH manager) emits `terminal-exit`; programmatic `close` / `close_by_connection` only tear down handles. Frontend `suspendTerminalPty` sets suspend flags and idle notice synchronously. |
| 2 | **Process-aware idle suspend** | **done** | **Shipped idle suspend:** remote host shell tabs only (`shouldIdleSuspendConnection` excludes local). **Process probe:** `terminal_has_active_processes` uses local `sysinfo` child scan (fail-closed) when evaluating remote tabs during idle flush; remote busy detection still uses output/input. |
| 3 | **PTY output streaming** | **done** | `terminal:create` accepts a Tauri `Channel`; batched output sent as raw frames (`generation` u32 LE + PTY bytes). `terminal-output-*` events removed. |
| 4 | **Multi-host PTY scale** | **done** | On sidebar host switch with idle suspend enabled: all remote host shell tabs share the idle timer (no immediate suspend). Local shells are excluded from idle suspend. |

---

## Related Documents

- [TERMINAL_GHOST_SUGGESTIONS.md](./TERMINAL_GHOST_SUGGESTIONS.md) — ghost suggestion architecture
- [SESSION_PERSISTENCE.md](./SESSION_PERSISTENCE.md) — tab/terminal session restore
- [SETTINGS_SYSTEM.md](./SETTINGS_SYSTEM.md) — `settings.terminal` options