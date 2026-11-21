import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from '../js/errors.js';
import { computeDelay, retryWithBackoff } from '../js/retry.js';
import { recordingSleep, retryOpts } from './helpers.mjs';

test('computeDelay doubles each attempt and respects the cap', () => {
  const o = { baseDelayMs: 500, maxDelayMs: 8000, jitter: false };
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => computeDelay(n, o)), [500, 1000, 2000, 4000, 8000, 8000]);
});

test('computeDelay with jitter stays between half and the full exponential delay', () => {
  const o = { baseDelayMs: 500, maxDelayMs: 8000 };
  assert.equal(computeDelay(2, { ...o, random: () => 0 }), 500);
  assert.equal(computeDelay(2, { ...o, random: () => 1 }), 1000);
});

test('succeeds on the first try without retrying', async () => {
  const sleep = recordingSleep();
  const result = await retryWithBackoff(async () => 'ok', { ...retryOpts, sleepFn: sleep });
  assert.equal(result, 'ok');
  assert.deepEqual(sleep.delays, []);
});

test('retries failures with exponential backoff and then succeeds', async () => {
  const sleep = recordingSleep();
  let calls = 0;
  const result = await retryWithBackoff(
    async (attempt) => {
      calls++;
      if (attempt < 3) throw new HttpError(503, 'Service Unavailable');
      return 'finally';
    },
    { ...retryOpts, sleepFn: sleep },
  );
  assert.equal(result, 'finally');
  assert.equal(calls, 3);
  assert.deepEqual(sleep.delays, [500, 1000]);
});

test('gives up after 3 attempts and reports the attempt count', async () => {
  const sleep = recordingSleep();
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(
      async () => {
        calls++;
        throw new HttpError(500, 'Server Error');
      },
      { ...retryOpts, sleepFn: sleep },
    ),
    (err) => err instanceof HttpError && err.attempts === 3,
  );
  assert.equal(calls, 3);
  assert.deepEqual(sleep.delays, [500, 1000]); // no wait after the final failure
});

test('does not retry client errors such as 404', async () => {
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(
      async () => {
        calls++;
        throw new HttpError(404, 'Not Found');
      },
      { ...retryOpts, sleepFn: recordingSleep() },
    ),
  );
  assert.equal(calls, 1);
});

test('retries 429 rate limits and network TypeErrors', async () => {
  let calls = 0;
  const result = await retryWithBackoff(
    async () => {
      calls++;
      if (calls === 1) throw new HttpError(429, 'Too Many Requests');
      if (calls === 2) throw new TypeError('Failed to fetch');
      return 'ok';
    },
    { ...retryOpts, sleepFn: recordingSleep() },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('reports each retry through onRetry', async () => {
  const events = [];
  await assert.rejects(
    retryWithBackoff(
      async () => {
        throw new HttpError(503, 'x');
      },
      { ...retryOpts, sleepFn: recordingSleep(), onRetry: (e) => events.push([e.attempt, e.nextAttempt, e.delayMs]) },
    ),
  );
  assert.deepEqual(events, [
    [1, 2, 500],
    [2, 3, 1000],
  ]);
});

test('abort while waiting for the backoff delay stops retrying immediately', async () => {
  const controller = new AbortController();
  let calls = 0;
  const promise = retryWithBackoff(
    async () => {
      calls++;
      throw new HttpError(503, 'x');
    },
    { ...retryOpts, baseDelayMs: 10_000, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('an already aborted signal never runs the task', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(async () => calls++, { ...retryOpts, signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 0);
});
