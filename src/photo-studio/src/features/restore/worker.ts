/// <reference lib="webworker" />
// Portrait & Restore worker: keeps the source as a pyramid, named extras
// (AI results, depth layers) and a cache of intermediate results, and renders
// the filter stack at a requested level. A newer run supersedes an older one
// at the next stage boundary, so the cache survives slider drags.
import { runRestore } from '../../imaging/restore/pipeline';
import { resizeMask, resizeRGBA } from '../../imaging/restore/util';
import { CancelledError, type Mask8, type RGBA8 } from '../../imaging/types';
import type { FromRestoreWorker, ToRestoreWorker } from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: FromRestoreWorker, transfer: Transferable[] = []) => scope.postMessage(m, transfer);

let levels: RGBA8[] = [];
let sel0: Mask8 | undefined;
const selLevels = new Map<number, Mask8>();
const aux = new Map<string, RGBA8>();
const auxLevels = new Map<string, RGBA8>();
let latest = 0;

const half = (n: number) => Math.max(1, Math.ceil(n / 2));
function level(k: number): RGBA8 {
  while (levels.length <= k) {
    const p = levels[levels.length - 1];
    levels.push(resizeRGBA(p, half(p.width), half(p.height)));
  }
  return levels[k];
}
function selLevel(k: number): Mask8 | undefined {
  if (!sel0) return undefined;
  let m = selLevels.get(k);
  if (!m) {
    const img = level(k);
    m = k === 0 ? sel0 : resizeMask(sel0, img.width, img.height);
    selLevels.set(k, m);
  }
  return m;
}
function auxAt(name: string, k: number): RGBA8 | undefined {
  const a = aux.get(name);
  if (!a) return undefined;
  const img = level(k);
  const key = `${name}@${k}`;
  let out = auxLevels.get(key);
  if (!out) {
    out = resizeRGBA(a, img.width, img.height);
    auxLevels.set(key, out);
  }
  return out;
}

// Results cache, bounded by memory: least recently used entries go first.
// Rejected promises (cancelled stages) are removed so they are computed again.
type Entry = { value: unknown; bytes: number };
const cache = new Map<string, Entry>();
const BUDGET = 320 * 1024 * 1024;
let total = 0;
function sizeOf(v: unknown, depth = 0): number {
  if (!v || typeof v !== 'object' || depth > 3) return 0;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  let s = 0;
  for (const x of Object.values(v)) s += sizeOf(x, depth + 1);
  return s;
}
function evict() {
  while (total > BUDGET && cache.size > 1) {
    const [k, e] = cache.entries().next().value!;
    cache.delete(k);
    total -= e.bytes;
  }
}
function memo<T>(key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.value as T;
  }
  const value = make();
  const entry: Entry = { value, bytes: 0 };
  cache.set(key, entry);
  const account = (v: unknown) => {
    if (cache.get(key) !== entry) return;
    entry.bytes = sizeOf(v);
    total += entry.bytes;
    evict();
  };
  if (value instanceof Promise)
    value.then(account, () => {
      if (cache.get(key) === entry) cache.delete(key);
    });
  else account(value);
  return value;
}
function clearCache() {
  cache.clear();
  total = 0;
}

scope.onmessage = async (ev: MessageEvent<ToRestoreWorker>) => {
  const m = ev.data;
  if (m.type === 'load') {
    levels = [m.image];
    sel0 = m.selection;
    selLevels.clear();
    clearCache();
    auxLevels.clear();
    return;
  }
  if (m.type === 'aux') {
    if (m.image) aux.set(m.name, m.image);
    else aux.delete(m.name);
    for (const k of [...auxLevels.keys()]) if (k.startsWith(`${m.name}@`)) auxLevels.delete(k);
    return;
  }
  const job = m.job;
  latest = job;
  try {
    if (!levels.length) throw new Error('The source is not loaded.');
    const k = Math.max(0, m.level);
    const src = level(k);
    const scale = src.width / levels[0].width;
    let last = 0;
    const out = await runRestore(
      src,
      m.params,
      {
        scale,
        selection: selLevel(k),
        aux: (name) => auxAt(name, k),
        full: k > 0 ? () => levels[0] : undefined,
        memo,
        overlay: m.overlay,
        affected: m.affected,
        seed: 7,
        yield: () => new Promise((r) => setTimeout(r, 0)),
      },
      {
        cancelled: () => latest !== job,
        report: (f) => {
          const now = performance.now();
          if (now - last < 80 && f < 1) return;
          last = now;
          post({ type: 'progress', job, value: f });
        },
      },
    );
    if (latest !== job) throw new CancelledError();
    const source = m.source ? { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) } : undefined;
    const transfer: Transferable[] = [out.image.data.buffer];
    if (out.overlay) out.overlay = { ...out.overlay, data: new Uint8Array(out.overlay.data) };
    if (out.overlay) transfer.push(out.overlay.data.buffer);
    if (out.affected) transfer.push(out.affected.data.buffer);
    if (source) transfer.push(source.data.buffer);
    post({ type: 'done', job, image: out.image, overlay: out.overlay, affected: out.affected, source }, transfer);
  } catch (error) {
    const cancelled = error instanceof Error && error.name === 'CancelledError';
    post({ type: 'error', job, message: error instanceof Error ? error.message : String(error), cancelled });
  }
};
