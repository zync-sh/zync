import assert from 'node:assert/strict';
import {
  nextSidebarSectionsForVaultToggle,
  resolveVaultExpanded,
} from '../.tmp-agent-tests/src/components/layout/sidebar/vaultNavState.js';

const failures = [];

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}:`, error.message);
    failures.push({ name, error });
  }
}

function makeSettings(overrides = {}) {
  return {
    sidebarSections: {
      vaultExpanded: true,
    },
    ...overrides,
  };
}

runTest('resolveVaultExpanded defaults to true when missing', () => {
  const settings = makeSettings({ sidebarSections: undefined });
  assert.equal(resolveVaultExpanded(settings), true);
});

runTest('resolveVaultExpanded returns explicit value', () => {
  assert.equal(resolveVaultExpanded(makeSettings({ sidebarSections: { vaultExpanded: false } })), false);
  assert.equal(resolveVaultExpanded(makeSettings({ sidebarSections: { vaultExpanded: true } })), true);
});

runTest('nextSidebarSectionsForVaultToggle flips current value', () => {
  const collapsed = nextSidebarSectionsForVaultToggle(
    makeSettings({ sidebarSections: { vaultExpanded: true } }),
    true,
  );
  assert.deepEqual(collapsed, { vaultExpanded: false });

  const expanded = nextSidebarSectionsForVaultToggle(
    makeSettings({ sidebarSections: { vaultExpanded: false } }),
    false,
  );
  assert.deepEqual(expanded, { vaultExpanded: true });
});

if (failures.length > 0) {
  console.error(`\n${failures.length} test(s) failed.`);
  process.exit(1);
}
console.log('Vault nav state tests passed.');
