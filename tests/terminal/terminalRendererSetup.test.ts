import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { ITerminalOptions, Terminal } from '@xterm/xterm';

import type { UseTerminalThemeOptions } from '../../src/components/terminal/useTerminalTheme.js';
import {
    clearTerminalRendererSession,
    getTerminalRendererState,
} from '../../src/lib/terminal/rendererSession.js';
import { type TerminalCache, terminalCache } from '../../src/lib/terminal/terminalCache.js';
import * as typography from '../../src/lib/terminal/terminalTypography.js';
import { createInitialRendererState } from '../../src/lib/terminal/types.js';
import type { TerminalXtermSettings } from '../../src/lib/terminal/xtermOptions.js';

// The shared loader is JavaScript; this local contract preserves checked module boundaries.
const { loadSource: loadProduction } = (await import(
    pathToFileURL(path.resolve('tests/helpers/loadSource.mjs')).href
)) as {
    loadSource<T>(
        file: string,
        dependencies: Record<string, unknown>,
        globals?: Record<string, unknown>,
    ): T;
};

const { needsTerminalRendererSetup } = loadProduction<
    typeof import('../../src/lib/terminal/rendererSetup.js')
>('lib/terminal/rendererSetup.ts', {
    './rendererController.js': {},
    './ligatures.js': {},
    './rendererSession.js': {},
    './terminalFit.js': {},
    './terminalTypography.js': {},
    '../../store/useAppStore.js': {},
});

test('fresh dom session with GPU on needs WebGL setup', () => {
    const state = createInitialRendererState();
    assert.equal(needsTerminalRendererSetup(state, true), true);
});

test('active WebGL session does not need setup', () => {
    const state = createInitialRendererState();
    state.kind = 'webgl';
    state.desiredKind = 'webgl';
    state.webglAddon = { dispose: () => {} };
    assert.equal(needsTerminalRendererSetup(state, true), false);
});

test('context-loss block skips further GPU setup', () => {
    const state = createInitialRendererState();
    state.webglContextLossBlocked = true;
    state.desiredKind = 'webgl';
    assert.equal(needsTerminalRendererSetup(state, true), false);
});

test('GPU off with WebGL loaded needs teardown setup', () => {
    const state = createInitialRendererState();
    state.kind = 'webgl';
    state.webglAddon = { dispose: () => {} };
    assert.equal(needsTerminalRendererSetup(state, false), true);
});

const settings: TerminalXtermSettings = {
    fontSize: 15,
    fontFamily: 'fixture-monospace',
    fontWeight: 500,
    cursorStyle: 'block',
    lineHeight: 1.2,
};
let serial = 0;

/** Real typography/cache ownership with instrumented xterm options and deterministic paints. */
function fixture() {
    const descriptors = new Map(
        ['window', 'requestAnimationFrame', 'cancelAnimationFrame'].map((key) => [
            key,
            Object.getOwnPropertyDescriptor(globalThis, key),
        ]),
    );
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    Object.defineProperties(globalThis, {
        window: { configurable: true, value: { electronUtils: { platform: 'win32' } } },
        requestAnimationFrame: {
            configurable: true,
            value: (callback: FrameRequestCallback) => {
                frames.set(++nextFrame, callback);
                return nextFrame;
            },
        },
        cancelAnimationFrame: { configurable: true, value: (id: number) => frames.delete(id) },
    });
    const owned: Array<{ id: string; state: ReturnType<typeof getTerminalRendererState> }> = [];
    function shell() {
        const id = `typography-fixture-${++serial}`;
        let redraws = 0;
        let clears = 0;
        const writes: PropertyKey[] = [];
        const options = new Proxy<ITerminalOptions>(
            {},
            {
                set(target, key, value: unknown) {
                    writes.push(key);
                    return Reflect.set(target, key, value);
                },
            },
        );
        const term = {
            options,
            rows: 24,
            refresh() {
                redraws++;
            },
        } as unknown as Terminal;
        const state = getTerminalRendererState(id);
        state.terminal = term;
        state.kind = 'webgl';
        state.webglAddon = {
            dispose() {},
            clearTextureAtlas() {
                clears++;
            },
        };
        terminalCache.set(id, { term } as TerminalCache);
        const result = {
            id,
            term,
            state,
            writes,
            get redraws() {
                return redraws;
            },
            get clears() {
                return clears;
            },
        };
        owned.push(result);
        return result;
    }
    return {
        shell,
        frames,
        paint() {
            const callbacks = [...frames.values()];
            frames.clear();
            for (const callback of callbacks) {
                callback(0);
            }
        },
        dispose() {
            for (const shell of owned) {
                shell.state.disposed = true;
                shell.state.terminal = undefined;
                shell.state.webglAddon = undefined;
                terminalCache.delete(shell.id);
                clearTerminalRendererSession(shell.id);
            }
            for (const [key, descriptor] of descriptors) {
                if (descriptor) {
                    Object.defineProperty(globalThis, key, descriptor);
                } else {
                    Reflect.deleteProperty(globalThis, key);
                }
            }
        },
    };
}

/** Mount the real theme hook with deterministic effects and renderer event delivery. */
function hookFixture() {
    type Cleanup = (() => void) | undefined;
    const listeners = new Set<(event: Event) => void>();
    let effects: Array<() => Cleanup> = [];
    const { useTerminalTheme } = loadProduction<
        typeof import('../../src/components/terminal/useTerminalTheme.js')
    >(
        'components/terminal/useTerminalTheme.ts',
        {
            react: {
                useMemo: (compute: () => unknown) => compute(),
                useEffect: (effect: () => Cleanup) => effects.push(effect),
            },
            '../../lib/terminal/terminalTypography.js': typography,
            '../../lib/terminal/terminalCache.js': { terminalCache },
            './terminalTheme.js': {
                resolveTerminalTransparency: () => ({}),
                buildTerminalHostStyle: () => ({}),
                resolveXtermTheme: () => ({}),
                applyXtermTheme() {},
            },
        },
        {
            window: {
                addEventListener: (_name: string, listener: (event: Event) => void) =>
                    listeners.add(listener),
                removeEventListener: (_name: string, listener: (event: Event) => void) =>
                    listeners.delete(listener),
            },
        },
    );
    return {
        mount(
            shell: ReturnType<ReturnType<typeof fixture>['shell']>,
            initialTerm: Terminal | null = shell.term,
        ) {
            const props: UseTerminalThemeOptions = {
                containerRef: { current: null },
                termRef: { current: initialTerm },
                settings: { theme: 'dark', terminal: { ...settings, fontWeight: 500 } },
                connection: null,
                sessionId: shell.id,
                isConnected: true,
            };
            let cleanup: Cleanup[] = [];
            const render = () => {
                for (const effect of cleanup) {
                    effect?.();
                }
                effects = [];
                useTerminalTheme(props);
                cleanup = effects.map((effect) => effect());
            };
            render();
            return { props, render, dispose: () => cleanup.forEach((effect) => effect?.()) };
        },
        emit(sessionId: string) {
            for (const listener of listeners) {
                listener({ detail: { sessionId } } as unknown as Event);
            }
        },
    };
}

test('foreground and background hooks update each owned terminal once, not the entire cache', () => {
    const owner = fixture();
    const hooks = hookFixture();
    const shells = [owner.shell(), owner.shell(), owner.shell(), owner.shell()];
    const mounted = shells.map((shell) => hooks.mount(shell));
    try {
        assert.equal(owner.frames.size, shells.length);
        assert.deepEqual(
            shells.map((shell) => shell.redraws),
            [1, 1, 1, 1],
        );
        owner.paint();
        assert.deepEqual(
            shells.map((shell) => shell.clears),
            [2, 2, 2, 2],
        );
        for (const shell of shells) {
            shell.writes.length = 0;
        }
        for (const hook of mounted) {
            hook.render();
        }
        assert.equal(owner.frames.size, 0, 'Unchanged settings schedule no paint');
        assert.deepEqual(
            shells.map((shell) => shell.writes.length),
            [0, 0, 0, 0],
        );
        assert.deepEqual(
            shells.map((shell) => shell.redraws),
            [2, 2, 2, 2],
        );
        for (const hook of mounted) {
            hook.props.settings.terminal = { ...hook.props.settings.terminal, fontSize: 17 };
            hook.render();
        }
        assert.deepEqual(
            shells.map((shell) => shell.writes),
            [['fontSize'], ['fontSize'], ['fontSize'], ['fontSize']],
        );
        assert.equal(owner.frames.size, shells.length);
        owner.paint();
        assert.deepEqual(
            shells.map((shell) => shell.redraws),
            [4, 4, 4, 4],
        );
        assert.deepEqual(
            shells.map((shell) => shell.term.options.fontWeightBold),
            [600, 600, 600, 600],
        );
    } finally {
        mounted.forEach((hook) => hook.dispose());
        owner.dispose();
    }
});

test('cursor-only and equivalent normalized weights do not invalidate the atlas', () => {
    const owner = fixture();
    const shell = owner.shell();
    try {
        typography.applyTerminalTypography(shell.id, shell.term, {
            ...settings,
            fontWeight: undefined,
        });
        owner.paint();
        shell.writes.length = 0;
        typography.applyTerminalTypography(shell.id, shell.term, {
            ...settings,
            fontWeight: 'normal',
            cursorStyle: 'bar',
        });
        assert.deepEqual(shell.writes, ['cursorStyle']);
        assert.equal(shell.clears, 2);
        assert.equal(shell.redraws, 2);
        assert.equal(owner.frames.size, 0);
    } finally {
        owner.dispose();
    }
});

test('retained disconnected shells receive typography without needing another connected hook', () => {
    const owner = fixture();
    const hooks = hookFixture();
    const shell = owner.shell();
    const mounted = hooks.mount(shell);
    try {
        owner.paint();
        mounted.props.isConnected = false;
        mounted.props.settings.terminal = { ...mounted.props.settings.terminal, fontSize: 19 };
        mounted.render();
        assert.equal(shell.term.options.fontSize, 19);
        assert.equal(owner.frames.size, 1);
        owner.paint();
        assert.equal(shell.redraws, 4);
    } finally {
        mounted.dispose();
        owner.dispose();
    }
});

test('a retained shell receives current typography before a remounted hook binds its terminal ref', () => {
    const owner = fixture();
    const hooks = hookFixture();
    const first = owner.shell();
    const other = owner.shell();
    typography.applyTerminalTypography(first.id, first.term, { ...settings, fontSize: 13 });
    typography.applyTerminalTypography(other.id, other.term, { ...settings, fontSize: 13 });
    owner.paint();
    const otherRedraws = other.redraws;
    const mounted = hooks.mount(first, null);
    try {
        assert.equal(first.term.options.fontSize, settings.fontSize);
        assert.equal(other.term.options.fontSize, 13);
        assert.equal(other.redraws, otherRedraws);
        owner.paint();
        mounted.props.isConnected = false;
        mounted.props.settings.terminal = { ...mounted.props.settings.terminal, fontSize: 19 };
        mounted.render();
        assert.equal(first.term.options.fontSize, 19);
        assert.equal(mounted.props.termRef.current, null);
        owner.paint();
        let clears = 0;
        first.state.webglAddon = {
            dispose() {},
            clearTextureAtlas() {
                clears++;
            },
        };
        hooks.emit(first.id);
        assert.equal(
            clears,
            1,
            'Renderer events also resolve only the retained owner before binding',
        );
        owner.paint();
        assert.equal(clears, 2);
        assert.equal(other.redraws, otherRedraws);
    } finally {
        mounted.dispose();
        owner.dispose();
    }
});

test('same-settings renderer replacement refreshes only its own terminal and platform spacing', () => {
    const owner = fixture();
    const hooks = hookFixture();
    const first = owner.shell();
    const second = owner.shell();
    const mounted = [hooks.mount(first), hooks.mount(second)];
    try {
        owner.paint();
        let newAtlasClears = 0;
        first.state.webglAddon = {
            dispose() {},
            clearTextureAtlas() {
                newAtlasClears++;
            },
        };
        hooks.emit(first.id);
        assert.equal(first.redraws, 3);
        assert.equal(second.redraws, 2);
        assert.equal(newAtlasClears, 1);
        owner.paint();
        assert.equal(newAtlasClears, 2);
        first.state.kind = 'dom';
        first.state.webglAddon = undefined;
        hooks.emit(first.id);
        assert.equal(first.term.options.letterSpacing, 0);
        assert.equal(second.term.options.letterSpacing, 1);
        owner.paint();
        assert.equal(second.redraws, 2);
    } finally {
        mounted.forEach((hook) => hook.dispose());
        owner.dispose();
    }
});

test('rapid typography edits share one paint; replaced and closed owners cannot redraw', () => {
    const owner = fixture();
    const shell = owner.shell();
    try {
        typography.applyTerminalTypography(shell.id, shell.term, settings);
        typography.applyTerminalTypography(shell.id, shell.term, { ...settings, fontSize: 16 });
        typography.applyTerminalTypography(shell.id, shell.term, { ...settings, fontSize: 17 });
        assert.equal(owner.frames.size, 1);
        owner.paint();
        assert.equal(shell.redraws, 4);
        typography.applyTerminalTypography(shell.id, shell.term, { ...settings, fontSize: 18 });
        terminalCache.set(shell.id, { term: {} as Terminal } as TerminalCache);
        owner.paint();
        assert.equal(shell.redraws, 5, 'A replaced cache owner rejects the deferred pass');
        const writes = shell.writes.length;
        typography.applyTerminalTypography(shell.id, shell.term, { ...settings, fontSize: 19 });
        assert.equal(shell.writes.length, writes, 'A stale caller cannot update its replacement');
        terminalCache.set(shell.id, { term: shell.term } as TerminalCache);
        typography.applyTerminalTypography(shell.id, shell.term, { ...settings, fontSize: 20 });
        shell.state.disposed = true;
        owner.paint();
        assert.equal(shell.redraws, 6, 'A closed renderer rejects the deferred pass');
    } finally {
        owner.dispose();
    }
});

test('initial uncached typography cannot repaint over a subsequently installed cache owner', () => {
    const owner = fixture();
    const shell = owner.shell();
    try {
        terminalCache.delete(shell.id);
        shell.state.terminal = undefined;
        typography.applyTerminalTypography(shell.id, shell.term, settings);
        terminalCache.set(shell.id, { term: {} as Terminal } as TerminalCache);
        owner.paint();
        assert.equal(shell.redraws, 1);
        assert.equal(shell.clears, 1);
    } finally {
        owner.dispose();
    }
});

test('an uncached renderer-owned terminal retains its post-paint measurement pass', () => {
    const owner = fixture();
    const shell = owner.shell();
    try {
        terminalCache.delete(shell.id);
        typography.applyTerminalTypography(shell.id, shell.term, settings);
        owner.paint();
        assert.equal(shell.redraws, 2);
        assert.equal(shell.clears, 2);
    } finally {
        owner.dispose();
    }
});
