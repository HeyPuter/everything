/**
 * Velocity ramps: named, dramatic speed curves, each optionally paired with
 * an accent at the ramp (a brief flash, a zoom punch or a motion blur push).
 * Accents reuse what clips already have: exposure keys (adjust.exposure),
 * scale keys and the clip's motion blur, so the renderer needs nothing new
 * and the user can edit them like any other key afterwards.
 *
 * A clip that got a ramp carries clip.speedRamp = { id, accent, blur? }:
 *   id      the ramp preset
 *   accent  whether the accent was added
 *   blur    'added' (no motion blur before) or 'enabled' (it was off)
 * Keys an accent adds are flagged { ramp: true } so picking another ramp
 * (or going back to constant speed) takes them away again without touching
 * the user's own keys.
 *
 * Pure functions; the timeline applies them (timeline.applySpeedRamp).
 */
import { US } from '../lib/time.js';
import { valueAt } from './keyframes.js';
import { sameCurve } from './speed-curve.js';

const P = (pairs) => pairs.map(([t, v]) => ({ t, v }));

/** Accent kinds, for labels and icons. */
export const RAMP_ACCENTS = {
  flash: { label: 'Flash', icon: 'zap' },
  punch: { label: 'Zoom punch', icon: 'zoomIn' },
  blur: { label: 'Motion blur', icon: 'waves' },
};

/**
 * Built-in velocity ramps. Original names and shapes. accents[].at is the
 * fraction of the clip's (new) timeline length where the accent peaks.
 */
export const SPEED_RAMPS = [
  {
    id: 'snap-glide',
    label: 'Snap and glide',
    hint: 'Races in, snaps to slow motion, then eases back to normal.',
    points: P([[0, 4], [0.26, 4], [0.36, 0.3], [0.68, 0.3], [0.82, 1], [1, 1]]),
    accents: [{ kind: 'punch', at: 0.34 }],
  },
  {
    id: 'punch-in',
    label: 'Punch in',
    hint: 'Normal speed, a hard drop to slow motion on the moment, then back.',
    points: P([[0, 1], [0.4, 1], [0.47, 0.25], [0.62, 0.25], [0.72, 1], [1, 1]]),
    accents: [{ kind: 'punch', at: 0.46 }],
  },
  {
    id: 'flash-hit',
    label: 'Flash hit',
    hint: 'Fast, a flash and a slow beat on the hit, fast again.',
    points: P([[0, 3], [0.44, 3], [0.5, 0.2], [0.64, 0.2], [0.74, 3], [1, 3]]),
    accents: [{ kind: 'flash', at: 0.49 }],
  },
  {
    id: 'double-tap',
    label: 'Double tap',
    hint: 'Two quick fast-slow hits, each with a zoom punch.',
    points: P([[0, 2.5], [0.18, 2.5], [0.25, 0.3], [0.37, 0.3], [0.45, 2.5], [0.56, 2.5], [0.63, 0.3], [0.75, 0.3], [0.83, 2.5], [1, 2.5]]),
    accents: [{ kind: 'punch', at: 0.24 }, { kind: 'punch', at: 0.62 }],
  },
  {
    id: 'hang-time',
    label: 'Hang time',
    hint: 'Fast up to a near-freeze in the middle, then fast away.',
    points: P([[0, 2], [0.3, 2], [0.42, 0.1], [0.58, 0.1], [0.7, 2], [1, 2]]),
    accents: [{ kind: 'flash', at: 0.42 }],
  },
  {
    id: 'whip-through',
    label: 'Whip through',
    hint: 'Steady slow motion with a blurred burst through the middle.',
    points: P([[0, 0.6], [0.4, 0.6], [0.5, 10], [0.6, 0.6], [1, 0.6]]),
    accents: [{ kind: 'blur', at: 0.5 }],
  },
  {
    id: 'rush',
    label: 'Rush',
    hint: 'Builds from normal speed into a blurred rush to the end.',
    points: P([[0, 1], [0.35, 1.5], [0.75, 8], [1, 8]]),
    accents: [{ kind: 'blur', at: 0.72 }],
  },
  {
    id: 'launch',
    label: 'Launch',
    hint: 'Slow, a flash, then a burst of speed.',
    points: P([[0, 0.3], [0.5, 0.3], [0.62, 6], [1, 6]]),
    accents: [{ kind: 'flash', at: 0.54 }, { kind: 'blur', at: 0.62 }],
  },
  {
    id: 'heartbeat',
    label: 'Heartbeat',
    hint: 'Two pulses of speed that land in slow motion.',
    points: P([[0, 1], [0.16, 4], [0.26, 0.4], [0.5, 1], [0.66, 4], [0.76, 0.4], [1, 1]]),
    accents: [{ kind: 'punch', at: 0.25 }, { kind: 'punch', at: 0.75 }],
  },
  {
    id: 'slow-reveal',
    label: 'Slow reveal',
    hint: 'Opens in deep slow motion and gathers to normal speed.',
    points: P([[0, 0.2], [0.55, 0.35], [0.85, 1], [1, 1]]),
    accents: [],
  },
  {
    id: 'wind-down',
    label: 'Wind down',
    hint: 'Starts fast and settles into slow motion at the end.',
    points: P([[0, 5], [0.4, 2], [0.75, 0.4], [1, 0.25]]),
    accents: [],
  },
];

export const findRamp = (id) => SPEED_RAMPS.find((r) => r.id === id) || null;

/** A fresh, editable copy of a ramp's points. */
export const rampPoints = (id) => findRamp(id)?.points.map((p) => ({ ...p })) || null;

/** Short description of a ramp's accents ("Zoom punch", "Flash, Motion blur"), or ''. */
export function accentLabel(ramp) {
  const kinds = [...new Set((ramp?.accents || []).map((a) => a.kind))];
  return kinds.map((k) => RAMP_ACCENTS[k].label).join(', ');
}

/**
 * The ramp a clip got and whether its curve was changed since:
 * { ramp, tweaked } or null.
 */
export function activeRamp(clip) {
  const ramp = findRamp(clip?.speedRamp?.id);
  if (!ramp || !Array.isArray(clip.speedCurve)) return null;
  return { ramp, tweaked: !sameCurve(clip.speedCurve, ramp.points) };
}

/** Clean a stored clip.speedRamp (null when unusable). */
export function normalizeSpeedRamp(raw) {
  if (!raw || typeof raw !== 'object' || !findRamp(raw.id)) return null;
  const out = { id: raw.id, accent: raw.accent !== false };
  if (raw.blur === 'added' || raw.blur === 'enabled') out.blur = raw.blur;
  return out;
}

// ---- Accents -------------------------------------------------------------------

/** Key shapes per accent: [offset us from the peak, value(base), ease to the next key]. */
const SHAPES = {
  flash: { prop: 'adjust.exposure', keys: [[-0.04 * US, (b) => b, 'linear'], [0, (b) => Math.min(100, b + 85), 'easeOut'], [0.3 * US, (b) => b, 'linear']] },
  punch: { prop: 'scale', keys: [[-0.08 * US, (b) => b, 'easeIn'], [0, (b) => b * 1.14, 'easeOut'], [0.45 * US, (b) => b, 'linear']] },
  // A short zoom push gives the motion blur movement to follow.
  blur: { prop: 'scale', keys: [[-0.25 * US, (b) => b, 'easeIn'], [0, (b) => b * 1.08, 'easeOut'], [0.35 * US, (b) => b, 'linear']] },
};

const BLUR_AMOUNT = 70;

const isVisual = (clip) => Boolean(clip?.transform);

function baseOf(clip, prop, t) {
  if (prop === 'scale') return valueAt(clip.keyframes, prop, t, clip.transform?.scale ?? 1);
  return valueAt(clip.keyframes, prop, t, clip.adjust?.exposure ?? 0);
}

/**
 * Add a ramp's accents to a clip (after its curve is set, so its duration is
 * final). Mutates the clip; returns whether anything was added. Audio clips
 * have nothing to accent.
 */
export function addRampAccents(clip, ramp) {
  if (!isVisual(clip) || !ramp?.accents?.length) return false;
  clip.keyframes ||= {};
  const D = clip.duration;
  for (const a of ramp.accents) {
    const shape = SHAPES[a.kind];
    if (shape.prop.startsWith('adjust.') && !clip.adjust) continue;
    const peak = a.at * D;
    // Bases first (the values without this accent), then the keys.
    const keys = shape.keys.map(([dt, f, ease]) => {
      const t = Math.round(Math.min(D, Math.max(0, peak + dt)));
      return { t, v: f(baseOf(clip, shape.prop, t)), ease, ramp: true };
    });
    const list = (clip.keyframes[shape.prop] ||= []);
    for (const k of keys) {
      const i = list.findIndex((x) => x.t === k.t);
      if (i >= 0) list[i] = k;
      else list.push(k);
    }
    list.sort((x, y) => x.t - y.t);
    if (a.kind === 'blur' && !clip.speedRamp?.blur) {
      const mb = clip.motionBlur;
      if (!mb) {
        clip.motionBlur = { on: true, amount: BLUR_AMOUNT };
        if (clip.speedRamp) clip.speedRamp.blur = 'added';
      } else if (!mb.on) {
        mb.on = true;
        if (clip.speedRamp) clip.speedRamp.blur = 'enabled';
      }
    }
  }
  return true;
}

/** Take away the accent keys and motion blur a ramp added, and the ramp marker. Mutates the clip. */
export function stripRampAccents(clip) {
  if (!clip) return;
  for (const [prop, keys] of Object.entries(clip.keyframes || {})) {
    if (!keys.some((k) => k.ramp)) continue;
    const kept = keys.filter((k) => !k.ramp);
    if (kept.length) clip.keyframes[prop] = kept;
    else delete clip.keyframes[prop];
  }
  const blur = clip.speedRamp?.blur;
  if (blur === 'added') delete clip.motionBlur;
  else if (blur === 'enabled' && clip.motionBlur) clip.motionBlur.on = false;
  delete clip.speedRamp;
}
