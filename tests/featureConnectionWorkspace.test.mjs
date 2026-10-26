import { loadSource } from './helpers/loadSource.mjs';
import { loadWorkspaceDomain } from './helpers/loadWorkspaceDomain.mjs';
import { runFeatureConnectionWorkspaceChecks } from '../.tmp-agent-tests/tests/featureConnectionWorkspace.test.js';

await runFeatureConnectionWorkspaceChecks(loadSource, loadWorkspaceDomain);
console.log('Feature connection workspace regression tests passed.');
