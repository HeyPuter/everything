// "Download all my data": every space this account owns (from its worker's `space.export`) plus personal KV, zipped.
import { strToU8, zipSync } from 'fflate';
import { isId } from '../../shared/ids.js';
import { pool } from '../../shared/pool.js';
import { plainObject } from '../../shared/schema/dsl.js';
import { IoError } from './errors.js';
import { IO_LIMITS } from './limits.js';
import { PRIVATE_TYPES, fromWorkerExport } from './space-format.js';
import { slug, stamp } from './text.js';
import { VACAY_INDEX, vacayKeys } from '../vacay/data.js';

export const PERSONAL_FORMAT = 'trips-personal';
const STATIC_KEYS = Object.freeze(['me:prefs', 'me:worker', 'me:spaces', 'me:collections', 'me:atlas', 'me:buckets', 'me:tags', 'me:cats', 'me:tpls', 'me:vault', 'me:notify', 'me:dawarich', 'me:photos']);
// Keys without an index cannot be found without listing KV, so they are not exported.
export const UNINDEXED_KEYS = Object.freeze(['me:import:<id>']);
// Device credentials and third-party server keys never leave the account.
const SECRET = /^me:(?:cred|integrations)(?::|$)/;

/** Personal KV keys to export, from the `me:spaces`, `me:tpls`, `me:buckets`, `me:photos` and `vacay:idx` indexes. Credentials and integration keys are never included. */
export function personalKeys({ spaces = [], templates = {}, buckets = {}, vacay = null, photos = {} } = {}) {
  const keys = new Set([...STATIC_KEYS, ...vacayKeys(vacay)]);
  for (const entry of Array.isArray(spaces) ? spaces : []) {
    const id = entry?.ref?.s;
    if (!isId(id)) continue;
    for (const type of PRIVATE_TYPES) keys.add(`me:priv:${id}:${type}`);
    keys.add(`me:seen:${id}`);
    keys.add(`me:photos:${id}`);
  }
  for (const id of Object.keys(plainObject(photos) ? photos : {})) if (isId(id)) keys.add(`me:photos:${id}`);
  for (const id of Object.keys(plainObject(templates) ? templates : {})) if (isId(id)) keys.add(`me:tpl:${id}`);
  for (const id of Object.keys(plainObject(buckets) ? buckets : {})) if (isId(id)) keys.add(`me:bucket:${id}`);
  return [...keys].filter((key) => !SECRET.test(key));
}

/** Reads personal KV values directly, so worker, vault and private-item keys are included as stored. */
export async function readPersonal(puter) {
  const get = async (key) => { const value = await puter.kv.get(key); return value === undefined ? null : value; };
  const spaces = await get('me:spaces');
  const templates = await get('me:tpls');
  const buckets = await get('me:buckets');
  const vacay = await get(VACAY_INDEX);
  const photos = await get('me:photos');
  const keys = personalKeys({ spaces: spaces ?? [], templates: templates ?? {}, buckets: buckets ?? {}, vacay, photos: photos ?? {} });
  const known = { 'me:spaces': spaces, 'me:tpls': templates, 'me:buckets': buckets, [VACAY_INDEX]: vacay, 'me:photos': photos };
  const values = await pool(keys, 6, (key) => (Object.hasOwn(known, key) ? known[key] : get(key)));
  const out = {};
  keys.forEach((key, index) => { if (values[index] !== null) out[key] = values[index]; });
  return out;
}

const dirName = (kind, title, id) => `spaces/${kind}-${slug(title, kind)}-${id}`;
const fileName = (id, name) => `${id}-${String(name ?? 'file').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').slice(-120)}`;
const STORED = /\.(jpe?g|png|gif|webp|avif|heic|heif|pdf|zip|gz|docx|xlsx|pkpass|pkpasses|mp4|mov|webm)$/i;

/**
 * Collects everything and returns `{blob, name, summary}`. `api` and `worker` (the account's own worker name) are
 * optional: without them only personal data is exported. `onProgress({stage, done, total})` reports
 * personal|spaces|files|zip. `summary`: `{spaces, files, skippedFiles, failed: [{space, code}], spacesIncluded}`.
 */
export async function exportAllData({ puter, api = null, worker = null, account = {}, includeFiles = false, readme = '', onProgress = () => {}, signal, now = new Date() }) {
  const entries = {};
  const json = (value) => [strToU8(JSON.stringify(value, null, 2)), { level: 6 }];
  const aborted = () => { if (signal?.aborted) throw new IoError('aborted'); };
  onProgress({ stage: 'personal', done: 0, total: 1 });
  const personal = await readPersonal(puter);
  aborted();
  entries['personal.json'] = json({ format: PERSONAL_FORMAT, version: 1, exportedAt: now.toISOString(), account: { uuid: account.uuid ?? null, username: account.username ?? null }, keys: personal, notIncluded: UNINDEXED_KEYS });
  const summary = { spaces: 0, files: 0, skippedFiles: [], failed: [], spacesIncluded: Boolean(api && worker) };
  if (api && worker) {
    const listed = await api.request(worker, JSON.stringify({ op: 'space.list' }));
    const spaces = (listed?.spaces ?? []).filter((item) => isId(item?.id));
    let fileBytes = 0;
    for (const [index, item] of spaces.entries()) {
      aborted();
      onProgress({ stage: 'spaces', done: index, total: spaces.length });
      let raw;
      try { raw = await api.request(worker, JSON.stringify({ op: 'space.export', space: item.id }), { binary: true }); }
      catch (error) { summary.failed.push({ space: item.id, code: error?.code ?? 'unknown' }); continue; }
      const privateItems = {};
      for (const type of PRIVATE_TYPES) {
        const stored = personal[`me:priv:${item.id}:${type}`];
        if (plainObject(stored)) privateItems[type] = Object.values(stored);
      }
      const data = fromWorkerExport(raw, { uid: account.uuid, privateItems });
      const title = data.meta?.title ?? data.meta?.name ?? '';
      const dir = dirName(data.kind, title, item.id);
      entries[`${dir}/${data.kind}.json`] = json(data);
      summary.spaces += 1;
      if (!includeFiles) continue;
      const ref = { w: worker, s: item.id, k: data.kind };
      const files = (data.entities.file ?? []).filter((file) => !file.trashed && Number.isSafeInteger(file.size));
      for (const [fileIndex, file] of files.entries()) {
        aborted();
        onProgress({ stage: 'files', done: fileIndex, total: files.length, space: index + 1, spaces: spaces.length });
        if (fileBytes + file.size > IO_LIMITS.dataFileBytes) { summary.skippedFiles.push({ space: item.id, file: file.id, name: file.name, reason: 'limit' }); continue; }
        try {
          const blob = await api.download(ref, file.id, { signal });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          fileBytes += bytes.length;
          const name = fileName(file.id, file.name);
          entries[`${dir}/files/${name}`] = [bytes, { level: STORED.test(name) ? 0 : 6 }];
          summary.files += 1;
        } catch (error) {
          if (error?.code === 'aborted') throw new IoError('aborted');
          summary.skippedFiles.push({ space: item.id, file: file.id, name: file.name, reason: error?.code ?? 'unknown' });
        }
      }
    }
    onProgress({ stage: 'spaces', done: spaces.length, total: spaces.length });
  }
  if (readme) entries['README.txt'] = [strToU8(readme), { level: 6 }];
  aborted();
  onProgress({ stage: 'zip', done: 0, total: 1 });
  const bytes = zipSync(entries, { mtime: now });
  return { blob: new Blob([bytes], { type: 'application/zip' }), name: `trips-data-${stamp(now)}.zip`, summary };
}
