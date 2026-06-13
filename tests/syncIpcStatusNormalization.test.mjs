import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

if (typeof globalThis.window === 'undefined') {
  const target = new EventTarget();
  globalThis.window = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
}

function parseSyncInvokeError(error) {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String(error.message ?? '');
    const match = message.match(/^\[([^\]]+)\]\s*(.*)$/s);
    if (match) return { code: match[1], message: match[2] || message };
    return { code: undefined, message };
  }
  return { code: undefined, message: String(error ?? 'Unknown sync error') };
}

async function loadSyncIpcModule() {
  const file = path.join(process.cwd(), 'src/vault/syncIpc.ts');
  const source = fs.readFileSync(file, 'utf8')
    .replace("import { invoke } from '@tauri-apps/api/core';", "const { invoke } = globalThis.__syncIpcTestDeps;")
    .replace("import { parseSyncInvokeError } from './syncError';", "const { parseSyncInvokeError } = globalThis.__syncIpcTestDeps;");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const spec = `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`;
  return import(spec);
}

const invokeStub = async () => ({ connected: false });
globalThis.__syncIpcTestDeps = { invoke: invokeStub, parseSyncInvokeError };
const mod = await loadSyncIpcModule();

test('normalizeProviderStatus fills provider and prefers lastError fields', () => {
  const out = mod.normalizeProviderStatus('google', {
    connected: true,
    lastError: 'x',
    lastErrorCode: 'code-x',
    error: 'old',
    errorCode: 'old-code',
  });
  assert.equal(out.provider, 'google');
  assert.equal(out.error, 'x');
  assert.equal(out.errorCode, 'code-x');
});

test('normalizeProviderStatus preserves error when lastError missing', () => {
  const out = mod.normalizeProviderStatus('google', {
    connected: false,
    error: 'network',
    errorCode: 'net',
  });
  assert.equal(out.error, 'network');
  assert.equal(out.errorCode, 'net');
});

test('notifySyncStatusChanged dispatches normalized status', () => {
  const events = [];
  const handler = (e) => events.push(e.detail);
  window.addEventListener(mod.SYNC_STATUS_CHANGED_EVENT, handler);
  try {
    mod.notifySyncStatusChanged('google', {
      connected: false,
      lastError: 'bad token',
      lastErrorCode: 'bad_token',
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].status.provider, 'google');
    assert.equal(events[0].status.error, 'bad token');
    assert.equal(events[0].status.errorCode, 'bad_token');
  } finally {
    window.removeEventListener(mod.SYNC_STATUS_CHANGED_EVENT, handler);
  }
});

test('status() uses normalized payload shape', async () => {
  mod.__setSyncIpcInvokeForTests(async (command) => {
    assert.equal(command, 'sync_status');
    return { connected: true, lastError: 'oops', lastErrorCode: 'oops_code' };
  });
  try {
    const out = await mod.syncIpc.status('google');
    assert.equal(out.provider, 'google');
    assert.equal(out.error, 'oops');
    assert.equal(out.errorCode, 'oops_code');
  } finally {
    mod.__resetSyncIpcInvokeForTests();
  }
});

test('connect() normalizes direct connect payload', async () => {
  mod.__setSyncIpcInvokeForTests(async (command) => {
    if (command === 'sync_connect') {
      return { connected: true, lastError: 'connect_error', lastErrorCode: 'ce' };
    }
    throw new Error(`unexpected command ${command}`);
  });
  try {
    const out = await mod.syncIpc.connect('google');
    assert.equal(out.provider, 'google');
    assert.equal(out.error, 'connect_error');
    assert.equal(out.errorCode, 'ce');
  } finally {
    mod.__resetSyncIpcInvokeForTests();
  }
});

test('domain mutations refresh provider status after the mutation', async () => {
  const calls = [];
  mod.__setSyncIpcInvokeForTests(async (command) => {
    calls.push(command);
    if (command === 'sync_hosts_upload') {
      return { domain: 'hosts', uploaded: 1, credentialsUploaded: 0, skipped: 0, syncedAt: 42 };
    }
    if (command === 'sync_status') {
      return { connected: true, lastSync: 42 };
    }
    throw new Error(`unexpected command ${command}`);
  });
  try {
    const result = await mod.syncIpc.hostsUpload('google');
    assert.equal(result.syncedAt, 42);
    assert.deepEqual(calls, ['sync_hosts_upload', 'sync_status']);
  } finally {
    mod.__resetSyncIpcInvokeForTests();
  }
});
