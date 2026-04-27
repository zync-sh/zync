import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const sourcePath = path.join(process.cwd(), 'src', 'components', 'UpdateNotification.tsx');
const source = fs.readFileSync(sourcePath, 'utf8');

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function extractFunctionBody(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const signature = new RegExp(
    String.raw`(?:const\s+${escaped}\s*=\s*(?:async\s*)?\(?[^)]*\)?\s*=>\s*\{|function\s+${escaped}\s*\([^)]*\)\s*\{|async\s+function\s+${escaped}\s*\([^)]*\)\s*\{)`,
    'm',
  );
  const match = signature.exec(source);
  assert.ok(match, `Function "${name}" signature not found`);

  const start = match.index + match[0].length - 1; // opening "{"
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start + 1, i);
      }
    }
  }
  assert.fail(`Function "${name}" body could not be parsed (unbalanced braces)`);
}

runTest('startDownload uses in-app updater flow', () => {
  const body = extractFunctionBody('startDownload');
  assert.match(body, /invoke\('update:download'\)/, 'startDownload should invoke update:download');
  assert.doesNotMatch(
    body,
    /platform\s*===\s*['"]darwin['"]/,
    'startDownload should not branch to a mac-specific manual path',
  );
  assert.doesNotMatch(
    body,
    /invoke\('shell:open'/,
    'startDownload should not open external release pages',
  );
});

runTest('manual fallback remains available for error state', () => {
  const body = extractFunctionBody('openManualDownload');
  assert.match(body, /invoke\('shell:open',\s*releaseUrl\)/, 'manual fallback should still open release URL');
});

runTest('available update CTA copy is in-app download', () => {
  assert.match(
    source,
    />\s*Download\s*</,
    'Available-state button should show "Download"',
  );
  assert.ok(
    !source.includes('Download from GitHub'),
    'UI should not present GitHub-only download text in available state',
  );
});

console.log('Update notification auto-update flow tests passed.');
