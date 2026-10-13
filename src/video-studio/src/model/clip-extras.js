/**
 * Per-clip picture extras for video and image clips, drawn in the clip's own
 * render pass so exports match the preview:
 *   motionBlur { on, amount 0..100 }       blur along the clip's own motion
 *   denoise    { on, strength 0..100 }     edge-preserving noise reduction
 *   relight    { on, angle, intensity 0..100, temperature -100..100 }
 *   enhance    { on, strength 0..100 }     crisper soft or small footage
 *   canvas     { on, type: color|blur|gradient, color, color2, angle, blur 0..100 }
 * Each is stored only once used; turning a section off keeps its settings.
 * Relight angle and intensity are keyframable (relight.angle, relight.intensity),
 * so is the enhance strength (enhance.strength). Enhance works on the source
 * picture before it is placed (engine/source-fx.js), the others on the clip
 * as drawn (engine/layer-extras.js).
 *
 * Also the layout helpers behind non-uniform scale (transform.sx / sy) and
 * the align-to-frame buttons.
 */
import { valueAt } from './keyframes.js';

export const EXTRA_DEFAULTS = {
  motionBlur: { on: true, amount: 50 },
  denoise: { on: true, strength: 40 },
  relight: { on: true, angle: 135, intensity: 50, temperature: 0 },
  enhance: { on: true, strength: 50 },
  canvas: { on: true, type: 'blur', color: '#000000', color2: '#1f3b73', angle: 180, blur: 50 },
};

export const CANVAS_TYPES = [
  { id: 'color', label: 'Color' },
  { id: 'blur', label: 'Blur' },
  { id: 'gradient', label: 'Gradient' },
];

const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const clampN = (v, lo, hi, d) => Math.min(hi, Math.max(lo, num(v, d)));
const hex = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);

/** Copy the extras of a saved clip onto a normalized one (video and image clips). */
export function normalizeClipExtras(raw, out) {
  const d = EXTRA_DEFAULTS;
  const mb = raw?.motionBlur;
  if (mb && typeof mb === 'object') out.motionBlur = { on: mb.on !== false, amount: clampN(mb.amount, 0, 100, d.motionBlur.amount) };
  const dn = raw?.denoise;
  if (dn && typeof dn === 'object') out.denoise = { on: dn.on !== false, strength: clampN(dn.strength, 0, 100, d.denoise.strength) };
  const rl = raw?.relight;
  if (rl && typeof rl === 'object') {
    out.relight = {
      on: rl.on !== false,
      angle: clampN(rl.angle, -360, 360, d.relight.angle),
      intensity: clampN(rl.intensity, 0, 100, d.relight.intensity),
      temperature: clampN(rl.temperature, -100, 100, 0),
    };
  }
  const en = raw?.enhance;
  if (en && typeof en === 'object') out.enhance = { on: en.on !== false, strength: clampN(en.strength, 0, 100, d.enhance.strength) };
  const cv = raw?.canvas;
  if (cv && typeof cv === 'object') {
    out.canvas = {
      on: cv.on !== false,
      type: CANVAS_TYPES.some((t) => t.id === cv.type) ? cv.type : d.canvas.type,
      color: hex(cv.color, d.canvas.color),
      color2: hex(cv.color2, d.canvas.color2),
      angle: clampN(cv.angle, -360, 360, d.canvas.angle),
      blur: clampN(cv.blur, 0, 100, d.canvas.blur),
    };
  }
  return out;
}

/** Media box at transform scale 1 (fit inside the frame), in project pixels. */
export function fitBox(srcW, srcH, crop, W, H) {
  const c = crop || { l: 0, t: 0, r: 0, b: 0 };
  const sw = Math.max(1, srcW || W) * (1 - c.l - c.r);
  const sh = Math.max(1, srcH || H) * (1 - c.t - c.b);
  const fit = Math.min(W / sw, H / sh);
  return { w: sw * fit, h: sh * fit };
}

/** Half extents of a w x h box rotated by deg (its axis-aligned bounds). */
export function rotatedHalf(w, h, deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  return { hw: (Math.abs(w) * c + Math.abs(h) * s) / 2, hh: (Math.abs(w) * s + Math.abs(h) * c) / 2 };
}

export const ALIGN_EDGES = [
  { id: 'left', label: 'Align left', icon: 'alignLeftEdge' },
  { id: 'hcenter', label: 'Align center', icon: 'alignHCenter' },
  { id: 'right', label: 'Align right', icon: 'alignRightEdge' },
  { id: 'top', label: 'Align top', icon: 'alignTopEdge' },
  { id: 'vcenter', label: 'Align middle', icon: 'alignVCenter' },
  { id: 'bottom', label: 'Align bottom', icon: 'alignBottomEdge' },
];

/**
 * Position (model units: offset from the frame center as a fraction of the
 * frame) that puts the clip's rotated box against a frame edge. w, h are the
 * box size in project pixels at the clip's current scale.
 */
export function alignPosition(edge, w, h, rotation, W, H) {
  const { hw, hh } = rotatedHalf(w, h, rotation);
  switch (edge) {
    case 'left': return { x: (hw - W / 2) / W };
    case 'right': return { x: (W / 2 - hw) / W };
    case 'hcenter': return { x: 0 };
    case 'top': return { y: (hh - H / 2) / H };
    case 'bottom': return { y: (H / 2 - hh) / H };
    case 'vcenter': return { y: 0 };
    default: return {};
  }
}

/**
 * Transform samples across the shutter for motion blur, or null when the
 * clip does not move. stateAt(local) returns { x, y, scale, rotation, sx, sy }.
 */
export function motionSamples(stateAt, local, fps, amount) {
  if (!(amount > 0)) return null;
  const shutter = (amount / 100) * 2 * (1e6 / (fps || 30));
  const a = stateAt(local - shutter / 2);
  const b = stateAt(local + shutter / 2);
  const moved = Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 1e-4
    || Math.abs(a.scale - b.scale) > 1e-4
    || Math.abs(a.rotation - b.rotation) > 0.02
    || Math.abs((a.sx ?? 1) - (b.sx ?? 1)) + Math.abs((a.sy ?? 1) - (b.sy ?? 1)) > 1e-4;
  if (!moved) return null;
  const n = Math.round(6 + (amount / 100) * 10);
  const out = [];
  for (let i = 0; i < n; i++) out.push(i === 0 ? a : i === n - 1 ? b : stateAt(local + (i / (n - 1) - 0.5) * shutter));
  return out;
}

/**
 * Render-time extras of a clip at clip-local time, or null when none is on.
 * stateAt is passed to motionSamples.
 */
export function layerExtras(clip, local, fps, stateAt) {
  let out = null;
  const mb = clip.motionBlur;
  if (mb?.on && mb.amount > 0) {
    const motion = motionSamples(stateAt, local, fps, mb.amount);
    if (motion) (out ||= {}).motion = motion;
  }
  const dn = clip.denoise;
  if (dn?.on && dn.strength > 0) (out ||= {}).denoise = dn.strength / 100;
  const rl = clip.relight;
  if (rl?.on) {
    const intensity = valueAt(clip.keyframes, 'relight.intensity', local, rl.intensity);
    if (intensity > 0) {
      (out ||= {}).relight = {
        angle: valueAt(clip.keyframes, 'relight.angle', local, rl.angle),
        intensity: intensity / 100,
        temperature: (rl.temperature || 0) / 100,
      };
    }
  }
  const cv = clip.canvas;
  if (cv?.on) (out ||= {}).canvas = { type: cv.type, color: cv.color, color2: cv.color2, angle: cv.angle, blur: cv.blur / 100 };
  return out;
}

/** Enhance strength (0..1) of a clip at clip-local time, or null when off. */
export function enhanceAt(clip, local) {
  const en = clip.enhance;
  if (!en?.on) return null;
  const strength = valueAt(clip.keyframes, 'enhance.strength', local, en.strength);
  return strength > 0 ? { strength: Math.min(1, strength / 100) } : null;
}

/**
 * How many times the source is enlarged when the clip fills the frame at
 * scale 1 (above 1 when it is smaller than the project frame), or 0 when the
 * size is unknown.
 */
export function upscaleFactor(srcW, srcH, W, H) {
  if (!(srcW > 0) || !(srcH > 0) || !(W > 0) || !(H > 0)) return 0;
  return Math.min(W / srcW, H / srcH);
}
