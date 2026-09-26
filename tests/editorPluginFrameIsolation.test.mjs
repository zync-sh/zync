import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const sourcePath = path.join(process.cwd(), 'src', 'components', 'EditorPluginFrame.tsx');
const source = fs.readFileSync(sourcePath, 'utf8');

const iframeSandbox = source.match(/<iframe[\s\S]*?sandbox="([^"]+)"/i)?.[1];
assert.equal(iframeSandbox, 'allow-scripts');
assert.equal(iframeSandbox.includes('allow-same-origin'), false);
assert.match(source, /Content-Security-Policy/, 'editor frames must receive their own CSP');
assert.match(source, /connect-src 'none'/, 'editor frames must not inherit the app network allowlist');
assert.match(source, /object-src 'none'/, 'editor frames must disable embedded objects');

console.log('Editor plugin iframe isolation test passed.');
