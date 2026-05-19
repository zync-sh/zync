# Phase 3 Plan — App Data Sync + Profile UX

## Goal
Expand sync beyond Vault credentials to include core app data domains, while improving account/sync discoverability via top-bar profile UX.

## Scope
Phase 3 (Google-first, provider-agnostic design):
- Domain sync for:
  - Vault credentials (existing)
  - Hosts
  - Tunnels
  - Snippets
  - Settings (safe subset)
- Top-bar signed-in profile entry (VS Code-style) with account/sync dropdown.
- Per-domain sync controls, status, and restore.
- Conflict handling by domain.

## Non-goals (for this phase)
- Adding a second cloud provider.
- Team/shared vault.
- Real-time collaborative sync.

---

## Architecture Additions

### 1) Domain-based sync model
Introduce sync domains:
- `vault`
- `hosts`
- `tunnels`
- `snippets`
- `settings`

Each domain has:
- serializer/deserializer
- item identity model
- merge/conflict strategy
- migration/version handling

Current implementation notes:
- Hosts: snapshot/upload/restore available
- Tunnels: snapshot/upload/restore available
- Snippets: snapshot/upload/restore available
- Settings: upload/restore available with strict allowlist only

### 2) Provider object model
Provider stores encrypted domain records:
- object key format:
  - `zync-sync-{collectionId}-{domain}-{itemLogicalId}.zobj`
- payload envelope:
  - `version`
  - `domain`
  - `logicalId`
  - `revision`
  - `updatedAt`
  - encrypted payload

### 3) Sync profile extensions
Extend `sync-profiles.json` with:
- connected account identity (email/avatar when provider exposes it)
- enabled domains
- last sync per domain
- last error per domain
- sync policy per domain (manual/auto/interval)

Current implementation notes:
- Provider status returns `domainStatuses[]` so UI can render per-domain last sync/error without guessing from global state.
- Successful domain upload/restore updates both global provider status and that domain's status.
- Domain definitions are centralized in the frontend (`src/vault/syncDomains.ts`) to avoid UI-only hardcoding.

### 4) Conflict model by domain
Add domain-scoped conflict entities:
- `domain`
- `logicalId`
- local/remote metadata
- decision status

---

## UX Plan

### 1) Top-bar profile menu
Add profile/account node in title/top bar:
- avatar/initial + email
- connection status badge
- dropdown actions:
  - Manage Sync
  - Account Settings
  - Disconnect
  - Open Settings

### 2) Move sync/account settings
Move sync/account controls from Settings page into profile dropdown + Vault/Sync workspace entry points.

### 3) Domain sync controls
In Sync UI:
- toggles for each domain
- per-domain backup/restore
- per-domain sync status + last sync time

Current implementation notes:
- The Vault tab shows a single domain table for vault credentials, hosts, tunnels, snippets, and settings.
- Each row has its own enable/disable state, operation buttons, and status text from `domainStatuses[]`.

### 4) Restore UX
Support:
- restore all enabled domains
- restore selected domains
- preview counts by domain

Current implementation notes:
- Credential restore has a review modal with scanned/new/update/delete/unchanged/failed counts before applying.
- Credential conflicts are shown in the same modal with per-item remote-apply selection.
- Non-vault app-data domains currently expose per-domain restore actions; all-enabled bulk restore remains a later UX layer.

---

## Security & Data Rules

- Keep end-to-end app-level encryption for all synced domain payloads.
- Never upload passphrases/recovery keys.
- Domain records use logical IDs + revisions for convergence.
- Settings sync must use allowlist (exclude local-only secrets/system paths).

Current settings allowlist:
- `theme`
- `fontFamily`
- `fontSize`
- `showHiddenFiles`
- `confirmOnExit`
- `editorTheme`
- `terminalFontSize`

---

## Rollout Plan

### Step 1 — Domain scaffolding
- Add domain enum/types/contracts.
- Add serializers for hosts/tunnels/snippets/settings.

### Step 2 — Domain record upload/restore
- Implement per-domain upload/list/read/restore.
- Keep vault flow unchanged, then plug into same orchestration.

### Step 3 — Profile/top-bar UX
- Add signed-in profile in top bar.
- Move account/sync entry points into dropdown.

### Step 4 — Conflict + preview
- Add preview + conflict resolution grouped by domain.

### Step 5 — Policies + stabilization
- Add per-domain policy controls.
- Add reliability + fault-injection tests.

---

## Testing Matrix (Phase 3)

1. Domain enable/disable persistence.
2. Backup/restore for each domain.
3. Repeat restore convergence (no endless re-apply).
4. Conflict detection + manual resolution per domain.
5. Settings allowlist enforcement.
6. Disconnect/reconnect + profile UI state consistency.

---

## Exit Criteria

Phase 3 is complete when:
- At least 4 non-vault domains sync reliably (hosts/tunnels/snippets/settings).
- Profile menu is primary sync/account entry point.
- Per-domain sync status + restore/conflict flows are production-stable.
- Automated tests cover core convergence/conflict scenarios.

Current closure status:
- Implemented: hosts/tunnels/snippets/settings upload + restore, profile dropdown entry point, per-domain controls/status, credential restore preview/conflict selection.
- Remaining before declaring fully shippable: final end-to-end manual matrix across a clean profile and a populated Google sync collection, plus any CodeRabbit/CI follow-up.

---

## Deferred (Phase 4+)
- Second provider implementation.
- Team/shared vault + org policy controls.
- Full bi-directional live sync scheduling across providers.
