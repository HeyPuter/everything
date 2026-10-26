import { el, uid } from '../../../ui/dom.js';
import { t } from '../../../lib/i18n/index.js';
import { isTimeZone } from '../../../shared/dates.js';
import { createAirports } from '../../../services/airports.js';
import { createTimezone } from '../../../services/tz.js';

let zonesList;
let fallback;
/** Offline services when the session has none yet: the bundled airport list and the zone lookup. */
export function servicesFor(session) {
  fallback ??= { airports: createAirports(), tz: createTimezone() };
  const services = session?.services ?? {};
  return { airports: services.airports ?? fallback.airports, tz: services.tz ?? fallback.tz, geocode: services.geocode ?? null };
}

/** One shared datalist of IANA zones for every time zone input in a form. */
export function zoneDatalist() {
  zonesList ??= (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return []; } })();
  const id = uid('zones');
  return { id, element: el('datalist', { id }, zonesList.map((zone) => el('option', { value: zone }))) };
}

/**
 * Text input with a listbox of suggestions (ARIA combobox). `search(query, signal)` resolves to
 * `{items, attribution?}` or null when search is unavailable; `describe(item)` gives the option text.
 */
export function combobox({ label, value = '', placeholder = '', minLength = 2, search, describe, onPick, onText, hint }) {
  const id = uid('combo');
  const listId = `${id}-list`;
  const statusId = `${id}-status`;
  const input = el('input.input', {
    id, type: 'text', value, placeholder, autocomplete: 'off', spellcheck: false, maxLength: 500,
    role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-describedby': statusId,
  });
  const list = el('ul.res-options', { id: listId, role: 'listbox', 'aria-label': t('bookings.suggestions', { field: label }), hidden: true });
  const status = el('span.field-hint.res-combo-status', { id: statusId, 'aria-live': 'polite' });
  let items = [];
  let active = -1;
  let controller = null;
  let timer = null;

  function close() {
    list.hidden = true; list.replaceChildren(); items = []; active = -1;
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  }
  function highlight(index) {
    active = index;
    [...list.children].forEach((node, position) => node.setAttribute('aria-selected', String(position === index)));
    const node = list.children[index];
    if (node) { input.setAttribute('aria-activedescendant', node.id); node.scrollIntoView?.({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function pick(index) {
    const item = items[index];
    if (!item) return;
    close();
    status.textContent = '';
    onPick(item);
  }
  function show(found, attribution) {
    items = found;
    list.replaceChildren(...found.map((item, index) => el('li.res-option', {
      id: `${id}-opt-${index}`, role: 'option', 'aria-selected': 'false',
      onpointerdown: (event) => { event.preventDefault(); pick(index); },
    }, describe(item))));
    if (found.length && attribution) list.append(el('li.res-attribution', { role: 'presentation' }, attribution));
    list.hidden = !found.length;
    input.setAttribute('aria-expanded', String(found.length > 0));
    active = -1;
  }
  async function run(query) {
    controller?.abort();
    const text = query.trim();
    if (text.length < minLength) { close(); status.textContent = ''; return; }
    const current = new AbortController();
    controller = current;
    status.textContent = t('bookings.searching');
    try {
      const result = await search(text, current.signal);
      if (current.signal.aborted) return;
      if (!result) { close(); status.textContent = t('bookings.searchUnavailable'); return; }
      show(result.items, result.attribution);
      status.textContent = result.items.length ? '' : t('bookings.noResults');
    } catch (error) {
      if (current.signal.aborted || error?.name === 'AbortError') return;
      close(); status.textContent = t('bookings.searchUnavailable');
    }
  }
  input.addEventListener('input', () => {
    onText?.(input.value);
    clearTimeout(timer);
    timer = setTimeout(() => run(input.value), 150);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && items.length) { event.preventDefault(); highlight((active + 1) % items.length); }
    else if (event.key === 'ArrowUp' && items.length) { event.preventDefault(); highlight((active - 1 + items.length) % items.length); }
    else if (event.key === 'Enter' && !list.hidden && active >= 0) { event.preventDefault(); pick(active); }
    else if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); close(); }
  });
  input.addEventListener('blur', () => { clearTimeout(timer); controller?.abort(); close(); });
  const element = el('div.field', {}, el('label.field-label', { htmlFor: id }, label), el('div.res-combo', {}, input, list), status, hint && el('span.field-hint', {}, hint));
  return { element, input, close, setText: (text) => { input.value = text; } };
}

/** `<details>` holding a time zone input; `onChange(zone|undefined)` fires for valid or cleared values. */
export function zoneField({ value, datalist, onChange }) {
  const id = uid('zone');
  const summary = el('summary.res-zone-summary');
  const input = el('input.input', { id, type: 'text', value: value ?? '', list: datalist, autocomplete: 'off', spellcheck: false, maxLength: 100, 'aria-describedby': `${id}-hint` });
  const error = el('span.field-error', { hidden: true, 'aria-live': 'polite' });
  const paint = (zone) => { summary.textContent = zone ? t('bookings.timeZoneIs', { zone }) : t('bookings.timeZoneNone'); };
  function commit() {
    const zone = input.value.trim();
    const valid = !zone || isTimeZone(zone);
    error.hidden = valid; error.textContent = valid ? '' : t('bookings.timeZoneInvalid');
    input.setAttribute('aria-invalid', String(!valid));
    if (!valid) return;
    paint(zone);
    onChange(zone || undefined);
  }
  input.addEventListener('change', commit);
  paint(value);
  const element = el('details.res-zone', {}, summary, el('div.field', {},
    el('label.field-label', { htmlFor: id }, t('bookings.timeZone')), input,
    el('span.field-hint', { id: `${id}-hint` }, t('bookings.timeZoneHint')), error));
  return {
    element,
    set(zone) { input.value = zone ?? ''; error.hidden = true; input.removeAttribute('aria-invalid'); paint(zone); },
  };
}

const endpointLabel = (end) => (end?.code ? [end.code, end.name].filter(Boolean).join(' · ') : end?.name ?? '');

/**
 * Transport endpoint: airports from the bundled list for flights, location search otherwise. The endpoint's
 * zone comes from the airport or from the picked coordinates, and can be set by hand.
 */
export function endpointPicker({ label, value, kind, services, datalist, onChange }) {
  const end = { ...value };
  let manualZone = false;
  const emit = () => onChange({ ...end });
  const zone = zoneField({ value: end.tz, datalist, onChange: (tz) => { manualZone = true; end.tz = tz; if (!tz) delete end.tz; emit(); } });
  const setZone = (tz) => { if (tz) end.tz = tz; else delete end.tz; zone.set(end.tz); };
  const airport = kind === 'airport';
  const box = combobox({
    label, value: endpointLabel(end), placeholder: t(airport ? 'bookings.airportPlaceholder' : 'bookings.placePlaceholder'), minLength: airport ? 2 : 3,
    search: airport
      ? async (query, signal) => { const items = await services.airports.search(query, { signal, limit: 8 }); return items && { items }; }
      : async (query, signal) => {
        if (!services.geocode) return null;
        const result = await services.geocode.autocomplete(query, { signal });
        return result && { items: result.data ?? [], attribution: result.attribution };
      },
    describe: airport
      ? (item) => `${item.iata} · ${item.name}${item.city && !item.name.includes(item.city) ? `, ${item.city}` : ''}${item.country ? ` (${item.country})` : ''}`
      : (item) => [item.name, item.address && item.address !== item.name ? item.address : ''].filter(Boolean).join(' · '),
    onPick: async (item) => {
      for (const key of ['name', 'code', 'lat', 'lng']) delete end[key];
      if (airport) Object.assign(end, { code: item.iata, name: item.name, lat: item.lat, lng: item.lng });
      else Object.assign(end, { name: item.name || item.address, ...(Number.isFinite(item.lat) ? { lat: item.lat, lng: item.lng } : {}) });
      box.setText(endpointLabel(end));
      manualZone = false;
      if (airport) setZone(item.tz);
      emit();
      if (!airport && Number.isFinite(item.lat)) {
        try { const tz = await services.tz.zoneAt(item.lat, item.lng); if (!manualZone && end.lat === item.lat) { setZone(tz); emit(); } } catch { /* Keep the zone unset. */ }
      }
    },
    onText: (text) => {
      for (const key of ['code', 'lat', 'lng']) delete end[key];
      end.name = text;
      if (!manualZone) setZone(undefined);
      emit();
    },
  });
  if (airport) {
    // A typed IATA code resolves without opening the list.
    box.input.addEventListener('change', async () => {
      const text = box.input.value.trim();
      if (!/^[A-Za-z]{3}$/.test(text) || end.code) return;
      try {
        const item = await services.airports.byCode(text);
        if (!item || box.input.value.trim() !== text) return;
        Object.assign(end, { code: item.iata, name: item.name, lat: item.lat, lng: item.lng });
        box.setText(endpointLabel(end));
        if (!manualZone) setZone(item.tz);
        emit();
      } catch { /* Keep the typed name. */ }
    });
  }
  return { element: el('div.res-endpoint', {}, box.element, zone.element), input: box.input };
}

/** Location search for bookings; `onChange({location, tz?, osm?})` after a pick or typed name. */
export function locationPicker({ label, value, services, onChange, hint }) {
  const box = combobox({
    label, value: value?.name ?? '', placeholder: t('bookings.placePlaceholder'), minLength: 3, hint,
    search: async (query, signal) => {
      if (!services.geocode) return null;
      const result = await services.geocode.autocomplete(query, { signal });
      return result && { items: result.data ?? [], attribution: result.attribution };
    },
    describe: (item) => [item.name, item.address && item.address !== item.name ? item.address : ''].filter(Boolean).join(' · '),
    onPick: async (item) => {
      const location = { name: item.name || item.address, ...(item.address ? { address: item.address } : {}), ...(Number.isFinite(item.lat) ? { lat: item.lat, lng: item.lng } : {}) };
      box.setText(location.name);
      onChange({ location, picked: item });
      if (Number.isFinite(item.lat)) {
        try { onChange({ location, picked: item, tz: await services.tz.zoneAt(item.lat, item.lng) }); } catch { /* Zone stays as it was. */ }
      }
    },
    onText: (text) => onChange({ location: text.trim() ? { name: text } : null }),
  });
  return { element: box.element, input: box.input, setText: box.setText };
}
