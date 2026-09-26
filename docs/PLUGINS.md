# Zync plugins — security, runtime, permissions, and marketplace architecture

**Last updated:** 2026-09-25
**Status:** The local Manifest v2 Sandbox MVP is implemented. Signed marketplace install review, permission-diff review, publisher-key rotation, monotonic revocation, retained-version rollback, and repeated-crash automatic recovery are implemented. Production registry deployment and independent security review remain operational beta work.
**Related:** [SECURITY.md](./SECURITY.md), [WORKSPACE.md](./WORKSPACE.md), [TERMINAL.md](./TERMINAL.md), [VAULT.md](./VAULT.md)

---

## Implementation status

### API 2.1 SSH commands (local, unpublished)

The standalone PM2 Monitor rebuild in `../zync-pm2-monitor` uses the new `zync.sshCommand.execute` worker API. Native `plugins/ssh_command.rs` authorizes `ssh.command.execute`, resolves the connection from the host-owned pane binding, and quotes program/arguments individually for POSIX SSH servers. Plugins cannot pass a connection ID. This is an explicit **remote code execution** permission, not a command allowlist or filesystem sandbox; the permission review explains the account-level risk.

Commands have a five-second open timeout, twenty-second execution timeout, combined 2 MiB output limit, 64-argument/16 KiB input limit, one concurrent command per pane, and eight globally. A binding lease cancels channels on close/rebind/runtime revocation; optional-permission changes stop the runtime natively. A returned opaque connection token includes the binding and reconnect generation; passing `expectedConnectionToken` prevents a later action from silently targeting a replacement connection. Missing exit status is an error. Channel cancellation cannot undo remote side effects or guarantee termination of daemonized processes.

Host API compatibility and the local SDK are advanced to 2.1; no npm publication is implied. Existing API 2.0 plugins remain compatible. The old marketplace PM2 archive remains untouched until a signed standalone release exists.

### Existing Sandbox MVP

The Sandbox MVP is complete on `feature/plugin-sandbox-v2` for locally reviewed Manifest v2 plugins:

- one frontend plugin/manifest type model replaces the previous repeated component-local shapes;
- a versioned permission catalog is available to both native validation and frontend management;
- native Manifest v2 parsing and validation runs before install and load;
- legacy Manifest v1 packages remain compatible while migration is in progress;
- marketplace downloads are HTTPS-only and bounded, archives/directories have extraction budgets and link/path checks, installed-package digests are streamed under the same file/count/size limits, and activation restores the previous version on failure;
- signed packages may include deterministic `integrity.json` and Ed25519 `signature.json` metadata; Zync verifies the complete payload, manifest identity, integrity root, public-key fingerprint, and signature during review and every later load, while clearly treating self-contained local signatures as unverified publisher identity;
- a native signed-registry verifier now authenticates canonical versioned metadata against a release-baked root key, rejects expired, future-dated, rolled-back, forged, oversized, duplicate, non-HTTPS, and publisher/key-mismatched entries, and persists the highest accepted version plus cumulative revocations through recoverable atomic replacement;
- marketplace install and update requests now send only plugin identity and version to native code; native code reloads the trusted registry, selects the signed release, downloads its fixed URL, verifies package digest, Manifest v2 identity, publisher signature and registered signing key, then routes the staged package through the same host-owned permission review as local packages;
- local packages are staged before execution, reviewed in host-owned permission UI, and activated only after required permissions are accepted;
- Developer Mode is a native, persisted, default-off policy boundary: local inspection and activation require it, local and legacy packages stay stopped while it is off, disabling it invalidates runtime identities, and signed marketplace packages remain available;
- the typed frontend message broker now lives under `src/features/plugins/broker/`; it validates and routes Manifest v2 pane, notification, confirmation, command, storage, network, and filesystem requests while `PluginContext` retains lifecycle composition and the explicit Manifest v1 compatibility bridge;
- permission decisions are stored natively and bound to the publisher, version, and SHA-256 digest of the reviewed package; optional permissions default to denied;
- brokered file, SSH, network, private-storage, notification and confirmation actions request missing declared optional permissions through Zync's Allow/Deny dialog before executing. Deny cancels the action without remembering a refusal, so another attempt asks again. Allow persists the grant without restarting the worker; Settings can revoke it. Required or undeclared permissions cannot be elevated this way. Native checks revalidate the active runtime and installed package before saving approval, and concurrent requests for the same runtime/permission share one dialog;
- worker generations receive host-owned native runtime identities; notifications, command registration, and private plugin storage are enforced against the live runtime, package digest, declaration, grant, and request-rate limit, while command identity and title must also match the manifest contribution;
- `zync.storage` persists bounded string values in a publisher/plugin namespace with atomic replacement; plugins cannot select or enumerate another plugin's storage path;
- Manifest v2 pane registration resolves the declared title and HTML entry from the verified package in native code; pane ids are host-namespaced, frames use opaque origins and a restrictive CSP, and the legacy panel bridge is not exposed;
- every mounted plugin pane has a host-generated instance id and a bounded JSON message channel to its own Worker; Worker replies are routed only to a live pane instance owned by that plugin;
- the frontend runtime supervisor owns Worker generations, monitors responsiveness without treating host sleep as a failure, exposes runtime health in plugin management, removes contributions after a crash or heartbeat timeout, and quarantines a plugin after three failures within one minute;
- native recovery state retains bounded failure classifications and an unclean-shutdown marker; after an unexpected exit Zync starts with third-party plugins paused until the user chooses **Try plugins**;
- installed plugin details are resolved from the native package and grant stores, show publisher/source/digest/runtime/storage information, allow optional permissions to be changed against the exact approved package, and clear only that plugin's private device store after revoking its live native runtime;
- uninstall now revokes the runtime and grants immediately, keeps private plugin data by default, and offers a separate confirmed **Uninstall and delete data** action; a data-deletion failure is reported without pretending the already-removed package is still installed;
- raw compatibility Worker APIs for filesystem paths, external windows, theme mutation, status mutation, plugin inventory, and terminal input are broker-blocked for Manifest v2 packages;
- arbitrary plugin-created webview windows have been removed from the Worker SDK and native command surface; plugins contribute isolated workspace panes instead;
- Worker generations have a frontend message-rate boundary in addition to native broker request budgets; confirmation dialogs require the reviewed `ui.dialog.confirm` capability and host-bounded text;
- common ambient Worker networking primitives are locked down before plugin code runs; `zync.network.fetch` provides a native GET-only broker for granted public HTTPS hosts with DNS pinning, private/reserved-address denial, redirect revalidation, time and response-size limits, and no automatic credentials or cookies;
- `zync.filesystem` provides runtime-scoped, operation-specific opaque handles for files and folders selected in Zync-owned open/save pickers; read, list, and atomic text-write operations are permission-checked natively, bounded, relative-path constrained, and deny links, hard-linked files, device paths, alternate data streams, and protected Zync, credential, SSH, and browser-profile locations;
- `zync.sshFilesystem` resolves the server from the live plugin pane binding rather than a plugin-supplied connection id; read/list access is rooted at that server's home folder, accepts only canonicalized relative paths, and rejects local panes and paths that escape through traversal or links;
- Tauri's local asset protocol is limited to installed plugin packages under the app-config plugin directory; release-note media accepts HTTPS sources and cannot request arbitrary local files;
- the main webview has production and development CSPs that deny remote scripts, remote frames, objects, base-tag changes, and form submission; every plugin and editor frame adds its own no-network CSP rather than inheriting the host's approved destinations. Tauri script-hash augmentation is disabled only for `script-src` because sandboxed `srcDoc` panes require inline bootstrap code; removing that exception requires moving pane documents to a separately served origin;
- focused native and frontend contract tests cover permission identity and validation boundaries.
- adversarial package and permission tests exercise traversal and platform-conflicting paths, entry-count and compression bombs, package tampering, oversized manifests/files/pane HTML, forged identity/signatures, unknown permission grants, wildcard host-scope smuggling, runtime/handle ownership, request floods, and malformed, cyclic, deep, or oversized Worker messages;
- the former standalone demo is retained only at `tests/fixtures/plugins/manifest-v2-demo` for automated security tests; developer examples use the SDK basic starter.
- an independently versioned `@zync-sh/plugin-sdk@2.0.0-beta.1` authoring package is published on npm and maintained at `packages/plugin-sdk`; it exposes Manifest v2 authoring types, brokered Worker/pane API types, a manifest identity helper, pre-signing validation, and a basic starter template. Manifest v2 engine ranges are enforced by the native host during review, activation, load, and rollback. Live marketplace staging evidence remains Phase 5 work.

The completion gate includes TypeScript validation, a production frontend build, the full agent regression suite, 77 native plugin security tests, package corpus checks, and historically exercised desktop demo flows. The Plugins settings surface was also checked in the local browser test view; native install and permission behavior is covered by the desktop demo flow and native integration tests because a normal browser cannot access Tauri's plugin store.

Permission review and durable package-bound install grants are implemented for local and trusted-marketplace Manifest v2 packages. Updates show added, changed, removed, and unchanged access before activation; unchanged optional grants are preserved while new or scope-changed optional access defaults off, and approval is bound to the exact installed package reviewed. New packages now pass a bounded Worker-ready health check before their rollback copy is retained; failed checks restore both the previous package and its approval, while interrupted transactions recover on next launch. Plugin details expose the retained last-known-good version, and a user-requested rollback atomically rotates the current and retained packages, restores the matching permission approval, and health-checks the restored runtime. The native broker now enforces notification emission, host-owned confirmation dialogs, command registration, plugin-private storage, bounded public HTTPS reads, runtime-scoped user-selected local filesystem reads and writes, and pane-bound SSH home-folder reads. Package-level integrity, Ed25519 package signatures, signed registry verification, publisher-key binding and rotation, expiry, rollback protection, cumulative publisher-key and exact-release revocation, native registry-selected marketplace installation, staged root-key rotation, and repeated-crash automatic rollback are implemented. Deploying the signed registry remains operational beta work. Persisted/workspace handles, remote writes, remaining compatibility APIs, broader scoped/temporary grant lifetimes, stronger runtime-level network confinement, and final management screens also remain; Zync must not yet describe the entire compatibility bridge as fully sandboxed. Registry publication, backup, compromise, and root rotation are covered by [PLUGIN_REGISTRY_OPERATIONS.md](./PLUGIN_REGISTRY_OPERATIONS.md).

---

## 1. Purpose

Zync should support a broad plugin ecosystem without asking users to trust every plugin as much as they trust Zync itself.

A standard plugin may contribute:

- workspace pane kinds;
- dashboard cards;
- commands and contextual actions;
- status items and notifications;
- sidebar and settings sections;
- file viewers and editors;
- terminal and SSH workflows;
- themes and icon packs;
- connection, tunnel, snippet, and automation integrations;
- app-wide services exposed through stable Zync APIs.

Broad capability does **not** mean unrestricted access. Plugins compose approved Zync APIs and isolated UI surfaces. They do not receive the host DOM, arbitrary native IPC, vault plaintext, or ambient access to the user's machine.

The architecture must remain useful for small local plugins, safe enough for a public marketplace, enforceable by organizations, and replaceable at individual layers as the runtime matures.

---

## 2. Non-negotiable invariants

1. **Default deny.** A plugin receives only its declared and granted capabilities.
2. **The native host enforces authority.** Frontend checks improve UX but are never the final security boundary.
3. **Identity is host-assigned.** Plugin messages cannot choose or spoof their publisher, plugin id, grant, pane owner, or connection scope.
4. **No ambient authority.** Files, network destinations, connections, and workspace resources are passed as scoped handles, not discovered globally.
5. **No raw vault secrets.** Zync may perform an approved operation using a credential, but a standard plugin never reads the password, token, private key, or vault encryption material.
6. **Plugin UI is isolated.** Plugins render in opaque-origin frames or declarative host components; they never inject arbitrary HTML or CSS into the host document.
7. **Workspace layout stays kind-agnostic.** A plugin pane is normal pane content registered through the workspace kind registry. Layout operations never branch on plugin type.
8. **One content per pane.** Plugin content does not introduce an inner workspace tab bar.
9. **Deny wins.** User, workspace, team, security-revocation, and platform policy are merged with explicit deny taking precedence.
10. **Revocation is immediate.** Disabling a plugin or removing a grant cancels pending requests, closes its surfaces, and prevents new work without requiring a restart.
11. **Install is not execution.** Packages are verified and permissions reviewed before plugin code starts.
12. **Recovery is always available.** Zync can start with third-party plugins disabled, quarantine crash loops, and roll back a failed update.

---

## 3. Trust and extension tiers

Zync uses separate tiers because one sandbox cannot safely cover both a theme and arbitrary native code.

| Tier | Intended use | Execution | Distribution | Authority |
|---|---|---|---|---|
| **Declarative pack** | Themes, icon packs, syntax definitions, snippets | No executable code | Built-in, marketplace, or local | Validated assets and tokens only |
| **Standard plugin** | Panes, dashboard cards, commands, editors, app workflows | Sandboxed worker plus isolated UI frames | Marketplace or local developer mode | Brokered Zync capabilities only |
| **Privileged extension** | Hardware, native protocol, or OS integration that cannot use standard APIs | Separate restricted process or WASI runtime | Signed and explicitly reviewed | Narrow native RPC contract |
| **Built-in module** | Zync-owned core behavior | App process | Shipped with Zync | Internal authority, reviewed as application code |

Privileged extensions are not ordinary marketplace plugins. They require a separate install warning, publisher verification, platform-specific review, and operating-system sandbox where available. Loading arbitrary native libraries into the Zync process is not supported.

Trust labels describe provenance, not safety guarantees:

- **Built in** — packaged with the installed Zync release.
- **Verified publisher** — publisher identity and package signatures are verified.
- **Community** — signed package from a registered but unverified publisher.
- **Local development** — unsigned local folder or archive installed through Developer Mode.
- **Blocked or revoked** — rejected by local or marketplace security policy.

---

## 4. High-level architecture

```text
Package / marketplace metadata
        |
        v
Package verifier ----> Publisher trust + revocation store
        |
        v
Installed plugin registry ----> Permission grants + organization policy
        |
        v
Plugin supervisor
  |-- worker runtime (logic; no DOM; direct network blocked)
  |-- UI frame runtime (opaque origin; strict CSP)
  `-- future isolated process / WASI runner
        |
        v
Typed plugin API broker
        |
        v
Native policy engine (identity + capability + scope + rate + audit)
        |
        +-- workspace service
        +-- terminal / SSH service
        +-- filesystem service
        +-- network service
        +-- connection / tunnel / snippet services
        +-- namespaced storage
        `-- credential operation broker (never secret export)
```

The runtime and policy engine are separate interfaces. This lets Zync replace Web Workers with a stronger runner later without redesigning plugin APIs or permissions.

### 4.1 Request envelope

Every broker request is created by the trusted host, not by plugin-provided fields:

```ts
interface PluginRequestEnvelope<T> {
  requestId: string;
  runtimeInstanceId: string;
  pluginId: string;
  publisherId: string | null;
  packageDigest: string;
  capability: string;
  grantToken: string;
  workspaceId?: string;
  connectionId?: string;
  deadlineMs: number;
  payload: T;
}
```

The native broker verifies that the runtime instance is alive, the token belongs to that exact package digest, the capability is granted for the requested scope, and the request is within its limits. Unknown fields and malformed messages are rejected.

---

## 5. Plugin package

The distributable format is a deterministic `.zync-plugin` archive:

```text
manifest.json
dist/worker.js                 # optional for executable plugins
ui/<surface>/index.html        # optional isolated UI entries
assets/                        # icons and packaged assets
integrity.json                 # digest of every packaged file
signature.json                 # publisher signature over identity + manifest + integrity root
LICENSE
README.md
```

There are no install scripts, post-install scripts, executable native libraries, dependency downloads, or runtime package-manager commands in a standard plugin.

### 5.1 Manifest v2

```json
{
  "manifestVersion": 2,
  "id": "dev.example.pm2-monitor",
  "name": "PM2 Monitor",
  "version": "2.0.0",
  "description": "Monitor PM2 processes on approved connections.",
  "publisher": "dev.example",
  "license": "MIT",
  "homepage": "https://example.dev/pm2-monitor",
  "support": "https://example.dev/pm2-monitor/support",
  "privacyPolicy": "https://example.dev/privacy",
  "engines": {
    "zync": ">=3.0.0 <4",
    "pluginApi": "^2.0"
  },
  "runtime": {
    "entry": "dist/worker.js"
  },
  "contributes": {
    "commands": [
      { "id": "pm2.refresh", "title": "PM2: Refresh Processes" }
    ],
    "paneKinds": [
      { "id": "pm2.monitor", "title": "PM2 Monitor", "entry": "ui/monitor/index.html", "allowMultiple": true }
    ],
    "dashboardCards": [
      { "id": "pm2.summary", "title": "PM2 Summary", "entry": "ui/summary/index.html" }
    ]
  },
  "permissions": {
    "required": [
      { "id": "ui.pane.register", "reason": "Display the process monitor." },
      { "id": "connection.metadata.read", "scope": "selected", "reason": "Show the selected host name." }
    ],
    "optional": [
      { "id": "terminal.command.execute", "scope": "selected", "reason": "Run PM2 status and control commands." },
      { "id": "network.fetch", "hosts": ["api.example.dev"], "reason": "Check plugin service status." }
    ]
  }
}
```

Unknown manifest versions fail closed. Unknown contribution types or required permissions prevent activation; unknown optional permissions remain denied.

### 5.2 Installation validation

Before installation Zync must:

1. download to a temporary location with HTTPS, redirect, time, and byte limits;
2. verify registry metadata, expected package digest, integrity table, and publisher signature;
3. reject absolute paths, parent traversal, links, device files, duplicate normalized paths, and platform-conflicting names;
4. enforce compressed size, expanded size, file count, path length, and per-file limits;
5. parse and validate the manifest before copying executable content;
6. display publisher, trust, source, required permissions, optional permissions, and permission reasons;
7. stage the package without executing it;
8. atomically activate it only after approval;
9. keep the previous healthy version until the new version passes its activation check.

An interrupted install leaves either the previous version or no version, never a partially installed plugin.

---

## 6. Contribution model

Plugins extend registered slots rather than modifying the host DOM or internal stores.

| Contribution | User-facing result | Runtime rule |
|---|---|---|
| `paneKinds` | Content that opens and splits like Files or a shell | Normal workspace pane content; supports instances and persistence |
| `dashboardCards` | A card on a Zync dashboard | Isolated frame or declarative component schema |
| `commands` | Command palette and shortcut action | Registered id; handler runs in plugin runtime |
| `menus` | Contextual command placement | References a registered command and a constrained context expression |
| `statusItems` | Compact status information | Text/icon/action limits; no arbitrary host HTML |
| `sidebarSections` | App-wide navigation entry | Host-owned row; opens a registered surface |
| `settings` | Plugin configuration | Schema-driven controls by default; isolated custom UI when needed |
| `editors` / `viewers` | File content provider | Opaque-origin frame; document handle instead of filesystem path authority |
| `connectionActions` | Host-related workflow | Selected connection handle only |
| `tunnelProviders` | Additional tunnel workflow | Typed tunnel API; no direct tunnel store mutation |
| `themes` / `iconPacks` | Appearance resources | Declarative pack; validated tokens/assets only |
| `backgroundServices` | Event-driven app workflow | Explicit events, quotas, and lifecycle; no permanent busy loop |

“Widget” is a developer concept for a small contributed surface. Zync UI should use the product-specific name, such as **dashboard card**, **status item**, or **pane**, rather than presenting a second generic layout vocabulary.

### 6.1 Workspace pane contract

- Plugins register a pane kind; they never manipulate `paneLayouts` directly.
- Each pane instance receives a host-generated `instanceId` and namespaced state store.
- `allowMultiple` is manifest data, not a layout code branch.
- Split, dock, drag, focus, close, unsplit, restore, and drop targeting remain shared container operations.
- A plugin pane can be used without a shell.
- Splitting a plugin pane creates an independent instance using the kind's declared clone policy.
- Persistence stores `kindId`, `pluginId`, `instanceId`, and versioned serializable state—not HTML or runtime objects.
- If a plugin is missing or disabled, the layout shows a recoverable placeholder with remove, reinstall, and retry actions.

### 6.2 App-wide contributions

App-wide does not mean unrestricted. A plugin may register commands, settings, navigation, notifications, background event handlers, and approved service providers. It cannot replace security dialogs, intercept unrelated keystrokes, read every store, alter updater behavior, impersonate core UI, or draw over permission prompts.

Zync-owned chrome remains visually identifiable. Permission and credential dialogs are always rendered by the host outside plugin frames.

---

## 7. Permission system

### 7.1 Permission shape

A permission consists of:

```text
capability + operation + resource scope + lifetime + constraints
```

Examples:

```text
filesystem.pluginData.read   scope=plugin                  lifetime=installed
filesystem.external.read     scope=user-selected-folder    lifetime=workspace
connection.metadata.read     scope=selected-connections    lifetime=workspace
terminal.command.execute     scope=selected-connection     lifetime=once
network.fetch                scope=api.example.dev          lifetime=installed
clipboard.read               scope=foreground              lifetime=once
```

### 7.2 Permission risk classes

| Class | Examples | Consent behavior |
|---|---|---|
| **Declarative** | Register pane kind, command metadata, theme tokens | Validated at install; no recurring prompt |
| **Low** | Namespaced settings/storage, host theme values | Shown in details; granted with enablement |
| **Personal data** | Connection metadata, filenames, selected document content | Install or contextual scope approval |
| **System-changing** | Write selected files, create tunnels, change settings | Explicit grant; visible activity and revocation |
| **Command execution** | Send terminal input, execute SSH command | Exact target/action confirmation unless a narrow durable grant exists |
| **High-risk transient** | Clipboard read, local-network access, external app launch | Foreground user gesture and once/session consent |
| **Forbidden for standard plugins** | Vault secret export, host DOM access, arbitrary native IPC/code, updater control | Never granted |

### 7.3 Grant lifetimes

Users can grant supported permissions:

- once;
- for this session;
- for this workspace;
- for selected connections or folders;
- while the plugin is installed.

Not every lifetime is offered for every permission. High-risk permissions default to the shortest useful lifetime. “Always allow” is never preselected.

### 7.4 Required and optional permissions

- Required permissions are reviewed before activation. Rejecting one keeps the plugin disabled.
- Optional permissions are requested only when the related feature is used.
- Permission reasons are publisher text, visually separated from Zync's own risk explanation.
- An update that adds or broadens permissions is staged but not activated until approved.
- Removing a permission from a new version deletes the obsolete grant.

### 7.5 Policy precedence

Effective authority is the intersection of:

```text
platform support
AND package declaration
AND marketplace security state
AND organization policy
AND user grant
AND workspace/resource scope
AND current runtime context
```

Any explicit deny wins. A plugin cannot request around an organization restriction by renaming a capability or using a lower-level API.

---

## 8. Safety barriers by subsystem

### 8.1 Filesystem

- Every plugin receives a private data directory with quota and atomic writes.
- External access starts with a host file/folder picker and returns an opaque handle.
- Paths are canonicalized after every creation or rename boundary.
- Symlinks, junctions, hard links, alternate data streams, case folding, and Windows device names are handled explicitly.
- Reads and writes are constrained to the granted handle and operation.
- Document providers receive document content or a document handle, not ambient filesystem authority.
- Sensitive Zync directories, vault files, SSH material, browser profiles, and OS credential stores are always denied to standard plugins.

### 8.2 Network

- Direct `fetch`, WebSocket, `EventSource`, DNS, and dynamic script import are blocked in plugin runtimes.
- Requests use a native network broker with scheme, hostname, port, method, redirect, timeout, request-size, and response-size policy.
- Domain grants are exact or narrowly wildcarded and are visible to users.
- Redirect targets and resolved addresses are revalidated.
- Loopback, private, link-local, multicast, Unix sockets, and cloud metadata endpoints are denied by default to prevent SSRF.
- A separately warned `network.local` permission may allow explicit local destinations when the product use case requires it.
- Zync authentication cookies, device credentials, and host headers are never attached automatically.

### 8.3 Terminal and SSH

- Prefer typed operations over shell text where Zync owns the operation.
- Raw command execution requires the target connection, exact command preview, and suitable grant.
- Durable grants are limited by plugin, connection set, and command template—not “all commands everywhere.”
- Arguments are separated from command templates where possible.
- Command output has byte/time limits and is returned only to the requesting plugin instance.
- Terminal scrollback, environment variables, cwd, selection, and input are separate permissions.
- Plugins cannot suppress Zync safety prompts or mark their own commands as trusted.

### 8.4 Vault and credentials

Standard plugins never receive plaintext vault values.

Allowed future patterns are brokered capabilities such as:

- authenticate an approved connection;
- sign a challenge with a selected SSH identity;
- attach a short-lived authorization header to an approved domain;
- store an opaque plugin credential through host-owned UI;
- test whether a named credential reference is available.

The plugin receives success, failure, or a scoped opaque reference. It does not receive the underlying secret. Credential consent is rendered by Zync and records plugin, publisher, operation, resource, and lifetime.

### 8.5 UI frames

- Use an opaque-origin iframe with only the minimum sandbox tokens.
- Apply a generated CSP with `default-src 'none'`; allow packaged images/fonts/styles and the broker bootstrap explicitly.
- Do not grant `allow-same-origin`, top navigation, downloads, popups, forms, pointer lock, or storage unless a reviewed surface requires it.
- Use structured-clone messages validated against versioned schemas.
- Require `event.source`, runtime instance, frame generation, session nonce, message size, and request id to match.
- Host-to-frame messages target the isolated frame and include no unrelated application state.
- Plugin content cannot cover, imitate, or position above host permission and security UI.

### 8.6 Availability and abuse limits

Each runtime has limits for:

- startup and request time;
- concurrent and queued requests;
- message and payload size;
- registered commands, surfaces, and listeners;
- notifications per time window;
- stored bytes and cache bytes;
- network bandwidth and response size;
- background wake frequency;
- repeated crashes and rejected requests.

Web Workers provide DOM separation and crash containment, not hard CPU or memory isolation. The supervisor must be able to terminate them. Resource-heavy or privileged workloads move to an out-of-process runner with operating-system limits.

---

## 9. Runtime lifecycle and supervisor

```text
discovered
  -> verified
  -> awaiting-permission
  -> staged
  -> starting
  -> active
  -> suspended | disabled | quarantined | incompatible | revoked
  -> stopped
```

The supervisor owns:

- one runtime identity per activated package version;
- worker and frame creation;
- capability token issuance and revocation;
- subscriptions and surface registrations;
- request cancellation;
- heartbeat, responsiveness, and crash state;
- cleanup on disable, update, workspace close, and app shutdown;
- activation timing and local diagnostics;
- automatic quarantine after a bounded crash loop.

Plugins activate lazily from declared events such as opening their pane, invoking their command, or a permitted workspace event. Merely installing a plugin does not start it at every app launch.

Background services declare activation events and cannot request an unbounded wildcard such as “every app event.”

---

## 10. Publisher identity and marketplace

### 10.1 Publisher record

Each publisher has a stable id and public profile containing:

- display name and verified domain;
- support and security contact;
- privacy policy;
- source repository where applicable;
- signing public keys and rotation history;
- verification status and date;
- published plugins and ownership transfers;
- security advisories, revocations, and policy actions.

Plugin ids are namespaced to a publisher. Ownership transfer is an explicit signed operation with a visible history; a new publisher cannot silently take over an abandoned id.

### 10.2 Package signing

- The publisher signs the plugin id, version, manifest digest, integrity root, and release timestamp.
- Marketplace metadata independently binds that digest to the approved listing and version.
- Zync verifies both before install and update.
- Signing keys support offline root keys, rotating release keys, expiry, and revocation.
- A compromised package or publisher key can be blocked by signed revocation metadata already cached by the client.

A signature proves origin and integrity. It does not prove that a plugin is safe, private, reliable, or endorsed by Zync.

The implemented package signature format is version 1:

- `integrity.json` contains `version: 1` and a path-to-`sha256:` map for every payload file except `integrity.json` and `signature.json` themselves;
- the integrity root hashes those entries in byte-sorted path order with the domain separator `zync-plugin-integrity-v1`;
- `signature.json` uses Ed25519 and binds publisher id, plugin id, plugin version, manifest digest, integrity root, and release timestamp;
- `keyId` is the SHA-256 fingerprint of the raw 32-byte public key;
- unknown fields and versions fail closed, and signed packages are reverified each time they load.

For now, a local package may remain unsigned and is labelled **Local development**. A valid local signature is labelled **Signed package**, with a separate warning that registry ownership has not yet verified the publisher. Marketplace acceptance will require a signature plus a matching key from trusted signed registry metadata; the public key embedded in a package is never sufficient for verified-publisher status.

Developers can manually exercise this flow with `npm run plugin:keygen`, `npm run plugin:sign`, and `npm run plugin:verify`. The signing command copies the source to a new output directory, refuses to overwrite existing output, and rejects publisher keys stored inside the source tree. Use the SDK basic starter at `packages/plugin-sdk/templates/basic` to build a local plugin before signing.

### 10.3 Registry resilience

Use signed, versioned registry metadata with separated root, targets, snapshot, and timestamp responsibilities. This protects against stale metadata, rollback, mix-and-match releases, and compromise of a single online key. Clients retain a last-known-good index and enforce metadata expiry without deleting already installed plugins.

Marketplace installation accepts only the signed download target and digest from registry metadata—not an arbitrary URL supplied by presentation data.

The implemented registry envelope contains a canonical `signed` payload and exactly one Ed25519 root signature. The payload binds each plugin release to its publisher, HTTPS download URL, package digest, publisher public key and fingerprint, and publisher-verification status. It also includes monotonically increasing `version`, `issuedAtMs`, and `expiresAtMs` fields. Zync rejects rollback below the highest version previously accepted on that device.

Release builds configure the native trust bootstrap with `ZYNC_PLUGIN_REGISTRY_URL` and one or more base64 raw Ed25519 public keys in `ZYNC_PLUGIN_REGISTRY_ROOT_KEYS`. Keys are comma-separated during a staged root rotation. The singular `ZYNC_PLUGIN_REGISTRY_ROOT_KEY` remains a compatibility fallback. If the URL or trust roots are absent, the trusted registry is unavailable; the existing unsigned GitHub catalog is shown only as **Legacy catalog · publisher not verified**, never receives a verified badge, and cannot be installed.

Registry publishing uses the same verifier format as the desktop app:

```powershell
npm run plugin:registry-keygen -- --out C:\safe\registry-root-key.json
npm run plugin:registry-build -- --releases .\registry-releases.json --key C:\safe\registry-root-key.json --version 1 --expires-at 2026-12-31T00:00:00Z --out .\dist\registry.json
npm run plugin:registry-verify -- --registry .\dist\registry.json --key C:\safe\registry-root-key.json
```

The release descriptor contains only publication choices; identity and integrity values are derived from the verified signed package so they cannot drift from the package bytes:

Each release may set `"channel": "stable"` (the default) or `"channel": "beta"`. Stable versions must be ordinary semantic versions; beta versions must use a prerelease suffix such as `1.1.0-beta.2`. Publish both channels as releases of the same plugin id in one signed registry. The marketplace shows one plugin listing, defaults to stable, and lets users opt into beta per plugin. Beta opt-in is stored on this device and checked natively before installing a beta. Turning it off stops future beta updates without silently downgrading an installed beta; a newer stable version or an explicit retained-version rollback is required to leave that installed build. Local demo sources and a packaging helper are kept in the sibling `zync-plugin-channel-examples/` folder outside this repository.

```json
{
  "releases": [
    {
      "packagePath": "./dist/dev.example.my-plugin-signed",
      "downloadUrl": "https://plugins.example.com/dev.example.my-plugin/1.0.0",
      "publisherVerified": false
    }
  ],
  "revocations": [
    {
      "kind": "publisherKey",
      "publisher": "dev.example",
      "keyId": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "revokedAtMs": 1800000000000,
      "reason": "Publisher rotated a compromised release key."
    },
    {
      "kind": "pluginRelease",
      "packagePath": "./dist/dev.example.my-plugin-signed",
      "revokedAtMs": 1800000000000,
      "reason": "This exact release contains a critical vulnerability."
    }
  ]
}
```

Keep `registry-root-key.json` offline and backed up. Never put it in the repository or CI. Configure releases with the public `ZYNC_PLUGIN_REGISTRY_ROOT_KEYS`, increase the registry version for every publication, use a short expiry appropriate to the hosting operation, and upload the generated `registry.json` only after `plugin:registry-verify` succeeds. Follow the operations runbook for two-person recovery drills and staged root rotation.

Published metadata can be checked without the private root key using `npm run plugin:registry-check`. The manual **Plugin registry staging** workflow verifies a protected staging environment, and the desktop **Release** workflow validates any configured production registry before creating a draft. URL and roots must be configured together; setting `ZYNC_PLUGIN_REGISTRY_REQUIRED=true` additionally prohibits marketplace-disabled releases. A configured registry must be reachable, correctly signed, at or above its version floor, no larger than 2 MiB, and valid for at least another 24 hours. Redirects are followed only while every hop remains HTTPS. See [PLUGIN_REGISTRY_OPERATIONS.md](./PLUGIN_REGISTRY_OPERATIONS.md) for environment setup and the manual install/revocation smoke checklist.

Marketplace installation is monotonic. A lower package version is rejected, and an existing version cannot be replaced by different bytes. The explicit retained-version rollback action remains the audited recovery path.

Publisher-key rotation does not change plugin ownership: sign the next package with the publisher's new key and publish that release in a higher registry version. If the old key is compromised, add a `publisherKey` revocation in the same or an earlier registry publication. Use `pluginRelease` when only one exact signed package must be blocked. Zync permanently unions accepted revocations into its local trust state, rejects installs and updates for revoked entries, and prevents an installed revoked package from being enabled again. Removing a revocation from a later registry does not restore trust.

### 10.4 Review pipeline

Marketplace submission should run:

- schema, compatibility, and permission checks;
- archive traversal and resource-limit tests;
- dependency and known-vulnerability scanning;
- secret and suspicious endpoint scanning;
- static analysis for forbidden globals and obfuscation policy;
- sandboxed activation and behavioral smoke tests;
- UI spoofing and accessibility checks;
- malware scanning;
- license, privacy, support, and data-use review;
- reproducible-build or source-provenance checks for elevated verification.

Automated review supplements, but does not replace, publisher accountability and runtime containment.

### 10.5 Updates, rollback, and revocation

1. Download and verify without touching the active version.
2. Show changelog, publisher changes, and permission diff.
3. Keep new versions disabled while new permissions await approval.
4. Start with a bounded health check.
5. Atomically switch the active version.
6. Retain at least one last-known-good version within a storage budget.
7. Roll back automatically after activation failure or repeated startup crashes.
8. Apply critical revocation by preventing new activation and explaining recovery options.

Revocation must not silently delete user data. Users can export namespaced non-secret plugin data when safe.

The update review, first activation rollback boundary, and last-known-good rollback control are implemented. Zync snapshots the installed version, package digest, permission declarations, and granted optional permissions when staging an update. The review highlights new and boundary-changed access, lists removed access, retains only unchanged optional grants, and rejects installation if the installed package changes before confirmation. The prior package and approval remain recoverable until the replacement Worker acknowledges readiness; a startup exception, timeout, or interrupted transaction restores the prior version automatically. A healthy update retains one verified previous version, shown in plugin details. Restoring it keeps plugin-private data, restores its exact reviewed grant, health-checks its Worker, and retains the replaced version so the operation can be reversed. Three runtime failures within one minute trigger one automatic rollback attempt for that exact active version. The retained Worker must pass the activation check; otherwise Zync restores the newer package and leaves the failing runtime stopped. Multi-version history remains future work.

---

## 11. Plugin management experience

### 11.1 Install review

The install screen shows:

- plugin and publisher identity;
- trust tier and signature status;
- source, version, compatibility, and package size;
- required and optional permissions grouped by risk;
- exact network domains and requested resource scopes;
- data collection and privacy links;
- whether the plugin runs in the background;
- whether it is local, community, verified, privileged, or built in.

### 11.2 Installed plugin details

Each plugin details page includes:

- enabled, disabled, incompatible, quarantined, or revoked state;
- current and last-known-good version;
- source and publisher history;
- every grant with scope and lifetime;
- revoke/change permission controls;
- storage and cache usage;
- contributed panes, commands, cards, editors, and services;
- last activation, resource usage summary, crashes, and denied operations;
- privacy-safe logs and exportable diagnostics;
- reload, update, rollback, disable, and uninstall actions;
- separate **Uninstall** and **Uninstall and delete data** actions.

### 11.3 Developer Mode

Developer Mode is explicit, persisted, default-off, and reversible. It permits local folders and unsigned archives, clearly labels their surfaces, disables automatic marketplace updates for them, and shows that local code has not been verified by Zync. Turning it off stops local and legacy packages and revokes their active runtime identities; signed marketplace packages are unaffected.

Development tools include:

- manifest validation;
- permission simulator;
- local reload;
- structured logs;
- API version inspector;
- mock workspace/connection/document handles;
- packaging, integrity, and signing commands;
- a test harness with denied-capability and timeout cases.

Developer Mode does not bypass the standard plugin sandbox. Testing a privileged extension uses a separate signed development flow.

---

## 12. Storage, sync, privacy, and teams

### 12.1 Namespaced storage

Plugins receive separate stores for:

- device-local settings;
- workspace-local state;
- per-instance pane state;
- cache data with eviction semantics;
- optional encrypted sync data.

Storage keys are namespaced by publisher, plugin id, major data schema, workspace, and optional instance id. Plugins cannot enumerate other namespaces.

### 12.2 Sync

Plugin sync is opt-in. A plugin declares a versioned, bounded data schema; users choose whether it syncs. Synced plugin data uses Zync's encrypted sync infrastructure and remains separate from executable packages and permission grants.

Permissions do not sync automatically. A second device reviews permissions locally because its paths, connections, organization policy, and risk context differ.

### 12.3 Privacy

- Marketplace analytics are separate from plugin-produced telemetry.
- Plugins cannot use Zync analytics as a covert transport.
- Network-capable plugins disclose their destinations and data purpose.
- Zync logs metadata needed for security and reliability, not terminal output, file content, secrets, or network bodies by default.
- Diagnostic export redacts paths, hostnames, usernames, commands, tokens, and user content unless the user explicitly includes them.

### 12.4 Team policy

Team or organization policy may:

- allow only built-in or approved publisher tiers;
- allowlist or block plugin ids and versions;
- deny capability families such as command execution or external network;
- constrain domains, connections, folders, and background execution;
- pin versions or update channels;
- require marketplace signatures and verified publishers;
- disable Developer Mode and privileged extensions;
- centrally revoke a package while preserving local user data.

Organization policy cannot silently grant a user-private resource to a plugin; it can constrain grants, not manufacture consent or secret access.

---

## 13. API design and compatibility

The plugin API is generated from versioned schemas and exposed through a small SDK. Internal React stores, DOM events, and raw Tauri command names are not public plugin APIs.

Compatibility fields are distinct:

- `manifestVersion` — package schema;
- `engines.zync` — compatible app versions;
- `engines.pluginApi` — broker API contract;
- contribution schema version;
- plugin-owned persisted state schema version.

Rules:

- Capability discovery is explicit; plugins can test optional API availability.
- Minor API releases are additive.
- Breaking changes require a new major API and a documented compatibility window.
- Deprecated APIs produce developer diagnostics before removal.
- Zync adapts old persisted contribution state through bounded migrations; plugin code does not run during package installation.
- Public types and errors use stable codes rather than UI strings.
- All async requests support cancellation, deadlines, and deterministic cleanup.

---

## 14. Security and reliability testing

The plugin platform requires automated tests at every boundary.

### Package corpus

- path traversal and absolute archive entries;
- symlink/junction/hard-link escape;
- zip bombs and extreme compression ratios;
- oversized manifest, script, HTML, and asset files;
- duplicate case-folded paths and Windows device names;
- corrupted integrity tables and signatures;
- rollback, expired metadata, revoked keys, and plugin-id takeover attempts.

### Broker and permission tests

- undeclared, denied, expired, and wrong-scope permissions;
- forged plugin id, runtime id, resource handle, or grant token;
- stale worker/frame responses after reload;
- request flood, oversized messages, timeout, cancellation, and quota exhaustion;
- redirect, DNS rebinding, loopback, private-network, and metadata endpoint denial;
- path race and link replacement between validation and use;
- permission expansion during update;
- organization deny overriding user allow.

### UI isolation tests

- parent DOM and storage access denial;
- top navigation, popup, download, form, and custom-protocol denial;
- CSP escape and external script/network denial;
- fake permission-dialog and clickjacking attempts;
- malformed postMessage payloads and response spoofing;
- plugin surface cleanup after disable, crash, update, and workspace close.

### Product regression tests

- plugin pane open, split, self-split, dock, close, unsplit, restore, and missing-plugin placeholder;
- independent state for multiple pane instances;
- live disable/reload without unrelated pane or terminal changes;
- update rollback and safe-mode startup;
- uninstall with keep-data and delete-data choices;
- accessibility, keyboard navigation, reduced motion, and theme contrast.

Security-sensitive parsers and policy evaluators should use fuzzing and property tests in addition to example tests.

---

## 15. Migration from the current runtime

The current Web Worker and sandboxed-frame implementation is a useful compatibility base, but it is not yet the complete boundary described above.

### Phase 0 — freeze and inventory

- Document every existing worker, panel, editor, filesystem, terminal, SSH, theme, window, and marketplace API.
- Stop adding unscoped bridge operations.
- Add security regression tests around current behavior.
- Mark current executable plugins as **Legacy access** in management UI and require explicit Developer Mode before they can run. *(Implemented.)*

### Phase 1 — manifest v2 and central policy

- Introduce manifest schema, contribution declarations, engine compatibility, permissions, and publisher fields.
- Add installed package registry and grant store.
- Route Manifest v2 plugin messages through one typed frontend broker and one native policy engine. *(Implemented; legacy compatibility remains explicitly separated.)*
- Bind each request to host-owned runtime identity and package digest.

### Phase 2 — close ambient access

- Replace arbitrary filesystem paths with private storage and user-selected handles.
- Apply a restrictive app CSP and plugin-frame CSP.
- Narrow the asset protocol from the global filesystem to explicit app/plugin asset roots.
- Block direct worker and frame networking; add the native network broker.
- Remove arbitrary external plugin windows or rebuild them as isolated, capability-limited plugin surfaces.

### Phase 3 — safe packages and marketplace

- Add bounded extraction, deterministic packages, integrity manifests, signatures, publisher identities, and signed registry metadata.
- Add permission review and update permission diff.
- Make installs and updates transactional with last-known-good rollback.

### Phase 4 — supervisor and management

- Add lazy activation, live disable/reload, quotas, health state, crash quarantine, safe mode, diagnostics, and data controls.
- Add plugin details, grants, publisher, source, storage, logs, rollback, and security-state UI.

### Phase 5 — ecosystem SDK

- The beta authoring package, pre-signing validator, starter template, release checklist, and package-boundary/type tests are in `packages/plugin-sdk`. Version `2.0.0-beta.1` is published to npm under `@zync-sh/plugin-sdk@beta`; it is not a substitute for native manifest validation. Run `npm run plugin:validate -- <plugin-directory>` after building and before signing; the CLI bundled in the SDK uses `zync-plugin validate <plugin-directory> [--zync-version <version>]`. `npm run sdk:release-check` runs the automatic publication gate. A protected staging-registry desktop smoke test and external security review are still required before a public stable release.
- Publish typed SDK, schemas, packaging/signing CLI, templates, test host, documentation, compatibility guarantees, and submission checks.
- Migrate official plugins first and use them as conformance fixtures.
- Keep legacy mode disabled by default, then remove it after a published compatibility window. *(Default-off enforcement is implemented; removal remains.)*

### Soon after the strong beta — `zync://` deep links

- Register a real operating-system `zync://` URL scheme after the signed marketplace and permission lifecycle are stable.
- Start with a small allowlist of declarative routes, such as opening a marketplace listing, an installed plugin, a saved workspace, or a saved connection by opaque identifier.
- Parse and validate every route natively; URLs must never carry passwords, tokens, raw shell commands, arbitrary filesystem paths, plugin download URLs, or untrusted permission grants.
- Show a Zync-owned confirmation screen before installation, connection, import, command execution, or any other meaningful action. Receiving a deep link alone never authorizes the action.
- Keep internal Tauri events such as `zync://file-drop` separate from the public deep-link contract and rename those events if needed to avoid confusing the two namespaces.

### Phase 6 — privileged runner, only when required

- Introduce an out-of-process or WASI runner with OS resource limits.
- Keep its RPC surface capability-based and smaller than the standard API.
- Require signed, reviewed packages and a separate user/admin approval path.

---

## 16. Initial implementation map

Suggested module boundaries:

```text
src/features/plugins/
  api/                  # generated public SDK types and message schemas
  broker/               # frontend runtime association; no policy authority
  contributions/        # pane, command, card, editor, menu registries
  runtime/              # worker/frame adapters and supervisor client
  management/           # install review, details, permissions, health

src-tauri/src/plugins/
  manifest.rs
  package.rs
  integrity.rs
  publisher.rs
  registry.rs
  grants.rs
  policy.rs
  broker.rs
  supervisor.rs
  storage.rs
  network.rs
  filesystem.rs
  audit.rs
```

The existing `PluginContext.tsx` should become composition and compatibility glue, not the permanent security broker. Sensitive decisions and resource resolution belong in the native plugin subsystem.

---

## 17. Definition of done for a public marketplace

Zync may describe standard plugins as sandboxed when all of these are true:

- executable plugins declare versioned permissions and contributions;
- native code enforces plugin identity, permission, scope, quota, and revocation;
- plugin runtimes have no direct filesystem, network, host DOM, raw IPC, or secret access;
- package install/update verifies integrity and publisher provenance with bounded extraction;
- UI frames use strict sandboxing, CSP, schema validation, and host-owned security UI;
- updates show permission changes and support atomic rollback;
- users can inspect and revoke every meaningful grant;
- crash quarantine and third-party-plugin safe mode work before normal workspace startup;
- official plugins pass conformance, malicious-package, and permission-bypass suites;
- the legacy unrestricted bridge is disabled for marketplace packages.

Until then, Zync should accurately describe current executable plugins as isolated from the host UI but trusted for the capabilities exposed by the compatibility bridge.

### Plugin pane shortcut boundary

`zync:shortcut` messages are untrusted plugin requests, not proof of a physical keypress. The host validates the source/focus, matches its current bindings, and independently authorizes the command against a restricted allowlist. Only opening host-controlled settings/palette/AI UI and tab/pane focus navigation are allowed. Closing tabs, changing saved settings, zoom IPC, connection creation, terminal input, and Files/Tunnels/Snippets/Dashboard actions are excluded. Opening a host palette does not authorize a subsequent privileged action; that selection remains host-controlled. The injected keyboard shim's `isTrusted` check is usability filtering, not a security boundary.
