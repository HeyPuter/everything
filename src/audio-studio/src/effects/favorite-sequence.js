// Multi-step favorites: Favorites > Start Recording Favorite captures every
// effect and supported edit applied in the Waveform editor until Stop
// Recording Favorite, and the favorite replays them in order.
//
// A step is { type: 'effect', effect, values, select } or
// { type: 'command', command, args, select }. `select` is null when the step
// ran on whatever was selected before it (the user's selection on replay), or
// the selection the user made just before the step:
//   { start, end, length, rate, mode }  frames at recording time, the file's
//   length and rate then, and how to place it in another file: 'relative'
//   (same fraction of the file) or 'absolute' (same time from the start).
// An empty range (start === end) means "no selection, playhead there".

import { getEffect } from './registry.js';
import { normalizeValues } from './params.js';
import { renderEffect } from './apply.js';
import * as E from '../model/edits.js';
import { peakOf } from './commands.js';
import { UserError } from '../lib/errors.js';

/** Edits a favorite can record, with how a batch applies them to [start, end) of a state ({ state, start, end } back). */
export const RECORDABLE_COMMANDS = {
  'fx.fadeIn': { batch: (st, a, s, e) => ({ state: E.fadeRange(st, s, e, 'in', a?.curve ?? 0, null), start: s, end: e }) },
  'fx.fadeOut': { batch: (st, a, s, e) => ({ state: E.fadeRange(st, s, e, 'out', a?.curve ?? 0, null), start: s, end: e }) },
  'fx.normalizePeak': {
    batch: (st, a, s, e) => {
      const peak = peakOf(st, s, e, null);
      return { state: peak > 0 ? E.gainRange(st, s, e, Math.pow(10, (a?.peak ?? -0.1) / 20) / peak, null) : st, start: s, end: e };
    },
  },
  'fx.invert': { batch: (st, a, s, e) => ({ state: E.invertRange(st, s, e, null), start: s, end: e }) },
  'fx.reverse': { batch: (st, a, s, e) => ({ state: E.reverseRange(st, s, e, null), start: s, end: e }) },
  'fx.silence': { selection: true, batch: (st, a, s, e) => ({ state: E.silenceRange(st, s, e, null), start: s, end: e }) },
  'fx.toMono': { whole: true, batch: (st) => ({ state: st.channels.length > 1 ? E.convertChannels(st, 1) : st }) },
  'fx.toStereo': { whole: true, batch: (st) => ({ state: st.channels.length === 1 ? E.convertChannels(st, 2) : st }) },
  'edit.delete': { selection: true, batch: (st, a, s, e) => ({ state: E.deleteRange(st, s, e, null), start: s, end: s }) },
  'edit.crop': { selection: true, batch: (st, a, s, e) => ({ state: E.cropRange(st, s, e), start: 0, end: e - s }) },
  'edit.insertSilence': {
    batch: (st, a, s) => {
      const n = Math.max(0, Math.round((a?.seconds || 0) * st.sampleRate));
      return { state: E.insertSilence(st, s, n), start: s, end: s + n };
    },
  },
  'fx.autoHeal': { selection: true },
};

const len = (state) => state.channels[0]?.length || 0;

/** Frames [start, end) a recorded selection maps to in a file of `length` frames at `rate`. */
export function placeSelection(sel, length, rate) {
  if (!sel) return null;
  let s;
  let e;
  if (sel.mode === 'absolute') {
    s = Math.round((sel.start / sel.rate) * rate);
    e = Math.round((sel.end / sel.rate) * rate);
  } else {
    const k = sel.length > 0 ? length / sel.length : 0;
    s = Math.round(sel.start * k);
    e = Math.round(sel.end * k);
  }
  s = Math.max(0, Math.min(length, s));
  e = Math.max(s, Math.min(length, e));
  return [s, e];
}

/** Records steps while on. Hooks the command registry and effect applies of `app`. */
export function createRecorder(app) {
  let steps = null;
  let lastSel = null; // selection after the previous step: [start, end]
  let pending = null; // command being run: { id, args, doc, sel, length }
  const audio = () => (app.active?.kind === 'audio' ? app.active : null);
  const selOf = (doc) => [doc.selection.start, doc.selection.end];
  const changed = (doc, sel) => !lastSel || sel[0] !== lastSel[0] || sel[1] !== lastSel[1];
  const selectFor = (doc, sel, length = doc.length) => (changed(doc, sel) ? { start: sel[0], end: sel[1], length, rate: doc.sampleRate, mode: 'relative' } : null);

  const push = (step, doc) => {
    steps.push(step);
    lastSel = selOf(doc);
    app.emit('favorites');
  };

  app.commands.watch?.({
    before(id, args) {
      if (!steps) return;
      const doc = audio();
      pending = doc ? { id, args, doc, sel: selOf(doc), length: doc.length, state: doc.state } : null;
    },
    after(id) {
      const p = pending;
      pending = null;
      if (!steps || !p || p.id !== id) return;
      const def = app.commands.commands.get(id);
      if (def?.effectCommand) return; // captured with its settings by fx-applied
      if (!RECORDABLE_COMMANDS[id] || p.doc.state === p.state) return;
      let args = p.args && typeof p.args === 'object' ? { ...p.args } : undefined;
      if (id === 'edit.insertSilence') args = { seconds: (p.doc.length - p.length) / p.doc.sampleRate };
      push({ type: 'command', command: id, ...(args ? { args } : {}), select: selectFor(p.doc, p.sel, p.length) }, p.doc);
    },
  });

  app.on('fx-applied', ({ effect, values, doc: target, before }) => {
    if (!steps) return;
    const doc = target || audio();
    if (!doc) return;
    const sel = before || pending?.sel || selOf(doc);
    push({ type: 'effect', effect, values: { ...values }, select: selectFor(doc, sel, pending?.doc === doc ? pending.length : doc.length) }, doc);
  });

  return {
    get recording() {
      return Boolean(steps);
    },
    get steps() {
      return steps ? steps.slice() : [];
    },
    start() {
      steps = [];
      const doc = audio();
      lastSel = doc ? selOf(doc) : null;
    },
    /** Stops and returns the recorded steps. */
    stop() {
      const out = steps || [];
      steps = null;
      pending = null;
      return out;
    },
  };
}

/** The favorite action for recorded steps: a plain effect or command for one step, else a sequence. */
export function actionFromSteps(steps) {
  if (steps.length === 1) {
    const { select, type, ...rest } = steps[0];
    return { type, ...rest };
  }
  return { type: 'sequence', steps };
}

/** Why a step cannot run in the editor right now, or ''. */
export function stepProblem(app, step) {
  if (step.type === 'effect') return getEffect(step.effect) ? '' : 'An effect it uses is not available.';
  if (step.type === 'command') return app.commands.get(step.command) ? '' : 'A command it uses is not available.';
  return 'A step is damaged.';
}

/**
 * Applies effect `def` with `values` like its menu item would with those settings: on
 * success the effect becomes the command Edit > Repeat runs (its dialog opens again, holding
 * these settings, now its last-used ones; Repeat Without Dialog reapplies them).
 */
export async function runEffectRepeatable(app, def, values) {
  const ok = await app.runEffect(def.id, { values: normalizeValues(def, values) });
  const id = `fx.${def.id}`;
  if (ok && app.commands?.get(id)?.repeatable) app.lastCommand = { id, args: {} };
  return ok;
}

/** Replays steps on the active audio file, one undo step each. Resolves false when a step could not run. */
export async function runSteps(app, steps) {
  for (const step of steps) {
    const doc = app.active?.kind === 'audio' ? app.active : null;
    if (!doc) return false;
    const range = placeSelection(step.select, doc.length, doc.sampleRate);
    if (range) {
      if (range[0] === range[1]) {
        doc.setSelection(range[0], range[0]);
        doc.cursor = range[0];
      } else doc.setSelection(range[0], range[1]);
    }
    const problem = stepProblem(app, step);
    if (problem) {
      app.notify(problem, { error: true });
      return false;
    }
    if (step.type === 'effect') {
      if (!(await runEffectRepeatable(app, getEffect(step.effect), step.values))) return false;
    } else {
      if (!app.commands.isEnabled(step.command, step.args)) {
        app.notify(`${app.commands.label(step.command).replace(/\.\.\.$/, '')} is not available for the selection at that step.`, { error: true });
        return false;
      }
      await app.commands.run(step.command, step.args);
    }
  }
  return true;
}

/** Why a sequence cannot run in Batch Process, or ''. */
export function batchStepsProblem(steps) {
  for (const s of steps) {
    if (s.type === 'effect' && !getEffect(s.effect)) return 'An effect it uses is not available.';
    if (s.type === 'command' && !RECORDABLE_COMMANDS[s.command]?.batch) return 'It uses an editor command that Batch Process cannot run.';
  }
  return '';
}

/**
 * Applies steps to a whole state (Batch Process). The selection starts as the
 * whole file; recorded selections replace it, and each step leaves the
 * selection where the editor would.
 */
export async function applyStepsToState(steps, state, { signal, onProgress, doc = null, applyChain } = {}) {
  const problem = batchStepsProblem(steps);
  if (problem) throw new UserError(problem);
  let sel = null;
  for (const [i, step] of steps.entries()) {
    const length = len(state);
    const placed = placeSelection(step.select, length, state.sampleRate);
    if (placed) sel = placed;
    const empty = !sel || sel[1] <= sel[0];
    const progress = (f) => onProgress?.((i + f) / steps.length);
    if (step.type === 'effect') {
      const def = getEffect(step.effect);
      if (def.needsNoisePrint && !doc?.noisePrint) throw new UserError(`${def.name} needs a captured noise print, which a batch cannot provide.`);
      if (def.needsSoundModel && !doc?.soundModel) throw new UserError(`${def.name} needs a learned sound model, which a batch cannot provide.`);
      const [a, b] = empty ? [0, length] : sel;
      const r = await renderEffect({ def, values: normalizeValues(def, step.values), state, start: a, end: b, signal, onProgress: progress, doc, applyChain });
      state = r.state;
      if (!empty) sel = [a, a + r.length];
    } else {
      const cmd = RECORDABLE_COMMANDS[step.command];
      if (cmd.selection && empty) continue; // needs a selection, as in the editor
      const insert = step.command === 'edit.insertSilence';
      const [a, b] = insert ? [sel ? sel[0] : 0, sel ? sel[0] : 0] : empty ? [0, length] : sel;
      const r = cmd.batch(state, step.args, a, b);
      state = r.state;
      if (r.start != null && (insert || !empty)) sel = [r.start, r.end];
    }
    progress(1);
  }
  return state;
}
