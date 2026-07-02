# Security Notes

**Last updated:** 2026-07-01  
**Scope:** Vault, Google sync, credential handling, and operator guidance for current Zync releases.

---

## Summary

Zync's main security surface is **encrypted local vaulting**, optional **remember-on-device unlock**, and **Google Drive–backed encrypted sync**. This document explains how those systems behave, what users and operators should know, and what remains out of scope.

---

## Security Capabilities

### Local Vault (encrypted at rest)

- Host credentials can be stored in an **encrypted local vault** instead of plaintext connection files.
- Vault crypto uses **Argon2id key derivation** and **AEAD** for record encryption (see [VAULT.md](./VAULT.md)).
- Vault unlock requires a user passphrase; a **recovery key** can be generated for passphrase loss scenarios.
- Plaintext host credentials can be **migrated into the vault** during normal workflows.

### Stable credential identity

- Hosts reference vault credentials via durable **`credentialId`** / `logicalId` instead of owning raw secrets directly.
- Stale `itemId` / missing `credentialId` paths include **self-healing relink and repair** on load.

### Credential revision history

- Rotated credentials keep **revision snapshots**; operators can review prior revisions and restore an older one from the Vault UI.
- Restore preserves stable `credentialId` identity so host references stay valid.

### Google Drive vault sync

- Vault backups and sync collections are stored in Google **`drive.appdata`** (hidden app folder, not user-visible Drive files).
- Sync collections use a **separate encryption passphrase** (local-vault-derived or custom).
- OAuth uses Google's installed/desktop app flow with scoped access to Drive app data and account email.

---

## Security Hardening

| Area | Behavior |
|------|----------|
| **Session unlock cache** | Optional OS keychain cache for vault session material; hardened restore and vault-auth edge cases |
| **Connect / test flows** | Vault-backed hosts prompt for unlock instead of silently failing or auto-connecting with missing secrets |
| **Tab open behavior** | Vault-backed connections defer auto-connect until explicit user reconnect |
| **Sync durability** | Atomic JSON writes with fsync on production sync/vault paths; improved restore convergence and Windows finalize handling |
| **Concurrent operations** | Guards against vault/sync state loss during overlapping provider and local operations |
| **Build-time secret filtering** | `build.rs` blocks most sensitive env keys from compile-time embedding; `GOOGLE_CLIENT_SECRET` is explicitly allowlisted only for desktop OAuth compatibility |

---

## Operator & User Guidance

### Passphrases and recovery

- Choose a **strong vault passphrase** (sync collection passphrases require at least 12 characters).
- **Store the recovery key offline** before relying on the vault for production hosts.
- Losing both passphrase and recovery key means **local vault data cannot be recovered**.

### Remember unlock on this device

- **Remember on device** stores session unlock material in the **OS keychain** (Windows Credential Manager / macOS Keychain / Linux secret service).
- This trades convenience for risk: anyone with access to your unlocked OS session may access vault-backed connections without re-entering the passphrase until cache expiry or **Forget device**.
- Do **not** enable remember-on-device on shared or untrusted machines.

### Google OAuth

- Official release builds embed **`GOOGLE_CLIENT_ID`** (and optionally **`GOOGLE_CLIENT_SECRET`**) for the Zync desktop OAuth client.
- **Low risk, expected for desktop apps:** Google's installed-app model does not treat the client secret as confidential — it cannot be kept secret inside a distributed binary. This is normal for desktop OAuth and is **not** the same as leaking a server-side OAuth secret.
- User data access still requires **per-user consent** and scoped tokens; extracting the embedded client pair alone does not grant access to someone else's Google data.
- Do **not** reuse a production **web/server** OAuth client for Zync desktop builds.
- Google sync tokens are stored locally; disconnect/revoke flows clear provider tokens where implemented.
- A future **PKCE-only** client (no embedded secret) is planned as hygiene improvement, not an urgent security blocker.

### Backups and restore

- Treat Google Drive sync collections as **encrypted backups**, not a live shared secrets broker.
- Review restore previews before applying connection bundle restore; scoped restore can affect hosts, tunnels, snippets, and credentials together.
- Use `scripts/reset-vault-test-data.ps1` only on **test machines** — full-local-reset wipes local hosts, vault, and sync state.

---

## Scope & Future Work (not security blockers)

These are **product scope** limits today, not vulnerabilities:

- **No team/org policy controls** — vault and sync are single-user oriented; shared/team vaults are deferred to later phases.
- **No live bi-directional sync scheduling** — Google sync is manual upload/restore; there is no background auto-sync scheduler yet.
- **Plugins** — marketplace plugins do **not** receive raw vault secrets by design; only explicit future export/copy flows could change that.

Embedded desktop OAuth client credentials are **informational only** for the installed-app model — see Google OAuth guidance above.

---

## Reporting Security Issues

If you discover a vulnerability in Zync, report it privately to the maintainers rather than opening a public issue with exploit details.

---

## Related Documentation

- [VAULT.md](./VAULT.md) — vault and sync architecture
- [VAULT_ROADMAP.md](./VAULT_ROADMAP.md) — planned vault/sync work
- [CHANGELOG.md](../CHANGELOG.md) — release history