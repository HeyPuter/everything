/**
 * Per-clip effect stacks. Video, image, text, graphic and avatar clips may carry
 * clip.effects = [{ id, params, off? }] (at most MAX_CLIP_EFFECTS), applied in
 * order to that clip alone before it is placed on the canvas. Effects on an
 * effect track still work as before, on everything below them.
 *
 * The field is optional: clips without effects have no effects key, so
 * projects saved before it existed load unchanged.
 */
import { EFFECT_PARAMS, effectDefaults, normalizeEffectParams, clampEffectParam, effectIsOff } from './effect-params.js';

export const MAX_CLIP_EFFECTS = 5;

const FX_TYPES = new Set(['video', 'image', 'text', 'sticker', 'avatar']);
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Clip types that can carry their own effects. */
export const canHaveEffects = (clip) => Boolean(clip) && FX_TYPES.has(clip.type);

export const isKnownEffect = (id) => typeof id === 'string' && Object.hasOwn(EFFECT_PARAMS, id);

/** Validate untrusted JSON into an effect stack, or null when there is none. */
export function normalizeClipEffects(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !ID.test(e.id)) continue;
    const item = { id: e.id, params: normalizeEffectParams(e.id, e.params) };
    if (e.off) item.off = true;
    out.push(item);
    if (out.length >= MAX_CLIP_EFFECTS) break;
  }
  return out.length ? out : null;
}

/** Append an effect to a clip's stack. Returns its index, or -1 if it cannot be added. */
export function addClipEffect(clip, id, params = null) {
  if (!canHaveEffects(clip) || !isKnownEffect(id)) return -1;
  const list = clip.effects || [];
  if (list.length >= MAX_CLIP_EFFECTS) return -1;
  list.push({ id, params: params ? normalizeEffectParams(id, params) : effectDefaults(id) });
  clip.effects = list;
  return list.length - 1;
}

/** Drop the effects key once the stack is empty, so the clip saves as before. */
function tidy(clip) {
  if (clip.effects && !clip.effects.length) delete clip.effects;
}

export function removeClipEffect(clip, index) {
  const list = clip?.effects;
  if (!list || index < 0 || index >= list.length) return false;
  list.splice(index, 1);
  tidy(clip);
  return true;
}

/** Move an effect from one position in the stack to another. */
export function moveClipEffect(clip, from, to) {
  const list = clip?.effects;
  if (!list || from < 0 || from >= list.length) return false;
  const dest = Math.max(0, Math.min(list.length - 1, to));
  if (dest === from) return false;
  const [item] = list.splice(from, 1);
  list.splice(dest, 0, item);
  return true;
}

/** Turn one effect on or off without removing it. */
export function setClipEffectOn(clip, index, on) {
  const e = clip?.effects?.[index];
  if (!e) return false;
  if (on) delete e.off;
  else e.off = true;
  return true;
}

export function setClipEffectParam(clip, index, key, value) {
  const e = clip?.effects?.[index];
  if (!e) return false;
  const v = clampEffectParam(e.id, key, value);
  if (v === undefined) return false;
  e.params ||= {};
  e.params[key] = v;
  return true;
}

/** Effects that actually render: on, known and not dialed down to nothing. */
export function activeClipEffects(clip) {
  const list = clip?.effects;
  if (!list?.length) return [];
  return list.filter((e) => !e.off && isKnownEffect(e.id) && !effectIsOff(e.id, e.params));
}
