import { isDate, isTime } from '../../src/shared/dates.js';
import { isUuid } from '../../src/shared/ids.js';
import { PROJECTION_VERSION, createAliases, initialOf, shareView } from './projection.js';

/** The public view of a journey (data-model §6 `GET /pub`). Fields are copied by allowlist, so new ones stay private. */

const RASTER = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const META_FIELDS = ['title', 'subtitle', 'status'];
const TEXT_FIELDS = ['story', 'mood', 'weather', 'tags', 'pros', 'cons'];
const CAPTION_MAX = 2000;

/** Entries a visitor may ever see: written up (not trip suggestions), not dismissed and not members-only. */
export function isPublicEntry(entity) {
  return Boolean(entity && entity.t === 'entry' && !entity.deleted && entity.type !== 'suggestion' && entity.dismissed !== true && entity.vis !== 'members');
}

/** Place name and country always; coordinates only when the map is shared. */
function locView(loc, view) {
  if (!loc || typeof loc !== 'object') return null;
  const out = {};
  if (typeof loc.name === 'string' && loc.name) out.name = loc.name;
  if (typeof loc.cc === 'string' && loc.cc) out.cc = loc.cc;
  if (view.map && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) Object.assign(out, { lat: loc.lat, lng: loc.lng });
  return Object.keys(out).length ? out : null;
}

/**
 * `timeline` shares the written entries, `map` their coordinates (pins and the route) and `gallery` their photos.
 * With only the map or the gallery on, entries carry just their date, title and place, so pins and photos can be
 * labelled. Photos are raster images listed in a public entry's `media`; videos and documents never are.
 */
export function projectJourney(snapshot, share, { meta: freshMeta, exp = null } = {}) {
  const ents = Array.isArray(snapshot?.ents) ? snapshot.ents.filter((entity) => entity && typeof entity === 'object') : [];
  const view = shareView('journey', share, exp);
  const metaEntity = freshMeta && typeof freshMeta === 'object' ? freshMeta : ents.find((entity) => entity.t === 'meta') ?? {};
  const meta = Object.fromEntries(META_FIELDS.filter((field) => typeof metaEntity[field] === 'string').map((field) => [field, metaEntity[field]]));

  const files = new Map();
  for (const entity of ents) if (entity.t === 'file' && !entity.deleted && !entity.trashed) files.set(entity.id, entity);
  const isImage = (id) => typeof id === 'string' && RASTER.has(files.get(id)?.mime);
  const isPhoto = (id) => isImage(id) && files.get(id).kind === 'user';
  const media = view.timeline || view.gallery;

  const servable = new Set();
  const captioned = new Set();
  const out = [];
  if (view.timeline || view.map || view.gallery) {
    for (const entity of ents) {
      if (!isPublicEntry(entity)) continue;
      const item = { t: 'entry', id: entity.id, title: entity.title };
      if (isDate(entity.date)) item.date = entity.date;
      if (isTime(entity.time)) item.time = entity.time;
      if (typeof entity.type === 'string') item.type = entity.type;
      if (typeof entity.order === 'string') item.order = entity.order;
      if (Number.isSafeInteger(entity.cr)) item.cr = entity.cr;
      if (view.timeline) for (const field of TEXT_FIELDS) if (entity[field] !== undefined) item[field] = structuredClone(entity[field]);
      const loc = locView(entity.loc, view);
      if (loc) item.loc = loc;
      if (media && Array.isArray(entity.media)) {
        const photos = entity.media.filter(isPhoto);
        if (photos.length) item.media = photos;
        for (const id of photos) { servable.add(id); captioned.add(id); }
      }
      out.push(item);
    }
  }
  if (typeof metaEntity.cover === 'string' && isImage(metaEntity.cover)) { meta.cover = metaEntity.cover; servable.add(metaEntity.cover); }
  else if (metaEntity.cover && typeof metaEntity.cover === 'object' && typeof metaEntity.cover.url === 'string') meta.cover = structuredClone(metaEntity.cover);

  const fileViews = [...servable].map((id) => {
    const { name, mime, size, desc, thumb } = files.get(id);
    return {
      t: 'file', id, name, mime, size,
      ...(captioned.has(id) && typeof desc === 'string' && desc.trim() ? { desc: desc.slice(0, CAPTION_MAX) } : {}),
      ...(thumb ? { thumb: true } : {}),
    };
  });

  const memberEnts = ents.filter((entity) => entity.t === 'member' && !entity.deleted && isUuid(entity.id))
    .sort((a, b) => (a.cr ?? 0) - (b.cr ?? 0) || (a.id < b.id ? -1 : 1));
  const aliases = createAliases(memberEnts);
  const members = memberEnts.map(({ id, name, color }) => ({ id: aliases.alias(id), name: initialOf(name), ...(color !== undefined ? { color } : {}) }));
  return {
    v: PROJECTION_VERSION, kind: 'journey', rev: snapshot?.rev ?? 0, at: snapshot?.at ?? 0,
    share: view, meta, members, ents: aliases.walk([...out, ...fileViews]), files: [...servable],
  };
}
