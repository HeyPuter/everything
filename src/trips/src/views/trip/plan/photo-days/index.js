// Build a past trip's days from photos (spec §13 [3]): group photos into stops by capture time and place, name them,
// review, then add places and timed visits. AI names are suggestions; nothing is written before Add.
import './photo-days.css';
import { el, uid } from '../../../../ui/dom.js';
import { button, spinner } from '../../../../ui/bits.js';
import { checkbox } from '../../../../ui/fields.js';
import { openModal } from '../../../../ui/modal.js';
import { toast } from '../../../../ui/toast.js';
import { t } from '../../../../lib/i18n/index.js';
import { formatDate, formatTime } from '../../../../lib/format.js';
import { aiPrefs } from '../../../../lib/prefs.js';
import { canUseDrive, chooseLocalFiles } from '../../../../lib/files/index.js';
import { EXIF_BYTES, blobBytes, createPhotoStore, folderImages, photoMeta } from '../../../../lib/photos/index.js';
import { groupStops, nameStops, photoDayDrafts, placeOnDays } from '../../../../lib/photos/days.js';
import { BUILTIN_CATEGORIES } from '../../../../lib/categories.js';
import { isOrder } from '../../../../shared/order.js';
import { newId } from '../../../../shared/ids.js';
import { registerPlanHooks } from '../hooks.js';

const MAX_PHOTOS = 1000;
const JPEG = /\.jpe?g$/i;
const located = (stop) => Number.isFinite(stop?.lat) && Number.isFinite(stop?.lng);
const number = (value) => new Intl.NumberFormat().format(value);

function dayEnd(space, dayId) {
  return [
    ...(space.select.visit.groupBy('dayId').get(dayId) ?? []).map((visit) => visit.order),
    ...space.select.dayNote.all().filter((note) => note.dayId === dayId).map((note) => note.order),
    ...space.select.res.all().map((res) => res.dayPos?.[dayId]),
  ].filter(isOrder).sort().at(-1) ?? null;
}

async function headBytes(read) {
  const blob = await read();
  return blobBytes(blob instanceof Blob ? blob : new Blob([blob]), EXIF_BYTES);
}

/** The dialog for one open trip (`space`, `session`, `puter`, `personal`). */
export function openPhotoDays(context) {
  const { space, session } = context;
  const puter = context.puter ?? globalThis.puter;
  const personal = session?.personal ?? context.personal;
  const services = session?.services ?? null;
  const chat = context.photoChat ?? (typeof puter?.ai?.chat === 'function' ? (messages, options) => puter.ai.chat(messages, options) : null);
  const status = el('p.field-hint', { role: 'status', 'aria-live': 'polite' });
  const error = el('p.field-error', { role: 'alert', hidden: true });
  const review = el('div.photo-days-review');
  const add = button(t('photoDays.add', { count: 0 }), { variant: 'primary', disabled: true, onclick: () => void apply() });
  const sources = el('div.photo-days-sources');
  const state = { photos: [], skipped: 0, plan: null, rows: [], keep: true, fromDrive: false, token: 0 };
  const dialog = openModal({ title: t('photoDays.title'), wide: true, dismissOnBackdrop: false,
    content: el('div.photo-days', {}, el('p', {}, t('photoDays.intro')), sources, status, error, review),
    actions: [button(t('ui.cancel'), { onclick: () => dialog.close('cancel') }), add] });
  const fail = (message) => { error.textContent = message; error.hidden = !message; };

  if (canUseDrive(puter)) sources.append(button(t('photoDays.fromDrive'), { variant: 'outline', onclick: () => void fromDrive() }));
  if (typeof puter?.ui?.showDirectoryPicker === 'function' && typeof puter?.fs?.readdir === 'function') sources.append(button(t('photoDays.fromFolder'), { variant: 'outline', onclick: () => void fromFolder() }));
  sources.append(button(t('photoDays.fromDevice'), { variant: 'outline', onclick: () => void fromDevice() }));

  async function read(list, reader, { drive }) {
    const token = ++state.token;
    fail('');
    const items = list.slice(0, MAX_PHOTOS);
    const photos = [];
    let skipped = list.length - items.length;
    for (const [index, item] of items.entries()) {
      if (token !== state.token) return;
      status.textContent = t('photoDays.reading', { done: number(index + 1), total: number(items.length) });
      if (!JPEG.test(item.name ?? '')) { skipped += 1; continue; }
      try {
        const meta = photoMeta(await headBytes(() => reader(item)));
        if (meta.taken) photos.push({ ...meta, name: item.name, ...(drive ? { uid: item.uid, path: item.path } : {}) });
        else skipped += 1;
      } catch { skipped += 1; }
    }
    state.photos = photos; state.skipped = skipped; state.fromDrive = drive;
    await build(token);
  }
  async function fromDrive() {
    let picked;
    try { picked = await puter.ui.showOpenFilePicker({ multiple: true, accept: '.jpg,.jpeg' }); } catch { return; }
    const items = (Array.isArray(picked) ? picked : [picked]).filter((item) => item && !item.is_dir);
    await read(items, (item) => (item.path ? puter.fs.read(item.path, { offset: 0, byte_count: EXIF_BYTES }) : item.read()), { drive: true });
  }
  async function fromFolder() {
    let folder;
    try { folder = await puter.ui.showDirectoryPicker(); } catch { return; }
    if (!folder?.path) return;
    let entries = [];
    try { entries = folderImages(await puter.fs.readdir(folder.path)); } catch { fail(t('photoDays.failed')); return; }
    await read(entries, (item) => puter.fs.read(item.path, { offset: 0, byte_count: EXIF_BYTES }), { drive: true });
  }
  async function fromDevice() {
    const files = await chooseLocalFiles({ accept: '.jpg,.jpeg,image/jpeg' });
    if (files.length) await read(files, (file) => file, { drive: false });
  }

  async function build(token) {
    const { stops } = groupStops(state.photos);
    if (!stops.length) { status.textContent = ''; review.replaceChildren(el('p', {}, t('photoDays.none'))); sync(); return; }
    state.plan = placeOnDays(stops, space.select.day.all());
    status.replaceChildren(spinner(), ` ${t('photoDays.naming')}`);
    for (const stop of state.plan.days.flatMap((entry) => entry.stops)) {
      if (token !== state.token) return;
      if (!located(stop) || !services?.geocode?.reverse || globalThis.navigator?.onLine === false) continue;
      try {
        const result = await services.geocode.reverse(stop.lat, stop.lng);
        const hit = Array.isArray(result?.data) ? result.data[0] : result?.data;
        if (hit?.name) Object.assign(stop, { name: String(hit.name).slice(0, 200), ...(hit.address ? { address: hit.address } : {}) });
      } catch { /* the stop keeps its default name */ }
    }
    if (token !== state.token) return;
    status.textContent = '';
    render();
  }

  function render() {
    const plan = state.plan;
    const days = space.select.day.all();
    state.rows = [];
    const stopCount = plan.days.reduce((sum, entry) => sum + entry.stops.length, 0);
    const notes = [
      t('photoDays.summary', { photos: number(state.photos.length), stops: number(stopCount) }),
      state.skipped ? t('photoDays.skipped', { count: number(state.skipped) }) : null,
      plan.outside.length ? t('photoDays.outside', { count: number(plan.outside.length) }) : null,
      plan.extra ? t('photoDays.extra', { count: number(plan.extra) }) : null,
    ].filter(Boolean);
    const aiButton = chat ? button(t('photoDays.ai'), { size: 'sm', variant: 'ghost', onclick: () => void suggest(aiButton) }) : null;
    review.replaceChildren(
      el('ul.photo-days-notes', {}, notes.map((note) => el('li', {}, note))),
      ...plan.days.map((entry) => {
        const index = days.findIndex((day) => day.id === entry.dayId);
        const date = formatDate(entry.date, { weekday: true });
        const label = !entry.dayId ? `${date} · ${t('photoDays.newDay')}` : days[index]?.date ? date : `${date} · ${t('photoDays.dayNumber', { number: index + 1 })}`;
        const headingId = uid('photo-days-day');
        return el('section.photo-days-day', { 'aria-labelledby': headingId }, el('h3.photo-days-title', { id: headingId }, label),
          el('ul.photo-days-stops', {}, entry.stops.map((stop) => {
            const usable = located(stop);
            const at = stop.start ? formatTime(stop.start) : formatDate(stop.date);
            const input = el('input', { type: 'checkbox', checked: usable, disabled: !usable, onchange: sync, 'aria-label': t('photoDays.addLabel', { time: at }) });
            const name = el('input.input', { value: stop.name ?? '', maxLength: 200, disabled: !usable, 'aria-label': t('photoDays.nameLabel', { time: at }),
              oninput: () => { stop.name = name.value; } });
            state.rows.push({ stop, input, name });
            const when = [stop.start && formatTime(stop.start), stop.end && stop.end !== stop.start && formatTime(stop.end)].filter(Boolean).join('–');
            return el('li.photo-days-stop', {}, input,
              el('div.photo-days-stop-main', {}, name, el('span.field-hint', {}, [when, t(stop.photos.length === 1 ? 'photoDays.photoCountOne' : 'photoDays.photoCount', { count: number(stop.photos.length) }),
                usable ? null : t('photoDays.noLocation')].filter(Boolean).join(' · '))));
          })));
      }),
      el('div.photo-days-options', {}, aiButton,
        state.fromDrive && personal?.get ? checkbox(t('photoDays.keep'), { checked: state.keep, onChange: (value) => { state.keep = value; } }) : null));
    sync();
  }
  function sync() {
    const n = state.rows.filter((row) => row.input.checked).length;
    add.textContent = t('photoDays.add', { count: number(n) });
    add.disabled = !n || !space.can('plan.edit');
  }

  async function suggest(node) {
    const stops = state.rows.map((row) => row.stop);
    node.setAttribute('aria-busy', 'true');
    fail('');
    try {
      const names = await nameStops({ chat, model: aiPrefs().quickModel, stops, categories: BUILTIN_CATEGORIES.map((entry) => entry.id) });
      for (const [index, value] of names) {
        const row = state.rows[index];
        if (!row) continue;
        row.stop.name = value.name; row.name.value = value.name;
        if (value.cat) row.stop.cat = value.cat;
      }
      status.textContent = t('photoDays.aiDone');
    } catch (cause) { fail(cause?.code === 'credit' ? t('photoDays.aiCredit') : t('photoDays.aiFailed')); }
    finally { node.setAttribute('aria-busy', 'false'); }
  }

  async function apply() {
    fail('');
    const chosen = new Set(state.rows.filter((row) => row.input.checked).map((row) => row.stop));
    const plan = { days: state.plan.days.map((entry) => ({ ...entry, stops: entry.stops.filter((stop) => chosen.has(stop)) })).filter((entry) => entry.stops.length) };
    const days = space.select.day.all();
    const ends = new Map(plan.days.filter((entry) => entry.dayId).map((entry) => [entry.dayId, dayEnd(space, entry.dayId)]));
    let result;
    try {
      result = photoDayDrafts({ plan, places: space.select.place.all(), ends, lastDay: days.at(-1)?.order ?? null, makeId: newId, fallbackName: t('photoDays.stopName') });
    } catch { fail(t('photoDays.failed')); return; }
    add.setAttribute('aria-busy', 'true');
    try {
      await space.apply(result.drafts.map((draft) => space.ops.create(draft.t, draft.put, { id: draft.id })), { history: t('photoDays.history') });
    } catch { fail(t('photoDays.failed')); add.setAttribute('aria-busy', 'false'); return; }
    if (state.keep && state.fromDrive && personal?.get && space.ref?.s) {
      const photos = [...chosen].flatMap((stop) => stop.photos).filter((photo) => photo.uid);
      try { await createPhotoStore({ personal, puter, spaceId: space.ref.s }).add(photos); } catch { /* the plan is saved; the photo list is a convenience */ }
    }
    add.setAttribute('aria-busy', 'false');
    toast(t('photoDays.added', { count: number(chosen.size) }), { action: { label: t('schedule.undo'), onClick: () => void space.history?.undo?.().catch(() => {}) } });
    dialog.close('done');
  }
  return dialog;
}

/**
 * "Build days from photos…" in each day's menu and as a palette command while the Plan tab is open, for people who
 * may edit the plan. Returns the cleanup.
 */
export function mountPhotoDays(pane) {
  const { space, app } = pane;
  if (!space?.select?.day) return () => {};
  const offs = [registerPlanHooks({
    dayActions: ({ context }) => (context?.space === space && space.can('plan.edit') ? [{ label: t('photoDays.menu'), icon: 'calendar', onSelect: () => openPhotoDays(pane) }] : []),
  })];
  if (typeof app?.commands?.register === 'function') {
    try { offs.push(app.commands.register({ id: 'trip-photo-days', labelKey: 'photoDays.command', run: () => openPhotoDays(pane) })); } catch { /* registered by another view */ }
  }
  return () => { for (const off of offs) off(); };
}
