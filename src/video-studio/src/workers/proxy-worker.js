/**
 * Proxy media encoding off the main thread (see media/proxy.js). Writes the
 * proxy straight into the local cache (OPFS) when the browser allows it in
 * workers, so even long files never sit in memory; otherwise the proxy comes
 * back as a Blob for the page to store.
 *
 * Messages in:  { id, op: 'proxy', blob, plan, root, dir, base, tolerance }
 *               { id, op: 'cancel', target }
 * Messages out: { id, partial: { progress } }
 *               { id, ok, result: { name, size, codec, blob? } } | { id, ok: false, error, code }
 */
import {
  Input, BlobSource, ALL_FORMATS, Output, BufferTarget, StreamTarget, Mp4OutputFormat, WebMOutputFormat, Conversion,
  getFirstEncodableVideoCodec,
} from 'mediabunny';
import { generateProxy, checkProxy } from '../media/proxy.js';

const mb = { Input, BlobSource, ALL_FORMATS, Output, BufferTarget, StreamTarget, Mp4OutputFormat, WebMOutputFormat, Conversion, getFirstEncodableVideoCodec };

const running = new Map(); // id -> AbortController

/**
 * A writable "<name>.part" file in the cache folder, or null when OPFS writes
 * are not available here. Mediabunny closes the stream itself when it is
 * done or canceled (closing commits it), so the file only gets its real name
 * once it is complete and checked; leftover .part files are cleared on start.
 */
async function openFile(root, dir, name) {
  try {
    const top = await navigator.storage.getDirectory();
    const folder = await (await top.getDirectoryHandle(root, { create: true })).getDirectoryHandle(dir, { create: true });
    const part = `${name}.part`;
    const handle = await folder.getFileHandle(part, { create: true });
    if (typeof handle.createWritable !== 'function' || typeof handle.move !== 'function') {
      await folder.removeEntry(part).catch(() => {});
      return null;
    }
    return { folder, handle, part, writable: await handle.createWritable() };
  } catch {
    return null;
  }
}

async function makeProxy(id, { blob, plan, root, dir, base, tolerance }) {
  const ctrl = new AbortController();
  running.set(id, ctrl);
  let file = null;
  let name = null;
  let lastSent = -1;
  const onProgress = (p) => {
    // A message per percent is plenty.
    const pct = Math.floor(p * 100);
    if (pct === lastSent) return;
    lastSent = pct;
    self.postMessage({ id, partial: { progress: p } });
  };
  const open = async (ext) => {
    name = `${base}.${ext}`;
    file = await openFile(root, dir, name);
    return file?.writable || null;
  };
  try {
    const out = await generateProxy({ blob, plan, open, onProgress, signal: ctrl.signal, mb });
    if (!file) {
      await checkProxy(mb, out.blob, plan, tolerance);
      return { name, size: out.blob.size, codec: out.codec, width: out.width, height: out.height, blob: out.blob };
    }
    const written = await file.handle.getFile();
    await checkProxy(mb, written, plan, tolerance);
    if (ctrl.signal.aborted) throw Object.assign(new Error('Canceled'), { code: 'canceled' });
    await file.handle.move(name);
    file = null;
    return { name, size: written.size, codec: out.codec, width: out.width, height: out.height };
  } finally {
    running.delete(id);
    // Failed or canceled: drop the partial file (once Mediabunny has let go of it).
    if (file) {
      const { folder, part } = file;
      await file.writable.abort?.().catch(() => {});
      await folder.removeEntry(part).catch(() => setTimeout(() => folder.removeEntry(part).catch(() => {}), 1000));
    }
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.op === 'cancel') {
    running.get(msg.target)?.abort();
    return;
  }
  if (msg.op !== 'proxy') return;
  try {
    const result = await makeProxy(msg.id, msg);
    self.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String(err?.message || err), code: err?.code || (err?.name === 'ConversionCanceledError' ? 'canceled' : '') });
  }
};
