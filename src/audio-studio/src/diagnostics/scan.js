// Diagnostics: scanning a range for problems and acting on the ones found.
//
// Scans stream the audio in blocks (with overlap for click and clip
// detection) through the diagnostics worker, so the main thread stays free
// and no whole-file copies are made. Results are problem lists:
//   { id, start, end, channels: number[], level, kind }
// with times in file frames. `level` is dBFS for clips, silence and audio,
// and the click strength (residual peak over its local noise level) for clicks.
//
// Actions return a new document state (one undo step for the caller):
//   repairClicks / repairClips  rebuild the audio around each problem
//   deleteSilences              shortens each silence to the Delete Silence "keep" time
//   markAudio                   adds a range marker per audio region

import { dspModule, dsp } from '../audio/dsp.js';
import { ops, clickSettings } from './kernels.js';
import { detectionFloor, maxRunOf, strengthOf, coreLength } from '../effects/defs/click-thresholds.js';
import { findSilence, audioMarkers, detectionWindow } from '../effects/defs/special-silence.js';
import { deleteRange } from '../model/edits.js';
import { addMarkers } from '../effects/apply.js';

const BLOCK = 1 << 19;
const CONTEXT = 4096;
const HOLD = 2;
const HOLD_FLOOR_DB = -200;

let factory = typeof Worker !== 'undefined' ? () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }) : null;

/** Tests pass null to run kernels in place. */
export function setDiagnosticsWorker(f) {
  factory = f;
}

/** A kernel runner: run(op, args) => Promise<result>. close() ends its worker. */
export async function createRunner() {
  if (!factory) {
    const d = await dsp();
    return { run: async (op, args) => ops[op](d, args), close() {} };
  }
  const module = await dspModule();
  const worker = factory();
  let next = 1;
  const pending = new Map();
  let failed = null;
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error) p.reject(new Error(e.data.error));
    else p.resolve(e.data.result);
  };
  worker.onerror = (e) => {
    failed = new Error(e.message || 'Diagnostics failed');
    for (const p of pending.values()) p.reject(failed);
    pending.clear();
  };
  let sentModule = false;
  return {
    run(op, args) {
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => {
        const id = next++;
        pending.set(id, { resolve, reject });
        const transfer = args.samples?.buffer ? [args.samples.buffer] : [];
        worker.postMessage({ id, op, args, module: sentModule ? null : module }, transfer);
        sentModule = true;
      });
    },
    close() {
      worker.terminate();
      for (const p of pending.values()) p.reject(cancelled());
      pending.clear();
    },
  };
}

function cancelled() {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
}

const toDb = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity);

/** Merges per-channel runs [{ start, end, channel, level }] that overlap into problems. */
export function mergeRuns(runs, kind) {
  const sorted = runs.slice().sort((a, b) => a.start - b.start || a.channel - b.channel);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
      if (!last.channels.includes(r.channel)) last.channels.push(r.channel);
      last.level = Math.max(last.level, r.level);
    } else out.push({ start: r.start, end: r.end, channels: [r.channel], level: r.level, kind });
  }
  return out.map((p, i) => ({ id: `${kind}${i + 1}`, ...p, channels: p.channels.sort((a, b) => a - b) }));
}

/** Streams [start, end) of a channel in overlapping blocks: fn(samples, at, lo) per block. */
async function blocks(channel, start, end, fn, { context = CONTEXT, signal, onProgress } = {}) {
  for (let a = start; a < end; a += BLOCK) {
    if (signal?.aborted) throw cancelled();
    const lo = Math.max(start, a - context);
    const hi = Math.min(end, a + BLOCK + context);
    await fn(channel.toArray(lo, hi), a, lo, Math.min(end, a + BLOCK));
    onProgress?.(Math.min(1, (a + BLOCK - start) / Math.max(1, end - start)));
  }
}

/**
 * Scans frames [start, end) of Channel[] for the problems an effect finds.
 * effect: 'declicker' | 'declipper' | 'deleteSilence' | 'markAudio'; values
 * are that effect's full parameter values. Resolves { problems, info }.
 */
export async function scanProblems({ effect, values, channels, rate, start, end, signal, onProgress, runner }) {
  const own = !runner;
  runner = runner || (await createRunner());
  const abort = () => runner.close();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const nch = channels.length;
    const prog = (c) => (f) => onProgress?.((c + f) / nch);
    if (effect === 'declicker') {
      const s = clickSettings(values);
      const runs = [];
      for (let c = 0; c < nch; c++) {
        await blocks(channels[c], start, end, async (samples, a, lo, hi) => {
          const t = await runner.run('clicks', { samples, k: s.k, disc: s.disc, maxRun: s.maxRun, oversample: s.oversample });
          for (let i = 0; i < t.length; i += 3) {
            const at = lo + t[i];
            if (at < a || at >= hi) continue; // owned by the neighbouring block
            runs.push({ start: at, end: Math.min(end, at + t[i + 1]), channel: c, level: t[i + 2] / s.k });
          }
        }, { signal, onProgress: prog(c) });
      }
      return { problems: mergeRuns(runs, 'click'), info: {} };
    }
    if (effect === 'clickPop') {
      // Click/Pop Eliminator: everything above the Detect curve's floor, with
      // the strength (threshold scale) and the level around each click.
      const k = detectionFloor(values);
      const oversample = values.oversample / 100;
      const runs = [];
      for (let c = 0; c < nch; c++) {
        await blocks(channels[c], start, end, async (samples, a, lo, hi) => {
          const t = await runner.run('clickLevels', { samples, k, maxRun: maxRunOf(values), oversample });
          for (let i = 0; i < t.length; i += 4) {
            const at = lo + t[i];
            if (at < a || at >= hi) continue;
            runs.push({ start: at, end: Math.min(end, at + t[i + 1]), channel: c, level: strengthOf(t[i + 2]), db: t[i + 3], core: coreLength(t[i + 1], oversample) });
          }
        }, { signal, onProgress: prog(c) });
      }
      // Merged runs keep the loudest surroundings and the longest core.
      const merged = mergeRuns(runs, 'click');
      let r = 0;
      const sorted = runs.slice().sort((x, y) => x.start - y.start || x.channel - y.channel);
      for (const p of merged) {
        p.db = -Infinity;
        p.core = 0;
        while (r < sorted.length && sorted[r].start < p.end) {
          p.db = Math.max(p.db, sorted[r].db);
          p.core = Math.max(p.core, sorted[r].core);
          r++;
        }
      }
      return { problems: merged, info: {} };
    }
    if (effect === 'levels') {
      // Window levels for the Click/Pop Eliminator's threshold levels (50 ms windows).
      const win = Math.max(64, Math.round(rate * 0.05));
      const dbs = [];
      for (let c = 0; c < nch; c++) {
        await blocks(channels[c], start, end, async (samples, a, lo, hi) => {
          const t = await runner.run('levels', { samples: samples.subarray(a - lo, hi - lo), win });
          dbs.push(...t);
        }, { context: 0, signal, onProgress: prog(c) });
      }
      return { problems: [], info: { dbs } };
    }
    if (effect === 'declipper') {
      let peak = 0;
      for (let c = 0; c < nch; c++) {
        await blocks(channels[c], start, end, async (samples) => {
          peak = Math.max(peak, await runner.run('peak', { samples }));
        }, { context: 0, signal, onProgress: (f) => onProgress?.((c + f) / nch / 2) });
      }
      if (peak <= 0) return { problems: [], info: { level: 0 } };
      const level = peak * (1 - values.tolerance / 100) * 0.99999;
      const runs = [];
      for (let c = 0; c < nch; c++) {
        await blocks(channels[c], start, end, async (samples, a, lo, hi) => {
          const t = await runner.run('clips', { samples, level, minRun: values.minRun });
          for (let i = 0; i < t.length; i += 2) {
            const at = lo + t[i];
            if (at < a || at >= hi) continue;
            runs.push({ start: at, end: at + t[i + 1], channel: c, level: toDb(level) });
          }
        }, { context: 2048, signal, onProgress: (f) => onProgress?.(0.5 + (c + f) / nch / 2) });
      }
      return { problems: mergeRuns(runs, 'clip'), info: { level } };
    }
    if (effect === 'deleteSilence' || effect === 'markAudio') {
      const win = detectionWindow(rate);
      const len = end - start;
      const n = Math.ceil(len / win);
      const peak = new Float32Array(n);
      const block = Math.floor(BLOCK / win) * win;
      for (let c = 0; c < nch; c++) {
        for (let a = 0; a < len; a += block) {
          if (signal?.aborted) throw cancelled();
          const b = Math.min(len, a + block);
          const p = await runner.run('peaks', { samples: channels[c].toArray(start + a, start + b), win });
          const off = a / win;
          for (let i = 0; i < p.length; i++) if (p[i] > peak[off + i]) peak[off + i] = p[i];
          prog(c)(b / len);
        }
      }
      const db = holdDb(peak);
      const silences = findSilence(db, win, rate, len, values);
      const regions = effect === 'deleteSilence' ? silences : audioMarkers(silences, len, Math.round(((values.padding || 0) * rate) / 1000)).map((m) => [m.start, m.start + m.duration]);
      const problems = regions.map(([a, b], i) => ({ id: `${effect === 'deleteSilence' ? 'silence' : 'audio'}${i + 1}`, start: start + a, end: start + b, channels: channels.map((_, k) => k), level: maxDb(db, a, b, win), kind: effect === 'deleteSilence' ? 'silence' : 'audio' }));
      return { problems, info: { win } };
    }
    throw new Error(`Unknown diagnostic "${effect}".`);
  } finally {
    signal?.removeEventListener('abort', abort);
    if (own) runner.close();
  }
}

/** Window peaks to dB, held over neighbouring windows (as Delete Silence detects). */
export function holdDb(peak) {
  const n = peak.length;
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let k = Math.max(0, i - HOLD); k <= Math.min(n - 1, i + HOLD); k++) if (peak[k] > m) m = peak[k];
    db[i] = Math.max(HOLD_FLOOR_DB, 20 * Math.log10(m));
  }
  return db;
}

function maxDb(db, a, b, win) {
  let m = -Infinity;
  for (let i = Math.floor(a / win); i < Math.min(db.length, Math.ceil(b / win)); i++) if (db[i] > m) m = db[i];
  // holdDb floors digital silence at -200 dB; report it as -Infinity.
  return m <= HOLD_FLOOR_DB ? -Infinity : m;
}

// ----------------------------------------------------------------- actions

/**
 * Rebuilds the audio around each problem with a windowed kernel: the window
 * gives the kernel context, and only the problem (plus `pad`) is written back.
 */
async function repairWindows(state, problems, { op, args, pad, context, runner, signal, onProgress }) {
  let channels = state.channels.slice();
  const len = channels[0].length;
  for (let i = 0; i < problems.length; i++) {
    if (signal?.aborted) throw cancelled();
    const p = problems[i];
    const lo = Math.max(0, p.start - context);
    const hi = Math.min(len, p.end + context);
    const a = Math.max(lo, p.start - pad);
    const b = Math.min(hi, p.end + pad);
    for (const c of p.channels) {
      if (c >= channels.length) continue;
      const fixed = await runner.run(op, { ...args, samples: channels[c].toArray(lo, hi) });
      channels[c] = channels[c].write(a, fixed.subarray(a - lo, b - lo));
    }
    onProgress?.((i + 1) / problems.length);
  }
  return { ...state, channels };
}

/** Repairs the given click problems with the DeClicker settings. */
export async function repairClicks(state, problems, values, { runner, signal, onProgress } = {}) {
  const own = !runner;
  runner = runner || (await createRunner());
  try {
    const s = clickSettings(values);
    return await repairWindows(state, problems, { op: 'declick', args: { k: s.k, disc: s.disc, maxRun: s.maxRun, oversample: s.oversample, passes: s.passes }, pad: 8, context: 2048, runner, signal, onProgress });
  } finally {
    if (own) runner.close();
  }
}

/** Rebuilds each problem's range exactly (Click/Pop Eliminator repairs and Fill Single Click). */
export async function fillProblems(state, problems, { runner, signal, onProgress } = {}) {
  const own = !runner;
  runner = runner || (await createRunner());
  try {
    let channels = state.channels.slice();
    const len = channels[0].length;
    const context = 2048;
    for (let i = 0; i < problems.length; i++) {
      if (signal?.aborted) throw cancelled();
      const p = problems[i];
      const lo = Math.max(0, p.start - context);
      const hi = Math.min(len, p.end + context);
      for (const c of p.channels) {
        if (c >= channels.length) continue;
        const fixed = await runner.run('fill', { samples: channels[c].toArray(lo, hi), start: p.start - lo, len: p.end - p.start });
        channels[c] = channels[c].write(p.start, fixed.subarray(p.start - lo, p.end - lo));
      }
      onProgress?.((i + 1) / problems.length);
    }
    return { ...state, channels };
  } finally {
    if (own) runner.close();
  }
}

/**
 * Repairs the given clipped runs at the scan's clip `level`, then applies
 * the DeClipper gain to [start, end) so restored peaks have headroom.
 */
export async function repairClips(state, problems, values, level, range, { runner, signal, onProgress } = {}) {
  const own = !runner;
  runner = runner || (await createRunner());
  try {
    let next = await repairWindows(state, problems, { op: 'declip', args: { level, minRun: values.minRun, method: values.method }, pad: 0, context: 1024, runner, signal, onProgress });
    const g = Math.pow(10, (values.gain || 0) / 20);
    if (g !== 1 && range) {
      const [a, b] = range;
      next = {
        ...next,
        channels: next.channels.map((ch) => {
          let out = ch;
          for (let at = a; at < b; at += BLOCK) {
            const block = ch.toArray(at, Math.min(b, at + BLOCK));
            for (let k = 0; k < block.length; k++) block[k] *= g;
            out = out.write(at, block);
          }
          return out;
        }),
      };
    }
    return next;
  } finally {
    if (own) runner.close();
  }
}

/** Frames removed from each silence when shortening it to `keep` frames (half kept on each side). */
export function silenceCut(p, keep, len) {
  const half = Math.floor(keep / 2);
  const s = p.start === 0 ? 0 : p.start + half;
  const e = p.end === len ? len : p.end - (keep - half);
  return e > s ? [s, e] : null;
}

/**
 * Shortens the given silences to `keepMs` (the start and end of the file
 * lose their silence entirely). Returns { state, removed: [[s, e)] } with
 * markers after each cut shifted by deleteRange.
 */
export function deleteSilences(state, problems, keepMs) {
  const len = state.channels[0].length;
  const keep = Math.round((keepMs * state.sampleRate) / 1000);
  const cuts = problems.map((p) => silenceCut(p, keep, len)).filter(Boolean).sort((a, b) => b[0] - a[0]);
  let next = state;
  for (const [s, e] of cuts) next = deleteRange(next, s, e, null);
  return { state: next, removed: cuts.reverse() };
}

/** Moves problem times left by the frames removed before them; drops the deleted ones. */
export function shiftProblems(problems, removed, deletedIds) {
  const gone = new Set(deletedIds);
  return problems
    .filter((p) => !gone.has(p.id))
    .map((p) => {
      let shift = 0;
      for (const [s, e] of removed) if (e <= p.start) shift += e - s;
      return { ...p, start: p.start - shift, end: p.end - shift };
    });
}

/** Adds a range marker for each problem (or audio region), named "<prefix> NN". */
export function markProblems(state, problems, prefix = 'Audio') {
  const existing = state.markers.length;
  const markers = problems.map((p, i) => ({ start: p.start, duration: Math.max(1, p.end - p.start), name: `${prefix} ${String(existing + i + 1).padStart(2, '0')}`, type: 'cue' }));
  return addMarkers(state, 0, markers);
}

/** Adds a range marker for each audio region. */
export function markAudio(state, problems) {
  return markProblems(state, problems, 'Audio');
}
