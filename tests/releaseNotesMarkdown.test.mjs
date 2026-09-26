import assert from 'node:assert/strict';
import {
  classifyMediaUrl,
  coerceHtmlBoolean,
  hasPathTraversal,
  isAllowedMediaUrl,
  isGithubAttachmentUrl,
  rewriteMarkdownMediaUrls,
} from '../.tmp-agent-tests/src/lib/releaseNotes/mediaUrls.js';
import { matchAlertPrefix, stripAlertPrefixFromParts } from '../.tmp-agent-tests/src/lib/releaseNotes/alerts.js';
import {
  buildHeadingIdLookup,
  extractToc,
  headingLookupKey,
  slugify,
} from '../.tmp-agent-tests/src/lib/releaseNotes/headings.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

runTest('allows GitHub user-attachment HTTPS media', () => {
  const url = 'https://github.com/user-attachments/assets/fd7731ff-3517-4b69-923c-e7ab79fe9e12';
  assert.equal(isAllowedMediaUrl(url), true);
  assert.equal(isGithubAttachmentUrl(url), true);
  assert.equal(classifyMediaUrl(url), 'unknown');
});

runTest('classifies gif and mp4 by extension', () => {
  assert.equal(
    classifyMediaUrl('https://user-images.githubusercontent.com/1/demo.gif'),
    'image',
  );
  assert.equal(
    classifyMediaUrl('https://user-images.githubusercontent.com/1/demo.mp4'),
    'video',
  );
  assert.equal(
    classifyMediaUrl('https://user-images.githubusercontent.com/1/demo.webm'),
    'video',
  );
});

runTest('rejects javascript, data, and non-media URLs', () => {
  assert.equal(isAllowedMediaUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedMediaUrl('data:image/png;base64,aaaa'), false);
  assert.equal(isAllowedMediaUrl('https://evil.example/not-media'), false);
  assert.equal(isAllowedMediaUrl('http://github.com/user-attachments/assets/abc'), false);
  assert.equal(isAllowedMediaUrl('shot.png'), false);
  assert.equal(isAllowedMediaUrl('./local.png'), false);
});

runTest('allows https CDN media and embeds a bare Demo GIF URL', () => {
  const gif = 'https://pub-f5d307b0347348988dccc997da10756a.r2.dev/export-1788007096421.gif';
  assert.equal(isAllowedMediaUrl(gif), true);
  assert.equal(classifyMediaUrl(gif), 'image');
  const out = rewriteMarkdownMediaUrls(`## Demo\n\n${gif}\n`);
  assert.match(out, /!\[\]\(https:\/\/pub-f5d307b0347348988dccc997da10756a\.r2\.dev\/export-1788007096421\.gif\)/);
});

runTest('rejects absolute local image paths and traversal', () => {
  const winPath = 'C:\\Users\\gajen\\AppData\\Local\\Temp\\waveterm-3125566605\\waveterm_paste_1788887604406_wsbwrk.png';
  assert.equal(isAllowedMediaUrl(winPath), false);
  assert.equal(classifyMediaUrl(winPath), 'unknown');
  assert.equal(isAllowedMediaUrl('/tmp/demo.gif'), false);
  assert.equal(isAllowedMediaUrl('file:///C:/Users/gajen/shot.png'), false);
  assert.equal(isAllowedMediaUrl('C:\\Windows\\notepad.exe'), false);
  assert.equal(isAllowedMediaUrl('C:\\Users\\gajen\\..\\secret.png'), false);
  assert.equal(hasPathTraversal('C:\\Users\\gajen\\..\\secret.png'), true);
  assert.equal(hasPathTraversal('file:///C:/Users/%2e%2e/secret.png'), true);
  assert.equal(hasPathTraversal('file:///C:/Users/gajen/shot.png'), false);
});

runTest('stripAlertPrefixFromParts keeps later markup nodes', () => {
  const kept = stripAlertPrefixFromParts(['[!NOTE] See the ', { href: '/docs' }, ' and `code`']);
  assert.deepEqual(kept, ['See the ', { href: '/docs' }, ' and `code`']);
  assert.deepEqual(stripAlertPrefixFromParts(['[!TIP]', { href: '/x' }]), [{ href: '/x' }]);
});

runTest('rewriteMarkdownMediaUrls does not embed a bare Windows path', () => {
  const winPath = 'C:\\Users\\gajen\\AppData\\Local\\Temp\\waveterm-3125566605\\waveterm_paste_1788887604406_wsbwrk.png';
  const out = rewriteMarkdownMediaUrls(`See this:\n\n${winPath}\n`);
  assert.equal(out, `See this:\n\n${winPath}\n`);
});

runTest('rewriteMarkdownMediaUrls leaves local markdown images for the protocol gate to reject', () => {
  const out = rewriteMarkdownMediaUrls('![paste](C:\\Temp\\shot.gif)');
  assert.equal(out, '![paste](C:\\Temp\\shot.gif)');
});

runTest('rewriteMarkdownMediaUrls leaves fenced paths alone', () => {
  const fenced = '```\nC:\\Temp\\shot.png\n```';
  assert.equal(rewriteMarkdownMediaUrls(fenced), fenced);
});

runTest('allows githubusercontent subdomains and shields badges', () => {
  assert.equal(isAllowedMediaUrl('https://raw.githubusercontent.com/zync-sh/zync/main/shot.png'), true);
  assert.equal(isAllowedMediaUrl('https://img.shields.io/badge/x-y.svg'), true);
  assert.equal(
    isAllowedMediaUrl('https://private-user-images.githubusercontent.com/1/2.jpg?jwt=abc'),
    true,
  );
});

runTest('coerceHtmlBoolean treats HTML boolean attributes as true', () => {
  assert.equal(coerceHtmlBoolean(true), true);
  assert.equal(coerceHtmlBoolean(''), true);
  assert.equal(coerceHtmlBoolean('true'), true);
  assert.equal(coerceHtmlBoolean('loop'), true);
  assert.equal(coerceHtmlBoolean(false), false);
  assert.equal(coerceHtmlBoolean(undefined), false);
});

runTest('matchAlertPrefix parses GitHub alert markers', () => {
  assert.deepEqual(matchAlertPrefix('[!NOTE]\nHello'), { kind: 'note', rest: 'Hello' });
  assert.deepEqual(matchAlertPrefix('[!WARNING] Careful'), { kind: 'warning', rest: 'Careful' });
  assert.equal(matchAlertPrefix('just a quote'), null);
});

runTest('extractToc skips headings inside fences and images', () => {
  const toc = extractToc(`
# Title

\`\`\`
# not a heading
\`\`\`

## Added

![Nested splits](https://github.com/user-attachments/assets/abc)

### Pane focus
`);
  assert.deepEqual(toc.map((e) => e.text), ['Title', 'Added', 'Pane focus']);
});

runTest('slugify uniquifies duplicate headings', () => {
  const used = new Map();
  assert.equal(slugify('Added', used), 'added');
  assert.equal(slugify('Added', used), 'added-1');
});

runTest('buildHeadingIdLookup keeps the first TOC id for duplicate texts', () => {
  const toc = extractToc('## Added\n\n## Fixed\n\n## Added\n');
  const lookup = buildHeadingIdLookup(toc);
  assert.equal(lookup.get(headingLookupKey(2, 'Added')), 'added');
  assert.equal(lookup.get(headingLookupKey(2, 'Fixed')), 'fixed');
  assert.equal(lookup.get('2:Added'), 'added');
});
