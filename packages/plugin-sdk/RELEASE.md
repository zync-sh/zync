# SDK release policy

The npm package version and the Zync plugin API version are separate. `@zync-sh/plugin-sdk` may release documentation, types, or tooling fixes without changing the host API. A breaking host API requires a new `engines.pluginApi` major version and matching native/SDK support. Plugin packages continue to declare their own `version`, `engines.zync`, and `engines.pluginApi` ranges.

Manifest v2 engine ranges use semantic-version comparators such as `^2.0.0`, `>=2.32.2`, or `>=2.32.2, <3.0.0`. Avoid npm-only unions (`||`) and hyphen ranges; the native host is authoritative. Pre-release host versions require a matching pre-release comparator. When a plugin's engine range does not match the running host, Zync rejects install/activation or skips loading the installed plugin. A rollback to an incompatible retained version is rejected before replacing the active package.

Before an npm release:

1. Run `npm run sdk:release-check` from the Zync repository root. It checks type contracts, validator cases, the starter build, and the exact npm package contents.
2. Run the native plugin tests and the full agent regression suite.
3. Run `node check.mjs` in the sibling `zync-plugin-channel-examples` project to validate, sign, and verify stable and beta builds in a disposable registry.
4. Deploy those test builds to a protected HTTPS staging registry and manually verify marketplace listing, opt-in beta update, switch back to stable, permission review, and retained-version rollback in the desktop app. Record the tested Zync build, SDK package version, registry version, and results. Local signing tests do not substitute for this step.
5. Review the SDK tarball, dependency audit, license, documentation, and published provenance. Publish a beta tag first; promote to stable only after the staging and external-plugin smoke tests pass.

The automatic checks are not a security audit. Do not publish the package merely because they pass.
