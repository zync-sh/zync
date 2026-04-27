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
  const start = source.indexOf(`const ${name} = async () => {`);
  assert.notEqual(start, -1, `Function "${name}" not found`);

  const afterStart = source.slice(start);
  const endMarker = '\n    };';
  const end = afterStart.indexOf(endMarker);
  assert.notEqual(end, -1, `Function "${name}" terminator not found`);
  return afterStart.slice(0, end);
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
