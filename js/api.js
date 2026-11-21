// Weather API layer (Open-Meteo): fetch + async/await, error handling, retries,
// parallel requests (Promise.all), cancellation (AbortController) and queued concurrency.

import { CONFIG } from './config.js';
import { HttpError, WeatherApiError, isAbortError } from './errors.js';
import { PromiseQueue } from './queue.js';
import { retryWithBackoff } from './retry.js';
import { describeWeather } from './weatherCodes.js';

const noop = () => {};

// One shared queue so the "max 2 concurrent calls" rule holds for the whole app.
let sharedQueue;
export function getSharedQueue() {
  sharedQueue ??= new PromiseQueue({ concurrency: CONFIG.maxConcurrent });
  return sharedQueue;
}

/** @typedef {{signal?: AbortSignal, queue?: PromiseQueue, fetchImpl?: typeof fetch, onEvent?: (e: object) => void, retry?: object, timeoutMs?: number, sleepFn?: Function}} RequestContext */

// ---------------------------------------------------------------- URL builders

function buildUrl(base, params) {
  const url = new URL(base);
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

export const buildGeocodeUrl = (city) =>
  buildUrl(CONFIG.geocodeUrl, { name: city, count: '1', language: 'en', format: 'json' });

export const buildCurrentUrl = ({ latitude, longitude }) =>
  buildUrl(CONFIG.forecastUrl, {
    latitude,
    longitude,
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
    timezone: 'auto',
  });

export const buildForecastUrl = ({ latitude, longitude }) =>
  buildUrl(CONFIG.forecastUrl, {
    latitude,
    longitude,
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum',
    forecast_days: '5',
    timezone: 'auto',
  });

// ---------------------------------------------------------------- low-level fetch

function combineSignals(signals) {
  const list = signals.filter(Boolean);
  return list.length > 1 ? AbortSignal.any(list) : list[0];
}

/** One HTTP attempt: applies the per-attempt timeout, checks the status, parses JSON. */
async function fetchJson(url, { signal, timeoutMs, fetchImpl }) {
  const combined = combineSignals([signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null]);
  const response = await fetchImpl(url, { signal: combined });
  if (!response.ok) throw new HttpError(response.status, response.statusText, url);
  try {
    return await response.json();
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw new WeatherApiError('The weather service returned an unreadable response.', { kind: 'parse', cause });
  }
}

/** Turns anything thrown by the network layer into a friendly WeatherApiError. */
function toApiError(error) {
  const attempts = error?.attempts ?? 1;
  if (error instanceof WeatherApiError) return error;
  if (error instanceof HttpError) {
    return new WeatherApiError(`The weather service responded with an error (${error.message}).`, {
      kind: 'http',
      status: error.status,
      attempts,
      cause: error,
    });
  }
  if (error?.name === 'TimeoutError') {
    return new WeatherApiError('The weather service took too long to respond.', { kind: 'timeout', attempts, cause: error });
  }
  if (error instanceof TypeError) {
    return new WeatherApiError('Network error: could not reach the weather service. Check your connection.', {
      kind: 'network',
      attempts,
      cause: error,
    });
  }
  return new WeatherApiError(error?.message || 'Something went wrong.', { kind: 'unknown', attempts, cause: error });
}

// ---------------------------------------------------------------- fetchWeatherData

/**
 * Fetches JSON from the weather API.
 *
 *  - every attempt goes through the shared queue (max 2 HTTP calls at once)
 *  - failed attempts are retried with exponential backoff (max 3 attempts)
 *  - the AbortSignal cancels queued attempts, in-flight fetches and backoff waits
 *  - all failures are caught and rethrown as WeatherApiError (cancellations stay AbortError)
 *
 * The queue wraps each *attempt*, not the whole retry loop, so a request that is waiting
 * out a backoff delay does not hold one of the two slots.
 *
 * @param {string} url
 * @param {RequestContext & {label?: string}} [options]
 */
export async function fetchWeatherData(url, options = {}) {
  const {
    label = url,
    signal,
    queue = getSharedQueue(),
    fetchImpl = globalThis.fetch.bind(globalThis),
    onEvent = noop,
    retry = CONFIG.retry,
    timeoutMs = CONFIG.requestTimeoutMs,
    sleepFn,
  } = options;

  try {
    onEvent({ type: 'request:queued', label });
    const data = await retryWithBackoff(
      (attempt) =>
        queue.add(
          () => {
            onEvent({ type: 'request:attempt', label, attempt });
            return fetchJson(url, { signal, timeoutMs, fetchImpl });
          },
          { signal },
        ),
      {
        ...retry,
        signal,
        sleepFn,
        onRetry: ({ attempt, nextAttempt, delayMs, error }) =>
          onEvent({ type: 'request:retry', label, attempt, nextAttempt, delayMs, reason: toApiError(error).message }),
      },
    );
    onEvent({ type: 'request:success', label });
    return data;
  } catch (error) {
    if (isAbortError(error)) {
      onEvent({ type: 'request:aborted', label });
      throw error;
    }
    const apiError = toApiError(error);
    onEvent({ type: 'request:failed', label, attempts: apiError.attempts, reason: apiError.message });
    throw apiError;
  }
}

// ---------------------------------------------------------------- endpoints

function normalizeCurrent(json) {
  const c = json?.current;
  if (!c) throw new WeatherApiError('Current weather data is missing from the response.', { kind: 'parse' });
  return {
    time: c.time,
    temperature: c.temperature_2m,
    feelsLike: c.apparent_temperature,
    humidity: c.relative_humidity_2m,
    windSpeed: c.wind_speed_10m,
    units: json.current_units ?? {},
    ...describeWeather(c.weather_code),
  };
}

function normalizeForecast(json) {
  const d = json?.daily;
  if (!d?.time) throw new WeatherApiError('Forecast data is missing from the response.', { kind: 'parse' });
  return d.time.map((date, i) => ({
    date,
    max: d.temperature_2m_max[i],
    min: d.temperature_2m_min[i],
    precipitation: d.precipitation_sum[i],
    ...describeWeather(d.weather_code[i]),
  }));
}

/** Looks a city name up and returns {name, country, latitude, longitude}. */
export async function geocodeCity(city, ctx = {}) {
  const query = city.trim();
  if (!query) throw new WeatherApiError('Please enter a city name.', { kind: 'notfound' });
  const json = await fetchWeatherData(buildGeocodeUrl(query), { ...ctx, label: `geocode: ${query}` });
  const hit = json?.results?.[0];
  if (!hit) throw new WeatherApiError(`No city found for "${query}".`, { kind: 'notfound' });
  return { name: hit.name, country: hit.country ?? '', admin: hit.admin1 ?? '', latitude: hit.latitude, longitude: hit.longitude };
}

export async function fetchCurrentWeather(place, ctx = {}) {
  const json = await fetchWeatherData(buildCurrentUrl(place), { ...ctx, label: `current: ${place.name}` });
  return normalizeCurrent(json);
}

export async function fetchForecast(place, ctx = {}) {
  const json = await fetchWeatherData(buildForecastUrl(place), { ...ctx, label: `forecast: ${place.name}` });
  return normalizeForecast(json);
}

/**
 * Full dashboard load for a city name.
 *   1. geocode the name (must come first, the next calls need coordinates)
 *   2. Promise.all: current weather + 5-day forecast at the same time
 *
 * If either parallel request fails, its sibling is cancelled instead of running on for nothing.
 */
export async function getDashboardData(city, ctx = {}) {
  const place = await geocodeCity(city, ctx);

  const sibling = new AbortController();
  const cancelSibling = () => sibling.abort();
  if (ctx.signal?.aborted) sibling.abort();
  else ctx.signal?.addEventListener('abort', cancelSibling, { once: true });

  try {
    const childCtx = { ...ctx, signal: sibling.signal };
    const [current, forecast] = await Promise.all([fetchCurrentWeather(place, childCtx), fetchForecast(place, childCtx)]);
    return { place, current, forecast };
  } catch (error) {
    sibling.abort();
    throw error;
  } finally {
    ctx.signal?.removeEventListener('abort', cancelSibling);
  }
}

/**
 * Loads current weather for many known cities at once. Everything is requested immediately,
 * but the queue lets only two HTTP calls run at a time. Uses allSettled so one failing city
 * does not hide the others.
 */
export function fetchCitiesOverview(cities, ctx = {}) {
  return Promise.allSettled(
    cities.map(async (place) => ({ place, current: await fetchCurrentWeather(place, ctx) })),
  );
}
