import assert from 'node:assert/strict';
import {
  PluginMessageRateLimiter,
  normalizePluginConfirmRequest,
} from '../.tmp-agent-tests/src/features/plugins/runtime/pluginMessageRateLimiter.js';

let now = 1_000;
const limiter = new PluginMessageRateLimiter(() => now, 3, 1_000);
assert.equal(limiter.consume(), true);
assert.equal(limiter.consume(), true);
assert.equal(limiter.consume(), true);
assert.equal(limiter.consume(), false);
now += 1_000;
assert.equal(limiter.consume(), true);

const normalized = normalizePluginConfirmRequest({
  title: `  ${'t'.repeat(140)}  `,
  message: 'm'.repeat(2_100),
  confirmText: '  Continue  ',
  cancelText: 42,
  variant: 'unexpected',
});
assert.equal(normalized.title.length, 120);
assert.equal(normalized.message.length, 2_000);
assert.equal(normalized.confirmText, 'Continue');
assert.equal(normalized.cancelText, undefined);
assert.equal(normalized.variant, 'primary');

console.log('Plugin Worker message rate and confirmation normalization tests passed.');
