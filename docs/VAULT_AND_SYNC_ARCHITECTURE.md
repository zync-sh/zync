# VAULT_AND_SYNC_ARCHITECTURE.md

## Status
- **Owner:** Core app team
- **Document type:** Architecture + implementation guide
- **Last updated:** 2026-05-08
- **Scope:** Vault UX, vault core, provider abstraction, sync engine, and future app-data sync

---

## 1) Problem Statement
Vault currently exists primarily as a settings tab workflow. This reduces discoverability, limits operational clarity for sync, and makes future provider expansion hard to manage.

We need a modular, robust, scalable, and maintainable architecture that:
1. Makes vault a first-class product feature.
2. Preserves local-first, secure secret management.
3. Supports multiple sync providers without coupling vault core to provider implementations.
4. Scales from secrets sync to broader app-data domain sync over time.

---

## 2) Goals / Non-Goals

### Goals
- First-class **Vaults** navigation in primary sidebar.
- Strong **local vault core** with clear security boundaries.
- Pluggable provider interface for cloud backends.
- Per-provider sync profiles (manual + optional autosync).
- Predictable conflict handling and operator-visible sync state.
- Forward-compatible design for syncing additional domains (hosts, snippets, tunnels, settings, etc.).

### Non-Goals (phase 1)
- Cross-provider automatic merge of the same logical item.
- Fully decentralized multi-writer conflict-free collaboration.
- Team vault server protocol implementation (deferred).

---

## 3) Guiding Principles
1. **Security-first core:** cryptography and key material remain in trusted backend modules.
2. **Local-first UX:** users can always work offline with local vault.
3. **Least coupling:** vault core must not call provider SDKs directly.
4. **Stable contracts:** provider interface versioning and capability negotiation.
5. **Small composable modules:** sync orchestration separate from crypto/store/UI.
6. **Observability by default:** status, timestamps, errors, and conflict states are surfaced.
7. **Incremental rollout:** no big-bang rewrite; preserve backward compatibility.

---

## 4) High-Level Architecture

```text
UI (Sidebar Vaults + Vault tabs + Sync status)
  -> Vault Application Service (commands / policy / orchestration)
      -> Vault Core (crypto + store + lock state)
      -> Sync Engine (state machine + conflict resolver + retries)
          -> Provider Registry (capability-aware adapters)
              -> Providers (Google Drive, GitHub, AWS, Custom Plugin)
```

### Mandatory Boundary
- Vault Core never imports provider-specific code.
- Provider adapters never access plaintext keys directly unless explicitly required by domain contract.

---

## 5) Product Information Architecture (IA)

### Sidebar
- Add top-level section: **Vaults**
  - Local Vault
  - Remote Profiles (Google, GitHub, AWS, Custom)
  - Team Vault (future)
  - `+ Add Provider`

### Tab Behavior
- Clicking a vault/profile opens a standard app tab.
- Each tab includes:
  - vault state (locked/unlocked)
  - item list/search
  - provider status
  - sync controls (upload, download, autosync toggle)
  - conflict badge if pending conflicts

### Discoverability rules
- If vault uninitialized, show global CTA: “Set up Vault”.
- In credential creation flows, default recommendation: “Store in Vault”.

---

## 6) Domain Model

For the detailed durable credential identity model that supports key-first vault UX,
host assignment, rotation, and stale-reference repair, see
[`VAULT_CREDENTIAL_IDENTITY_MODEL.md`](./VAULT_CREDENTIAL_IDENTITY_MODEL.md).

### Core entities
- `Vault`
  - id, type (`local`, `team`), state (`uninitialized|locked|unlocked`)
- `VaultItem`
  - id, kind, label, encrypted payload, metadata, revision, timestamps
- `SyncProfile`
  - id, vault_id, provider_kind, enabled, autosync_policy, last_sync, health
- `SyncCursor`
  - profile_id, domain, remote_version, remote_etag, sync_token, last_applied_clock
- `Conflict`
  - id, profile_id, domain, item_id, local_meta, remote_meta, status

### Future domain sync abstraction
- `SyncDomain` enum:
  - `secrets`
  - `hosts`
  - `snippets`
  - `tunnels`
  - `settings`
  - `known_hosts`

---

## 7) Provider Contract (Plugin-Compatible)

Define a versioned backend interface (Rust trait + IPC shape):

```rust
trait VaultProviderV1 {
    fn kind(&self) -> ProviderKind;
    fn capabilities(&self) -> ProviderCapabilities;

    // connection/auth
    async fn connect(&self, ctx: ProviderContext) -> Result<ProviderIdentity>;
    async fn disconnect(&self, ctx: ProviderContext) -> Result<()>;
    async fn health_check(&self, ctx: ProviderContext) -> Result<ProviderHealth>;

    // object ops
    async fn list(&self, req: ListRequest) -> Result<Vec<ObjectMeta>>;
    async fn read(&self, req: ReadRequest) -> Result<ObjectPayload>;
    async fn write(&self, req: WriteRequest) -> Result<WriteResult>;
    async fn delete(&self, req: DeleteRequest) -> Result<()>;

    // incremental sync support
    async fn get_cursor(&self, req: CursorRequest) -> Result<ProviderCursor>;
}
```

```rust
struct WriteRequest {
    path: String,
    payload: Vec<u8>,
    idempotency_key: Option<String>,
    if_match: Option<String>,
}

struct DeleteRequest {
    path: String,
    idempotency_key: Option<String>,
    expected_revision: Option<String>,
}
```

Provider contract notes:
- `list` and `read` must be safe to retry.
- `write` and `delete` may be retried; callers should provide `idempotency_key`.
- Providers must honor `if_match` / `expected_revision` preconditions when supplied.
- Providers must normalize failed preconditions to `conflict_precondition_failed` so conflict handling is provider-agnostic.

### Capability flags
- `supports_autosync`
- `supports_incremental`
- `supports_etag`
- `supports_domains`
- `max_object_size`
- `encryption_mode` (`provider_encrypted`, `app_encrypted_only`)

---

## 8) Sync Strategy

### 8.1 Local-first semantics
- Local store is immediately updated.
- Sync engine asynchronously reconciles with each enabled profile.

### 8.2 Per-profile state machine
- `idle -> syncing -> success|conflict|retrying|error`

### 8.3 Conflict policy (phase 1)
- No cross-provider merge.
- Conflict resolution is **local vs specific provider**.
- User choices:
  - Keep Local
  - Keep Remote
  - Duplicate as new item (optional safety path)

### 8.4 Retry policy
- Exponential backoff with jitter.
- Bounded retry budget per run.
- Persist retry reason and last failure code.

---

## 9) Security & Compliance Requirements
1. Vault encryption remains app-managed (Argon2id + AEAD suite currently used).
2. Provider tokens stored in vault-backed secure storage where possible.
3. Secrets never logged in plaintext.
4. Recovery key lifecycle must include rotate + revoke semantics.
5. Import/export guarded with validation and backup-before-replace.
6. Plugin providers run under explicit permission boundaries.

---

## 10) Observability Requirements
- For every sync profile, expose:
  - connected identity
  - last sync timestamp
  - last status
  - bytes uploaded/downloaded
  - conflict count
  - last error code/message (sanitized)
- Emit structured backend events for UI updates.

---

## 11) Implementation Plan (Incremental)

### Phase 1 — UX promotion + no-risk refactor
- Add sidebar `Vaults` section and tabs.
- Keep existing vault core and google sync logic functional.
- Add global status badges.

### Phase 2 — Provider abstraction
- Introduce `VaultProviderV1` interface.
- Wrap existing Google Drive implementation as first provider adapter.
- Introduce `SyncProfile` persistence.

### Phase 3 — Robust sync behavior
- Add state machine, retries, conflict objects, conflict badge center.
- Add autosync policies (manual, periodic, on-change, on-exit).

### Phase 4 — Multi-provider & future domains
- Add second provider (e.g., GitHub blob store) to validate abstraction.
- Add domain-scoped sync (start with `secrets`; expand later).

### Phase 5 — Team vault and advanced policy
- Remote/team vault model and org policies.
- Audit chain hardening and policy controls.

---

## 12) Data Migration / Backward Compatibility
- Existing local vault (`vault.redb`) remains canonical.
- Existing Google token data migrates into `SyncProfile` + provider credentials store.
- Old APIs remain available behind compatibility adapter during transition.
- Feature flags gate new sidebar and provider engine rollout.

---

## 13) Testing Strategy

### Unit
- provider contract conformance tests
- sync state transitions
- conflict resolver behavior
- retry/backoff timing policy

### Integration
- local vault <-> provider round trip
- upload/download/restore with fault injection
- migration compatibility tests

### E2E
- first-time setup
- connect provider
- autosync on/off
- conflict detection + resolution flow

### Security tests
- key zeroization checks where applicable
- token storage isolation
- no-secret logging checks

---

## 14) Open Decisions
1. Single-file remote object vs per-item object layout per provider.
2. Exact conflict metadata schema (`vector_clock` vs lamport + timestamps).
3. Plugin trust model and signature/allowlist policy.
4. Team vault protocol shape and authority model.

---

## 15) Acceptance Criteria for “Architecture Ready”
- Vault appears as global sidebar feature.
- Provider abstraction exists and Google adapter uses it.
- Sync profile lifecycle is persisted and visible in UI.
- Conflict state surfaced with deterministic resolution flow.
- Existing users can upgrade without data loss.

---

## 16) Immediate Next Engineering Tasks
1. Create ADR: `docs/adr/ADR-VAULT-001-global-vault-navigation.md`.
2. Define `SyncProfile` and `ProviderCapabilities` types in backend + frontend contracts.
3. Implement Google provider adapter over the new interface.
4. Add sidebar Vaults navigation and tab routing.
5. Add sync status widget with last run + error summary.

---

## 17) Team Skill Matrix (for Modular + Scalable Delivery)

To keep implementation manageable and robust, split ownership by skill areas.

### 17.1 Required skill lanes
- **Security/Crypto lane**
  - Key lifecycle, passphrase/recovery flows, secret-handling guarantees, zeroization checks.
- **Backend architecture lane (Rust/Tauri)**
  - Provider contract, sync state machine, profile persistence, migration adapters.
- **Frontend UX lane (React/TS)**
  - Sidebar Vaults IA, tab workflows, conflict center, sync health/status surfaces.
- **Reliability/QA lane**
  - Fault injection, retry behavior, migration safety, non-regression coverage.
- **Docs/ADR lane**
  - Architecture decisions, compatibility notes, rollout and operational playbooks.

### 17.2 Definition of done per lane
- Security lane: threat model reviewed, no plaintext secret logs, key handling tests passing.
- Backend lane: provider abstraction merged, Google flow behind adapter, stable IPC contract.
- Frontend lane: vault discoverability goals met, conflict and sync status visible.
- QA lane: unit + integration + E2E happy-path and failure-path coverage for sync lifecycle.
- Docs lane: ADRs, migration notes, and operator troubleshooting guide updated.

### 17.3 Cross-lane quality gates
1. No feature merges without explicit conflict-state UX.
2. No provider merge without conformance tests to `VaultProviderV1`.
3. No migration merge without rollback/backup validation.
4. No autosync merge without retry/backoff and bounded-failure semantics.
5. No public release without upgrade path verification from existing local vault users.
