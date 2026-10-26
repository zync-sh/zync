type LoadSource = (file: string, dependencies?: Record<string, unknown>, globals?: Record<string, unknown>) => any;
type LoadPure = (file: string) => any;
type Retry = 'vault-access' | 'vault-conversion' | 'failure';

/** Fail with state context while leaving assertions and fixture behavior in TypeScript. */
function equal(actual: unknown, expected: unknown, label: string): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

/** Run both production slices, including workspace allocation, with only native/auth/runtime boundaries isolated. */
export async function runFeatureConnectionWorkspaceChecks(loadSource: LoadSource, pure: LoadPure): Promise<void> {
    const layout = pure('lib/paneLayout/index.ts');
    let fixtureNumber = 0;

    function fixture({ terminals = false, retry }: { terminals?: boolean; retry?: Retry } = {}) {
        const id = `feature-connect-${++fixtureNumber}`;
        let state: any;
        let attempt = 0;
        let keyPreparation = 0;
        let serial = 0;
        const calls: string[] = [];
        const connects: Array<{ preserveWorkspace?: boolean; skipVaultPrompt?: boolean; skipCredentialPull?: boolean } | undefined> = [];
        const operations: Promise<void>[] = [];
        const microtasks: Array<() => void> = [];
        class KeyPassphrasePromptCancelledError extends Error {}
        class NetworkSelectionCancelledError extends Error {}
        class KeyPassphraseVaultRequestedError extends Error {
            constructor(public connectionId: string, public keyPath: string) { super('Save this key in Vault.'); }
        }
        const vaultState = { status: { status: 'unlocked', vaultId: 'vault-fixture' },
            requestUnlock: async () => { calls.push('vault-unlock'); return true; }, refreshItems: async () => {} };
        const dependencies: Record<string, unknown> = {
            './sessionSlice': { scheduleSaveSession: () => calls.push('save-session') },
            '../features/workspace/application/reconnectTerminal': pure('features/workspace/application/reconnectTerminal.ts'),
            '../features/workspace/domain/presentation': pure('features/workspace/domain/presentation.ts'),
            '../features/workspace/domain/registrations': pure('features/workspace/domain/registrations.ts'),
            '../features/workspace/domain/mainTabPresentation': pure('features/workspace/domain/mainTabPresentation.ts'),
            '../lib/paneCloseBlockers': {},
            '../features/connections/application/connectionService': {},
            '../features/connections/application/tabService': pure('features/connections/application/tabService.ts'),
            '../features/connections/application/connectionLifecycleService': pure('features/connections/application/connectionLifecycleService.ts'),
            '../features/connections/application/tunnelAutoStartService': {},
            '../features/usage': { track: () => {}, trackConnectSuccess: () => {}, trackConnectFailure: () => {} },
            '../features/tunnels/application/tunnelReconnectService': pure('features/tunnels/application/tunnelReconnectService.ts'),
            '../features/connections/domain': {
                connectConfigUsesVaultAuth: () => false,
                buildConnectConfigResult: () => ({ status: 'ok', config: { id, name: id, host: 'fixture.invalid', username: 'fixture', port: 22,
                    auth_method: { type: 'Password', password: 'synthetic-fixture-only' }, jump_host: null } }),
                buildDefaultKeyVaultLabel: () => 'Fixture key', buildUniqueVaultLabel: (label: string) => label,
            },
            '../features/connections/domain/errorSanitization': pure('features/connections/domain/errorSanitization.ts'),
            '../features/connections/application/hostKeyVerification': { connectWithHostKeyVerification: async () => {
                calls.push('host-key-connect'); attempt++;
                if (attempt === 1 && retry === 'vault-access') throw new Error('Vault is locked');
                if (attempt === 1 && retry === 'failure') throw new Error('Synthetic transport failure');
                return { detected_os: 'linux' };
            } },
            '../vault/useVaultStore': { useVaultStore: { getState: () => vaultState, setState: () => {} } },
            '../vault/vaultLoading': { isVaultInUseError: () => false },
            '../vault/vaultUnlockPrompt': { isVaultAccessError: (message: string) => message.includes('Vault is locked') },
            '../features/connections/application/ensureVaultCredentialForConnect': { ensureVaultCredentialForConnect: async () => 'ready' },
            '../features/connections/infrastructure/connectionIpc': { getRemoteCwdIpc: async () => '/home/fixture', readLocalKeyFileIpc: async () => 'synthetic-fixture-key' },
            '../vault/ipc': { vaultIpc: { status: async () => vaultState.status, itemList: async () => [],
                itemCreate: async () => ({ id: 'vault-item', logicalId: 'credential-fixture' }) } },
            '../lib/ghostSuggestions/client': {}, '../lib/ghostSuggestions/ghostDebug': {},
            '../features/connections/infrastructure/connectionOpQueue': pure('features/connections/infrastructure/connectionOpQueue.ts'),
            '../features/connections/infrastructure/connectCancelState': pure('features/connections/infrastructure/connectCancelState.ts'),
            '../lib/terminal/connectionBackend': { markConnectionBackendLive: () => calls.push('backend-live') },
            '../lib/terminal/suspendAllTerminals': {},
            '../features/connections/infrastructure/connectionPersistence': { saveConnectionsIpc: async () => {} },
            '../lib/shells/cache': {}, '../features/connections/domain/hostInventoryCache': {},
            '../lib/terminal': { resetTerminalPtyForReconnect: (term: string) => calls.push(`reset:${term}`),
                dispatchTerminalConnectionWakeup: (ids: string[]) => calls.push(`wake:${ids.join(',')}`) },
            '../lib/terminal/terminalCache': { terminalCache: { get: () => { calls.push('startup-shell'); return { spawned: true, starting: false }; } } },
            '../features/connections/domain/connectionDisplay.js': { DEFAULT_SHOW_HOST_ADDRESSES_IN_LISTS: true },
            '../vault/profileTypes': {},
            '../features/connections/application/keyPassphraseRuntime': { KeyPassphrasePromptCancelledError, KeyPassphraseVaultRequestedError,
                prepareConnectKeyPassphrases: async () => {
                    calls.push('key-preparation'); keyPreparation++;
                    if (keyPreparation === 1 && retry === 'vault-conversion') throw new KeyPassphraseVaultRequestedError(id, '/fixture/key');
                }, consumeVaultRequestedPassphrase: () => 'synthetic-fixture-passphrase', clearVaultRequestedPassphrase: () => {} },
            '../features/connections/application/networkInterface': { NetworkSelectionCancelledError,
                prepareNetworkInterface: async () => calls.push('network-selection') },
        };
        const globals = { console: { error: () => {} }, window: { ipcRenderer: {} }, performance: { now: () => 0 },
            crypto: { randomUUID: () => `fixture-${++serial}` }, queueMicrotask: (task: () => void) => microtasks.push(task) };
        const connectionSlice = loadSource('store/connectionSlice.ts', dependencies, globals);
        const uiSlice = loadSource('store/uiSlice.ts', {}, globals);
        const terminalSlice = loadSource('store/terminalSlice.ts', {
            '../features/usage': dependencies['../features/usage'], '../lib/terminal': {}, './sessionSlice': dependencies['./sessionSlice'],
            '../lib/paneCloseBlockers': {}, '../lib/paneLayout': layout, '../lib/paneLayout/groups': pure('lib/paneLayout/groups.ts'),
            '../features/workspace/application/viewRegistrationAdapters': pure('features/workspace/application/viewRegistrationAdapters.ts'),
            '../features/workspace/domain/dockingTopology': pure('features/workspace/domain/dockingTopology.ts'),
            '../features/workspace/domain/canvases': pure('features/workspace/domain/canvases.ts'),
            '../features/workspace/domain/docking': pure('features/workspace/domain/docking.ts'),
            '../features/workspace/domain/paneTabRelease': pure('features/workspace/domain/paneTabRelease.ts'),
            '../features/workspace/domain/contentPresentation': pure('features/workspace/domain/contentPresentation.ts'),
        }, globals);
        const audit = layout.singleFeaturePane('security', 'audit-pane', 'audit-instance');
        const snippets = layout.singleFeaturePane('snippets', 'snippets-pane', 'snippets-instance');
        const group = { ...audit, root: { type: 'split', id: 'feature-split', direction: 'horizontal', sizes: [0.5, 0.5], children: [audit.root, snippets.root] } };
        const dashboard = layout.singleFeaturePane('dashboard', 'dashboard-pane', 'dashboard-instance');
        const dashboardKey = layout.paneContentKey(dashboard.root.content, dashboard.root.id);
        const set = (patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
        state = { ...connectionSlice.createConnectionSlice(set, () => state), ...terminalSlice.createTerminalSlice(set, () => state), ...uiSlice.createUiSlice(set, () => state),
            connections: [{ id, name: id, host: 'fixture.invalid', username: 'fixture', port: 22, status: 'disconnected', privateKeyPath: '/fixture/key' }],
            tabs: [{ id: 'host-tab', type: 'connection', connectionId: id, view: 'security' }], activeTabId: 'host-tab', activeConnectionId: id,
            terminals: { [id]: terminals ? [{ id: 'retained-shell', title: 'Existing shell', pendingRestore: true }] : [] }, activeTerminalIds: {},
            paneLayouts: { [id]: { 'audit-instance': group, 'dashboard-instance': dashboard } }, activePaneGroupOwner: { [id]: 'audit-instance' },
            workspaceDocking: { [id]: { version: 1, placements: { [dashboardKey]: 'primary-sidebar',
                ...(terminals && { '["term","retained-shell"]': 'bottom-panel' }) } } }, workspaceDockFocus: { [id]: dashboardKey },
            settings: { ghostSuggestions: { importRemoteHistoryOnConnect: false } }, tunnels: { [id]: [] },
            showToast: () => {}, showConfirmDialog: async () => true, loadTunnels: async () => {}, saveSession: async () => {},
            editConnection: async (connection: any) => set({ connections: [connection] }),
        };
        const connect = state.connect;
        state.connect = (connectionId: string, options?: typeof connects[number]) => {
            connects.push(options); const operation = connect(connectionId, options); operations.push(operation); return operation;
        };
        const before = { tabs: state.tabs, activeTerminalIds: state.activeTerminalIds, paneLayouts: state.paneLayouts,
            activePaneGroupOwner: state.activePaneGroupOwner, workspaceDocking: state.workspaceDocking, workspaceDockFocus: state.workspaceDockFocus };
        /** Drain explicit retry scheduling only after the serialized operation has released its owner. */
        const drain = async () => {
            let completed = 0;
            while (completed < operations.length || microtasks.length) {
                await Promise.all(operations.slice(completed)); completed = operations.length;
                while (microtasks.length) microtasks.shift()!();
            }
        };
        return { id, get: () => state, calls, connects, before, drain };
    }

    /** Connection metadata and existing PTY readiness may change; workspace identity and selection may not. */
    function unchanged(subject: ReturnType<typeof fixture>): void {
        for (const [key, value] of Object.entries(subject.before)) {
            if (subject.get()[key] !== value) throw new Error(`Feature connect changed ${key}`);
        }
        equal(subject.get().activeTabId, 'host-tab', 'Selected host tab remains active');
        equal(subject.get().connections[0].status, 'connected', 'Shared connection flow completes');
        equal(subject.get().connections[0].homePath, '/home/fixture', 'Connection metadata still loads');
    }

    {
        const subject = fixture();
        subject.get().openSecurityAuditsTab();
        const first = subject.get().tabs.find((tab: any) => tab.type === 'security-audits');
        equal(subject.get().globalSidebarSection, null, 'Direct audit opening clears the default sidebar selection so the audit tab is highlighted');
        equal(subject.get().lastGlobalSidebarSection, 'hosts', 'Opening audits retains the sidebar destination for later reopening');
        equal(subject.get().globalSidebarSelectionRevision, 1, 'Audit opening advances sidebar action ownership through the shared setter');
        subject.get().setGlobalSidebarSection('plugins');
        subject.get().openSecurityAuditsTab();
        equal(subject.get().globalSidebarSection, null, 'Reopening the existing audit tab also clears a subsequently selected sidebar section');
        equal(subject.get().lastGlobalSidebarSection, 'plugins', 'Repeated audit opening preserves the latest remembered sidebar destination');
        equal(subject.get().globalSidebarSelectionRevision, 3, 'Repeated audit opening cannot be rolled back by an older sidebar action');
        equal(subject.get().tabs.length, 2, 'Global audit navigation reuses one library tab alongside the host workspace');
        equal(subject.get().activeTabId, first.id, 'Repeated global audit navigation selects the same tab');
        equal(first.title, 'Security hardening audit', 'The global library uses the canonical feature name');
        equal(subject.get().activeConnectionId, null, 'The global audit library owns no live host connection');
        equal(subject.connects, [], 'Opening the global audit library never connects a host');
        equal(subject.get().terminals[subject.id], [], 'Opening the global audit library creates no shell');
        subject.get().restoreTabState([{ ...first, tabType: first.type, connectionId: subject.id }], first.id, subject.id);
        equal(subject.get().tabs[0].type, 'security-audits', 'The global audit destination survives session restoration');
        equal(subject.get().tabs[0].view, 'security', 'Restored global audit tabs retain their stable view identity');
        equal(subject.get().activeConnectionId, null, 'Restoring the global audit library does not select or connect a host');
        equal(subject.get().tabs[0].connectionId, undefined, 'Restored global audit tabs never inherit a stale host association');
        equal(subject.connects, [], 'Session restoration never starts an audit host connection');
    }

    for (const terminals of [false, true]) {
        const subject = fixture({ terminals });
        await subject.get().connect(subject.id, { preserveWorkspace: true }); await subject.drain(); unchanged(subject);
        equal(subject.get().terminals[subject.id].map((item: any) => item.id), terminals ? ['retained-shell'] : [], 'Feature reconnect retains terminal inventory');
        equal(subject.calls.filter(call => call.startsWith('reset:')), terminals ? ['reset:retained-shell'] : [], 'Existing shell PTYs reset');
        equal(subject.calls.filter(call => call.startsWith('wake:')), terminals ? ['wake:retained-shell'] : ['wake:'], 'Existing shell PTYs wake');
        equal(subject.calls.includes('startup-shell'), terminals, 'Visible retained shell keeps first reconnect channel');
        if (terminals) equal(Boolean(subject.get().terminals[subject.id][0].pendingRestore), false, 'Restored shell can resume');
    }
    {
        const subject = fixture();
        await subject.get().connect(subject.id); await subject.drain();
        equal(subject.get().terminals[subject.id].map((item: any) => item.title), ['Shell 1'], 'Default terminal connect still bootstraps a shell');
        equal(subject.get().activePaneGroupOwner[subject.id], null, 'Default terminal connect selects its new shell');
        equal(subject.get().workspaceDockFocus[subject.id], null, 'Default shell selection retains existing dock-focus semantics');
    }
    for (const retry of ['vault-access', 'vault-conversion'] as const) {
        const subject = fixture({ retry });
        await subject.get().connect(subject.id, { preserveWorkspace: true, skipCredentialPull: true }); await subject.drain(); unchanged(subject);
        equal(subject.connects, [{ preserveWorkspace: true, skipCredentialPull: true },
            { preserveWorkspace: true, skipCredentialPull: true, skipVaultPrompt: true }], `${retry}: recursive retry retains bootstrap and credential options`);
        equal(subject.calls.filter(call => call === 'vault-unlock').length, 1, `${retry}: the existing Vault prompt remains the retry owner`);
        equal(subject.get().terminals[subject.id], [], `${retry}: retry creates no shell`);
    }
    {
        const subject = fixture({ retry: 'failure' });
        await subject.get().connect(subject.id, { preserveWorkspace: true }); await subject.drain();
        equal(subject.get().connections[0].status, 'error', 'Failed feature connect reports the existing connection error');
        await subject.get().connect(subject.id, { preserveWorkspace: true }); await subject.drain(); unchanged(subject);
        equal(subject.get().terminals[subject.id], [], 'Explicit Retry creates no shell');
    }

    // Exercise the production UI/store adapters so feature callers cannot regress to terminal bootstrap.
    {
        const subject = fixture();
        const store = Object.assign((selector: (state: any) => unknown) => selector(subject.get()), { getState: subject.get });
        const jsx = (type: unknown, props: any) => ({ type, props });
        const notice = loadSource('components/connections/HostConnectionNotice.tsx', {
            react: { useEffect: () => {}, useRef: () => ({ current: null }), useState: (value: unknown) => [value, () => {}] },
            'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': {}, '../../store/useAppStore': { useAppStore: store },
            '../../lib/utils': { cn: (...parts: unknown[]) => parts.join(' ') }, '../ui/Button': { Button: 'Button' },
            '../../features/connections/domain/formPresentation': {},
        }).HostConnectionNotice({ connectionId: subject.id, description: 'Connect to continue.' });
        const findConnect = (node: any): any => {
            if (!node || typeof node !== 'object') return undefined;
            if (node.type === 'Button' && node.props.children === 'Connect') return node;
            return [node.props?.children].flat().map(findConnect).find(Boolean);
        };
        const button = findConnect(notice);
        if (!button) throw new Error('Production connection notice must expose Connect');
        button.props.onClick(); await subject.drain(); unchanged(subject);
        equal(subject.connects, [{ preserveWorkspace: true }], 'Feature connection notice requests workspace preservation');
    }
    {
        const subject = fixture();
        const adapter = loadSource('features/tunnels/application/userTunnelStoreActions.ts', {
            '../../../store/useAppStore': { useAppStore: { getState: subject.get } },
            './userTunnelActions': { createUserTunnelActions: (dependencies: unknown) => dependencies },
        }).userTunnelActions;
        await adapter.connect(subject.id); await subject.drain(); unchanged(subject);
        equal(subject.connects, [{ preserveWorkspace: true }], 'Explicit tunnel connection requests workspace preservation');
    }
}
