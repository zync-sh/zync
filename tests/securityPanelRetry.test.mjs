import { loadSource } from './helpers/loadSource.mjs';
import { runSecurityPanelRetryChecks } from '../.tmp-agent-tests/tests/securityPanelRetry.test.js';

runSecurityPanelRetryChecks(loadSource);
console.log('Security panel sudo-retry guards passed.');
