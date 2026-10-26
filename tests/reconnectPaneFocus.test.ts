type ElementNode = { type: unknown; props: Record<string, unknown> };
type SourceLoader = (path: string, dependencies: Record<string, unknown>, globals?: Record<string, unknown>) => Record<string, unknown>;
type Effect = () => (() => void) | void;

/** Exercise production pane wiring and reconnect listeners with only React/DOM boundaries substituted. */
export function runReconnectPaneFocusChecks(loadSource: SourceLoader): void {
    function equal(actual: unknown, expected: unknown, label: string): void {
        if (actual !== expected) throw new Error(`${label}: ${String(actual)} !== ${String(expected)}`);
    }
    const jsx = (type: unknown, props: Record<string, unknown>): ElementNode => ({ type, props });
    const state = {
        connections: [{ id: 'remote', name: 'Fixture', host: 'fixture.invalid', username: 'fixture', status: 'disconnected' }],
        activeConnectionId: 'remote', activeTabId: 'host-tab', terminals: { remote: [{ id: 'shell', pendingRestore: true }] },
        settings: { terminal: {}, ghostSuggestions: {} }, connect: () => {}, openConnectionModal: () => {}, openVaultTab: () => {}, setTabView: () => {},
    };
    const store = { useAppStore: (selector: (value: typeof state) => unknown) => selector(state) };
    const react = {
        memo: (component: unknown) => component,
        useCallback: (callback: unknown) => callback,
        useEffect: () => {},
        useMemo: (factory: () => unknown) => factory(),
        useRef: (current: unknown) => ({ current }),
        useState: (initial: unknown) => [initial, () => {}],
    };
    const { TerminalComponent } = loadSource('components/terminal/Terminal.tsx', {
        react, 'react/jsx-runtime': { jsx, jsxs: jsx }, '@xterm/xterm/css/xterm.css': {},
        '../../store/useAppStore': store, '../../lib/terminal/connectionIds.js': { LOCAL_TERMINAL_CONNECTION_ID: 'local' },
        './useTerminalTheme': { useTerminalTheme: () => ({ terminalTransparency: { enabled: false } }) },
        './useTerminalLifecycle': { useTerminalLifecycle: () => ({}) },
        './useTerminalSearch': { useTerminalSearch: () => ({}) }, './useTerminalGhost': { useTerminalGhost: () => ({}) },
        './useTerminalKeybindings': { useTerminalKeybindings: () => ({}) },
        './useTerminalGlobalShortcuts': { useTerminalGlobalShortcuts: () => ({ copied: false }) },
        './TerminalDisconnectedView': { TerminalDisconnectedView: 'Disconnected' }, './TerminalHost': { TerminalHost: 'TerminalHost' },
    }) as { TerminalComponent: (props: Record<string, unknown>) => ElementNode };
    const renderTerminal = (props: Record<string, unknown>) => TerminalComponent({ connectionId: 'remote', termId: 'shell', ...props });
    const focused = renderTerminal({ isFocused: true });
    const sibling = renderTerminal({ isFocused: false });
    equal(focused.props.isSurfaceActive, true, 'Focused restored terminal owns reconnect input');
    equal(sibling.props.isSurfaceActive, false, 'Visible sibling terminal does not register reconnect input');
    for (const hiddenBy of ['isVisible', 'isWorkspaceActive', 'isTerminalView']) {
        equal(renderTerminal({ isFocused: true, [hiddenBy]: false }).props.isSurfaceActive, false, `${hiddenBy} disables reconnect input`);
    }
    equal(renderTerminal({ isActiveTab: false }).props.isSurfaceActive, false, 'Legacy standalone activity remains the fallback');
    equal(renderTerminal({ isActiveTab: false, isFocused: true }).props.isSurfaceActive, true, 'Docked focused terminal does not depend on center-tab activity');

    const { FeaturePaneBody } = loadSource('components/terminal/FeaturePaneBody.tsx', {
        react: { lazy: () => 'LazyPane', Suspense: 'Suspense' }, 'react/jsx-runtime': { jsx, jsxs: jsx },
        '../ErrorBoundary': { ErrorBoundary: 'Boundary' },
        '../../context/PluginContext': { usePlugins: () => ({ panels: [], loaded: true }) },
        '../plugins/PluginUnavailable': {},
    }) as { FeaturePaneBody: (props: Record<string, unknown>) => ElementNode };
    for (const visible of [false, true]) for (const focused of [false, true]) {
        const body = FeaturePaneBody({ connectionId: 'remote', featureId: 'files', instanceId: 'files', visible, focused });
        const boundary = (body.props.children as Array<ElementNode | false>).find(child => child && (child.props.children as ElementNode)?.props.surface === 'pane') as ElementNode;
        const files = boundary.props.children as ElementNode;
        equal(files.props.active, visible, 'Files listing activity still follows visibility, including an unfocused split');
        equal(files.props.focused, focused, 'Files reconnect input receives independent renderer focus');

        const auditBody = FeaturePaneBody({ connectionId: 'remote', featureId: 'security', visible, focused });
        const auditBoundary = (auditBody.props.children as Array<ElementNode | false>).find(child => child && child.type === 'Boundary') as ElementNode;
        const audit = auditBoundary.props.children as ElementNode;
        equal(audit.props.visible, visible, 'Audit reconnect receives renderer visibility independently');
        equal(audit.props.focused, focused, 'Audit reconnect receives renderer keyboard ownership independently');
    }

    const listeners = new Set<(event: Record<string, unknown>) => void>();
    let effects: Effect[] = [];
    let autofocuses = 0;
    const { TerminalDisconnectedView } = loadSource('components/terminal/TerminalDisconnectedView.tsx', {
        react: { ...react, useEffect: (effect: Effect) => { effects.push(effect); },
            useRef: () => ({ current: { focus: () => { autofocuses++; } } }) },
        'react/jsx-runtime': { jsx, jsxs: jsx },
        'lucide-react': { AlertCircle: 'Icon', FolderOpen: 'Icon', KeyRound: 'Icon', PlugZap: 'Icon', RefreshCw: 'Icon', Terminal: 'Icon' },
        '../ui/Button': { Button: 'Button' }, '../../store/useAppStore': store,
        '../../features/connections/domain/connectionConfig': { connectionUsesVaultAuth: () => false },
        '../../features/connections/presentation/useConnectionDisplayLabels': { useConnectionDisplayLabels: () => ({ primary: 'Fixture', secondary: 'fixture' }) },
        '../../lib/relativeTime': { formatLastConnectedLabel: () => '' }, '../../lib/utils.js': { cn: () => '' },
    }, { window: {
        requestAnimationFrame: (callback: () => void) => { callback(); return 1; }, cancelAnimationFrame: () => {},
        addEventListener: (_name: string, listener: (event: Record<string, unknown>) => void) => listeners.add(listener),
        removeEventListener: (_name: string, listener: (event: Record<string, unknown>) => void) => listeners.delete(listener),
    } }) as { TerminalDisconnectedView: (props: Record<string, unknown>) => ElementNode };
    const cleanups: Array<() => void> = [];
    let reconnects = 0;
    for (const node of [focused, sibling]) {
        effects = [];
        TerminalDisconnectedView({ ...node.props, onReconnect: () => { reconnects++; } });
        for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
    }
    equal(autofocuses, 1, 'Only one restored split pane requests autofocus');
    equal(listeners.size, 1, 'Only one restored split pane installs the global Enter listener');
    let prevented = 0;
    for (const listener of listeners) listener({ key: 'Enter', target: null, preventDefault: () => { prevented++; } });
    equal(reconnects, 1, 'Enter launches exactly one reconnect across visible split terminals');
    equal(prevented, 1, 'Only the focused reconnect handler consumes Enter');
    cleanups.forEach(cleanup => cleanup());
    equal(listeners.size, 0, 'Unmount removes the focused reconnect listener');
}

/** Reconnect focus is a one-shot permission that cannot survive a lost pane owner. */
export function runConnectionFocusChecks(loadSource: SourceLoader): void {
    function equal(actual: unknown, expected: unknown, label: string): void {
        if (actual !== expected) throw new Error(`${label}: ${String(actual)} !== ${String(expected)}`);
    }
    type Slot = { current?: unknown; value?: unknown; dependencies?: readonly unknown[]; cleanup?: () => void };
    const slots: Slot[] = [];
    let cursor = 0;
    let effects: Array<() => void> = [];
    const same = (left: readonly unknown[] | undefined, right: readonly unknown[]) => left?.length === right.length
        && left.every((value, index) => Object.is(value, right[index]));
    const effect = (callback: Effect, dependencies: readonly unknown[]) => {
        const index = cursor++;
        const previous = slots[index];
        if (same(previous?.dependencies, dependencies)) return;
        effects.push(() => {
            previous?.cleanup?.();
            const cleanup = callback();
            slots[index] = { dependencies, cleanup: cleanup || undefined };
        });
    };
    const listeners = new Map<string, Set<(event: { target: unknown; type: string }) => void>>();
    const eventTarget = {
        addEventListener: (name: string, callback: (event: { target: unknown; type: string }) => void) => {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name)!.add(callback);
        },
        removeEventListener: (name: string, callback: (event: { target: unknown; type: string }) => void) => { listeners.get(name)?.delete(callback); },
    };
    const document: { activeElement: unknown; body: object; defaultView: typeof eventTarget } & typeof eventTarget = {
        ...eventTarget, activeElement: null, body: {}, defaultView: eventTarget,
    };
    class TestNode {
        ownerDocument = document;
        contains(node: unknown) { return node === this; }
    }
    const source = new TestNode();
    let focuses = 0;
    const target = { current: { isConnected: true, getClientRects: () => [1], focus: () => { focuses++; } } };
    const { useConnectionFocus } = loadSource('features/connections/presentation/useConnectionFocus.ts', {
        react: {
            useRef: (initial: unknown) => slots[cursor++] ??= { current: initial },
            useCallback: (callback: unknown, dependencies: readonly unknown[]) => {
                const index = cursor++;
                if (!same(slots[index]?.dependencies, dependencies)) slots[index] = { value: callback, dependencies };
                return slots[index].value;
            },
            useLayoutEffect: effect, useEffect: effect,
        },
    }, { Node: TestNode }) as { useConnectionFocus: (connected: boolean, target: unknown, id: string, active?: boolean) => (source: unknown) => (success: boolean) => void };
    function render(connected = false, active?: boolean, id = 'remote') {
        cursor = 0; effects = [];
        const begin = useConnectionFocus(connected, target, id, active);
        effects.forEach(run => run());
        return begin;
    }
    const count = () => [...listeners.values()].reduce((total, handlers) => total + handlers.size, 0);
    function begin(active?: boolean, id = 'remote') {
        const callback = render(false, active, id);
        document.activeElement = source;
        return callback(source);
    }
    function bodyFocus() { document.activeElement = document.body; }

    begin(); bodyFocus(); render(true);
    equal(focuses, 1, 'Standalone callers retain the successful reconnect focus handoff');
    equal(count(), 0, 'Successful handoff removes all temporary listeners');

    begin(true); bodyFocus(); render(false, false); render(false, true); render(true, true);
    equal(focuses, 1, 'Losing and regaining logical ownership permanently revokes the pending handoff');
    equal(count(), 0, 'Ownership loss disposes temporary listeners');
    begin(false); bodyFocus(); render(true, true);
    equal(focuses, 1, 'A visible but unfocused surface cannot start a handoff');
    begin(true); bodyFocus(); render(true, false);
    equal(focuses, 1, 'Simultaneous connection success and ownership loss cannot focus the destination');

    const cancelled = begin(true); cancelled(false); bodyFocus(); render(true, true);
    equal(focuses, 1, 'A cancelled or failed attempt cannot hand focus to controls');
    begin(true); bodyFocus(); render(false, true, 'other'); render(true, true, 'other');
    equal(focuses, 1, 'Changing hosts cancels the previous host focus permission');
    begin(true, 'other');
    for (const handler of listeners.get('focusin') ?? []) handler({ target: new TestNode(), type: 'focusin' });
    bodyFocus(); render(true, true, 'other');
    equal(focuses, 1, 'An explicit DOM focus move still cancels the handoff');
    begin(true, 'other');
    for (const handler of listeners.get('blur') ?? []) handler({ target: null, type: 'blur' });
    bodyFocus(); render(true, true, 'other');
    equal(focuses, 1, 'Leaving the window still cancels the handoff');

    const stale = begin(true, 'other');
    begin(true, 'other'); stale(false); bodyFocus(); render(true, true, 'other');
    equal(focuses, 2, 'A stale attempt completion cannot cancel a newer handoff');
    begin(true, 'other'); bodyFocus(); target.current.isConnected = false; render(true, true, 'other');
    equal(focuses, 2, 'Unmounted destinations never receive focus');
    target.current.isConnected = true;
    begin(true, 'other'); slots.forEach(slot => slot.cleanup?.());
    equal(count(), 0, 'Unmount releases pending reconnect listeners');
}

interface FileActivationProps {
    isFilesSurfaceActive: boolean; focused?: boolean; surface: 'pane' | 'overlay';
    focusOnActivation(): void; containerRef: { current: object };
}
type FileActivationRenderer = (props: FileActivationProps) => void;

/** Two visible Files panes share an activation event but retain one current focus owner. */
export function runFilePaneActivationChecks(createRenderer: (react: Record<string, unknown>, globals: Record<string, unknown>) => FileActivationRenderer): void {
    function equal(actual: unknown, expected: unknown, label: string): void {
        if (actual !== expected) throw new Error(`${label}: ${String(actual)} !== ${String(expected)}`);
    }
    type EffectSlot = { dependencies: readonly unknown[]; cleanup?: () => void };
    type Pane = { slots: unknown[]; props: FileActivationProps; focuses: number; id: string };
    const listeners = new Set<() => void>();
    let current!: Pane;
    let cursor = 0;
    let scheduled: Array<() => void> = [];
    let focusedTarget = 'outside';
    const render = createRenderer({
        useRef: (initial: unknown) => current.slots[cursor++] ??= { current: initial },
        useEffect: (effect: Effect, dependencies: readonly unknown[]) => {
            const pane = current;
            const index = cursor++;
            const previous = pane.slots[index] as EffectSlot | undefined;
            if (previous && dependencies.length === previous.dependencies.length
                && dependencies.every((value, position) => Object.is(value, previous.dependencies[position]))) return;
            scheduled.push(() => {
                previous?.cleanup?.();
                const cleanup = effect();
                pane.slots[index] = { dependencies, cleanup: cleanup || undefined };
            });
        },
    }, {
        isFileManagerPanelShown: () => true,
        window: { addEventListener: (_name: string, callback: () => void) => listeners.add(callback),
            removeEventListener: (_name: string, callback: () => void) => listeners.delete(callback) },
    });
    function pane(id: string, focused?: boolean, surface: 'pane' | 'overlay' = 'pane'): Pane {
        const item: Pane = { id, focuses: 0, slots: [], props: { isFilesSurfaceActive: true, focused, surface,
            containerRef: { current: {} }, focusOnActivation: () => { item.focuses++; focusedTarget = item.id; } } };
        return item;
    }
    function update(item: Pane, patch: Partial<FileActivationProps> = {}) {
        current = item; cursor = 0; scheduled = [];
        item.props = { ...item.props, ...patch };
        render(item.props);
        scheduled.forEach(effect => effect());
    }
    function unmount(item: Pane) { item.slots.forEach(slot => (slot as EffectSlot).cleanup?.()); }
    const first = pane('first-listing', true);
    const second = pane('second-listing', false);
    update(first); update(second);
    equal(first.focuses, 1, 'Focused Files pane activates its listing on visibility');
    equal(second.focuses, 0, 'Visible unfocused Files pane never grabs activation focus');
    equal(listeners.size, 2, 'Each visible Files instance owns and cleans up its event subscription');
    listeners.forEach(listener => listener());
    equal(first.focuses, 2, 'Explicit panel-show event still activates the focused Files pane');
    equal(second.focuses, 0, 'Broadcast activation cannot steal focus into a visible sibling');

    focusedTarget = 'second-toolbar-input';
    update(first, { focused: false }); update(second, { focused: true });
    equal(focusedTarget, 'second-toolbar-input', 'Focus-only pane transition preserves the explicitly clicked input');
    equal(second.focuses, 0, 'Focus-only rerender does not replay visibility autofocus');
    listeners.forEach(listener => listener());
    equal(first.focuses, 2, 'Existing event handler sees that the former owner lost focus');
    equal(second.focuses, 1, 'Existing event handler reads the newly focused pane without remount');
    update(second, { isFilesSurfaceActive: false });
    listeners.forEach(listener => listener());
    equal(second.focuses, 1, 'A hidden focused Files pane cannot reactivate through the event');
    unmount(first); unmount(second);
    equal(listeners.size, 0, 'Unmount removes both pane activation listeners');

    const legacy = pane('standalone-listing', undefined, 'overlay');
    update(legacy);
    equal(legacy.focuses, 0, 'Overlay keeps its existing explicit activation trigger');
    listeners.forEach(listener => listener());
    equal(legacy.focuses, 1, 'Standalone Files retains explicit panel-show focus without renderer focus input');
    unmount(legacy);
    equal(listeners.size, 0, 'Standalone listener also cleans up');
}
