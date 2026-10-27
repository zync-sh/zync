import assert from 'node:assert/strict';
import test from 'node:test';

import type { FocusEvent, KeyboardEvent } from 'react';

import { loadSource } from './helpers/loadSource';

/** Substitute DOM ownership and React state boundaries, not the production intent policy. */
function setup() {
    class Element {
        visible = true;
        focus: (options: FocusOptions) => void = () => {};

        constructor(
            public parent: Element | null = null,
            public role: string | null = null,
        ) {}
        contains(node: Element | null | undefined): boolean {
            return node === this || Boolean(node?.parent && this.contains(node.parent));
        }
        matches(selector: string) {
            assert.equal(selector, ':focus-visible');
            return this.visible;
        }
        closest(selector: string): Element | null {
            assert.equal(selector, '[role="dialog"], [role="menu"]');
            return this.role === 'dialog' || this.role === 'menu'
                ? this
                : (this.parent?.closest(selector) ?? null);
        }
    }
    let quiet: boolean | undefined;
    const { useFileActivationFocus } = loadSource<
        typeof import('../../src/components/file-manager/useFileActivationFocus')
    >(
        'components/file-manager/useFileActivationFocus.ts',
        {
            react: {
                useCallback: <T>(callback: T) => callback,
                useRef: <T>(current: T) => ({ current }),
                useState: (initial: boolean) => {
                    quiet = initial;
                    return [
                        initial,
                        (value: boolean) => {
                            quiet = value;
                        },
                    ];
                },
            },
        },
        { Element, Node: Element },
    );
    const scope = new Element();
    const listing = new Element(scope);
    const control = new Element(scope);
    const outside = new Element();
    const dialog = new Element(null, 'dialog');
    const input = new Element(dialog);
    const menuItem = new Element(new Element(null, 'menu'));
    const productionHooks = useFileActivationFocus(
        { current: scope as unknown as HTMLElement },
        { current: listing as unknown as HTMLElement },
    );
    // These partial events model only the DOM fields consumed by the production hook.
    const hooks = {
        ...productionHooks,
        onKeyDownCapture(event: {
            target: Element;
            key?: string;
            ctrlKey?: boolean;
            shiftKey?: boolean;
        }) {
            productionHooks.onKeyDownCapture(event as unknown as KeyboardEvent<HTMLElement>);
        },
        onFocusCapture(event: { target: Element; relatedTarget: Element | null }) {
            productionHooks.onFocusCapture(event as unknown as FocusEvent<HTMLElement>);
        },
    };
    const focused: FocusOptions[] = [];
    listing.focus = (options) => {
        focused.push(options);
        hooks.onFocusCapture({ target: listing, relatedTarget: outside });
    };
    return {
        hooks,
        scope,
        listing,
        control,
        outside,
        input,
        menuItem,
        focused,
        quiet: () => quiet,
    };
}

test('automatic activation keeps native focus and scroll position while suppressing its decoration', () => {
    const h = setup();
    h.hooks.onKeyDownCapture({ target: h.listing, key: 'ArrowDown' });
    assert.equal(h.quiet(), false);
    h.hooks.focusOnActivation();
    assert.equal(h.quiet(), true);
    assert.equal(h.focused.length, 1);
    assert.equal(h.focused[0].preventScroll, true);
});

test('typing and focus in a portaled dialog cannot reveal underlying listing indicators', () => {
    const h = setup();
    h.hooks.onPointerDownCapture();
    h.hooks.onFocusCapture({ target: h.input, relatedTarget: h.listing });
    h.hooks.onKeyDownCapture({ target: h.input });
    h.hooks.onFocusCapture({ target: h.listing, relatedTarget: h.input });
    assert.equal(h.quiet(), true);
    h.hooks.onFocusCapture({ target: h.listing, relatedTarget: null });
    assert.equal(h.quiet(), true, 'detached-dialog cleanup is still programmatic restoration');
});

test('keyboard intent survives modal focus changes and pointer dismissal explicitly quiets it', () => {
    const h = setup();
    h.hooks.onKeyDownCapture({ target: h.control });
    h.hooks.onFocusCapture({ target: h.input, relatedTarget: h.listing });
    h.hooks.onFocusCapture({ target: h.listing, relatedTarget: h.input });
    assert.equal(h.quiet(), false);
    h.hooks.onPointerDownCapture();
    h.hooks.onFocusCapture({ target: h.listing, relatedTarget: h.input });
    assert.equal(h.quiet(), true);
});

test('Tab navigation within Files and keyboard entry from neighboring surfaces reveal focus', () => {
    const h = setup();
    h.hooks.onKeyDownCapture({ target: h.control });
    h.hooks.onFocusCapture({ target: h.listing, relatedTarget: h.control });
    assert.equal(h.quiet(), false);
    h.hooks.onPointerDownCapture();
    h.hooks.onFocusCapture({ target: h.listing, relatedTarget: h.outside });
    assert.equal(h.quiet(), false);
});

test('pointer/internal focus changes and menu restoration do not manufacture keyboard intent', () => {
    const h = setup();
    h.hooks.onPointerDownCapture();
    h.hooks.onFocusCapture({ target: h.listing, relatedTarget: h.control });
    h.hooks.onFocusCapture({ target: h.listing, relatedTarget: h.menuItem });
    assert.equal(h.quiet(), true);
    h.listing.visible = false;
    h.hooks.onFocusCapture({ target: h.listing, relatedTarget: h.outside });
    assert.equal(h.quiet(), true);
});

test('clipboard accelerators and modifier keys do not reveal the listing focus cursor', () => {
    const h = setup();
    for (const key of ['Control', 'Meta', 'Alt', 'Shift', 'c', 'v', 'x', 'a']) {
        h.hooks.onKeyDownCapture({ target: h.listing, key, ctrlKey: true });
        assert.equal(h.quiet(), true, key);
    }
    h.hooks.onKeyDownCapture({ target: h.control, key: 'v', ctrlKey: true });
    assert.equal(h.quiet(), false, 'editing keyboard intent in a Files control is unchanged');
});

test('listing navigation, selection activation and context commands still reveal keyboard focus', () => {
    const h = setup();
    for (const key of [
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End',
        'PageUp',
        'PageDown',
        'Tab',
        'Enter',
        ' ',
        'F2',
        'ContextMenu',
        'F10',
    ]) {
        h.hooks.onPointerDownCapture();
        h.hooks.onKeyDownCapture({ target: h.listing, key, shiftKey: key === 'F10' });
        assert.equal(h.quiet(), false, key);
    }
});
