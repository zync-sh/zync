import assert from 'node:assert/strict';
import {
  bumpTerminalInputQueueEpoch,
  clearTerminalInputQueue,
  enqueueTerminalInputTask,
} from '../.tmp-agent-tests/src/lib/terminal/inputQueue.js';

const SESSION = 'input-queue-test';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runTest(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok ${name}`))
    .catch((error) => {
      console.error(`  fail ${name}`);
      throw error;
    });
}

await runTest('enqueueTerminalInputTask runs tasks in order', async () => {
  clearTerminalInputQueue(SESSION);
  const order = [];

  enqueueTerminalInputTask(SESSION, async () => {
    order.push('first-start');
    await delay(20);
    order.push('first-end');
  });
  enqueueTerminalInputTask(SESSION, async () => {
    order.push('second');
  });

  await delay(60);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});

await runTest('clearTerminalInputQueue allows a fresh task after drain', async () => {
  clearTerminalInputQueue(SESSION);
  let secondFinished = false;

  enqueueTerminalInputTask(SESSION, async () => {
    await delay(40);
  });

  await delay(5);
  clearTerminalInputQueue(SESSION);

  enqueueTerminalInputTask(SESSION, async () => {
    secondFinished = true;
  });

  await delay(80);
  assert.equal(secondFinished, true);
});

await runTest('bumpTerminalInputQueueEpoch increments epoch', async () => {
  clearTerminalInputQueue(SESSION);
  const first = bumpTerminalInputQueueEpoch(SESSION);
  const second = bumpTerminalInputQueueEpoch(SESSION);
  assert.equal(second, first + 1);
});

await runTest('stale epoch prevents queued task from running', async () => {
  clearTerminalInputQueue(SESSION);
  let executed = false;

  enqueueTerminalInputTask(SESSION, async () => {
    executed = true;
  });
  bumpTerminalInputQueueEpoch(SESSION);

  await delay(20);
  assert.equal(executed, false);
});

console.log('Terminal input queue tests passed.');