// Entry point: wires the form and buttons to the async API layer.

import { fetchCitiesOverview, getDashboardData } from './api.js';
import { CONFIG } from './config.js';
import { DEMO_MODES, createDemoFetch } from './demo.js';
import { isAbortError } from './errors.js';
import { PromiseQueue } from './queue.js';
import { RequestManager } from './requestManager.js';
import * as ui from './ui.js';

const SEARCH = 'search';
const CITIES = 'cities';

const queue = new PromiseQueue({ concurrency: CONFIG.maxConcurrent, onChange: ui.renderQueue });
const requests = new RequestManager();

const modeSelect = document.querySelector('#mode');
modeSelect.replaceChildren(
  ...Object.entries(DEMO_MODES).map(([value, label]) => Object.assign(document.createElement('option'), { value, textContent: label })),
);
const fetchImpl = createDemoFetch(() => modeSelect.value);

// Everything the API layer needs, minus the per-request AbortSignal.
const baseCtx = { queue, fetchImpl, onEvent: ui.logEvent };

ui.renderQueue(queue.stats);
ui.clearLog();

// ---------------------------------------------------------------- single city search

document.querySelector('#search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const city = new FormData(event.currentTarget).get('city').toString().trim();
  if (!city) return;

  // Starting a new search cancels the previous one (stale request protection).
  const controller = requests.start(SEARCH);
  ui.setBusy(true);
  ui.setStatus('loading', `Loading weather for ${city}…`);

  try {
    const data = await getDashboardData(city, { ...baseCtx, signal: controller.signal });
    ui.renderDashboard(data);
    ui.setStatus('success', `Updated: ${data.place.name}${data.place.country ? ', ' + data.place.country : ''}`);
  } catch (error) {
    if (isAbortError(error)) {
      // Superseded by a newer search? Then the newer one owns the banner.
      if (requests.isCurrent(SEARCH, controller) || !requests.has(SEARCH)) {
        ui.setStatus('cancelled', 'Request cancelled.');
      }
    } else {
      ui.hideDashboard();
      const tries = error.attempts > 1 ? ` (after ${error.attempts} attempts)` : '';
      ui.setStatus('error', `${error.message}${tries}`);
    }
  } finally {
    if (requests.isCurrent(SEARCH, controller)) {
      requests.finish(SEARCH, controller);
      ui.setBusy(false);
    } else if (!requests.has(SEARCH)) {
      ui.setBusy(false); // cancelled via the Cancel button
    }
  }
});

document.querySelector('#cancel-btn').addEventListener('click', () => {
  requests.cancel(SEARCH);
  requests.cancel(CITIES);
});

// ---------------------------------------------------------------- queue demo: six cities at once

document.querySelector('#cities-btn').addEventListener('click', async () => {
  const controller = requests.start(CITIES);
  const cities = CONFIG.presetCities;
  ui.setBusy(true); // enables the Cancel button
  ui.setStatus('loading', `Requesting ${cities.length} cities at once. Only ${CONFIG.maxConcurrent} run at a time…`);

  const results = await fetchCitiesOverview(cities, { ...baseCtx, signal: controller.signal });

  const superseded = !requests.isCurrent(CITIES, controller) && requests.has(CITIES);
  requests.finish(CITIES, controller);
  if (superseded) return; // a newer comparison owns the UI now
  if (!requests.has(SEARCH)) ui.setBusy(false);

  if (controller.signal.aborted) {
    ui.setStatus('cancelled', 'City comparison cancelled.');
    return;
  }
  ui.renderCities(results, cities);
  const failed = results.filter((r) => r.status === 'rejected').length;
  ui.setStatus(failed ? 'error' : 'success', failed ? `${failed} of ${cities.length} cities failed to load.` : `Loaded ${cities.length} cities.`);
});

document.querySelector('#clear-log').addEventListener('click', ui.clearLog);
