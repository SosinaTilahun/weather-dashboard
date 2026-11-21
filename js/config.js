// Central configuration. Open-Meteo is a free public weather API (no API key).
// Docs: https://open-meteo.com/en/docs

export const CONFIG = Object.freeze({
  geocodeUrl: 'https://geocoding-api.open-meteo.com/v1/search',
  forecastUrl: 'https://api.open-meteo.com/v1/forecast',

  // The queue never lets more than this many HTTP calls run at once.
  maxConcurrent: 2,

  retry: Object.freeze({
    maxAttempts: 3, // 1 initial try + 2 retries
    baseDelayMs: 500, // delays: 500ms, 1000ms (then give up)
    maxDelayMs: 8000,
  }),

  // A single attempt that takes longer than this is aborted and may be retried.
  requestTimeoutMs: 8000,

  // Used by the "Compare cities" queue demo (coordinates are known, so no geocoding step).
  presetCities: Object.freeze([
    { name: 'Addis Ababa', latitude: 9.03, longitude: 38.74 },
    { name: 'London', latitude: 51.51, longitude: -0.13 },
    { name: 'Tokyo', latitude: 35.69, longitude: 139.69 },
    { name: 'New York', latitude: 40.71, longitude: -74.01 },
    { name: 'Nairobi', latitude: -1.29, longitude: 36.82 },
    { name: 'Sydney', latitude: -33.87, longitude: 151.21 },
  ]),
});
