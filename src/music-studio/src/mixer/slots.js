// Pure effect-slot edits the mixer adds on top of model/edits.js: replace,
// duplicate, reset, clear, copy a chain, plus the drop-index math the slot
// list uses while dragging. No DOM.

import * as E from '../model/edits.js';
import { createSlot, MAX_FX_SLOTS } from '../model/project.js';
import { EFFECTS, defaultEffectParams } from '../effects/catalog.js';

export { MAX_FX_SLOTS };

export function slotIndex(project, track, slotId) {
  return project.mixer[track]?.fx.findIndex((s) => s.id === slotId) ?? -1;
}

export function slotById(project, track, slotId) {
  return project.mixer[track]?.fx.find((s) => s.id === slotId) || null;
}

/** Adds an effect at `at` (default: the end). Returns { project, id } (id null when full or unknown). */
export function addEffect(project, track, type, at) {
  if (!EFFECTS[type]) return { project, id: null };
  return E.addSlot(project, track, type, at);
}

/** Swaps a slot's effect for another type in place (new parameters, same position, on and mix kept). */
export function replaceEffect(project, track, slotId, type) {
  const t = project.mixer[track];
  const i = slotIndex(project, track, slotId);
  if (i < 0 || !EFFECTS[type]) return { project, id: null };
  const old = t.fx[i];
  if (old.type === type) return { project, id: old.id };
  const slot = { ...createSlot(type), on: old.on, mix: old.mix };
  const fx = t.fx.slice();
  fx[i] = slot;
  return { project: E.updateMixerTrack(project, track, { fx }), id: slot.id };
}

/** Copies a slot right after itself. */
export function duplicateSlot(project, track, slotId) {
  const t = project.mixer[track];
  const i = slotIndex(project, track, slotId);
  if (i < 0 || t.fx.length >= MAX_FX_SLOTS) return { project, id: null };
  const copy = { ...structuredClone(t.fx[i]), id: createSlot(t.fx[i].type).id };
  const fx = t.fx.slice();
  fx.splice(i + 1, 0, copy);
  return { project: E.updateMixerTrack(project, track, { fx }), id: copy.id };
}

/** Restores a slot's parameters to the effect defaults. */
export function resetSlot(project, track, slotId) {
  const s = slotById(project, track, slotId);
  if (!s) return project;
  return E.updateSlot(project, track, slotId, { params: defaultEffectParams(s.type), mix: 1 });
}

export function clearEffects(project, track) {
  const t = project.mixer[track];
  if (!t || !t.fx.length) return project;
  return E.updateMixerTrack(project, track, { fx: [] });
}

/** Moves a slot one place up (-1) or down (+1). */
export function nudgeSlot(project, track, slotId, dir) {
  const i = slotIndex(project, track, slotId);
  if (i < 0) return project;
  const to = i + dir;
  if (to < 0 || to >= project.mixer[track].fx.length) return project;
  return E.moveSlot(project, track, slotId, to);
}

/**
 * Index a dragged slot lands on, given the pointer y and the row midpoints
 * (top to bottom) of the filled slots. `from` is the dragged row's index.
 * The result is the final index for E.moveSlot.
 */
export function dropIndex(mids, y, from) {
  let gap = 0; // insertion gap 0..n among all rows
  while (gap < mids.length && y > mids[gap]) gap++;
  // Removing the dragged row first shifts later gaps up by one.
  const to = gap > from ? gap - 1 : gap;
  return Math.max(0, Math.min(mids.length - 1, to));
}
