import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SETTINGS_SECTIONS, SettingsNavigation, nextSettingsSection, settingsPanelId, settingsTabId } from '../.tmp-agent-tests/src/components/settings/SettingsNavigation.js';

test('vertical section navigation wraps and supports Home/End', () => {
  assert.equal(nextSettingsSection('general', 'ArrowDown'), 'terminal');
  assert.equal(nextSettingsSection('general', 'ArrowUp'), 'about');
  assert.equal(nextSettingsSection('about', 'ArrowDown'), 'general');
  assert.equal(nextSettingsSection('feedback', 'Home'), 'general');
  assert.equal(nextSettingsSection('terminal', 'End'), 'about');
  assert.equal(new Set(SETTINGS_SECTIONS.map(section => section.key)).size, SETTINGS_SECTIONS.length);
});

test('Tab, activation keys and horizontal arrows retain native behavior', () => {
  for (const key of ['Tab', 'Enter', ' ', 'Escape', 'ArrowLeft', 'ArrowRight']) {
    assert.equal(nextSettingsSection('general', key), undefined);
  }
});

test('only the selected tab and the separate JSON action start in the Tab sequence', () => {
  const html = renderToStaticMarkup(h(SettingsNavigation, {
    idPrefix: 'settings', activeTab: 'terminal',
    onTabChange: () => assert.fail('render must not change sections'),
    onOpenJson: () => assert.fail('render must not open JSON'), aboutBadge: true, aboutBadgeLabel: 'Update ready',
  }));
  assert.match(html, /role="tablist" aria-label="Settings sections" aria-orientation="vertical"/);
  const tabs = html.match(/<button[^>]*role="tab"[^>]*>/g);
  assert.equal(tabs.length, 10);
  assert.equal(tabs.filter(tab => tab.includes('tabindex="0"')).length, 1);
  assert.ok(tabs.find(tab => tab.includes(`id="${settingsTabId('settings', 'terminal')}"`)).includes('aria-selected="true"'));
  assert.ok(tabs.every(tab => tab.includes(`aria-controls="${settingsPanelId('settings')}"`)));
  assert.match(html, /Update ready/);
  // The JSON button is a sibling after the tablist, not a selectable tab.
  assert.match(html, /<\/div><button type="button"[^>]*>[\s\S]*settings\.json<\/button><\/div>$/);
});
