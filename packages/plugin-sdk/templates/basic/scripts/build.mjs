import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import manifest from '../manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] ?? path.join(root, 'dist'));
if (output === root || !output.startsWith(`${root}${path.sep}`)) {
  throw new Error('Build output must be a directory inside the plugin project');
}
fs.mkdirSync(path.join(output, 'ui'), { recursive: true });
fs.copyFileSync(path.join(root, 'src', 'worker.js'), path.join(output, 'worker.js'));
fs.copyFileSync(path.join(root, 'src', 'ui', 'index.html'), path.join(output, 'ui', 'index.html'));
fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built plugin: ${output}`);
