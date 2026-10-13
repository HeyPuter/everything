/**
 * Actions: recorded sequences of edits that play back on the current
 * selection, in one document or every open document.
 *
 *   set     { id, name, actions: [action] }
 *   action  { id, name, shortcut?, color?, steps: [step] }
 *   step    { id, kind, on, modal, label, ... }
 *     kind 'command'    cmd, args, dialogs: [{ title, value }]  (a menu command
 *                       and the values entered in the dialogs it opened)
 *     kind 'style'      patch                (a paint or appearance change)
 *     kind 'transform'  m: [a, b, c, d], d: [dx, dy], copy, opts
 *                       (a move, rotation, scale... made with a tool or the
 *                       arrow keys, relative to the selection's center)
 *     kind 'stop'       message, canContinue (pause with a message)
 *     kind 'select'     name                 (select the objects with this name
 *                       or note: Select Object)
 *     kind 'path'       sub, layer?          (Insert Selected Path: add a copy of
 *                       the recorded paths and select them)
 *
 * Playback Options (prefs 'actionPlayback'): 'accelerated' plays steps
 * back to back, 'step' lets the document redraw between steps, 'pause'
 * waits `pause` seconds between steps.
 *
 * Steps turned off are skipped. A step with `modal` on shows its dialogs,
 * prefilled with the recorded values; with `modal` off they are applied
 * without showing. Dialogs that return something other than plain data are
 * always shown (`interactive`).
 *
 * Recording observes the app: commands run at the top level (not commands
 * run by other commands), dialogs through ui/dialogs/dialog.js
 * `dialogHooks`, paint changes through ops/paint-ops.js `paintHooks`, and
 * transforms through the editor's `lastTransform` after each undo step.
 * Sets persist in preferences ('actionSets').
 */
import { uid } from '../../lib/ids.js';
import { UserError } from '../../lib/errors.js';
import { multiply, translate } from '../../lib/matrix.js';
import { dialogHooks } from '../../ui/dialogs/dialog.js';
import { paintHooks, applyStyle } from '../../ops/paint-ops.js';
import { transformNodes } from '../../model/geometry.js';
import { createEffect } from '../paint/effects-model.js';

export const ACTIONS_FORMAT = 'vector-studio-actions';
export const PREF_KEY = 'actionSets';

/** Commands that change the workspace rather than artwork are not recorded. */
const IGNORED = [/^panel\./, /^window\./, /^theme\./, /^help\./, /^view\./, /^actions\./, /^file\./, /^edit\.(undo|redo|preferences|keyboardShortcuts|exportSettings|importSettings)$/];
export const isRecordable = (id) => !IGNORED.some((re) => re.test(id));

/** JSON-safe data (what a recorded dialog value must be to replay without the dialog). */
export function isPlain(v, depth = 0) {
  if (depth > 20) return false;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isPlain(x, depth + 1));
  if (typeof v === 'object') return Object.getPrototypeOf(v) === Object.prototype && Object.values(v).every((x) => x === undefined || isPlain(x, depth + 1));
  return false;
}

const step = (kind, extra) => ({ id: uid('st'), kind, on: true, modal: false, ...extra });
const cmd = (c, label, extra = {}) => step('command', { cmd: c, label, args: null, dialogs: [], ...extra });
const dlg = (title, value) => ({ title, value });

/** The built-in set (original actions, restored by Reset Actions). */
export function defaultSets() {
  const solid = (color) => ({ type: 'solid', color });
  return [
    {
      id: 'set-default',
      name: 'Default Actions',
      actions: [
        { id: 'act-center', name: 'Center on Artboard', steps: [cmd('align.toArtboard', 'Align To Artboard'), cmd('align.center', 'Horizontal & Vertical Align Center'), cmd('align.toSelection', 'Align To Selection')] },
        { id: 'act-offset', name: 'Duplicate and Offset', steps: [cmd('edit.copy', 'Copy'), cmd('edit.pasteFront', 'Paste in Front'), cmd('object.transform.move', 'Move', { dialogs: [dlg('Move', { dx: 12, dy: 12, preview: false })] })] },
        { id: 'act-rotate45', name: 'Rotate 45°', steps: [cmd('object.transform.rotate', 'Rotate', { dialogs: [dlg('Rotate', { angle: 45, preview: false })] })] },
        { id: 'act-half', name: 'Scale to 50%', steps: [cmd('object.transform.scale', 'Scale', { dialogs: [dlg('Scale', { uniform: true, uniformPct: 50, sx: 50, sy: 50, corners: false, strokes: true, preview: false })] })] },
        { id: 'act-mirror', name: 'Mirror Copy', steps: [cmd('edit.copy', 'Copy'), cmd('edit.pasteFront', 'Paste in Front'), cmd('object.flipH', 'Flip Horizontal')] },
        { id: 'act-gray', name: 'Grayscale Copy', steps: [cmd('edit.copy', 'Copy'), cmd('edit.pasteFront', 'Paste in Front'), cmd('color.grayscale', 'Convert to Grayscale')] },
        { id: 'act-hairline', name: 'Hairline Outline', steps: [step('style', { label: 'Set Appearance', patch: { fill: null, stroke: solid('#1f1f1f'), strokeWidth: 0.25 } })] },
        { id: 'act-shadow', name: 'Soft Drop Shadow', steps: [step('style', { label: 'Set Appearance', patch: { effects: [createEffect('dropShadow', { x: 3, y: 4, blur: 6, opacity: 0.3 })] } })] },
        { id: 'act-trim', name: 'Trim Marks Around Selection', steps: [cmd('object.trimMarks', 'Create Trim Marks')] },
        { id: 'act-focus', name: 'Focus on Selection', steps: [cmd('object.lockOthers', 'Lock Others'), cmd('object.hideAbove', 'Hide All Artwork Above')] },
        { id: 'act-assets', name: 'Collect as Assets', steps: [cmd('assetExport.multiple', 'As Multiple Assets')] },
        { id: 'act-two', name: 'Reduce to Two Colors', steps: [cmd('color.preset.two', '2 Colors', { modal: true })] },
      ],
    },
  ];
}

// ---- storage ----

export function loadSets(prefs) {
  const v = prefs.get(PREF_KEY);
  return Array.isArray(v) ? structuredClone(v) : defaultSets();
}

export function saveSets(prefs, sets) {
  prefs.set(PREF_KEY, structuredClone(sets));
}

/** Sets as a file. */
export function exportSetsData(sets) {
  return { format: ACTIONS_FORMAT, version: 1, sets: structuredClone(sets) };
}

/** Sets from a file, with fresh ids so they never clash with existing ones. */
export function parseSetsData(data) {
  if (!data || data.format !== ACTIONS_FORMAT || !Array.isArray(data.sets)) throw new UserError('This file does not contain Vector Studio actions.');
  return data.sets.map((s) => ({
    id: uid('set'),
    name: String(s.name || 'Imported Set'),
    actions: (s.actions || []).map((a) => ({
      id: uid('act'),
      name: String(a.name || 'Action'),
      ...(a.color ? { color: String(a.color) } : {}),
      steps: (a.steps || []).filter((st) => st && ['command', 'style', 'transform', 'stop', 'select', 'path'].includes(st.kind)).map((st) => ({ ...structuredClone(st), id: uid('st'), on: st.on !== false, modal: Boolean(st.modal) })),
    })),
  }));
}

export function findAction(sets, actionId) {
  for (const set of sets) {
    const action = set.actions.find((a) => a.id === actionId);
    if (action) return { set, action };
  }
  return null;
}

// ---- labels ----

function describeValue(v) {
  if (v === true) return 'on';
  if (v === false) return 'off';
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return `${v.length} items`;
  if (v && typeof v === 'object') return '...';
  return String(v);
}

/** A one-line description of what a step does, for the panel. */
export function stepDetail(st) {
  if (st.kind === 'command') {
    const parts = [];
    for (const d of st.dialogs || []) {
      if (!d.value || typeof d.value !== 'object') continue;
      for (const [k, v] of Object.entries(d.value)) if (k !== 'preview' && !k.startsWith('__') && v !== undefined) parts.push(`${k}: ${describeValue(v)}`);
    }
    return parts.join(', ');
  }
  if (st.kind === 'style') return Object.keys(st.patch || {}).join(', ');
  if (st.kind === 'transform') {
    const [a, b] = st.m;
    const rot = Math.round((-Math.atan2(b, a) * 180) / Math.PI * 100) / 100;
    const sc = Math.round(Math.hypot(a, b) * 1000) / 10;
    const out = [];
    if (Math.abs(st.d[0]) > 1e-6 || Math.abs(st.d[1]) > 1e-6) out.push(`move ${Math.round(st.d[0] * 100) / 100}, ${Math.round(st.d[1] * 100) / 100}`);
    if (rot) out.push(`rotate ${rot}°`);
    if (Math.abs(sc - 100) > 0.05) out.push(`scale ${sc}%`);
    if (st.copy) out.push('copy');
    return out.join(', ');
  }
  if (st.kind === 'stop') return st.message || '';
  if (st.kind === 'select') return st.name || '';
  if (st.kind === 'path') return `${st.subs?.length || 0} path${st.subs?.length === 1 ? '' : 's'}`;
  return '';
}

/** Objects whose name or note is `name` (Select Object steps), visible and unlocked. */
export function objectsNamed(doc, name) {
  const out = [];
  if (!name) return out;
  doc.walk((n) => {
    if (n.hidden || n.locked) return false;
    if (n.type !== 'layer' && (n.name === name || n.notes === name)) {
      out.push(n.id);
      return false;
    }
    return true;
  });
  return out;
}

/** Playback Options with defaults. */
export function playbackOptions(prefs) {
  return { mode: 'accelerated', pause: 1, ...(prefs?.get('actionPlayback') || {}) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Does replaying this step involve a dialog that can be shown or skipped? */
export function hasDialog(st) {
  return st.kind === 'command' && ((st.dialogs && st.dialogs.length > 0) || st.interactive);
}

// ---- relative transforms ----

/** Express a document matrix relative to a center point: { m: [a, b, c, d], d: [dx, dy] }. */
export function relativeTransform(M, c) {
  const [a, b, cc, d, e, f] = M;
  return { m: [a, b, cc, d], d: [a * c.x + cc * c.y + e - c.x, b * c.x + d * c.y + f - c.y] };
}

/** The document matrix for a relative transform around a center point. */
export function absoluteTransform(st, c) {
  const [a, b, cc, d] = st.m;
  return multiply(translate(c.x + st.d[0], c.y + st.d[1]), multiply([a, b, cc, d, 0, 0], translate(-c.x, -c.y)));
}

function selectionCenter(editor) {
  const b = editor?.selectionBounds(false);
  return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
}

// ---- recording and playback ----

/**
 * The recorder and player for one app. `onChange` runs when the sets or the
 * recording state change (the panel re-renders).
 */
export class ActionEngine {
  constructor(app, { onChange = () => {} } = {}) {
    this.app = app;
    this.onChange = onChange;
    this.sets = loadSets(app.prefs);
    this.recording = null; // { action, set }
    this.playing = false;
    this.depth = 0;
    this.current = null; // the command step being recorded
    this.queue = null; // dialogs to replay: { entries, modal }
    this.#install();
  }

  save() {
    saveSets(this.app.prefs, this.sets);
    this.onChange();
  }

  /** Reload from preferences (after Import Settings). */
  reload() {
    this.sets = loadSets(this.app.prefs);
    this.onChange();
  }

  #install() {
    const app = this.app;
    const commands = app.commands;
    const run = commands.run.bind(commands);
    commands.run = async (id, args) => {
      if (!this.recording || this.depth > 0 || this.playing || !isRecordable(id) || !commands.isEnabled(id, args)) {
        this.depth++;
        try {
          return await run(id, args);
        } finally {
          this.depth--;
        }
      }
      const st = cmd(id, String(commands.label(id) || id).replace(/\.\.\.$/, ''), { args: isPlain(args ?? null) ? (args ?? null) : null });
      this.current = st;
      this.depth++;
      let result;
      try {
        result = await run(id, args);
      } finally {
        this.depth--;
        this.current = null;
      }
      if (!st.cancelled) this.#append(st);
      return result;
    };

    const prevOpen = dialogHooks.open;
    dialogHooks.open = (opts, show) => {
      const next = (o) => (prevOpen ? prevOpen(o, show) : show(o));
      if (this.queue) return this.#replayDialog(opts, next);
      if (!this.current) return next(opts);
      const st = this.current;
      return Promise.resolve(next(opts)).then((value) => {
        // A cancelled dialog means the command changed nothing: the step is dropped.
        if (value === null || value === undefined || value === false) st.cancelled = true;
        else if (isPlain(value)) st.dialogs.push({ title: opts.title || '', value: structuredClone(value) });
        else {
          // Not replayable without the dialog: it always shows.
          st.interactive = true;
          st.modal = true;
        }
        return value;
      });
    };
    const prevFields = dialogHooks.fields;
    dialogHooks.fields = (title, fields) => {
      const base = prevFields?.(title, fields) || fields;
      const rec = this.queue?.entries.find((d) => d.title === title && !d.used);
      if (!rec || !rec.value || typeof rec.value !== 'object') return base;
      return base.map((f) => (f.key && f.key in rec.value ? { ...f, value: rec.value[f.key] } : f));
    };

    const prevStyle = paintHooks.applyStyle;
    paintHooks.applyStyle = (editor, patch, label, coalesce) => {
      if (this.recording && this.depth === 0 && !this.playing && isPlain(patch)) this.#recordStyle(patch, label);
      return prevStyle ? prevStyle(editor, patch, label, coalesce) : false;
    };

    // Transforms made with tools and the arrow keys, observed per document.
    const watched = new WeakSet();
    const watch = (ed) => {
      if (!ed || watched.has(ed)) return;
      watched.add(ed);
      ed.lastTransformSeen = ed.lastTransform;
      ed.on('selection', () => {
        if (!ed.doc.tx) ed.actionCenter = selectionCenter(ed);
      });
      // Checked after the undo step's own code finished: tools set lastTransform right after they commit.
      ed.doc.on('history', () =>
        queueMicrotask(() => {
          const t = ed.lastTransform;
          if (t !== ed.lastTransformSeen) {
            ed.lastTransformSeen = t;
            if (this.recording && this.depth === 0 && !this.playing && t?.matrix && ed === app.editor) {
              const c = ed.actionCenter || selectionCenter(ed);
              if (c) this.#append(step('transform', { label: t.copy ? 'Transform Copy' : 'Transform', ...relativeTransform(t.matrix, c), copy: Boolean(t.copy), opts: isPlain(t.opts ?? null) ? t.opts || null : null }));
            }
          }
          ed.actionCenter = selectionCenter(ed);
        }),
      );
      ed.actionCenter = selectionCenter(ed);
    };
    app.on('active-editor', watch);
    for (const ed of app.editors) watch(ed);
  }

  #append(st) {
    if (!this.recording) return;
    this.recording.action.steps.push(st);
    this.save();
  }

  #recordStyle(patch, label) {
    const steps = this.recording.action.steps;
    const last = steps[steps.length - 1];
    const keys = Object.keys(patch).sort().join(',');
    // Slider drags send many changes: keep only the last value of one gesture.
    if (last?.kind === 'style' && Object.keys(last.patch).sort().join(',') === keys && Date.now() - (last.time || 0) < 1500) {
      last.patch = structuredClone(patch);
      last.time = Date.now();
      this.save();
      return;
    }
    this.#append(step('style', { label: label || 'Set Appearance', patch: structuredClone(patch), time: Date.now() }));
  }

  #replayDialog(opts, next) {
    const q = this.queue;
    const rec = q.entries.find((d) => d.title === (opts.title || '') && !d.used) || (q.entries.length === 1 && !q.entries[0].used ? q.entries[0] : null);
    if (!rec) return next(opts);
    if (q.modal || rec.value === undefined) {
      return Promise.resolve(next(opts)).then((v) => {
        rec.used = true;
        return v;
      });
    }
    rec.used = true;
    return Promise.resolve(structuredClone(rec.value));
  }

  // ---- recording ----

  startRecording(actionId) {
    const found = findAction(this.sets, actionId);
    if (!found) throw new UserError('Choose an action to record into.');
    this.recording = found;
    for (const ed of this.app.editors) ed.actionCenter = selectionCenter(ed);
    this.onChange();
  }

  stopRecording() {
    if (!this.recording) return;
    this.recording = null;
    this.save();
  }

  // ---- playback ----

  /**
   * Play an action on the active document from step `from`. Resolves to
   * { ok, done, stoppedAt?, message? }.
   */
  async play(actionId, { from = 0, only = null } = {}) {
    const found = findAction(this.sets, actionId);
    if (!found) throw new UserError('This action no longer exists.');
    if (this.playing) return { ok: false, done: 0, message: 'An action is already playing.' };
    const app = this.app;
    if (!app.editor) throw new UserError('Open a document to play an action.');
    const steps = only ? found.action.steps.filter((s) => only.includes(s.id)) : found.action.steps.slice(from);
    this.playing = true;
    let done = 0;
    try {
      for (const [i, st] of steps.entries()) {
        if (!st.on) continue;
        const res = await this.#playStep(st);
        if (res === 'stop') return { ok: false, done, stoppedAt: i };
        if (res === true && i < steps.length - 1) await this.#between();
        if (typeof res === 'string') {
          app.notify(`Action "${found.action.name}" stopped at step ${from + i + 1}: ${res}`, { error: true, timeout: 6000 });
          return { ok: false, done, stoppedAt: i, message: res };
        }
        done++;
      }
      return { ok: true, done };
    } finally {
      this.playing = false;
      this.queue = null;
    }
  }

  /** Play an action on every open document in turn. */
  async playOnAll(actionId) {
    const app = this.app;
    const back = app.editor;
    const results = [];
    for (const ed of [...app.editors]) {
      app.activate(ed);
      results.push(await this.play(actionId));
      if (results[results.length - 1].stoppedAt !== undefined && !results[results.length - 1].message) break;
    }
    if (back && app.editors.includes(back)) app.activate(back);
    return results;
  }

  /** The wait between steps that Playback Options asks for. */
  async #between() {
    const o = playbackOptions(this.app.prefs);
    if (o.mode === 'step') {
      this.app.editor?.invalidate?.();
      this.app.dock?.update();
      await sleep(120);
    } else if (o.mode === 'pause') await sleep(Math.max(0, Math.min(60, Number(o.pause) || 0)) * 1000);
  }

  async #playStep(st) {
    const app = this.app;
    const ed = app.editor;
    if (st.kind === 'select') {
      if (!ed) return 'No document.';
      const ids = objectsNamed(ed.doc, st.name);
      if (!ids.length) return `No object is named "${st.name}".`;
      ed.select(ids);
      return true;
    }
    if (st.kind === 'path') {
      if (!ed) return 'No document.';
      const target = ed.targetLayer();
      if (!target || ed.doc.isLocked(target.id) || ed.doc.isHidden(target.id)) return 'The current layer is locked or hidden.';
      const out = [];
      ed.doc.transact(st.label || 'Insert Path', () => {
        for (const sub of st.subs || []) out.push(ed.doc.importSubtree(sub, target.id).id);
      });
      ed.select(out);
      return true;
    }
    if (st.kind === 'command') {
      const c = app.commands.get(st.cmd);
      if (!c) return `"${st.label}" is not available.`;
      if (!app.commands.isEnabled(st.cmd, st.args ?? undefined)) return `"${st.label}" cannot be used with the current selection.`;
      this.queue = { entries: (st.dialogs || []).map((d) => ({ ...d, used: false })), modal: Boolean(st.modal) };
      try {
        await app.commands.run(st.cmd, st.args ?? undefined);
      } finally {
        this.queue = null;
      }
      return true;
    }
    if (st.kind === 'style') {
      if (!ed) return 'No document.';
      applyStyle(ed, structuredClone(st.patch), st.label || 'Set Appearance');
      return true;
    }
    if (st.kind === 'transform') {
      if (!ed?.selection.size) return 'Select objects to transform.';
      const c = selectionCenter(ed);
      const m = absoluteTransform(st, c);
      const opts = st.opts || { scaleStrokes: app.prefs.get('scaleStrokes'), scaleCorners: app.prefs.get('scaleCorners') };
      ed.doc.transact(st.label || 'Transform', () => {
        let ids = ed.topSelection();
        if (st.copy) {
          const out = [];
          for (const id of ids) {
            const n = ed.doc.get(id);
            const parent = ed.doc.get(n.parent);
            const { node, descendants } = ed.doc.cloneSubtree(id);
            ed.doc.insert(node, parent.id, parent.children.indexOf(id) + 1, descendants);
            out.push(node.id);
          }
          ids = out;
          ed.select(out);
        }
        transformNodes(ed.doc, ids, m, opts);
      });
      ed.lastTransform = { matrix: m, copy: Boolean(st.copy), opts };
      return true;
    }
    if (st.kind === 'stop') {
      const go = await app.dialogs.open({
        title: 'Action Paused',
        body: (() => {
          const p = document.createElement('p');
          p.className = 'dialog-message';
          p.textContent = st.message || 'The action is paused.';
          return p;
        })(),
        buttons: [{ label: 'Stop', value: false }, ...(st.canContinue !== false ? [{ label: 'Continue', value: true, primary: true }] : [])],
      });
      return go ? true : 'stop';
    }
    return true;
  }
}
