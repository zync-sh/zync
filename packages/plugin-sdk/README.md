# Zync plugin SDK (beta)

Public authoring types for Manifest v2 plugins. This package lives in the Zync repository but has its own npm version and release lifecycle.

Install the prerelease as a development dependency:

```sh
npm install --save-dev @zync-sh/plugin-sdk@beta
```

This first npm release is a beta. npm also initialized its `latest` tag to this version, so use `@beta` explicitly until a stable release is promoted.

To try the local package from another project, install it by path:

```sh
npm install --save-dev /path/to/zync/packages/plugin-sdk
```

Zync supplies the `zync` object when it starts a plugin worker or pane. Do not bundle an SDK runtime into the plugin.

## Manifest

`defineManifest` gives TypeScript a Manifest v2 contract and returns the same object. It does **not** validate a package or grant permissions; the Zync host is the final authority.

```ts
import { defineManifest } from '@zync-sh/plugin-sdk';

export default defineManifest({
  manifestVersion: 2,
  id: 'com.example.hello',
  name: 'Hello',
  version: '1.0.0',
  publisher: 'com.example',
  engines: { zync: '>=2.32.2', pluginApi: '^2.0.0' },
  runtime: { entry: 'worker.js' },
  contributes: {
    commands: [{ id: 'hello.say-hi', title: 'Say hi' }],
  },
  permissions: {
    required: [{ id: 'ui.commands.register', reason: 'Add the command to Zync.' }],
  },
});
```

Write the resulting object to `manifest.json` during your build. Zync installs the JSON and the built plugin files, not the TypeScript source.

## Validate before signing

Run the packaged CLI against the **built plugin directory** (the one containing `manifest.json` and its referenced assets):

```sh
npx zync-plugin validate ./dist/my-plugin --zync-version 2.32.2
```

In this repository, the same check is available as `npm run plugin:validate -- ./examples/plugins/manifest-v2-demo`. For programmatic checks, import `validateManifest` or `validatePackageDirectory` from `@zync-sh/plugin-sdk/validate`. Validation returns `{ valid, issues }`; warnings do not fail the check.

The preflight checks Manifest v2 fields, publisher namespace, semantic plugin version, contribution/permission declarations, known permissions, network host declarations, referenced files, basic package limits, and plugin API compatibility. Pass `--zync-version` to check compatibility with a specific app build; without it, the Zync range is syntax-checked only. Unknown optional permissions produce warnings because the host denies them until supported. The preflight does **not** validate signatures, inspect executable behavior, or replace native install-time validation. The signing tool and native host retain their own package and security checks.

The [basic starter template](templates/basic/README.md) is included in this package. It builds a minimal worker and isolated pane, then validates the output. See [RELEASE.md](RELEASE.md) for versioning and the publication checklist.

## Host-provided APIs

For a worker:

```ts
import type { ZyncWorkerApi } from '@zync-sh/plugin-sdk/worker';

declare const zync: ZyncWorkerApi;

zync.on('ready', async () => {
  await zync.commands.register('hello.say-hi', 'Say hi', async () => {
    await zync.ui.notify({ message: 'Hello from the plugin' });
  });
});
```

For an isolated pane, use `import type { ZyncPaneApi } from '@zync-sh/plugin-sdk/pane'` and declare `window.zync` with that type in your pane source. Panes can exchange messages with their worker; they do not get the worker API, host DOM, or direct network access.

The typed worker interface covers the Manifest v2 broker APIs only. Legacy plugin APIs are deliberately absent. Every host operation is still checked against the installed manifest, current grant, runtime identity, and applicable scope. The SDK version does not replace the manifest's `engines.pluginApi` compatibility declaration.

See the [plugin architecture](https://github.com/zync-sh/zync/blob/main/docs/PLUGINS.md) and [Manifest v2 demo](https://github.com/zync-sh/zync/tree/main/examples/plugins/manifest-v2-demo) for package format, permissions, signing, and manual testing.
