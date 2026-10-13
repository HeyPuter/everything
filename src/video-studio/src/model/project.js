/**
 * Project document. Everything the editor saves lives in this plain JSON
 * object; times are integer microseconds (see lib/time.js).
 *
 * project = {
 *   format: 'video-studio-project', version, id, name, created, modified,
 *   settings: { width, height, fps, ratio, background: { type: 'color'|'blur', color, blur }, proxy?: 'off'|'on' },
 *     (proxy: proxy media for the preview, model/proxy.js; no field means 'auto')
 *   assets: { [id]: Asset },
 *   tracks: [Track]            // visual order, top to bottom
 *   markers: [{ id, time, color, label, note? }],
 *   range?: { in, out },       // in/out points for playback and export
 *   guides?: { v: [x], h: [y] }, // player guides as fractions of the frame
 *   deletedAt?: ms timestamp while the project is in the Trash
 *   transcript?: { words: [{ text, start, end }], language }  // timed words of the speech
 *   bins?: [{ id, name, parent }]  // media bin folders; asset.folder points at one (model/bins.js)
 *   fonts?: [{ id, family, name, hash, ext, mime, size }]   // uploaded fonts
 *   timelineId?, timelines?: [{ id, name, ...contents }]   // more timelines sharing the media (model/timelines.js)
 * }
 * Track = { id, kind: 'video'|'audio'|'text'|'effect'|'filter'|'adjust', main?, locked, hidden, muted, solo?, name?, size?, clips: [Clip] }
 *   (main: true marks the base track, the one video track overlays stack on)
 * Clip  = { id, type, start, duration, ... } (see makeClip)
 *   video, image and adjust clips may also carry grade (see model/color.js)
 *   video and audio clips may carry speedCurve (see model/speed-curve.js) and
 *   speedRamp, the velocity ramp it came from (see model/speed-ramps.js)
 *   video clips may carry smoothSlow: 'blend'|'flow' (see model/slow-motion.js)
 *   video and image clips may carry masks (model/masks.js), removal
 *   (model/removal.js) and motionBlur, denoise, relight, enhance, canvas
 *   (model/clip-extras.js); transform may carry
 *   sx, sy (non-uniform scale) and uniform: false
 *   video, image, text, sticker and avatar clips may carry effects (see model/clip-effects.js)
 *   video and image clips may carry stylize: { id, amount } (see model/stylize.js)
 *   avatar clips hold a talking presenter (see model/avatar.js)
 */
import { uid } from '../lib/ids.js';
import { US } from '../lib/time.js';
import { normalizeAudioFields } from './audio.js';
import { normalizeGrade } from './color.js';
import { normalizeBins, fixAssetFolders } from './bins.js';
import { TEXT_STYLE_EXTRAS, normTextExtras } from './text-style.js';
import { normalizeCurve, meanSpeed } from './speed-curve.js';
import { normalizeSpeedRamp } from './speed-ramps.js';
import { normalizeMasks } from './masks.js';
import { normalizeClipExtras } from './clip-extras.js';
import { normalizeCutout } from './cutout.js';
import { normalizeRemoval } from './removal.js';
import { normalizeRetouch, normalizeFaceShape, normalizeHairColor, normalizeBodyShape, normalizeMakeup } from './retouch.js';
import { normalizeMarks } from './text-marks.js';
import { normalizeProxyMode } from './proxy.js';
import { isEase } from './keyframes.js';
import { normalizeSmoothSlow } from './slow-motion.js';
import { effectDefaults, normalizeEffectParams } from './effect-params.js';
import { normalizeClipEffects, canHaveEffects } from './clip-effects.js';
import { fitMulticam, normalizeMulticam, MAX_ANGLES } from './multicam.js';
import { normalizeAvatar, DEFAULT_AVATAR } from './avatar.js';
import { normalizeStylize } from './stylize.js';

export const FORMAT = 'video-studio-project';
export const VERSION = 1;

export const RATIOS = [
  { id: '16:9', label: '16:9', w: 1920, h: 1080, hint: 'YouTube' },
  { id: '9:16', label: '9:16', w: 1080, h: 1920, hint: 'Vertical' },
  { id: '1:1', label: '1:1', w: 1080, h: 1080, hint: 'Square' },
  { id: '4:3', label: '4:3', w: 1440, h: 1080, hint: 'Classic' },
  { id: '3:4', label: '3:4', w: 1080, h: 1440, hint: 'Portrait' },
  { id: '4:5', label: '4:5', w: 1080, h: 1350, hint: 'Feed post' },
  { id: '21:9', label: '21:9', w: 2560, h: 1080, hint: 'Cinema' },
  { id: '2:1', label: '2:1', w: 2160, h: 1080, hint: 'Widescreen' },
];

export const FPS_OPTIONS = [24, 25, 30, 50, 60];

/** Color labels a clip can carry on the timeline. */
export const CLIP_LABELS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];

/** Marker colors offered in the marker editor (the first is the default). */
export const MARKER_COLORS = ['#f5b83d', '#f05d5e', '#4fc27d', '#4f8ff7', '#a46cf0', '#3ec6e0', '#f27fc0', '#e6e6e6'];

/** Lane heights a track can be set to. */
export const TRACK_SIZES = ['small', 'medium', 'large'];

/** Track kinds that draw pixels, in the order new tracks of that kind are preferred. */
export const VISUAL_KINDS = new Set(['video', 'text', 'effect', 'filter', 'adjust']);

/** Which track kind holds each clip type. */
export const TRACK_KIND_FOR = {
  video: 'video',
  image: 'video',
  audio: 'audio',
  text: 'text',
  sticker: 'text',
  avatar: 'video',
  effect: 'effect',
  filter: 'filter',
  adjust: 'adjust',
  compound: 'video',
};

export const DEFAULT_TRANSFORM = Object.freeze({ x: 0, y: 0, scale: 1, rotation: 0, flipH: false, flipV: false });

export const DEFAULT_ADJUST = Object.freeze({
  brightness: 0,
  contrast: 0,
  saturation: 0,
  exposure: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  vignette: 0,
  sharpen: 0,
  fade: 0,
  grain: 0,
  vibrance: 0,
  whites: 0,
  blacks: 0,
  brilliance: 0,
  clarity: 0,
});

export const DEFAULT_TEXT_STYLE = Object.freeze({
  font: 'Inter',
  size: 64,
  color: '#ffffff',
  bold: false,
  italic: false,
  underline: false,
  align: 'center',
  letterSpacing: 0,
  lineHeight: 1.2,
  strokeColor: '#000000',
  strokeWidth: 0,
  bgColor: '#000000',
  bgOpacity: 0,
  bgRadius: 8,
  shadowColor: '#000000',
  shadowOpacity: 0,
  shadowBlur: 8,
  shadowDistance: 4,
  shadowAngle: 45,
  ...TEXT_STYLE_EXTRAS,
});

export function defaultSettings(ratioId = '16:9') {
  // "original" starts as 16:9 and adopts the shape of the first media added.
  const r = RATIOS.find((x) => x.id === ratioId) || RATIOS[0];
  return { width: r.w, height: r.h, fps: 30, ratio: ratioId === 'original' ? 'original' : r.id, background: { type: 'color', color: '#000000', blur: 0.5 } };
}

export function makeTrack(kind, extra = {}) {
  return { id: uid('t'), kind, locked: false, hidden: false, muted: false, clips: [], ...extra };
}

export function createProject({ name = 'Untitled project', ratio = '16:9' } = {}) {
  const now = Date.now();
  return {
    format: FORMAT,
    version: VERSION,
    id: uid('p'),
    name,
    created: now,
    modified: now,
    settings: defaultSettings(ratio),
    assets: {},
    tracks: [makeTrack('video', { main: true })],
    markers: [],
    cover: null,
  };
}

/** Default fields per clip type. */
export function makeClip(type, fields = {}) {
  const base = { id: uid('c'), type, start: 0, duration: 5 * US, name: '' };
  switch (type) {
    case 'video':
    case 'image':
      return {
        ...base,
        assetId: null,
        in: 0,
        speed: 1,
        volume: 1,
        muted: false,
        fadeIn: 0,
        fadeOut: 0,
        transform: { ...DEFAULT_TRANSFORM },
        opacity: 1,
        blend: 'normal',
        crop: { l: 0, t: 0, r: 0, b: 0 },
        adjust: { ...DEFAULT_ADJUST },
        filter: null,
        animIn: null,
        animOut: null,
        animLoop: null,
        transition: null,
        keyframes: {},
        freeze: false,
        ...fields,
      };
    case 'audio':
      return { ...base, assetId: null, in: 0, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, keyframes: {}, ...fields };
    case 'compound':
      // A nested timeline (model/compound.js): its own tracks, shown from `in` for `duration`.
      return {
        ...base,
        name: 'Compound clip',
        in: 0,
        volume: 1,
        muted: false,
        fadeIn: 0,
        fadeOut: 0,
        transform: { ...DEFAULT_TRANSFORM },
        opacity: 1,
        blend: 'normal',
        animIn: null,
        animOut: null,
        animLoop: null,
        keyframes: {},
        sequence: { tracks: [] },
        ...fields,
      };
    case 'text':
      return {
        ...base,
        duration: 3 * US,
        text: 'Your text',
        style: { ...DEFAULT_TEXT_STYLE },
        transform: { ...DEFAULT_TRANSFORM },
        opacity: 1,
        blend: 'normal',
        animIn: null,
        animOut: null,
        animLoop: null,
        keyframes: {},
        ...fields,
      };
    case 'sticker':
      return {
        ...base,
        duration: 3 * US,
        sticker: 'star',
        color: '#ffd23f',
        transform: { ...DEFAULT_TRANSFORM, scale: 1 },
        opacity: 1,
        blend: 'normal',
        animIn: null,
        animOut: null,
        animLoop: null,
        keyframes: {},
        ...fields,
      };
    case 'avatar':
      // A talking presenter (model/avatar.js) drawn over the frame like a picture.
      return {
        ...base,
        transform: { ...DEFAULT_TRANSFORM },
        opacity: 1,
        blend: 'normal',
        animIn: null,
        animOut: null,
        animLoop: null,
        keyframes: {},
        ...fields,
        avatar: { ...DEFAULT_AVATAR, ...fields.avatar },
      };
    case 'effect':
      return { ...base, duration: 3 * US, effect: 'blur', params: effectDefaults(fields.effect || 'blur'), ...fields };
    case 'filter':
      return { ...base, duration: 3 * US, filter: 'vivid', intensity: 100, ...fields };
    case 'adjust':
      return { ...base, duration: 3 * US, adjust: { ...DEFAULT_ADJUST }, keyframes: {}, ...fields };
    default:
      throw new Error(`Unknown clip type ${type}`);
  }
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const int = (v, d = 0) => Math.round(num(v, d));
const str = (v, d = '') => (typeof v === 'string' ? v : d);
const bool = (v) => Boolean(v);
const color = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toLowerCase() : d);
const clampN = (v, lo, hi, d) => Math.min(hi, Math.max(lo, num(v, d)));
// Keys that would reach Object.prototype when used on a plain object.
const unsafeKey = (k) => k === '__proto__' || k === 'constructor' || k === 'prototype';
const obj = (v) => (v && typeof v === 'object' ? v : {});

function normTransform(raw) {
  const t = obj(raw);
  return {
    x: num(t.x),
    y: num(t.y),
    scale: clampN(t.scale, 0.01, 50, 1),
    rotation: num(t.rotation),
    flipH: bool(t.flipH),
    flipV: bool(t.flipV),
    // Non-uniform scale multipliers, stored only when used.
    ...(Number.isFinite(Number(t.sx)) && Number(t.sx) !== 1 ? { sx: clampN(t.sx, 0.01, 50, 1) } : {}),
    ...(Number.isFinite(Number(t.sy)) && Number(t.sy) !== 1 ? { sy: clampN(t.sy, 0.01, 50, 1) } : {}),
    ...(t.uniform === false ? { uniform: false } : {}),
  };
}

function normAdjust(a) {
  const out = {};
  for (const k of Object.keys(DEFAULT_ADJUST)) out[k] = clampN(a?.[k], -100, 100, 0);
  return out;
}

function normAnim(a) {
  if (!a || typeof a !== 'object' || typeof a.id !== 'string') return null;
  return { id: a.id, duration: Math.max(0, int(a.duration, 500_000)) };
}

function normKeyframes(k) {
  const out = {};
  if (!k || typeof k !== 'object') return out;
  for (const [prop, list] of Object.entries(k)) {
    if (!Array.isArray(list) || unsafeKey(prop)) continue;
    const keys = list
      .filter((x) => x && Number.isFinite(Number(x.t)) && x.v !== undefined)
      // ramp: added by a velocity ramp's accent (model/speed-ramps.js).
      .map((x) => ({ t: Math.max(0, int(x.t)), v: num(x.v), ease: isEase(x.ease) ? x.ease : 'linear', ...(x.ramp === true ? { ramp: true } : {}) }))
      .sort((a, b) => a.t - b.t);
    if (keys.length) out[prop] = keys;
  }
  return out;
}

function normStyle(raw) {
  const s = obj(raw);
  const d = DEFAULT_TEXT_STYLE;
  return {
    font: str(s.font, d.font).slice(0, 80),
    size: clampN(s.size, 4, 600, d.size),
    color: color(s.color, d.color),
    bold: bool(s.bold),
    italic: bool(s.italic),
    underline: bool(s.underline),
    align: ['left', 'center', 'right'].includes(s.align) ? s.align : d.align,
    letterSpacing: clampN(s.letterSpacing, -50, 200, 0),
    lineHeight: clampN(s.lineHeight, 0.5, 4, d.lineHeight),
    strokeColor: color(s.strokeColor, d.strokeColor),
    strokeWidth: clampN(s.strokeWidth, 0, 40, 0),
    bgColor: color(s.bgColor, d.bgColor),
    bgOpacity: clampN(s.bgOpacity, 0, 1, 0),
    bgRadius: clampN(s.bgRadius, 0, 200, d.bgRadius),
    shadowColor: color(s.shadowColor, d.shadowColor),
    shadowOpacity: clampN(s.shadowOpacity, 0, 1, 0),
    shadowBlur: clampN(s.shadowBlur, 0, 100, d.shadowBlur),
    shadowDistance: clampN(s.shadowDistance, 0, 100, d.shadowDistance),
    shadowAngle: num(s.shadowAngle, d.shadowAngle),
    ...normTextExtras(s),
  };
}

export function normalizeClip(c) {
  if (!c || typeof c !== 'object' || typeof c.type !== 'string' || !Object.hasOwn(TRACK_KIND_FOR, c.type)) return null;
  const base = makeClip(c.type);
  const out = {
    ...base,
    id: str(c.id) || base.id,
    start: Math.max(0, int(c.start)),
    duration: Math.max(1000, int(c.duration, base.duration)),
    name: str(c.name).slice(0, 200),
  };
  if ('assetId' in base) {
    out.assetId = str(c.assetId) || null;
    out.in = Math.max(0, int(c.in));
    out.speed = clampN(c.speed, 0.1, 100, 1);
    out.volume = clampN(c.volume, 0, 10, 1);
    out.muted = bool(c.muted);
    out.fadeIn = Math.max(0, int(c.fadeIn));
    out.fadeOut = Math.max(0, int(c.fadeOut));
    if (c.type === 'audio' || c.type === 'video') normalizeAudioFields(c, out);
  }
  if ('transform' in base) {
    out.transform = normTransform(c.transform);
    out.opacity = clampN(c.opacity, 0, 1, 1);
    out.blend = str(c.blend, 'normal');
    out.animIn = normAnim(c.animIn);
    out.animOut = normAnim(c.animOut);
    out.animLoop = normAnim(c.animLoop ?? c.animCombo); // older projects saved this as animCombo
  }
  if ('keyframes' in base) out.keyframes = normKeyframes(c.keyframes);
  if (c.type === 'video' || c.type === 'image') {
    const cr = c.crop || {};
    out.crop = { l: clampN(cr.l, 0, 0.95, 0), t: clampN(cr.t, 0, 0.95, 0), r: clampN(cr.r, 0, 0.95, 0), b: clampN(cr.b, 0, 0.95, 0) };
    out.adjust = normAdjust(c.adjust);
    const grade = normalizeGrade(c.grade);
    if (grade) out.grade = grade;
    out.filter = c.filter && typeof c.filter.id === 'string' ? { id: c.filter.id, intensity: clampN(c.filter.intensity, 0, 100, 100) } : null;
    out.transition = c.transition && typeof c.transition.id === 'string' ? { id: c.transition.id, duration: Math.max(100_000, int(c.transition.duration, 500_000)) } : null;
    out.freeze = bool(c.freeze);
    if (c.audioDetached) out.audioDetached = true;
    if (c.reversed) out.reversed = true;
    const masks = normalizeMasks(c);
    if (masks.length) out.masks = masks;
    normalizeClipExtras(c, out);
    if (c.chroma && typeof c.chroma === 'object') out.chroma = { color: color(c.chroma.color, '#00ff00'), strength: clampN(c.chroma.strength, 0, 100, 40), spill: clampN(c.chroma.spill ?? c.chroma.shadow, 0, 100, 0) };
    if (c.cutout && typeof c.cutout === 'object') out.cutout = normalizeCutout(c.cutout);
    const removal = normalizeRemoval(c.removal);
    if (removal) out.removal = removal;
    if (c.retouch && typeof c.retouch === 'object') out.retouch = normalizeRetouch(c.retouch);
    if (c.faceShape && typeof c.faceShape === 'object') out.faceShape = normalizeFaceShape(c.faceShape);
    if (c.hairColor && typeof c.hairColor === 'object') out.hairColor = normalizeHairColor(c.hairColor);
    if (c.bodyShape && typeof c.bodyShape === 'object') out.bodyShape = normalizeBodyShape(c.bodyShape);
    if (c.makeup && typeof c.makeup === 'object') out.makeup = normalizeMakeup(c.makeup);
    if (c.colorTarget === 'person' || c.colorTarget === 'background') out.colorTarget = c.colorTarget;
    if (c.maskUse === 'color') out.maskUse = 'color';
    const look = normalizeStylize(c.stylize);
    if (look) out.stylize = look;
  }
  if ((c.type === 'video' || c.type === 'audio') && !out.freeze) {
    // Variable speed: clip.speed mirrors the curve's mean speed (source span / duration).
    const curve = normalizeCurve(c.speedCurve);
    if (curve) {
      out.speedCurve = curve;
      out.speed = meanSpeed(curve);
      const ramp = normalizeSpeedRamp(c.speedRamp);
      if (ramp) out.speedRamp = ramp;
    }
    // Kept at 1x too, so the choice survives a speed change; it only acts below 1x.
    const smooth = c.type === 'video' ? normalizeSmoothSlow(c.smoothSlow) : null;
    if (smooth) out.smoothSlow = smooth;
  }
  if (c.type === 'text') {
    out.text = str(c.text, 'Text').slice(0, 5000);
    out.style = normStyle(c.style);
    if (c.caption) out.caption = true;
    if (typeof c.captionStyle === 'string' && /^[a-z0-9-]{1,40}$/.test(c.captionStyle)) out.captionStyle = c.captionStyle;
    const marks = normalizeMarks(c.marks, out.text);
    if (marks.length) out.marks = marks;
    if (c.preset) out.preset = str(c.preset);
  }
  if (c.type === 'sticker') {
    out.sticker = str(c.sticker, 'star');
    out.color = color(c.color, '#ffd23f');
    // Multi-color graphics keep their own palette unless set to the custom color.
    if (c.colorMode === 'original') out.colorMode = 'original';
  }
  if (c.type === 'avatar') out.avatar = normalizeAvatar(c.avatar);
  if (c.type === 'effect') {
    out.effect = str(c.effect, 'blur');
    out.params = normalizeEffectParams(out.effect, c.params);
  }
  if (c.type === 'filter') {
    out.filter = str(c.filter, 'vivid');
    out.intensity = clampN(c.intensity, 0, 100, 100);
  }
  if (c.type === 'compound') {
    out.in = Math.max(0, int(c.in));
    out.volume = clampN(c.volume, 0, 10, 1);
    out.muted = bool(c.muted);
    out.fadeIn = Math.max(0, int(c.fadeIn));
    out.fadeOut = Math.max(0, int(c.fadeOut));
    // Nested tracks are checked against the project's media in normalizeProject.
    out.sequence = { tracks: Array.isArray(c.sequence?.tracks) ? c.sequence.tracks : [] };
    // Multi-camera switches (model/multicam.js), fitted to the angles there too.
    if (c.multicam && typeof c.multicam === 'object') out.multicam = normalizeMulticam(c.multicam, MAX_ANGLES);
  }
  if (c.type === 'adjust') {
    out.adjust = normAdjust(c.adjust);
    const grade = normalizeGrade(c.grade);
    if (grade) out.grade = grade;
  }
  if (canHaveEffects(out)) {
    const fx = normalizeClipEffects(c.effects);
    if (fx) out.effects = fx;
  }
  if (c.disabled) out.disabled = true;
  if (typeof c.group === 'string' && /^[\w-]{1,40}$/.test(c.group)) out.group = c.group;
  if (CLIP_LABELS.includes(c.label)) out.label = c.label;
  return out;
}

export function normalizeAsset(a) {
  if (!a || typeof a !== 'object' || !['video', 'audio', 'image'].includes(a.kind)) return null;
  return {
    id: str(a.id) || uid('a'),
    kind: a.kind,
    name: str(a.name, 'Media').slice(0, 300),
    // Used in file paths, so only the characters content hashes use.
    hash: str(a.hash).replace(/[^a-z0-9_-]/gi, '').slice(0, 128),
    ext: str(a.ext).replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase(),
    mime: str(a.mime),
    size: Math.max(0, int(a.size)),
    duration: Math.max(0, int(a.duration)),
    width: Math.max(0, int(a.width)),
    height: Math.max(0, int(a.height)),
    fps: clampN(a.fps, 0, 240, 0),
    hasAudio: bool(a.hasAudio),
    hasVideo: a.kind === 'video' ? a.hasVideo !== false : false,
    added: int(a.added, Date.now()),
    origin: str(a.origin),
    ...(a.reversedOf ? { reversedOf: str(a.reversedOf) } : {}),
    // Media bin folder (see model/bins.js); checked against project.bins in normalizeProject.
    ...(typeof a.folder === 'string' && a.folder ? { folder: a.folder.slice(0, 64) } : {}),
  };
}

/** Clips may only use media of their own kind (audio clips also play a video's sound). */
function assetFits(clip, assets) {
  if (!Object.hasOwn(assets, clip.assetId)) return false;
  const kind = assets[clip.assetId].kind;
  return clip.type === 'audio' ? kind === 'audio' || kind === 'video' : kind === clip.type;
}

/**
 * A track plays one clip at a time: clips that overlap an earlier one move
 * to a new track of the same kind just above (the base track included).
 */
function separateOverlaps(tracks) {
  for (let i = 0; i < tracks.length; i++) {
    const keep = [];
    const spill = [];
    let end = -Infinity;
    for (const c of tracks[i].clips) {
      if (c.start < end - 1) spill.push(c);
      else {
        keep.push(c);
        end = c.start + c.duration;
      }
    }
    if (!spill.length) continue;
    tracks[i].clips = keep;
    // Inserted at i and visited next, in case the spilled clips overlap each other.
    tracks.splice(i, 0, makeTrack(tracks[i].kind, { main: false, clips: spill }));
    i--;
  }
}

/** Transitions need a touching next clip and fit within both clips (as timeline.maxTransition). */
function fitTransitions(track) {
  track.clips.forEach((c, i) => {
    if (!c.transition) return;
    const next = track.clips[i + 1];
    const max = next && Math.abs(next.start - (c.start + c.duration)) <= 2000 ? Math.min(c.duration, next.duration, 5 * US) : 0;
    if (max < 100_000) c.transition = null;
    else c.transition.duration = Math.min(c.transition.duration, max);
  });
}

/** Tracks of a compound clip, validated against the project's media (nesting depth is limited). */
function normSequence(raw, assets, depth) {
  const tracks = [];
  const seen = new Set();
  for (const t of Array.isArray(raw?.tracks) ? raw.tracks : []) {
    if (!t || !['video', 'audio', 'text', 'effect', 'filter', 'adjust'].includes(t.kind)) continue;
    const clips = [];
    for (const c of Array.isArray(t.clips) ? t.clips : []) {
      const n = normalizeClip(c);
      if (!n || seen.has(n.id) || TRACK_KIND_FOR[n.type] !== t.kind) continue;
      if (n.assetId !== undefined && n.assetId !== null && !assetFits(n, assets)) continue;
      if (n.type === 'compound') {
        if (depth >= 4) continue;
        n.sequence = normSequence(n.sequence, assets, depth + 1);
        fitMulticam(n);
      }
      seen.add(n.id);
      clips.push(n);
    }
    clips.sort((a, b) => a.start - b.start);
    const track = { id: str(t.id) || uid('t'), kind: t.kind, main: Boolean(t.main) && t.kind === 'video', locked: false, hidden: bool(t.hidden), muted: bool(t.muted), clips };
    if (str(t.name).trim()) track.name = str(t.name).trim().slice(0, 60);
    // A camera angle of a multi-camera clip.
    if (t.angle && t.kind === 'video') track.angle = true;
    tracks.push(track);
  }
  const mains = tracks.filter((t) => t.main);
  mains.slice(1).forEach((t) => (t.main = false));
  if (!mains.length) {
    const v = tracks.find((t) => t.kind === 'video');
    if (v) v.main = true;
    else tracks.push(makeTrack('video', { main: true }));
  }
  separateOverlaps(tracks);
  return { tracks };
}

/** Validate untrusted JSON (from storage or an imported file) into a well-formed project. */
export function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Not a project');
  if (raw.format && raw.format !== FORMAT) throw new Error('Not a Video Studio project');
  const s = raw.settings || {};
  const ratio = RATIOS.some((r) => r.id === s.ratio) || s.ratio === 'custom' || s.ratio === 'original' ? s.ratio : '16:9';
  const settings = {
    width: Math.round(clampN(s.width, 16, 8192, 1920) / 2) * 2,
    height: Math.round(clampN(s.height, 16, 8192, 1080) / 2) * 2,
    fps: FPS_OPTIONS.includes(Number(s.fps)) ? Number(s.fps) : 30,
    ratio,
    background: {
      type: s.background?.type === 'blur' ? 'blur' : 'color',
      color: color(s.background?.color, '#000000'),
      blur: clampN(s.background?.blur, 0, 1, 0.5),
    },
    ...(normalizeProxyMode(s.proxy) ? { proxy: normalizeProxyMode(s.proxy) } : {}),
  };
  const assets = {};
  for (const a of Object.values(raw.assets && typeof raw.assets === 'object' ? raw.assets : {})) {
    const n = normalizeAsset(a);
    if (n && !unsafeKey(n.id)) assets[n.id] = n;
  }
  const bins = normalizeBins(raw.bins);
  fixAssetFolders(assets, bins);
  const seen = new Set();
  const trackIds = new Set();
  const tracks = [];
  for (const t of Array.isArray(raw.tracks) ? raw.tracks : []) {
    if (!t || !['video', 'audio', 'text', 'effect', 'filter', 'adjust'].includes(t.kind)) continue;
    const clips = [];
    for (const c of Array.isArray(t.clips) ? t.clips : []) {
      const n = normalizeClip(c);
      if (!n || seen.has(n.id)) continue;
      if (TRACK_KIND_FOR[n.type] !== t.kind) continue;
      if (n.assetId !== undefined && n.assetId !== null && !assetFits(n, assets)) continue;
      seen.add(n.id);
      clips.push(n);
    }
    clips.sort((a, b) => a.start - b.start);
    let id = str(t.id);
    if (!id || trackIds.has(id)) id = uid('t');
    trackIds.add(id);
    const track = { id, kind: t.kind, main: Boolean(t.main) && t.kind === 'video', locked: bool(t.locked), hidden: bool(t.hidden), muted: bool(t.muted), clips };
    if (t.solo) track.solo = true;
    if (str(t.name).trim()) track.name = str(t.name).trim().slice(0, 60);
    if (TRACK_SIZES.includes(t.size) && t.size !== 'medium') track.size = t.size;
    tracks.push(track);
  }
  // Compound clips hold their own tracks; check them like the top level.
  for (const t of tracks) for (const c of t.clips) if (c.type === 'compound') fitMulticam(Object.assign(c, { sequence: normSequence(c.sequence, assets, 1) }));
  // Exactly one base track.
  const mains = tracks.filter((t) => t.main);
  mains.slice(1).forEach((t) => (t.main = false));
  if (!mains.length) {
    const firstVideo = tracks.find((t) => t.kind === 'video');
    if (firstVideo) firstVideo.main = true;
    else tracks.push(makeTrack('video', { main: true }));
  }
  separateOverlaps(tracks);
  for (const t of tracks) fitTransitions(t);
  const markers = (Array.isArray(raw.markers) ? raw.markers : [])
    .filter((m) => m && Number.isFinite(Number(m.time)))
    .map((m) => {
      const out = { id: str(m.id) || uid('m'), time: Math.max(0, int(m.time)), color: color(m.color, '#3ec6e0'), label: str(m.label).slice(0, 200) };
      if (str(m.note)) out.note = str(m.note).slice(0, 2000);
      return out;
    });
  const fracs = (list) => (Array.isArray(list) ? list.map(Number).filter((v) => Number.isFinite(v) && v >= 0 && v <= 1).slice(0, 50) : []);
  const guides = raw.guides && typeof raw.guides === 'object' ? { v: fracs(raw.guides.v), h: fracs(raw.guides.h) } : null;
  const tw = Array.isArray(raw.transcript?.words) ? raw.transcript.words : [];
  const transcriptWords = tw
    .filter((w) => w && typeof w.text === 'string' && w.text.trim() && Number.isFinite(Number(w.start)) && Number.isFinite(Number(w.end)))
    .slice(0, 200_000)
    .map((w) => ({ text: w.text.trim().slice(0, 80), start: Math.max(0, int(w.start)), end: Math.max(0, int(w.end)) }))
    .sort((a, b) => a.start - b.start);
  const r = raw.range;
  const range = r && Number.isFinite(Number(r.in)) && Number.isFinite(Number(r.out)) && int(r.out) > int(r.in) ? { in: Math.max(0, int(r.in)), out: int(r.out) } : null;
  return {
    format: FORMAT,
    version: VERSION,
    id: str(raw.id) || uid('p'),
    name: str(raw.name, 'Untitled project').slice(0, 200) || 'Untitled project',
    created: int(raw.created, Date.now()),
    modified: int(raw.modified, Date.now()),
    settings,
    assets,
    tracks,
    markers,
    ...(range ? { range } : {}),
    ...(guides && (guides.v.length || guides.h.length) ? { guides } : {}),
    ...(transcriptWords.length ? { transcript: { words: transcriptWords, language: str(raw.transcript.language, 'auto').slice(0, 12) } } : {}),
    cover: raw.cover && Number.isFinite(Number(raw.cover.time)) ? { time: Math.max(0, int(raw.cover.time)) } : null,
    // Set while the project is in the Trash (time it was moved there).
    ...(num(raw.deletedAt) > 0 ? { deletedAt: int(raw.deletedAt) } : {}),
    ...(bins.length ? { bins } : {}),
    ...normFonts(raw.fonts),
    ...normTimelines(raw),
  };
}

/** What a stored timeline owns (see model/timelines.js). */
const TIMELINE_KEYS = ['settings', 'tracks', 'markers', 'range', 'transcript', 'guides', 'cover'];

/**
 * The project's other timelines: each stored one is checked like a project
 * of its own against the shared media; the open one is just { id, name }.
 */
function normTimelines(raw) {
  if (raw.nested || !Array.isArray(raw.timelines) || typeof raw.timelineId !== 'string') return {};
  const ids = new Set();
  const timelines = [];
  for (const t of raw.timelines.slice(0, 50)) {
    const id = str(t?.id);
    if (!id || ids.has(id) || unsafeKey(id)) continue;
    ids.add(id);
    const name = str(t.name).replace(/\s+/g, ' ').trim().slice(0, 80) || `Timeline ${timelines.length + 1}`;
    if (id === raw.timelineId) {
      timelines.push({ id, name });
      continue;
    }
    const n = normalizeProject({ ...t, format: FORMAT, assets: raw.assets, bins: raw.bins, nested: true });
    const entry = { id, name };
    for (const k of TIMELINE_KEYS) if (n[k] !== undefined && n[k] !== null) entry[k] = n[k];
    timelines.push(entry);
  }
  if (!ids.has(raw.timelineId)) return {};
  return { timelineId: raw.timelineId, timelines };
}

/**
 * Fonts the user uploaded: { id, family, name, hash, ext, mime, size }. The
 * file lives at fonts/<hash>.<ext> next to the media; family is the CSS
 * name text styles use.
 */
function normFonts(list) {
  if (!Array.isArray(list)) return {};
  const fonts = [];
  const seen = new Set();
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const hash = str(f.hash).replace(/[^a-z0-9_-]/gi, '').slice(0, 128);
    const family = str(f.family).replace(/[^a-z0-9 _-]/gi, '').slice(0, 80);
    if (!hash || !family || seen.has(family)) continue;
    seen.add(family);
    fonts.push({
      id: str(f.id) || uid('f'),
      family,
      name: str(f.name, family).slice(0, 120),
      hash,
      ext: str(f.ext).replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase(),
      mime: str(f.mime).slice(0, 80),
      size: Math.max(0, int(f.size)),
    });
  }
  return fonts.length ? { fonts } : {};
}

/** Summary stored in the project index for the home screen. */
export function projectSummary(p, duration) {
  const out = { id: p.id, name: p.name, modified: p.modified, created: p.created, duration, ratio: p.settings.ratio, width: p.settings.width, height: p.settings.height };
  if (p.deletedAt) out.deletedAt = p.deletedAt;
  return out;
}
