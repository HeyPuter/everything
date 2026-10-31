// The public journey projection checked as untrusted input (the worker belongs to the journey's owner).
import { validateEntity } from '../../../shared/schema/index.js';
import { isId, isUuid } from '../../../shared/ids.js';
import { safeURL } from '../../../ui/dom.js';
import { JOURNEY_STATUSES } from '../constants.js';

const RASTER = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const ENTRY_FIELDS = ['type', 'date', 'time', 'title', 'story', 'loc', 'mood', 'weather', 'tags', 'pros', 'cons', 'order', 'media'];
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

function cleanFile(entity) {
  if (!isId(entity.id) || typeof entity.name !== 'string' || !RASTER.has(entity.mime) || !Number.isSafeInteger(entity.size)) return null;
  return Object.freeze({
    t: 'file', id: entity.id, name: entity.name.slice(0, 500), mime: entity.mime, size: entity.size,
    ...(typeof entity.desc === 'string' && entity.desc.trim() ? { desc: entity.desc.slice(0, 2000) } : {}), thumb: entity.thumb === true,
  });
}

function cleanEntry(entity, files) {
  if (entity?.t !== 'entry' || !isId(entity.id)) return null;
  const fields = Object.fromEntries(ENTRY_FIELDS.filter((key) => entity[key] !== undefined).map((key) => [key, entity[key]]));
  try { validateEntity('journey', 'entry', fields); } catch { return null; }
  if (fields.type === 'suggestion') return null;
  if (fields.media) fields.media = fields.media.filter((id) => files.has(id));
  return Object.freeze({ ...fields, t: 'entry', id: entity.id, ...(Number.isSafeInteger(entity.cr) ? { cr: entity.cr } : {}) });
}

/** Returns `{rev, share, meta, members, entries, files}` with only well-formed values. */
export function cleanJourneyProjection(data) {
  const value = data && typeof data === 'object' ? data : {};
  const raw = Array.isArray(value.ents) ? value.ents : [];
  const servable = new Set((Array.isArray(value.files) ? value.files : []).filter(isId));
  const files = new Map();
  for (const entity of raw) if (entity?.t === 'file' && servable.has(entity.id)) { const file = cleanFile(entity); if (file) files.set(file.id, file); }
  const entries = raw.map((entity) => cleanEntry(entity, files)).filter(Boolean);
  const share = value.share && typeof value.share === 'object' ? value.share : {};
  const meta = value.meta && typeof value.meta === 'object' ? value.meta : {};
  const cover = files.has(meta.cover) ? meta.cover : safeURL(meta.cover?.url) ? { url: safeURL(meta.cover.url), ...(typeof meta.cover.credit === 'string' ? { credit: meta.cover.credit.slice(0, 500) } : {}) } : null;
  return Object.freeze({
    rev: Number.isSafeInteger(value.rev) ? value.rev : 0,
    share: Object.freeze({ timeline: share.timeline === true, gallery: share.gallery === true, map: share.map === true, newestFirst: share.newestFirst === true, exp: Number.isSafeInteger(share.exp) ? share.exp : null }),
    meta: Object.freeze({ title: text(meta.title, 500), subtitle: text(meta.subtitle, 500), status: JOURNEY_STATUSES.includes(meta.status) ? meta.status : null, cover }),
    members: Object.freeze((Array.isArray(value.members) ? value.members : []).filter((member) => isUuid(member?.id) && typeof member.name === 'string').map((member) => member.name.slice(0, 500))),
    entries: Object.freeze(entries),
    files: files,
  });
}
