# Plugin Registry Operations

This runbook covers the production trust root for Zync's signed plugin registry. The private root key is an offline release authority, not an application secret. Desktop builds receive public keys only.

## Custody and recovery

- Generate the root key on an offline machine. Never copy the private key into this repository, GitHub Actions, the registry host, chat, logs, or issue trackers.
- Keep two encrypted backups on separate media and in separate physical locations. Record the key id and public key in the release log.
- Require two people for key recovery, registry signing, revocation publication, and destruction of retired key material.
- Every quarter, restore a backup on an offline disposable machine, verify a known registry fixture, record the result, and securely erase the restored copy.
- Losing every private-key copy means the current desktop trust root cannot publish new metadata. It does not justify bypassing signature checks.

## Publishing checklist

1. Build signed plugin packages and verify each package locally.
2. Use a registry version greater than every version previously published. Never reuse a version, including after a failed upload.
   Stable and beta releases share this registry version counter and trust root. Give beta releases prerelease semantic versions and mark their descriptor entries with `"channel": "beta"`; normal releases default to stable. Do not use a Zync build channel to select plugin releases.
3. Set a short, intentional expiry and include every cumulative revocation. Clients permanently retain accepted revocations.
4. Build `registry.json` on the offline signing machine and run `npm run plugin:registry-verify` before transfer.
5. Upload to a staging object, download it again, and verify the downloaded bytes before atomically promoting it to the HTTPS registry URL.
6. Confirm the endpoint does not redirect away from HTTPS and serves no more than 2 MiB.
7. Test a release build against the published metadata before announcing the registry version.
8. Archive the signed registry, input release descriptor, version, expiry, hashes, signer key id, reviewer names, and publication time. Do not archive the private key with release artifacts.

Before promoting a staged object, run the same live check used by release CI:

```powershell
npm run plugin:registry-check -- --url $env:ZYNC_PLUGIN_STAGING_REGISTRY_URL --root-keys $env:ZYNC_PLUGIN_STAGING_REGISTRY_ROOT_KEYS --minimum-version 1 --min-valid-for-hours 24
```

The check follows at most three HTTPS-only redirects, reads at most 2 MiB, verifies the root signature against the complete rotation bundle, enforces expiry and a version floor, and requires at least the requested validity window. It never needs the offline root private key.

## Staging release gate

Create a protected GitHub environment named `plugin-staging` with these public configuration values as environment variables (secrets are also accepted when repository policy requires them):

- `ZYNC_PLUGIN_STAGING_REGISTRY_URL`;
- `ZYNC_PLUGIN_STAGING_REGISTRY_ROOT_KEYS`.

Run **Plugin registry staging** manually with the minimum registry version being promoted. The workflow validates the live endpoint, signing tools, native trust rules, and frontend production build. After it passes, manually use a desktop build pointed at staging to install one release, reject one permission review, accept it on a second attempt, exercise its command and pane, and verify rollback or revocation with a higher registry version. Record the tested registry version and package digest in the release log.

The normal **Release** workflow separately checks the production endpoint before it creates a draft release. Configure `ZYNC_PLUGIN_REGISTRY_MIN_VERSION` whenever production must reject an older published registry, and set `ZYNC_PLUGIN_REGISTRY_REQUIRED=true` when every release must include the trusted marketplace. URL and roots must either both be absent (an intentionally marketplace-disabled build) or both be configured. Once required, a missing, expired, undersized-validity, wrongly signed, or unreachable registry blocks the desktop release.

Marketplace updates cannot downgrade an installed plugin or replace an existing semantic version with different bytes. Use Zync's retained-version rollback action for recovery.

## Planned root rotation

Zync accepts a comma-separated public-key bundle from `ZYNC_PLUGIN_REGISTRY_ROOT_KEYS`. Rotation is deliberately staged so old and new desktop versions remain usable.

1. Generate the new root offline and verify its backups.
2. Ship a desktop release whose trust bundle contains `oldPublicKey,newPublicKey`. Keep publishing with the old root while that release rolls out.
3. After the overlap release reaches the required adoption threshold, publish the next higher registry version signed by the new root.
4. Keep publishing refreshed, unexpired old-root metadata at the URL already baked into old clients. The overlap desktop release must use a new registry URL before that new URL begins serving metadata signed only by the new root.
5. Ship a later desktop release containing only `newPublicKey`.
6. Retire the old private key with a witnessed destruction record after the compatibility period.

Do not replace the CI public key and registry signature in one uncoordinated step. Clients that never received the overlap release will reject the new root, as intended.

## Suspected compromise

1. Stop marketplace publication and preserve logs and signed artifacts.
2. Determine whether the root key, a publisher key, or one exact plugin release is affected.
3. For a publisher key or release, publish a higher registry version with the matching cumulative revocation, signed by an uncompromised root.
4. For a root compromise, do not trust metadata signed after the suspected compromise time. Start the incident rotation path and ship a desktop trust update through the normal signed application release channel.
5. Notify users with affected plugin ids, versions, key ids, dates, and containment steps. Do not claim that package signatures prove plugin safety.
6. Complete a post-incident review before resuming publication.

## Release configuration

GitHub Actions needs:

- `ZYNC_PLUGIN_REGISTRY_URL`: the production HTTPS metadata URL;
- `ZYNC_PLUGIN_REGISTRY_ROOT_KEYS`: one public Ed25519 key, or `old,new` during rotation.

GitHub Actions also accepts the repository variables `ZYNC_PLUGIN_REGISTRY_MIN_VERSION` as the production version floor and `ZYNC_PLUGIN_REGISTRY_REQUIRED=true` to prohibit marketplace-disabled builds. The release check requires a configured registry to remain valid for at least 24 hours.

`ZYNC_PLUGIN_REGISTRY_ROOT_KEY` is accepted only as a compatibility fallback. Private registry or publisher keys must never be configured as repository secrets.
