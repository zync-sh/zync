import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real router with only IPC substituted; native authorization is
// covered separately by the broker/lease tests.
const source = fs.readFileSync('src/features/plugins/runtime/pluginSshCommand.ts', 'utf8');
const transpiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const calls = [];
let complete;
const exports = {};
vm.runInNewContext(transpiled, { exports, Error, require: () => ({ ipcRenderer: {
  invoke: (...args) => { calls.push(args); return new Promise(resolve => { complete = resolve; }); },
} }) });
const handle = exports.handlePluginSshCommandMessage;
const replies = [];
let current = true;
const options = { type: 'api:ssh-command:execute', payload: { requestId: 'r1', paneInstanceId: 'pane-a', runtimeInstanceId: 'forged', connectionId: 'forged', request: { program: 'pm2', args: ['jlist'] } },
  runtimeInstanceId: 'host-runtime', isCurrent: () => current, respond: reply => replies.push(reply) };
assert.equal(await handle({ ...options, type: 'unrelated' }), false);
await handle({ ...options, runtimeInstanceId: undefined });
assert.match(replies.pop().error, /not registered/);
await handle({ ...options, payload: { requestId: 'r1' } });
assert.match(replies.pop().error, /pane instance/);
const pending = handle(options);
assert.equal(calls[0][0], 'plugins:ssh_command_execute');
assert.equal(calls[0][1].runtimeInstanceId, 'host-runtime');
assert.equal(calls[0][1].connectionId, undefined);
assert.equal(calls[0][1].paneInstanceId, 'pane-a');
complete({ stdout: '[]', exitCode: 0 }); await pending;
assert.equal(replies.pop().result.exitCode, 0);
const stale = handle(options); current = false; complete({ stdout: 'sensitive', exitCode: 0 }); await stale;
assert.equal(replies.length, 0);
console.log('Plugin SSH command routing: host identity, pane scope, validation and stale replies passed.');
