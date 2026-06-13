# Vault Provider Sync Key Model

## Status

- **Owner:** Core app team
- **Document type:** Architecture decision + implementation guide
- **Last updated:** 2026-05-13
- **Scope:** Provider sync passphrases, per-credential cloud records, recovery, and restore behavior

---

## 1) Problem This Solves

The current Google Drive flow is a full-file backup:

```text
local vault.redb -> provider vault.redb
provider vault.redb -> replace local vault.redb
```

That is acceptable only as a disaster-recovery fallback. It becomes confusing when users:

- create a local vault with passphrase A and back it up
- reset local vault and create a new vault with passphrase B
- back up again to the same provider
- later add Git, S3, or self-hosted sync

The robust model is **provider-scoped encrypted credential sync**, not full database replacement.
Providers should store encrypted credential records that can be restored into any local vault after
the provider sync collection is unlocked.

---

## 2) Terms

- **Local Vault:** the device-local encrypted `vault.redb`.
- **Local Vault passphrase:** unlocks the local vault on this device.
- **Provider Sync Collection:** encrypted remote collection for one provider profile, such as Google Drive.
- **Provider Sync passphrase:** unlocks a provider sync collection.
- **Provider Sync key:** random key used to encrypt provider records; it is wrapped by passphrase/recovery slots.
- **Recovery key:** optional fallback secret that can unwrap the Provider Sync key.
- **Credential record:** one logical credential identified by `credentialId` / `logicalId`.

---

## 2.1) Credential Scope and Taxonomy

Use **Credential** as the product/domain name, not only **Key**. SSH keys are the first credential
type, but the model must stay open for broader auth material.

### Current implementation scope

For the next implementation slice, provider sync should support the current vault-backed credential
shape:

- SSH private key secret
- optional key passphrase
- label, kind, revision, timestamps
- stable `credentialId` / `logicalId`

### Future credential categories

The same model should later support category-wise listing and sync for:

- SSH private keys
- SSH passwords
- key + certificate pairs
- API tokens / secure notes
- passphrases
- FIDO2 / hardware-backed auth references
- OS keychain-backed references

### Username handling

Do not force username into every credential record by default. In SSH clients, the same private key can
be used by multiple usernames/hosts. Keep username on the host assignment unless the user explicitly
creates a bundled credential such as:

```text
SSH login credential = username + auth material
```

This keeps both flows possible:

- key-only credential assigned to many hosts/users
- login credential bundle for users who want “username + key/password” as one reusable item

### UI implication

The Vault UI should label the area as **Credentials** and show category filters over time. For v1,
only SSH key credentials need to be active; future categories can be hidden until implemented.

---

## 3) Key Policy Options

Each provider profile has a key policy:

```ts
type ProviderSyncKeyPolicy =
  | { mode: "local-passphrase"; providerId: string }
  | { mode: "custom-passphrase"; providerId: string }
  | { mode: "recovery-key"; providerId: string };
```

### Default: use Local Vault passphrase text

Recommended first-run UX:

> Use your Local Vault passphrase for Google Sync.

This means the same passphrase text can unlock both local and provider data, but Zync must still
derive separate cryptographic keys with separate contexts. The local vault encryption key is never
reused for provider encryption.

### Advanced: custom provider passphrase

Advanced users can choose a separate provider passphrase:

- better isolation between providers
- useful for Git/self-hosted/team-adjacent storage
- higher recovery burden because each custom provider passphrase must be remembered or recovered

### Recovery key

Every provider sync collection should offer a recovery key. If both passphrase and recovery key are
lost, Zync cannot decrypt that provider's credential records.

---

## 4) Crypto Boundary

The decrypt/re-encrypt flow is expected and safe when it stays inside trusted backend memory:

```text
local vault item --decrypt with Local Vault key--> plaintext in backend memory
plaintext --encrypt with Provider Sync key--> provider credential record
```

Rules:

- never upload plaintext secrets
- never upload raw passphrases
- never upload raw recovery keys
- never reuse the raw local vault encryption key for provider records
- derive wrapping keys with explicit context separation, for example:
  - `zync-local-vault:<vaultId>`
  - `zync-provider-sync:<providerKind>:<providerProfileId>`

This allows the same passphrase text to be convenient without collapsing security boundaries.

---

## 5) Provider Storage Model

Future normal sync should store a manifest plus per-credential encrypted records:

```text
zync-sync/
  manifest.json
  credentials/
    <credentialId>/
      current.zcred
      revisions/
        <revision>.zcred
```

`manifest.json` contains safe metadata:

- schema version
- provider profile id
- sync collection id
- created/updated timestamps
- wrapped Provider Sync key slots:
  - passphrase slot: `keyWrapSalt`, `keyWrapNonce`, `keyWrapCiphertext`
  - recovery slot: `recoveryKeyWrapSalt`, `recoveryKeyWrapNonce`, `recoveryKeyWrapCiphertext`
- credential count
- optional provider cursor/etag metadata

### Implemented key wrapping behavior

- Provider sync setup always requires a passphrase input.
- The default policy asks for the **Local Vault passphrase** and validates it against the current
  local vault before creating/updating the sync collection.
- The provider sync collection key is random key material and is never the local vault encryption key.
- The collection key is wrapped with Argon2id + XChaCha20-Poly1305 using provider/collection/mode
  AAD context separation, then cached in the OS keychain for normal operations.
- Argon2id parameters for provider key-wrapping derivation are fixed to:
  - memory cost: **64 MiB** (`m=65536` KiB)
  - time cost / iterations: **3** (`t=3`)
  - parallelism: **1** (`p=1`)
  - output key length: **32 bytes** (for XChaCha20-Poly1305 key material)
- If the keychain cache is lost, the wrapped key can be rehydrated by setting up the same provider
  collection with the correct passphrase again.
- When the user chooses the recommended recovery option, Zync generates a one-time provider sync
  recovery key and writes a second encrypted wrap slot for the same provider collection key.
- The recovery key can unlock only the provider sync collection key cache. It does not unlock the
  Local Vault and is never uploaded.

Each `.zcred` contains an encrypted credential payload:

- `credentialId` / `logicalId`
- credential kind
- label and non-secret metadata
- secret material
- revision
- updated timestamp
- tombstoned state (`deleted=true`)

Providers are storage adapters. They do not decide credential identity and do not need plaintext access.

---

## 6) Restore and Sync Scenarios

### Sync selected credential

If 50 credentials already exist in Google Drive and the user syncs one more credential, Zync uploads
only that credential record/revision, not all 51 records.

### Restore into a new local vault

If a user creates a new local vault with a new passphrase:

1. user connects the provider
2. user unlocks the Provider Sync Collection with its provider passphrase or recovery key
3. user selects credentials to restore
4. Zync decrypts provider records and writes them into the new local vault under the new local vault encryption key.

The old local vault passphrase is only needed if that was the chosen provider sync passphrase policy.

### Reset provider sync

If the user forgets the provider sync passphrase and recovery key, the safe reset path is:

- delete the provider sync collection
- create a new provider sync collection
- upload credentials again from an unlocked local vault

This does not recover old remote-only credentials.

### Conflict and tombstone behavior (implemented)

- Restore now runs a deterministic decision model per `logicalId`:
  - higher remote revision ⇒ update
  - lower remote revision ⇒ skip as stale
  - same revision + same payload ⇒ skip
  - same revision + same timestamp + different payload ⇒ mark conflict (skip, no silent overwrite)
- Provider payloads may include tombstoned records (`deleted=true`).
  - Tombstones apply only when remote revision/timestamp is newer than local.
  - Otherwise tombstones are ignored as stale.

Concurrent offline edits to different `logicalId`s are reconciled independently because restore
decisions are computed per `logicalId`; both updates are accepted and the system converges to
eventual consistency across devices. For the same `logicalId`, deterministic ordering is:
revision → timestamp → payload equality. If revision and timestamp are equal but payload differs,
Zync raises a user-visible conflict for manual resolution. Tombstoned records follow the same
"newer-than-local" rule.

Clock skew note: timestamp comparisons currently use exact values (no drift window). This means
the same-revision + same-timestamp rule depends on device clocks being reasonably synchronized
(use NTP/UTC). Revision remains the primary ordering signal; timestamp is only a tie-breaker.

### Legacy full-file restore

Full `vault.redb` upload/restore remains a separate destructive disaster-recovery action. It should be
clearly labeled as replacing the local vault file and requiring the passphrase of the restored vault.

---

## 7) UX Copy Guidance

Use explicit names in UI:

- **Local Vault passphrase** — unlocks this device's vault.
- **Google Sync passphrase** — unlocks credentials stored in Google Drive.
- **Use Local Vault passphrase for Google Sync** — default/recommended.
- **Use separate Google Sync passphrase** — advanced isolation.

Restore copy must say:

> Provider sync restores encrypted credentials into your current Local Vault. It does not replace the
> vault file unless you choose Legacy Full Restore.

Legacy restore copy must say:

> This replaces your local vault file. You must know the passphrase or recovery key for the restored vault.

---

## 8) Implementation Checklist

1. ✅ Add provider sync manifest and key-slot schema.
2. ✅ Add provider unlock/setup flow with key policy selection.
3. ✅ Add per-credential provider object read/write APIs.
4. ✅ Add selected credential upload/download flows.
5. ✅ Add conflict detection by `credentialId`, revision, and updated timestamp.
6. ✅ Keep full-file `vault.redb` backup under a clearly labeled legacy/disaster restore path.
7. ✅ Add provider contract/conformance tests for `VaultProviderV1` capability invariants.
8. ✅ Enforce sync-key policy cryptographically with wrapped provider collection keys.
9. ✅ Add provider sync recovery-key slot generation and unlock flow.

---

## 9) Non-Goals / Deferred Work

- Team vault authority model.
- Multi-user sharing policies.
- Hardware-backed FIDO2 credential sync.
- Cross-provider automatic merge without user-visible conflict state.
- Storing hosts, snippets, tunnels, settings, or known-hosts in the sync collection.
