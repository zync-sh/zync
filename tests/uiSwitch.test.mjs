import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Switch } from '../.tmp-agent-tests/src/components/ui/Switch.js';
import { Toggle } from '../.tmp-agent-tests/src/components/settings/common/Toggle.js';
import { SettingsGroup } from '../.tmp-agent-tests/src/components/settings/common/SettingsGroup.js';

const render = (props) => renderToStaticMarkup(h(Switch, { label: 'Feature', checked: false, onCheckedChange: () => assert.fail('render must not change state'), ...props }));

test('plain and boxed settings groups leave horizontal spacing to their rows', () => {
  for (const plain of [false, true]) {
    const html = renderToStaticMarkup(h(SettingsGroup, { plain }, h('span', null, 'Child')));
    const classes = html.match(/class="([^"]+)"/)[1];
    assert.doesNotMatch(classes, /(?:^|\s)(?:p[xrl]?|border)(?:-|\s|$)/);
    assert.equal(classes.includes('ring-inset'), !plain);
    assert.match(html, /<span>Child<\/span>/);
  }
});

test('compact switch has a stable name, checked state and non-submit semantics', () => {
  for (const checked of [false, true]) {
    const html = render({ checked });
    assert.match(html, /type="button" role="switch" aria-label="Feature"/);
    assert.ok(html.includes(`aria-checked="${checked}"`));
    assert.match(html, /aria-hidden="true"/);
    assert.doesNotMatch(html, /aria-describedby=/);
  }
});

test('disabled switch uses native disabling and retains checked state', () => {
  const html = render({ checked: true, disabled: true });
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-checked="true"/);
});

test('labeled row associates its description while retaining caller descriptions', () => {
  const html = render({ showLabel: true, description: 'Explanation', 'aria-describedby': 'external-help' });
  const ids = html.match(/aria-describedby="([^"]+)"/)[1].split(' ');
  assert.equal(ids[0], 'external-help');
  assert.equal(ids.length, 2);
  assert.ok(html.includes(`id="${ids[1]}"`));
  assert.match(html, /Explanation/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
});

test('compact switches do not reference unrendered descriptions and accept overrides', () => {
  const html = render({ description: 'Hidden', 'aria-describedby': 'external-help', className: 'h-10 rounded-none', id: 'setting' });
  assert.match(html, /aria-describedby="external-help"/);
  assert.match(html, /id="setting"/);
  assert.doesNotMatch(html, /Hidden|h-8/);
  assert.match(html, /h-10 rounded-none/);
});

test('switch motion respects reduced-motion styles in both states', () => {
  for (const checked of [false, true]) {
    const html = render({ checked });
    assert.match(html, /motion-reduce:transition-none/);
    assert.equal(html.includes('-translate-x-full'), checked);
    assert.match(html, /aspect-square/);
    assert.match(html, /bottom-\[var\(--zync-switch-inset\)\]/);
    assert.doesNotMatch(html, /--zync-switch-thumb\)|--zync-switch-travel/);
  }
});

test('existing Toggle API delegates to a single labeled switch without changing its contract', () => {
  const html = renderToStaticMarkup(h(Toggle, { label: 'Setting', description: 'Help', checked: true, disabled: true, onChange: () => assert.fail('render must not call onChange') }));
  assert.match(html, /aria-label="Setting"/);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /Help/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
});
