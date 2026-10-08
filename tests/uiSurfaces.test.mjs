import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Select } from '../.tmp-agent-tests/src/components/ui/Select.js';
import { TopbarDropdown } from '../.tmp-agent-tests/src/components/ui/TopbarDropdown.js';
import { MenuSubmenu, MENU_PANEL_CLASS } from '../.tmp-agent-tests/src/components/ui/MenuSubmenu.js';
import { POPUP_SURFACE_CLASSES } from '../.tmp-agent-tests/src/components/ui/surfaceStyles.js';

const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const options = [{ value: 'sh', label: 'Shell' }, { value: 'bash', label: 'Bash' }];
const onChange = () => assert.fail('Rendering must not change selection');

test('Select retains label, selection and native non-submit semantics', () => {
  const html = render(Select, { id: 'shell', label: 'Shell type', ariaDescribedBy: 'help', value: 'bash', options, onChange });
  assert.match(html, /for="shell"/);
  assert.match(html, /id="shell"/);
  assert.match(html, /type="button"/);
  assert.match(html, /aria-describedby="help"/);
  assert.match(html, /aria-haspopup="listbox"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, />Bash<\/span>/);
});

test('Select retains disabled accessible trigger and unknown-value fallback', () => {
  const html = render(Select, { ariaLabel: 'Choose shell', disabled: true, value: 'missing', placeholder: 'Choose one', options, onChange });
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-label="Choose shell"/);
  assert.match(html, /disabled=""/);
  assert.match(html, />Choose one<\/span>/);
});

test('Select keeps caller trigger sizing and radius overrides', () => {
  const html = render(Select, { options, onChange, triggerClassName: 'h-7 rounded-none text-xs' });
  assert.match(html, /h-7/);
  assert.match(html, /rounded-none/);
  assert.doesNotMatch(html, /h-\[var\(--zync-control-height/);
  assert.doesNotMatch(html, /rounded-\[var/);
});

test('TopbarDropdown retains caller alignment, placement, width and element attributes', () => {
  const html = render(TopbarDropdown, { align: 'right', side: 'top', widthClass: 'w-64', className: 'rounded-none', role: 'menu', 'aria-label': 'Actions', children: 'Item' });
  assert.match(html, /right-0/);
  assert.match(html, /bottom-full/);
  assert.match(html, /w-64/);
  assert.match(html, /role="menu"/);
  assert.match(html, /aria-label="Actions"/);
  assert.match(html, /rounded-none/);
  assert.doesNotMatch(html, /rounded-\[var/);
});

test('submenu and other popups share visual tokens without merging placement ownership', () => {
  assert.ok(MENU_PANEL_CLASS.includes(POPUP_SURFACE_CLASSES));
  assert.ok(MENU_PANEL_CLASS.includes('fixed'));
  const html = render(MenuSubmenu, { label: 'More actions', disabled: true, triggerClassName: 'h-7', children: createElement('button', null, 'Child') });
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, />Child</);
});
