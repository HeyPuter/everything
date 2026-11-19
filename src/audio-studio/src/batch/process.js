// Processing one Batch Process item: load the audio (an open document's
// current state or a range of it, a file from this device or a Puter file), apply the chosen
// Favorite to the whole file, encode it with the batch export options in the
// export worker and hand the Blob to the output (a Puter folder or the ZIP
// collector). Open documents are never modified.

import { getEffect } from '../effects/registry.js';
import { normalizeValues } from '../effects/params.js';
import { renderEffect, writeResult } from '../effects/apply.js';
import * as E from '../model/edits.js';
import { peakOf } from '../effects/commands.js';
import { exportAudio } from '../export/export.js';
import { audioFileFromBlob } from '../storage/files.js';
import * as puter from '../storage/puter.js';
import { exportOptionsFor } from './queue.js';
import { UserError } from '../lib/errors.js';
import { batchStepsProblem, applyStepsToState } from '../effects/favorite-sequence.js';

/**
 * Commands a Favorite may run that Batch Process can apply without opening
 * the file: (state, args) => state. Other command favorites need the editor.
 */
export const BATCH_COMMANDS = {
  'fx.normalizePeak': (state, args) => {
    const len = state.channels[0]?.length || 0;
    const peak = peakOf(state, 0, len, null);
    if (peak <= 0) return state;
    return E.gainRange(state, 0, len, Math.pow(10, (args?.peak ?? -0.1) / 20) / peak, null);
  },
  'fx.fadeIn': (state, args) => E.fadeRange(state, 0, state.channels[0]?.length || 0, 'in', args?.curve ?? 0, null),
  'fx.fadeOut': (state, args) => E.fadeRange(state, 0, state.channels[0]?.length || 0, 'out', args?.curve ?? 0, null),
  'fx.toMono': (state) => (state.channels.length > 1 ? E.convertChannels(state, 1) : state),
  'fx.toStereo': (state) => (state.channels.length === 1 ? E.convertChannels(state, 2) : state),
};

/** Why a favorite cannot run in a batch, or ''. */
export function batchFavoriteProblem(fav) {
  if (!fav) return '';
  const a = fav.action || {};
  if (a.type === 'effect') return getEffect(a.effect) ? '' : 'This effect is not available.';
  if (a.type === 'command') return BATCH_COMMANDS[a.command] ? '' : 'This favorite runs an editor command that Batch Process cannot run.';
  if (a.type === 'sequence' && Array.isArray(a.steps) && a.steps.length) return batchStepsProblem(a.steps);
  return 'This favorite is damaged.';
}

/** Applies a favorite to a whole state. */
export async function applyFavoriteToState(fav, state, { signal, onProgress, doc = null, applyChain } = {}) {
  if (!fav) return state;
  const problem = batchFavoriteProblem(fav);
  if (problem) throw new UserError(problem);
  const a = fav.action;
  if (a.type === 'command') return BATCH_COMMANDS[a.command](state, a.args);
  if (a.type === 'sequence') return applyStepsToState(a.steps, state, { signal, onProgress, doc, applyChain });
  const def = getEffect(a.effect);
  if (def.needsNoisePrint && !doc?.noisePrint) throw new UserError(`${def.name} needs a captured noise print, which a batch cannot provide.`);
  if (def.needsSoundModel && !doc?.soundModel) throw new UserError(`${def.name} needs a learned sound model, which a batch cannot provide.`);
  const len = state.channels[0]?.length || 0;
  if (!len) throw new UserError('The file has no audio.');
  const r = await renderEffect({ def, values: normalizeValues(def, a.values), state, start: 0, end: len, signal, onProgress, doc, applyChain });
  return r.state;
}

/** Loads an item's audio state: { state, info } (state = { sampleRate, channels, markers, meta }). */
export async function loadItem(item) {
  const s = item.source;
  if (s.type === 'doc') return { state: s.doc.state, doc: s.doc };
  if (s.type === 'range') return { state: E.cropRange(s.doc.state, s.start, s.end), doc: s.doc };
  let blob = s.file;
  if (s.type === 'puter') blob = typeof s.item?.read === 'function' ? await s.item.read() : await puter.readFile(s.path);
  const doc = await audioFileFromBlob(blob, item.name, s.type === 'puter' ? { type: 'puter', path: s.path } : { type: 'local' });
  return { state: doc.state, doc };
}

/**
 * Full pipeline for one item. `write(name, blob)` stores the output and
 * resolves the final name. Progress: load 10%, favorite 50%, encode 40%.
 */
export async function processItem(item, { favorite, settings, write, signal, onProgress, load = loadItem, encode = exportAudio, applyChain }) {
  onProgress?.(0.02);
  const { state: loaded, doc } = await load(item);
  if (signal?.aborted) throw abortError();
  onProgress?.(0.1);
  const state = await applyFavoriteToState(favorite, loaded, { signal, doc, applyChain, onProgress: (f) => onProgress?.(0.1 + 0.5 * f) });
  if (signal?.aborted) throw abortError();
  onProgress?.(0.6);
  const options = exportOptionsFor(settings, { sampleRate: state.sampleRate, channels: state.channels.length });
  const blob = await encode({ channels: state.channels, sampleRate: state.sampleRate, markers: state.markers || [], meta: state.meta || {} }, options, { signal, onProgress: (f) => onProgress?.(0.6 + 0.35 * f) });
  if (signal?.aborted) throw abortError();
  const output = await write(item.output, blob);
  onProgress?.(1);
  return { output: output || item.output };
}

/**
 * Applies a favorite to an item without exporting it. An open document (or
 * a range of one) is processed from its current state; a file from this
 * device or Puter is opened first with `openDoc(item)`, which returns its
 * document. Returns { doc, before, state }: the caller applies `state` to
 * `doc` as one undoable edit (unless the document changed meanwhile).
 */
export async function processInPlace(item, { favorite, signal, onProgress, openDoc, applyChain }) {
  if (!favorite) throw new UserError('Choose a favorite to apply.');
  const s = item.source;
  onProgress?.(0.02);
  const doc = s.type === 'doc' || s.type === 'range' ? s.doc : await openDoc(item);
  if (signal?.aborted) throw abortError();
  onProgress?.(0.1);
  const before = doc.state;
  const range = s.type === 'range' ? [s.start, s.end] : null;
  const input = range ? E.cropRange(before, range[0], range[1]) : before;
  const out = await applyFavoriteToState(favorite, input, { signal, doc, applyChain, onProgress: (f) => onProgress?.(0.1 + 0.85 * f) });
  if (signal?.aborted) throw abortError();
  let state = out;
  if (range) {
    if (out.channels.length !== before.channels.length) throw new UserError('This favorite changes the number of channels, so it cannot be applied to a range.');
    state = writeResult(before, range[0], range[1], out.channels.map((c) => c.toArray()), null);
  }
  onProgress?.(1);
  return { doc, before, state };
}

function abortError() {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
}
