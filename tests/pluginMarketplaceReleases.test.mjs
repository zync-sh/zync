import assert from 'node:assert/strict';
import { selectMarketplaceReleases } from '../.tmp-agent-tests/src/features/plugins/marketplace/releases.js';

const releases = [
  { id: 'dev.example.one', version: '1.0.0', channel: 'stable' },
  { id: 'dev.example.one', version: '1.1.0-beta.1', channel: 'beta' },
  { id: 'dev.example.one', version: '1.1.0-beta.2', channel: 'beta' },
  { id: 'dev.example.two', version: '2.0.0', channel: 'stable' },
];
assert.deepEqual(selectMarketplaceReleases(releases, new Set()).map(item => item.version), ['1.0.0', '2.0.0']);
assert.deepEqual(selectMarketplaceReleases(releases, new Set(['dev.example.one'])).map(item => item.version), ['1.1.0-beta.2', '2.0.0']);
assert.deepEqual(selectMarketplaceReleases(releases, new Set(['dev.example.two'])).map(item => item.version), ['1.0.0', '2.0.0']);
console.log('Plugin marketplace release selection tests passed.');
