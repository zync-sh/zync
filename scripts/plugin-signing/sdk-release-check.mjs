import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sdk = path.join(root, 'packages', 'plugin-sdk');
const metadata = JSON.parse(fs.readFileSync(path.join(sdk, 'package.json'), 'utf8'));
if (metadata.private || !metadata.name || !metadata.version || !metadata.bin?.['zync-plugin']) {
  throw new Error('Plugin SDK package metadata is not publishable');
}

for (const args of [
  [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(sdk, 'tsconfig.test.json')],
  [path.join(root, 'tests', 'pluginSdkValidator.test.mjs')],
  [path.join(root, 'tests', 'pluginSdkTemplate.test.mjs')],
  [path.join(root, 'tests', 'pluginSdkPackage.test.mjs')],
]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`SDK ${metadata.version} automatic release checks passed. Marketplace staging and independent review are required before stable promotion.`);
