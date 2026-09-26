import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeTheme } from '../packages/plugin-ui/index.js';
const pkg = new URL('../packages/plugin-ui/', import.meta.url);
const metadata = JSON.parse(fs.readFileSync(new URL('package.json', pkg), 'utf8'));
assert.equal(metadata.name, '@zync-sh/plugin-ui');
assert.equal(metadata.publishConfig.tag, 'beta');
assert.equal(metadata.private, undefined);
assert.equal(metadata.dependencies, undefined);
assert.deepEqual(normalizeTheme(null), { colors: {} });
assert.deepEqual(normalizeTheme([], () => true), { colors: {} });
assert.deepEqual(normalizeTheme({ mode: 'bad', colors: { background: '#fff', injected: 'red', text: 42, primary: 'x'.repeat(257) } }, value => value === '#fff'), { colors: { background: '#fff' } });
assert.deepEqual(normalizeTheme({ mode: 'light', colors: { text: '#123' } }, () => true), { colors: { text: '#123' }, mode: 'light' });
for (const file of metadata.files) assert.ok(fs.statSync(new URL(file, pkg)).isFile(), file);
for (const file of ['index.js', 'theme.js', 'select.js', 'tooltips.js']) {
  const source = fs.readFileSync(new URL(file, pkg), 'utf8');
  assert.ok(!/\.innerHTML\s*=|\beval\(|new Function|\bfetch\(/.test(source), `${file}: unsafe operation`);
}
console.log('Plugin UI metadata, safe imports, theme validation, and package assets passed.');
