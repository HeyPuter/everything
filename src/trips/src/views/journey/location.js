// Where an entry happened: a place name, a geocoder search, the device position (reverse geocoded) and the weather there.
import { el, uid } from '../../ui/dom.js';
import { button } from '../../ui/bits.js';
import { t } from '../../lib/i18n/index.js';
import { displayLocale } from '../../lib/prefs.js';
import { dedupeResults } from '../../services/geocode.js';
import { icon } from './icons.js';
import { weatherFromCondition } from './model.js';

const isAbort = (error) => error?.name === 'AbortError';
const language = () => { try { return displayLocale(); } catch { return 'en'; } };
const coord = (value) => Math.round(value * 1e6) / 1e6;

/** One-shot device position from a user action. Rejects with `{code}` (`unsupported`, `denied`, `unavailable`). */
export function devicePosition({ timeout = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const geo = globalThis.navigator?.geolocation;
    if (!geo?.getCurrentPosition) { reject(Object.assign(new Error('unsupported'), { code: 'unsupported' })); return; }
    geo.getCurrentPosition(
      (position) => resolve({ lat: coord(position.coords.latitude), lng: coord(position.coords.longitude) }),
      (error) => reject(Object.assign(new Error('position'), { code: error?.code === 1 ? 'denied' : 'unavailable' })),
      { enableHighAccuracy: false, timeout, maximumAge: 60_000 },
    );
  });
}

/** `{name?, cc?}` for a position, or `{}` when the geocoder has nothing (offline included). */
export async function placeName(services, { lat, lng }, { signal } = {}) {
  try {
    const result = await services?.geocode?.reverse(lat, lng, { lang: language(), signal });
    const found = result?.data?.[0];
    if (!found) return {};
    const name = [found.name, found.city].filter(Boolean).filter((part, index, list) => list.indexOf(part) === index).join(', ').slice(0, 500);
    return { ...(name ? { name } : {}), ...(/^[A-Z]{2}$/.test(found.country ?? '') ? { cc: found.country } : {}) };
  } catch (error) { if (isAbort(error)) throw error; return {}; }
}

/** The weather now at a position: `{weather, temperatureC}` or null. */
export async function currentWeather(services, { lat, lng }, { signal, now = Date.now() } = {}) {
  try {
    const result = await services?.weather?.forecast(lat, lng, { signal });
    const entries = result?.data?.entries ?? [];
    const closest = entries.reduce((best, entry) => (!best || Math.abs(Date.parse(entry.time) - now) < Math.abs(Date.parse(best.time) - now) ? entry : best), null);
    if (!closest) return null;
    const weather = weatherFromCondition(closest.condition, closest.windMps);
    return weather ? { weather, temperatureC: closest.temperatureC } : null;
  } catch (error) { if (isAbort(error)) throw error; return null; }
}

/**
 * The location control in the entry editor. `value()` returns the `loc` object or null. The name can be typed;
 * a search result or the device position also pins coordinates and the country.
 */
export function locationField({ services, value = null, onChange }) {
  let loc = value ? { ...value } : null;
  const nameId = uid('jr-loc');
  const listId = `${nameId}-list`;
  const input = el('input.input', {
    id: nameId, type: 'text', role: 'combobox', autocomplete: 'off', maxLength: 500, value: loc?.name ?? '',
    'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId, placeholder: t('journey.locPlaceholder'),
  });
  const list = el('ul.jr-suggest', { id: listId, role: 'listbox', 'aria-label': t('journey.locResults'), hidden: true });
  const status = el('p.field-hint', { role: 'status' });
  const pin = el('p.jr-loc-pin');
  const locate = button(t('journey.locHere'), { size: 'sm', variant: 'outline', onclick: () => void here() });
  locate.prepend(icon('locate', 16));
  const clear = button(t('journey.locClearPin'), { size: 'sm', variant: 'ghost', onclick: () => { loc = loc?.name ? { name: loc.name } : null; render(); onChange?.(loc); } });
  let options = [];
  let active = -1;
  let controller = null;
  let sequence = 0;
  let timer = 0;

  function render() {
    const pinned = Number.isFinite(loc?.lat) && Number.isFinite(loc?.lng);
    pin.replaceChildren(...(pinned ? [icon('map-pin', 14), el('span', {}, t('journey.locPinned', { cc: loc.cc ?? '' }).trim())] : []));
    pin.hidden = !pinned;
    clear.hidden = !pinned;
  }
  function show(next) {
    options = next; active = -1;
    list.replaceChildren(...options.map((option, index) => el('li.jr-option', { id: `${listId}-${index}`, role: 'option', 'aria-selected': 'false',
      onmousedown: (event) => event.preventDefault(), onclick: () => choose(index) },
    el('span', {}, option.name || option.address), option.name && option.address && el('span.jr-muted', {}, option.address))));
    list.hidden = !options.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
    input.removeAttribute('aria-activedescendant');
  }
  function choose(index) {
    const found = options[index];
    if (!found) return;
    loc = { name: (found.name || found.address || '').slice(0, 500), lat: coord(found.lat), lng: coord(found.lng), ...(/^[A-Z]{2}$/.test(found.country ?? '') ? { cc: found.country } : {}) };
    input.value = loc.name;
    show([]); status.textContent = '';
    render(); onChange?.(loc);
  }
  async function search(query) {
    if (!services?.geocode) return;
    controller?.abort(); controller = new AbortController();
    const run = ++sequence;
    try {
      const result = await services.geocode.autocomplete(query, { lang: language(), signal: controller.signal });
      if (run !== sequence) return;
      const found = dedupeResults(result?.data ?? []).filter((item) => Number.isFinite(item.lat)).slice(0, 6);
      show(found);
      status.textContent = result ? (found.length ? '' : t('journey.locNone')) : t('journey.locOffline');
    } catch (error) { if (!isAbort(error) && run === sequence) { show([]); status.textContent = t('journey.locFailed'); } }
  }
  async function here() {
    locate.setAttribute('aria-busy', 'true');
    status.textContent = t('journey.locFinding');
    try {
      const position = await devicePosition();
      const named = await placeName(services, position);
      loc = { ...position, ...named, name: named.name ?? input.value.trim() ?? '' };
      if (!loc.name) delete loc.name;
      input.value = loc.name ?? '';
      status.textContent = '';
      render(); onChange?.(loc);
    } catch (error) {
      status.textContent = t(error?.code === 'denied' ? 'journey.locDenied' : error?.code === 'unsupported' ? 'journey.locUnsupported' : 'journey.locUnavailable');
    } finally { locate.setAttribute('aria-busy', 'false'); }
  }
  input.addEventListener('input', () => {
    const name = input.value.trim();
    loc = name ? { ...(loc ?? {}), name } : (loc && Number.isFinite(loc.lat) ? { lat: loc.lat, lng: loc.lng, ...(loc.cc ? { cc: loc.cc } : {}) } : null);
    if (loc && !name) delete loc.name;
    onChange?.(loc);
    clearTimeout(timer);
    if (name.length >= 3) timer = setTimeout(() => void search(name), 250);
    else { controller?.abort(); show([]); }
  });
  input.addEventListener('keydown', (event) => {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length) {
      event.preventDefault();
      active = event.key === 'ArrowDown' ? (active + 1) % options.length : (active - 1 + options.length) % options.length;
      [...list.children].forEach((node, i) => node.setAttribute('aria-selected', String(i === active)));
      input.setAttribute('aria-activedescendant', `${listId}-${active}`);
    } else if (event.key === 'Enter' && active >= 0) { event.preventDefault(); choose(active); } else if (event.key === 'Escape' && options.length) { event.stopPropagation(); show([]); }
  });
  input.addEventListener('blur', () => setTimeout(() => show([]), 150));
  render();
  const element = el('div.field.jr-location', {},
    el('label.field-label', { htmlFor: nameId }, t('journey.fieldLocation')),
    el('div.jr-combo', {}, input, list), el('div.jr-row', {}, locate, clear, pin), status);
  return { element, value: () => (loc && Object.keys(loc).length ? { ...loc } : null), destroy() { controller?.abort(); clearTimeout(timer); } };
}
