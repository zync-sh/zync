# Port Forwarding & Tunnels — Current Documentation

**Last updated:** 2026-07-08
**SSH stack:** russh sessions in `commands.rs` / `ssh.rs`  
**User-facing guide:** [zync.thesudoer.in/docs/port-forwarding](https://zync.thesudoer.in/docs/port-forwarding)

Canonical reference for Zync’s SSH tunnel system: product behavior, architecture, sync, known limits, and the active improvement plan (reconnect, SOCKS, import).

---

## Table of Contents

1. [What it is](#1-what-it-is)
2. [Goals and non-goals](#2-goals-and-non-goals)
3. [Guiding principles](#3-guiding-principles)
4. [Architecture](#4-architecture)
5. [Tunnel types](#5-tunnel-types)
6. [Lifecycle](#6-lifecycle)
7. [UI surfaces](#7-ui-surfaces)
8. [Auto-start](#8-auto-start)
9. [Sync & restore](#9-sync--restore)
10. [IPC commands](#10-ipc-commands)
11. [Persistence schema](#11-persistence-schema)
12. [File map](#12-file-map)
13. [Testing](#13-testing)
14. [Phase 1 manual QA playbook](#14-phase-1-manual-qa-playbook)
15. [Known limits & bugs](#15-known-limits--bugs)
16. [Improvement plan](#16-improvement-plan)
17. [Future features](#17-future-features)
18. [Backend modularization](#18-backend-modularization)

---

## 1. What it is

Zync manages **SSH port forwards** visually — the same jobs as `ssh -L`, `ssh -R`, and `ssh -D`, without hand-editing commands for every session.

| Capability | Status |
|------------|--------|
| Local forward (`-L`) — listen locally, forward via SSH | Shipped |
| Remote forward (`-R`) — listen on remote, forward to local target | Shipped |
| Per-connection **Port Forwarding** tab | Shipped |
| Global tunnel dashboard (sidebar) | Shipped |
| CRUD, groups, presets, bulk create | Shipped |
| SSH command import (`ssh -L` / `-R` / `-D` paste) | Shipped |
| Port conflict detection + suggested alternate port | Shipped (local bind) |
| Opt-in **auto-start on connect** | Shipped |
| Open in browser / copy address | Shipped |
| Sync domain + bundled restore (with host) | Shipped |
| Dynamic / SOCKS forward (`-D`) | Shipped |
| `~/.ssh/config` `LocalForward` / `RemoteForward` import | **Not implemented** |
| Auto-restart tunnels after reconnect | Shipped (active + `autoStart` on reconnect) |

Tunnels require an **active SSH session** on the host connection. They stop when the session drops.

---

## 2. Goals and non-goals

### Goals

- Replace ad-hoc `ssh -L/-R` for common dev workflows (DB, HTTP dev server, internal APIs)
- Persist tunnel configs per connection; survive app restarts
- Global visibility across all connections
- Safe port-conflict UX on local binds
- Sync tunnels with hosts (scoped by `connection_id` / logical host id)
- Fail with clear errors (connection closed, port in use, remote refused)

### Non-goals (current scope)


- Jump-host topology editor (tunnels use the existing connected session)
- Per-tunnel bandwidth metrics dashboard — planned
- Arbitrary `ssh -J` multi-hop tunnel chains beyond the active session

---

## 3. Guiding principles

1. **Session-bound** — a tunnel is only as stable as its SSH connection.
2. **One start path** — all UI entry points must respect saved `bind_address` (see [T1 in §14](#t1--unified-start-path--bind-address)).
3. **Explicit lifecycle** — start/stop are user-visible; auto-start is opt-in per tunnel.
4. **Host-scoped sync** — tunnel restore follows restored hosts; orphans are skipped.
5. **Event-driven UI** — `tunnel:status-change` drives status; no polling in tunnel UIs.

---

## 4. Architecture

```text
UI (TunnelManager | GlobalTunnelList | AddTunnelModal)
  → tunnelSlice (Zustand)
    → tunnel:start | tunnel:stop
      → commands.rs (load tunnels.json, resolve SSH session)
        → TunnelManager (`tunnels/manager.rs`)
          → russh: channel_open_direct_tcpip (local)
          → russh: tcpip_forward + forwarded-tcpip handler (remote)
          → SOCKS5 handshake + per-client direct-tcpip (dynamic)
  ← tunnel:status-change (active | stopped | error)
```

### Runtime state (`TunnelManager`)

| Map | Key | Value |
|-----|-----|-------|
| `local_listeners` | `tunnel_runtime_id` — `local:…`, `dynamic:{connectionId}:{localPort}:{bind}` | TcpListener abort handle + cancel broadcast |
| `remote_forwards` | `remote_forward_map_key` — `{connectionId}:{remotePort}` | `(local_host, local_port, bind_address)` |

### SSH integration

- `TunnelManager` is cloned into the russh `Client` handler for incoming `forwarded-tcpip` channels on remote forwards.
- On disconnect, `stop_tunnels_for_connections()` stops runtime forwards and emits status events.

---

## 5. Tunnel types

### Local forward (`type: "local"`)

Equivalent to `ssh -L [bind:]localPort:remoteHost:remotePort`.

- Binds `TcpListener` on `bind_address:local_port` (default `127.0.0.1`).
- Each accepted TCP connection opens `channel_open_direct_tcpip` to `remote_host:remote_port` over the SSH session.

### Remote forward (`type: "remote"`)

Equivalent to `ssh -R [bind:]remotePort:localHost:localPort`.

- Calls `tcpip_forward` on the SSH server for `bind_address:remote_port`.
- Incoming forwarded connections are proxied to `remote_host:local_port` on the machine where Zync runs (field name `remote_host` in schema — stores the **local target host** for `-R`).

**Server requirement:** Remote binds on non-loopback addresses need `GatewayPorts` / `AllowTcpForwarding` on `sshd` (documented on the marketing site).

### Dynamic forward / SOCKS (`type: "dynamic"`)

Equivalent to `ssh -D [bind:]localPort`.

- Binds `TcpListener` on `bind_address:local_port` (default `127.0.0.1`).
- Each accepted connection runs a **SOCKS5** handshake (RFC 1928 subset: no-auth, CONNECT only).
- Per-client target is opened via `channel_open_direct_tcpip` through the SSH session.
- Persisted sentinel fields: `remote_host: "*"`, `remote_port: 0` (no fixed remote target).

**Scope (v1):** IPv4, domain, and IPv6 targets; UDP ASSOCIATE and BIND are not supported.

**Security:** Binding to `0.0.0.0` exposes the SOCKS port on the LAN — use loopback unless intentional.

**Modules:** `tunnels/socks5.rs` (protocol), `tunnels/dynamic.rs` (per-client handler), `tunnels/manager.rs::start_dynamic_forwarding`.

---

## 6. Lifecycle

| Event | Behavior |
|-------|----------|
| **Create / edit** | `tunnel:save` → `tunnels.json` |
| **Start** | Requires connected session; emits `tunnel:status-change` → `active` or `error` |
| **Stop** | `tunnel:stop` → tears down listener or `cancel_tcpip_forward` |
| **SSH disconnect** | Runtime tunnels stopped; `tunnel:status-change` → `stopped` |
| **Transport drop** (pipe break) | Fatal SSH errors + 15s session probe stop active listeners; `connection:transport-lost` → `handleTransportLost` (suspend PTY, keep tabs) + active-only tunnel stop; `tunnel:list` probes dead sessions |
| **Reconnect** | Restarts tunnels that were **active before disconnect** plus any with `autoStart: true` (`tunnelReconnectService.ts`) |
| **Delete** | `tunnel:delete` removes config (stop first if active) |

Port conflict (local): backend returns a message with process hint and **suggested next free port**; UI may offer one-click switch (`original_port` tracks revert on stop).

---

## 7. UI surfaces

| Surface | Path | State model |
|---------|------|-------------|
| Per-connection tab | `TunnelManager.tsx` | `tunnelSlice`; `tunnel:status-change` events |
| Global dashboard | `GlobalTunnelList.tsx` | `tunnelSlice`; search; grid/list; group collapse; events |
| Add / edit | `AddTunnelModal.tsx` | Presets from `tunnelPresets.ts` |
| Import | `ImportSSHCommandModal.tsx` | `ssh_parse_command` backend |

**Global list grouping:** UI groups by user-defined `group` field, **not** by connection. Connection name appears on each card.

All UI start/stop paths go through `tunnelSlice.startTunnel` → `tunnel:start` (honors saved `bindAddress`).

---

## 8. Auto-start

**Setting:** per-tunnel `autoStart` in Add Tunnel modal.

**Trigger:** After successful `connectionSlice.connect()`:

1. `loadTunnels(connectionId)`
2. `restartTunnelsAfterConnect()` — parallel `tunnel:start` for tunnels that were active before disconnect **or** have `autoStart` (`tunnelReconnectService.ts` + `tunnelAutoStartService.ts`)
3. On any success, pin `port-forwarding` feature on connection (silent; no view switch)

**Failures:** Toast per failed tunnel restart on reconnect.

**Modal copy:** “Auto-start tunnel when connection opens”.

---

## 9. Sync & restore

Tunnels are a **sync domain** (`tunnels`) in Vault / Sync & Backup.

| Command | Purpose |
|---------|---------|
| `sync_tunnels_upload` | Push local `tunnels.json` entries |
| `sync_tunnels_restore` | Merge remote tunnel records |
| `sync_connections_restore` | Orchestrator step after hosts — restores tunnels whose `connection_id` matches restored host logical ids |

Orphan tunnels (host not in restore set) are skipped with counts. See [VAULT.md](./VAULT.md) and [VAULT_ROADMAP.md](./VAULT_ROADMAP.md) for bundle restore UX.

---

## 10. IPC commands

| Command | Purpose |
|---------|---------|
| `tunnel:save` | Persist tunnel config |
| `tunnel:delete` | Remove config |
| `tunnel:list` | List for one `connectionId` with live `status` |
| `tunnel:getAll` | All tunnels with live `status` |
| `tunnel:start` | **Preferred** — load config by id, honor `bind_address` |
| `tunnel:start_local` | Legacy direct local forward — optional `bind_address`; UI does not use |
| `tunnel:start_remote` | Legacy direct remote forward — optional `bind_address`; UI does not use |
| `tunnel:stop` | Stop by saved tunnel id |
| `ssh_parse_command` | Parse pasted `ssh` command for `-L`/`-R`/`-D` |

### Events

| Event | Payload |
|-------|---------|
| `tunnel:status-change` | `{ id, status: active \| stopped \| error, error? }` |

---

## 11. Persistence schema

**File:** `{data_dir}/tunnels.json`

```json
{
  "tunnels": [
    {
      "id": "uuid",
      "connectionId": "host-uuid",
      "name": "Postgres",
      "type": "local",
      "localPort": 5432,
      "remoteHost": "127.0.0.1",
      "remotePort": 5432,
      "bindAddress": "127.0.0.1",
      "bindToAny": false,
      "autoStart": true,
      "group": "Databases",
      "originalPort": null
    }
  ]
}
```

`bindToAny` is legacy/display; **`bindAddress`** is the source of truth when using `tunnel:start`.

---

## 12. File map

| Area | Path |
|------|------|
| Tunnel module | `src-tauri/src/tunnels/` |
| Runtime engine | `src-tauri/src/tunnels/manager.rs` |
| Tunnel IPC | `src-tauri/src/tunnels/commands.rs` |
| Types | `src-tauri/src/types.rs` (`SavedTunnel`) |
| Sync domain | `src-tauri/src/sync/domain_tunnels.rs` |
| Zustand slice | `src/store/tunnelSlice.ts` |
| Auto-start | `src/features/connections/application/tunnelAutoStartService.ts` |
| Reconnect restore | `src/features/tunnels/application/tunnelReconnectService.ts` |
| Tunnel types (shared) | `src/features/tunnels/domain/tunnelTypes.ts` |
| SOCKS5 protocol | `src-tauri/src/tunnels/socks5.rs` |
| Dynamic handler | `src-tauri/src/tunnels/dynamic.rs` |
| Shared actions | `src/features/tunnels/application/tunnelActions.ts` |
| Port conflict UX | `src/features/tunnels/application/tunnelPortConflict.ts` |
| Per-connection UI | `src/components/tunnel/TunnelManager.tsx` |
| Global UI | `src/components/tunnel/GlobalTunnelList.tsx` |
| Card | `src/components/tunnel/TunnelCard.tsx` |
| Modals | `src/components/modals/AddTunnelModal.tsx`, `ImportSSHCommandModal.tsx` |
| Presets | `src/lib/tunnelPresets.ts` |
| Tests | `tests/tunnelAutoStartService.test.mjs`, `tests/tunnelReconnectService.test.mjs` |

---

## 13. Testing

### Automated (run before manual QA)

```bash
cd zync

# Rust — runtime IDs + sync domain
cd src-tauri && cargo test tunnel

# TypeScript — reconnect + auto-start services
npm run test:tunnel-autostart-service
npm run test:tunnel-reconnect-service

# Full frontend compile
npm run build
```

### Run the app locally

```bash
cd zync
npm run tauri dev
```

Use a real SSH host you can connect to, disconnect, and reconnect. Two hosts are helpful for the collision test (T7).

### Quick regression matrix (post-Phase 1)

| # | Area | One-line check |
|---|------|----------------|
| 1 | Local forward | Client reaches remote service via `localhost:localPort` |
| 2 | Remote forward | Remote peer reaches local target per `sshd` config |
| 3 | Bind address | Non-`127.0.0.1` bind actually listens on that address |
| 4 | Reconnect restore | Active tunnels come back after disconnect → reconnect |
| 5 | Auto-start | `autoStart` tunnel starts on connect without manual click |
| 6 | Disconnect hygiene | All tunnel cards show **stopped** after SSH disconnect |
| 7 | Global list parity | Start/stop from sidebar matches per-connection tab |
| 8 | Port conflict | Suggested alternate port; stop reverts `originalPort` |
| 9 | Cross-connection ports | Same remote port on two connections does not collide |
| 10 | Sync restore | Restored host bundle brings tunnels back (T8) |

Detailed steps and pass criteria: [§14](#14-phase-1-manual-qa-playbook).

---

## 14. Phase 1 manual QA playbook

**Status:** Phase 1 is **implemented in the working tree** (not yet released). Use this section to validate behavior before we cut a release or touch the landing page.

### What changed (summary for testers)

| Area | Before | After (test this) |
|------|--------|-------------------|
| Start path | Some UI called `tunnel:start_local` / `remote` (hardcoded bind) | All UI uses `tunnel:start` via `tunnelSlice` |
| Reconnect | Only `autoStart` tunnels restarted | **Active** tunnels before disconnect **plus** `autoStart` restart |
| Disconnect | Tunnels could leak / stay “active” in UI | `ssh_disconnect` stops runtime forwards; status events fire |
| Runtime IDs | `local:{port}:{port}` — cross-connection collision risk | IDs include `connectionId` + endpoints |
| UI refresh | 30s polling in places | Event-driven via `tunnel:status-change` |
| Failures | Silent auto-start failures | Toast when a tunnel fails to restart on reconnect |
| Modal copy | Ambiguous auto-start label | “Auto-start tunnel when connection opens” |

**Files touched (for dev reference):** `src-tauri/src/tunnels/`, `commands.rs`, `ssh.rs`; `src/features/tunnels/application/*`; `src/store/connectionSlice.ts`, `tunnelSlice.ts`; `TunnelManager.tsx`, `GlobalTunnelList.tsx`.

---

### T1 — Unified start path / bind address

**Goal:** Saved `bindAddress` is honored from every UI entry point.

**Setup:** Create a **local** tunnel. In Add/Edit modal, set bind address to `127.0.0.1` (default). Save.

**Steps:**

1. Connect the host.
2. Start the tunnel from the **Port Forwarding** tab → confirm card shows **active** within ~1s (no 30s wait).
3. Stop the tunnel.
4. Open **global tunnel list** (sidebar) → start the same tunnel → **active**.
5. Stop again.
6. Edit tunnel: set bind address to `0.0.0.0` (or another valid local bind). Save.
7. Start from either UI.

**Pass:**

- Tunnel reaches **active** from both surfaces.
- With `0.0.0.0`, the port is reachable from LAN (or `netstat` / `ss` shows `0.0.0.0:localPort`).

**Fail signs:** Tunnel active but only listens on `127.0.0.1` when `0.0.0.0` was saved; status stuck until manual refresh.

---

### T2 — Reconnect restores previously active tunnels

**Goal:** Tunnels you had running before disconnect restart automatically on reconnect (even without `autoStart`).

**Setup:** One local tunnel, **`autoStart` unchecked**.

**Steps:**

1. Connect host → manually **start** the tunnel → confirm **active**.
2. Disconnect the host (context menu, disconnect button, or close last tab per your workflow).
3. Confirm tunnel card shows **stopped** (T3).
4. Reconnect the same host (same session flow you normally use).

**Pass:**

- Tunnel returns to **active** without clicking Start.
- No duplicate listeners / “port already in use” unless something else bound the port.

**Fail signs:** Tunnel stays **stopped** after reconnect; only `autoStart` tunnels come back.

---

### T2b — Auto-start on connect

**Goal:** `autoStart` tunnels start on first connect.

**Setup:** New or existing tunnel with **“Auto-start tunnel when connection opens”** enabled.

**Steps:**

1. Ensure tunnel is **stopped**.
2. Connect host.

**Pass:** Tunnel becomes **active** shortly after connect.

---

### T3 — Disconnect hygiene

**Goal:** SSH disconnect tears down runtime forwards immediately.

**Steps:**

1. Connect → start one or more tunnels → **active**.
2. Disconnect host.

**Pass:**

- All affected tunnel cards flip to **stopped** quickly (event-driven, not after a long poll).
- Starting again after reconnect works without “already listening” errors from Zync itself.

**Fail signs:** Cards still show **active** while SSH session is gone.

---

### T5 — Event-driven UI (no polling)

**Goal:** Status updates arrive via `tunnel:status-change`, not a 30s timer.

**Steps:**

1. With devtools console open (optional), start then stop a tunnel from **Port Forwarding** tab.
2. Repeat from **global list**.

**Pass:** Status flips within ~1s each time.

**Fail signs:** Status unchanged for ~30s then jumps.

---

### T6 — Reconnect failure feedback

**Goal:** Failed tunnel restart on reconnect surfaces a toast (not silent).

**Setup (if you can simulate failure):** Point a tunnel at an invalid remote target or use a port guaranteed to conflict locally, then reconnect with that tunnel previously active.

**Pass:** Error **toast** names the tunnel; card shows **error** or **stopped** with message.

*Skip if you cannot easily force a failure — optional.*

---

### T7 — Cross-connection runtime ID scoping

**Goal:** Two connections can each run a forward involving the same port numbers without cross-wiring.

**Setup:** Two SSH hosts (A and B). On each, create a local forward using the **same `localPort`** (e.g. `15432`) to different remote services.

**Steps:**

1. Connect host A → start tunnel A → **active**.
2. Connect host B → start tunnel B → **active**.
3. Verify each forward reaches the **correct** remote service (not swapped).
4. Stop A only → B stays **active**.

**Pass:** Both can be active simultaneously; stopping one does not stop the other.

---

### T8 — Port conflict + revert

**Goal:** Local bind conflict UX still works after refactor.

**Steps:**

1. Start tunnel on local port P.
2. Create/start second tunnel also trying port P.
3. Accept suggested alternate port when prompted.
4. Stop the second tunnel.

**Pass:** Port reverts to original; toast mentions revert (global list) or success message (per-connection tab).

---

### T9 — Global list ↔ per-connection parity

**Goal:** Both surfaces share `tunnelSlice` state.

**Steps:**

1. Start tunnel from global list → open Port Forwarding tab on that host.
2. Stop from tab → check global list.

**Pass:** Status matches on both surfaces without reload.

---

### T11 — Dynamic / SOCKS forward (`-D`)

**Goal:** Local SOCKS5 proxy routes arbitrary TCP destinations through the SSH session.

**Setup:** Create a **dynamic** tunnel (preset “SOCKS Proxy” or Add Tunnel → SOCKS Proxy). Default port `1080`, bind `127.0.0.1`. Connect to host, start tunnel.

**Pass checks:**

1. Tunnel card shows **SOCKS** badge and `1080 → SOCKS → any host` flow.
2. Copy action produces `socks5://127.0.0.1:1080`.
3. With tunnel active:
   ```bash
   curl --proxy socks5://127.0.0.1:1080 https://example.com -I
   ```
   Returns HTTP headers (proves CONNECT + relay).
4. Stop tunnel — port no longer accepts connections; status → stopped.
5. Reconnect host with tunnel active before disconnect — SOCKS restarts (T2 behavior).

**Security note:** Binding to `0.0.0.0` exposes SOCKS on all interfaces — verify only when intentional.

---

### T10 — Sync restore (T8 exit criteria)

**Goal:** Bundled host restore still brings tunnels.

**Steps:**

1. On machine/profile A: host + tunnels configured and synced/backed up.
2. On B (or after wipe): restore connections bundle including that host.

**Pass:** Tunnels appear under restored host; start/stop works.

*Optional for first pass — can follow core reconnect tests.*

---

### Sign-off checklist

Before we call Phase 1 done and update the landing page / CHANGELOG:

- [ ] T1 bind address
- [ ] T2 reconnect restore (non-autoStart)
- [ ] T2b auto-start
- [ ] T3 disconnect hygiene
- [ ] T5 event-driven status
- [ ] T7 cross-connection ports (if you have two hosts)
- [ ] T8 port conflict revert
- [ ] T9 UI parity
- [ ] T11 SOCKS / dynamic forward
- [ ] Automated tests green (`cargo test tunnel`, reconnect/autostart npm tests, `npm run build`)

Note failures with: host OS, tunnel type (local/remote), which UI surface, and whether reconnect was manual or auto-reconnect.

---

## 15. Known limits & bugs

| Issue | Severity | Detail |
|-------|----------|--------|
| **Remote port uniqueness** | P1 | One remote forward per `remote_port` per SSH session (by design) |
| **Marketing doc drift** | P1 | Landing page `/docs/port-forwarding` still stale (auto-start, ssh_config import claims) |

**Fixed in Phase 1 (v2.21+):** unified `tunnel:start` path, reconnect restore for active + auto-start tunnels, disconnect stops runtime tunnels, stable runtime IDs scoped by `connectionId`, event-driven UI (no 30s poll), auto-start/reconnect failure toasts.

---

## 16. Improvement plan

Active work track after v2.21.0. Implement in order where possible.

### Phase 1 — Trust (P0) — **implemented (next tunnel release)**

| ID | Task | Status |
|----|------|--------|
| T1 | Unify start paths | Implemented — all UI via `tunnelSlice` → `tunnel:start` |
| T2 | Reconnect policy | Implemented — `tunnelReconnectService` restores active + `autoStart` |
| T3 | Disconnect hygiene | Implemented — `ssh_disconnect` stops tunnels; events emitted |
| T4 | Copy + docs | Modal done; this playbook added; landing page pending after QA |

### Phase 2 — Reliability (P1) — **implemented (next tunnel release)**

| ID | Task | Status |
|----|------|--------|
| T5 | Event-driven UI | Implemented — poll removed; both UIs use `tunnelSlice` + events |
| T6 | Auto-start feedback | Implemented — toast on reconnect restart failure |
| T7 | Stable internal IDs | Implemented — `tunnel_runtime_id` / `remote_forward_map_key` |
| T8 | Sync smoke | Pending — see [T10 in §14](#t10--sync-restore-t8-exit-criteria) |

### Phase 3 — Advanced (P2)

See §17.

---

## 17. Future features

### SOCKS enhancements (post-v1)

- SOCKS username/password auth (RFC 1929)
- UDP ASSOCIATE for DNS-over-SOCKS clients
- Per-connection connection limits / rate limiting

### SSH config forward import

- Parse `LocalForward` / `RemoteForward` from imported `~/.ssh/config` blocks (marketing site currently claims this — implement or remove claim).
- Map `Host` → Zync connection id when names match.

### Reconnect semantics (expanded)

| Mode | Behavior |
|------|----------|
| **Off** | Manual restart only (no `autoStart`, tunnel was stopped before disconnect) |
| **Auto-start only** | `autoStart` tunnels on connect |
| **Restore last session** | Shipped — remembers active tunnels across disconnect; restarts on reconnect |
| **Always-on profile** (proposed) | Per-connection “start these tunnels whenever connected” |

### Observability

- Bytes in/out per tunnel (optional)
- Last error + uptime on `TunnelCard`
- Health probe for HTTP forwards (optional HEAD request)

### UI

- Optional “group by connection” toggle on global list
- Jump-host hint when session uses `ProxyJump` (informational)

---

## 18. Backend modularization

**Tunnel module consolidation — done (next tunnel release):** `tunnels/commands.rs` (IPC) + `tunnels/manager.rs` (runtime). Broader `commands.rs` split (SSH, terminal, FS) remains deferred.

### Problem

`commands.rs` is still ~5,500 lines for SSH, terminal, FS, and settings. The **tunnel subsystem** is consolidated under `src-tauri/src/tunnels/` (`manager.rs` + `commands.rs`). Sync persistence remains in `sync/domain_tunnels.rs`.

### Completed layout

```text
src-tauri/src/tunnels/
  mod.rs
  manager.rs      # TunnelManager, runtime IDs, port conflict helpers
  commands.rs     # tunnel_* IPC + stop_tunnels_for_connections
```

**Still in `commands.rs`:** `AppState`, `get_data_dir()` (shared with ghost/vault today).

### Out of scope for tunnel-only extraction

Splitting SSH, terminal, connections, and filesystem commands out of `commands.rs` — same pattern, separate future phases.

---

## Change checklist

When modifying tunnel behavior, update in the same change:

- This document (if behavior or architecture changes)
- [CHANGELOG.md](../CHANGELOG.md)
- Landing page `/docs/port-forwarding` when user-visible behavior changes
- `tests/tunnelAutoStartService.test.mjs` or new Rust/TS tests as appropriate
- [VAULT.md](./VAULT.md) only if sync schema or restore rules change

---

## Related documents

- [VAULT.md](./VAULT.md) — sync domains including tunnels
- [VAULT_ROADMAP.md](./VAULT_ROADMAP.md) — bundle restore, tunnel UI cleanup notes
- [SESSION_PERSISTENCE.md](./SESSION_PERSISTENCE.md) — `port-forwarding` tab restore
- [SECURITY.md](./SECURITY.md) — restore preview warnings