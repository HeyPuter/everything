// The document store: the current project, its undo history and the view
// state that is not part of the history (selected pattern and channels).
//
//   store.apply('Add note', (p) => edits.addNotes(p, ...))   one undo step
//   store.begin('Move notes'); store.preview(fn)...; store.commit()   drags
//
// Every change emits 'change' (project, previous, { label, source }) where
// source is 'edit' | 'preview' | 'undo' | 'redo' | 'load'. Views compare
// references (project.channels !== previous.channels) to decide what to redraw.

import { Emitter } from '../lib/emitter.js';
import { createProject, patternById } from './project.js';

const LIMIT = 300;

export class Store extends Emitter {
  constructor(project = createProject()) {
    super();
    this.project = project;
    this.undoStack = []; // { project, label, view }
    this.redoStack = [];
    this.gesture = null; // { label, start }
    this.dirty = false;
    this.view = {
      pattern: project.patterns[0]?.id ?? null,
      channel: project.channels[0]?.id ?? null, // the channel the piano roll edits
      selectedChannels: new Set(project.channels[0] ? [project.channels[0].id] : []),
    };
  }

  /** Replaces the whole document (open, new) and clears the history. */
  load(project) {
    const prev = this.project;
    this.project = project;
    this.undoStack = [];
    this.redoStack = [];
    this.gesture = null;
    this.dirty = false;
    this.view.pattern = project.ui?.pattern && patternById(project, project.ui.pattern) ? project.ui.pattern : project.patterns[0]?.id ?? null;
    this.view.channel = project.channels[0]?.id ?? null;
    this.view.selectedChannels = new Set(this.view.channel ? [this.view.channel] : []);
    this.emit('change', project, prev, { label: 'Open', source: 'load' });
    this.emit('view');
  }

  /**
   * Runs `fn(project)` and records one undo step. `fn` may return a project
   * or an object { project, ...extra }; the extra fields are returned.
   */
  apply(label, fn) {
    if (this.gesture) this.commit();
    const prev = this.project;
    const out = fn(prev);
    const next = out && out.project && out.version === undefined ? out.project : out;
    if (!next || next === prev) return out;
    this.undoStack.push({ project: prev, label, view: this.#viewSnapshot() });
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.project = next;
    this.dirty = true;
    this.#fixView();
    this.emit('change', next, prev, { label, source: 'edit' });
    return out;
  }

  /** Starts a continuous gesture (drag): previews are merged into one undo step. */
  begin(label) {
    if (this.gesture) this.commit();
    this.gesture = { label, start: this.project, view: this.#viewSnapshot() };
  }

  /** Applies `fn` relative to the gesture's start state (so drags never accumulate rounding). */
  preview(fn, { fromStart = true } = {}) {
    if (!this.gesture) this.begin('Edit');
    const prev = this.project;
    const base = fromStart ? this.gesture.start : prev;
    const out = fn(base);
    const next = out && out.project && out.version === undefined ? out.project : out;
    if (!next || next === prev) return out;
    this.project = next;
    this.#fixView();
    this.emit('change', next, prev, { label: this.gesture.label, source: 'preview' });
    return out;
  }

  /** Ends the gesture, recording one undo step if the project changed. */
  commit() {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    if (this.project === g.start) return;
    this.undoStack.push({ project: g.start, label: g.label, view: g.view });
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
    this.emit('change', this.project, this.project, { label: g.label, source: 'edit' });
  }

  /** Abandons the gesture and restores its start state. */
  cancel() {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    const prev = this.project;
    this.project = g.start;
    if (prev === g.start) return;
    // The preview may have selected things the start state does not have.
    const before = `${this.view.pattern}|${this.view.channel}`;
    this.#fixView();
    this.emit('change', g.start, prev, { label: g.label, source: 'undo' });
    if (`${this.view.pattern}|${this.view.channel}` !== before) this.emit('view');
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  get undoLabel() {
    return this.undoStack.at(-1)?.label || '';
  }

  get redoLabel() {
    return this.redoStack.at(-1)?.label || '';
  }

  undo() {
    if (this.gesture) this.commit();
    const step = this.undoStack.pop();
    if (!step) return null;
    const prev = this.project;
    this.redoStack.push({ project: prev, label: step.label, view: this.#viewSnapshot() });
    this.project = step.project;
    this.dirty = true;
    this.#restoreView(step.view);
    this.emit('change', this.project, prev, { label: step.label, source: 'undo' });
    return step.label;
  }

  redo() {
    const step = this.redoStack.pop();
    if (!step) return null;
    const prev = this.project;
    this.undoStack.push({ project: prev, label: step.label, view: this.#viewSnapshot() });
    this.project = step.project;
    this.dirty = true;
    this.#restoreView(step.view);
    this.emit('change', this.project, prev, { label: step.label, source: 'redo' });
    return step.label;
  }

  /** Jumps to a point in the history (the undo history panel). `index` counts undo steps kept. */
  jumpTo(index) {
    while (this.undoStack.length > index && this.canUndo) this.undo();
    while (this.undoStack.length < index && this.canRedo) this.redo();
  }

  markSaved() {
    this.dirty = false;
    this.emit('saved');
  }

  // ---------------------------------------------------------------- view

  setPattern(id) {
    if (this.view.pattern === id || !patternById(this.project, id)) return;
    this.view.pattern = id;
    this.emit('view');
  }

  get pattern() {
    return patternById(this.project, this.view.pattern) || this.project.patterns[0];
  }

  /** Selects channels in the rack. `channel` (the piano roll target) follows the last one. */
  selectChannels(ids, { primary } = {}) {
    this.view.selectedChannels = new Set(ids);
    const p = primary ?? ids.at?.(-1) ?? [...ids].at(-1);
    if (p) this.view.channel = p;
    this.emit('view');
  }

  setChannel(id) {
    if (this.view.channel === id) return;
    this.view.channel = id;
    this.emit('view');
  }

  get channel() {
    return this.project.channels.find((c) => c.id === this.view.channel) || this.project.channels[0] || null;
  }

  #viewSnapshot() {
    return { pattern: this.view.pattern, channel: this.view.channel };
  }

  #restoreView(v) {
    if (v?.pattern && patternById(this.project, v.pattern)) this.view.pattern = v.pattern;
    if (v?.channel && this.project.channels.some((c) => c.id === v.channel)) this.view.channel = v.channel;
    this.#fixView();
    this.emit('view');
  }

  // Keeps the view pointing at things that still exist.
  #fixView() {
    const p = this.project;
    if (!patternById(p, this.view.pattern)) this.view.pattern = p.patterns[0]?.id ?? null;
    if (!p.channels.some((c) => c.id === this.view.channel)) this.view.channel = p.channels[0]?.id ?? null;
    const ids = new Set(p.channels.map((c) => c.id));
    for (const id of this.view.selectedChannels) if (!ids.has(id)) this.view.selectedChannels.delete(id);
  }
}
