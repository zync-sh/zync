import assert from 'node:assert/strict';
import fs from 'node:fs';

import ts from 'typescript';

// Execute actual reload teardown and recovery gating without rendering React.
const source = fs.readFileSync('src/context/PluginContext.tsx', 'utf8');
const start = source.indexOf(
    'runtimeSupervisor.current.stopAll(',
    source.indexOf('const reloadPluginsUnsafe'),
);
const end = source.indexOf("console.log('[Plugins] Discovered:'", start);
assert.ok(start >= 0 && end > start);
const code = ts.transpileModule(
    `async function gate(getNativePluginRecoveryStatus, isCurrent, setPluginSafeMode, runtimeSupervisor) {
const healthCheckPluginId = undefined;
const rejectPendingPluginNotifyActionsForPlugin = () => {};
const resetNativePluginRuntimes = async () => {};
const ipcRenderer = { invoke: async () => [] };
const setCommands = value => { registrations.commands = value; };
const setPanels = value => { registrations.panels = value; };
const paneMessageTargets = { current: registrations.targets };
const paneBindingQueue = { current: registrations.bindings };
${source.slice(start, end)}
return recovery;
}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const registrations = {
    commands: [] as { id: string }[],
    panels: [] as { id: string }[],
    targets: new Map<string, object>(),
    bindings: new Map<string, object>(),
};
type RestoreCall = [pluginId: string, timestamps: number[], kind: string];
type Recovery = {
    safeMode: boolean;
    diagnostics: { pluginId: string; failures: { atMs: number; kind: string }[] }[];
};
const restored: RestoreCall[] = [];
let stops = 0;
const supervisor = {
    current: {
        stopAll: () => {
            stops += 1;
        },
        restoreFailures: (...args: RestoreCall) => restored.push(args),
    },
};
const gate = new Function('registrations', `${code}; return gate;`)(registrations) as (
    readRecovery: () => Promise<Recovery>,
    isCurrent: () => boolean,
    setSafeMode: (value: boolean) => void,
    supervisor: {
        current: { stopAll: () => void; restoreFailures: (...args: RestoreCall) => number };
    },
) => Promise<Recovery>;
let safeMode: boolean | undefined;
const readError = new Error('IPC unavailable');
await assert.rejects(
    gate(
        async () => {
            throw readError;
        },
        () => true,
        (value) => {
            safeMode = value;
        },
        supervisor,
    ),
    /Plugin startup blocked: recovery history is unavailable/,
);
assert.deepEqual(restored, [], 'failed reads must not replace retained quarantine');
assert.equal(safeMode, undefined, 'failed reads must not change recovery state');
const recovery = await gate(
    async () => ({
        safeMode: true,
        diagnostics: [
            {
                pluginId: 'dev.example.monitor',
                failures: [{ atMs: 123, kind: 'worker-error' }],
            },
        ],
    }),
    () => true,
    (value) => {
        safeMode = value;
    },
    supervisor,
);
assert.equal(recovery.safeMode, false, 'legacy global pause remains disabled');
assert.deepEqual(restored, [['dev.example.monitor', [123], 'worker-error']]);
assert.equal(safeMode, false);
// Simulate contributions from the successful generation, then fail the next reload.
registrations.commands = [{ id: 'monitor.refresh' }];
registrations.panels = [{ id: 'monitor.panel' }];
registrations.targets.set('pane', {});
registrations.bindings.set('pane', {});
const previousStops = stops;
await assert.rejects(
    gate(
        async () => {
            throw readError;
        },
        () => true,
        (value) => {
            safeMode = value;
        },
        supervisor,
    ),
    /Plugin startup blocked/,
);
assert.equal(stops, previousStops + 1);
assert.deepEqual(registrations.commands, []);
assert.deepEqual(registrations.panels, []);
assert.equal(registrations.targets.size, 0);
assert.equal(registrations.bindings.size, 0);
console.log('Plugin recovery startup gate regression tests passed.');
