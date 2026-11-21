// Retry with exponential backoff.
//
//   attempt 1 fails -> wait baseDelay * 2^0 = 500ms
//   attempt 2 fails -> wait baseDelay * 2^1 = 1000ms
//   attempt 3 fails -> give up (no wait after the last attempt)

import { createAbortError, isRetryable } from './errors.js';

/** Delay before retry number `attempt` (1-based: the delay after the 1st failure is attempt 1). */
export function computeDelay(attempt, { baseDelayMs = 500, maxDelayMs = 8000, jitter = true, random = Math.random } = {}) {
  const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  if (!jitter) return exponential;
  // "Equal jitter": keep half of the delay, randomise the other half. This stops many
  // clients from retrying in lock-step while still growing exponentially.
  return Math.round(exponential / 2 + random() * (exponential / 2));
}

/** setTimeout as a promise that rejects immediately if the signal aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(createAbortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `task(attempt)` until it succeeds, a non-retryable error is thrown,
 * the signal aborts, or `maxAttempts` is reached.
 *
 * @param {(attempt: number) => Promise<T>} task
 * @param {object} [options]
 * @param {number} [options.maxAttempts=3]
 * @param {number} [options.baseDelayMs=500]
 * @param {number} [options.maxDelayMs=8000]
 * @param {boolean} [options.jitter=true]
 * @param {AbortSignal} [options.signal]
 * @param {(err: unknown) => boolean} [options.shouldRetry]
 * @param {(info: {attempt: number, nextAttempt: number, delayMs: number, error: unknown}) => void} [options.onRetry]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleepFn] injectable for tests
 * @returns {Promise<T>}
 * @template T
 */
export async function retryWithBackoff(task, options = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 8000,
    jitter = true,
    signal,
    shouldRetry = isRetryable,
    onRetry,
    sleepFn = sleep,
  } = options;

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw createAbortError();
    try {
      return await task(attempt);
    } catch (error) {
      const lastAttempt = attempt >= maxAttempts;
      if (lastAttempt || !shouldRetry(error)) {
        // Attach how many tries we made so the UI can report it.
        if (error && typeof error === 'object') error.attempts = attempt;
        throw error;
      }
      const delayMs = computeDelay(attempt, { baseDelayMs, maxDelayMs, jitter });
      onRetry?.({ attempt, nextAttempt: attempt + 1, delayMs, error });
      await sleepFn(delayMs, signal); // rejects with AbortError if cancelled while waiting
    }
  }
}
