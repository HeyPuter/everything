// Dawarich in Trips: stays recorded during a trip as place suggestions, and countries from stays for the atlas.
// Decisions are kept in `me:dawarich`, so a dismissed stay stays dismissed on every device.
import { el } from '../../ui/dom.js';
import { button, chip, emptyState, spinner } from '../../ui/bits.js';
import { checkbox, field } from '../../ui/fields.js';
import { openModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { formatDate, formatDateRange, formatDuration, formatTime } from '../../lib/format.js';
import { addDays, isDate, isTimeZone } from '../../shared/dates.js';
import { isOrder, orderKeys } from '../../shared/order.js';
import { duplicateOf } from '../../lib/io/plan.js';
import { dayForDate } from '../../lib/res/days.js';
import { MARKS_KEY, loadCountries, normalizeMarks, writeMarks } from '../../lib/atlas/data.js';
import { integrationStore } from '../../lib/integrations/store.js';
import { DAWARICH_KEY, dawarichClient, listStays, localParts, readReview, reviewKey, writeReview } from '../../lib/integrations/dawarich.js';
import { nameOf } from '../atlas/text.js';
import { errorLine, errorText, netAvailable, plural, setupState, today, tripZone } from './common.js';
import { icon } from './icons.js';
import { bucketSection, journeyButton } from './stays/index.js';

const MAX_RANGE_DAYS = 400;

function shell(title) {
  const body = el('div.int-dialog');
  const dialog = openModal({ title, content: body, wide: true, dismissOnBackdrop: false });
  return { body, dialog };
}

/** Settings and the review state, or a reason the dialog cannot go on. */
async function prepare(context, body, dialog) {
  const puter = context.puter ?? globalThis.puter;
  const personal = context.session?.personal ?? context.personal ?? null;
  body.replaceChildren(el('div.int-loading', {}, spinner()));
  if (!netAvailable(puter)) { body.replaceChildren(el('p.int-note', {}, t('integrations.unavailable'))); return null; }
  const config = (await integrationStore(puter).load()).dawarich;
  if (!config) { body.replaceChildren(setupState('dawarich', { app: context.app, close: () => dialog.close() })); return null; }
  const stored = personal?.get ? await personal.get(DAWARICH_KEY).catch(() => puter.kv.get(DAWARICH_KEY)) : await puter.kv.get(DAWARICH_KEY);
  return { puter, personal, config, client: dawarichClient(puter, config), review: readReview(stored) };
}

function rangeForm({ start, end, onSearch }) {
  const from = field({ label: t('integrations.from'), type: 'date', value: start });
  const to = field({ label: t('integrations.to'), type: 'date', value: end });
  const search = button(t('integrations.dawarich.search'), { type: 'submit', variant: 'outline' });
  const form = el('form.int-range', { noValidate: true, onsubmit: (event) => {
    event.preventDefault();
    const a = from.input.value; const b = to.input.value;
    if (!isDate(a) || !isDate(b) || b < a || addDays(a, MAX_RANGE_DAYS) < b) { to.setError(t('integrations.rangeInvalid')); return; }
    to.setError('');
    onSearch(a, b);
  } }, from.element, to.element, search);
  return { form, from, search };
}

/** The last order key of a day's visits, notes and placed bookings. */
function dayEnd(space, dayId) {
  return [
    ...(space.select.visit.groupBy('dayId').get(dayId) ?? []).map((visit) => visit.order),
    ...space.select.dayNote.all().filter((note) => note.dayId === dayId).map((note) => note.order),
    ...space.select.res.all().map((res) => res.dayPos?.[dayId]),
  ].filter(isOrder).sort().at(-1) ?? null;
}

/** Stays during the open trip: add them as places (and to their day), dismiss them, or restore dismissed ones. */
export function openDawarichStays(context) {
  const { space } = context;
  const services = context.session?.services ?? null;
  const { body, dialog } = shell(t('integrations.dawarich.staysTitle'));
  const meta = space?.get?.('meta', 'meta') ?? {};
  const zones = new Map();
  let deps = null;
  let stays = [];
  let showDismissed = false;
  let toDays = true;

  async function zoneOf(stay) {
    if (stay.lat === null || !services?.tz?.zoneAt) return tripZone(space);
    const key = `${stay.lat.toFixed(3)},${stay.lng.toFixed(3)}`;
    if (!zones.has(key)) zones.set(key, services.tz.zoneAt(stay.lat, stay.lng).then((zone) => (isTimeZone(zone) ? zone : tripZone(space)), () => tripZone(space)));
    return zones.get(key);
  }

  async function search(start, end) {
    list.replaceChildren(el('div.int-loading', {}, spinner(), el('p', {}, t('integrations.dawarich.loading'))));
    error.clear();
    try {
      const found = await listStays(deps.client, { from: start, to: end });
      stays = await Promise.all(found.map(async (stay) => {
        const zone = await zoneOf(stay);
        const begin = localParts(stay.start, zone); const finish = localParts(stay.end, zone);
        return { ...stay, zone, date: begin.date, time: begin.time, endTime: finish.date === begin.date ? finish.time : null, key: reviewKey(deps.config.url, stay.id) };
      }));
      stays = stays.filter((stay) => stay.key && stay.date >= start && stay.date <= end);
      draw();
    } catch (problem) { list.replaceChildren(); error.show(problem, () => void search(start, end)); }
  }

  const list = el('div.int-stays');
  const error = errorLine('dawarich');
  const add = button('', { variant: 'primary', onclick: () => void accept() });
  const dismiss = button(t('integrations.dawarich.dismiss'), { variant: 'outline', onclick: () => void decide('dismissed') });
  let rows = [];

  function draw() {
    rows = [];
    const places = space.select.place.all();
    const visible = stays.filter((stay) => showDismissed || deps.review.get(stay.key)?.s !== 'dismissed');
    if (!visible.length) {
      list.replaceChildren(emptyState({ icon: 'pin', title: t('integrations.dawarich.noStays'), body: t('integrations.dawarich.noStaysBody') }));
      sync(); return;
    }
    const items = visible.map((stay) => {
      const state = deps.review.get(stay.key)?.s ?? null;
      const name = stay.name || t('integrations.dawarich.unnamed');
      const present = stay.lat !== null && duplicateOf({ name, lat: stay.lat, lng: stay.lng }, places);
      const input = el('input', { type: 'checkbox', checked: !state && !present, disabled: state === 'dismissed', onchange: () => sync() });
      const when = [formatDate(stay.date, { weekday: true }), [stay.time && formatTime(stay.time), stay.endTime && formatTime(stay.endTime)].filter(Boolean).join('–'), formatDuration(stay.minutes)].filter(Boolean).join(' · ');
      const restore = state === 'dismissed' ? button(t('integrations.dawarich.restore'), { size: 'sm', variant: 'ghost', onclick: () => void decide(null, [stay]) }) : null;
      rows.push({ stay, input, name });
      return el('li.int-row', {},
        el('label.int-row-main', {}, input, icon('stay', 16),
          el('span.int-row-text', {}, el('span.int-row-name', {}, name), el('span.int-row-meta', {}, [when, stay.city].filter(Boolean).join(' · '))),
          state === 'accepted' && chip(t('integrations.dawarich.added'), { status: 'success' }),
          state === 'dismissed' && chip(t('integrations.dawarich.dismissed')),
          present && chip(t('integrations.dawarich.inTrip')),
          stay.lat === null && chip(t('integrations.dawarich.noLocation'), { status: 'warn' })),
        restore);
    });
    list.replaceChildren(el('ul.int-rows', { 'aria-label': t('integrations.dawarich.staysLabel') }, items));
    sync();
  }
  function selected() { return rows.filter((row) => row.input.checked && !row.input.disabled); }
  function sync() {
    const count = selected().length;
    add.textContent = count ? plural(count, 'addStays') : t('integrations.dawarich.choose');
    add.disabled = !count || !space.can('plan.edit');
    dismiss.disabled = !count;
  }
  async function decide(state, chosen = selected().map((row) => row.stay)) {
    if (!chosen.length) return;
    try {
      deps.review = await writeReview(deps.puter, chosen.map((stay) => ({ key: stay.key, state, trip: space.ref?.s })), { current: deps.review, personal: deps.personal });
      draw();
    } catch (problem) { error.show(problem); }
  }
  async function accept() {
    const chosen = selected().filter((row) => row.stay.lat !== null);
    if (!chosen.length) { error.show(t('integrations.dawarich.needLocation')); return; }
    const days = space.select.day.all();
    const ops = [];
    const perDay = new Map();
    for (const row of chosen) {
      const { stay } = row;
      const place = space.ops.create('place', { name: row.name.slice(0, 500), lat: stay.lat, lng: stay.lng, src: 'dawarich', ...(isTimeZone(stay.zone) ? { tz: stay.zone } : {}) });
      ops.push(place);
      const dayId = toDays ? dayForDate(days, stay.date) : null;
      if (dayId) { if (!perDay.has(dayId)) perDay.set(dayId, []); perDay.get(dayId).push({ stay, placeId: place.id }); }
    }
    for (const [dayId, items] of perDay) {
      items.sort((a, b) => a.stay.start - b.stay.start);
      const keys = orderKeys(items.length, dayEnd(space, dayId), null);
      items.forEach(({ stay, placeId }, index) => ops.push(space.ops.create('visit', {
        dayId, placeId, order: keys[index], ...(stay.time ? { start: stay.time } : {}), ...(stay.endTime && stay.endTime > stay.time ? { end: stay.endTime } : {}),
        ...(stay.minutes > 0 && stay.minutes <= 10080 ? { dwell: stay.minutes } : {}),
      })));
    }
    add.setAttribute('aria-busy', 'true'); error.clear();
    try { await space.apply(ops, { history: t('integrations.dawarich.history') }); }
    catch (problem) { error.show(errorText(problem)); add.setAttribute('aria-busy', 'false'); return; }
    add.setAttribute('aria-busy', 'false');
    toast(plural(chosen.length, 'staysAdded'));
    await decide('accepted', chosen.map((row) => row.stay));
  }

  async function start() {
    try { deps = await prepare(context, body, dialog); } catch (problem) { error.show(problem, () => void start()); body.replaceChildren(error.node); return; }
    if (!deps) return;
    if (!space?.select) { body.replaceChildren(el('p.int-note', {}, t('integrations.dawarich.needTrip'))); return; }
    const end = isDate(meta.end) ? meta.end : isDate(meta.start) ? meta.start : today();
    const range = rangeForm({ start: isDate(meta.start) ? meta.start : addDays(end, -14), end, onSearch: (a, b) => void search(a, b) });
    const datedDays = space.select.day.all().some((day) => isDate(day.date));
    const options = el('div.int-toggle', {},
      checkbox(t('integrations.dawarich.showDismissed'), { checked: showDismissed, onChange: (value) => { showDismissed = value; draw(); } }),
      datedDays ? checkbox(t('integrations.dawarich.toDays'), { checked: toDays, onChange: (value) => { toDays = value; } }) : null);
    const toJourney = journeyButton({ context, selected: () => selected().map((row) => ({ ...row.stay, name: row.name })),
      onAdded: (chosen) => decide('accepted', chosen), onError: (problem) => error.show(errorText(problem)) });
    body.replaceChildren(el('p.int-muted', {}, t('integrations.dawarich.staysIntro')), range.form, list, options, error.node,
      el('div.modal-actions', {}, button(t('integrations.close'), { onclick: () => dialog.close() }), dismiss, toJourney, add));
    sync();
    range.from.input.focus();
    void search(range.from.input.value, end);
  }
  void start();
  return dialog;
}

/** Countries of stays in a date range, to mark visited in the atlas. `visited()` lists codes the atlas already counts. */
export function openDawarichCountries(context, { visited = () => [] } = {}) {
  const { body, dialog } = shell(t('integrations.dawarich.countriesTitle'));
  const list = el('div.int-stays');
  const error = errorLine('dawarich');
  const mark = button('', { variant: 'primary', onclick: () => void save() });
  let deps = null;
  let rows = [];

  function sync() {
    const count = rows.filter((row) => row.input.checked).length;
    mark.textContent = count ? plural(count, 'markCountries') : t('integrations.dawarich.chooseCountries');
    mark.disabled = !count;
  }
  async function search(start, end) {
    list.replaceChildren(el('div.int-loading', {}, spinner(), el('p', {}, t('integrations.dawarich.loading'))));
    error.clear();
    try {
      const [stays, countries, marks] = await Promise.all([
        listStays(deps.client, { from: start, to: end }),
        loadCountries(),
        deps.personal?.get ? deps.personal.get(MARKS_KEY).catch(() => null) : deps.puter.kv.get(MARKS_KEY),
      ]);
      const already = new Set([...visited(), ...Object.keys(normalizeMarks(marks).visited)]);
      const found = new Map();
      for (const stay of stays) {
        if (stay.lat === null) continue;
        const code = countries.locate(stay.lat, stay.lng);
        if (!code) continue;
        const date = localParts(stay.start, 'UTC').date;
        const entry = found.get(code) ?? { code, count: 0, first: date, last: date };
        entry.count += 1; if (date < entry.first) entry.first = date; if (date > entry.last) entry.last = date;
        found.set(code, entry);
      }
      rows = [];
      const bucket = await bucketSection({ puter: deps.puter, personal: deps.personal, locate: countries.locate,
        stays: stays.map((stay) => ({ ...stay, date: localParts(stay.start, 'UTC').date })), onError: (problem) => error.show(errorText(problem)) });
      const entries = [...found.values()].sort((a, b) => Number(already.has(a.code)) - Number(already.has(b.code)) || nameOf(a.code).localeCompare(nameOf(b.code)));
      if (!entries.length) { list.replaceChildren(emptyState({ icon: 'globe', title: t('integrations.dawarich.noCountries'), body: t('integrations.dawarich.noStaysBody') }), bucket.element ?? ''); sync(); return; }
      list.replaceChildren(el('ul.int-rows', { 'aria-label': t('integrations.dawarich.countriesLabel') }, entries.map((entry) => {
        const known = already.has(entry.code);
        const input = el('input', { type: 'checkbox', checked: !known, disabled: known, onchange: () => sync() });
        if (!known) rows.push({ code: entry.code, input });
        return el('li.int-row', {}, el('label.int-row-main', {}, input, icon('flag', 16),
          el('span.int-row-text', {}, el('span.int-row-name', {}, nameOf(entry.code)),
            el('span.int-row-meta', {}, [plural(entry.count, 'stayCount'), formatDateRange(entry.first, entry.last)].join(' · '))),
          known && chip(t('integrations.dawarich.alreadyVisited'), { status: 'success' })));
      })), bucket.element ?? '');
      sync();
    } catch (problem) { list.replaceChildren(); error.show(problem, () => void search(start, end)); }
  }
  async function save() {
    const codes = rows.filter((row) => row.input.checked).map((row) => row.code);
    if (!codes.length) return;
    if (!deps.personal) { error.show(errorText(null, 'dawarich')); return; }
    mark.setAttribute('aria-busy', 'true');
    try {
      await writeMarks({ puter: deps.puter, personal: deps.personal, changes: Object.fromEntries(codes.map((code) => [`visited.${code}`, 'manual'])) });
      dialog.close('done');
      toast(plural(codes.length, 'countriesMarked'));
    } catch (problem) { error.show(errorText(problem)); }
    finally { mark.setAttribute('aria-busy', 'false'); }
  }
  async function start() {
    try { deps = await prepare(context, body, dialog); } catch (problem) { error.show(problem, () => void start()); body.replaceChildren(error.node); return; }
    if (!deps) return;
    const end = today();
    const range = rangeForm({ start: `${end.slice(0, 4)}-01-01`, end, onSearch: (a, b) => void search(a, b) });
    body.replaceChildren(el('p.int-muted', {}, t('integrations.dawarich.countriesIntro')), range.form, list, error.node,
      el('div.modal-actions', {}, button(t('integrations.close'), { onclick: () => dialog.close() }), mark));
    sync();
    range.from.input.focus();
    void search(range.from.input.value, end);
  }
  void start();
  return dialog;
}
