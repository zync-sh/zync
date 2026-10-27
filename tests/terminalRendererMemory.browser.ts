import { Terminal } from '@xterm/xterm';

import {
    reactivateTerminalWebgl,
    syncTerminalRenderer,
} from '../src/lib/terminal/rendererController';
import {
    clearTerminalRendererSession,
    getTerminalRendererState,
    hasTerminalRendererSession,
} from '../src/lib/terminal/rendererSession';

declare global {
    interface Window {
        rendererMemoryChecks: {
            disposeCase: (shellBlink: boolean, serial: number) => Promise<void>;
            retained: () => { timers: number; terminals: number; canvases: number };
            lifecycle: () => Promise<void>;
        };
    }
}

function check(value: unknown, message: string): asserts value {
    if (!value) {
        throw new Error(message);
    }
}

// Store timer IDs only, never callbacks: instrumentation must not retain terminals itself.
const intervals = new Set<number>();
const originalSet = window.setInterval.bind(window);
const originalClear = window.clearInterval.bind(window);
window.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    const id = originalSet(callback, delay, ...args);
    intervals.add(id);
    return id;
}) as typeof window.setInterval;
window.clearInterval = (id) => {
    if (typeof id === 'number') {
        intervals.delete(id);
    }

    originalClear(id);
};
const weak: WeakRef<Terminal>[] = [];
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function createTerminal(cursorBlink = true) {
    const host = document.createElement('div');
    host.style.cssText = 'width:800px;height:400px';
    document.body.appendChild(host);
    const term = new Terminal({ cols: 80, rows: 24, cursorBlink, scrollback: 5000 });
    term.open(host);
    term.focus();
    return { term, host };
}

/** Exercise focused disposal after real blink timers and bounded scrollback allocations exist. */
async function disposeCase(shellBlink: boolean, serial: number): Promise<void> {
    const { term, host } = createTerminal(!shellBlink);
    const id = `memory-${serial}`;
    try {
        await syncTerminalRenderer(id, term, { gpuAcceleration: true });
        check(
            getTerminalRendererState(id).kind === 'webgl',
            'test must exercise real WebGL, not DOM fallback',
        );
        if (shellBlink) {
            await new Promise<void>((resolve) => term.write('\x1b[?12h', resolve));
        }
        for (let offset = 0; offset < 5000; offset += 100) {
            await new Promise<void>((resolve) =>
                term.write(
                    ('bounded regression data ' + '.'.repeat(50) + '\r\n').repeat(100),
                    resolve,
                ),
            );
        }
        await delay(850);
        check(intervals.size > 0, 'a real blinking cursor timer must exist before cleanup');
    } finally {
        clearTerminalRendererSession(id, term);
        term.dispose();
        host.remove();
        weak.push(new WeakRef(term));
    }
    check(!hasTerminalRendererSession(id), 'disposal removes session ownership');
    await delay(80);
}

/** Real addon checks for coalescing, focus/options preservation, replacement and context loss. */
async function lifecycle(): Promise<void> {
    const { term, host } = createTerminal();
    let loads = 0;
    const load = term.loadAddon.bind(term);
    term.loadAddon = (addon) => {
        loads++;
        load(addon);
    };
    try {
        const requests = Array.from({ length: 10 }, () =>
            syncTerminalRenderer('lifecycle', term, { gpuAcceleration: true }),
        );
        check(
            requests.every((request) => request === requests[0]),
            'overlapping startup shares one promise',
        );
        await Promise.all(requests);
        check(loads === 1, 'overlapping startup installs one real addon');
        await new Promise<void>((resolve) => term.write('renderer-sentinel\r\n', resolve));
        await delay(850);
        await syncTerminalRenderer('lifecycle', term, { gpuAcceleration: false });
        check(document.activeElement === term.textarea, 'DOM fallback preserves keyboard focus');
        check(term.options.cursorBlink, 'DOM fallback keeps the cursor preference');
        check(intervals.size === 0, 'DOM fallback clears the old WebGL blink timer');
        await syncTerminalRenderer('lifecycle', term, { gpuAcceleration: true });
        const before = loads;
        await Promise.all([
            reactivateTerminalWebgl('lifecycle', term),
            reactivateTerminalWebgl('lifecycle', term),
        ]);
        check(loads === before + 1, 'ligature reactivation creates only one replacement');
        check(document.activeElement === term.textarea, 'reactivation preserves focus');
        check(
            term.buffer.active.getLine(0)?.translateToString(true) === 'renderer-sentinel',
            'renderer changes preserve scrollback',
        );
        await delay(850);
        check([...intervals].length === 1, 'only the current renderer owns a blink timer');
        const gl = [...(term.element?.querySelectorAll('canvas') ?? [])]
            .map((canvas) => canvas.getContext('webgl2'))
            .find((context) => context !== null);
        const extension = gl?.getExtension('WEBGL_lose_context');
        check(extension, 'test requires supported WebGL context-loss simulation');
        host.style.display = 'none';
        extension.loseContext();
        const deadline = performance.now() + 6000;
        while (
            !getTerminalRendererState('lifecycle').webglContextLossBlocked &&
            performance.now() < deadline
        ) {
            await delay(50);
        }
        check(getTerminalRendererState('lifecycle').kind === 'dom', 'context loss settles on DOM');
        check(
            getTerminalRendererState('lifecycle').webglContextLossBlocked,
            'lost contexts remain blocked',
        );
        check(intervals.size === 0, 'lost-context disposal clears the blink timer');
        check(
            term.element?.querySelector('.xterm-rows'),
            'lost-context fallback restores the actual DOM renderer',
        );
        check(
            term.buffer.active.getLine(0)?.translateToString(true) === 'renderer-sentinel',
            'hidden context loss preserves scrollback',
        );
        host.style.display = '';
        term.refresh(0, term.rows - 1);
        await new Promise(requestAnimationFrame);
        check(
            term.element?.querySelector('.xterm-rows')?.textContent?.includes('renderer-sentinel'),
            'hidden context-loss recovery redraws existing text',
        );
    } finally {
        clearTerminalRendererSession('lifecycle', term);
        term.dispose();
        host.remove();
    }

    const closed = createTerminal();
    const pending = syncTerminalRenderer('reused-id', closed.term, { gpuAcceleration: true });
    clearTerminalRendererSession('reused-id', closed.term);
    closed.term.dispose();
    closed.host.remove();
    check(
        (await reactivateTerminalWebgl('reused-id', closed.term)) === 'dom',
        'late reactivation returns DOM for a closed session',
    );
    check(
        !hasTerminalRendererSession('reused-id'),
        'late reactivation cannot recreate a closed session',
    );
    const replacement = createTerminal();
    try {
        await syncTerminalRenderer('reused-id', replacement.term, { gpuAcceleration: true });
        check((await pending) === 'dom', 'closed startup never installs a late addon');
        check(
            getTerminalRendererState('reused-id').terminal === replacement.term,
            'late startup cannot take over a reused ID',
        );
    } finally {
        clearTerminalRendererSession('reused-id', replacement.term);
        replacement.term.dispose();
        replacement.host.remove();
    }
    await delay(80);
    check(intervals.size === 0, 'all lifecycle cases release their blink timers');
}

window.rendererMemoryChecks = {
    disposeCase,
    lifecycle,
    retained: () => ({
        timers: intervals.size,
        terminals: weak.filter((ref) => ref.deref()).length,
        canvases: document.querySelectorAll('canvas').length,
    }),
};
