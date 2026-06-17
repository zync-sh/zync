import assert from 'node:assert/strict';
import { runSerializedConnectionOp } from '../.tmp-agent-tests/src/features/connections/infrastructure/connectionOpQueue.js';

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ok ${name}`);
  } catch (error) {
    console.error(`  fail ${name}`);
    throw error;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  await runTest('runSerializedConnectionOp runs same-host ops in order', async () => {
    const order = [];
    await Promise.all([
      runSerializedConnectionOp('ssh_host', async () => {
        order.push('disconnect-start');
        await sleep(30);
        order.push('disconnect-end');
      }),
      runSerializedConnectionOp('ssh_host', async () => {
        order.push('connect-start');
        order.push('connect-end');
      }),
    ]);

    assert.deepEqual(order, [
      'disconnect-start',
      'disconnect-end',
      'connect-start',
      'connect-end',
    ]);
  });

  await runTest('runSerializedConnectionOp does not block unrelated hosts', async () => {
    const order = [];
    await Promise.all([
      runSerializedConnectionOp('ssh_a', async () => {
        order.push('a-start');
        await sleep(30);
        order.push('a-end');
      }),
      runSerializedConnectionOp('ssh_b', async () => {
        order.push('b-start');
        order.push('b-end');
      }),
    ]);

    assert.ok(order.includes('a-start'));
    assert.ok(order.includes('a-end'));
    assert.ok(order.includes('b-start'));
    assert.ok(order.includes('b-end'));
    assert.ok(
      order.indexOf('b-end') < order.indexOf('a-end'),
      'unrelated host ops should not block each other',
    );
  });

  console.log('Connection op queue tests passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});