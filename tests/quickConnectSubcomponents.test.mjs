import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function ensureNoExtShim(basePath, targetFile) {
  if (!fs.existsSync(basePath)) {
    fs.writeFileSync(basePath, `export * from './${targetFile}';\n`, 'utf8');
  }
}

const tmpRoot = path.resolve('.tmp-agent-tests/src');
ensureNoExtShim(path.join(tmpRoot, 'components/icons/OSIcon'), 'OSIcon.js');
ensureNoExtShim(path.join(tmpRoot, 'lib/utils'), 'utils.js');

const { AuthPanel } = await import('../.tmp-agent-tests/src/components/dashboard/welcome/quick-connect/AuthPanel.js');
const { SuggestionsDropdown } = await import('../.tmp-agent-tests/src/components/dashboard/welcome/quick-connect/SuggestionsDropdown.js');
const { TemplatesDropdown } = await import('../.tmp-agent-tests/src/components/dashboard/welcome/quick-connect/TemplatesDropdown.js');

runTest('AuthPanel renders auth controls when open', () => {
  const html = renderToStaticMarkup(
    React.createElement(AuthPanel, {
      isAuthOpen: true,
      password: 'pw',
      setPassword: () => {},
      portOverride: '22',
      setPortOverride: () => {},
      privateKeyPath: '/tmp/key',
      setPrivateKeyPath: () => {},
      onBrowseKey: () => {},
    }),
  );

  assert.ok(html.includes('SSH password'));
  assert.ok(html.includes('Port override'));
  assert.ok(html.includes('Private key file path'));
});

runTest('SuggestionsDropdown renders recent header and live tag', () => {
  const html = renderToStaticMarkup(
    React.createElement(SuggestionsDropdown, {
      showDropdown: true,
      showRecents: true,
      listboxId: 'qc-list',
      dropItems: [{
        id: 'c1',
        name: 'Prod',
        host: '10.0.0.1',
        username: 'root',
        port: 22,
        status: 'connected',
        createdAt: Date.now(),
      }],
      activeIndex: 0,
      setActiveIndex: () => {},
      onSelectExisting: () => {},
    }),
  );

  assert.ok(html.includes('Recent'));
  assert.ok(html.includes('live'));
  assert.ok(html.includes('Prod'));
});

runTest('TemplatesDropdown applies focused class and ARIA selected state', () => {
  const templateRefs = { current: [] };
  const html = renderToStaticMarkup(
    React.createElement(TemplatesDropdown, {
      showTemplates: true,
      templateFocusIndex: 1,
      templateItemRefs: templateRefs,
      templates: [
        { id: 't1', name: 'Template 1', username: 'root', port: 22 },
        { id: 't2', name: 'Template 2', username: 'ubuntu', port: 2222 },
      ],
      onTemplateKeyDown: () => {},
      onTemplateFocus: () => {},
      onTemplateApply: () => {},
    }),
  );

  assert.ok(html.includes('Template 2'));
  assert.ok(html.includes('aria-selected="true"'));
  assert.ok(html.includes('bg-app-surface/70'));
});

console.log('Quick connect subcomponent tests passed.');
