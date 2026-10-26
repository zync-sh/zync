import { markConnectionStatus } from '../src/features/connections/application/connectionLifecycleService';
import { snapshotActiveTunnelsForReconnect, restartTunnelsAfterConnect } from '../src/features/tunnels/application/tunnelReconnectService';
import * as operationQueue from '../src/features/connections/infrastructure/connectionOpQueue';
import * as cancellation from '../src/features/connections/infrastructure/connectCancelState';

const fsModule = 'node:fs'; const vmModule = 'node:vm'; const tsModule = 'typescript';
const { readFileSync } = await import(fsModule);
const { runInNewContext } = await import(vmModule);
const tsImport = await import(tsModule);
const ts = tsImport.default ?? tsImport;
function check(condition: unknown, message: string): void { if (!condition) throw new Error(message); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
let fixtureId = 0;

/** Exercise both production slices with only native/auth/terminal boundaries isolated, using the existing VM fixture pattern. */
function fixture(options: { terminals?: boolean; disconnectFails?: boolean; refreshFailsAfterTeardown?: boolean } = {}) {
    const id = `tunnel-lifecycle-${++fixtureId}`;
    let state: any;
    let tornDown = false;
    const calls: string[] = [];
    const ready = deferred(); const release = deferred();
    const invoke = async (command: string) => {
        calls.push(command);
        if (command === 'tunnel:list') {
            if (tornDown && options.refreshFailsAfterTeardown) throw new Error('Synthetic runtime read failure');
            return state.tunnels[id].map((tunnel: { status: string }) => tornDown && tunnel.status === 'active' ? { ...tunnel, status: 'stopped' } : tunnel);
        }
        if (command === 'tunnel:reconcileConnection') { tornDown = true; return; }
        if (command === 'disconnect' || command === 'transport-lost') {
            tornDown = true;
            if (options.disconnectFails) throw new Error('Synthetic teardown failure');
            return;
        }
        if (command === 'cancel-connect') return;
        throw new Error(`Unexpected lifecycle command: ${command}`);
    };
    const services: Record<string, unknown> = {
        '/application/connectionLifecycleService': { markConnectionStatus },
        '/application/tunnelReconnectService': { snapshotActiveTunnelsForReconnect },
        '/infrastructure/connectionOpQueue': operationQueue,
        '/infrastructure/connectCancelState': cancellation,
        '/infrastructure/connectionIpc': {
            disconnectIpc: () => invoke('disconnect'), transportLostIpc: () => invoke('transport-lost'), cancelConnectIpc: () => invoke('cancel-connect'),
        },
        '/terminal/connectionBackend': { markConnectionBackendOffline: () => calls.push('backend-offline') },
        '/terminal/suspendAllTerminals': { suspendAllTerminalsForConnection: () => calls.push('suspend-terminals') },
        '/application/networkInterface': { cancelNetworkPrompts: () => {}, prepareNetworkInterface: async () => {} },
        '/application/keyPassphraseRuntime': { prepareConnectKeyPassphrases: async () => {} },
        '/application/hostKeyVerification': { connectWithHostKeyVerification: async () => {
            calls.push('native-connect-pending'); ready.resolve(); await release.promise; return { success: true };
        } },
        '/connections/domain': {
            connectConfigUsesVaultAuth: () => false,
            buildConnectConfigResult: () => ({ status: 'ready', config: { id, name: id, host: 'fixture.invalid', username: 'fixture', port: 22,
                auth_method: { type: 'Password', password: 'synthetic-fixture-only' }, jump_host: null } }),
        },
    };
    const load = (path: string) => {
        const context = { exports: {} as Record<string, any>, console: { error() {} },
            window: { ipcRenderer: { invoke } }, crypto: { randomUUID: () => `attempt-${id}` },
            require: (name: string) => Object.entries(services).find(([suffix]) => name.endsWith(suffix))?.[1] ?? {},
        };
        const { outputText } = ts.transpileModule(readFileSync(path, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        });
        runInNewContext(outputText, context); return context.exports;
    };
    const connections = load('src/store/connectionSlice.ts'); const tunnels = load('src/store/tunnelSlice.ts');
    const set = (patch: any) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; };
    state = { ...connections.createConnectionSlice(set, () => state, {}), ...tunnels.createTunnelSlice(set, () => state, {}),
        connections: [{ id, name: id, host: 'fixture.invalid', username: 'fixture', port: 22, password: 'synthetic-fixture-only', status: 'connected' }],
        terminals: options.terminals ? { [id]: [{ id: 'retained-terminal' }] } : {},
        tunnels: { [id]: [
            { id: 'active', connectionId: id, status: 'active' }, { id: 'stopped', connectionId: id, status: 'stopped' },
            { id: 'error', connectionId: id, status: 'error', error: 'Recorded bind conflict' },
        ] },
    };
    return { id, get: () => state, calls, ready, release };
}

/** A runtime clear never erases remembered active-forward IDs or unrelated stopped/error records. */
async function verifyStoppedAndRemembered(subject: ReturnType<typeof fixture>, label: string) {
    const state = subject.get();
    check(state.connections[0].status === 'disconnected', `${label}: host becomes disconnected`);
    check(state.tunnels[subject.id][0].status === 'stopped', `${label}: renderer runtime flags stop`);
    check(state.tunnels[subject.id][1].status === 'stopped' && state.tunnels[subject.id][2].error === 'Recorded bind conflict', `${label}: configuration and other errors remain recorded`);
    state.markAllTunnelsStoppedForConnection(subject.id);
    check(subject.get().tunnels === state.tunnels, `${label}: repeated lifecycle cleanup preserves unchanged list identity`);
    const restarted: string[] = [];
    await restartTunnelsAfterConnect({ connectionId: subject.id, tunnels: state.tunnels[subject.id],
        startTunnel: async id => { restarted.push(id); }, onTunnelError: () => {} });
    check(restarted.join(',') === 'active', `${label}: the pre-clear active forward remains eligible for reconnect restoration`);
}

for (const terminals of [false, true]) {
    for (const disconnectFails of [false, true]) {
        const subject = fixture({ terminals, disconnectFails });
        await subject.get().disconnect(subject.id);
        await verifyStoppedAndRemembered(subject, `Explicit disconnect (terminals=${terminals}, native failure=${disconnectFails})`);
        if (terminals) check(subject.get().terminals[subject.id][0].pendingRestore === true, 'The terminal-preserving early return also clears tunnel runtime flags');
    }
}
{
    const subject = fixture({ refreshFailsAfterTeardown: true });
    await subject.get().handleTransportLost(subject.id);
    await verifyStoppedAndRemembered(subject, 'Transport loss with failed runtime reload');
    check(subject.calls.includes('tunnel:reconcileConnection'), 'Transport loss retains its existing native teardown owner');
}
{
    const subject = fixture();
    await subject.get().cancelConnect(subject.id);
    await verifyStoppedAndRemembered(subject, 'Immediate cancellation');
}
{
    const subject = fixture();
    await subject.get().cancelConnect(subject.id);
    const stopped = subject.get().tunnels;
    // Both calls snapshot and clear runtime status; no active event is republished between them.
    await subject.get().cancelConnect(subject.id);
    check(subject.get().tunnels === stopped, 'Repeated cancellation leaves already-cleared tunnel runtime state unchanged');
    await verifyStoppedAndRemembered(subject, 'Repeated cancellation snapshots with no active forwards');
}
{
    const subject = fixture({ terminals: true, disconnectFails: true });
    const connecting = subject.get().connect(subject.id);
    await subject.ready.promise;
    await subject.get().cancelConnect(subject.id);
    // Model a late successful native connection/status publication after the user already cancelled.
    subject.get().updateTunnelStatus('active', subject.id, 'active');
    subject.release.resolve(); await connecting;
    await verifyStoppedAndRemembered(subject, 'Late cancelled-connect backend cleanup');
    check(subject.calls.includes('disconnect'), 'Late cancelled connects explicitly tear down their native transport');
    check(subject.get().terminals[subject.id][0].pendingRestore === true, 'Late cancellation keeps restored terminal identity');
}

console.log('Tunnel connection lifecycle regression tests passed.');
