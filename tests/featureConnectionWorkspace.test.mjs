import { runFeatureConnectionWorkspaceChecks } from '../.tmp-agent-tests/tests/workspace/featureConnectionWorkspace.test.js';
import { loadSource } from './helpers/loadSource.mjs';
import { loadWorkspaceDomain } from './helpers/loadWorkspaceDomain.mjs';

await runFeatureConnectionWorkspaceChecks(loadSource, loadWorkspaceDomain);
console.log('Feature connection workspace regression tests passed.');
