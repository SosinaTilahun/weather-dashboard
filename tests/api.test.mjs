import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchCitiesOverview, fetchWeatherData, getDashboardData } from '../js/api.js';
import { createDemoFetch } from '../js/demo.js';
import { WeatherApiError } from '../js/errors.js';
import { PromiseQueue } from '../js/queue.js';
import { currentPayload, delay, json, recordingSleep, retryOpts, routeUrl } from './helpers.mjs';

const ctx = (extra = {}) => ({ queue: new PromiseQueue({ concurrency: 2 }), retry: retryOpts, sleepFn: recordingSleep(), ...extra });

test('getDashboardData returns normalised place, current weather and a 5-day forecast', async () => {
  const data = await getDashboardData('Addis Ababa', ctx({ fetchImpl: async (url) => routeUrl(url) }));
  assert.equal(data.place.name, 'Addis Ababa');
  assert.equal(data.current.temperature, 21.4);
  assert.equal(data.current.label, 'Partly cloudy');
  assert.equal(data.forecast.length, 5);
  assert.equal(data.forecast[4].label, 'Thunderstorm');
});

test('Promise.all: current weather and forecast are in flight at the same time', async () => {
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = async (url, { signal }) => {
    if (url.includes('geocoding')) return routeUrl(url);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await delay(20, signal);
    inFlight--;
    return routeUrl(url);
  };
  await getDashboardData('Addis Ababa', ctx({ fetchImpl }));
  assert.equal(peak, 2);
});

test('the queue caps real HTTP calls at 2 even when 6 cities are requested together', async () => {
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = async (url, { signal }) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await delay(10, signal);
    inFlight--;
    return json(currentPayload);
  };
  const cities = Array.from({ length: 6 }, (_, i) => ({ name: `City ${i}`, latitude: i, longitude: i }));
  const results = await fetchCitiesOverview(cities, ctx({ fetchImpl }));
  assert.equal(peak, 2);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 6);
});

test('fetchWeatherData retries 503 twice then succeeds (3 attempts, backoff 500ms then 1000ms)', async () => {
  let calls = 0;
  const sleepFn = recordingSleep();
  const events = [];
  const data = await fetchWeatherData('https://example.test/x', {
    ...ctx({ sleepFn }),
    onEvent: (e) => events.push(e.type),
    fetchImpl: async () => (++calls < 3 ? json({}, 503, 'Service Unavailable') : json({ ok: true })),
  });
  assert.deepEqual(data, { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(sleepFn.delays, [500, 1000]);
  assert.deepEqual(events.filter((t) => t === 'request:retry'), ['request:retry', 'request:retry']);
});

test('after 3 failed attempts the error is a WeatherApiError with kind, status and attempts', async () => {
  let calls = 0;
  await assert.rejects(
    fetchWeatherData('https://example.test/x', {
      ...ctx(),
      fetchImpl: async () => {
        calls++;
        return json({}, 503, 'Service Unavailable');
      },
    }),
    (err) => err instanceof WeatherApiError && err.kind === 'http' && err.status === 503 && err.attempts === 3,
  );
  assert.equal(calls, 3);
});

test('a 404 is reported immediately without retries', async () => {
  let calls = 0;
  await assert.rejects(
    fetchWeatherData('https://example.test/x', {
      ...ctx(),
      fetchImpl: async () => {
        calls++;
        return json({}, 404, 'Not Found');
      },
    }),
    (err) => err.kind === 'http' && err.status === 404 && err.attempts === 1,
  );
  assert.equal(calls, 1);
});

test('network failures are classified as kind "network" after retries', async () => {
  await assert.rejects(
    fetchWeatherData('https://example.test/x', {
      ...ctx(),
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    }),
    (err) => err.kind === 'network' && err.attempts === 3,
  );
});

test('invalid JSON becomes a non-retried parse error', async () => {
  let calls = 0;
  await assert.rejects(
    fetchWeatherData('https://example.test/x', {
      ...ctx(),
      fetchImpl: async () => {
        calls++;
        return new Response('<html>nope</html>', { status: 200 });
      },
    }),
    (err) => err.kind === 'parse',
  );
  assert.equal(calls, 1);
});

test('a per-attempt timeout is retried and finally reported as kind "timeout"', async () => {
  let calls = 0;
  await assert.rejects(
    fetchWeatherData('https://example.test/x', {
      ...ctx({ retry: { ...retryOpts, maxAttempts: 2 } }),
      timeoutMs: 15,
      fetchImpl: async (url, { signal }) => {
        calls++;
        await delay(1000, signal); // never finishes in time
      },
    }),
    (err) => err.kind === 'timeout' && err.attempts === 2,
  );
  assert.equal(calls, 2);
});

test('AbortController cancels an in-flight request and the error stays an AbortError', async () => {
  const controller = new AbortController();
  const events = [];
  const promise = fetchWeatherData('https://example.test/x', {
    ...ctx(),
    signal: controller.signal,
    onEvent: (e) => events.push(e.type),
    fetchImpl: async (url, { signal }) => {
      await delay(1000, signal);
      return json({});
    },
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(promise, { name: 'AbortError' });
  assert.ok(events.includes('request:aborted'));
  assert.ok(!events.includes('request:retry'), 'a cancelled request must not be retried');
});

test('stale search: starting a new request and aborting the old one never lets old data through', async () => {
  const slowFetch = async (url, { signal }) => {
    if (url.includes('geocoding')) await delay(50, signal);
    return routeUrl(url);
  };
  const oldController = new AbortController();
  const oldSearch = getDashboardData('Addis Ababa', ctx({ fetchImpl: slowFetch, signal: oldController.signal }));
  const newSearch = getDashboardData('Addis Ababa', ctx({ fetchImpl: async (u) => routeUrl(u) }));
  oldController.abort();
  await assert.rejects(oldSearch, { name: 'AbortError' });
  assert.equal((await newSearch).place.name, 'Addis Ababa');
});

test('if one parallel request fails, the sibling request is cancelled', async () => {
  let forecastAborted = false;
  const fetchImpl = async (url, { signal }) => {
    if (url.includes('geocoding')) return routeUrl(url);
    if (url.includes('current=')) return json({}, 404, 'Not Found');
    try {
      await delay(1000, signal);
    } catch (error) {
      forecastAborted = true;
      throw error;
    }
    return routeUrl(url);
  };
  await assert.rejects(getDashboardData('Addis Ababa', ctx({ fetchImpl })), (err) => err.kind === 'http' && err.status === 404);
  assert.equal(forecastAborted, true);
});

test('unknown city gives a friendly "notfound" error', async () => {
  await assert.rejects(
    getDashboardData('Nowhereville', ctx({ fetchImpl: async () => json({}) })),
    (err) => err.kind === 'notfound' && /Nowhereville/.test(err.message),
  );
});

test('queue slots are released after failures (no deadlock)', async () => {
  const queue = new PromiseQueue({ concurrency: 2 });
  const failing = { ...ctx({ queue }), fetchImpl: async () => json({}, 503) };
  await Promise.allSettled([1, 2, 3].map(() => fetchWeatherData('https://example.test/x', failing)));
  assert.deepEqual(queue.stats, { active: 0, pending: 0, concurrency: 2 });
});

test('demo fetch "flaky" mode fails twice per URL then succeeds', async () => {
  const demo = createDemoFetch(() => 'flaky', { realFetch: async () => json({ ok: true }) });
  assert.equal((await demo('u')).status, 503);
  assert.equal((await demo('u')).status, 503);
  assert.equal((await demo('u')).status, 200);
});

test('demo fetch "slow" mode honours cancellation', async () => {
  const demo = createDemoFetch(() => 'slow', { slowMs: 1000, realFetch: async () => json({}) });
  const controller = new AbortController();
  const promise = demo('u', { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, { name: 'AbortError' });
});
