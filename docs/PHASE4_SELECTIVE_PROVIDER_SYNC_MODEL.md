# Phase 4 Direction — Selective Provider Sync Model

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
`VAULT_CREDENTIAL_TYPES_MODEL.md`.

#### Backups

Backups are disaster recovery snapshots, not the normal sync graph.

They should remain conceptually separate from per-item provider records.

---

## Related Documents

- VAULT_CREDENTIAL_TYPES_MODEL.md — long-term model for vault credentials beyond SSH keys/passwords.
- VAULT_CREDENTIAL_IDENTITY_MODEL.md — stable credential identity and host reference rules.

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

