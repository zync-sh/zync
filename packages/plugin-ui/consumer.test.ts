import { normalizeTheme, applyTheme, installThemeBridge, enhanceSelects, installTooltips, createButton, createBadge, createField, createEmptyState } from './index.js';
const theme = normalizeTheme({ mode: 'light' });
applyTheme(theme);
const dispose: Array<() => void> = [installThemeBridge({ onChange: value => applyTheme(value) }), enhanceSelects(), installTooltips()];
const button: HTMLButtonElement = createButton({ text: 'Retry', variant: 'primary' });
const field: HTMLInputElement = createField({ label: 'Search', type: 'search' }).input;
createBadge(field.value, 'positive');
createEmptyState({ title: 'Ready', actions: [button] });
dispose.forEach(cleanup => cleanup());
