# Zync Vault & Sync — Roadmap & Future Plans

**Last updated:** 2026-06-15  
**Current implementation reference:** [VAULT.md](./VAULT.md)

Plans, deferred work, and long-term direction. Not required for day-to-day implementation of shipped features.

## Table of Contents

1. [Phase 2 Follow-ups](#1-phase-2-follow-ups)
2. [Phase 3 Remaining & Exit Criteria](#2-phase-3-remaining--exit-criteria)
3. [Connection Bundle Restore (reference)](#3-connection-bundle-restore-reference)
4. [Phase 4 — Selective Provider Sync](#4-phase-4--selective-provider-sync)
5. [Architecture Phases 4–5](#5-architecture-phases-45)
6. [Credential Model Deferred Work](#6-credential-model-deferred-work)
7. [Provider Sync Deferred Work](#7-provider-sync-deferred-work)

---

## 1. Phase 2 Follow-ups

## Deferred / Phase 3 Candidates1. Add a second provider implementation (GitHub/S3/self-hosted) and run same provider contract suite.
2. Expand provider conformance suite to shared reusable macro/helper for all providers.
3. Add full end-to-end automated restore scenario test harness with mocked provider payload fixtures.
4. Rotation/revision history UX polish in Vault UI (already tracked in identity-model roadmap).

## Agent Handoff Notes
- When adding a new provider, keep `syncIpc` normalization centralized through `normalizeProviderStatus`.
- For restore paths, use sync-specific write methods that preserve remote metadata:
  - `item_create_from_sync`
  - `item_apply_sync_restore`
- Do not route provider restore writes through generic `item_update` / `item_create_with_logical_id`,
  or reconciliation can regress into repeated re-apply loops.
---

## 2. Phase 3 Remaining & Exit Criteria

Phase 3 is complete when:
- At least 4 non-vault domains sync reliably (hosts/tunnels/snippets/settings).
- Profile menu is primary sync/account entry point.
- Per-domain sync status + restore/conflict flows are production-stable.
- Automated tests cover core convergence/conflict scenarios.

Current closure status:
- Implemented: hosts/tunnels/snippets/settings upload + restore, profile dropdown entry point, per-domain controls/status, credential restore preview/conflict selection, Google host inventory/listing without restore.
- Remaining before declaring fully shippable: final end-to-end manual matrix across a clean profile and a populated Google sync collection, host restore verification from a true empty-local state, selected host restore/use-on-device flow, plus any CodeRabbit/CI follow-up.

---

### Phase 3.5 status

Connection bundle restore + grouped Sync UI are **implemented** in v2.16.0. See [VAULT.md §7](./VAULT.md#7-implemented-sync-features-phase-3).

### Deferred (Phase 4+)

- Second provider implementation.
- Team/shared vault + org policy controls.
- Full bi-directional live sync scheduling across providers.
---

## 3. Connection Bundle Restore (reference)

> **Status:** Implemented. This section preserves the original orchestration plan for maintainers.

## Status

- **Owner:** Core app team
- **Document type:** Implementation plan (pre-code)
- **Last updated:** 2026-06-14
- **Scope:** Grouped Sync & Backup UX (item #8), connection-scoped restore orchestration, risk mitigations
- **Depends on:** Phase 3 per-domain sync (implemented), Phase 4 selective-sync direction (draft)

This document records the validated product/technical plan from design review **before**
implementation. It complements — does not replace — per-domain backend storage.

---

## Related documents

- [VAULT.md §7](./VAULT.md#7-implemented-sync-features-phase-3) — shipped per-domain sync scaffolding
- [§4 Phase 4](#4-phase-4--selective-provider-sync) — long-term selective materialization model
- [VAULT.md §4](./VAULT.md#4-provider-sync-key-model) — credential restore, `logicalId`, skip/conflict rules
- [VAULT.md §2](./VAULT.md#2-credential-identity-model) — host `authRef` → `credentialId`

---

## Problem

Today the Sync & Backup workspace exposes **five peer domains** (vault, hosts, tunnels,
snippets, settings) in a flat table (`VaultSyncCard`). That is accurate at the storage layer
but misleading at the product layer:

- **Tunnels** and **host-scoped snippets** depend on a host (`connection_id` / `connectionId`).
- **Vault credentials** are shared secrets referenced by hosts, not embedded in host records.
- **Global snippets** and **settings** are app-scoped and do not depend on a host.

Restore behavior is only partially aligned:

- Host restore already pulls **referenced vault credentials** first (subset, deduped by `logicalId`).
- Host restore does **not** yet restore tunnels or host-scoped snippets for those hosts.
- Users can restore hosts and still miss port forwards / per-host snippets — setup feels broken.

---

## Goals

1. **Grouped UX** that matches how users think: Connections vs App-wide vs Vault.
2. **Restore orchestration** for connection-scoped data without merging sync domains in the backend.
3. **Idempotent restore** — skip creds/records already local and up to date.
4. **Per-host scope** — restoring 2 of 10 hosts restores only related tunnels/snippets for those 2.
5. **Sync safety** — disabling a domain still means that domain is not uploaded.

## Non-goals (this plan)

- Merging domains into one remote blob or one sync cursor.
- Auto-sync on domain toggle (manual sync remains unless a separate auto-sync engine is added).
- Full Phase 4 entity graph (`HostEntity` with multiple providers) — orchestration uses today's domain commands.
- Replacing credential preview/conflict modals for full vault restore.

---

## Mental model: three scopes

| Scope | Domains / data | Depends on host? |
|-------|----------------|------------------|
| **Connection-scoped** | Hosts, tunnels, host-scoped snippets | Tunnels/snippets yes; hosts are the anchor |
| **App-scoped** | Global snippets (`connectionId` empty), settings allowlist | No |
| **Credential-scoped** | Vault credentials (`logicalId`) | Referenced by hosts; shared across many hosts |

**Rule:** A host **references** a credential via `authRef.credentialId`. It does not own the credential.

---

## Sync vs restore (keep separate)

| Concern | Behavior |
|---------|----------|
| **Sync (upload)** | Per-domain commands only (`sync_hosts_upload`, `sync_tunnels_upload`, …). Grouped UI is visual; optional “Sync connections” macro runs uploads **only for enabled** domains. |
| **Restore (download)** | May orchestrate multiple domains in dependency order for connection-scoped restore. |

Enabling host sync must **not** implicitly upload tunnels if the tunnels domain is disabled.

---

## UX plan: item #8 split

Item #8 (“`VaultSyncCard` progressive setup”) splits into two deliverables:

### 8a — Progressive provider setup (independent)

Wizard-style flow before the domain table:

1. Connect Google Drive
2. Set up / unlock Google sync encryption
3. Then reveal domain controls

**Does not** require the restore orchestrator. Can ship earlier if first-time setup confusion is the main pain.

### 8b — Grouped domains + Restore connections (depends on orchestrator)

Replace the flat five-row table with:

```text
▼ Connections
  Hosts                    [Sync] [Restore connections]
  └─ ☑ Host definitions
     ☑ Tunnels (for restored/selected hosts)
     ☑ Host-scoped snippets
     ☑ Referenced vault credentials (if vault domain enabled)

▼ App-wide
  Global snippets          [Sync] [Restore]
  Settings                 [Sync] [Restore]

▼ Vault
  All credentials          [Sync] [Restore]  (preview modal; skips existing logicalIds)
```

**Advanced:** Per-domain sync/restore remains available (today's behavior) for power users.

Copy for creds on connection restore: *“Referenced credentials are restored once and shared by all hosts that use them.”*

---

## Backend plan: `sync_connections_restore`

New orchestrator command (name tentative). **Does not** add a sixth sync domain.

### Inputs

```ts
interface SyncConnectionsRestoreArgs {
  provider: 'google';
  hostLogicalIds?: string[];  // omit = all eligible remote hosts in filter
  includeTunnels?: boolean;   // default true
  includeHostSnippets?: boolean; // default true
  includeReferencedCredentials?: boolean; // default true
}
```

### Ordered steps

1. **Resolve host set** — all remote hosts or `hostLogicalIds` subset.
2. **Restore referenced vault credentials** (if enabled) — union of `authRef.credentialId` across host set; each `logicalId` once. Reuse `restore_credentials_from_provider_records` + `decide_restore_action` (skip stale/unchanged).
3. **Restore hosts** — reuse `apply_hosts_restore_records`.
4. **Restore tunnels** (if enabled) — only records where `connection_id` ∈ successfully restored host logical ids.
5. **Restore host-scoped snippets** (if enabled) — only records where `connectionId` matches restored host ids (non-empty).
6. **Relink vault refs** — reuse existing repair/relink after credential restore.

### Orphan policy

If a tunnel or host-scoped snippet references a `connection_id` **not** in the restored host set:

- **Skip** the record (do not create dangling local data).
- Count as `skippedOrphaned` in the result payload.

### Result shape (illustrative)

Per-step counts: scanned, restored, updated, skipped, skippedOrphaned, failed, conflicts (credentials).

---

## Risk mitigations

| Risk | Mitigation |
|------|------------|
| **Over-bundling sync** | No implicit cross-domain upload. Group checkboxes map 1:1 to existing domain enable flags. “Sync connections” is a macro over **enabled** domains only. |
| **Under-bundling restore** | `sync_connections_restore` chains creds → hosts → tunnels → host-snippets. Primary CTA: **Restore connections**. |
| **Duplicate credentials** | Restore cred set = union of referenced ids; vault keyed by `logicalId`; `decide_restore_action` skips unchanged/stale. |
| **Tunnels/snippets on wrong host** | Gate on `eligible_connection_ids` from successfully restored hosts; skip orphans; partial restore uses selected `hostLogicalIds` only. |

---

## Implemented today (baseline)

| Behavior | Status |
|----------|--------|
| Per-domain sync upload/restore | ✅ |
| Host restore → referenced creds first | ✅ (`sync_hosts_restore`) |
| Credential skip/conflict on restore | ✅ (`decide_restore_action`, preview modal for full vault restore) |
| Vault ref relink after host restore | ✅ |
| Tunnels/snippets with host restore | ❌ |
| Grouped Sync UI / progressive setup | ❌ |
| `sync_connections_restore` orchestrator | ❌ |
| Orphan tunnel/snippet filter | ❌ |

---

## Phase A — Scenario validation (no code)

Agree expected behavior before implementation:

| # | Scenario | Expected |
|---|----------|----------|
| 1 | **New device** — empty local, restore connections | Creds (referenced) → hosts → tunnels → host-snippets; globals unchanged until App-wide restore |
| 2 | **Partial** — restore 2 of 10 hosts | Only those 2 hosts + their tunnels/snippets + their cred refs |
| 3 | **Shared cred** — 3 hosts, same `credentialId` | Cred restored **once**; all 3 hosts relink |
| 4 | **Cred already local** — same `logicalId`, same revision | Skipped; host still restores |
| 5 | **Tunnels domain sync off** — user runs Sync connections | Host upload runs; tunnel upload skipped (domain disabled) |
| 6 | **Orphan tunnel** — tunnel refs host not in restore set | Tunnel skipped, `skippedOrphaned` reported |

---

## Implementation order

```text
Phase A  Scenario sign-off (this doc + table above)
   ↓
Phase B  Backend: sync_connections_restore + orphan filter + structured result
   ↓
Phase C  UI 8b: grouped VaultSyncCard + Restore connections wired to orchestrator
   ↓
Phase D  UI 8a: progressive connect/encryption setup (can parallelize after B if needed)
   ↓
Phase E  Restore preview modal (counts, orphans, credential conflicts summary)
```

**Default sequence:** A → B → C, with 8a (D) anytime after or in parallel with B.

**Do not** ship 8b “Restore connections” before Phase B — the button would not match behavior.

---

## Testing matrix (add to Phase 3 closure)

1. Orchestrator happy path (new device).
2. Partial host selection scope.
3. Shared credential dedup across multiple hosts.
4. Skip unchanged credential on second restore.
5. Orphan tunnel/snippet skipped with correct counts.
6. Domain disabled — sync macro does not upload disabled domain.
7. UI grouping — toggles persist to existing `domainPolicies` / `hostsSyncEnabled`.
8. Regression — per-domain restore still works under Advanced.

---

## Exit criteria

- [ ] Phase A scenarios reviewed and signed off.
- [ ] `sync_connections_restore` implemented with per-step stats and orphan skips.
- [ ] Sync & Backup UI shows Connections / App-wide / Vault groups.
- [ ] Restore connections uses orchestrator; Advanced retains per-domain actions.
- [ ] 8a progressive setup shipped or explicitly deferred with reason.
- [ ] Manual smoke on empty-local profile documented in Phase 3 closure notes.

---

## Design rules to preserve

```text
Provider domains stay separate in storage and cursors.
UI grouping is not backend merging.
Restore order follows dependencies; sync order follows user-enabled domains.
logicalId / credentialId is the identity anchor for skip and dedup.
Connection-scoped restore is per selected host set, not “everything on Drive.”
```
---

## 4. Phase 4 — Selective Provider Sync

## Purpose

This document captures the validated direction for Zync sync after the Phase 3 Google-first work. It records what exists today, what is intentionally *not* automatic yet, and the next UX/data-model direction for provider-backed hosts, credentials, app data, plugins, and future providers.

The core rule is:

> One logical entity. Many provider locations. Optional local materialization.

This is the model we should preserve as Zync evolves from manual Google sync into a multi-provider, selective-sync product.

---

## Current State

### Implemented now

Zync currently has:

- Google Drive connection from the profile/top-bar flow.
- Google sync collection setup with provider-side encryption key.
- Local vault remains separate from provider sync setup.
- App-data domains can be synced manually:
  - hosts
  - tunnels
  - snippets
  - settings allowlist
- Vault credentials can be backed up/restored manually when the local vault exists.
- Credential restore has preview/conflict selection.
- Hosts can be listed from Google Drive as a read-only remote inventory before restore.
- Provider status exposes per-domain status:
  - enabled/disabled
  - last sync
  - last error
- Domain metadata is centralized in frontend code instead of being duplicated across UI rows.

### Not implemented yet

Current Google sync is **manual**, not automatic:

- Connecting Google does not upload or restore data automatically.
- Setting up the sync key does not sync data automatically.
- Turning a domain on/off only changes policy; it does not sync by itself.
- Hosts/tunnels/snippets/settings restore currently uses deterministic keyed upsert, not a full conflict-resolution UI.
- There is no selected host import/use-on-device flow yet for remote-only hosts.
- There is no remote credential catalog browser yet for provider-only credentials.
- There is no bulk “sync all enabled domains” flow yet.

### Current host behavior

For hosts, the current behavior is intentionally split:

- `Google Drive Hosts` can be listed without restoring them locally.
- `Restore hosts` is still the explicit materialization path into local `connections.json`.
- Host restore is expected to restore/relink referenced vault credentials first when those refs exist.
- The current inventory view is read-only; it does not yet support `Use on this device` or `Restore selected`.

---

## Product Direction

### Top-bar sync entry point

Primary discovery should start from the top bar/profile icon:

```text
Top bar profile/sync icon
  -> Sync
    -> Choose provider
      -> Google Drive
      -> Git
      -> Custom/self-hosted later
    -> Choose what to sync/use
```

This keeps provider setup discoverable and avoids hiding sync inside the Vault screen.

### Separate product areas

Sync should be split into four conceptual areas:

```text
Sync & Backup
  App Profile
  Hosts
  Vault Credentials
  Backups
```

#### App Profile

Low-risk app data can be automatic after user opts in:

- settings
- themes
- plugin list/config
- layout/preferences

Recommended UX:

```text
App Profile Sync
  Sync automatically across devices
```

#### Hosts

Hosts are app data, not vault data.

A host may reference a vault credential, but it should not live inside the vault.

```text
Host -> authRef -> Vault Credential
```

Hosts should support selective provider materialization:

```text
Hosts on this device
Available from Google Drive
Available from Git
```

Remote provider hosts can be browsed without immediately importing every host into local storage.

Current implementation note:
- A read-only Google host inventory now exists in the Sync & Backup workspace.
- Selected import/use-on-device remains the next implementation step.

#### Vault Credentials

Credentials are sensitive and should stay stricter than normal app data.

Recommended default:

- manual/preview-first restore
- optional backup
- optional keep-synced later
- no silent secret restore by default

Remote credentials should be browsable as encrypted provider records and imported/cached selectively.

Long-term, this area should be modeled as **typed vault credentials**, not only
SSH keys. SSH private keys are one credential kind alongside future
username/password credentials, certificates, Jenkins credentials, keychain
references, and plugin-defined credential schemas. See
[VAULT.md §3](./VAULT.md#3-credential-types-model).

#### Backups

Backups are disaster recovery snapshots, not the normal sync graph.

They should remain conceptually separate from per-item provider records.

---

## Related Documents

- [VAULT.md §3](./VAULT.md#3-credential-types-model) — long-term model for vault credentials beyond SSH keys/passwords.
- [VAULT.md §2](./VAULT.md#2-credential-identity-model) — stable credential identity and host reference rules.
- [§3 Connection Bundle Restore](#3-connection-bundle-restore-reference) — grouped Sync UI + connection restore orchestrator (shipped).

---

## Data Model Direction

### Host entity

Do not create unrelated duplicate records for the same host across providers.

Use one logical host entity with many locations:

```ts
interface HostEntity {
  logicalId: string;
  local?: LocalHostRecord;
  providers: ProviderLocation[];
  syncState: 'local_only' | 'remote_only' | 'synced' | 'conflict' | 'stale';
}

interface ProviderLocation {
  provider: 'google' | 'git' | 'custom';
  remoteId: string;
  revision: number;
  lastSync?: number;
  state: 'remote_only' | 'synced' | 'dirty' | 'conflict';
}
```

Examples:

#### Local only

```ts
{
  logicalId: 'host_prod_api',
  local: { name: 'prod-api', host: '10.0.0.5' },
  providers: [],
  syncState: 'local_only'
}
```

#### Remote only

```ts
{
  logicalId: 'host_prod_api',
  local: undefined,
  providers: [
    { provider: 'google', remoteId: '...', revision: 12, state: 'remote_only' }
  ],
  syncState: 'remote_only'
}
```

#### Local + Google

```ts
{
  logicalId: 'host_prod_api',
  local: { name: 'prod-api', host: '10.0.0.5' },
  providers: [
    { provider: 'google', remoteId: '...', revision: 12, state: 'synced' }
  ],
  syncState: 'synced'
}
```

The same entity can appear under both UI sections:

```text
Hosts on this device
  prod-api    Synced with Google

Available from Google Drive
  prod-api    Already on this device
```

But internally it remains one logical entity.

### Credential entity

Credentials follow the same identity rule, but with stricter restore/import UX:

```ts
interface CredentialEntity {
  credentialId: string;
  localVaultItem?: VaultItem;
  providers: ProviderLocation[];
  syncState: 'local_only' | 'remote_only' | 'synced' | 'conflict' | 'stale';
}
```

Provider-only credentials should show as:

```text
Available from Google Drive
  prod-key    [Import to local vault]
```

A host can use a credential only when the credential is available locally or intentionally cached for the session.

---

## UX Direction

### Preferred wording

Use user-facing language that separates local materialization from provider availability:

- “On this device”
- “Available from Google Drive”
- “Synced with Google”
- “Use on this device”
- “Keep synced”
- “Back up to provider”
- “Import to local vault”

Avoid making provider records sound like unrelated systems:

- Avoid: “Google Hosts” as a separate host product.
- Prefer: “Available from Google Drive” as a provider view of the same host domain.

### Suggested Sync & Backup page

```text
Sync & Backup

Google Drive connected
Sync key ready
Last sync: 2 minutes ago

[Sync now] [Manage providers]

App Profile
  Settings, plugins, layout
  Automatic sync: On

Hosts
  On this device: 12
  Available from Google Drive: 34
  [Browse]

Vault Credentials
  Local vault: 8
  Available from Google Drive: 10
  [Review / Import]

Backups
  Full encrypted vault backup
  [Back up now] [Restore backup]
```

---

## Sync Semantics

### App profile

Can support automatic sync after setup:

- startup pull/merge
- debounced upload after local changes
- no secrets or machine-local paths

### Hosts and non-secret domains

Should support selective sync:

- publish local item to provider
- browse provider catalog
- import/use selected item locally
- keep selected item synced
- later: conflict UI for changed local + changed remote

### Vault credentials

Should default to manual/preview-first:

- publish selected credential to provider
- browse provider catalog
- import selected credential into local vault
- preview conflicts before applying remote secrets
- optional auto-backup/keep-synced only after explicit opt-in

### Backups

Backups should remain snapshot-based and clearly labeled as disaster recovery.

They should not be confused with item-level sync.

---

## Why this is not an anti-pattern

This model aligns with big-player patterns:

- Profile/settings sync behaves like VS Code/Chrome-style account sync.
- Remote provider catalogs behave like Drive/Dropbox selective local availability.
- Credential handling behaves more like password managers: encrypted, preview-first, and not silently restored by default.
- Hosts and credentials remain linked by stable identity instead of duplicated across providers.

The anti-pattern to avoid is treating each provider as a separate unrelated database:

```text
Local host A
Google host A
Git host A
```

That creates duplicates, confusing conflict handling, and broken search.

The robust model is:

```text
Host A
  local: yes/no
  providers: google/git/custom
```

---

## Next Implementation Improvements

Recommended sequence:

1. Create a dedicated **Sync & Backup** page reachable from the top bar profile/sync menu.
2. Move provider setup/status out of the Vault-only mental model.
3. Add a provider catalog/index API for hosts and credentials.
   Status: host inventory API and Google host listing are now implemented.
4. Add “Available from provider” sections without importing all remote records.
   Status: read-only Google host listing is implemented; selected host actions remain next.
5. Introduce typed credential envelopes before adding non-SSH credential UI.
6. Add item-level actions:
   - Use on this device
   - Import to local
   - Back up to provider
   - Keep synced
7. Add “Sync now” for enabled app-profile domains.
8. Add auto-sync engine for low-risk app profile data.
9. Keep vault credential restore manual/preview-first until explicit opt-in exists.

### Deferred provider-performance follow-up

Google provider upload lookup still has a deferred optimization:

- current behavior is correct and has a safe per-file fallback
- current implementation does not yet batch existing-file lookups across multiple collection prefixes
- if provider sync starts spending noticeable time on repeated object-existence checks, update the Google provider upload path to group records by collection prefix and batch-list each prefix before falling back to per-file lookup

This is intentionally deferred because restore correctness, host/credential relink stability,
and selective provider materialization are higher-value priorities than this API-call reduction.

### Deferred Code Review Follow-up

The following review items are intentionally left as tracked follow-up work after the current
vault/sync milestone and hardening commits:

- typed credential zeroization hardening:
  remove `#[zeroize(skip)]` from `PlaintextRecord.credential` only after `CredentialEnvelope`
  and nested typed credential structs derive/implement `Zeroize` safely
- tunnel UI refresh cleanup:
  remove remaining fire-and-forget / delayed `loadTunnels()` refresh paths in `TunnelManager`
  once the event-driven refresh path is unified across tunnel surfaces
- vault credential module cleanup:
  replace broad module-level `#![allow(dead_code)]` in `src-tauri/src/vault/credential.rs`
  with item-level allowances only where still justified
- optional Google provider performance polish:
  batch existing-file lookup across multiple collection prefixes when provider upload lookup
  becomes a measurable bottleneck

These are not blocked by current restore correctness or provider inventory behavior, so they
should not be mixed back into the main selective-sync/product flow unless that work is being
re-opened intentionally.

---

## Design Rule to Preserve

When adding Google, Git, custom plugins, or a future backend, preserve this invariant:

```text
Provider is a location, not the identity.
Local is a materialized copy, not the source of truth for every record.
Logical ID / credential ID is the identity anchor.
```
---

## 5. Architecture Phases 4–5

### Phase 4 — Multi-provider& future domains
- Add second provider (e.g., GitHub blob store) to validate abstraction.
- Add domain-scoped sync (start with `secrets`; expand later).

### Phase 5 — Team vault and advanced policy
- Remote/team vault model and org policies.
- Audit chain hardening and policy controls.
---

## 6. Credential Model Deferred Work

### Not yet fully implemented

- standalone ``Credential`` records (beyond current vault item + authRef model)

### Historical note: rotation history UI

Rotation history UI **shipped** in v2.16.0 (``CredentialHistoryModal``, ``itemRestoreRevision``). Older docs may still list this as deferred; treat [VAULT.md](./VAULT.md) as canonical.

### Original rotation-history design notes (archived)
#### Design notes

Rotation currently updates the active vault item in place and increments its revision.
That is enough for stable host references, but it is not yet enough for operator-facing
history, audit, or rollback UX.

### What is still missing

- revision timeline in Vault UI
- per-credential change history view
- optional restore/revert to an older revision
- explicit audit metadata for future team/shared vaults

### Recommended implementation shape

The most maintainable next step is:

1. keep `credentialId` stable
2. treat each rotation as a **new immutable revision snapshot**
3. keep one `currentItemId` fast path for active use
4. expose a revision list in the UI

Recommended shape:

```text
Credential logical record
  -> currentItemId
  -> revisionCounter

Credential revision snapshots
  -> credentialId
  -> revision
  -> itemId
  -> createdAt
  -> rotatedAt
  -> metadata
```

### Why this is better than only mutating in place

- preserves operator-visible history
- supports future rollback
- supports future audit/event stream
- scales better for team vaults and synced environments

### Suggested rollout

1. backend revision snapshot storage
2. read API for revision list
3. Vault UI history drawer/modal
4. optional restore previous revision action

This is intentionally deferred because stable identity + relink + assignment safety are
more important than history UI for the first robust vault foundation.

---

## 1.2)
---

## 7. Provider Sync Deferred Work

## 9) Non-Goals / Deferred Work- Team vault authority model.
- Multi-user sharing policies.
- Hardware-backed FIDO2 credential sync.
- Cross-provider automatic merge without user-visible conflict state.
- Storing hosts, snippets, tunnels, settings, or known-hosts in the sync collection.
