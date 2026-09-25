import { defineManifest, type ManifestV2 } from '@zync-sh/plugin-sdk';
import type { ZyncWorkerApi } from '@zync-sh/plugin-sdk/worker';
import type { ZyncPaneApi } from '@zync-sh/plugin-sdk/pane';
import { validateManifest, type ValidationIssue } from '@zync-sh/plugin-sdk/validate';

const manifest: ManifestV2 = defineManifest({
  manifestVersion: 2,
  id: 'com.example.hello',
  name: 'Hello',
  version: '1.0.0',
  publisher: 'com.example',
  engines: { zync: '>=2.32.2', pluginApi: '^2.0.0' },
  runtime: { entry: 'worker.js' },
  contributes: {
    paneKinds: [{ id: 'hello.pane', title: 'Hello', entry: 'pane.html', allowMultiple: true }],
  },
  permissions: { required: [{ id: 'ui.pane.register', reason: 'Show a pane.' }] },
});

declare const worker: ZyncWorkerApi;
declare const pane: ZyncPaneApi;

worker.on('ready', async () => {
  await worker.panel.register(manifest.contributes?.paneKinds?.[0].id ?? 'hello.pane');
  const value: string | null = await worker.storage.get('key');
  if (value !== null) await worker.storage.set('key', value);
});

pane.pane.onMessage(message => pane.pane.postMessage(message));

const issue: ValidationIssue | undefined = validateManifest(manifest).issues[0];
if (issue) issue.severity satisfies 'error' | 'warning';

// @ts-expect-error legacy, unbrokered filesystem access is not part of Manifest v2
worker.fs.readFile('/etc/passwd');
