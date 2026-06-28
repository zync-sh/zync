# Zync Terminal — Optimization & Robustness Roadmap

**Last updated:** 2026-06-28 (Phase 6 shipped v2.18.0; Phase 7 in progress)
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

---

## 1. Executive Summary

The terminal stack has strong foundations: generation-gated lifecycle events, frontend input batching, remote output coalescing, remote resize coalescing, and a module-level xterm cache for tab persistence.

The largest remaining costs are:

| Area | Problem |
|------|---------|
| **Scale** | N tabs ⇒ N live PTYs, N ResizeObservers, N reader tasks (even when hidden) |
| **IPC** | Local PTY output is unbatched; remote path already batches |
| **Correctness** | Async `onData` can reorder keystrokes; input not gated on `terminal-ready` |
| **Structure** | `terminal/Terminal.tsx` (~1,300 lines) still couples xterm, IPC, ghost, theme, search, layout |
| **Resize** | Five overlapping fit/resize paths; hidden tabs still observe resize |

Recent hardening (commit `c10c082`): layout-transition safety timeout, always-on visual fit during transitions, window-resize refit, dev single-instance disabled in debug builds.

**Next priority (post-2.18.0):** **Phase 7 maintainability & scale** — terminal service layer, idle-host PTY suspend, `Terminal.tsx` split, optional xterm 6 features. Phase 6 (xterm 6 + DOM fallback) shipped in **v2.18.0**. See [§13](#13-phase-7--maintainability--scale).

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

**Buggy (Zync-specific — address via roadmap items):**

- xterm canvas not filling the host (large black margins, tiny render area)
- Literal duplicate rendering of the same framebuffer
- Garbled/overlapping text after resize
- Backend PTY cols/rows out of sync with xterm canvas (hidden-tab resize during layout transition)

xterm on Windows ConPTY disables scrollback reflow by design (`windowsPty` compatibility). Do not treat “old output stays narrow” as a bug.

---

## 4. P0 — Highest Impact

### 4.1 Lazy PTY spawn (active tab only) — **partial (shipped)**

**Shipped behavior (2026-06):**

- Defer PTY spawn until a shell tab is first selected (`isActiveTab`).
- Keep PTYs alive when switching **sidebar hosts** or **internal shell tabs** (scrollback + running shells preserved).
- Suspend only the **active** shell PTY when leaving **Terminal view** for Files/Dashboard within the same workspace (`isTerminalView === false`). The terminal panel stays **laid out** under the Files overlay (`invisible`, not `display:none`) so xterm scrollback and GPU context are preserved.
- Modules: `ptyLifecycle.ts` (`spawnTerminalSession`, `suspendTerminalPty`), `spawnContext.ts`.

**Remaining (Phase 7):** Idle-timer suspend for background workspace hosts — **deferred** (`terminalIdlePty.ts` exists but is not wired). Killing remote SSH PTYs after 2 minutes forces a new login banner on return and feels like a cleared terminal; host switches keep PTYs alive like 2.17.0 until an opt-in setting + gentler respawn UX ships.

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
| 5.5 | Store ↔ UI coupling | ~~`terminalSlice` imported lifecycle from React component~~ | **Done (partial):** `terminalCache`, `destroyTerminalInstance`, ligatures, renderer setup in `src/lib/terminal/`; UI shell remains in `terminal/Terminal.tsx` |
| 5.6 | Split write paths | ~~`TerminalManager` sends `terminal:write` directly~~ | **Done:** route through `queueTerminalInput` |
| 5.7 | Child cleanup | Local `close()` aborts reader; child kill relies on `Drop` | **Done:** explicit `child.kill()` in PtyManager::close / close_by_connection (see src-tauri/src/pty.rs) |
| 5.8 | Input batch encoding | Full `pendingInput` re-encoded each keystroke | **Done:** track `pendingInputBytes` incrementally (encode only delta) |
| 5.9 | Disconnect tab wipe | `clearTerminals` on disconnect destroys cache + PTYs | **Done:** clearTerminals supports preservePendingRestore; on SSH disconnect we now set pendingRestore on tabs; UX documented in comments (tabs preserved for reconnect, local clears fully) |

---

## 6. P2 — Polish & Longer-Term

- **xterm 6.x upgrade (Phase 6)** — **shipped v2.18.0**; DOM fallback, addon bumps, ghost/cursor API fixes. See [§12](#12-phase-6--xterm-6x-terminal-milestone).
- **GPU acceleration (WebGL renderer)** — implemented; see [§11](#11-gpu-acceleration-webgl-renderer)
- Skip ghost suggestion IPC when tab is hidden — **done** (guarded behind `isVisibleRef`)
- Binary Tauri event payloads instead of `number[]` serde for output — **done (base64)**; `pty.rs` emits `data` as base64; frontend `decodeTerminalOutputData()` in `terminalOutputPayload.ts`. True Tauri `Channel` streaming remains optional follow-up.
- ~~Integration tests: spawn → resize → generation → close sequences~~ — done (`terminalLifecycleIntegration.test.mjs`)
- Split `Terminal.tsx` into `TerminalHost`, lifecycle hook, input pipeline, theme hook
- Central terminal service API for store (`terminalService.destroy(id)`)
- Optional `reflowCursorLine` / `windowsPty` tuning for Windows ConPTY edge cases
- ~~Replace private xterm `_core._renderService` usage in `cursorPosition.ts` when upgrading xterm~~ — **done** (Phase 6, v2.18.0)

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

Phase 7 — **in progress** (see §13)
  - Terminal service layer (`terminalService.ts`) ✓
  - Idle-host PTY suspend (`terminalIdlePty.ts`) — deferred (SSH UX)
  - `Terminal.tsx` split (search/ghost extraction) ✓
  - Optional xterm 6 features: `reflowCursorLine`, synchronized output tuning
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
| `src/lib/terminal/terminalIdlePty.ts` | Idle-timer PTY suspend on workspace host switch (Phase 7) |
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
| Maximize / sidebar resize | No canvas duplication; fit still correct |
| Enable ligatures | WebGL off; ligatures render |
| Enable terminal transparency | No double-alpha or black flash |
| Sleep / resume laptop | Context loss recovers or falls back without blank terminal |
| Integrated GPU + remote desktop | Graceful DOM fallback (Phase 6) |

### Priority

**Shipped** as modular Phase 5 foundation. Future work: move `terminalCache` into `src/lib/terminal/` and route all lifecycle through the service layer (roadmap §5.5, §7 larger refactors).

### Future-proofing notes

- Policy is pure (`rendererPolicy.ts`) — easy to unit test; Phase 6 retargets non-WebGL kind to DOM (rename `canvas` → `dom` in types/diagnostics as needed).
- `webglContextLossBlocked` prevents retry loops after GPU context loss only; init/probe failures remain retryable.
- `isWebgl2Available()` probes before loading the addon.
- Renderer state lives in `rendererSession.ts`, not on `TerminalCache`.
- Ligatures and WebGL remain mutually exclusive by policy, not ad-hoc UI checks.
- `clearTerminalRendererSession` is called from `destroyTerminalInstance` to avoid GPU leaks on tab close.

### References

- [@xterm/addon-webgl README](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-webgl) — context loss handling
- [@xterm/addon-ligatures README](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-ligatures) — canvas renderer requirement
- `package.json` — `@xterm/addon-webgl`, `@xterm/addon-canvas` (canvas removed in xterm 6.0; see §12)

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

**Status:** in progress (post-2.18.0)  
**Estimate:** 3–5 days focused work

### Goal

Reduce terminal module coupling, reclaim resources from background workspace hosts, and optionally adopt xterm 6 maintainability features — without regressing 2.17.0/2.18.0 tab-switch perf or scrollback preservation.

### Work packages

| # | Item | Status | Detail |
|---|------|--------|--------|
| 7.1 | Terminal service layer | **done** | `terminalService.ts` — `destroy`, `getRecentLines`, `suspendAllForConnection`; `terminalSlice` routes through service |
| 7.2 | Idle-host PTY suspend | **deferred** | `terminalIdlePty.ts` scaffold only — not wired; remote SSH respawn shows duplicate `Last login` / poor scrollback UX |
| 7.3 | `Terminal.tsx` split | **done** | `useTerminalSearch`, `useTerminalGhost`, `useTerminalKeybindings`, `TerminalSearchBar`, `TerminalDisconnectedView`, `TerminalContextMenu` |
| 7.4 | xterm 6 options | pending | Evaluate `reflowCursorLine`, synchronized output tuning for Windows ConPTY |
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
- [x] Idle-host suspend unit tests (`terminalIdlePty.test.mjs`) — module only, not active in app
- [ ] Idle-host suspend: re-enable only with opt-in setting + no auto-respawn on SSH return
- [x] `Terminal.tsx` under ~500 lines with search/ghost in dedicated modules (~270 lines)
- [x] `npm run test:terminal-renderer` green including `terminalIdlePty.test.mjs`

---

## Related Documents

- [TERMINAL_GHOST_SUGGESTIONS.md](./TERMINAL_GHOST_SUGGESTIONS.md) — ghost suggestion architecture
- [SESSION_PERSISTENCE.md](./SESSION_PERSISTENCE.md) — tab/terminal session restore
- [SETTINGS_SYSTEM.md](./SETTINGS_SYSTEM.md) — `settings.terminal` options