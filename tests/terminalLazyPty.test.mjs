import assert from 'node:assert/strict';
import { resolveLazyPtyAction } from '../.tmp-agent-tests/src/lib/terminal/terminalLazyPty.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

const activeWorkspace = { isWorkspaceActive: true, isTerminalView: true, isActiveTab: true };

runTest('spawn when active tab has no PTY', () => {
  assert.equal(resolveLazyPtyAction(activeWorkspace, false), 'spawn');
});

runTest('none when active tab already has PTY', () => {
  assert.equal(resolveLazyPtyAction(activeWorkspace, true), 'none');
});

runTest('none for inactive shell tab even when unspawned', () => {
  assert.equal(
    resolveLazyPtyAction({ ...activeWorkspace, isActiveTab: false }, false),
    'none',
  );
});

runTest('none when background workspace host is selected', () => {
  assert.equal(
    resolveLazyPtyAction({ ...activeWorkspace, isWorkspaceActive: false }, true),
    'none',
  );
});

runTest('suspend_panel when leaving terminal view with live PTY', () => {
  assert.equal(
    resolveLazyPtyAction({ ...activeWorkspace, isTerminalView: false }, true),
    'suspend_panel',
  );
});

runTest('none when leaving terminal view without live PTY', () => {
  assert.equal(
    resolveLazyPtyAction({ ...activeWorkspace, isTerminalView: false }, false),
    'none',
  );
});

console.log('Terminal lazy PTY policy tests passed.');