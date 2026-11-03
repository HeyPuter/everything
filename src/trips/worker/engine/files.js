import { LIMITS } from '../../src/shared/limits.js';
import { storageName } from '../../src/shared/storage.js';
import { entitySchema, validate, s as schema } from '../../src/shared/schema/index.js';
import { bytesResponse, check, fail, json, readBody } from '../http.js';
import { HEX64, K, P, fileIdOf, own, spaceId } from '../keys.js';
import { workerChange } from './commit.js';
import { cleanupInvite, reconcileGrants } from './members.js';
import { DAY, HOUR, kvBudget, throttle } from './limits.js';
import { sweepInbox, sweepInboxes } from './inbox.js';
import { recordsUnder } from './scan.js';
import { snapshotJson } from './snapshot.js';
import { guardWrite, kindOf, loadMember, loadSpace, requireCan } from './space.js';
import { pool } from './store.js';

const VIDEO_BYTES = 500 * 1024 * 1024;
const TRASH_DAYS = 30 * DAY;
const SWEEP_AGE = HOUR;
const SNIFF_BYTES = 4096;
const MAX_PENDING = 500;
const decoder = new TextDecoder('utf-8', { fatal: true });

// Extension → accepted MIME types, magic-byte class, allowed `kind`s, and whether it needs direct mode.
// Trip photos (`kind: 'photo'`) are images only.
const IMAGE = Object.freeze(['user', 'photo']);
const TYPES = Object.freeze({
  jpg: { mimes: ['image/jpeg'], sniff: 'jpeg', kinds: IMAGE }, jpeg: { mimes: ['image/jpeg'], sniff: 'jpeg', kinds: IMAGE },
  png: { mimes: ['image/png'], sniff: 'png', kinds: IMAGE }, gif: { mimes: ['image/gif'], sniff: 'gif', kinds: IMAGE }, webp: { mimes: ['image/webp'], sniff: 'webp', kinds: IMAGE },
  avif: { mimes: ['image/avif'], sniff: 'isobmff', kinds: IMAGE }, heic: { mimes: ['image/heic', 'image/heif'], sniff: 'isobmff', kinds: IMAGE }, heif: { mimes: ['image/heif', 'image/heic'], sniff: 'isobmff', kinds: IMAGE },
  pdf: { mimes: ['application/pdf'], sniff: 'pdf' },
  doc: { mimes: ['application/msword'], sniff: 'ole' }, xls: { mimes: ['application/vnd.ms-excel'], sniff: 'ole' },
  docx: { mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], sniff: 'zip' },
  xlsx: { mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], sniff: 'zip' },
  pkpass: { mimes: ['application/vnd.apple.pkpass'], sniff: 'zip' }, pkpasses: { mimes: ['application/vnd.apple.pkpasses'], sniff: 'zip' },
  txt: { mimes: ['text/plain'], sniff: 'text' }, csv: { mimes: ['text/csv'], sniff: 'text' }, md: { mimes: ['text/markdown'], sniff: 'text' },
  mp4: { mimes: ['video/mp4'], sniff: 'isobmff', video: true }, mov: { mimes: ['video/quicktime'], sniff: 'isobmff', video: true },
  webm: { mimes: ['video/webm'], sniff: 'webm', video: true },
  gz: { mimes: ['application/gzip'], sniff: 'gzip', kinds: ['track'] },
  json: { mimes: ['application/json'], sniff: 'text', kinds: ['book'] },
});
export const RASTER = Object.freeze({ 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' });

const ascii = (bytes, start, text) => [...text].every((char, i) => bytes[start + i] === char.charCodeAt(0));

/** Magic-byte class of the first bytes of a file. Text must not look like markup. */
export function sniff(bytes) {
  if (!bytes.length) return 'empty';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => bytes[i] === byte)) return 'png';
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'gif';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'webp';
  if (ascii(bytes, 4, 'ftyp')) return 'isobmff';
  if (ascii(bytes, 0, '%PDF-')) return 'pdf';
  if ([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, i) => bytes[i] === byte)) return 'ole';
  if (ascii(bytes, 0, 'PK\u0003\u0004')) return 'zip';
  if ([0x1a, 0x45, 0xdf, 0xa3].every((byte, i) => bytes[i] === byte)) return 'webm';
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';
  if (bytes.includes(0)) return 'binary';
  let text;
  // A multi-byte character may be cut at the sniff boundary.
  try { text = decoder.decode(bytes.length >= SNIFF_BYTES ? bytes.subarray(0, SNIFF_BYTES - 4) : bytes); } catch { return 'binary'; }
  return /^\s*</.test(text) ? 'markup' : 'text';
}

export function typeFor(name, mime, kind) {
  const ext = name.toLowerCase().split('.').pop();
  const type = Object.hasOwn(TYPES, ext) ? TYPES[ext] : null;
  if (!type || !type.mimes.includes(mime.toLowerCase()) || !(type.kinds ?? ['user']).includes(kind)) fail('file_type', 415);
  if (ext === 'gz' && !name.toLowerCase().endsWith('.geojson.gz')) fail('file_type', 415);
  return type;
}

export { storageName };

export const filePath = (sid, fileId, entity) => `${P.file(sid, fileId)}/${entity.loc?.mode === 'direct' ? storageName(entity.name) : 'data'}`;

/** Reads stored bytes; a missing blob is a 404, never a retryable 500. */
export async function readStored(w, path) {
  try { return await w.fs.read(path); } catch (error) {
    if (error?.status === 404 || error?.code === 'subject_does_not_exist') fail('not_found', 404);
    throw error;
  }
}
const fileFields = schema.object({
  fileId: schema.string(16), name: schema.string(500, { nonempty: true }), mime: schema.string(255), sha256: schema.string(64, { pattern: HEX64 }),
  kind: schema.enum('user', 'track', 'book', 'photo'), inboxName: schema.optional(schema.string(128, { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ })),
  desc: schema.optional(schema.string(100_000)), op: schema.string(32), space: schema.string(16),
  taken: schema.optional(entitySchema('trip', 'file').fields.taken), geo: schema.optional(entitySchema('trip', 'file').fields.geo),
});

async function uploadBudget(w, sid, uuid, size) {
  await kvBudget(w, sid, 'up', uuid, { windowMs: DAY, limit: LIMITS.uploadsPerDay });
  await kvBudget(w, sid, 'upb', uuid, { windowMs: DAY, limit: LIMITS.uploadBytesPerDay, amount: size });
}

const pendingBytes = (pending) => Object.values(pending ?? {}).reduce((sum, item) => sum + (Number(item?.size) || 0), 0);
// Unregistered proxied uploads count too, so parked bytes cannot bypass the quota.
const quota = (count, size, pending) => { if ((Number(own(count, 'bytes')) || 0) + pendingBytes(pending) + size > LIMITS.spaceFileBytes) fail('space_quota', 413); };
const DOWNLOAD_BYTES = 2 * 1024 ** 3;
export const MIN_METERED = 256 * 1024;

/** Proxied upload: `PUT /files/<space>/<fileId>`, ≤50 MB, registered later by `file.put`. */
export async function putFile(w, ident, request, sid, fileId) {
  const { s, role } = await loadMember(w, ident, sid, { meta: true });
  requireCan(s, role, 'files.upload');
  guardWrite(w, s, 'files');
  throttle(w, `put:${sid}:${ident.uuid}`, 30, 60_000);
  const [existing, count, pending] = await w.kv.getMany([K.entity(sid, 'file', fileId), K.count(sid), K.pending(sid)]);
  if (existing) fail('exists', 409);
  const held = own(pending, fileId);
  if (held && held.uuid !== ident.uuid) fail('exists', 409);
  if (!held && Object.keys(pending ?? {}).length >= MAX_PENDING) fail('rate_limited', 429, { retryAfter: 600 });
  const bytes = await readBody(request, LIMITS.fileBytes);
  const kind = sniff(bytes.subarray(0, SNIFF_BYTES));
  if (['empty', 'binary', 'markup'].includes(kind)) fail('file_type', 415);
  quota(count, bytes.byteLength, held ? { ...pending, [fileId]: null } : pending);
  await uploadBudget(w, sid, ident.uuid, bytes.byteLength);
  const stat = await w.fs.write(`${P.file(sid, fileId)}/data`, new Blob([bytes]), { overwrite: true, createMissingParents: true, dedupeName: false });
  await w.kv.update(K.pending(sid), { [fileId]: { uuid: ident.uuid, size: bytes.byteLength, at: w.now(), sniff: kind, uid: stat.uid } });
  return json({ ok: true, fileId, size: bytes.byteLength });
}

/** Proxied download for members: always an attachment byte stream. */
export async function getFile(w, ident, sid, fileId) {
  await loadMember(w, ident, sid);
  throttle(w, `get:${sid}:${ident.uuid}`, 240, 60_000);
  const entity = await w.kv.get(K.entity(sid, 'file', fileId));
  if (!entity || entity.deleted) fail('not_found', 404);
  // The owner pays proxied egress, so downloads have a daily byte budget per member.
  // A floor per download keeps tiny files from turning the byte budget into an unlimited request count.
  await kvBudget(w, sid, 'dlb', ident.uuid, { windowMs: DAY, limit: DOWNLOAD_BYTES, amount: Math.max(MIN_METERED, Number(entity.size) || 0) });
  const blob = await readStored(w, filePath(sid, fileId, entity));
  return bytesResponse(blob.stream(), { headers: { 'Content-Length': String(blob.size) } });
}

/** Registers an uploaded file: direct mode moves it out of the inbox, proxied mode claims the pending upload. */
export async function filePut(w, ident, input) {
  const sid = spaceId(input.space);
  const fileId = fileIdOf(input.fileId);
  validate(fileFields, input);
  const { s, role } = await loadMember(w, ident, sid, { meta: true });
  requireCan(s, role, 'files.upload');
  guardWrite(w, s, 'files');
  const type = typeFor(input.name, input.mime, input.kind);
  check(input.kind === 'photo' || (input.taken === undefined && input.geo === undefined), 'invalid_file');
  if (input.kind === 'photo' && kindOf(s) !== 'trip') fail('file_type', 415);
  const [existing, count, pending, filesMode] = await w.kv.getMany([K.entity(sid, 'file', fileId), K.count(sid), K.pending(sid), K.filesMode(sid)]);
  if (existing) {
    if (!existing.deleted && existing.by === ident.uuid && existing.sha256 === input.sha256) {
      if (own(pending, fileId)) await w.kv.remove(K.pending(sid), [fileId]);
      return { rev: existing.rev, ents: [{ t: 'file', ...existing }], del: [] };
    }
    fail('exists', 409);
  }
  let loc;
  let size;
  if (input.inboxName !== undefined) {
    check(role === 'owner' || filesMode === 'direct', 'direct_unavailable', 409);
    const path = `${P.inboxOf(sid, ident.uuid)}/${input.inboxName}`;
    let stat;
    try { stat = await w.fs.stat(path); } catch { fail('upload_missing', 404); }
    const discard = async (code, status) => { await w.fs.delete(path).catch(() => {}); fail(code, status); };
    if (stat.is_dir || !(stat.size > 0)) await discard('upload_missing', 404);
    size = stat.size;
    if (size > (type.video ? VIDEO_BYTES : LIMITS.fileBytes)) await discard('file_too_large', 413);
    const head = new Uint8Array(await (await w.fs.read(path, { offset: 0, byte_count: SNIFF_BYTES })).slice(0, SNIFF_BYTES).arrayBuffer());
    if (sniff(head) !== type.sniff) await discard('file_type', 415);
    try { quota(count, size, pending); await uploadBudget(w, sid, ident.uuid, size); } catch (error) { await w.fs.delete(path).catch(() => {}); throw error; }
    await w.fs.mkdir(P.file(sid, fileId), { createMissingParents: true });
    const target = `${P.file(sid, fileId)}/${storageName(input.name)}`;
    const moved = await w.fs.move(path, target);
    // The member could rewrite the inbox file between the check and the move; check the moved copy again.
    const after = await w.fs.stat(target);
    const tail = new Uint8Array(await (await w.fs.read(target, { offset: 0, byte_count: SNIFF_BYTES })).slice(0, SNIFF_BYTES).arrayBuffer());
    if (after.size !== size || sniff(tail) !== type.sniff) {
      await w.fs.delete(P.file(sid, fileId), { recursive: true }).catch(() => {});
      fail('file_type', 415);
    }
    loc = { mode: 'direct', ...(isUuidLike(moved?.uid) ? { uid: moved.uid } : {}) };
    w.waitUntil(sweepInbox(w, sid, ident.uuid).catch(() => {}));
  } else {
    const held = own(pending, fileId);
    if (!held || held.uuid !== ident.uuid) fail('upload_missing', 404);
    if (held.sniff !== type.sniff) fail('file_type', 415);
    if (type.video) fail('direct_required', 409);
    size = held.size;
    loc = { mode: 'proxied', ...(isUuidLike(held.uid) ? { uid: held.uid } : {}) };
  }
  const put = { name: input.name, mime: input.mime.toLowerCase(), size, sha256: input.sha256, kind: input.kind, loc, ...(input.desc ? { desc: input.desc } : {}),
    ...(input.taken ? { taken: input.taken } : {}), ...(input.geo ? { geo: input.geo } : {}) };
  const result = await workerChange(w, sid, ident.uuid, [{ t: 'file', id: fileId, put }], { kind: kindOf(s), deltas: { bytes: size } });
  if (loc.mode === 'proxied') await w.kv.remove(K.pending(sid), [fileId]);
  return { rev: result.rev, ents: result.ents, del: result.del };
}

const isUuidLike = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

async function purge(w, sid, s, actor, entity) {
  await w.fs.delete(P.file(sid, entity.id), { recursive: true }).catch((error) => { if (error?.status !== 404 && error?.code !== 'subject_does_not_exist') throw error; });
  return workerChange(w, sid, actor, [{ t: 'file', id: entity.id, del: true }], { kind: kindOf(s), deltas: { bytes: -(Number(entity.size) || 0) } });
}

/** `{fileId}` trashes, `{restore:true}` restores, `{purge:true}` deletes a trashed file. */
export async function fileDel(w, ident, input) {
  const sid = spaceId(input.space);
  const fileId = fileIdOf(input.fileId);
  const { s, role } = await loadMember(w, ident, sid, { meta: true });
  requireCan(s, role, 'files.delete');
  guardWrite(w, s, 'files');
  const entity = await w.kv.get(K.entity(sid, 'file', fileId));
  if (!entity || entity.deleted) fail('gone', 409);
  const got = new Map([[K.entity(sid, 'file', fileId), entity]]);
  let result;
  if (input.purge === true) {
    if (!entity.trashed) fail('not_trashed', 409);
    result = await purge(w, sid, s, ident.uuid, entity);
  } else if (input.restore === true) {
    result = entity.trashed ? await workerChange(w, sid, ident.uuid, [{ t: 'file', id: fileId, unset: ['trashed'] }], { kind: kindOf(s), got }) : null;
  } else {
    result = entity.trashed ? null : await workerChange(w, sid, ident.uuid, [{ t: 'file', id: fileId, set: { trashed: w.now() } }], { kind: kindOf(s), got });
  }
  return { rev: result?.rev ?? entity.rev, ents: result?.ents ?? [], del: result?.del ?? [] };
}

/** Hourly owner-side cleanup: stale uploads, inboxes, 30-day trash, expired invites and grants of former members. */
export async function maintain(w, sid, kind) {
  const key = K.maint(sid, w.now());
  if ((await w.kv.incr(key)) !== 1) return;
  await w.kv.expire(key, 7200).catch(() => {});
  const s = await loadSpace(w, sid);
  const [pending, invites] = await w.kv.getMany([K.pending(sid), K.invs(sid)]);
  const stale = Object.entries(pending ?? {}).filter(([, item]) => !item || w.now() - item.at > SWEEP_AGE).map(([fileId]) => fileId);
  if (stale.length) {
    // A registered file whose pending entry survived keeps its bytes.
    const registered = await w.kv.getMany(stale.map((fileId) => K.entity(sid, 'file', fileId)));
    const orphans = stale.filter((_, i) => !registered[i]);
    await pool(orphans, 4, (fileId) => w.fs.delete(P.file(sid, fileId), { recursive: true }).catch(() => {}));
    await w.kv.remove(K.pending(sid), stale);
  }
  await sweepInboxes(w, sid).catch(() => {});
  const expired = Object.entries(invites ?? {}).filter(([, item]) => !item || item.exp <= w.now());
  await pool(expired, 4, ([hash, item]) => cleanupInvite(w, sid, hash, item ?? {}, { keep: true }));
  await reconcileGrants(w, sid, await recordsUnder(w, sid, 'h')).catch(() => {});
  const snapshot = await snapshotJson(w, sid, kind);
  const candidates = (snapshot?.ents ?? []).filter((entity) => entity.t === 'file' && entity.trashed && w.now() - entity.trashed > TRASH_DAYS).slice(0, 50);
  if (!candidates.length) return;
  // The snapshot may predate a restore, so purge only what is still trashed now.
  const current = await w.kv.getMany(candidates.map((entity) => K.entity(sid, 'file', entity.id)));
  const owner = (await w.owner()).uuid;
  for (const entity of current) {
    if (entity && !entity.deleted && entity.trashed && w.now() - entity.trashed > TRASH_DAYS) await purge(w, sid, s, owner, entity).catch(() => {});
  }
}
