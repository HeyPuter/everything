// Import dialogs: a Trips file (.json) as a new trip or into the open trip, and GPX/KML/KMZ as places and tracks.
import { el, uid as domId, append, clear } from '../../ui/dom.js';
import { button, chip } from '../../ui/bits.js';
import { checkbox, choiceGroup, field } from '../../ui/fields.js';
import { openModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { formatDateRange, formatDistance } from '../../lib/format.js';
import { openSpace } from '../../lib/store/index.js';
import { newId } from '../../shared/ids.js';
import { isOrder } from '../../shared/order.js';
import { spaceRoute } from '../../shared/protocol.js';
import { ROAD_PREFS_ID } from '../../shared/schema/trip.js';
import { IoError, errorCode } from '../../lib/io/errors.js';
import { IO_LIMITS } from '../../lib/io/limits.js';
import { GEO_ACCEPT, readGeoFile } from '../../lib/io/geo-import.js';
import { parseSpaceExport } from '../../lib/io/space-format.js';
import { GROUP_ACTIONS, IMPORT_GROUPS, batches, duplicateOf, groupCounts, itemNames, planGeoImport, planSpaceImport, withTracks } from '../../lib/io/plan.js';
import { uploadTrack } from '../../lib/io/track-upload.js';
import { BUILTIN_CATEGORIES, CAT_ICONS } from '../../lib/categories.js';
import { dayLabel, deps, dropZone, errorLine, errorText, fileBytes, icon, pickDeviceFile, pickDriveFile, pickerAvailable, plural, progressBlock } from './common.js';
import './io.css';

const JSON_ACCEPT = '.json,application/json';
const REKEY = ['day', 'pack', 'todo', 'bag', 'listMeta', 'costCat', 'exp'];
const isJson = (file, bytes) => /\.json$/i.test(file.name) || /^\s*[{[]/.test(new TextDecoder().decode(bytes.subarray(0, 64)));

function builtinNames() {
  const map = new Map();
  for (const category of BUILTIN_CATEGORIES) {
    map.set(category.id, category.id);
    map.set(t(`places.cat.${category.id}`).toLocaleLowerCase(), category.id);
  }
  return map;
}

/** The last order key used on a day by visits, notes or placed bookings. */
function dayEnd(space, dayId) {
  const keys = [
    ...(space.select.visit.groupBy('dayId').get(dayId) ?? []).map((visit) => visit.order),
    ...space.select.dayNote.all().filter((note) => note.dayId === dayId).map((note) => note.order),
    ...space.select.res.all().map((res) => res.dayPos?.[dayId]),
  ].filter(isOrder).sort();
  return keys.at(-1) ?? null;
}

function maxOrders(space) {
  const out = {};
  for (const type of REKEY) {
    const keys = space.select[type].all().map((entity) => entity.order).filter(isOrder).sort();
    if (keys.length) out[type] = keys.at(-1);
  }
  return out;
}

/** Applies drafts through `space.apply` in commit-sized batches; each batch is one undo step when `label` is given. */
async function applyDrafts(space, drafts, { label, onProgress } = {}) {
  let done = 0;
  for (const batch of batches(drafts)) {
    const ops = batch.map((draft) => (draft.put ? space.ops.create(draft.t, draft.put, { id: draft.id }) : space.ops.patch(draft.t, draft.id, { set: draft.set })));
    await space.apply(ops, label ? { history: label } : undefined);
    done += batch.length;
    onProgress?.(done, drafts.length);
  }
  return batches(drafts).length;
}

/** Uploads planned tracks one at a time; returns the uploaded map and how many failed. */
async function uploadTracks(space, tracks, { api, onProgress }) {
  const uploaded = new Map();
  let failed = 0;
  let lastError = null;
  for (const [index, track] of tracks.entries()) {
    onProgress?.(index, tracks.length);
    try { uploaded.set(track.fileId ?? track.placeId, await uploadTrack(space, track.feature, { api })); }
    catch (error) {
      failed += 1; lastError = error;
      if (['offline', 'forbidden', 'credit', 'session_unavailable'].includes(errorCode(error))) { failed += tracks.length - index - 1; break; }
    }
  }
  return { uploaded, failed, lastError };
}

/** Sends queued writes until none remain or progress stalls (offline). Returns how many are still queued. */
async function drain(space, onProgress) {
  const total = space.state.pending;
  for (let stalls = 0; space.state.pending > 0 && stalls < 3;) {
    const before = space.state.pending;
    const result = await space.flush().catch(() => null);
    onProgress?.(total - space.state.pending, total);
    if (space.state.pending < before) { stalls = 0; continue; }
    stalls += 1;
    if (result?.held || result?.status === 'busy') await new Promise((resolve) => setTimeout(resolve, 2000));
    else if (!result || result.error) break;
  }
  return space.state.pending;
}

function shell(title) {
  const body = el('div.io-dialog');
  const dialog = openModal({ title, content: body, wide: true, dismissOnBackdrop: false });
  return { dialog, body };
}

/** First step: choose a file from the device, Puter or a drop. */
function pickStep({ body, accept, intro, puter, onFile }) {
  const error = errorLine();
  const busy = el('p.io-muted', { hidden: true, role: 'status' }, t('io.reading'));
  const handle = async (file) => {
    if (!file) return;
    error.clear(); busy.hidden = false;
    try { await onFile(file); } catch (problem) { error.show(problem); } finally { busy.hidden = true; }
  };
  const choose = button(t('io.chooseFile'), { variant: 'primary', onclick: async () => handle(await pickDeviceFile(accept)) });
  const drive = pickerAvailable(puter) && button(t('io.fromPuter'), { variant: 'outline', onclick: () => { void pickDriveFile(puter).then(handle, (problem) => error.show(problem)); } });
  body.replaceChildren(
    el('p', {}, intro),
    dropZone(handle, icon('upload', 28), el('p.io-drop-text', {}, t('io.dropHint')), el('div.io-actions-inline', {}, choose, drive)),
    busy, error.node);
  choose.focus();
  return { handle };
}

// ---- GPX, KML and KMZ

function geoStep({ body, dialog, space, api, file, result, onBack }) {
  const names = itemNames(result.items, { waypoint: (n) => t('io.waypointN', { n }), track: (n) => t('io.trackN', { n }) });
  const places = space.select.place.all();
  const trackPlaces = places.filter((place) => place.track);
  const duplicates = result.items.map((item, index) => (item.kind === 'track'
    ? duplicateOf({ name: names[index], lat: item.start[1], lng: item.start[0] }, trackPlaces)
    : duplicateOf({ ...item, name: names[index] }, places)));
  const boxes = [];
  const listId = domId('io-items');
  const rows = result.items.map((item, index) => {
    const input = el('input', { type: 'checkbox', checked: !duplicates[index], onchange: () => sync() });
    boxes.push(input);
    const meta = item.kind === 'track'
      ? [t(item.source === 'rte' ? 'io.kindRoute' : 'io.kindTrack'), Number.isFinite(item.km) ? formatDistance(item.km * 1000) : null]
      : [t('io.kindWaypoint'), item.sym ?? item.category ?? item.type ?? null];
    return el('li', {}, el('label.io-item', {}, input, icon(item.kind === 'track' ? 'track' : 'waypoint', 16),
      el('span.io-item-text', {}, el('span.io-item-name', {}, names[index]), el('span.io-item-meta', {}, meta.filter(Boolean).join(' · '))),
      duplicates[index] && chip(t('io.alreadyHere'))));
  });
  const all = el('input', { type: 'checkbox', onchange: () => { for (const box of boxes) box.checked = all.checked; sync(); } });
  const days = space.select.day.all();
  const daySelect = field({ label: t('io.addToDay'), type: 'select', value: '', options: [{ value: '', label: t('io.noDay') }, ...days.map((day, index) => ({ value: day.id, label: dayLabel(day, index) }))] });
  const counts = { waypoint: result.items.filter((item) => item.kind === 'waypoint').length, track: result.items.filter((item) => item.kind === 'track').length };
  const skippedCount = result.skipped.shapes + result.skipped.empty + result.skipped.invalid + result.skipped.over;
  const progress = progressBlock();
  progress.node.hidden = true;
  const error = errorLine();
  const importButton = button('', { variant: 'primary', onclick: () => run() });
  const back = button(t('io.back'), { onclick: onBack });
  function selected() { return boxes.flatMap((box, index) => (box.checked ? [index] : [])); }
  function sync() {
    const count = selected().length;
    all.checked = count === boxes.length; all.indeterminate = count > 0 && count < boxes.length;
    importButton.textContent = plural(count, 'importCount');
    importButton.disabled = count === 0;
  }
  async function run() {
    const picked = selected();
    if (!picked.length) return;
    error.clear(); importButton.setAttribute('aria-busy', 'true'); back.disabled = true; progress.node.hidden = false;
    try {
      const dayId = daySelect.input.value || null;
      const plan = planGeoImport(result.items.map((item, index) => ({ ...item, name: names[index] })), picked, {
        cats: space.select.cat.all(), builtins: builtinNames(), dayId, dayAfter: dayId ? dayEnd(space, dayId) : null,
      });
      let { drafts } = plan;
      let failed = 0;
      if (plan.tracks.length) {
        const upload = await uploadTracks(space, plan.tracks, { api, onProgress: (done, total) => progress.set(t('io.uploadingTracks', { done: done + 1, total }), done, total) });
        failed = upload.failed;
        const missing = new Set(plan.tracks.filter((track) => !upload.uploaded.has(track.placeId)).map((track) => track.placeId));
        drafts = withTracks(drafts.filter((draft) => !missing.has(draft.id) && !missing.has(draft.put?.placeId)), plan.tracks, upload.uploaded, { linkFiles: space.can('files.edit') });
        if (missing.size === plan.drafts.filter((draft) => draft.t === 'place').length) throw upload.lastError ?? new IoError('offline');
      }
      const label = t('io.historyImport', { name: file.name });
      progress.set(t('io.saving'), 0, drafts.length);
      const steps = await applyDrafts(space, drafts, { label, onProgress: (done, total) => progress.set(t('io.saving'), done, total) });
      const added = drafts.filter((draft) => draft.t === 'place').length;
      dialog.close('done');
      const message = failed ? t('io.addedWithFailures', { added: plural(added, 'places'), failed: plural(failed, 'tracks') }) : t('io.added', { added: plural(added, 'places') });
      toast(message, steps === 1 && space.history.label === label ? { action: { label: t('io.undo'), onClick: () => { void space.history.undo().catch(() => toast(t('io.undoFailed'))); } } } : {});
    } catch (problem) {
      error.show(problem, () => run());
      progress.node.hidden = true;
    } finally { importButton.setAttribute('aria-busy', 'false'); back.disabled = false; }
  }
  append(clear(body), [
    el('p.io-summary', {}, el('strong', {}, file.name), ' · ', [counts.waypoint && plural(counts.waypoint, 'waypoints'), counts.track && plural(counts.track, 'tracks')].filter(Boolean).join(' · ')),
    skippedCount ? el('p.io-note', {}, plural(skippedCount, 'skippedItems')) : null,
    counts.track && !space.can('files.upload') ? el('p.io-note', {}, t('io.tracksNeedUpload')) : null,
    el('label.check-field.io-all', {}, all, el('span', {}, t('io.selectAll'))),
    el('ul.io-items', { id: listId, 'aria-label': t('io.itemsLabel') }, rows),
    days.length ? daySelect.element : null,
    progress.node, error.node,
    el('div.modal-actions', {}, back, importButton)]);
  sync();
  all.focus();
}

function openGeo({ context, file, result, dialog, body, onBack }) {
  const { space, api } = deps(context);
  if (!space || space.ref?.k !== 'trip') throw new IoError('needs_trip');
  if (!space.can('plan.edit')) throw new IoError('forbidden');
  geoStep({ body, dialog, space, api, file, result, onBack });
}

async function readGeo(file) {
  return readGeoFile({ name: file.name, bytes: await fileBytes(file, IO_LIMITS.geoFileBytes) });
}

/** GPX, KML or KMZ into the open trip: waypoints become places, tracks and routes places with a track. */
export function openTrackImport(context, { file } = {}) {
  const { puter } = deps(context);
  const { dialog, body } = shell(t('io.trackImportTitle'));
  const start = () => pickStep({ body, accept: GEO_ACCEPT, intro: t('io.trackImportIntro'), puter, onFile: async (picked) => openGeo({ context, file: picked, result: await readGeo(picked), dialog, body, onBack: start }) });
  const step = start();
  if (file) void step.handle(file);
  return dialog;
}

// ---- Trips files

function tripStep({ body, dialog, context, file, data, onBack }) {
  const { space, session, api, puter, personal, uid, app } = deps(context);
  const counts = groupCounts(data);
  const canMerge = Boolean(space && space.ref?.k === 'trip');
  const canCreate = Boolean(session?.deployer && session?.api && session?.db && personal);
  const invalid = Object.values(data.invalid).reduce((sum, value) => sum + value, 0);
  const groups = Object.keys(IMPORT_GROUPS).filter((group) => counts[group] > 0);
  const modeControl = canMerge && choiceGroup({ label: t('io.importMode'), value: canCreate ? 'new' : 'merge', onChange: () => draw(), items: [
    { value: 'new', label: t('io.modeNew'), hint: canCreate ? t('io.modeNewHint') : t('io.sessionPending'), disabled: !canCreate },
    { value: 'merge', label: t('io.modeMerge'), hint: t('io.modeMergeHint') },
  ] });
  const title = field({ label: t('io.newTitle'), value: data.meta.title, maxLength: 500, required: true });
  const picks = new Map(groups.map((group) => [group, true]));
  const options = el('div.io-options');
  const progress = progressBlock();
  progress.node.hidden = true;
  const error = errorLine();
  const importButton = button(t('io.import'), { variant: 'primary', onclick: () => run() });
  const back = button(t('io.back'), { onclick: onBack });
  const mode = () => (modeControl ? modeControl.value : 'new');
  function draw() {
    const merge = mode() === 'merge';
    append(clear(options), [
      merge ? null : title.element,
      el('fieldset.io-groups', {}, el('legend.field-label', {}, t('io.whatToImport')), groups.map((group) => {
        const allowed = !merge || space.can(GROUP_ACTIONS[group]);
        return el('div.io-group', {}, checkbox(`${t(`io.group.${group}`)} (${counts[group]})`, { checked: allowed && picks.get(group), disabled: !allowed, onChange: (value) => picks.set(group, value) }),
          allowed ? null : el('span.io-muted', {}, t('io.groupForbidden')));
      })),
      counts.private ? el('p.io-note', {}, data.exportedBy === uid ? plural(counts.private, 'privateIncluded') : t('io.privateSkipped')) : null]);
  }
  async function run() {
    error.clear();
    const merge = mode() === 'merge';
    const chosen = groups.filter((group) => picks.get(group) && (!merge || space.can(GROUP_ACTIONS[group])));
    if (!merge && !title.input.value.trim()) { title.setError(t('io.titleRequired')); title.input.focus(); return; }
    if (merge && !chosen.length) { error.show(t('io.nothingChosen')); return; }
    title.setError('');
    importButton.setAttribute('aria-busy', 'true'); back.disabled = true; progress.node.hidden = false;
    let target = null;
    let created = null;
    try {
      if (!merge && !canCreate) throw new IoError('session_unavailable');
      if (merge) target = space;
      else {
        progress.set(t('io.stepWorker'));
        const { worker } = await session.deployer.ensure();
        const meta = { ...data.meta, title: title.input.value.trim().slice(0, 500) };
        progress.set(t('io.stepCreate'));
        const result = await api.request(worker.name, JSON.stringify({ op: 'space.create', kind: 'trip', meta, space: newId() }));
        created = { w: worker.name, s: result.space, k: 'trip' };
        await personal.spaces.upsert({ ref: created, role: 'owner', title: meta.title, ...(meta.start ? { start: meta.start } : {}), ...(meta.end ? { end: meta.end } : {}) }).catch(() => {});
        target = await openSpace({ ref: created, db: session.db, api, puter, personal, ownWorker: worker.name, role: 'owner', view: 'import' });
      }
      const plan = planSpaceImport(data, {
        uid, mode: merge ? 'merge' : 'new', groups: chosen, can: (action) => (merge ? space.can(action) : true),
        target: merge ? { members: space.members(), guests: space.select.guest.all(), places: space.select.place.all(), orders: maxOrders(space), rtPrefs: space.get('rtPrefs', ROAD_PREFS_ID) ?? null } : {},
        formerName: (n) => t('io.formerMember', { n }), catIcons: CAT_ICONS,
      });
      let drafts = plan.drafts;
      let failedTracks = 0;
      if (plan.tracks.length) {
        if (target.can('files.upload') && api) {
          const upload = await uploadTracks(target, plan.tracks, { api, onProgress: (done, total) => progress.set(t('io.uploadingTracks', { done: done + 1, total }), done, total) });
          failedTracks = upload.failed;
          drafts = withTracks(drafts, plan.tracks, upload.uploaded, { linkFiles: target.can('files.edit') });
        } else failedTracks = plan.tracks.length;
      }
      const label = merge ? t('io.historyImport', { name: file.name }) : null;
      progress.set(t('io.saving'), 0, drafts.length);
      const steps = await applyDrafts(target, drafts, { label, onProgress: (done, total) => progress.set(t('io.saving'), done, total) });
      for (const type of ['pack', 'exp']) for (const item of plan.private[type]) await target.privateItems(type).put(item.fields, item.id);
      let queued = 0;
      if (!merge) {
        queued = await drain(target, (done, total) => progress.set(t('io.sending'), done, total));
        target.close();
      }
      dialog.close('done');
      const total = drafts.filter((draft) => draft.t !== 'file').length;
      const parts = [merge ? t('io.importedInto', { items: plural(total, 'items') }) : t('io.importedNew', { title: title.input.value.trim() })];
      if (failedTracks) parts.push(plural(failedTracks, 'tracksFailed'));
      if (queued) parts.push(t('io.queuedLater'));
      toast(parts.join(' '), merge && steps === 1 && space.history.label === label ? { action: { label: t('io.undo'), onClick: () => { void space.history.undo().catch(() => toast(t('io.undoFailed'))); } } } : {});
      if (created) app?.navigate?.(`${spaceRoute(created)}/plan`);
    } catch (problem) {
      if (!merge && target && target !== space) target.close();
      progress.node.hidden = true;
      if (created) error.show(`${errorText(problem)} ${t('io.createdPartly')}`);
      else error.show(problem, () => run());
    } finally { importButton.setAttribute('aria-busy', 'false'); back.disabled = false; }
  }
  const range = formatDateRange(data.meta.start, data.meta.end);
  append(clear(body), [
    el('div.io-summary', {}, icon('json', 20), el('div', {}, el('strong', {}, data.meta.title), range && el('span.io-muted', {}, ` · ${range}`))),
    invalid ? el('p.io-note', {}, plural(invalid, 'invalidItems')) : null,
    counts.chat || counts.files ? el('p.io-note', {}, t('io.notImported')) : null,
    modeControl ? el('div.field', {}, el('span.field-label', {}, t('io.importMode')), modeControl.element) : null,
    options, progress.node, error.node,
    el('div.modal-actions', {}, back, importButton)]);
  draw();
  if (!canMerge && !canCreate) { importButton.disabled = true; error.show(t('io.error.session_unavailable')); }
}

/**
 * Imports a file: a Trips file (`.json`) as a new trip, or into the open trip; GPX, KML or KMZ into the open trip.
 * `context` is a view context (`space` and `session` as available).
 */
export function openTripImport(context, { file } = {}) {
  const { puter, space } = deps(context);
  const { dialog, body } = shell(t('io.importTitle'));
  const geoAllowed = Boolean(space && space.ref?.k === 'trip');
  const handle = async (picked) => {
    const bytes = await fileBytes(picked, Math.max(IO_LIMITS.jsonBytes, IO_LIMITS.geoFileBytes));
    if (isJson(picked, bytes)) {
      if (bytes.length > IO_LIMITS.jsonBytes) throw new IoError('file_too_large');
      tripStep({ body, dialog, context, file: picked, data: parseSpaceExport(new TextDecoder().decode(bytes)), onBack: start });
      return;
    }
    if (!geoAllowed) throw new IoError('needs_trip');
    openGeo({ context, file: picked, result: readGeoFile({ name: picked.name, bytes }), dialog, body, onBack: start });
  };
  const start = () => pickStep({ body, accept: geoAllowed ? `${JSON_ACCEPT},${GEO_ACCEPT}` : JSON_ACCEPT, intro: t(geoAllowed ? 'io.importIntroTrip' : 'io.importIntro'), puter, onFile: handle });
  const step = start();
  if (file) void step.handle(file);
  return dialog;
}
