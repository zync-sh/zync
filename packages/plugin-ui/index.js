export { normalizeTheme, applyTheme, installThemeBridge } from './theme.js';
export { enhanceSelects } from './select.js';
export { installTooltips } from './tooltips.js';

let sequence = 0;
const variants = new Set(['default', 'primary', 'danger', 'ghost']);
const tones = new Set(['muted', 'positive', 'negative', 'warning', 'info']);

/** All user-visible strings are inert text; these helpers never use innerHTML. */
export function createButton({ text, variant = 'default', ariaLabel, onClick, document: doc = document } = {}) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'zui-button';
  button.dataset.variant = variants.has(variant) ? variant : 'default';
  button.textContent = String(text ?? '');
  if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
  if (onClick) button.addEventListener('click', onClick);
  return button;
}

export function createField({ label, value = '', placeholder = '', type = 'text', document: doc = document } = {}) {
  const field = doc.createElement('label');
  field.className = 'zui-field';
  const caption = doc.createElement('span');
  caption.textContent = String(label ?? '');
  const input = doc.createElement('input');
  input.id = `zui-field-${++sequence}`;
  input.type = ['text', 'search', 'number', 'password', 'email', 'url'].includes(type) ? type : 'text';
  input.className = 'zui-input';
  input.value = String(value);
  input.placeholder = String(placeholder);
  field.htmlFor = input.id;
  field.append(caption, input);
  return { field, input };
}

export function createBadge(text, tone = 'muted', doc = document) {
  const badge = doc.createElement('span');
  badge.className = 'zui-badge';
  badge.dataset.tone = tones.has(tone) ? tone : 'muted';
  badge.textContent = String(text ?? '');
  return badge;
}

export function createEmptyState({ title, description, actions = [], document: doc = document } = {}) {
  const panel = doc.createElement('section');
  panel.className = 'zui-empty-state';
  const heading = doc.createElement('h2');
  heading.id = `zui-empty-${++sequence}`;
  heading.textContent = String(title ?? '');
  panel.setAttribute('aria-labelledby', heading.id);
  const copy = doc.createElement('p');
  copy.textContent = String(description ?? '');
  const buttons = doc.createElement('div');
  buttons.className = 'zui-actions';
  buttons.append(...actions);
  panel.append(heading, copy, buttons);
  return panel;
}
