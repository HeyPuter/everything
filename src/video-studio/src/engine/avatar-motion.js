/**
 * How a presenter avatar moves at a moment: its mouth (from the analyzed
 * voice, media/lipsync.js), blinks, small eye moves, breathing, an idle head
 * sway that grows while talking, and a gesture on each emphasis beat (a nod,
 * raised brows, a head tilt, or with the waist-up framing a hand).
 *
 * Pure and deterministic: the pose depends only on the clip's seed, the
 * clip-local time, the voice time and the lip data, so the preview and the
 * export draw exactly the same frame.
 */
import { mouthAt, talkLevel, CLOSED_MOUTH } from '../media/lipsync.js';

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ease = (p) => p * p * (3 - 2 * p);

/** 32-bit FNV-1a hash of a string (a seed). */
export function seedOf(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A repeatable number in [0, 1) for (seed, n). */
export function hash01(seed, n) {
  let x = (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(n | 0, 0xc2b2ae35)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/**
 * The latest event at or before t in a schedule whose gaps are drawn from
 * [lo, hi) seconds: { k, at } or null before the first one.
 */
function lastEvent(seed, salt, t, first, lo, hi) {
  let at = first;
  let k = 0;
  let prev = null;
  // A walk from the start (a few hundred steps for a long clip) keeps every frame consistent.
  while (at <= t) {
    prev = { k, at };
    at += lo + hash01(seed, salt + k * 13) * (hi - lo);
    k++;
  }
  return prev;
}

/** Lid closing over a blink that started d seconds ago (0 open, 1 closed). */
function lid(d) {
  if (d < 0 || d >= 0.2) return 0;
  if (d < 0.07) return ease(d / 0.07);
  if (d < 0.1) return 1;
  return 1 - ease((d - 0.1) / 0.1);
}

/** Eyelid closure at t: a blink every 2.2 to 5.8 seconds, now and then a double one. */
export function blinkAt(seed, t) {
  if (!(t >= 0)) return 0;
  const e = lastEvent(seed, 101, t, 0.5 + hash01(seed, 7) * 1.8, 2.2, 5.8);
  if (!e) return 0;
  const d = t - e.at;
  let v = lid(d);
  if (hash01(seed, 977 + e.k) < 0.2) v = Math.max(v, lid(d - 0.3));
  return v;
}

/** Where the eyes look at t: mostly at the camera, with a small glance every few seconds. */
export function gazeAt(seed, t) {
  if (!(t >= 0)) return { x: 0, y: 0 };
  const e = lastEvent(seed, 503, t, 0.8 + hash01(seed, 11) * 1.5, 1.4, 3.6);
  if (!e) return { x: 0, y: 0 };
  const target = (k) => (hash01(seed, 2001 + k) < 0.45
    ? { x: 0, y: 0 }
    : { x: (hash01(seed, 3001 + k) - 0.5) * 0.7, y: (hash01(seed, 4001 + k) - 0.5) * 0.35 });
  const to = target(e.k);
  const from = e.k > 0 ? target(e.k - 1) : { x: 0, y: 0 };
  const p = ease(clamp01((t - e.at) / 0.07));
  return { x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p };
}

/** Gesture kinds; 'hand' is only seen with the waist-up framing (head framing tilts instead). */
const GESTURES = ['nod', 'hand', 'brows', 'hand', 'tilt', 'nod', 'hand', 'brows'];

/** Envelope of a gesture d seconds after its beat: rises just before, holds, settles. */
function gestureEnvelope(d) {
  if (d < -0.28 || d > 1.15) return 0;
  if (d < 0) return ease((d + 0.28) / 0.28);
  if (d < 0.45) return 1;
  return 1 - ease((d - 0.45) / 0.7);
}

/** The gesture active at voice time sec: { kind, amount, side } or null. */
export function gestureAt(seed, lips, sec, framing = 'head') {
  const beats = lips?.beats;
  if (!beats?.length || !Number.isFinite(sec)) return null;
  const f = sec * lips.rate;
  // Binary search for the first beat after f.
  let lo = 0;
  let hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= f) lo = mid + 1;
    else hi = mid;
  }
  let best = null;
  for (const i of [lo - 1, lo]) {
    if (i < 0 || i >= beats.length) continue;
    const amount = gestureEnvelope(sec - beats[i] / lips.rate);
    if (amount > 0 && (!best || amount > best.amount)) {
      let kind = GESTURES[Math.floor(hash01(seed, 5003 + i) * GESTURES.length)];
      if (kind === 'hand' && framing !== 'waist') kind = 'tilt';
      best = { kind, amount, side: hash01(seed, 6007 + i) < 0.5 ? -1 : 1, index: i };
    }
  }
  return best;
}

/**
 * Pose of a presenter: t is clip-local seconds, voiceSec the time in its
 * voice (null when no voice is playing), lips the stored analysis.
 * Head offsets are in head widths, rotation in degrees.
 */
export function avatarPose({ seed = 0, t = 0, voiceSec = null, lips = null, framing = 'head' } = {}) {
  const ph = (n) => hash01(seed, n) * TAU;
  const speaking = voiceSec !== null && voiceSec !== undefined && lips;
  const mouth = speaking ? mouthAt(lips, voiceSec) : CLOSED_MOUTH;
  const talk = speaking ? talkLevel(lips, voiceSec) : 0;
  const gesture = speaking ? gestureAt(seed, lips, voiceSec, framing) : null;
  const g = gesture?.amount || 0;
  let rot = 1.4 * Math.sin(TAU * 0.11 * t + ph(1)) + 0.7 * Math.sin(TAU * 0.23 * t + ph(2));
  rot += talk * 1.6 * Math.sin(TAU * 0.83 * t + ph(3));
  let dx = 0.012 * Math.sin(TAU * 0.07 * t + ph(4));
  let dy = 0.006 * Math.sin(TAU * 0.19 * t + ph(5)) + talk * 0.009 * Math.sin(TAU * 1.7 * t + ph(6));
  let yaw = 0.22 * Math.sin(TAU * 0.05 * t + ph(8)) + talk * 0.12 * Math.sin(TAU * 0.37 * t + ph(9));
  let brow = talk * 0.25 * (0.5 + 0.5 * Math.sin(TAU * 0.6 * t + ph(10)));
  let hand = 0;
  let handSide = 1;
  if (gesture) {
    const s = gesture.side;
    switch (gesture.kind) {
      case 'nod':
        dy += 0.035 * g * Math.sin(Math.min(1, g) * Math.PI * 0.5);
        rot += 0.6 * s * g;
        break;
      case 'brows':
        brow = Math.max(brow, g);
        yaw += 0.15 * s * g;
        break;
      case 'tilt':
        rot += 4 * s * g;
        brow = Math.max(brow, 0.5 * g);
        break;
      case 'hand':
        hand = g;
        handSide = s;
        brow = Math.max(brow, 0.45 * g);
        rot -= 1.2 * s * g;
        break;
      default:
        break;
    }
  }
  const breath = 0.5 + 0.5 * Math.sin(TAU * 0.24 * t + ph(12));
  const gaze = gazeAt(seed, t);
  return {
    open: mouth.open,
    wide: mouth.wide,
    round: mouth.round,
    fric: mouth.fric,
    blink: blinkAt(seed, t),
    brow: clamp01(brow),
    gazeX: gaze.x,
    gazeY: gaze.y,
    rot,
    dx,
    dy,
    yaw: Math.max(-1, Math.min(1, yaw)),
    breath,
    hand: clamp01(hand),
    handSide,
  };
}

/** Pose rounded for cache keys: frames that look the same share one raster. */
export function poseKey(p) {
  const r = (v) => Math.round(v * 400);
  return [p.open, p.wide, p.round, p.fric, p.blink, p.brow, p.gazeX, p.gazeY, p.rot / 10, p.dx, p.dy, p.yaw, p.breath, p.hand].map(r).join(',') + (p.handSide < 0 ? 'L' : 'R');
}
