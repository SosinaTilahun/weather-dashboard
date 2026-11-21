// Shared test helpers: fake API payloads and an abort-aware delay.

export const json = (body, status = 200, statusText = '') =>
  new Response(JSON.stringify(body), { status, statusText, headers: { 'content-type': 'application/json' } });

export const geocodePayload = { results: [{ name: 'Addis Ababa', country: 'Ethiopia', admin1: 'Addis Ababa', latitude: 9.03, longitude: 38.74 }] };

export const currentPayload = {
  current_units: { temperature_2m: '°C', relative_humidity_2m: '%', apparent_temperature: '°C', wind_speed_10m: 'km/h' },
  current: { time: '2026-11-15T12:00', temperature_2m: 21.4, relative_humidity_2m: 55, apparent_temperature: 20.8, weather_code: 2, wind_speed_10m: 9.5 },
};

export const forecastPayload = {
  daily: {
    time: ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'],
    weather_code: [2, 3, 61, 0, 95],
    temperature_2m_max: [24, 23, 20, 25, 22],
    temperature_2m_min: [11, 12, 12, 10, 13],
    precipitation_sum: [0, 0.2, 5.1, 0, 12.4],
  },
};

/** Resolves after `ms`, or rejects with the signal's reason (like a real fetch would). */
export function delay(ms, signal) {
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

/** Default router for the three endpoints used by the dashboard. */
export function routeUrl(url) {
  if (url.includes('geocoding-api')) return json(geocodePayload);
  if (url.includes('current=')) return json(currentPayload);
  if (url.includes('daily=')) return json(forecastPayload);
  return json({}, 404, 'Not Found');
}

/** Retry options for tests: same shape as production, but deterministic. */
export const retryOpts = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000, jitter: false };

/** A sleep replacement that records delays and returns immediately. */
export function recordingSleep() {
  const delays = [];
  const fn = async (ms) => {
    delays.push(ms);
  };
  fn.delays = delays;
  return fn;
}
