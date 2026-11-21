// DOM rendering. Everything is built with createElement/textContent (never innerHTML),
// so text that comes from the API can never inject markup.

const $ = (selector) => document.querySelector(selector);

function el(tag, { className, text, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [key, value] of Object.entries(attrs ?? {})) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

const round = (n) => (typeof n === 'number' ? Math.round(n) : '–');

// ---------------------------------------------------------------- status banner

export function setStatus(kind, message) {
  const status = $('#status');
  status.className = `status ${kind}`;
  status.textContent = message;
}

// The search button stays enabled while a request runs on purpose: submitting a new search
// cancels the stale one (see RequestManager). Only Cancel is tied to the busy state.
export function setBusy(busy) {
  $('#cancel-btn').disabled = !busy;
}

// ---------------------------------------------------------------- queue meter

export function renderQueue({ active, pending, concurrency }) {
  const slots = $('#queue-slots');
  if (slots.children.length !== concurrency) {
    slots.replaceChildren(...Array.from({ length: concurrency }, () => el('span', { className: 'slot' })));
  }
  [...slots.children].forEach((slot, i) => slot.classList.toggle('busy', i < active));
  $('#queue-text').textContent = active === 0 && pending === 0 ? 'idle' : `${active}/${concurrency} running, ${pending} waiting`;
}

// ---------------------------------------------------------------- results

export function renderDashboard({ place, current, forecast }) {
  const unit = (key, fallback) => current.units?.[key] ?? fallback;
  const where = [place.name, place.admin, place.country].filter(Boolean).join(', ');

  $('#current').replaceChildren(
    el('div', { className: 'place', text: where }),
    el('div', { className: 'temp', text: `${round(current.temperature)}${unit('temperature_2m', '°C')}` }),
    el('div', { className: 'cond', text: `${current.icon} ${current.label}` }),
    el('dl', {}, [
      el('dt', { text: 'Feels like' }), el('dd', { text: `${round(current.feelsLike)}${unit('apparent_temperature', '°C')}` }),
      el('dt', { text: 'Humidity' }), el('dd', { text: `${round(current.humidity)}${unit('relative_humidity_2m', '%')}` }),
      el('dt', { text: 'Wind' }), el('dd', { text: `${round(current.windSpeed)} ${unit('wind_speed_10m', 'km/h')}` }),
    ]),
  );

  $('#forecast').replaceChildren(
    el('h2', { text: '5-day forecast' }),
    el(
      'div',
      { className: 'days' },
      forecast.map((day) =>
        el('div', { className: 'day' }, [
          el('div', { className: 'dow', text: new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) }),
          el('div', { className: 'icon', text: day.icon, attrs: { title: day.label, 'aria-label': day.label } }),
          el('div', { className: 'hi', text: `${round(day.max)}°` }),
          el('div', { className: 'lo', text: `${round(day.min)}°` }),
          el('div', { className: 'rain', text: `${day.precipitation ?? 0} mm` }),
        ]),
      ),
    ),
  );

  $('#dashboard').hidden = false;
}

export function hideDashboard() {
  $('#dashboard').hidden = true;
}

export function renderCities(results, cities) {
  $('#cities').replaceChildren(
    ...results.map((result, i) => {
      const name = cities[i].name;
      if (result.status === 'rejected') {
        return el('div', { className: 'city failed' }, [el('div', { className: 'n', text: name }), el('div', { text: 'Failed to load' })]);
      }
      const { current } = result.value;
      return el('div', { className: 'city' }, [
        el('div', { className: 'n', text: name }),
        el('div', { className: 't', text: `${round(current.temperature)}° ${current.icon}` }),
        el('div', { text: current.label }),
      ]);
    }),
  );
  $('#cities-section').hidden = false;
}

// ---------------------------------------------------------------- request log

const TAGS = {
  'request:queued': ['queued', 'QUEUED'],
  'request:attempt': ['attempt', 'START'],
  'request:retry': ['retry', 'RETRY'],
  'request:success': ['success', 'OK'],
  'request:failed': ['failed', 'FAILED'],
  'request:aborted': ['aborted', 'CANCELLED'],
};

const trimDot = (text = '') => text.replace(/\.$/, '');

function describeEvent(event) {
  switch (event.type) {
    case 'request:attempt':
      return `${event.label} (attempt ${event.attempt})`;
    case 'request:retry':
      return `${event.label}: ${trimDot(event.reason)}. Retrying in ${event.delayMs} ms (attempt ${event.nextAttempt})`;
    case 'request:failed':
      return `${event.label}: gave up after ${event.attempts} attempt${event.attempts === 1 ? '' : 's'}. ${trimDot(event.reason)}`;
    default:
      return event.label;
  }
}

export function logEvent(event) {
  const [cls, tag] = TAGS[event.type] ?? ['queued', event.type];
  const log = $('#log');
  log.querySelector('.empty')?.remove();
  const time = new Date().toLocaleTimeString([], { hour12: false });
  log.prepend(
    el('li', { className: cls }, [el('time', { text: time }), el('span', { className: 'tag', text: tag }), el('span', { text: describeEvent(event) })]),
  );
  while (log.children.length > 200) log.lastElementChild.remove();
}

export function logNote(message) {
  logEvent({ type: 'note', label: message });
}

export function clearLog() {
  $('#log').replaceChildren(el('li', { className: 'empty', text: 'No requests yet.' }));
}
