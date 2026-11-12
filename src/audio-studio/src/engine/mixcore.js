// Mixing core shared by the realtime AudioWorklet and offline rendering. It has
// no DOM or Web Audio dependencies: it mixes clips from chunked sources through
// per-track gain, pan, envelopes and effect chains into a stereo master.
//
// Graph shape (all times in frames at the graph rate):
//   { rate, master: { gain, fx }, tracks: [
//       { id, gain, pan, mute, solo, volumeEnv?, panEnv?, fx?: [slot],
//         bus?, output?, sends?: [{ target, gain, pan, pre }], soloSafe?, mono?,
//         clips: [{ id, source, channels, start, offset, length, gain,
//                   fadeIn, fadeInCurve, fadeOut, fadeOutCurve, mute, gainEnv?,
//                   panEnv?, base?, full?, fx?: [slot], fxTail? }] } ] }
// `source` is a key into the chunk store: chunk i holds source frames
// [i * CHUNK, (i + 1) * CHUNK) as one Float32Array per channel.
//
// Routing: a track with `output` set to the id of a `bus` track mixes into
// that bus instead of the master; buses render after their inputs (and a bus
// feeding another bus before it). `sends` feed extra copies of a track to
// buses: `pre` sends tap the track after its effects but before its volume
// and pan, post sends after them; each send has its own gain and a balance
// pan. Soloing a bus keeps its inputs audible, and soloing a track keeps the
// buses it feeds (by output or send) audible. `soloSafe` tracks (the
// metronome) ignore solo. A `mono` track (a mono bus) sums its input to mono
// before its effects and pan. A clip's `base` and `full` place a segment inside a
// longer clip (looped or partly hidden clips) so fades and envelopes line up:
// fades and envelopes are evaluated at frame `base + t` of a clip `full` long.
// A clip `panEnv` ([{ t, v }] with v in -1..1) pans the clip with the graph's pan law.
// Pan law: `graph.panLaw` = { mode: 'balance' } (default: centre is unity on
// both sides, the far side fades out) or { mode: 'equalPower', centerDb }
// (sin/cos curves raised so the centre sits at centerDb, -3 dB being
// constant power; hard pan leaves one side at unity).
// A clip `fx` chain (Sound Assistant) processes the clip on its own before it
// joins the track: segments sharing a clip id mix into one per-clip buffer,
// the chain runs once per block, and it keeps running `fxTail` frames past
// the clip's end so reverb tails ring out.
//
// 5.1 surround: with `graph.surround` the master is 6 channels (L, R, C, LFE,
// Ls, Rs; see surround.js) and renderBlock needs 6 master buffers. Tracks
// with `six` carry 6 channels end to end (5.1 audio tracks read 6-channel
// sources, stereo ones into L/R and mono ones into C; 5.1 buses collect
// their inputs in 6 channels). Mono and stereo tracks keep their effects and
// are placed in the field by their `surround` panner settings, instead of
// the stereo pan, when they feed the master or a 5.1 bus. Effect chains on
// 6-channel tracks and on a 5.1 master run only their surround-capable slots
// (specs with `channels: 6`, e.g. Surround Reverb; the other effects are
// stereo and left out), sends from 5.1 tracks are skipped, and sends into a 5.1 bus feed its front
// pair. A 6-channel track routed to a stereo bus is downmixed.

import { surroundMatrix, channelMap } from './surround.js';

export const CHUNK = 32768;
export const QUANTUM = 128;

/** Evaluates a breakpoint envelope [{ t, v }] (sorted by t) at frame t. */
export function envelopeAt(points, t, fallback = 1) {
  if (!points || !points.length) return fallback;
  if (t <= points[0].t) return points[0].v;
  const last = points[points.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t || 1);
}

/**
 * Writes envelopeAt(points, pos + i, fallback) for i in [0, frames) into `out`
 * (walking the breakpoints once instead of searching per frame). Returns `out`.
 */
export function envelopeFill(points, pos, frames, out, fallback = 1) {
  if (!points || !points.length) {
    out.fill(fallback, 0, frames);
    return out;
  }
  const last = points.length - 1;
  // j: the first breakpoint after the current frame.
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= pos) lo = mid + 1;
    else hi = mid;
  }
  // One segment at a time: before the first breakpoint, between two, or after the last.
  let j = lo;
  let i = 0;
  while (i < frames) {
    const end = j <= last ? Math.min(frames, Math.ceil(points[j].t - pos)) : frames;
    if (j === 0 || j > last) out.fill(points[j === 0 ? 0 : last].v, i, end);
    else {
      const a = points[j - 1];
      const b = points[j];
      const slope = (b.v - a.v) / (b.t - a.t);
      for (let k = i; k < end; k++) out[k] = a.v + slope * (pos + k - a.t);
    }
    i = end;
    while (j <= last && points[j].t <= pos + i) j++;
  }
  return out;
}

/**
 * Per-frame values of an envelope over the block [pos, pos + frames) (in
 * scratch buffer `i`), or null when no breakpoint falls inside it: the
 * envelope is then one straight line from envelopeAt(pos) to
 * envelopeAt(pos + frames), which callers interpolate themselves. Evaluating
 * breakpoints inside a block keeps automation exact whatever the block size
 * (a mixdown renders 8192-frame blocks, playback 128).
 */
function envelopeFrames(points, pos, frames, scratch, i, fallback) {
  if (!points || !points.length) return null;
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= pos) lo = mid + 1;
    else hi = mid;
  }
  if (lo === points.length || points[lo].t >= pos + frames) return null;
  if (!scratch.env || scratch.env[0].length < frames) scratch.env = [0, 1].map(() => new Float32Array(Math.max(frames, scratch.gains.length)));
  return envelopeFill(points, pos, frames, scratch.env[i], fallback);
}

/** Fade gain for position x in [0, 1] with curve (0 linear, + log, - exp, 2 = cosine). */
export function fadeShape(x, curve = 0) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (curve === 2) return 0.5 - 0.5 * Math.cos(Math.PI * x);
  if (curve === 0) return x;
  if (curve > 0) return Math.pow(x, 1 / (1 + curve * 3));
  return Math.pow(x, 1 - curve * 3);
}

/** Exponent that puts the equal-power centre at `centerDb` (cos(pi/4)^k = centerDb). */
function powerExponent(centerDb) {
  const db = Number.isFinite(centerDb) ? Math.max(-12, Math.min(-0.5, centerDb)) : -3;
  return db / (20 * Math.log10(Math.SQRT1_2));
}

/**
 * Left and right gains for pan p in [-1, 1] under `law` (see the header).
 * Returns [l, r]; `out` is reused when given.
 */
export function panGains(p, law, out = [1, 1]) {
  if (law && law.mode === 'equalPower') {
    const k = law.k ?? powerExponent(law.centerDb);
    const th = ((Math.max(-1, Math.min(1, p)) + 1) * Math.PI) / 4;
    out[0] = Math.pow(Math.max(0, Math.cos(th)), k);
    out[1] = Math.pow(Math.max(0, Math.sin(th)), k);
    return out;
  }
  out[0] = p > 0 ? 1 - p : 1;
  out[1] = p < 0 ? 1 + p : 1;
  return out;
}

/** The graph's pan law with its exponent precomputed (cached per graph). */
function lawOf(graph) {
  const law = graph.panLaw;
  if (!law || law.mode !== 'equalPower') return null;
  if (law.k === undefined) law.k = powerExponent(law.centerDb);
  return law;
}

export class ChunkStore {
  constructor() {
    /** source key -> Map(chunk index -> Float32Array[]) */
    this.sources = new Map();
  }

  put(key, index, channels) {
    let m = this.sources.get(key);
    if (!m) this.sources.set(key, (m = new Map()));
    m.set(index, channels);
  }

  drop(key, index) {
    const m = this.sources.get(key);
    if (!m) return;
    if (index === undefined) this.sources.delete(key);
    else m.delete(index);
  }

  /**
   * Adds `count` source frames starting at `from`, times per-frame gains, into
   * `out` (stereo planar: out[0], out[1]) at offset `at`. Returns false when a
   * needed chunk is missing (the frames are treated as silence). With `mono`,
   * the first two channels are averaged into both outputs (mono tracks).
   */
  mixInto(key, srcChannels, from, count, gains, out, at, gainsR = gains, mono = false) {
    const m = this.sources.get(key);
    let ok = true;
    let done = 0;
    while (done < count) {
      const f = from + done;
      const index = Math.floor(f / CHUNK);
      const inChunk = f - index * CHUNK;
      const take = Math.min(count - done, CHUNK - inChunk);
      const chunk = m && m.get(index);
      if (!chunk) {
        ok = false;
      } else {
        const l = chunk[0];
        const r = chunk[Math.min(1, srcChannels - 1)];
        const oL = out[0];
        const oR = out[1];
        const n = Math.min(take, l.length - inChunk);
        if (mono && r !== l) {
          for (let i = 0; i < n; i++) {
            const v = (l[inChunk + i] + r[inChunk + i]) * 0.5;
            oL[at + done + i] += v * gains[done + i];
            oR[at + done + i] += v * gainsR[done + i];
          }
        } else {
          for (let i = 0; i < n; i++) {
            oL[at + done + i] += l[inChunk + i] * gains[done + i];
            oR[at + done + i] += r[inChunk + i] * gainsR[done + i];
          }
        }
      }
      done += take;
    }
    return ok;
  }
}

/**
 * Adds `count` frames of a source into the 6-channel planar `out` at `at`,
 * placing its channels by channelMap (see surround.js). Returns false when a
 * chunk is missing.
 */
function mixIntoSix(store, key, srcChannels, from, count, gains, out, at) {
  const m = store.sources.get(key);
  const map = channelMap(srcChannels);
  let ok = true;
  let done = 0;
  while (done < count) {
    const f = from + done;
    const index = Math.floor(f / CHUNK);
    const inChunk = f - index * CHUNK;
    const take = Math.min(count - done, CHUNK - inChunk);
    const chunk = m && m.get(index);
    if (!chunk) ok = false;
    else {
      for (let c = 0; c < 6; c++) {
        const sc = map[c];
        if (sc < 0 || !chunk[sc]) continue;
        const src = chunk[sc];
        const o = out[c];
        const n = Math.min(take, src.length - inChunk);
        for (let i = 0; i < n; i++) o[at + done + i] += src[inChunk + i] * gains[done + i];
      }
    }
    done += take;
  }
  return ok;
}

/** Surround panner gains of a track (cached on the track object), one vector per input channel. */
function trackMatrix(track) {
  if (!track.matrix) track.matrix = surroundMatrix(track.surround, track.monoIn ? 1 : 2);
  return track.matrix;
}

/** Adds the track buffer `src` (2 or 6 channels) into the destination `dst` (2 or 6 channels). */
function addInto(track, src, dst, frames) {
  if (src.length >= 6 && dst.length >= 6) {
    for (let c = 0; c < 6; c++) {
      const s = src[c];
      const d = dst[c];
      for (let i = 0; i < frames; i++) d[i] += s[i];
    }
  } else if (src.length >= 6) {
    const k = Math.SQRT1_2;
    const [L, R, C, , Ls, Rs] = src;
    for (let i = 0; i < frames; i++) {
      dst[0][i] += L[i] + k * (C[i] + Ls[i]);
      dst[1][i] += R[i] + k * (C[i] + Rs[i]);
    }
  } else if (dst.length >= 6) {
    const [gl, gr] = trackMatrix(track);
    const [L, R] = src;
    for (let c = 0; c < 6; c++) {
      const a = gl[c];
      const b = gr ? gr[c] : 0;
      if (!a && !b) continue;
      const d = dst[c];
      if (!gr) for (let i = 0; i < frames; i++) d[i] += (L[i] + R[i]) * 0.5 * a;
      else for (let i = 0; i < frames; i++) d[i] += L[i] * a + R[i] * b;
    }
  } else {
    for (let i = 0; i < frames; i++) {
      dst[0][i] += src[0][i];
      dst[1][i] += src[1][i];
    }
  }
}

/**
 * Runs a track's effect chain in place. With `fxMix` < 1 the first `fxWet`
 * specs (the effects rack: input gain and slots) are blended with the dry
 * signal (scaled by `fxDry`, the rack input gain) before the rest of the chain.
 * The dry signal is delayed by `fxLatency` frames, the wet slots' processing
 * delay, so the two line up instead of comb filtering.
 */
function runChain(track, buf, frames, scratch, runFx) {
  const mix = track.fxMix ?? 1;
  const n = track.fxWet || 0;
  if (mix >= 1 || !n) {
    runFx(track.fx, buf, frames);
    return;
  }
  if (track.fxParts?.src !== track.fx) track.fxParts = { src: track.fx, wet: track.fx.slice(0, n), rest: track.fx.slice(n) };
  const nch = buf.length;
  if (!scratch.dry || scratch.dry.length < nch || scratch.dry[0].length < frames) scratch.dry = Array.from({ length: nch }, () => new Float32Array(Math.max(frames, scratch.gains.length)));
  const dry = scratch.dry;
  for (let c = 0; c < nch; c++) dry[c].set(buf[c].subarray(0, frames));
  const lat = track.fxLatency || 0;
  if (lat > 0) delayDry(scratch, track.id ?? 'master', dry, nch, frames, lat);
  runFx(track.fxParts.wet, buf, frames);
  const d = (1 - Math.max(0, mix)) * (track.fxDry ?? 1);
  const w = Math.max(0, mix);
  for (let c = 0; c < nch; c++) {
    const b = buf[c];
    const x = dry[c];
    for (let i = 0; i < frames; i++) b[i] = b[i] * w + x[i] * d;
  }
  if (track.fxParts.rest.length) runFx(track.fxParts.rest, buf, frames);
}

/** Delays `frames` of the dry channels in place by `lat` frames (a ring per track in scratch). */
function delayDry(scratch, id, dry, nch, frames, lat) {
  if (!scratch.dryDelay) scratch.dryDelay = new Map();
  let d = scratch.dryDelay.get(id);
  if (!d || d.lat !== lat || d.ring.length !== nch) {
    d = { lat, pos: 0, ring: Array.from({ length: nch }, () => new Float32Array(lat)) };
    scratch.dryDelay.set(id, d);
  }
  let pos = d.pos;
  for (let c = 0; c < nch; c++) {
    const r = d.ring[c];
    const x = dry[c];
    pos = d.pos;
    for (let i = 0; i < frames; i++) {
      const v = r[pos];
      r[pos] = x[i];
      x[i] = v;
      if (++pos === lat) pos = 0;
    }
  }
  d.pos = pos;
}

/**
 * Renders one block of `frames` frames starting at timeline frame `pos` into
 * `master` (stereo planar Float32Array[2]). Per-track peaks are written into
 * `meters` (Map track id -> [l, r]) when given. `runFx(slots, buf, frames)`
 * applies an effect chain in place to a stereo planar buffer.
 */
const plans = new WeakMap();

/** Render order and solo state for a graph (cached per graph object). */
export function routingPlan(graph) {
  let plan = plans.get(graph);
  if (plan) return plan;
  const tracks = graph.tracks;
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const busIds = new Set(tracks.filter((t) => t.bus).map((t) => t.id));
  const dest = (t) => (t.output && t.output !== t.id && busIds.has(t.output) ? t.output : null);
  // Every bus a track feeds: its output and its send targets.
  const feeds = (t) => {
    const out = [];
    const d = dest(t);
    if (d) out.push(d);
    for (const s of t.sends || []) if (s.target !== t.id && busIds.has(s.target) && !out.includes(s.target)) out.push(s.target);
    return out;
  };
  // Longest path from each bus to the master; inputs render before the buses they feed.
  const dist = new Map();
  const distance = (id, guard = 0) => {
    if (dist.has(id)) return dist.get(id);
    const t = byId.get(id);
    let d = 0;
    if (guard < tracks.length) for (const f of feeds(t)) d = Math.max(d, 1 + distance(f, guard + 1));
    dist.set(id, d);
    return d;
  };
  const buses = tracks.filter((t) => t.bus).sort((a, b) => distance(b.id) - distance(a.id));
  const order = [...tracks.filter((t) => !t.bus), ...buses];
  const anySolo = tracks.some((t) => t.solo && !t.soloSafe);
  const audible = new Set();
  if (!anySolo) {
    for (const t of tracks) if (!t.mute) audible.add(t.id);
  } else {
    const keep = new Set();
    const soloedBuses = new Set(tracks.filter((t) => t.solo && t.bus).map((t) => t.id));
    // Buses reachable from a track through outputs and sends.
    const downstream = (t) => {
      const seen = new Set();
      const stack = feeds(t);
      while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        stack.push(...feeds(byId.get(id)));
      }
      return seen;
    };
    for (const t of tracks) {
      if (t.solo || t.soloSafe) keep.add(t.id);
      const down = downstream(t);
      // Downstream: every bus a soloed track feeds.
      if (t.solo) for (const d of down) keep.add(d);
      // Upstream: tracks feeding a soloed bus.
      for (const d of down) if (soloedBuses.has(d)) keep.add(t.id);
    }
    for (const id of keep) if (!byId.get(id).mute) audible.add(id);
  }
  const six = new Set(graph.surround ? tracks.filter((t) => t.six).map((t) => t.id) : []);
  plan = { order, audible, dest, six };
  plans.set(graph, plan);
  return plan;
}

function busBuffer(scratch, id, frames, channels = 2) {
  if (!scratch.buses) scratch.buses = new Map();
  let b = scratch.buses.get(id);
  if (!b || b.buf[0].length < frames || b.buf.length !== channels) {
    const n = Math.max(frames, scratch.gains.length);
    b = { buf: Array.from({ length: channels }, () => new Float32Array(n)), used: false };
    scratch.buses.set(id, b);
  }
  return b;
}

/** Adds `src` (stereo planar) times a send's gain and balance into the bus it targets. */
function feedSend(scratch, send, src, frames, law, pg, channels = 2) {
  const b = busBuffer(scratch, send.target, frames, channels);
  if (!b.used) {
    for (const c of b.buf) c.fill(0, 0, frames);
    b.used = true;
  }
  panGains(send.pan || 0, law, pg);
  const gl = send.gain * pg[0];
  const gr = send.gain * pg[1];
  if (!gl && !gr) return;
  const [L, R] = src;
  const [bl, br] = b.buf;
  for (let i = 0; i < frames; i++) {
    bl[i] += L[i] * gl;
    br[i] += R[i] * gr;
  }
}

/** A stereo scratch buffer for one clip's effect chain. */
function clipBuffer(scratch, id, frames) {
  if (!scratch.clips) scratch.clips = new Map();
  let b = scratch.clips.get(id);
  if (!b || b[0].length < frames) {
    const n = Math.max(frames, scratch.gains.length);
    b = [new Float32Array(n), new Float32Array(n)];
    scratch.clips.set(id, b);
  }
  return b;
}

/**
 * Renders one block of `frames` frames starting at timeline frame `pos` into
 * `master` (stereo planar Float32Array[2]). Per-track peaks are written into
 * `meters` (Map track id -> [l, r]) when given. `runFx(slots, buf, frames)`
 * applies an effect chain in place to a stereo planar buffer.
 */
export function renderBlock(graph, store, pos, frames, master, scratch, { meters, runFx, missing } = {}) {
  const surround = Boolean(graph.surround) && master.length >= 6;
  for (const c of master) c.fill(0, 0, frames);
  const plan = routingPlan(graph);
  const chOf = (id) => (surround && plan.six.has(id) ? 6 : 2);
  const gains = scratch.gains;
  if (!scratch.gainsR || scratch.gainsR.length < gains.length) scratch.gainsR = new Float32Array(gains.length);
  const gainsR = scratch.gainsR;
  const tbuf = scratch.track;
  const law = lawOf(graph);
  const pg = [1, 1];
  const centre = panGains(0, law, [1, 1])[0] || 1;
  if (scratch.buses) for (const b of scratch.buses.values()) b.used = false;
  for (const track of plan.order) {
    const audible = plan.audible.has(track.id);
    if (!audible && !meters) continue;
    const six = surround && plan.six.has(track.id);
    if (six) {
      renderSix(graph, store, pos, frames, track, plan, master, scratch, { meters, missing, audible, chOf, runFx });
      continue;
    }
    tbuf[0].fill(0, 0, frames);
    tbuf[1].fill(0, 0, frames);
    let active = false;
    if (track.bus) {
      const b = scratch.buses?.get(track.id);
      if (b && b.used) {
        tbuf[0].set(b.buf[0].subarray(0, frames));
        tbuf[1].set(b.buf[1].subarray(0, frames));
        active = true;
      }
    }
    let clipFx = null;
    for (const clip of track.clips) {
      if (clip.mute) continue;
      const cs = clip.start;
      const ce = clip.start + clip.length;
      const hasFx = runFx && clip.fx && clip.fx.length;
      const reach = hasFx ? Math.max(ce, cs - (clip.base || 0) + (clip.full ?? clip.length) + (clip.fxTail || 0)) : ce;
      if (reach <= pos || cs >= pos + frames) continue;
      let dest = tbuf;
      if (hasFx) {
        if (!clipFx) clipFx = new Map();
        let entry = clipFx.get(clip.id);
        if (!entry) {
          entry = { buf: clipBuffer(scratch, clip.id, frames), fx: clip.fx };
          entry.buf[0].fill(0, 0, frames);
          entry.buf[1].fill(0, 0, frames);
          clipFx.set(clip.id, entry);
        }
        dest = entry.buf;
        active = true;
        if (ce <= pos) continue; // tail only
      }
      const a = Math.max(pos, cs);
      const b = Math.min(pos + frames, ce);
      const n = b - a;
      const base = clip.base || 0;
      const full = clip.full ?? clip.length;
      const panEnv = clip.panEnv && clip.panEnv.length ? clip.panEnv : null;
      for (let i = 0; i < n; i++) {
        const t = a + i - cs + base; // frame within the whole clip
        let g = clip.gain;
        if (clip.fadeIn > 0 && t < clip.fadeIn) g *= fadeShape(t / clip.fadeIn, clip.fadeInCurve);
        const fromEnd = full - t;
        if (clip.fadeOut > 0 && fromEnd < clip.fadeOut) g *= fadeShape(fromEnd / clip.fadeOut, clip.fadeOutCurve);
        if (clip.gainEnv) g *= envelopeAt(clip.gainEnv, t);
        if (panEnv) {
          // Relative to the law's centre: the track pan applies the law once more.
          panGains(envelopeAt(panEnv, t, 0), law, pg);
          gains[i] = (g * pg[0]) / centre;
          gainsR[i] = (g * pg[1]) / centre;
        } else gains[i] = g;
      }
      const ok = store.mixInto(clip.source, clip.channels, clip.offset + (a - cs), n, gains, dest, a - pos, panEnv ? gainsR : gains, clip.mono);
      if (!ok && missing) missing(clip.source, clip.offset + (a - cs), n);
      active = true;
    }
    if (clipFx) {
      for (const { buf, fx } of clipFx.values()) {
        runFx(fx, buf, frames);
        const [cl, cr] = buf;
        for (let i = 0; i < frames; i++) {
          tbuf[0][i] += cl[i];
          tbuf[1][i] += cr[i];
        }
      }
    }
    if (track.mono && active) {
      const L = tbuf[0];
      const R = tbuf[1];
      for (let i = 0; i < frames; i++) L[i] = R[i] = (L[i] + R[i]) * 0.5;
    }
    if (track.invert && active) {
      const L = tbuf[0];
      const R = tbuf[1];
      for (let i = 0; i < frames; i++) {
        L[i] = -L[i];
        R[i] = -R[i];
      }
    }
    if (track.fx && track.fx.length && runFx) {
      runChain(track, tbuf, frames, scratch, runFx);
      active = true;
    }
    if (!active) {
      if (meters) meters.set(track.id, [0, 0]);
      continue;
    }
    const sends = audible && track.sends && track.sends.length ? track.sends : null;
    if (sends) for (const snd of sends) if (snd.pre) feedSend(scratch, snd, tbuf, frames, law, pg, chOf(snd.target));
    const to = plan.dest(track);
    // Feeding a 6-channel destination, the surround panner places the track instead of the stereo pan.
    const toSix = surround && (to ? plan.six.has(to) : true);
    const vol = envelopeFrames(track.volumeEnv, pos, frames, scratch, 0, 1);
    const pan = toSix ? null : envelopeFrames(track.panEnv, pos, frames, scratch, 1, 0);
    const v0 = track.gain * envelopeAt(track.volumeEnv, pos);
    const v1 = track.gain * envelopeAt(track.volumeEnv, pos + frames);
    const p0 = Math.max(-1, Math.min(1, track.pan + envelopeAt(track.panEnv, pos, 0)));
    const p1 = Math.max(-1, Math.min(1, track.pan + envelopeAt(track.panEnv, pos + frames, 0)));
    let pkL = 0;
    let pkR = 0;
    const L = tbuf[0];
    const R = tbuf[1];
    const steady = toSix || (!pan && p0 === p1);
    if (toSix) pg[0] = pg[1] = 1;
    else if (steady) panGains(p0, law, pg);
    for (let i = 0; i < frames; i++) {
      const x = i / frames;
      const v = vol ? track.gain * vol[i] : v0 + (v1 - v0) * x;
      if (!steady) panGains(pan ? Math.max(-1, Math.min(1, track.pan + pan[i])) : p0 + (p1 - p0) * x, law, pg);
      const l = L[i] * v * pg[0];
      const r = R[i] * v * pg[1];
      L[i] = l;
      R[i] = r;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > pkL) pkL = al;
      if (ar > pkR) pkR = ar;
    }
    if (meters) meters.set(track.id, [pkL, pkR]);
    if (!audible) continue;
    if (sends) for (const snd of sends) if (!snd.pre) feedSend(scratch, snd, tbuf, frames, law, pg, chOf(snd.target));
    if (toSix) {
      addInto(track, tbuf, to ? usedBus(scratch, to, frames, 6).buf : master, frames);
      continue;
    }
    let mL = master[0];
    let mR = master[1];
    if (to) {
      const b = usedBus(scratch, to, frames, 2);
      mL = b.buf[0];
      mR = b.buf[1];
    }
    for (let i = 0; i < frames; i++) {
      mL[i] += L[i];
      mR[i] += R[i];
    }
  }
  const m = graph.master || {};
  if (m.fx && m.fx.length && runFx) runChain(m, surround ? master.slice(0, 6) : master, frames, scratch, runFx);
  const mg = (m.invert ? -1 : 1) * (m.gain ?? 1);
  const mvol = envelopeFrames(m.volumeEnv, pos, frames, scratch, 0, 1);
  const m0 = mg * envelopeAt(m.volumeEnv, pos);
  const m1 = mg * envelopeAt(m.volumeEnv, pos + frames);
  if (mvol) {
    for (const c of master) for (let i = 0; i < frames; i++) c[i] *= mg * mvol[i];
  } else if (m0 !== m1) {
    for (const c of master) for (let i = 0; i < frames; i++) c[i] *= m0 + ((m1 - m0) * i) / frames;
  } else if (m0 !== 1) {
    for (const c of master) for (let i = 0; i < frames; i++) c[i] *= m0;
  }
  if (m.mono && !surround) {
    for (let i = 0; i < frames; i++) master[0][i] = master[1][i] = (master[0][i] + master[1][i]) * 0.5;
  }
}

/** A bus buffer cleared for this block on first use. */
function usedBus(scratch, id, frames, channels) {
  const b = busBuffer(scratch, id, frames, channels);
  if (!b.used) {
    for (const c of b.buf) c.fill(0, 0, frames);
    b.used = true;
  }
  return b;
}

/** Renders a 6-channel track (5.1 audio or bus track) into its destination. */
function renderSix(graph, store, pos, frames, track, plan, master, scratch, { meters, missing, audible, chOf, runFx }) {
  if (!scratch.six || scratch.six[0].length < frames) scratch.six = Array.from({ length: 6 }, () => new Float32Array(Math.max(frames, scratch.gains.length)));
  const buf = scratch.six;
  for (const c of buf) c.fill(0, 0, frames);
  const gains = scratch.gains;
  let active = false;
  if (track.bus) {
    const b = scratch.buses?.get(track.id);
    if (b && b.used) {
      for (let c = 0; c < 6; c++) buf[c].set((b.buf[c] || b.buf[c % 2]).subarray(0, frames));
      active = true;
    }
  }
  for (const clip of track.clips) {
    if (clip.mute) continue;
    const cs = clip.start;
    const ce = clip.start + clip.length;
    if (ce <= pos || cs >= pos + frames) continue;
    const a = Math.max(pos, cs);
    const b = Math.min(pos + frames, ce);
    const n = b - a;
    const base = clip.base || 0;
    const full = clip.full ?? clip.length;
    for (let i = 0; i < n; i++) {
      const t = a + i - cs + base;
      let g = clip.gain;
      if (clip.fadeIn > 0 && t < clip.fadeIn) g *= fadeShape(t / clip.fadeIn, clip.fadeInCurve);
      const fromEnd = full - t;
      if (clip.fadeOut > 0 && fromEnd < clip.fadeOut) g *= fadeShape(fromEnd / clip.fadeOut, clip.fadeOutCurve);
      if (clip.gainEnv) g *= envelopeAt(clip.gainEnv, t);
      gains[i] = g;
    }
    const ok = mixIntoSix(store, clip.source, clip.channels, clip.offset + (a - cs), n, gains, buf, a - pos);
    if (!ok && missing) missing(clip.source, clip.offset + (a - cs), n);
    active = true;
  }
  if (!active) {
    if (meters) meters.set(track.id, [0, 0]);
    return;
  }
  // Surround-capable effects (the stereo ones are left out on six channels).
  if (track.fx?.length && runFx) runChain(track, buf, frames, scratch, runFx);
  const g = (track.invert ? -1 : 1) * track.gain;
  const vol = envelopeFrames(track.volumeEnv, pos, frames, scratch, 0, 1);
  const v0 = g * envelopeAt(track.volumeEnv, pos);
  const v1 = g * envelopeAt(track.volumeEnv, pos + frames);
  let pkL = 0;
  let pkR = 0;
  for (let c = 0; c < 6; c++) {
    const x = buf[c];
    let pk = 0;
    for (let i = 0; i < frames; i++) {
      const y = x[i] * (vol ? g * vol[i] : v0 + ((v1 - v0) * i) / frames);
      x[i] = y;
      const ay = y < 0 ? -y : y;
      if (ay > pk) pk = ay;
    }
    // Left meter: L, C, LFE, Ls; right meter: R, C, LFE, Rs.
    if (c !== 1 && c !== 5 && pk > pkL) pkL = pk;
    if (c !== 0 && c !== 4 && pk > pkR) pkR = pk;
  }
  if (meters) meters.set(track.id, [pkL, pkR]);
  if (!audible) return;
  const to = plan.dest(track);
  addInto(track, buf, to ? usedBus(scratch, to, frames, chOf(to)).buf : master, frames);
}

export function createScratch(frames = QUANTUM) {
  return {
    gains: new Float32Array(frames),
    gainsR: new Float32Array(frames),
    track: [new Float32Array(frames), new Float32Array(frames)],
  };
}

/** Timeline frame where the graph's last clip ends. */
export function graphLength(graph) {
  let end = 0;
  for (const t of graph.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.length);
  return end;
}
