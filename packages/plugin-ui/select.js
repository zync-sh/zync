let sequence = 0;
const installed = new WeakMap();

/** Enhance single-select controls in-place. Returns a complete teardown function. */
export function enhanceSelects(root = document, { closeEvent = 'zync-ui:close-menus' } = {}) {
  const doc = root.ownerDocument || root;
  const view = doc.defaultView;
  const cleanups = [];
  for (const select of root.querySelectorAll('select:not([hidden]):not([multiple])')) {
    if (installed.has(select)) continue;
    const controller = new view.AbortController();
    const listen = (target, name, callback, capture = false) => target.addEventListener(name, callback, { signal: controller.signal, capture });
    const wrapper = doc.createElement('div');
    wrapper.className = 'zui-select-control select-control';
    const trigger = doc.createElement('button');
    trigger.type = 'button';
    trigger.className = 'zui-select-trigger select-trigger';
    const label = select.getAttribute('aria-label') || select.labels?.[0]?.textContent?.trim() || 'Choose an option';
    trigger.setAttribute('aria-label', label);
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const menu = doc.createElement('div');
    menu.className = 'zui-select-menu select-menu';
    menu.id = `zui-select-${++sequence}`;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', label);
    menu.hidden = true;
    trigger.setAttribute('aria-controls', menu.id);
    select.before(wrapper);
    wrapper.append(select, trigger);
    doc.body.append(menu);
    select.hidden = true;
    let buttons = [];
    let active = -1;
    let typed = '';
    let typedAt = 0;
    const available = () => buttons.filter(button => !button.disabled && !button.hidden);
    function close(restoreFocus = false) {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus && trigger.isConnected) trigger.focus();
    }
    function sync(rebuild = false) {
      if (rebuild) {
        buttons = [...select.options].map((option, index) => {
          const button = doc.createElement('button');
          button.type = 'button';
          button.textContent = option.textContent;
          button.setAttribute('role', 'option');
          button.tabIndex = -1;
          button.disabled = option.disabled || (option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled);
          button.hidden = option.hidden;
          button.addEventListener('click', () => {
            if (select.disabled || button.disabled) return;
            select.selectedIndex = index;
            select.dispatchEvent(new view.Event('change', { bubbles: true }));
            close(true);
          });
          return button;
        });
        menu.replaceChildren(...buttons);
      }
      trigger.textContent = select.selectedOptions[0]?.textContent || '';
      trigger.disabled = select.disabled;
      buttons.forEach((button, index) => button.setAttribute('aria-selected', String(index === select.selectedIndex)));
      if (select.disabled) close();
    }
    function focus(button) {
      active = buttons.indexOf(button);
      button?.focus({ preventScroll: true });
      button?.scrollIntoView({ block: 'nearest' });
    }
    function open() {
      if (select.disabled) return;
      doc.dispatchEvent(new view.Event(closeEvent));
      sync();
      const enabled = available();
      if (!enabled.length) return;
      menu.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 160), Math.max(0, view.innerWidth - 16));
      menu.style.width = `${width}px`;
      menu.style.left = `${Math.max(8, Math.min(rect.left, view.innerWidth - width - 8))}px`;
      const below = Math.max(0, view.innerHeight - rect.bottom - 8);
      const above = Math.max(0, rect.top - 8);
      const down = below >= Math.min(menu.scrollHeight, 220) || below >= above;
      menu.style.maxHeight = `${Math.min(220, down ? below : above)}px`;
      menu.style.top = down ? `${rect.bottom + 4}px` : 'auto';
      menu.style.bottom = down ? 'auto' : `${view.innerHeight - rect.top + 4}px`;
      typed = '';
      focus(enabled.includes(buttons[select.selectedIndex]) ? buttons[select.selectedIndex] : enabled[0]);
    }
    listen(trigger, 'click', () => menu.hidden ? open() : close());
    listen(trigger, 'keydown', event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); }
    });
    listen(menu, 'keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
      if (event.key === 'Tab') { close(true); return; }
      const enabled = available();
      if (!enabled.length) return;
      const index = enabled.indexOf(buttons[active]);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
        focus(enabled[next]);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        typed = Date.now() - typedAt < 500 ? typed + event.key.toLowerCase() : event.key.toLowerCase();
        typedAt = Date.now();
        const match = enabled.find(button => button.textContent.toLowerCase().startsWith(typed));
        if (match) { event.preventDefault(); focus(match); }
      }
    });
    listen(doc, 'pointerdown', event => { if (!wrapper.contains(event.target) && !menu.contains(event.target)) close(); });
    listen(doc, closeEvent, () => close());
    listen(view, 'resize', () => close());
    listen(view, 'blur', () => close());
    listen(doc, 'scroll', event => { if (!menu.contains(event.target)) close(); }, true);
    listen(select, 'change', () => sync());
    const observer = new view.MutationObserver(records => {
      const rebuild = records.some(record => record.target !== select || record.type !== 'attributes');
      sync(rebuild);
    });
    observer.observe(select, { attributes: true, childList: true, characterData: true, subtree: true });
    sync(true);
    const dispose = () => {
      close(); controller.abort(); observer.disconnect(); menu.remove();
      select.hidden = false;
      wrapper.before(select); wrapper.remove(); installed.delete(select);
    };
    installed.set(select, dispose);
    cleanups.push(dispose);
  }
  return () => { for (const cleanup of cleanups.splice(0)) cleanup(); };
}
