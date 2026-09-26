import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackageDirectory } from '../packages/plugin-sdk/validate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const template = path.join(root, 'packages', 'plugin-sdk', 'templates', 'basic');
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'zync-plugin-starter-'));
const output = path.join(project, 'dist');
try {
  fs.cpSync(template, project, { recursive: true });
  const link = path.join(project, 'node_modules', '@zync-sh', 'plugin-sdk');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(root, 'packages', 'plugin-sdk'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const build = spawnSync(process.execPath, [path.join(project, 'scripts', 'build.mjs')], {
    cwd: project,
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, build.stderr);
  const result = validatePackageDirectory(output, { zyncVersion: '2.32.2' });
  assert.equal(result.valid, true, JSON.stringify(result.issues));
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8')).id, 'dev.example.starter');
  assert.match(fs.readFileSync(path.join(output, 'ui', 'index.html'), 'utf8'), /Ask the Worker/);
} finally {
  if (project.startsWith(os.tmpdir())) fs.rmSync(project, { recursive: true, force: true });
}

console.log('plugin SDK starter template: build and validate OK');
