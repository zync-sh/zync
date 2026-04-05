import assert from 'node:assert/strict';

import {
  getEditorThemeColors,
  LIGHT_EDITOR_THEME_OPTIONS,
  buildLightEditorThemeTokens,
  resolveLightEditorThemeId,
} from '../.tmp-agent-tests/src/components/light-editor/theme/themes.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('resolves system mode from app theme state', () => {
  assert.equal(resolveLightEditorThemeId('system', 'dark'), 'system');
});

runTest('resolves light-oriented app themes to the light editor family', () => {
  assert.equal(resolveLightEditorThemeId('light', 'light'), 'zync-light');
  assert.equal(resolveLightEditorThemeId('light-warm', 'light'), 'zync-light');
});

runTest('builds editor tokens from app colors', () => {
  const tokens = buildLightEditorThemeTokens({
    background: '#111111',
    panel: '#222222',
    surface: '#333333',
    border: '#444444',
    text: '#eeeeee',
    muted: '#999999',
    accent: '#797bce',
  });

  assert.equal(tokens['--editor-background'], '#111111');
  assert.equal(tokens['--editor-panel'], '#222222');
  assert.equal(tokens['--editor-text'], '#eeeeee');
  assert.equal(tokens['--editor-accent'], '#797bce');
  assert.match(tokens['--editor-accent-soft'], /color-mix/);
  assert.match(tokens['--editor-active-line'], /color-mix/);
});

runTest('exports theme selector options including system default', () => {
  assert.equal(LIGHT_EDITOR_THEME_OPTIONS[0].id, 'system');
  assert.ok(LIGHT_EDITOR_THEME_OPTIONS.some((option) => option.id === 'editor-midnight'));
  assert.ok(LIGHT_EDITOR_THEME_OPTIONS.some((option) => option.id === 'editor-warm'));
});

runTest('derives custom editor theme colors without breaking inherited accent usage', () => {
  const appColors = {
    background: '#111111',
    panel: '#222222',
    surface: '#333333',
    border: '#444444',
    text: '#eeeeee',
    muted: '#999999',
    accent: '#797bce',
  };

  const midnight = getEditorThemeColors('editor-midnight', appColors);
  const warm = getEditorThemeColors('editor-warm', appColors);

  assert.equal(midnight.accent, '#797bce');
  assert.equal(warm.accent, '#797bce');
  assert.notEqual(midnight.background, appColors.background);
  assert.notEqual(warm.background, appColors.background);
});

console.log('Light editor theme tests passed.');
