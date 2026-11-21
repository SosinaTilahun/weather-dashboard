import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PromiseQueue } from '../js/queue.js';
import { RequestManager } from '../js/requestManager.js';
import { delay } from './helpers.mjs';

test('never runs more than 2 tasks at once', async () => {
  const queue = new PromiseQueue({ concurrency: 2 });
  let running = 0;
  let peak = 0;
  const task = async () => {
    running++;
    peak = Math.max(peak, running);
    await delay(15);
    running--;
  };
  await Promise.all(Array.from({ length: 8 }, () => queue.add(task)));
  assert.equal(peak, 2);
  assert.deepEqual(queue.stats, { active: 0, pending: 0, concurrency: 2 });
});

test('starts tasks in FIFO order and returns each result', async () => {
  const queue = new PromiseQueue({ concurrency: 2 });
  const started = [];
  const results = await Promise.all(
    [0, 1, 2, 3, 4].map((n) =>
      queue.add(async () => {
        started.push(n);
        await delay(5);
        return n * 10;
      }),
    ),
  );
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  assert.deepEqual(results, [0, 10, 20, 30, 40]);
});

test('a rejected task does not block the queue', async () => {
  const queue = new PromiseQueue({ concurrency: 1 });
  const bad = queue.add(async () => {
    throw new Error('boom');
  });
  const good = queue.add(async () => 'fine');
  await assert.rejects(bad, /boom/);
  assert.equal(await good, 'fine');
});

test('a synchronous throw inside a task is caught too', async () => {
  const queue = new PromiseQueue({ concurrency: 1 });
  await assert.rejects(
    queue.add(() => {
      throw new Error('sync');
    }),
    /sync/,
  );
  assert.equal(await queue.add(() => 1), 1);
});

test('aborting a waiting task removes it from the queue without running it', async () => {
  const queue = new PromiseQueue({ concurrency: 1 });
  const blocker = queue.add(() => delay(40));
  const controller = new AbortController();
  let ran = false;
  const waiting = queue.add(() => (ran = true), { signal: controller.signal });
  assert.equal(queue.stats.pending, 1);
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(queue.stats.pending, 0);
  await blocker;
  assert.equal(ran, false);
});

test('adding with an already aborted signal rejects right away', async () => {
  const queue = new PromiseQueue({ concurrency: 2 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(queue.add(() => 1, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(queue.stats.pending, 0);
});

test('onChange reports active and waiting counts', async () => {
  const seen = [];
  const queue = new PromiseQueue({ concurrency: 2, onChange: (s) => seen.push(`${s.active}/${s.pending}`) });
  await Promise.all([1, 2, 3].map(() => queue.add(() => delay(5))));
  assert.ok(seen.includes('2/1'), `expected a moment with 2 running and 1 waiting, got ${seen}`);
  assert.equal(seen.at(-1), '0/0');
});

test('rejects invalid concurrency', () => {
  assert.throws(() => new PromiseQueue({ concurrency: 0 }), RangeError);
  assert.throws(() => new PromiseQueue({ concurrency: 1.5 }), RangeError);
});

test('RequestManager.start cancels the previous request in the same slot', () => {
  const manager = new RequestManager();
  const first = manager.start('search');
  const second = manager.start('search');
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
  assert.equal(manager.isCurrent('search', second), true);
  assert.equal(manager.isCurrent('search', first), false);
});

test('RequestManager.cancel aborts and clears; finish only clears the current one', () => {
  const manager = new RequestManager();
  const a = manager.start('x');
  assert.equal(manager.cancel('x'), true);
  assert.equal(a.signal.aborted, true);
  assert.equal(manager.cancel('x'), false);

  const old = manager.start('y');
  const current = manager.start('y');
  manager.finish('y', old); // stale controller: ignored
  assert.equal(manager.has('y'), true);
  manager.finish('y', current);
  assert.equal(manager.has('y'), false);
});
