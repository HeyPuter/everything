import { LIMITS } from '../../shared/limits.js';
import { isId, isUuid } from '../../shared/ids.js';

// Non-media trip attachments kept as blobs in Cache Storage, one cache per account. Keys are synthetic same-origin
// URLs that are never fetched.
const MEDIA = /^(?:image|video|audio)\//i;
const PREFIX = 'offline-files/';

export const fileCacheName = (account) => {
  if (!isUuid(account)) throw new TypeError('invalid_account');
  return `trips-files-${account}`;
};
const base = () => new URL('./', globalThis.document?.baseURI ?? globalThis.location?.href ?? 'https://trips.invalid/');
const keyOf = (ref, file) => new URL(`${PREFIX}${ref.w}/${ref.s}/${file.id}?sha=${file.sha256}`, base()).href;
const tripPrefix = (ref) => new URL(`${PREFIX}${ref.w}/${ref.s}/`, base()).href;

/** Files kept offline: live user attachments that are not media and fit the proxied size limit. */
export function cacheable(file) {
  return Boolean(file) && isId(file.id) && file.kind === 'user' && !file.trashed && typeof file.mime === 'string' && !MEDIA.test(file.mime)
    && Number.isSafeInteger(file.size) && file.size > 0 && file.size <= LIMITS.fileBytes && /^[0-9a-f]{64}$/.test(file.sha256 ?? '');
}

/** The cached copy of a trip file, or null. Views can call this before downloading. */
export async function readCachedFile({ account, ref, file, caches: storage = globalThis.caches }) {
  if (!storage || !cacheable(file)) return null;
  try {
    const cache = await storage.open(fileCacheName(account));
    const hit = await cache.match(keyOf(ref, file));
    return hit ? await hit.blob() : null;
  } catch { return null; }
}

export async function storeFile({ account, ref, file, blob, caches: storage = globalThis.caches }) {
  if (!storage || !cacheable(file) || !(blob instanceof Blob)) return false;
  const cache = await storage.open(fileCacheName(account));
  await cache.put(keyOf(ref, file), new Response(blob, { headers: { 'content-type': file.mime, 'content-length': String(blob.size) } }));
  return true;
}

/**
 * Brings one trip's cached files in line with `files`: downloads missing ones through `download(ref, file, {signal})`
 * (a Blob) and removes copies of files that are gone, trashed or changed. Resolves `{count, bytes, failed}`.
 */
export async function syncTripFiles({ account, ref, files, download, signal, caches: storage = globalThis.caches, onProgress = () => {} }) {
  const cache = await storage.open(fileCacheName(account));
  const wanted = new Map(files.filter(cacheable).map((file) => [keyOf(ref, file), file]));
  const prefix = tripPrefix(ref);
  for (const request of await cache.keys()) if (request.url.startsWith(prefix) && !wanted.has(request.url)) await cache.delete(request);
  const result = { count: 0, bytes: 0, failed: 0 };
  let done = 0;
  for (const [key, file] of wanted) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (await cache.match(key)) { result.count++; result.bytes += file.size; }
    else if (typeof download === 'function') {
      try {
        const blob = await download(ref, file, { signal });
        if (!(blob instanceof Blob) || blob.size !== file.size) throw new Error('file_mismatch');
        await cache.put(key, new Response(blob, { headers: { 'content-type': file.mime, 'content-length': String(blob.size) } }));
        result.count++; result.bytes += blob.size;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        result.failed++;
      }
    }
    onProgress({ done: ++done, total: wanted.size });
  }
  return result;
}

export async function dropTripFiles({ account, ref, caches: storage = globalThis.caches }) {
  if (!storage) return;
  const cache = await storage.open(fileCacheName(account));
  const prefix = tripPrefix(ref);
  for (const request of await cache.keys()) if (request.url.startsWith(prefix)) await cache.delete(request);
}
