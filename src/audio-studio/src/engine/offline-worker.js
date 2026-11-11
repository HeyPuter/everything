// Offline renderer worker: runs the same mixing core and WASM effect chains as
// realtime playback, as fast as possible. Sample chunks are pulled from the
// main thread on demand, so memory stays bounded for long sessions.
//
// in:  { type: 'render', id, graph, start, end, module, block }
//      { type: 'chunk', key, index, channels }     reply to 'need'
//      { type: 'cancel', id }
// out: { type: 'need', id, key, index }
//      { type: 'data', id, at, channels }  rendered output, in order ([L, R], or six channels for a 5.1 graph)
//      { type: 'progress', id, done, total }
//      { type: 'done', id } | { type: 'error', id, message }

import { ChunkStore, renderBlock, createScratch, CHUNK } from './mixcore.js';
import { FxHost } from './fxhost.js';

const jobs = new Map();

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'render') run(m).catch((err) => self.postMessage({ type: 'error', id: m.id, message: String(err?.message || err) }));
  else if (m.type === 'chunk') {
    const job = jobs.get(m.id);
    if (!job) return;
    job.store.put(m.key, m.index, m.channels);
    const waiter = job.waiting.get(`${m.key}#${m.index}`);
    if (waiter) {
      job.waiting.delete(`${m.key}#${m.index}`);
      waiter();
    }
  } else if (m.type === 'cancel') {
    const job = jobs.get(m.id);
    if (job) job.cancelled = true;
  }
};

async function run({ id, graph, start, end, module, block = 8192 }) {
  const job = { store: new ChunkStore(), waiting: new Map(), cancelled: false };
  jobs.set(id, job);
  try {
    let host = null;
    if (module) {
      host = new FxHost(new WebAssembly.Instance(module, {}), graph.rate);
      for (const t of graph.tracks) {
        t.fx = host.sync(t.fx);
        for (const c of t.clips) if (c.fx) c.fx = host.sync(c.fx);
      }
      if (graph.master) graph.master.fx = host.sync(graph.master.fx);
    } else {
      for (const t of graph.tracks) t.fx = [];
    }
    const scratch = createScratch(block);
    const total = end - start;
    let lastProgress = 0;
    for (let at = start; at < end; at += block) {
      if (job.cancelled) throw new Error('cancelled');
      const n = Math.min(block, end - at);
      await ensureChunks(id, job, graph, at, n);
      const out = Array.from({ length: graph.surround ? 6 : 2 }, () => new Float32Array(n));
      renderBlock(graph, job.store, at, n, out, scratch, { runFx: host ? (chain, buf, f) => host.run(chain, buf, f) : null });
      self.postMessage({ type: 'data', id, at: at - start, channels: out }, out.map((c) => c.buffer));
      dropBehind(job, graph, at);
      const done = at + n - start;
      if (done - lastProgress > total / 50 || done === total) {
        lastProgress = done;
        self.postMessage({ type: 'progress', id, done, total });
      }
    }
    self.postMessage({ type: 'done', id });
  } finally {
    jobs.delete(id);
  }
}

/** Requests every source chunk the next block needs and waits for them. */
function ensureChunks(id, job, graph, at, n) {
  const waits = [];
  for (const track of graph.tracks) {
    for (const clip of track.clips) {
      if (clip.mute) continue;
      const a = Math.max(at, clip.start);
      const b = Math.min(at + n, clip.start + clip.length);
      if (b <= a) continue;
      const s0 = clip.offset + (a - clip.start);
      const s1 = clip.offset + (b - clip.start);
      for (let i = Math.floor(s0 / CHUNK); i <= Math.floor((s1 - 1) / CHUNK); i++) {
        const k = `${clip.source}#${i}`;
        if (job.store.sources.get(clip.source)?.has(i) || job.waiting.has(k)) {
          if (job.waiting.has(k)) waits.push(new Promise((r) => {
            const prev = job.waiting.get(k);
            job.waiting.set(k, () => {
              prev();
              r();
            });
          }));
          continue;
        }
        waits.push(new Promise((r) => job.waiting.set(k, r)));
        self.postMessage({ type: 'need', id, key: clip.source, index: i });
      }
    }
  }
  return Promise.all(waits);
}

/**
 * Frees chunks no clip playing at `at` reads around its position. A source
 * shared by several clips keeps the chunks of each, so a clip that already
 * ended (or one further along) no longer discards chunks another still needs.
 */
export function dropBehind(job, graph, at) {
  const keep = new Map();
  for (const track of graph.tracks) {
    for (const clip of track.clips) {
      if (clip.mute || at < clip.start || at >= clip.start + clip.length) continue;
      const pos = clip.offset + (at - clip.start);
      let set = keep.get(clip.source);
      if (!set) keep.set(clip.source, (set = new Set()));
      for (let i = Math.max(0, Math.floor(pos / CHUNK) - 1); i <= Math.floor(pos / CHUNK) + 1; i++) set.add(i);
    }
  }
  for (const [key, src] of job.store.sources) {
    const set = keep.get(key);
    for (const index of [...src.keys()]) if (!set?.has(index)) src.delete(index);
  }
}
