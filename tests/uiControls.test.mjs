import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '../.tmp-agent-tests/src/components/ui/Button.js';
import { Input } from '../.tmp-agent-tests/src/components/ui/Input.js';

const render = (component, props) => renderToStaticMarkup(createElement(component, props));

test('button retains native form attributes and marks loading as disabled and busy', () => {
  const html = render(Button, { type: 'submit', name: 'action', value: 'save', isLoading: true, 'aria-busy': false, children: 'Save' });
  assert.match(html, /type="submit"/);
  assert.match(html, /name="action"/);
  assert.match(html, /value="save"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(render(Button, { children: 'Default' }), /type=/);
  assert.match(render(Button, { 'aria-busy': true, children: 'Busy' }), /aria-busy="true"/);
});

test('all button variants and sizes render and caller sizing overrides win', () => {
  for (const variant of ['primary', 'secondary', 'ghost', 'danger']) {
    for (const size of ['sm', 'md', 'lg', 'icon']) {
      assert.match(render(Button, { variant, size, children: 'Action' }), /<button/);
    }
  }
  const html = render(Button, { className: 'h-7 rounded-none text-xs', children: 'Compact' });
  assert.match(html, /h-7/);
  assert.match(html, /rounded-none/);
  assert.doesNotMatch(html, /h-\[var\(--zync-control-height/);
  assert.doesNotMatch(html, /rounded-\[var/);
  assert.doesNotMatch(html, /text-\[length:/);
});

test('input associates its label and error while retaining external descriptions', () => {
  const html = render(Input, { id: 'host', label: 'Host', error: 'Required', 'aria-invalid': false, 'aria-describedby': 'hint host-error hint', defaultValue: 'example', required: true });
  assert.match(html, /for="host"/);
  assert.match(html, /id="host"/);
  assert.match(html, /id="host-error"/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /aria-describedby="hint host-error"/);
  assert.match(html, /value="example"/);
  assert.match(html, /required=""/);
});

test('input preserves caller aria state when no local error and does not invent a description', () => {
  const html = render(Input, { 'aria-invalid': 'grammar', 'aria-describedby': 'hint' });
  assert.match(html, /aria-invalid="grammar"/);
  assert.match(html, /aria-describedby="hint"/);
  assert.doesNotMatch(render(Input, {}), /aria-describedby|aria-invalid/);
});

test('generated input IDs are unique and error references point at rendered messages', () => {
  const html = renderToStaticMarkup(createElement('div', null,
    createElement(Input, { label: 'First', error: 'Missing first' }),
    createElement(Input, { label: 'Second', error: 'Missing second' }),
  ));
  const ids = [...html.matchAll(/<input[^>]* id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) {
    assert.ok(html.includes(`for="${id}"`));
    assert.ok(html.includes(`aria-describedby="${id}-error"`));
    assert.ok(html.includes(`id="${id}-error"`));
  }
});

test('input retains native attributes, trailing content and caller style overrides', () => {
  const html = render(Input, { type: 'password', autoComplete: 'current-password', disabled: true, className: 'h-7 rounded-none text-xs', rightElement: createElement('button', { type: 'button' }, 'Show') });
  assert.match(html, /type="password"/);
  assert.match(html, /autoComplete="current-password"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /pr-9/);
  assert.match(html, />Show<\/button>/);
  assert.doesNotMatch(html, /h-\[var\(--zync-control-height|rounded-\[var|text-\[length:/);
});
