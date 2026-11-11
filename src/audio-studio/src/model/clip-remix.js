// Clip remix: pure state operations. A remixed clip carries
//
//   clip.remix = { sourceId, offset, length, target, edit, balance, maxJump,
//                  xfade, segments: [[a, b], ...], bpm }
//
// where `sourceId`, `offset` and `length` are the clip's original media and
// range (what Revert Remix returns to), `target` the duration asked for (in
// frames), `edit` the segment length preference (0 short .. 1 long),
// `balance` how jumps are judged (0 timbre .. 1 harmony), `maxJump` the
// longest jump in beats (0 = any), `xfade` the crossfade at each join (frames),
// and `segments` the remix itself: ranges of the original source, played back
// to back. The first starts at `offset` and the last ends at the source end.
//
// A remixed clip plays a derived pool source: the segments joined with
// equal-power crossfades (see multitrack/remix.js), with an id from remixKey.
// Its offset and length are in the frames of that source, so trimming,
// splitting and drawing work as on any other clip. A clip is either remixed
// or stretched, never both.

import { originalRange } from './clip-stretch.js';
import { normalizeEnvelope, envelopeValue } from './session-edits.js';

/** Defaults for new remixes. */
export const REMIX_DEFAULTS = { edit: 0.5, balance: 0.5, maxJump: 0 };

/** Crossfade at each join (seconds). */
export const REMIX_XFADE = 0.012;

/** Shortest remix target (seconds). */
export const MIN_REMIX_SECONDS = 1;

export const isRemixed = (clip) => Boolean(clip?.remix?.segments?.length);

/** A clip's remix settings with defaults filled in (null when it is not remixed). */
export function remixOf(clip) {
  const r = clip?.remix;
  if (!r) return null;
  return {
    ...REMIX_DEFAULTS,
    ...r,
    edit: clamp01(r.edit ?? REMIX_DEFAULTS.edit),
    balance: clamp01(r.balance ?? REMIX_DEFAULTS.balance),
    maxJump: Math.max(0, Math.round(Number(r.maxJump) || 0)),
  };
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** Total length (frames) of remix segments. */
export const remixLength = (segments) => segments.reduce((s, [a, b]) => s + Math.max(0, b - a), 0);

/** FNV-1a hash of numbers, base 36 (pool ids for derived sources). */
function hash(values) {
  let h = 0x811c9dc5;
  for (const v of values) {
    let x = Math.round(v) >>> 0;
    for (let i = 0; i < 4; i++) {
      h ^= x & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      x >>>= 8;
    }
  }
  return h.toString(36);
}

/** Pool id of the derived source for an original source, segments and crossfade. */
export function remixKey(sourceId, segments, xfade) {
  return `${sourceId}~remix~${segments.length}~${hash([xfade, ...segments.flat()])}`;
}

/**
 * The clip's original media and range: { sourceId, offset, length } (what a
 * remix starts from and Revert Remix returns to). A stretched clip counts
 * from its unstretched audio.
 */
export function remixOrigin(clip) {
  if (clip.remix) return { sourceId: clip.remix.sourceId, offset: clip.remix.offset, length: clip.remix.length };
  const r = originalRange(clip);
  return { sourceId: r.sourceId, offset: Math.round(r.offset), length: Math.max(1, Math.round(r.length)) };
}

/** Fades and envelopes of `clip` fitted to a new length. */
function fitTo(clip, length) {
  return {
    length,
    fadeIn: { ...clip.fadeIn, length: Math.min(length, clip.fadeIn.length) },
    fadeOut: { ...clip.fadeOut, length: Math.min(length, clip.fadeOut.length) },
    volumeEnv: clip.volumeEnv.length ? normalizeEnvelope(clip.volumeEnv, length) : clip.volumeEnv,
    panEnv: clip.panEnv.length ? normalizeEnvelope(clip.panEnv, length) : clip.panEnv,
  };
}

/**
 * The clip remixed: it plays `derivedId` (the joined segments) from its start.
 * `settings` holds target, edit, balance, maxJump, xfade and bpm; `segments`
 * the plan. A stretch is dropped (the remix starts from the original audio)
 * and looping turns off.
 */
export function remixClip(clip, settings, segments, derivedId) {
  const origin = remixOrigin(clip);
  const length = Math.max(1, remixLength(segments));
  const cur = remixOf(clip) || REMIX_DEFAULTS;
  return {
    ...clip,
    sourceId: derivedId,
    offset: 0,
    loop: false,
    stretch: null,
    ...fitTo(clip, length),
    remix: {
      ...origin,
      target: Math.round(settings.target ?? cur.target ?? length),
      edit: clamp01(settings.edit ?? cur.edit),
      balance: clamp01(settings.balance ?? cur.balance),
      maxJump: Math.max(0, Math.round(Number(settings.maxJump ?? cur.maxJump) || 0)),
      xfade: Math.max(0, Math.round(settings.xfade ?? cur.xfade ?? 0)),
      bpm: settings.bpm ?? cur.bpm ?? null,
      segments: segments.map(([a, b]) => [Math.round(a), Math.round(b)]),
    },
  };
}

/** The clip back on its original media and range (Revert Remix). */
export function unremixClip(clip) {
  if (!clip.remix) return clip;
  const { sourceId, offset, length } = clip.remix;
  return { ...clip, sourceId, offset, ...fitTo(clip, length), remix: null };
}

/** Reverts the remix of clips in a state (others are left alone). */
export function revertRemixes(state, ids) {
  const set = new Set(ids);
  let changed = false;
  const clips = state.clips.map((c) => {
    if (!set.has(c.id) || !c.remix) return c;
    changed = true;
    return unremixClip(c);
  });
  return changed ? { ...state, clips } : state;
}

/** Positions (frames in the derived source) where segments join. */
export function remixJoins(remix) {
  const out = [];
  let pos = 0;
  for (let i = 0; i < remix.segments.length - 1; i++) {
    const [a, b] = remix.segments[i];
    pos += b - a;
    out.push(pos);
  }
  return out;
}

/** Joins inside the part of a remixed clip that plays, relative to the clip start (frames). */
export function remixSeams(clip) {
  if (!isRemixed(clip)) return [];
  return remixJoins(clip.remix)
    .map((p) => p - clip.offset)
    .filter((t) => t > 0 && t < clip.length);
}

/** Ids of original sources that remixed clips in `state` keep (what saves must keep). */
export function remixOrigins(state) {
  const out = new Set();
  for (const c of state.clips) if (c.remix?.sourceId && c.remix.sourceId !== c.sourceId) out.add(c.remix.sourceId);
  return out;
}

/** Shifts envelope points right by `d` frames, holding the first value from 0. */
const padEnvelope = (points, d) => (points.length && d ? [{ t: 0, v: points[0].v }, ...points.map((p) => ({ ...p, t: p.t + d }))] : points);

/**
 * Plain clips for each segment of a remixed clip (the part of it that plays),
 * back to back on its track. Neighbours overlap by the remix crossfade and
 * are marked to crossfade there. `makeId` gives new clip ids; the first
 * piece keeps the clip's id. `sourceLength` is the original's length.
 */
export function splitRemix(clip, makeId, sourceLength = Infinity) {
  if (!isRemixed(clip)) return [clip];
  const r = clip.remix;
  const half = Math.floor((r.xfade || 0) / 2);
  const out = [];
  let pos = 0;
  const lo = clip.offset;
  const hi = clip.offset + clip.length;
  for (const [a, b] of r.segments) {
    const p0 = Math.max(pos, lo);
    const p1 = Math.min(pos + (b - a), hi);
    if (p1 > p0) out.push({ pos: p0, from: a + (p0 - pos), len: p1 - p0, first: p0 === lo, last: p1 === hi });
    pos += b - a;
  }
  // Volume and pan envelopes are cut at the joins like a split would cut them.
  const env = (points, t0, len) => {
    if (!points.length) return points;
    const inner = points.filter((p) => p.t > t0 && p.t < t0 + len).map((p) => ({ ...p, t: p.t - t0 }));
    return [{ t: 0, v: envelopeValue(points, t0, 0) }, ...inner, { t: len, v: envelopeValue(points, t0 + len, 0) }];
  };
  return out.map((s, i) => {
    // Overlap the neighbours by half the crossfade on each side of the cut, where there is audio.
    const t0 = s.pos - lo;
    // (not before the session start, when the clip begins at 0 with a short first piece)
    const left = s.first ? 0 : Math.max(0, Math.min(half, s.from, clip.start + t0));
    const right = s.last ? 0 : Math.max(0, Math.min(half, sourceLength - (s.from + s.len)));
    const length = s.len + left + right;
    return {
      ...clip,
      id: i === 0 ? clip.id : makeId(),
      name: `${clip.name} ${i + 1}`,
      sourceId: r.sourceId,
      start: clip.start + t0 - left,
      offset: s.from - left,
      length,
      remix: null,
      stretch: null,
      fadeIn: s.first ? { ...clip.fadeIn, length: Math.min(clip.fadeIn.length, length) } : { length: 0, curve: 0.5, xf: true },
      fadeOut: s.last ? { ...clip.fadeOut, length: Math.min(clip.fadeOut.length, length) } : { length: 0, curve: 0.5, xf: true },
      volumeEnv: padEnvelope(env(clip.volumeEnv, t0, s.len), left),
      panEnv: padEnvelope(env(clip.panEnv, t0, s.len), left),
    };
  });
}
