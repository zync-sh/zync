let sequence = 0;
const installed = new WeakMap();

export function installTooltips(root = document) {
  if (installed.has(root)) return () => {};
  const doc = root.ownerDocument || root;
  const view = doc.defaultView;
  const controller = new view.AbortController();
  const listen = (target, name, callback, capture = false) => target.addEventListener(name, callback, { signal: controller.signal, capture });
  const tip = doc.createElement('div');
  tip.id = `zui-tooltip-${++sequence}`;
  tip.className = 'zui-tooltip tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  doc.body.append(tip);
  let target;
  let timer;
  function hide() {
    view.clearTimeout(timer);
    if (target) {
      const ids = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== tip.id);
      if (ids.length) target.setAttribute('aria-describedby', ids.join(' '));
      else target.removeAttribute('aria-describedby');
    }
    target = null;
    tip.hidden = true;
  }
  function show() {
    if (!target?.isConnected || !target.dataset.tooltip) { hide(); return; }
    tip.textContent = target.dataset.tooltip;
    tip.hidden = false;
    tip.style.left = '8px'; tip.style.top = '8px';
    const rect = target.getBoundingClientRect();
    const bounds = tip.getBoundingClientRect();
    const above = rect.top >= bounds.height + 16;
    tip.style.left = `${Math.max(8, Math.min(rect.left + (rect.width - bounds.width) / 2, view.innerWidth - bounds.width - 8))}px`;
    tip.style.top = `${Math.max(8, Math.min(above ? rect.top - bounds.height - 8 : rect.bottom + 8, view.innerHeight - bounds.height - 8))}px`;
    const ids = new Set((target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    ids.add(tip.id);
    target.setAttribute('aria-describedby', [...ids].join(' '));
  }
  function enter(event) {
    const next = event.target.closest?.('[data-tooltip]');
    if (!next?.dataset.tooltip || !root.contains(next) || next === target) return;
    hide(); target = next;
    timer = view.setTimeout(show, event.type === 'focusin' ? 120 : 400);
  }
  listen(root, 'pointerover', enter);
  listen(root, 'focusin', enter);
  for (const name of ['pointerout', 'focusout']) listen(root, name, event => {
    if (target?.contains(event.target) && !target.contains(event.relatedTarget)) hide();
  });
  listen(doc, 'pointerdown', hide, true);
  listen(doc, 'keydown', event => { if (event.key === 'Escape') hide(); });
  listen(doc, 'scroll', hide, true);
  listen(view, 'resize', hide);
  listen(view, 'blur', hide);
  const observer = new view.MutationObserver(() => {
    if (!target) return;
    if (!target.isConnected || !target.dataset.tooltip) hide();
    else if (!tip.hidden && tip.textContent !== target.dataset.tooltip) show();
  });
  observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-tooltip'] });
  const dispose = () => { hide(); observer.disconnect(); controller.abort(); tip.remove(); installed.delete(root); };
  installed.set(root, dispose);
  return dispose;
}
