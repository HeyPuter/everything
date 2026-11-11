/**
 * Color grading helpers shared by the details panel (Color tab) and the
 * Color assets tab: LUT import, saved color presets, auto adjust, color
 * match and the player eyedropper.
 */
import { h, announce } from '../lib/dom.js';
import { US } from '../lib/time.js';
import { DEFAULT_ADJUST } from '../model/project.js';
import { normalizeGrade, ensureGrade, pixelStats, autoAdjustValues, ADJUST_PREFIX } from '../model/color.js';
import { setKey } from '../model/keyframes.js';
import { findClip, clipEnd, clipLabel } from '../model/timeline.js';
import { colorMatch, scaleMatch, applyMatch } from '../model/color-match.js';
import { clipFrames } from '../media/frame-sampler.js';
import { putLut } from '../engine/luts.js';
import { prefs, setPref } from './prefs.js';
import { toast } from './dialog.js';
import { uid } from '../lib/ids.js';

export const isGradable = (clip) => clip && (clip.type === 'video' || clip.type === 'image' || clip.type === 'adjust');

/* LUTs --------------------------------------------------------------------------- */

/** Import .cube files into the library. Returns the new LUT entries. */
export async function importLutFiles(ctx, files) {
  const out = [];
  for (const file of files) {
    try {
      const { entry, lut } = await ctx.library.importLut(file);
      putLut(entry.id, lut, entry.name);
      out.push(entry);
    } catch (err) {
      toast(`${file.name}: ${err?.message || "couldn't read this LUT"}`, { kind: 'error' });
    }
  }
  if (out.length) announce(out.length === 1 ? `Imported LUT ${out[0].name}` : `Imported ${out.length} LUTs`);
  return out;
}

/** Ask for .cube files and import them. Resolves to the new entries (empty when cancelled). */
export function chooseLutFiles(ctx) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: '.cube,.CUBE', multiple: true, hidden: true });
    input.addEventListener('change', async () => {
      const files = [...(input.files || [])];
      input.remove();
      resolve(files.length ? await importLutFiles(ctx, files) : []);
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve([]);
    });
    document.body.append(input);
    input.click();
  });
}

/** Set (or clear, with entry null) the LUT of a clip. */
export function applyLut(ctx, clipId, entry) {
  return ctx.actions.editClip(clipId, entry ? `Apply LUT ${entry.name}` : 'Remove LUT', (c) => {
    if (!isGradable(c)) return false;
    const g = ensureGrade(c);
    g.lut = entry ? { id: entry.id, name: entry.name, intensity: g.lut?.intensity ?? 100 } : null;
    if (entry) delete g.off.lut;
  });
}

/* Presets ------------------------------------------------------------------------ */

const presetListeners = new Set();

export function colorPresets() {
  const list = prefs().colorPresets;
  return Array.isArray(list) ? list : [];
}

export function onPresetsChanged(fn) {
  presetListeners.add(fn);
  return () => presetListeners.delete(fn);
}

function writePresets(list) {
  setPref('colorPresets', list);
  presetListeners.forEach((fn) => fn(list));
}

/** The color setup of a clip as plain data (adjust values plus grade). */
export function colorSetup(clip) {
  const adjust = {};
  for (const k of Object.keys(DEFAULT_ADJUST)) adjust[k] = clip.adjust?.[k] ?? 0;
  return { adjust, grade: normalizeGrade(clip.grade) };
}

export function savePreset(name, clip) {
  const preset = { id: uid('cp'), name: String(name).slice(0, 80) || 'Color preset', created: Date.now(), ...colorSetup(clip) };
  writePresets([preset, ...colorPresets()].slice(0, 200));
  return preset;
}

export function removePreset(id) {
  writePresets(colorPresets().filter((p) => p.id !== id));
}

export function renamePreset(id, name) {
  writePresets(colorPresets().map((p) => (p.id === id ? { ...p, name: String(name).slice(0, 80) } : p)));
}

/** Replace a clip's color setup with a preset (one undo step; color keyframes are dropped). */
export function applyPreset(ctx, clipId, preset) {
  return ctx.actions.editClip(clipId, `Apply ${preset.name}`, (c) => {
    if (!isGradable(c)) return false;
    c.adjust = { ...DEFAULT_ADJUST };
    for (const k of Object.keys(DEFAULT_ADJUST)) if (Number.isFinite(preset.adjust?.[k])) c.adjust[k] = Math.max(-100, Math.min(100, preset.adjust[k]));
    const g = normalizeGrade(preset.grade);
    if (g) c.grade = structuredClone(g);
    else delete c.grade;
    for (const p of Object.keys(c.keyframes || {})) if (p.startsWith(ADJUST_PREFIX)) delete c.keyframes[p];
  });
}

/* Frame analysis ------------------------------------------------------------------ */

/** The layer drawing clipId (also inside a transition pair). */
function findLayer(layers, clipId) {
  for (const l of layers) {
    if (l.kind === 'transition') {
      if (l.from?.clip?.id === clipId) return l.from;
      if (l.to?.clip?.id === clipId) return l.to;
    } else if (l.clip?.id === clipId) return l;
  }
  return null;
}

/**
 * Render what a clip's grading starts from at the playhead: a media clip on
 * its own with grading switched off (or only some parts, via strip), or for
 * a color layer everything below it. Returns { px, rect } or null with a
 * reason toast.
 */
function sourceFrame(ctx, clipId, strip) {
  const { store, player } = ctx;
  const f = findClip(store.project, clipId);
  if (!f) return null;
  if (!player?.supported || !player.probe) {
    toast('The preview is unavailable in this browser.', { kind: 'error' });
    return null;
  }
  const clip = f.clip;
  const t = Math.min(clipEnd(clip) - 1, Math.max(clip.start, store.time));
  let ready = true;
  let target = null;
  const px = player.probe(t, (layers) => {
    if (clip.type === 'adjust') {
      const i = layers.findIndex((l) => l.clip?.id === clipId);
      return i >= 0 ? layers.slice(0, i) : layers;
    }
    const layer = findLayer(layers, clipId);
    if (!layer) {
      ready = false;
      return [];
    }
    target = { ...layer, ...strip(layer), opacity: 1, blend: 'normal', masks: null, extras: null, blur: 0 };
    ready = player.hasSource(target);
    return [target];
  });
  if (!px || px.width < 4 || !ready) {
    toast(f.track.hidden ? 'Show the track first: hidden clips are not drawn.' : 'The frame is still loading. Try again in a moment.', { kind: 'info' });
    return null;
  }
  let rect = null;
  if (target) {
    const b = player.boxFor(target);
    const k = px.width / store.project.settings.width;
    if (b) rect = { x: (b.cx - b.w / 2) * k, y: (b.cy - b.h / 2) * k, w: b.w * k, h: b.h * k };
  }
  return { px, rect, t, clip };
}

/**
 * Auto adjust: analyze the clip's ungraded frame at the playhead and set
 * exposure, contrast, whites, blacks, temperature and tint (one undo step).
 * Keyed values get a key at the playhead.
 */
export function autoAdjust(ctx, clipId) {
  const src = sourceFrame(ctx, clipId, () => ({ adjust: DEFAULT_ADJUST, grade: null, filter: null }));
  if (!src) return null;
  const patch = autoAdjustValues(pixelStats(src.px.data, src.px.width, src.px.height, { rect: src.rect }));
  if (!patch) {
    toast('Nothing to analyze in this frame.', { kind: 'info' });
    return null;
  }
  const { store } = ctx;
  ctx.actions.editClip(clipId, 'Auto adjust', (c) => {
    c.adjust ||= { ...DEFAULT_ADJUST };
    const local = Math.round(src.t - c.start);
    for (const [k, v] of Object.entries(patch)) {
      const prop = ADJUST_PREFIX + k;
      if (c.keyframes?.[prop]?.length) setKey(c.keyframes, prop, local, v, 'linear', Math.round(US / store.fps / 2));
      else c.adjust[k] = v;
    }
    if (c.grade?.off) {
      delete c.grade.off.light;
      delete c.grade.off.color;
    }
  });
  store.seal();
  announce('Auto adjust applied');
  return patch;
}

/**
 * Color match: sample a few small frames of the clip and of the reference,
 * work out the slider values (and a luma curve) that make the clip look
 * like the reference as graded, and apply them at strength 0..100 as one
 * undo step. Returns { adjust, curve, before, after } or null.
 */
export async function matchColor(ctx, clipId, refId, { strength = 100, signal } = {}) {
  const { store, library } = ctx;
  const usable = (f) => f && (f.clip.type === 'video' || f.clip.type === 'image') && store.project.assets[f.clip.assetId];
  const f = findClip(store.project, clipId);
  const r = findClip(store.project, refId);
  if (!usable(f) || !usable(r) || clipId === refId) {
    toast('Pick another video or photo clip to match to.', { kind: 'info' });
    return null;
  }
  if (f.track.locked) {
    toast('This clip is on a locked track.', { kind: 'info' });
    return null;
  }
  const frames = async (clip) => {
    const asset = store.project.assets[clip.assetId];
    return clipFrames(await library.mediaBlob(asset), clip, asset, { count: 6, signal });
  };
  try {
    const src = await frames(f.clip);
    const ref = await frames(r.clip);
    // The reference as it looks on screen, so matching to a graded clip carries its grade over.
    const m = colorMatch(src, ref, { srcCrop: f.clip.crop, refCrop: r.clip.crop, refLook: { adjust: r.clip.adjust, grade: r.clip.grade } });
    if (!m) {
      toast('Could not read frames from these clips.', { kind: 'error' });
      return null;
    }
    const values = scaleMatch(m, strength);
    const done = ctx.actions.editClip(clipId, 'Match color', (c) => {
      applyMatch(c, values);
    });
    store.seal();
    if (!done) return null;
    const name = clipLabel(store.project, r.clip);
    toast(`Matched the color to ${name}.`, { kind: 'success' });
    announce(`Color matched to ${name}`);
    return { ...values, before: m.before, after: m.after };
  } catch (err) {
    if (err?.name !== 'AbortError') {
      console.error(err);
      toast(err?.message || 'Could not match these clips.', { kind: 'error' });
    }
    return null;
  }
}

/** Average color around (u, v) (0..1 across the frame) of an RGBA buffer. */
export function sampleAt(px, u, v, radius = 2) {
  const cx = Math.round(u * (px.width - 1));
  const cy = Math.round(v * (px.height - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (x < 0 || y < 0 || x >= px.width || y >= px.height) continue;
      const i = (y * px.width + x) * 4;
      r += px.data[i];
      g += px.data[i + 1];
      b += px.data[i + 2];
      n++;
    }
  }
  return n ? [r / n / 255, g / n / 255, b / n / 255] : null;
}

/**
 * Eyedropper on the player: the next click on the preview picks the color
 * there (as the clip looks before its HSL step). onPick([r, g, b]) or
 * onCancel() (Escape or a click outside the picture). alive() false (the
 * control that started it is gone) or the clip no longer selected ends it
 * quietly, leaving the next click to the player. Returns a cancel function.
 */
export function pickFromPlayer(ctx, clipId, { onPick, onCancel, alive } = {}) {
  const canvas = ctx.player?.canvas;
  const stage = canvas?.closest?.('.player-stage');
  if (!stage) {
    toast('Open the preview to pick a color.', { kind: 'info' });
    return () => {};
  }
  stage.classList.add('eyedropper-active');
  announce('Click the preview to pick a color. Press Escape to cancel.');
  let done = false;
  const offs = [];
  const finish = () => {
    done = true;
    stage.classList.remove('eyedropper-active');
    stage.removeEventListener('pointerdown', down, true);
    document.removeEventListener('keydown', key, true);
    offs.forEach((off) => off());
  };
  const stale = () => (alive && !alive()) || (ctx.store && !ctx.store.selectedIds.includes(clipId));
  const down = (e) => {
    if (e.button !== 0) return;
    if (stale()) {
      finish();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    const r = canvas.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width;
    const v = (e.clientY - r.top) / r.height;
    finish();
    if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) {
      onCancel?.();
      return;
    }
    const src = sourceFrame(ctx, clipId, (layer) => ({ grade: layer.grade ? { ...layer.grade, off: { ...layer.grade.off, hsl: true } } : null }));
    const rgb = src ? sampleAt(src.px, u, v) : null;
    if (rgb) onPick?.(rgb);
    else onCancel?.();
  };
  const key = (e) => {
    if (e.key !== 'Escape') return;
    if (stale()) {
      finish();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    finish();
    onCancel?.();
  };
  stage.addEventListener('pointerdown', down, true);
  document.addEventListener('keydown', key, true);
  // Another clip selected, or this one removed: stop picking.
  const check = () => {
    if (!done && stale()) finish();
  };
  if (ctx.store?.on) offs.push(ctx.store.on('select', check), ctx.store.on('change', check));
  return () => {
    if (done) return;
    finish();
    onCancel?.();
  };
}
