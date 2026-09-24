import assert from 'node:assert/strict';
import { bumpFeature, createQueueState, markCurrentFlushed, sealDay, utcDay } from '../.tmp-agent-tests/src/features/usage/queue.js';
import { clearUsageSession, ensureUsageSession } from '../.tmp-agent-tests/src/features/usage/session.js';

function run(name, fn) {
  try {
    fn();
    console.log(`ok ${name}`);
  } catch (error) {
    console.error(`not ok ${name}`);
    throw error;
  }
}

run('utcDay is YYYY-MM-DD', () => {
  assert.match(utcDay(new Date('2026-09-20T15:00:00.000Z')), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(utcDay(new Date('2026-09-20T15:00:00.000Z')), '2026-09-20');
});

run('bumpFeature increments and marks dirty', () => {
  const next = bumpFeature(createQueueState(new Date('2026-09-20T12:00:00.000Z')), 'files', new Date('2026-09-20T12:00:00.000Z'));
  assert.equal(next.current.features.files, 1);
  assert.equal(next.current.dirty, true);
  const twice = bumpFeature(next, 'files', new Date('2026-09-20T12:01:00.000Z'));
  assert.equal(twice.current.features.files, 2);
});

run('many UTC rollovers keep only 7 pending days', () => {
  let state = createQueueState(new Date('2026-09-01T12:00:00.000Z'));
  for (let day = 1; day <= 10; day += 1) {
    const stamp = `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;
    state = bumpFeature(state, 'files', new Date(stamp));
  }
  assert.equal(state.pending.length, 7);
  assert.equal(state.pending[0].day, '2026-09-03');
  assert.equal(state.current.day, '2026-09-10');
});

run('markCurrentFlushed clears dirty when counts did not grow', () => {
  const sent = bumpFeature(createQueueState(new Date('2026-09-20T12:00:00.000Z')), 'files', new Date('2026-09-20T12:00:00.000Z'));
  const flushed = markCurrentFlushed(sent, sent.current, 1_000);
  assert.equal(flushed.current.dirty, false);
  assert.equal(flushed.lastFlushAt, 1_000);
});

run('markCurrentFlushed keeps dirty when counts grew after the snapshot', () => {
  const sent = bumpFeature(createQueueState(new Date('2026-09-20T12:00:00.000Z')), 'files', new Date('2026-09-20T12:00:00.000Z'));
  const grew = bumpFeature(sent, 'files', new Date('2026-09-20T12:01:00.000Z'));
  const flushed = markCurrentFlushed(grew, sent.current, 2_000);
  assert.equal(flushed.current.dirty, true);
  assert.equal(flushed.current.features.files, 2);
  assert.equal(flushed.lastFlushAt, 2_000);
});

run('UTC rollover stores that day open time before it becomes pending', () => {
  clearUsageSession();
  ensureUsageSession(new Date('2026-09-23T22:00:00.000Z'));
  const day = createQueueState(new Date('2026-09-23T22:00:00.000Z'));
  const sealed = sealDay(day.current, new Date('2026-09-24T01:30:00.000Z'));
  assert.equal(sealed.openSeconds, 2 * 60 * 60);
  assert.equal(sealed.sessions.length, 1);
  assert.equal(sealed.sessions[0].closedAt, '2026-09-24T00:00:00.000Z');
  clearUsageSession();
});

run('a session that starts the next day does not seal the previous day', () => {
  clearUsageSession();
  ensureUsageSession(new Date('2026-09-24T01:00:00.000Z'));
  const day = createQueueState(new Date('2026-09-23T22:00:00.000Z'));
  const sealed = sealDay(day.current, new Date('2026-09-24T01:30:00.000Z'));
  assert.equal(sealed.openSeconds, undefined);
  assert.equal(sealed.sessions, undefined);
  clearUsageSession();
});

run('UTC rollover keeps the unsent day in pending', () => {
  const day1 = bumpFeature(createQueueState(new Date('2026-09-20T12:00:00.000Z')), 'files', new Date('2026-09-20T12:00:00.000Z'));
  const day2 = bumpFeature(day1, 'tunnels', new Date('2026-09-21T01:00:00.000Z'));
  assert.equal(day2.current.day, '2026-09-21');
  assert.equal(day2.pending.length, 1);
  assert.equal(day2.pending[0].day, '2026-09-20');
  assert.equal(day2.pending[0].features.files, 1);
});
