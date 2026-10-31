// Import a Google Maps route into a day (spec §22 [3]): paste a directions link, check the stops, add them in order.
// Stops given by name are looked up with the geocoder; dragged route points become road-trip vias.
import './route-import.css';
import { el, uid, append, clear } from '../../../../ui/dom.js';
import { button, chip, spinner } from '../../../../ui/bits.js';
import { checkbox } from '../../../../ui/fields.js';
import { openModal } from '../../../../ui/modal.js';
import { toast } from '../../../../ui/toast.js';
import { t } from '../../../../lib/i18n/index.js';
import { formatDate } from '../../../../lib/format.js';
import { followRouteLink, parseRouteLink } from '../../../../lib/route-import/google.js';
import { ROUTE_MODES, routeDrafts } from '../../../../lib/route-import/plan.js';
import { duplicateOf } from '../../../../lib/io/plan.js';
import { isOrder } from '../../../../shared/order.js';
import { newId } from '../../../../shared/ids.js';
import { registerPlanHooks } from '../hooks.js';

const located = (stop) => Number.isFinite(stop?.lat) && Number.isFinite(stop?.lng);

/** The last order key of a day's visits, notes and placed bookings. */
function dayEnd(space, dayId) {
  return [
    ...(space.select.visit.groupBy('dayId').get(dayId) ?? []).map((visit) => visit.order),
    ...space.select.dayNote.all().filter((note) => note.dayId === dayId).map((note) => note.order),
    ...space.select.res.all().map((res) => res.dayPos?.[dayId]),
  ].filter(isOrder).sort().at(-1) ?? null;
}

/** The dialog. `dayId` preselects a day; `plan` (optional) selects it after the import. */
export function openRouteImport({ space, session, puter, dayId = null, plan = null }) {
  const days = space.select.day.all();
  const services = session?.services ?? null;
  const net = puter ?? globalThis.puter;
  const input = el('input.input', { id: uid('route-link'), type: 'url', inputMode: 'url', autocomplete: 'off', spellcheck: false, placeholder: 'https://www.google.com/maps/dir/…' });
  const read = button(t('routeImport.read'), { variant: 'outline', type: 'submit' });
  const status = el('p.field-hint', { role: 'status', 'aria-live': 'polite' });
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const list = el('div.route-import-stops');
  const options = el('div.route-import-options', { hidden: true });
  const add = button(t('routeImport.add', { count: 0 }), { variant: 'primary', disabled: true, onclick: () => void apply() });
  const daySelect = el('select.select', { id: uid('route-day') }, days.map((day, index) => el('option', { value: day.id }, day.date ? formatDate(day.date, { weekday: true }) : t('routeImport.dayNumber', { number: index + 1 }))));
  daySelect.value = days.some((day) => day.id === dayId) ? dayId : days.some((day) => day.id === plan?.get?.().day) ? plan.get().day : days[0]?.id ?? '';
  const modeSelect = el('select.select', { id: uid('route-mode') }, el('option', { value: '' }, t('routeImport.modeKeep')), ROUTE_MODES.map((mode) => el('option', { value: mode }, t(`plan.mode.${mode}`))));
  const state = { route: null, rows: [], reuse: true, vias: true, token: 0 };
  const roadtrip = space.get('meta', 'meta')?.settings?.addons?.roadtrip === true && Boolean(space.select.via);

  const form = el('form.route-import-form', { noValidate: true, onsubmit: (event) => { event.preventDefault(); void parse(); } },
    el('div.field', {}, el('label.field-label', { htmlFor: input.id }, t('routeImport.link')), el('div.route-import-row', {}, input, read)));
  input.addEventListener('paste', () => setTimeout(() => void parse(), 0));
  const body = el('div.route-import', {}, el('p', {}, t('routeImport.intro')), form, status, error, list, options);
  const dialog = openModal({ title: t('routeImport.title'), content: body, wide: true, dismissOnBackdrop: false,
    actions: [button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), add] });
  if (!days.length) { form.hidden = true; status.textContent = t('routeImport.noDays'); }

  const fail = (message) => { error.textContent = message; error.hidden = !message; };
  function sync() {
    const n = state.rows.filter((row) => row.input.checked && located(row.stop)).length;
    add.textContent = t('routeImport.add', { count: new Intl.NumberFormat().format(n) });
    add.disabled = n < 1 || !daySelect.value;
  }

  async function parse() {
    const token = ++state.token;
    fail('');
    let route = parseRouteLink(input.value);
    if (route?.short) {
      if (typeof net?.net?.fetch !== 'function') { fail(t('routeImport.shortUnavailable')); return; }
      status.textContent = t('routeImport.following');
      try { route = await followRouteLink(route.short, (url, init) => net.net.fetch(url, init)); } catch { route = null; }
      if (token !== state.token) return;
      status.textContent = '';
    }
    if (!route?.stops) { fail(t('routeImport.invalid')); list.replaceChildren(); options.hidden = true; state.rows = []; sync(); return; }
    state.route = route;
    if (route.mode) modeSelect.value = route.mode;
    const places = space.select.place.all();
    state.rows = route.stops.map((stop, index) => {
      const row = { stop: { ...stop }, input: el('input', { type: 'checkbox', checked: true, onchange: sync }), meta: el('span.route-import-meta'), badges: el('span') };
      row.node = el('li.route-import-stop', {}, el('label.check-field', {}, row.input,
        el('span.route-import-text', {}, el('span', {}, stop.name || t('routeImport.unnamed', { number: index + 1 })), row.meta)), row.badges);
      return row;
    });
    list.replaceChildren(el('h3.field-label', {}, t('routeImport.stops')), el('ol.route-import-list', {}, state.rows.map((row) => row.node)));
    renderOptions();
    for (const [index, row] of state.rows.entries()) {
      if (token !== state.token) return;
      if (!located(row.stop)) {
        if (!services?.geocode || globalThis.navigator?.onLine === false) { row.meta.textContent = t('routeImport.notFound'); row.input.checked = false; row.input.disabled = true; status.textContent = t('routeImport.offline'); continue; }
        row.meta.replaceChildren(spinner(), ` ${t('routeImport.finding', { name: row.stop.name })}`);
        const near = state.rows.slice(0, index).map((item) => item.stop).reverse().find(located);
        try {
          const result = await services.geocode.search(row.stop.name, near ? { bias: { lat: near.lat, lng: near.lng, zoom: 8 } } : {});
          const hit = result?.data?.[0];
          if (hit && located(hit)) Object.assign(row.stop, { lat: hit.lat, lng: hit.lng, ...(hit.address ? { address: hit.address } : {}), ...(hit.osm ? { osm: hit.osm } : {}), name: row.stop.name || hit.name });
        } catch { /* reported below */ }
        if (token !== state.token) return;
      }
      row.meta.textContent = located(row.stop) ? `${row.stop.lat.toFixed(4)}, ${row.stop.lng.toFixed(4)}` : t('routeImport.notFound');
      if (!located(row.stop)) { row.input.checked = false; row.input.disabled = true; }
      if (located(row.stop) && duplicateOf({ name: row.stop.name, lat: row.stop.lat, lng: row.stop.lng }, places)) row.badges.replaceChildren(chip(t('routeImport.existing')));
      sync();
    }
    sync();
  }

  function renderOptions() {
    const vias = state.route?.vias?.length ?? 0;
    options.hidden = false;
    append(clear(options), [
      el('div.field-row', {},
        el('div.field', {}, el('label.field-label', { htmlFor: daySelect.id }, t('routeImport.day')), daySelect),
        el('div.field', {}, el('label.field-label', { htmlFor: modeSelect.id }, t('routeImport.mode')), modeSelect)),
      checkbox(t('routeImport.reuse'), { checked: state.reuse, onChange: (value) => { state.reuse = value; } }),
      roadtrip && vias ? checkbox(t('routeImport.vias', { count: new Intl.NumberFormat().format(vias) }), { checked: state.vias, onChange: (value) => { state.vias = value; } }) : null]);
    daySelect.onchange = sync;
  }

  async function apply() {
    fail('');
    const chosen = state.rows.filter((row) => row.input.checked && located(row.stop));
    if (!chosen.length || !daySelect.value) return;
    const unnamed = (stop) => t('routeImport.unnamed', { number: state.rows.findIndex((row) => row.stop === stop) + 1 });
    let plan2;
    try {
      plan2 = routeDrafts({
        stops: state.rows.map((row) => (row.input.checked && located(row.stop) ? { ...row.stop, name: row.stop.name || unnamed(row.stop) } : { ...row.stop, lat: undefined, lng: undefined })),
        vias: state.vias ? state.route.vias : [], dayId: daySelect.value, mode: modeSelect.value || null, places: space.select.place.all(), reuse: state.reuse,
        after: dayEnd(space, daySelect.value), roadtrip: roadtrip && state.vias, makeId: newId, fallbackName: t('routeImport.unnamed', { number: '' }).trim(),
      });
    } catch { fail(t('routeImport.failed')); return; }
    add.setAttribute('aria-busy', 'true');
    try {
      await space.apply(plan2.drafts.map((draft) => space.ops.create(draft.t, draft.put, { id: draft.id })), { history: t('routeImport.history') });
      toast(t('routeImport.added', { count: new Intl.NumberFormat().format(chosen.length) }), { action: { label: t('schedule.undo'), onClick: () => void space.history.undo().catch(() => {}) } });
      plan?.set?.({ day: daySelect.value });
      dialog.close('done');
    } catch { fail(t('routeImport.failed')); } finally { add.setAttribute('aria-busy', 'false'); }
  }
  input.focus();
  return dialog;
}

/** Registers "Import a Google Maps route…" in each day's menu for people who may edit the plan. Returns the cleanup. */
export function mountRouteImport(pane) {
  const { space } = pane;
  if (!space?.select?.day) return () => {};
  return registerPlanHooks({
    dayActions: ({ entry, context }) => (context?.space === space && space.can('plan.edit')
      ? [{ label: t('routeImport.menu'), icon: 'map', onSelect: () => openRouteImport({ ...pane, dayId: entry.day.id }) }] : []),
  });
}
