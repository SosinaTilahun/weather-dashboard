// Demo helpers: a fetch wrapper that can simulate bad network conditions so retries,
// cancellation and error handling can be shown on demand (also used for the screen recording).
//
//   live    -> real requests, untouched
//   slow    -> every request waits a few seconds first (easy to cancel)
//   flaky   -> each URL fails twice with HTTP 503 and succeeds on the 3rd attempt (shows retries)
//   error   -> always HTTP 503 (shows retries running out)
//   offline -> fetch rejects like a dropped connection

export const DEMO_MODES = Object.freeze({
  live: 'Live API',
  slow: 'Slow network (4s)',
  flaky: 'Flaky server (2 failures, then OK)',
  error: 'Server down (always 503)',
  offline: 'Offline',
});

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const failure = () => new Response('{"error":"simulated"}', { status: 503, statusText: 'Service Unavailable' });

/**
 * @param {() => keyof typeof DEMO_MODES} getMode called on every request, so the mode can change live
 * @param {{slowMs?: number, realFetch?: typeof fetch}} [options]
 */
export function createDemoFetch(getMode, { slowMs = 4000, realFetch = globalThis.fetch.bind(globalThis) } = {}) {
  const tries = new Map();

  return async function demoFetch(url, init = {}) {
    const mode = getMode();

    if (mode === 'slow') await delay(slowMs, init.signal);
    if (mode === 'offline') throw new TypeError('Failed to fetch');
    if (mode === 'error') return failure();
    if (mode === 'flaky') {
      const n = (tries.get(url) ?? 0) + 1;
      tries.set(url, n);
      if (n % 3 !== 0) return failure();
    }
    return realFetch(url, init);
  };
}
