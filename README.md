# Async Weather Dashboard

A modular JavaScript weather dashboard that demonstrates robust async code: `fetch` + `async/await`, retries with exponential backoff, parallel requests with `Promise.all`, request cancellation with `AbortController`, and a Promise-based queue limiting concurrency to 2. Plain ES modules, no dependencies, no build step.

Data comes from the free [Open-Meteo](https://open-meteo.com/) API (no API key).

## Run

```bash
npm start            # serves http://localhost:5173  (needs Node 20+)
# or: python3 -m http.server 5173
npm test             # 36 unit tests (node:test, mocked fetch)
```

ES modules do not load from `file://`, so open the app through a local server.

## Requirement map

| Requirement | Where |
|---|---|
| `fetchWeatherData` with try/catch | `js/api.js` |
| Retry, exponential backoff, max 3 attempts | `js/retry.js` (`retryWithBackoff`, 500 ms then 1000 ms) |
| `Promise.all` current + 5-day forecast | `js/api.js` (`getDashboardData`) |
| `AbortController` cancels stale requests | `js/requestManager.js`, used in `js/main.js` |
| Promise queue, 2 concurrent calls | `js/queue.js` (`PromiseQueue`) |
| ES modules | everything under `js/` |

## Structure

```
index.html            page
css/styles.css
js/config.js          URLs, limits (maxConcurrent, retry, timeout)
js/errors.js          HttpError, WeatherApiError, isRetryable, isAbortError
js/retry.js           retryWithBackoff, computeDelay, sleep
js/queue.js           PromiseQueue
js/requestManager.js  one AbortController per slot, newest request wins
js/api.js             fetchWeatherData, geocodeCity, getDashboardData, ...
js/demo.js            network simulation (slow / flaky / down / offline)
js/ui.js, js/main.js  rendering and wiring
tests/                node:test suites
```

## Demo controls

Use **Network simulation** to show each behaviour on demand:

- **Flaky server**: each URL fails twice with 503, then succeeds. The log shows RETRY lines with growing delays.
- **Slow network**: requests wait 4 s. Press **Cancel** (or search again) to see CANCELLED.
- **Server down**: always 503. After 3 attempts the error banner appears.
- **Compare 6 cities**: six requests are queued at once; the Queue meter never exceeds 2 running.

## Design notes

- The queue wraps each *attempt*, not the whole retry loop, so a request waiting out its backoff does not occupy a slot.
- 4xx errors (except 408/429) are not retried; cancellations are never retried.
- If one of the two parallel requests fails, its sibling is cancelled.
- All API text is rendered with `textContent`, never `innerHTML`.
