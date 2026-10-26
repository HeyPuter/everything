// Export dialog for the open trip: the Trips file (JSON), GPX, KML or KMZ, saved to the device or Puter.
import { el } from '../../ui/dom.js';
import { button } from '../../ui/bits.js';
import { checkbox, choiceGroup, segmented } from '../../ui/fields.js';
import { openModal } from '../../ui/modal.js';
import { toast } from '../../ui/toast.js';
import { t } from '../../lib/i18n/index.js';
import { saveBlob } from '../../lib/download.js';
import { IoError } from '../../lib/io/errors.js';
import { tripGeo, toGpx, toKml, toKmz, GEO_SCOPES } from '../../lib/io/geo-export.js';
import { buildSpaceExport } from '../../lib/io/space-format.js';
import { downloadTrack } from '../../lib/io/track-file.js';
import { ownPrivateItems, spaceEntities, spaceMembers, tripData } from '../../lib/io/collect.js';
import { slug, stamp } from '../../lib/io/text.js';
import { categoryOf } from '../../lib/categories.js';
import { dayLabel, deps, driveAvailable, errorLine, errorText, plural, progressBlock, resolveColor, saveToDrive } from './common.js';
import './io.css';

const FORMATS = Object.freeze(['json', 'gpx', 'kml', 'kmz']);
const MIME = { json: 'application/json', gpx: 'application/gpx+xml', kml: 'application/vnd.google-earth.kml+xml', kmz: 'application/vnd.google-earth.kmz' };

/** Downloads the track files of the trip's track places (four at a time); failures are counted, not thrown. */
async function loadTracks(space, api, places, onProgress) {
  const ids = [...new Set(places.map((place) => place.track?.fileId).filter((id) => id && space.get('file', id) && !space.get('file', id).deleted))];
  const tracks = new Map();
  let failed = 0;
  let next = 0;
  let done = 0;
  if (!ids.length) return { tracks, failed };
  if (!api) return { tracks, failed: ids.length };
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try { tracks.set(id, await downloadTrack(space.ref, id, { api })); } catch { failed += 1; }
      onProgress?.(++done, ids.length);
    }
  }));
  return { tracks, failed };
}

/** Builds the chosen file: `{blob, name, failed}`. */
export async function buildExport(context, { format, scope = 'all', includeChat = true, onProgress } = {}) {
  const { space, api, uid } = deps(context);
  if (!space) throw new IoError('needs_trip');
  const meta = space.get('meta', 'meta') ?? {};
  const base = `${slug(meta.title)}-${stamp()}`;
  const trip = tripData(space);
  const needTracks = format === 'json' || scope === 'all';
  const { tracks, failed } = needTracks ? await loadTracks(space, api, trip.places, (done, total) => onProgress?.(t('io.downloadingTracks', { done, total }), done, total)) : { tracks: new Map(), failed: 0 };
  if (format === 'json') {
    const data = buildSpaceExport({ kind: space.ref.k, meta, entities: spaceEntities(space), members: spaceMembers(space), uid, privateItems: ownPrivateItems(space),
      tracks: Object.fromEntries(tracks), source: { space: space.ref.s, rev: space.state?.rev }, includeChat });
    return { blob: new Blob([JSON.stringify(data, null, 2)], { type: MIME.json }), name: `${base}.json`, failed };
  }
  const geo = tripGeo(trip, { scope, tracks, category: (place) => categoryOf(space, place.cat), dayName: (entry) => dayLabel(entry.day, entry.index) });
  if (!geo.waypoints.length && !geo.routes.length && !geo.tracks.length) throw new IoError('no_features');
  const options = { name: meta.title, desc: meta.description, resolveColor };
  if (format === 'gpx') return { blob: new Blob([toGpx(geo, options)], { type: MIME.gpx }), name: `${base}.gpx`, failed };
  const kml = toKml(geo, { ...options, labels: { places: t('io.folderPlaces'), days: t('io.folderDays'), tracks: t('io.folderTracks') } });
  if (format === 'kml') return { blob: new Blob([kml], { type: MIME.kml }), name: `${base}.kml`, failed };
  return { blob: new Blob([toKmz(kml)], { type: MIME.kmz }), name: `${base}.kmz`, failed };
}

/** Opens the export dialog for the trip in `context.space`. */
export function openTripExport(context) {
  const { space, puter } = deps(context);
  const body = el('div.io-dialog');
  const dialog = openModal({ title: t('io.exportTitle'), content: body, wide: true });
  if (!space) { body.replaceChildren(el('p', {}, t('io.error.needs_trip'))); return dialog; }
  let includeChat = true;
  const format = choiceGroup({ label: t('io.format'), value: 'json', onChange: () => draw(), items: FORMATS.map((value) => ({ value, label: t(`io.format.${value}`), hint: t(`io.formatHint.${value}`) })) });
  const scope = segmented({ label: t('io.scope'), value: 'all', items: GEO_SCOPES.map((value) => ({ value, label: t(`io.scope.${value}`) })) });
  const chat = checkbox(t('io.includeChat'), { checked: includeChat, onChange: (value) => { includeChat = value; } });
  const options = el('div.io-options');
  const progress = progressBlock();
  progress.node.hidden = true;
  const error = errorLine();
  function draw() {
    const json = format.value === 'json';
    options.replaceChildren(
      json ? chat : el('div.field', {}, el('span.field-label', {}, t('io.scope')), scope.element),
      el('p.io-note', {}, t(json ? 'io.jsonPrivacy' : 'io.geoPrivacy')));
  }
  async function run(target) {
    error.clear();
    for (const control of actions) control.disabled = true;
    progress.node.hidden = false;
    progress.set(t('io.preparing'));
    try {
      const { blob, name, failed } = await buildExport(context, { format: format.value, scope: scope.value, includeChat, onProgress: (message, done, total) => progress.set(message, done, total) });
      if (target === 'drive') void new Promise((resolve) => { resolve(saveToDrive(puter, blob, name)); }).then(() => toast(t('io.savedToPuter', { name })), (problem) => toast(errorText(problem)));
      else saveBlob(blob, name);
      dialog.close('done');
      if (failed) toast(plural(failed, 'tracksMissing'));
    } catch (problem) {
      error.show(problem, () => run(target));
      progress.node.hidden = true;
    } finally { for (const control of actions) control.disabled = false; }
  }
  const actions = [
    button(t('io.cancel'), { onclick: () => dialog.close('cancel') }),
    driveAvailable(puter) && button(t('io.saveToPuter'), { variant: 'outline', onclick: () => run('drive') }),
    button(t('io.download'), { variant: 'primary', onclick: () => run('device') }),
  ].filter(Boolean);
  body.replaceChildren(
    el('div.field', {}, el('span.field-label', {}, t('io.format')), format.element),
    options, progress.node, error.node,
    el('div.modal-actions', {}, actions));
  draw();
  return dialog;
}
