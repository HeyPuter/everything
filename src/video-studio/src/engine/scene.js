/**
 * Scene evaluation: what is on screen (and audible) at time t. Pure data in,
 * pure data out, shared by the live player and the exporter.
 *
 * Transform units: x and y are offsets from the canvas center as a fraction
 * of canvas width and height; scale 1 fits the media inside the canvas;
 * rotation is in degrees, clockwise.
 */
import { valueAt } from '../model/keyframes.js';
import { loudnessGain } from '../model/audio.js';
import { clipEnd, nextAdjacent, sourceTimeAt } from '../model/timeline.js';
import { sourceOffset } from '../model/speed-curve.js';
import { keyedAdjust } from '../model/color.js';
import { textColorAt } from '../model/text-style.js';
import { applyMotion, WHOLE_LOOPS } from './motion-anims.js';
import { expandProject } from './compound.js';
import { isGlyphAnim, isWholeClipAnim } from './text-anim.js';
import { evaluateMasks } from '../model/masks.js';
import { layerExtras, enhanceAt } from '../model/clip-extras.js';
import { removalAt } from '../model/removal.js';
import { activeClipEffects } from '../model/clip-effects.js';
import { smoothSlowAt } from '../model/slow-motion.js';
import { styleEffect } from '../model/stylize.js';
import { avatarPose } from './avatar-motion.js';

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const easeOut = (p) => 1 - (1 - p) ** 3;
const easeIn = (p) => p * p * p;
const backOut = (p) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2;
};
const bounceOut = (p) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (p < 1 / d1) return n1 * p * p;
  if (p < 2 / d1) return n1 * (p -= 1.5 / d1) * p + 0.75;
  if (p < 2.5 / d1) return n1 * (p -= 2.25 / d1) * p + 0.9375;
  return n1 * (p -= 2.625 / d1) * p + 0.984375;
};

/** Base transform with keyframes applied at clip-local time. */
export function keyedTransform(clip, local) {
  const t = clip.transform;
  const k = clip.keyframes;
  return {
    x: valueAt(k, 'x', local, t.x),
    y: valueAt(k, 'y', local, t.y),
    // Overshooting easings may dip a scale below zero; it stops at nothing rather than flipping.
    scale: Math.max(0, valueAt(k, 'scale', local, t.scale)),
    rotation: valueAt(k, 'rotation', local, t.rotation),
    sx: Math.max(0, valueAt(k, 'sx', local, t.sx ?? 1)),
    sy: Math.max(0, valueAt(k, 'sy', local, t.sy ?? 1)),
    flipH: t.flipH,
    flipV: t.flipV,
  };
}

/** Keyed and animated transform at clip-local time (motion blur samples). */
export function motionStateAt(clip, local) {
  const tr = keyedTransform(clip, local);
  const s = applyAnimations(clip, local, { x: tr.x, y: tr.y, scale: tr.scale, rotation: tr.rotation, opacity: 1, blur: 0, reveal: 1 });
  return { x: s.x, y: s.y, scale: s.scale, rotation: s.rotation, sx: tr.sx, sy: tr.sy };
}

/**
 * Apply in/out/loop animations. Mutates and returns state
 * { x, y, scale, rotation, opacity, blur, reveal }. Letter and word
 * animations (engine/text-anim.js) add { id, phase, p } entries to
 * state.textAnim for the text renderer.
 */
export function applyAnimations(clip, local, s) {
  const dur = clip.duration;
  const a = clip.animIn;
  if (a && a.duration > 0 && local < a.duration) {
    const p = clamp01(local / a.duration);
    const e = easeOut(p);
    switch (a.id) {
      case 'fade-in': s.opacity *= p; break;
      case 'zoom-in': s.scale *= 0.4 + 0.6 * e; s.opacity *= clamp01(p * 3); break;
      case 'zoom-out-in': s.scale *= 1.8 - 0.8 * e; s.opacity *= clamp01(p * 3); break;
      case 'slide-left-in': s.x += (1 - e); break;
      case 'slide-right-in': s.x -= (1 - e); break;
      case 'slide-up-in': s.y += (1 - e); break;
      case 'slide-down-in': s.y -= (1 - e); break;
      case 'rotate-in': s.rotation -= (1 - e) * 180; s.scale *= 0.3 + 0.7 * e; s.opacity *= p; break;
      case 'pop-in': s.scale *= Math.max(0, backOut(p)); break;
      case 'bounce-in': s.y -= (1 - bounceOut(p)) * 0.6; break;
      case 'blur-in': s.blur = Math.max(s.blur, 1 - e); s.opacity *= clamp01(p * 2); break;
      case 'typewriter': s.reveal = p; break;
      default: applyMotion('in', a.id, p, s); break;
    }
    if (isGlyphAnim(a.id)) (s.textAnim ||= []).push({ id: a.id, phase: 'in', p });
  }
  const o = clip.animOut;
  if (o && o.duration > 0 && local > dur - o.duration) {
    const p = clamp01((local - (dur - o.duration)) / o.duration);
    const e = easeIn(p);
    switch (o.id) {
      case 'fade-out': s.opacity *= 1 - p; break;
      case 'zoom-out': s.scale *= 1 - 0.6 * e; s.opacity *= clamp01((1 - p) * 3); break;
      case 'zoom-in-out': s.scale *= 1 + 0.8 * e; s.opacity *= clamp01((1 - p) * 3); break;
      case 'slide-left-out': s.x -= e; break;
      case 'slide-right-out': s.x += e; break;
      case 'slide-up-out': s.y -= e; break;
      case 'slide-down-out': s.y += e; break;
      case 'rotate-out': s.rotation += e * 180; s.scale *= 1 - 0.7 * e; s.opacity *= 1 - p; break;
      case 'pop-out': s.scale *= Math.max(0, 1 - backOut(p) * 0.999); break;
      case 'blur-out': s.blur = Math.max(s.blur, e); s.opacity *= clamp01((1 - p) * 2); break;
      default: applyMotion('out', o.id, p, s); break;
    }
    if (isGlyphAnim(o.id)) (s.textAnim ||= []).push({ id: o.id, phase: 'out', p });
  }
  const c = clip.animLoop;
  if (c && c.duration > 0) {
    const phase = WHOLE_LOOPS.has(c.id) ? clamp01(local / dur) : (local % c.duration) / c.duration;
    const w = Math.sin(phase * Math.PI * 2);
    switch (c.id) {
      case 'sway': s.rotation += w * 8; break;
      case 'pulse': s.scale *= 1 + 0.08 * Math.max(0, w); break;
      case 'float': s.y += w * 0.025; break;
      case 'spin': s.rotation += phase * 360; break;
      case 'wobble': s.x += Math.sin(phase * Math.PI * 6) * 0.015 * (1 - phase); s.rotation += Math.sin(phase * Math.PI * 4) * 4; break;
      case 'zoom-loop': s.scale *= 1 + 0.05 * (1 - Math.cos(phase * Math.PI * 2)); break;
      default: applyMotion('loop', c.id, phase, s); break;
    }
    if (isGlyphAnim(c.id)) (s.textAnim ||= []).push({ id: c.id, phase: 'loop', p: isWholeClipAnim(c.id) ? clamp01(local / dur) : phase });
  }
  return s;
}

/** Evaluate a visual clip at timeline time t into a layer. */
export function clipLayer(project, clip, t, trackIndex) {
  const local = t - clip.start;
  const tr = keyedTransform(clip, local);
  const state = applyAnimations(clip, local, {
    x: tr.x,
    y: tr.y,
    scale: tr.scale,
    rotation: tr.rotation,
    opacity: valueAt(clip.keyframes, 'opacity', local, clip.opacity),
    blur: 0,
    reveal: 1,
  });
  const layer = {
    kind: clip.type === 'video' || clip.type === 'image' ? 'media' : clip.type,
    clip,
    trackIndex,
    x: state.x,
    y: state.y,
    scale: state.scale,
    rotation: state.rotation,
    sx: tr.sx,
    sy: tr.sy,
    flipH: tr.flipH,
    flipV: tr.flipV,
    opacity: clamp01(state.opacity),
    blur: state.blur,
    reveal: state.reveal,
    blend: clip.blend || 'normal',
  };
  // Animated graphics are drawn at clip-local time (microseconds).
  if (clip.type === 'sticker') layer.local = local;
  if (clip.type === 'text') {
    layer.textAnim = state.textAnim || null;
    layer.textColor = textColorAt(clip, local);
  }
  if (clip.type === 'avatar') {
    // A talking presenter: drawn over the whole frame in a pose for this moment (engine/avatars.js).
    layer.local = local;
    layer.frameW = project.settings.width;
    layer.frameH = project.settings.height;
    const a = clip.avatar;
    layer.pose = avatarPose({ seed: a.seed, t: local / 1e6, voiceSec: voiceTimeAt(project, a, t), lips: a.lips, framing: a.framing });
  }
  if (clip.parent) withParent(layer, clip.parent, t, project);
  if (layer.kind === 'media') {
    const asset = project.assets[clip.assetId];
    layer.asset = asset;
    layer.width = asset?.width || project.settings.width;
    layer.height = asset?.height || project.settings.height;
    layer.sourceTime = clip.type === 'video' ? sourceTimeForTransition(clip, t, asset) : 0;
    // Slower than 1x with smooth slow motion on: draw in-between frames (engine/slow-motion.js).
    const smooth = smoothSlowAt(clip, local);
    if (smooth) layer.smoothSlow = smooth;
    layer.crop = clip.crop;
    layer.adjust = keyedAdjust(clip, local);
    layer.grade = clip.grade || null;
    layer.filter = clip.filter;
    layer.chroma = clip.chroma || null;
    layer.cutout = clip.cutout || null;
    layer.retouch = clip.retouch || null;
    layer.faceShape = clip.faceShape || null;
    layer.hairColor = clip.hairColor || null;
    layer.bodyShape = clip.bodyShape || null;
    layer.makeup = clip.makeup || null;
    layer.colorTarget = clip.colorTarget || null;
    layer.maskUse = clip.maskUse || null;
    layer.masks = evaluateMasks(clip, local);
    layer.extras = layerExtras(clip, local, project.settings.fps, (l) => motionStateAt(clip, l));
    // Passes on the source picture itself: object removal, then enhance (engine/source-fx.js).
    layer.removal = removalAt(clip, local);
    layer.enhance = enhanceAt(clip, local);
  }
  // The clip's own effect stack (rendered on this clip only, see engine/fx-render.js),
  // after its style look (model/stylize.js).
  const look = layer.kind === 'media' ? styleEffect(clip.stylize) : null;
  const fx = look ? [look, ...activeClipEffects(clip)] : activeClipEffects(clip);
  if (fx.length) {
    layer.effects = fx;
    layer.fxTime = local;
    layer.fxDur = clip.duration;
  }
  return layer;
}

/**
 * Apply the compound clip(s) a clip sits in: their transform, animations and
 * opacity wrap around the clip's own.
 */
function withParent(layer, parent, t, project) {
  const local = t - parent.start;
  const tr = keyedTransform(parent, local);
  const p = applyAnimations(parent, local, { x: tr.x, y: tr.y, scale: tr.scale, rotation: tr.rotation, opacity: valueAt(parent.keyframes, 'opacity', local, parent.opacity), blur: 0, reveal: 1 });
  const W = project.settings.width;
  const H = project.settings.height;
  const r = (p.rotation * Math.PI) / 180;
  const X = layer.x * W * (tr.flipH ? -1 : 1);
  const Y = layer.y * H * (tr.flipV ? -1 : 1);
  layer.x = p.x + ((X * Math.cos(r) - Y * Math.sin(r)) * p.scale) / W;
  layer.y = p.y + ((X * Math.sin(r) + Y * Math.cos(r)) * p.scale) / H;
  layer.scale *= p.scale;
  layer.rotation += p.rotation;
  if (tr.flipH) layer.flipH = !layer.flipH;
  if (tr.flipV) layer.flipV = !layer.flipV;
  layer.opacity = clamp01(layer.opacity * p.opacity);
  layer.blur = Math.max(layer.blur, p.blur);
  if (layer.blend === 'normal' && parent.blend && parent.blend !== 'normal') layer.blend = parent.blend;
  // Inner compound first, then the one holding it.
  if (parent.parent) withParent(layer, parent.parent, t, project);
}

/** Source time that may run past the clip edges during a transition, clamped to the media. */
function sourceTimeForTransition(clip, t, asset) {
  if (clip.freeze) return clip.in;
  // Same mapping as sourceTimeAt, continued past the edges at the end speeds.
  const raw = clip.in + sourceOffset(clip, t - clip.start);
  const max = asset?.duration ? asset.duration - 1000 : Infinity;
  return Math.max(0, Math.min(raw, max));
}

/**
 * Layers visible at time t, bottom to top. Transition pairs are emitted as a
 * single { kind: 'transition', id, progress, from, to } entry.
 */
export function evaluate(project, t, { includeHidden = false } = {}) {
  project = expandProject(project);
  const layers = [];
  const tracks = project.tracks;
  for (let ti = tracks.length - 1; ti >= 0; ti--) {
    const track = tracks[ti];
    if (track.kind === 'audio') continue;
    if (track.hidden && !includeHidden) continue;
    const clips = track.clips;
    // Transitions first: a window around a cut where both clips are drawn.
    let handled = false;
    for (let i = 0; i < clips.length; i++) {
      const a = clips[i];
      if (!a.transition) continue;
      const cut = clipEnd(a);
      const half = a.transition.duration / 2;
      if (t < cut - half || t >= cut + half) continue;
      const b = clips[i + 1];
      if (!b || Math.abs(b.start - cut) > 2000) continue;
      // A disabled side turns the transition off; the enabled clip plays on its own.
      if (a.disabled || b.disabled) continue;
      layers.push({
        kind: 'transition',
        id: a.transition.id,
        progress: clamp01((t - (cut - half)) / a.transition.duration),
        from: clipLayer(project, a, Math.min(t, cut + half), ti),
        to: clipLayer(project, b, Math.max(t, cut - half), ti),
        trackIndex: ti,
      });
      // Animations near the cut use the clip-local time, which can be out of range; clamp it.
      handled = true;
      break;
    }
    if (handled) continue;
    const clip = binaryClipAt(clips, t);
    if (!clip || clip.disabled || !showsAt(clip, t)) continue;
    if (track.kind === 'effect') {
      layers.push({ kind: 'effect', clip, effect: clip.effect, params: clip.params, local: t - clip.start, duration: clip.duration, trackIndex: ti });
    } else if (track.kind === 'filter') {
      layers.push({ kind: 'filter', clip, filter: clip.filter, intensity: clip.intensity, trackIndex: ti });
    } else if (track.kind === 'adjust') {
      layers.push({ kind: 'adjust', clip, adjust: keyedAdjust(clip, t - clip.start), grade: clip.grade || null, trackIndex: ti });
    } else {
      layers.push(clipLayer(project, clip, t, ti));
    }
  }
  return layers;
}

/**
 * Seconds into an avatar's voice at timeline time t: from the first clip of
 * its voice audio under t that is heard, or null when none plays. Moving or
 * trimming the voice clip keeps the lips in step with what is heard.
 */
export function voiceTimeAt(project, avatar, t) {
  const id = avatar?.voiceAsset;
  if (!id || !avatar.lips) return null;
  for (const track of project.tracks) {
    if (track.kind !== 'audio' || track.muted) continue;
    for (const c of track.clips) {
      if (c.assetId !== id || c.disabled || c.muted || t < c.start || t >= c.start + c.duration) continue;
      return sourceTimeAt(c, t) / 1e6;
    }
  }
  return null;
}

/** Whether a clip is drawn at t: a multi-camera angle that gives the sound is heard throughout but seen only in its show ranges. */
export function showsAt(clip, t) {
  if (!clip.show) return true;
  for (const [a, b] of clip.show) if (t >= a && t < b) return true;
  return false;
}

/** Clip covering t in a sorted clip list. */
export function binaryClipAt(clips, t) {
  let lo = 0;
  let hi = clips.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = clips[mid];
    if (t < c.start) hi = mid - 1;
    else if (t >= c.start + c.duration) lo = mid + 1;
    else return c;
  }
  return null;
}

/** Video clips whose frames may be needed in [t, t + ahead] (for preloading). */
export function upcomingVideoClips(project, t, ahead) {
  project = expandProject(project);
  const out = [];
  for (const track of project.tracks) {
    if (track.kind !== 'video' || track.hidden) continue;
    for (const c of track.clips) {
      if (c.type !== 'video') continue;
      const pad = c.transition ? c.transition.duration : 0;
      const prev = track.clips[track.clips.indexOf(c) - 1];
      const lead = prev?.transition ? prev.transition.duration : 0;
      if (c.start - lead <= t + ahead && clipEnd(c) + pad > t) out.push(c);
    }
  }
  return out;
}

/** Gain of an audio-bearing clip at timeline time t (keyframes, fades, mute). */
export function gainAt(clip, t) {
  let g = ownGain(clip, t);
  // Clips inside compound clips also follow the compound's volume and fades.
  for (let p = clip.parent; p && g > 0; p = p.parent) g *= ownGain(p, t);
  return g;
}

function ownGain(clip, t) {
  if (clip.muted || clip.disabled) return 0;
  const local = t - clip.start;
  // Loudness normalization is an extra gain on top of the volume the user sets.
  let g = Math.max(0, valueAt(clip.keyframes, 'volume', local, clip.volume)) * loudnessGain(clip);
  if (clip.fadeIn > 0 && local < clip.fadeIn) g *= Math.max(0, local / clip.fadeIn);
  if (clip.fadeOut > 0 && local > clip.duration - clip.fadeOut) g *= Math.max(0, (clip.duration - local) / clip.fadeOut);
  return Math.max(0, g);
}

/** Whether a track is heard: not muted, and soloed when any track is soloed. */
export function trackAudible(project, track) {
  if (track.muted) return false;
  if (track.kind !== 'audio' && track.kind !== 'video') return false;
  if (track.solo) return true;
  return !project.tracks.some((t) => t.solo && (t.kind === 'audio' || t.kind === 'video'));
}

/**
 * Every clip that makes sound: audio clips plus video clips whose audio has
 * not been detached. Muted tracks are skipped.
 */
export function audibleClips(project) {
  project = expandProject(project);
  const out = [];
  for (const track of project.tracks) {
    if (!trackAudible(project, track)) continue;
    for (const c of track.clips) {
      if (c.type === 'audio' || (c.type === 'video' && !c.freeze && !c.audioDetached && project.assets[c.assetId]?.hasAudio)) {
        if (c.muted || c.disabled) continue;
        out.push({ clip: c, track });
      }
    }
  }
  return out;
}

export { sourceTimeAt, nextAdjacent };
