# Security Notes — Zync v2.16.0

**Release date:** 2026-06-15  
**Applies to:** Zync v2.16.0 (vault + Google sync release)

---

## Summary

v2.16.0 is **not** a CVE-style emergency patch. It introduces a **new security surface**: encrypted local vaulting, optional remember-on-device unlock, and Google Drive–backed encrypted sync.

This document explains what changed from a security perspective, what users and operators should know, and what remains out of scope.

---

## New Security Capabilities

### Local Vault (encrypted at rest)

- Host credentials can be stored in an **encrypted local vault** instead of plaintext connection files.
- Vault crypto uses **Argon2id key derivation** and **AEAD** for record encryption (see [VAULT.md](./VAULT.md)).
- Vault unlock requires a user passphrase; a **recovery key** can be generated for passphrase loss scenarios.
- Plaintext host credentials can be **migrated into the vault** during normal workflows.

**Relevant commits:** [6e8dd42], [1d865ed], [e0409f4]

### Stable credential identity

- Hosts reference vault credentials via durable **`credentialId`** / `logicalId` instead of owning raw secrets directly.
- Stale `itemId` / missing `credentialId` paths include **self-healing relink and repair** on load.

**Relevant commits:** [1d865ed], [bdbd81b], [416c1b4]

### Credential revision history

- Rotated credentials keep **revision snapshots**; operators can review prior revisions and restore an older one from the Vault UI.
- Restore preserves stable `credentialId` identity so host references stay valid.

**Relevant commits:** [e0409f4]

### Google Drive vault sync

- Vault backups and sync collections are stored in Google **`drive.appdata`** (hidden app folder, not user-visible Drive files).
- Sync collections use a **separate encryption passphrase** (local-vault-derived or custom).
- OAuth uses Google's installed/desktop app flow with scoped access to Drive app data and account email.

**Relevant commits:** [8cdb20d], [85f038e], [e3a393e]

---

## Security Hardening in This Release

| Area | What was hardened |
|------|-------------------|
| **Session unlock cache** | Optional OS keychain cache for vault session material; hardened restore and vault-auth edge cases. ([35c3285], [416c1b4]) |
| **Connect / test flows** | Vault-backed hosts prompt for unlock instead of silently failing or auto-connecting with missing secrets. ([c372596]) |
| **Tab open behavior** | Vault-backed connections defer auto-connect until explicit user reconnect. ([1d865ed]) |
| **Sync durability** | Atomic JSON writes with fsync on production sync/vault paths; improved restore convergence and Windows finalize handling. ([d5becab], [c69d592]) |
| **Concurrent operations** | Guards against vault/sync state loss during overlapping provider and local operations. ([4ae5df9], [39ad2d7]) |
| **Build-time secret filtering** | `build.rs` blocks most sensitive env keys from compile-time embedding; `GOOGLE_CLIENT_SECRET` is explicitly allowlisted only for desktop OAuth compatibility. ([6e8dd42]) |

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

These are **product scope** limits for v2.16.0, not vulnerabilities:

- **No team/org policy controls** — vault and sync are single-user oriented today; shared/team vaults are deferred to later phases.
- **No live bi-directional sync scheduling** — Google sync is manual upload/restore; there is no background auto-sync scheduler yet.
- **Plugins** — marketplace plugins do **not** receive raw vault secrets by design; only explicit future export/copy flows could change that.

**Not a concern for this release:** credential revision history UI (review + restore) **is included** in v2.16.0. Embedded desktop OAuth client credentials are **informational only** — see Google OAuth guidance above.

---

## Reporting Security Issues

If you discover a vulnerability in Zync, report it privately to the maintainers rather than opening a public issue with exploit details.

---

## Related Documentation

- [VAULT.md](./VAULT.md) — current vault and sync architecture
- [VAULT_ROADMAP.md](./VAULT_ROADMAP.md) — planned vault/sync work
- [CHANGELOG.md](../CHANGELOG.md) — v2.16.0 section

---

## Commit References

[6e8dd42]: https://github.com/zync-sh/zync/commit/6e8dd42
[8cdb20d]: https://github.com/zync-sh/zync/commit/8cdb20d
[1d865ed]: https://github.com/zync-sh/zync/commit/1d865ed
[bdbd81b]: https://github.com/zync-sh/zync/commit/bdbd81b
[e0409f4]: https://github.com/zync-sh/zync/commit/e0409f4
[85f038e]: https://github.com/zync-sh/zync/commit/85f038e
[e3a393e]: https://github.com/zync-sh/zync/commit/e3a393e
[35c3285]: https://github.com/zync-sh/zync/commit/35c3285
[416c1b4]: https://github.com/zync-sh/zync/commit/416c1b4
[c372596]: https://github.com/zync-sh/zync/commit/c372596
[c69d592]: https://github.com/zync-sh/zync/commit/c69d592
[d5becab]: https://github.com/zync-sh/zync/commit/d5becab
[4ae5df9]: https://github.com/zync-sh/zync/commit/4ae5df9
[39ad2d7]: https://github.com/zync-sh/zync/commit/39ad2d7