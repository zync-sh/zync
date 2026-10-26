import { createUserTunnelActions, type UserTunnelPort } from '../src/features/tunnels/application/userTunnelActions';

function check(condition: unknown, message: string): void { if (!condition) throw new Error(message); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function rejects(work: () => Promise<unknown>, message: string) {
    let rejected = false; try { await work(); } catch { rejected = true; } check(rejected, message);
}

/** Model live store reads and arbitrary prompt/refresh/start completion without using SSH or a global app store. */
function fixture() {
    type Status = ReturnType<UserTunnelPort['connectionStatus']>;
    const values = new Map<string, Status>([['host', 'disconnected']]);
    const listeners = new Map<string, Set<(status: Status) => void>>();
    const publish = (id: string) => { for (const listener of listeners.get(id) ?? []) listener(values.get(id)); };
    const statuses = {
        get: (id: string) => values.get(id),
        set: (id: string, status: Status) => { const previous = values.get(id); values.set(id, status); if (previous !== status) publish(id); },
        delete: (id: string) => { if (values.delete(id)) publish(id); },
    };
    const forwards = new Map<string, ReturnType<UserTunnelPort['tunnelStatus']>>([['one', 'stopped'], ['two', 'stopped']]);
    const calls: string[] = [];
    const work = {
        connect: async (id: string) => { statuses.set(id, 'connected'); },
        refresh: async (_id: string) => {},
        start: async (id: string, _host: string) => { forwards.set(id, 'active'); },
    };
    const actions = createUserTunnelActions({
        connectionStatus: id => statuses.get(id),
        subscribeConnectionStatus: (id, listener) => {
            const hostListeners = listeners.get(id) ?? new Set();
            hostListeners.add(listener); listeners.set(id, hostListeners);
            return () => { hostListeners.delete(listener); if (hostListeners.size === 0) listeners.delete(id); };
        },
        tunnelStatus: tunnel => forwards.get(tunnel.id),
        connect: async id => { calls.push(`connect:${id}`); await work.connect(id); },
        refreshTunnels: async id => { calls.push(`refresh:${id}`); await work.refresh(id); },
        startTunnel: async (id, host) => { calls.push(`start:${id}:${host}`); await work.start(id, host); },
    });
    return { statuses, forwards, calls, work, actions, listenerCount: () => [...listeners.values()].reduce((count, host) => count + host.size, 0) };
}
const one = { id: 'one', connectionId: 'host' };
const two = { id: 'two', connectionId: 'host' };

{
    const state = fixture();
    check(await state.actions.start(one) === 'started', 'An explicit offline start connects and starts the forward');
    check(state.calls.join(',') === 'connect:host,refresh:host,start:one:host', 'Transport and refreshed runtime state precede starting');
    check(await state.actions.start(one) === 'already-running', 'A current active forward is not started twice');
    check(state.calls.filter(call => call.startsWith('start:')).length === 1, 'Repeated ready-state starts preserve the runtime listener');
}
{
    const state = fixture(); state.statuses.set('host', 'connected');
    await state.actions.start(one);
    check(state.calls.join(',') === 'start:one:host', 'A connected host is reused without reconnect or background refresh');
}
{
    const state = fixture();
    state.work.connect = async () => {};
    check(await state.actions.start(one) === 'cancelled', 'A normally resolved but cancelled connect does not authorize forwarding');
    check(state.calls.join(',') === 'connect:host', 'Cancelled connects cause no tunnel refresh or remote start');
}
{
    const state = fixture(); state.statuses.set('host', 'connecting');
    check(await state.actions.start(one) === 'cancelled', 'An existing connect owned by another surface is not queued again');
    check(state.calls.length === 0, 'An already connecting host is not reconnected behind its current attempt');
}
{
    const state = fixture(); state.work.connect = async () => { throw new Error('Authentication declined'); };
    await rejects(() => state.actions.start(one), 'Connection failures retain the existing action error flow');
    check(state.calls.join(',') === 'connect:host', 'Failed connection cannot start a forward');
    state.work.connect = async id => { state.statuses.set(id, 'connected'); };
    await state.actions.start(one);
    check(state.calls.filter(call => call === 'connect:host').length === 2, 'Failed admission releases its singleflight for a later explicit retry');
}
for (const publishConnecting of [false, true]) {
    const state = fixture();
    // The store reports ordinary connection failures through status and resolves its promise.
    state.work.connect = async id => {
        if (publishConnecting) state.statuses.set(id, 'connecting');
        state.statuses.set(id, 'error');
    };
    await rejects(() => state.actions.start(one), 'A resolved connect with final error status rejects instead of reporting cancellation');
    check(state.calls.join(',') === 'connect:host', 'Recorded connection failure cannot refresh or start a forward');
    check(state.listenerCount() === 0, 'Recorded connection failure releases its status observer');
    state.work.connect = async id => { state.statuses.set(id, 'connected'); };
    check(await state.actions.start(one) === 'started', 'A later explicit retry can recover from a recorded connection failure');
    check(state.listenerCount() === 0, 'Recovery after recorded failure releases its status observer');
}
{
    const state = fixture(); const failure = new Error('Authentication declined');
    state.work.connect = async id => { state.statuses.set(id, 'connecting'); state.statuses.set(id, 'error'); throw failure; };
    let caught: unknown;
    try { await state.actions.start(one); } catch (error) { caught = error; }
    check(caught === failure, 'Publishing error before rejection preserves the original connection failure');
    check(state.calls.join(',') === 'connect:host' && state.listenerCount() === 0, 'Rejected connection failure performs no tunnel work and releases its observer');
}
{
    const state = fixture(); const gate = deferred();
    state.work.connect = async id => { state.statuses.set(id, 'connecting'); await gate.promise; state.statuses.set(id, 'error'); };
    const original = state.actions.start(one);
    state.statuses.set('host', 'disconnected');
    gate.resolve();
    check(await original === 'cancelled', 'An error arriving after Cancel does not replace the existing cancellation');
    check(state.calls.join(',') === 'connect:host' && state.listenerCount() === 0, 'Late errors after Cancel perform no tunnel work and release their observer');
}
{
    const state = fixture(); state.statuses.delete('host');
    await rejects(() => state.actions.start(one), 'A removed host cannot be started');
    check(state.calls.length === 0, 'A missing host opens no authentication or forwarding operation');
}
{
    const state = fixture(); state.forwards.delete('one');
    await rejects(() => state.actions.start(one), 'A removed saved forward cannot initiate a connection');
    check(state.calls.length === 0, 'Stale deleted rows perform no host action');
}
{
    const state = fixture();
    state.work.connect = async id => { state.statuses.set(id, 'connected'); state.forwards.delete('one'); };
    await rejects(() => state.actions.start(one), 'A forward removed during authentication is revalidated after the prompt');
    check(!state.calls.some(call => call.startsWith('start:')), 'No stale start follows deletion during connection');
}
{
    const state = fixture();
    state.work.refresh = async () => { state.forwards.set('one', 'active'); };
    check(await state.actions.start(one) === 'already-running', 'Post-connect authoritative refresh sees auto-started forwards');
    check(state.calls.join(',') === 'connect:host,refresh:host', 'Reconnect auto-start is never followed by a duplicate user start');
}
{
    const state = fixture();
    state.work.refresh = async id => { state.statuses.set(id, 'disconnected'); };
    check(await state.actions.start(one) === 'cancelled', 'Transport loss during the runtime refresh blocks the action');
    check(!state.calls.some(call => call.startsWith('start:')), 'Fresh transport validation occurs after every connection await');
}
{
    const state = fixture();
    state.work.refresh = async () => { throw new Error('Could not read runtime status'); };
    await rejects(() => state.actions.start(one), 'A failed authoritative read cannot assume auto-start did not already run');
    check(!state.calls.some(call => call.startsWith('start:')), 'Refresh failure does not create a duplicate listener');
}
{
    const state = fixture(); const gate = deferred();
    state.work.connect = async id => { state.statuses.set(id, 'connecting'); await gate.promise; state.statuses.set(id, 'connected'); };
    const first = state.actions.start(one); const repeated = state.actions.start(one); const sibling = state.actions.start(two);
    check(first === repeated && state.listenerCount() === 1, 'Repeated clicks share their result and one temporary host-status observer');
    check(state.calls.join(',') === 'connect:host', 'Concurrent global/per-host/sibling actions share the owned connection attempt');
    gate.resolve(); await Promise.all([first, repeated, sibling]);
    check(state.calls.filter(call => call === 'refresh:host').length === 1, 'Shared admission performs one authoritative refresh');
    check(state.calls.filter(call => call === 'start:one:host').length === 1, 'Repeated start clicks share one runtime operation');
    check(state.calls.filter(call => call === 'start:two:host').length === 1, 'A sibling starts independently over the same transport');
    check(state.listenerCount() === 0, 'Successful shared starts release their host-status observer');
}
{
    const state = fixture(); const firstGate = deferred(); const retryGate = deferred(); const retryReady = deferred();
    let attempts = 0;
    state.work.connect = async id => {
        attempts++; state.statuses.set(id, 'connecting');
        if (attempts === 1) { await firstGate.promise; return; }
        retryReady.resolve(); await retryGate.promise;
        state.statuses.set(id, 'connected');
    };
    const original = state.actions.start(one); const oldSibling = state.actions.start(two);
    const oldGroup = state.actions.startGroup([one, two]);
    state.statuses.set('host', 'disconnected'); // Cancel is visible before the original native invocation unwinds.
    const retry = state.actions.start(one); const repeated = state.actions.start(one);
    const sibling = state.actions.start(two); const groupRetry = state.actions.startGroup([one, two]);
    check(retry !== original && retry === repeated, 'A fresh explicit retry replaces cancelled work and coalesces rapid repeated clicks');
    check(attempts === 1 && state.listenerCount() === 1, 'Fresh row, sibling and group retries wait behind the cancelled host attempt');
    firstGate.resolve(); await retryReady.promise;
    check(await original === 'cancelled' && await oldSibling === 'cancelled', 'Late native completion cannot revive either cancelled row intent');
    const cancelledGroup = await oldGroup;
    check(cancelledGroup.cancelled === 2 && cancelledGroup.started === 0, 'The original group remains cancelled on the newer connection');
    check(!state.calls.some(call => call.startsWith('refresh:') || call.startsWith('start:')), 'Cancelled work neither refreshes nor starts over a newer transport');
    retryGate.resolve();
    check(await retry === 'started' && await sibling === 'started', 'Only the fresh explicit row and sibling intents start after retry admission');
    const retriedGroup = await groupRetry;
    check(retriedGroup.cancelled === 0 && retriedGroup.failed === 0, 'An explicit group retry shares the fresh admission');
    check(attempts === 2 && state.calls.filter(call => call === 'refresh:host').length === 1, 'Rapid row, sibling and group retries create one fresh connection and refresh');
    check(state.calls.filter(call => call === 'start:one:host').length === 1 && state.calls.filter(call => call === 'start:two:host').length === 1, 'Fresh retry surfaces never duplicate runtime listeners');
    check(state.listenerCount() === 0, 'Cancelled and replacement admissions release every observer');
}
{
    const state = fixture(); const gate = deferred();
    // Store.connect may itself wait in the host operation queue before publishing connecting.
    state.work.connect = async id => { await gate.promise; state.statuses.set(id, 'connecting'); state.statuses.set(id, 'connected'); };
    const first = state.actions.start(one); const repeated = state.actions.start(one); const sibling = state.actions.start(two);
    check(first === repeated && state.calls.join(',') === 'connect:host', 'An initial disconnected queue gap is not mistaken for cancellation');
    gate.resolve(); await Promise.all([first, repeated, sibling]);
    check(state.calls.filter(call => call === 'connect:host').length === 1, 'Queued initial admission keeps sibling and repeated starts coalesced');
    check(state.listenerCount() === 0, 'Initially queued admission releases its temporary observer');
}
{
    const state = fixture(); const refreshing = deferred(); const refreshGate = deferred();
    let refreshes = 0;
    state.work.refresh = async () => { if (++refreshes === 1) { refreshing.resolve(); await refreshGate.promise; } };
    const original = state.actions.start(one); await refreshing.promise;
    state.statuses.set('host', 'disconnected');
    const retry = state.actions.start(one);
    check(state.calls.filter(call => call === 'connect:host').length === 1, 'A retry also waits for cancelled post-connect refresh work');
    refreshGate.resolve();
    check(await original === 'cancelled' && await retry === 'started', 'A cancelled refresh cannot authorize a start on the replacement connection');
    check(state.calls.filter(call => call === 'start:one:host').length === 1 && state.listenerCount() === 0, 'Refresh cancellation leaves one fresh runtime start and no observer');
}
{
    const state = fixture(); const gate = deferred();
    state.work.connect = async id => { state.statuses.set(id, 'connecting'); await gate.promise; throw new Error('Cancelled native invocation'); };
    const original = state.actions.start(one);
    state.statuses.set('host', 'disconnected');
    const retry = state.actions.start(one);
    state.work.connect = async id => { state.statuses.set(id, 'connected'); };
    gate.resolve();
    check(await original === 'cancelled' && await retry === 'started', 'A cancelled predecessor rejection cannot reject or swallow its fresh explicit retry');
    check(state.listenerCount() === 0, 'Cancelled native rejection and retry release their observers');
}
{
    const state = fixture(); state.statuses.set('host', 'connected');
    state.work.start = async () => { throw new Error('Port in use'); };
    await rejects(() => state.actions.start(one), 'Port conflicts propagate to the existing conflict picker');
    state.work.start = async id => { state.forwards.set(id, 'active'); };
    await state.actions.start(one);
    check(state.calls.filter(call => call === 'start:one:host').length === 2, 'A failed runtime start releases its admission for conflict retry');
}
{
    const state = fixture(); state.work.connect = async () => {};
    const result = await state.actions.startGroup([one, two]);
    check(result.cancelled === 2 && result.failed === 0 && result.started === 0, 'Cancelling group authentication skips all host rows');
    check(state.calls.join(',') === 'connect:host', 'A group never prompts again for each cancelled host row');
}
{
    const state = fixture(); state.statuses.set('host', 'connected'); state.forwards.set('one', 'active'); state.forwards.delete('two');
    const result = await state.actions.startGroup([one, two]);
    check(result.started === 0 && result.failed === 1 && result.cancelled === 0, 'Active and deleted rows do not enter group connection admission');
    check(state.calls.length === 0, 'A group with no startable saved row opens no host connection');
}
{
    const state = fixture(); state.forwards.set('one', 'active');
    state.work.refresh = async () => { state.forwards.set('one', 'stopped'); };
    const result = await state.actions.startGroup([one]);
    check(result.started === 1 && result.failed === 0, 'A cached active flag on an offline host cannot hide a stopped forward from Start group');
    check(state.calls.join(',') === 'connect:host,refresh:host,start:one:host', 'Group membership survives until authoritative post-connect state is available');
}
{
    const state = fixture();
    state.work.refresh = async () => { state.forwards.set('one', 'active'); };
    const result = await state.actions.startGroup([one]);
    check(result.started === 0 && result.failed === 0, 'Freshly auto-started group rows are filtered only after host admission');
    check(state.calls.join(',') === 'connect:host,refresh:host', 'A group does not start an auto-restarted forward twice');
}
{
    const state = fixture(); state.statuses.set('other', 'disconnected'); state.forwards.set('three', 'stopped');
    state.work.connect = async id => { if (id === 'host') throw new Error('Denied'); state.statuses.set(id, 'connected'); };
    const result = await state.actions.startGroup([one, two, { id: 'three', connectionId: 'other' }]);
    check(result.failed === 2 && result.started === 1, 'A failed host group leaves unrelated host actions available');
    check(state.calls.filter(call => call === 'connect:host').length === 1, 'A failed host group authenticates at most once');
}
{
    const state = fixture(); state.statuses.set('other', 'disconnected'); state.forwards.set('three', 'stopped');
    state.work.connect = async id => { state.statuses.set(id, 'connecting'); state.statuses.set(id, id === 'host' ? 'error' : 'connected'); };
    const result = await state.actions.startGroup([one, two, { id: 'three', connectionId: 'other' }]);
    check(result.failed === 2 && result.started === 1 && result.cancelled === 0, 'A recorded connection error counts host rows as failed and leaves unrelated host groups available');
    check(state.calls.join(',') === 'connect:host,connect:other,refresh:other,start:three:other', 'A failed host group connects once without refreshing or starting its forwards');
    check(state.listenerCount() === 0, 'Failed and successful host groups both release their status observers');
}
{
    const state = fixture();
    state.work.start = async (id, host) => { state.forwards.set(id, 'active'); state.statuses.set(host, 'disconnected'); };
    const result = await state.actions.startGroup([one, two]);
    check(result.started === 0 && result.cancelled === 2, 'Disconnecting during group start cancels its in-flight row and skips the remaining host rows');
    check(state.calls.filter(call => call === 'connect:host').length === 1, 'A group never silently reconnects after transport loss or explicit disconnect');
}

console.log('User tunnel action regression tests passed.');
