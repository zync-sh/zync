import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  filterUnsupportedHostThemes,
  filterTrustedBuiltinThemeChoices,
  getBuiltinThemeChoices,
  handlePanelPluginCommand,
  handleWorkerTerminalCommand,
  isTrustedBuiltinTheme,
  postCurrentWorkerResponse,
} from '../.tmp-agent-tests/src/features/plugins/pluginCommandBridge.js';

assert.deepEqual(getBuiltinThemeChoices([]).map(item => item.id), ['system', 'dark']);
assert.deepEqual(getBuiltinThemeChoices([
  { path: 'builtin://light', manifest: { id: 'com.zync.theme.light', name: 'Light Theme', mode: 'light' } },
  { path: 'builtin://theme-manager', manifest: { id: 'com.zync.theme.manager' } },
  { path: 'C:/plugins/theme', manifest: { id: 'com.zync.theme.fake', name: 'Fake Theme' } },
]).map(item => item.id), ['system', 'dark', 'light']);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function panelHarness(type, payload, overrides = {}) {
  const requester = {};
  const state = {
    requester,
    current: requester,
    active: true,
    confirmations: [],
    dispatches: [],
    posts: [],
    invokes: [],
  };
  const deps = {
    event: { source: requester, data: { type, payload } },
    pluginId: 'plugin.test',
    connectionId: 'conn-1',
    getRequester: () => state.requester,
    isCurrent: candidate => state.active && state.current === candidate,
    confirm: async (...args) => {
      state.confirmations.push(args);
      return true;
    },
    confirmUi: async () => true,
    dispatch: (eventType, detail) => state.dispatches.push({ type: eventType, detail }),
    post: (target, message) => state.posts.push({ target, message }),
    loadSshInvoker: async () => async (connectionId, command) => {
      state.invokes.push({ connectionId, command });
      return 'result';
    },
    ...overrides,
  };
  return { requester, state, deps };
}

async function run(name, fn) {
  try {
    await fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

await run('ignores a foreign panel source and malformed messages', async () => {
  const foreign = panelHarness('zync:terminal:send', { text: 'whoami\r' });
  foreign.deps.event.source = {};
  assert.equal(await handlePanelPluginCommand(foreign.deps), false);
  assert.deepEqual(foreign.state.confirmations, []);
  assert.deepEqual(foreign.state.dispatches, []);

  const malformed = panelHarness(undefined, undefined);
  malformed.deps.event.data = null;
  assert.equal(await handlePanelPluginCommand(malformed.deps), false);

  const badSend = panelHarness('zync:terminal:send', { text: 42 });
  assert.equal(await handlePanelPluginCommand(badSend.deps), true);
  assert.deepEqual(badSend.state.confirmations, []);
});

await run('denies and allows panel terminal input with exact dispatch detail', async () => {
  const denied = panelHarness('zync:terminal:send', { text: 'rm -rf nope\r' }, {
    confirm: async () => false,
  });
  await handlePanelPluginCommand(denied.deps);
  assert.deepEqual(denied.state.dispatches, []);

  const allowed = panelHarness('zync:terminal:send', { text: 'pwd\r' });
  await handlePanelPluginCommand(allowed.deps);
  assert.deepEqual(allowed.state.confirmations, [
    ['plugin.test', 'send terminal input', 'pwd\r'],
  ]);
  assert.deepEqual(allowed.state.dispatches, [{
    type: 'zync:terminal:send',
    detail: { text: 'pwd\r', connectionId: 'conn-1' },
  }]);
});

await run('binds panel UI confirmation responses to the requesting frame generation', async () => {
  const approval = deferred();
  const current = panelHarness('zync:ui:confirm', {
    requestId: 'confirm-current',
    title: 'Plugin request',
    message: 'Continue?',
    variant: 'danger',
  }, { confirmUi: () => approval.promise });
  const pending = handlePanelPluginCommand(current.deps);
  approval.resolve(true);
  await pending;
  assert.deepEqual(current.state.posts, [{
    target: current.requester,
    message: {
      type: 'zync:ui:confirm:response',
      payload: { requestId: 'confirm-current', confirmed: true },
    },
  }]);

  for (const replacement of [null, {}]) {
    const staleApproval = deferred();
    const stale = panelHarness('zync:ui:confirm', { requestId: 'confirm-stale' }, {
      confirmUi: () => staleApproval.promise,
    });
    const stalePending = handlePanelPluginCommand(stale.deps);
    if (replacement === null) stale.state.active = false;
    else stale.state.current = replacement;
    staleApproval.resolve(true);
    await stalePending;
    assert.deepEqual(stale.state.posts, []);
  }
});

await run('keeps bare opentab unconfirmed and confirms command-bearing opentab', async () => {
  const bare = panelHarness('zync:terminal:opentab', {});
  await handlePanelPluginCommand(bare.deps);
  assert.deepEqual(bare.state.confirmations, []);
  assert.deepEqual(bare.state.dispatches, [{
    type: 'ssh-ui:new-terminal-tab',
    detail: { connectionId: 'conn-1', command: undefined },
  }]);

  const denied = panelHarness('zync:terminal:opentab', { command: 'tail -f app.log' }, {
    confirm: async () => false,
  });
  await handlePanelPluginCommand(denied.deps);
  assert.deepEqual(denied.state.dispatches, []);

  const allowed = panelHarness('zync:terminal:opentab', { command: 'tail -f app.log' });
  await handlePanelPluginCommand(allowed.deps);
  assert.deepEqual(allowed.state.confirmations, [
    ['plugin.test', 'open a terminal and run', 'tail -f app.log'],
  ]);
  assert.deepEqual(allowed.state.dispatches, [{
    type: 'ssh-ui:new-terminal-tab',
    detail: { connectionId: 'conn-1', command: 'tail -f app.log' },
  }]);

  const malformed = panelHarness('zync:terminal:opentab', { command: 42 });
  await handlePanelPluginCommand(malformed.deps);
  assert.deepEqual(malformed.state.confirmations, []);
  assert.deepEqual(malformed.state.dispatches, []);
});

await run('returns structured SSH validation and denial errors without invoking', async () => {
  const disconnected = panelHarness('zync:ssh:exec', { requestId: 'r0', command: 'id' }, {
    connectionId: null,
  });
  await handlePanelPluginCommand(disconnected.deps);
  assert.deepEqual(disconnected.state.posts[0].message, {
    type: 'zync:ssh:exec:response',
    payload: { requestId: 'r0', error: 'No active connection' },
  });

  const invalid = panelHarness('zync:ssh:exec', { requestId: 'r1', command: 42 });
  await handlePanelPluginCommand(invalid.deps);
  assert.deepEqual(invalid.state.posts[0].message.payload.error, {
    code: 'SSH_EXEC_INVALID_COMMAND',
    message: 'SSH command must be a string.',
  });
  assert.deepEqual(invalid.state.invokes, []);

  const denied = panelHarness('zync:ssh:exec', { requestId: 'r2', command: 'id' }, {
    confirm: async () => false,
  });
  await handlePanelPluginCommand(denied.deps);
  assert.deepEqual(denied.state.posts[0].message.payload.error, {
    code: 'SSH_EXEC_DENIED',
    message: 'SSH command was not approved by the user.',
  });
  assert.deepEqual(denied.state.invokes, []);
});

await run('invokes approved SSH exactly once and responds to the requester', async () => {
  const allowed = panelHarness('zync:ssh:exec', { requestId: 'r3', command: 'uname -a' });
  await handlePanelPluginCommand(allowed.deps);
  assert.deepEqual(allowed.state.confirmations, [[
    'plugin.test',
    'run an SSH command on connection "conn-1"',
    'uname -a',
  ]]);
  assert.deepEqual(allowed.state.invokes, [{ connectionId: 'conn-1', command: 'uname -a' }]);
  assert.deepEqual(allowed.state.posts, [{
    target: allowed.requester,
    message: {
      type: 'zync:ssh:exec:response',
      payload: { requestId: 'r3', result: 'result' },
    },
  }]);
});

await run('cancels panel actions replaced or unmounted during confirmation', async () => {
  for (const replacement of [null, {}]) {
    const approval = deferred();
    const harness = panelHarness('zync:terminal:send', { text: 'date\r' }, {
      confirm: () => approval.promise,
    });
    const pending = handlePanelPluginCommand(harness.deps);
    if (replacement === null) harness.state.active = false;
    else harness.state.current = replacement;
    approval.resolve(true);
    await pending;
    assert.deepEqual(harness.state.dispatches, []);
  }
});

await run('does not leak SSH results or errors to a replacement during IPC', async () => {
  const loader = deferred();
  let loadInvokes = 0;
  const replacedWhileLoading = panelHarness('zync:ssh:exec', { requestId: 'load', command: 'whoami' }, {
    loadSshInvoker: () => loader.promise,
  });
  const pendingLoad = handlePanelPluginCommand(replacedWhileLoading.deps);
  await Promise.resolve();
  replacedWhileLoading.state.current = {};
  loader.resolve(async () => {
    loadInvokes += 1;
    return 'must-not-run';
  });
  await pendingLoad;
  assert.equal(loadInvokes, 0);
  assert.deepEqual(replacedWhileLoading.state.posts, []);

  const invocation = deferred();
  const success = panelHarness('zync:ssh:exec', { requestId: 'r4', command: 'hostname' }, {
    loadSshInvoker: async () => async () => invocation.promise,
  });
  const pendingSuccess = handlePanelPluginCommand(success.deps);
  await Promise.resolve();
  await Promise.resolve();
  success.state.current = {};
  invocation.resolve('secret-output');
  await pendingSuccess;
  assert.deepEqual(success.state.posts, []);

  const failure = deferred();
  const rejected = panelHarness('zync:ssh:exec', { requestId: 'r5', command: 'false' }, {
    loadSshInvoker: async () => async () => failure.promise,
  });
  const pendingFailure = handlePanelPluginCommand(rejected.deps);
  await Promise.resolve();
  await Promise.resolve();
  rejected.state.current = {};
  failure.reject(new Error('private failure'));
  await pendingFailure;
  assert.deepEqual(rejected.state.posts, []);
});

function workerHarness(payload, overrides = {}) {
  const requester = {};
  const state = { current: requester, confirmations: [], dispatches: [] };
  return {
    requester,
    state,
    deps: {
      type: 'api:terminal:send',
      payload,
      pluginId: 'worker.test',
      requester,
      isCurrent: candidate => state.current === candidate,
      confirm: async (...args) => {
        state.confirmations.push(args);
        return true;
      },
      getActiveConnectionId: () => 'conn-worker',
      dispatch: (type, detail) => state.dispatches.push({ type, detail }),
      ...overrides,
    },
  };
}

await run('validates, denies, and allows worker terminal input', async () => {
  const malformed = workerHarness({ text: 42 });
  assert.equal(await handleWorkerTerminalCommand(malformed.deps), true);
  assert.deepEqual(malformed.state.confirmations, []);

  const denied = workerHarness({ text: 'id\r' }, { confirm: async () => false });
  await handleWorkerTerminalCommand(denied.deps);
  assert.deepEqual(denied.state.dispatches, []);

  const allowed = workerHarness({ text: 'id\r' });
  await handleWorkerTerminalCommand(allowed.deps);
  assert.deepEqual(allowed.state.confirmations, [['worker.test', 'send terminal input', 'id\r']]);
  assert.deepEqual(allowed.state.dispatches, [{
    type: 'zync:terminal:send',
    detail: { text: 'id\r', connectionId: 'conn-worker' },
  }]);
});

await run('cancels a worker replaced during confirmation', async () => {
  const approval = deferred();
  const harness = workerHarness({ text: 'uptime\r' }, { confirm: () => approval.promise });
  const pending = handleWorkerTerminalCommand(harness.deps);
  harness.state.current = {};
  approval.resolve(true);
  await pending;
  assert.deepEqual(harness.state.dispatches, []);
});

await run('never posts an asynchronous response to a replacement Worker', async () => {
  const first = { messages: [], postMessage(message) { this.messages.push(message); } };
  const replacement = { messages: [], postMessage(message) { this.messages.push(message); } };
  let current = first;
  const operation = deferred();
  const pending = (async () => {
    const result = await operation.promise;
    return postCurrentWorkerResponse(
      first,
      candidate => current === candidate,
      'api:fs:read',
      { requestId: 'async-1', result },
    );
  })();
  current = replacement;
  operation.resolve('private content');
  assert.equal(await pending, false);
  assert.deepEqual(first.messages, []);
  assert.deepEqual(replacement.messages, []);

  current = first;
  assert.equal(postCurrentWorkerResponse(
    first,
    candidate => current === candidate,
    'api:plugins:load',
    { requestId: 'async-2', result: [] },
  ), true);
  assert.deepEqual(first.messages, [{
    type: 'api:plugins:load:response',
    payload: { requestId: 'async-2', result: [] },
  }]);
});

await run('keeps app-owned Appearance themes and rejects filesystem theme CSS', async () => {
  const plugins = [
    { path: 'builtin://dracula', manifest: { id: 'com.zync.theme.dracula' }, enabled: true, style: 'trusted css' },
    { path: 'builtin://disabled', manifest: { id: 'com.zync.theme.disabled' }, enabled: false, style: 'trusted css' },
    { path: 'C:/plugins/evil', manifest: { id: 'com.zync.theme.evil' }, enabled: true, style: 'host css' },
    { path: '/plugins/third-party', manifest: { id: 'third.party.theme', type: 'theme' }, enabled: true, style: 'host css' },
    { manifest: { id: 'com.zync.theme.editor', type: 'editor-provider' }, enabled: true, style: 'iframe css' },
    { manifest: { id: 'third.party.tool', type: 'tool' }, enabled: true, script: 'run();' },
  ];
  assert.equal(isTrustedBuiltinTheme(plugins[0]), true);
  assert.equal(isTrustedBuiltinTheme(plugins[2]), false);
  const appearanceChoices = filterUnsupportedHostThemes(plugins).filter(plugin => plugin.enabled);
  assert.deepEqual(appearanceChoices, [plugins[0], plugins[4], plugins[5]]);
  const appearanceThemes = appearanceChoices.filter(plugin => (
    plugin.manifest.type === 'theme' || plugin.manifest.id.startsWith('com.zync.theme.')
  ) && plugin.manifest.type !== 'editor-provider');
  assert.deepEqual(appearanceThemes, [plugins[0]]);
});

await run('starts the real built-in theme manager and exposes only backed theme choices', async () => {
  const managerSource = fs.readFileSync(
    'src-tauri/src/plugins/builtins/theme_manager.rs',
    'utf8',
  );
  const script = /script: Some\(r#"([\s\S]*?)"#\.to_string\(\)\)/.exec(managerSource)?.[1];
  assert.ok(script, 'the app-owned theme manager script must exist');

  const manager = {
    path: 'builtin://theme-manager',
    manifest: { id: 'com.zync.theme.manager' },
    enabled: true,
    script,
  };
  const light = {
    path: 'builtin://light',
    manifest: { id: 'com.zync.theme.light', mode: 'light' },
    enabled: true,
    style: 'trusted light css',
  };
  const dracula = {
    path: 'builtin://dracula',
    manifest: { id: 'com.zync.theme.dracula', mode: 'dark' },
    enabled: true,
    style: 'trusted dark css',
  };
  const evil = {
    path: 'C:/plugins/evil',
    manifest: { id: 'com.zync.theme.evil', mode: 'dark' },
    enabled: true,
    style: 'untrusted css',
  };
  const admitted = filterUnsupportedHostThemes([manager, light, dracula, evil]);
  const runnable = admitted.filter(plugin => plugin.enabled && plugin.script);
  assert.deepEqual(runnable, [manager], 'the trusted manager Worker must remain runnable');

  const listeners = new Map();
  const commands = new Map();
  let shownItems = [];
  let selectedTheme = null;
  const zync = {
    on: (event, callback) => listeners.set(event, callback),
    commands: {
      register: (id, title, handler) => commands.set(id, { title, handler }),
    },
    plugins: { list: async () => admitted },
    window: {
      showQuickPick: async (items) => {
        shownItems = filterTrustedBuiltinThemeChoices(items, admitted);
        return shownItems.find(item => item.id === 'dracula');
      },
    },
    theme: { set: id => { selectedTheme = id; } },
  };
  new Function('zync', script)(zync);
  listeners.get('ready')();
  const command = commands.get('workbench.action.selectTheme');
  assert.equal(command?.title, 'Preferences: Color Theme');
  await command.handler();
  assert.ok(shownItems.some(item => item.id === 'system'));
  assert.ok(shownItems.some(item => item.id === 'light'));
  assert.ok(shownItems.some(item => item.id === 'dark'));
  assert.ok(shownItems.some(item => item.id === 'dracula'));
  assert.ok(!shownItems.some(item => item.id === 'night-owl'));
  assert.ok(!shownItems.some(item => item.id === 'evil'));
  assert.equal(selectedTheme, 'dracula');
});

await run('delivers quick pick response to the worker and rejects stale generation', async () => {
  const workerMessages = [];
  const worker = {
    postMessage(msg) {
      workerMessages.push(msg);
    },
  };
  const workers = new Map([['com.zync.theme.manager', worker]]);
  const isCurrent = candidate => workers.get('com.zync.theme.manager') === candidate;

  // Scenario 1: requester provided and active
  const ok1 = postCurrentWorkerResponse(
    worker,
    isCurrent,
    'api:window:showQuickPick',
    { requestId: 'qp-1', result: { id: 'dracula', label: 'Dracula' } },
  );
  assert.equal(ok1, true);
  assert.deepEqual(workerMessages[0], {
    type: 'api:window:showQuickPick:response',
    payload: { requestId: 'qp-1', result: { id: 'dracula', label: 'Dracula' } },
  });

  // Scenario 2: targetWorker resolved from map and active
  const targetWorker = workers.get('com.zync.theme.manager');
  const ok2 = postCurrentWorkerResponse(
    targetWorker,
    isCurrent,
    'api:window:showQuickPick',
    { requestId: 'qp-2', result: { id: 'monokai', label: 'Monokai' } },
  );
  assert.equal(ok2, true);
  assert.deepEqual(workerMessages[1], {
    type: 'api:window:showQuickPick:response',
    payload: { requestId: 'qp-2', result: { id: 'monokai', label: 'Monokai' } },
  });

  // Scenario 3: stale replaced worker
  const staleWorker = worker;
  const newWorker = { postMessage() {} };
  workers.set('com.zync.theme.manager', newWorker);
  const ok3 = postCurrentWorkerResponse(
    staleWorker,
    isCurrent,
    'api:window:showQuickPick',
    { requestId: 'qp-3', result: { id: 'light', label: 'Light' } },
  );
  assert.equal(ok3, false);
  assert.equal(workerMessages.length, 2);
});

await run('handles consecutive immediate quick-pick events with synchronous cancellation of prior request', async () => {
  const dispatchedEvents = [];
  const eventTarget = {
    dispatchEvent(event) {
      dispatchedEvents.push(event);
      return true;
    },
  };

  // Model the CommandPalette synchronous ref transition logic
  const state = {
    open: false,
    quickPickMode: false,
    quickPickOptions: null,
  };
  const refs = {
    open: false,
    quickPickMode: false,
    quickPickOptions: null,
  };

  const cancelActiveQuickPick = () => {
    if (refs.quickPickMode) {
      state.quickPickMode = false;
      refs.quickPickMode = false;
      const currentOptions = refs.quickPickOptions;
      state.quickPickOptions = null;
      refs.quickPickOptions = null;
      if (currentOptions && currentOptions.pluginId !== 'system') {
        eventTarget.dispatchEvent({
          type: 'zync:quick-pick-select',
          detail: {
            requestId: currentOptions.requestId,
            pluginId: currentOptions.pluginId,
            selectedItem: null,
            requester: currentOptions.requester,
          },
        });
      }
    }
  };

  const handleQuickPick = (detail) => {
    cancelActiveQuickPick();
    const { options, requestId, pluginId, requester } = detail;
    const nextOptions = { ...options, requestId, pluginId, requester };
    state.quickPickOptions = nextOptions;
    refs.quickPickOptions = nextOptions;
    state.quickPickMode = true;
    refs.quickPickMode = true;
    state.open = true;
    refs.open = true;
  };

  const worker1 = { id: 'worker-1' };
  const worker2 = { id: 'worker-2' };

  // Dispatch first quick-pick event
  handleQuickPick({
    items: [{ id: 'dracula', label: 'Dracula' }],
    options: { placeHolder: 'Theme 1' },
    requestId: 'req-1',
    pluginId: 'com.zync.theme.manager',
    requester: worker1,
  });

  assert.equal(refs.quickPickMode, true);
  assert.equal(refs.open, true);
  assert.equal(refs.quickPickOptions?.requestId, 'req-1');
  assert.equal(dispatchedEvents.length, 0);

  // Dispatch second quick-pick event immediately without waiting for React re-render / useEffect
  handleQuickPick({
    items: [{ id: 'monokai', label: 'Monokai' }],
    options: { placeHolder: 'Theme 2' },
    requestId: 'req-2',
    pluginId: 'com.zync.theme.manager',
    requester: worker2,
  });

  // Verify prior request was cancelled synchronously
  assert.equal(dispatchedEvents.length, 1);
  assert.deepEqual(dispatchedEvents[0], {
    type: 'zync:quick-pick-select',
    detail: {
      requestId: 'req-1',
      pluginId: 'com.zync.theme.manager',
      selectedItem: null,
      requester: worker1,
    },
  });

  // Verify active state now holds the second request
  assert.equal(refs.quickPickMode, true);
  assert.equal(refs.open, true);
  assert.equal(refs.quickPickOptions?.requestId, 'req-2');
  assert.equal(refs.quickPickOptions?.requester, worker2);
});

// Verify static source patterns in CommandPalette.tsx
await run('CommandPalette updates quick-pick refs synchronously across state transitions', async () => {
  const cpSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'components', 'layout', 'CommandPalette.tsx'),
    'utf8',
  );

  assert.match(
    cpSource,
    /quickPickModeRef\.current = false;[\s\S]*?quickPickOptionsRef\.current = null;/,
    'cancelActiveQuickPick must clear quickPickModeRef and quickPickOptionsRef synchronously',
  );
  assert.match(
    cpSource,
    /quickPickOptionsRef\.current = nextOptions;[\s\S]*?quickPickModeRef\.current = true;[\s\S]*?openRef\.current = true;/,
    'handleQuickPick must assign quickPickOptionsRef, quickPickModeRef, and openRef synchronously',
  );
});

console.log('Plugin command bridge behavioral tests passed.');

