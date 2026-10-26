// Import and export: JSON (lossless for one member) and GPX waypoints (OsmAnd favourites included).
import { el } from '../../ui/dom.js';
import { button } from '../../ui/bits.js';
import { segmented } from '../../ui/fields.js';
import { openModal } from '../../ui/modal.js';
import { t } from '../../lib/i18n/index.js';
import { saveBlob } from '../../lib/download.js';
import { formatNumber } from '../../lib/format.js';
import { newId } from '../../shared/ids.js';
import { MAX_IMPORT_BYTES, STATUSES, appendOrders, exportGpx, exportJson, fold, gpxFields, parseGpx, parseJson, samePlace } from './model.js';
import { errorText } from './spaces.js';

const count = (value) => formatNumber(value);

export function pickFile({ accept, document: doc = globalThis.document } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, hidden: true });
    let settled = false;
    const done = (file) => { if (settled) return; settled = true; input.remove(); resolve(file); };
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => done(null));
    // Browsers without a cancel event: focus comes back to the page with no file chosen.
    globalThis.addEventListener?.('focus', () => setTimeout(() => { if (!input.files?.length) done(null); }, 1000), { once: true });
    doc.body.append(input);
    input.click();
  });
}


export const fileName = (name, extension) => `${(name || 'collection').replace(/[\u0000-\u001f\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'collection'}.${extension}`;

/** Parses a picked file into `{kind, meta, labels, places: [{fields, labels}], skipped}`. */
export async function readImport(file, { uid }) {
  if (!file) return null;
  if (file.size > MAX_IMPORT_BYTES) throw Object.assign(new Error('import_too_large'), { code: 'import_too_large' });
  const text = await file.text();
  if (/\.json$/i.test(file.name) || /^\s*\{/.test(text)) return { kind: 'json', ...parseJson(text, { uid }) };
  const gpx = parseGpx(text);
  const labels = [];
  for (const place of gpx.places) if (place.group && !labels.some((label) => fold(label.name) === fold(place.group))) labels.push({ name: place.group });
  return {
    kind: 'gpx', meta: { name: gpx.name || file.name.replace(/\.[^.]+$/, '').slice(0, 200) }, labels, skipped: gpx.skipped,
    places: gpx.places.map((place) => ({ fields: gpxFields(place), labels: place.group ? [place.group] : [] })),
  };
}

/** Ops that add the parsed places to `space`, reusing labels by name and skipping places already saved. */
export function importOps(space, parsed, { status, makeId = newId } = {}) {
  const existing = space.select.saved.all();
  const labelIds = new Map(space.select.label.all().map((label) => [fold(label.name), label.id]));
  const ops = [];
  const fresh = parsed.places.filter((place) => !existing.some((item) => samePlace(item, place.fields)));
  const used = new Set(fresh.flatMap((place) => place.labels.map(fold)));
  const newLabels = parsed.labels.filter((label) => used.has(fold(label.name)) && !labelIds.has(fold(label.name)));
  const labelOrders = appendOrders(space.select.label.all(), newLabels.length);
  newLabels.forEach((label, index) => {
    const id = makeId();
    labelIds.set(fold(label.name), id);
    ops.push(space.ops.create('label', { name: label.name, ...(label.color ? { color: label.color } : {}), order: labelOrders[index] }, { id }));
  });
  const orders = appendOrders(existing, fresh.length);
  fresh.forEach((place, index) => {
    const labels = [...new Set(place.labels.map((name) => labelIds.get(fold(name))).filter(Boolean))];
    ops.push(space.ops.create('saved', { ...place.fields, ...(status ? { status } : {}), order: orders[index], ...(labels.length ? { labels } : {}) }));
  });
  return { ops, added: fresh.length, duplicates: parsed.places.length - fresh.length, labels: newLabels.length };
}

/** Saves the collection as a file. Places without coordinates are left out of GPX. Resolves the export summary. */
export function exportCollection(space, { uid, format }) {
  const meta = space.get('meta', 'meta') ?? {};
  const labels = space.select.label.all();
  const saved = space.select.saved.all();
  if (format === 'gpx') {
    const result = exportGpx({ meta, labels, saved });
    saveBlob(new Blob([result.text], { type: 'application/gpx+xml' }), fileName(meta.name, 'gpx'));
    return result;
  }
  saveBlob(new Blob([`${JSON.stringify(exportJson({ meta, labels, saved, uid }), null, 2)}\n`], { type: 'application/json' }), fileName(meta.name, 'json'));
  return { count: saved.length, skipped: 0 };
}

/**
 * Asks for a file, previews what it holds and resolves `{parsed, status}` on confirm, or null. `target` (a space)
 * marks duplicates in the preview.
 */
export async function chooseImport({ uid, target = null }) {
  const file = await pickFile({ accept: '.json,.gpx,application/json,application/gpx+xml' });
  if (!file) return null;
  let parsed;
  try { parsed = await readImport(file, { uid }); } catch (error) {
    await notice(error?.code === 'import_too_large' ? t('collections.importTooLarge') : error?.code === 'import_unreadable' ? t('collections.importUnreadable') : errorText(error));
    return null;
  }
  if (!parsed.places.length) { await notice(t('collections.importEmpty')); return null; }
  const duplicates = target ? parsed.places.filter((place) => target.select.saved.all().some((item) => samePlace(item, place.fields))).length : 0;
  return new Promise((resolve) => {
    let result = null;
    const status = parsed.kind === 'gpx'
      ? segmented({ label: t('collections.importStatus'), radio: true, value: 'idea', items: STATUSES.map((value) => ({ value, label: t(`collections.status.${value}`) })) })
      : null;
    const confirm = button(t('collections.importConfirm', { count: count(parsed.places.length - duplicates) }), { variant: 'primary', disabled: parsed.places.length === duplicates,
      onclick: () => { result = { parsed, status: status?.value }; dialog.close('confirm'); } });
    const dialog = openModal({
      title: t('collections.importTitle', { name: file.name }),
      content: el('div.col-import', {},
        el('ul.col-import-facts', {},
          el('li', {}, t('collections.importCount', { count: count(parsed.places.length) })),
          parsed.labels.length > 0 && el('li', {}, t('collections.importLabels', { count: count(parsed.labels.length) })),
          duplicates > 0 && el('li', {}, t('collections.importDuplicates', { count: count(duplicates) })),
          parsed.skipped > 0 && el('li', {}, t('collections.importSkipped', { count: count(parsed.skipped) }))),
        status && el('div.col-field-group', {}, el('span.field-label', {}, t('collections.importStatus')), status.element),
        el('p.col-hint', {}, t('collections.importPrivacy'))),
      actions: [button(t('collections.cancel'), { onclick: () => dialog.close('cancel') }), confirm],
      onClose: () => resolve(result),
    });
  });
}

function notice(message) {
  return new Promise((resolve) => {
    const dialog = openModal({ title: t('collections.importTitleShort'), content: el('p', { role: 'alert' }, message),
      actions: [button(t('collections.close'), { variant: 'primary', onclick: () => dialog.close('ok') })], onClose: () => resolve() });
  });
}
