# Vault Credential Types Model

## Purpose

This document captures the long-term direction for Zync Vault credential storage.

The vault should not be treated as only an SSH private-key store. SSH keys are the
first supported credential type, but the durable product model is:

> Zync Vault stores typed credentials. SSH keys, passwords, certificates, Jenkins credentials, and plugin-defined secrets are all credential types.

This keeps the current SSH workflow simple while leaving a clean path for future
credentials without rebuilding the vault identity, sync, or host-reference model.

---

## Current State

Today Zync is SSH-focused:

- local hosts reference credentials through `authRef` / `credentialId`
- the vault stores SSH private keys and password-like secrets
- secure-to-vault migrates connection auth material out of host records
- provider sync moves encrypted vault records by stable credential identity
- credential record schema v2 stores named encrypted secret values instead of
  one opaque secret string
- `ssh-private-key` is the canonical kind; an optional `passphrase` is a named
  field of that credential rather than a separate credential kind

That is the right foundation, but the UI and data model should keep saying
**credential** instead of assuming every vault item is a **key**.

---

## Product Direction

Zync Vault should grow into a generic credential vault with typed forms and typed
runtime adapters.

Recommended credential categories:

```text
SSH Credentials
  - SSH private key
  - SSH private key + passphrase
  - SSH username + password
  - SSH username + private key
  - SSH certificate / key pair

Generic Credentials
  - username/password
  - API token
  - access token
  - secret text
  - environment secret

Certificates
  - client certificate
  - private key
  - CA certificate
  - certificate chain / bundle

Service / Tool Credentials
  - Jenkins credential
  - Git credential
  - container registry credential
  - cloud provider credential
  - plugin-defined credential

External References
  - OS keychain reference
  - hardware/security-key reference
  - provider-managed secret reference
```

External references should not silently copy secrets out of another secure store.
They should store a durable reference plus metadata and require an adapter that
knows how to resolve that reference safely.

---

## Core Data Model

Avoid modeling every vault item as a single opaque `secret` string forever.

Use a typed credential envelope with fields:

```ts
interface CredentialEntity {
  credentialId: string;
  kind: CredentialKind;
  label: string;
  fields: CredentialField[];
  metadata: CredentialMetadata;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  revision: number;
  schemaVersion: number;
}

interface EncryptedCredentialPayload {
  // Stored only inside the per-record encrypted payload.
  secretValues: Record<string, string>;
}

interface CredentialField {
  name: string;
  label: string;
  secret: boolean;
  required?: boolean;
  format?:
    | 'text'
    | 'username'
    | 'password'
    | 'private-key'
    | 'certificate'
    | 'token'
    | 'url'
    | 'json';

  // Non-secret fields may be stored directly for search/display.
  value?: string;

  // Secret fields should resolve through vault encryption, not be logged or
  // indexed as plaintext.
  valueRef?: string;

  encoding?: 'plain' | 'pem' | 'base64';
}

interface CredentialMetadata {
  service?: string;
  url?: string;
  username?: string;
  pluginId?: string;
  externalRefKind?: 'os-keychain' | 'hardware-key' | 'provider-secret';
  externalRef?: string;
  schemaName?: string;
  schemaVersion?: number;
}
```

### Field rules

- Secret fields use `valueRef` / encrypted vault storage.
- Canonical secret references use `secret:<fieldName>`, for example
  `secret:privateKey`, `secret:passphrase`, and `secret:password`.
- Normal item-detail IPC returns typed metadata and field references only; it
  does not return `secretValues` to the renderer.
- Non-secret fields may use `value` for labels, usernames, service names, URLs,
  and search-friendly metadata.
- Never log secret field values.
- Never use raw secret hashes for dedupe. Use the existing keyed fingerprint
  direction so equality checks do not become dictionary-attackable.
- Keep field names stable once shipped; add schema migrations for renames.

---

## Credential Kinds

Suggested storage enum:

```text
ssh-private-key
ssh-password
ssh-certificate
username-password
api-token
secret-text
certificate
certificate-key-pair
certificate-chain
git-credential
jenkins-credential
container-registry-credential
cloud-provider-credential
external-keychain-reference
plugin-defined
```

Rules:

- Keep kinds stable and migration-friendly.
- Model optional secret material as fields, not kind variants. A private key
  with a passphrase remains `ssh-private-key`.
- Do not overload one kind with unrelated schemas.
- Prefer a generic kind (`username-password`) when a service does not need
  special runtime behavior.
- Use service-specific kinds (`jenkins-credential`) only when the UI, validation,
  or adapter behavior needs to be service-aware.
- Plugin-defined credentials must include `pluginId`, `schemaName`, and
  `schemaVersion`.

---

## Examples

### Jenkins username/password credential

```json
{
  "credentialId": "cred_jenkins_prod",
  "kind": "username-password",
  "label": "Jenkins prod",
  "fields": [
    {
      "name": "username",
      "label": "Username",
      "secret": false,
      "format": "username",
      "value": "admin"
    },
    {
      "name": "password",
      "label": "Password",
      "secret": true,
      "format": "password",
      "valueRef": "secret:password"
    }
  ],
  "metadata": {
    "service": "jenkins",
    "url": "https://jenkins.example.com"
  },
  "tags": ["ci", "prod"],
  "schemaVersion": 1
}
```

### SSH private key with passphrase

```json
{
  "credentialId": "cred_prod_ssh_key",
  "kind": "ssh-private-key",
  "label": "Production SSH key",
  "fields": [
    {
      "name": "privateKey",
      "label": "Private Key",
      "secret": true,
      "format": "private-key",
      "encoding": "pem",
      "valueRef": "secret:privateKey"
    },
    {
      "name": "passphrase",
      "label": "Passphrase",
      "secret": true,
      "format": "password",
      "valueRef": "secret:passphrase"
    }
  ],
  "metadata": {
    "username": "deploy"
  },
  "tags": ["prod", "ssh"],
  "schemaVersion": 1
}
```

### Certificate/key-pair credential

```json
{
  "credentialId": "cred_client_cert_prod",
  "kind": "certificate-key-pair",
  "label": "Production client certificate",
  "fields": [
    {
      "name": "certificate",
      "label": "Certificate",
      "secret": false,
      "format": "certificate",
      "encoding": "pem",
      "value": "-----BEGIN CERTIFICATE-----..."
    },
    {
      "name": "privateKey",
      "label": "Private Key",
      "secret": true,
      "format": "private-key",
      "encoding": "pem",
      "valueRef": "secret:privateKey"
    },
    {
      "name": "chain",
      "label": "Certificate Chain",
      "secret": false,
      "format": "certificate",
      "encoding": "pem",
      "value": "-----BEGIN CERTIFICATE-----..."
    }
  ],
  "metadata": {
    "service": "mtls"
  },
  "schemaVersion": 1
}
```

### OS keychain reference

```json
{
  "credentialId": "cred_keychain_github",
  "kind": "external-keychain-reference",
  "label": "GitHub token in OS keychain",
  "fields": [],
  "metadata": {
    "service": "github",
    "externalRefKind": "os-keychain",
    "externalRef": "zync:github:prod-token"
  },
  "schemaVersion": 1
}
```

This record does not contain the token. It tells the runtime adapter where to
request it on this device.

---

## Host Relationship

Hosts are app data. Credentials are vault data.

Correct relationship:

```text
Host -> authRef / credentialId -> Vault Credential
```

A host should not store raw private keys, passwords, or secret file fallbacks
after the credential is secured to vault.

The host should only store:

- hostname / port / user-facing connection metadata
- `authRef` / `credentialId`
- non-secret preferences

The SSH adapter resolves the credential into runtime auth material:

```text
Host
  authRef: cred_prod_ssh_key

Vault Credential
  kind: ssh-private-key
  fields: privateKey, passphrase

SSH adapter
  -> private-key auth material
```

Later adapters can resolve the same credential model for Jenkins, Git,
certificates, cloud tools, or plugins without putting those secrets into host
records.

---

## Plugin and Schema Extensibility

The vault core owns:

- encryption
- locking/unlocking
- recovery
- audit metadata
- provider sync serialization
- field secrecy rules

Plugins may register credential schemas, but they must not bypass vault core.

Plugin schema contract should eventually include:

```ts
interface CredentialSchema {
  pluginId: string;
  schemaName: string;
  schemaVersion: number;
  kind: 'plugin-defined' | CredentialKind;
  fields: CredentialFieldDefinition[];
  displayName: string;
  description?: string;
}
```

Rules:

- plugin schemas must be versioned
- plugin-defined secret fields still use vault encryption
- plugins receive resolved secret material only through explicit user-approved
  runtime actions
- provider sync stores encrypted credential records, not plugin-owned plaintext
  blobs

---

## Sync Implications

This model aligns with the selective provider sync direction:

```text
CredentialEntity
  credentialId
  kind
  localVaultItem?
  providers[]
  syncState
```

Provider sync should sync encrypted credential records by `credentialId`,
independent of the specific credential kind.

Credential restore/import should remain stricter than normal app-data sync:

- preview-first by default
- conflict-aware
- no silent import of secrets unless explicitly opted in
- optional keep-synced per credential later
- provider is a location, not the credential identity

Remote credentials should be browsable as encrypted provider records and
selectively imported/cached.

---

## UX Direction

Preferred user-facing language:

- Vault Credential
- Credential type
- Add credential
- Import credential
- Assign credential to host
- Used by
- Available from provider

Avoid reducing everything to:

- key
- password

“Key” should be a specific credential type, not the vault’s entire identity.

Recommended UI flow:

```text
Add Credential
  SSH private key
  Username + password
  API token
  Certificate / key pair
  Jenkins credential
  Plugin credential
```

Credential detail view should eventually show:

- type-specific form
- non-secret metadata
- reveal/copy actions with explicit intent
- “Used by” hosts/apps/plugins
- provider availability
- revision/rotation history

---

## Migration Direction

Current SSH-key-focused records can evolve without breaking existing hosts.

Migration strategy:

1. Preserve current `credentialId` / logical identity.
2. On unlock, run idempotent record migration before returning vault status.
3. Wrap legacy SSH vault records in typed credential envelopes.
4. Split legacy raw/JSON private-key payloads into named `privateKey` and
   optional `passphrase` secret values.
5. Canonicalize legacy `ssh-key-with-passphrase` records to `ssh-private-key`.
6. Clear the legacy single-secret field before rewriting the encrypted record.
7. Keep backward-compatible readers for legacy local/provider records.
8. Add usernames/service/URL/tags as metadata or non-secret fields.
9. Add type-specific UI one credential kind at a time.

Recommended implementation order:

```text
V1: SSH-focused single-secret VaultItem (legacy read compatibility)
V2: typed envelope + named secret-value storage (implemented)
V3: username/password + certificate UI
V4: Jenkins/plugin-defined schema support
```

---

## Anti-patterns to Avoid

Avoid:

- treating every credential as one opaque `secret` string forever
- putting host records inside the vault
- storing provider-specific duplicate credential identities
- letting plugins manage their own plaintext secret storage
- silently copying secrets from OS keychain or hardware-backed stores
- syncing plaintext metadata that can reveal sensitive internals unnecessarily

Prefer:

- stable `credentialId`
- typed credential envelope
- encrypted secret fields
- searchable non-secret metadata
- explicit adapters for runtime use
- preview-first restore for sensitive records

---

## Design Rule to Preserve

When adding Jenkins credentials, certificates, Git credentials, plugin
credentials, cloud tokens, or keychain references, preserve this invariant:

```text
A vault item is a typed credential envelope.
A host references credentials; it does not own credential storage.
Provider sync moves encrypted credential records; it does not define credential identity.
Plugins may extend schemas, but vault core owns encryption and secret lifecycle.
```
