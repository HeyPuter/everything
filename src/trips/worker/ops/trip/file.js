// File entity rules beyond the shared schema, and the thumbnail routes (`/files/<space>/<fileId>/thumb`).
import { DomainError } from '../../../src/shared/errors.js';
import { isId, newId } from '../../../src/shared/ids.js';
import { parseLinkKey } from '../../../src/shared/file-links.js';
import { LIMITS } from '../../../src/shared/limits.js';
import { bytesResponse, check, fail, json, readBody } from '../../http.js';
import { K, P } from '../../keys.js';
import { workerChange } from '../../engine/commit.js';
import { MIN_METERED, readStored, sniff } from '../../engine/files.js';
import { DAY, kvBudget } from '../../engine/limits.js';
import { guardWrite, kindOf, loadMember, requireCan } from '../../engine/space.js';

/** Entity types a file may link to; `meta` marks the trip cover. */
export const LINK_TYPES = Object.freeze(['place', 'res', 'visit', 'exp', 'note', 'msg', 'meta']);
export const THUMB_BYTES = 256 * 1024;
const THUMB_KINDS = new Set(['webp', 'jpeg', 'png']);
const THUMB_SOURCES = /^image\/(jpeg|png|gif|webp|avif|heic|heif)$/;
// Same daily budget as file downloads (engine/files.js).
const DOWNLOAD_BYTES = 2 * 1024 ** 3;

// Stored names never start with a dot (engine/files.js `storageName`), so this cannot collide with a direct-mode file.
export const thumbPath = (sid, fileId) => `${P.file(sid, fileId)}/.thumb`;

/**
 * Checks both link forms of a file (`links[]` and `linked` paths) against the target types of its space kind. A link
 * may sit in both forms (an older client wrote the list while a newer one wrote the path).
 */
export function checkFileLinks(after, types) {
  if (!after) return;
  const valid = (link) => Boolean(link) && types.includes(link.t) && (link.t === 'meta' ? link.id === 'meta' : isId(link.id));
  const seen = new Set();
  for (const link of after.links ?? []) {
    if (!valid(link) || seen.has(`${link.t}:${link.id}`)) throw new DomainError('invalid_links', 400);
    seen.add(`${link.t}:${link.id}`);
  }
  for (const key of Object.keys(after.linked ?? {})) if (!valid(parseLinkKey(key))) throw new DomainError('invalid_links', 400);
}

export default Object.freeze({
  check({ after }) { checkFileLinks(after, LINK_TYPES); },
});

/** Stores a browser-made thumbnail for an image file and stamps a fresh `thumb` id on the entity. */
export async function putThumb(w, ident, request, sid, fileId) {
  const { s, role } = await loadMember(w, ident, sid, { meta: true });
  requireCan(s, role, 'files.edit');
  guardWrite(w, s, 'files');
  check(w.limiter.take(`thumb:${sid}:${ident.uuid}`, 60, 60_000), 'rate_limited', 429);
  const key = K.entity(sid, 'file', fileId);
  const entity = await w.kv.get(key);
  if (!entity || entity.deleted) fail('not_found', 404);
  check(THUMB_SOURCES.test(entity.mime ?? ''), 'thumb_unsupported', 415);
  const bytes = await readBody(request, THUMB_BYTES);
  check(THUMB_KINDS.has(sniff(bytes.subarray(0, 4096))), 'file_type', 415);
  await kvBudget(w, sid, 'upb', ident.uuid, { windowMs: DAY, limit: LIMITS.uploadBytesPerDay, amount: bytes.byteLength });
  const path = thumbPath(sid, fileId);
  await w.fs.write(path, new Blob([bytes]), { overwrite: true, createMissingParents: true, dedupeName: false });
  let result;
  try {
    result = await workerChange(w, sid, ident.uuid, [{ t: 'file', id: fileId, set: { thumb: newId() } }], { kind: kindOf(s), got: new Map([[key, entity]]) });
  } catch (error) {
    // The file was purged meanwhile; drop the orphan.
    await w.fs.delete(path).catch(() => {});
    throw error;
  }
  return json({ ok: true, rev: result.rev, ents: result.ents, del: result.del });
}

/** Thumbnail download for members, metered like file downloads. */
export async function getThumb(w, ident, sid, fileId) {
  await loadMember(w, ident, sid);
  check(w.limiter.take(`thumbget:${sid}:${ident.uuid}`, 600, 60_000), 'rate_limited', 429);
  await kvBudget(w, sid, 'dlb', ident.uuid, { windowMs: DAY, limit: DOWNLOAD_BYTES, amount: MIN_METERED });
  const blob = await readStored(w, thumbPath(sid, fileId));
  return bytesResponse(blob.stream(), { headers: { 'Content-Length': String(blob.size) } });
}
