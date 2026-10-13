/**
 * Editor state: the open project plus selection, playhead and editing
 * toggles. Every project edit goes through update() so it is undoable,
 * autosaved and broadcast to the views.
 *
 * Events:
 *   change  { label, structural }   project edited (or undo/redo)
 *   select  { ids }                 selection changed
 *   time    { time }                playhead moved
 *   toggles {}                      ripple/snap/linkOverlays/hover preview changed
 *   nest    { depth }               a compound clip was opened or closed
 *   timeline { id }                 another of the project's timelines was opened
 *   history { label }               undo steps were regrouped (endBatch)
 */
import { Emitter } from '../lib/emitter.js';
import { History } from './history.js';
import { projectDuration, findClip, pruneTracks, cleanupTransitions, resolveOverlaps, MIN_CLIP, sequenceLength } from './timeline.js';
import { switchTimeline } from './timelines.js';

export class EditorStore extends Emitter {
  constructor(project, { toggles } = {}) {
    super();
    this.project = project;
    this.history = new History();
    this.selection = new Set();
    this.transition = null; // clip id whose outgoing transition is selected
    this.time = 0;
    this.toggles = { ripple: true, snap: true, linkOverlays: true, hoverPreview: false, ...toggles };
    this.revision = 0;
    this.savedRevision = 0;
    this._coalesce = null;
    // Compound clips opened for editing, outermost first: { outer, history, id, time }.
    this.nest = [];
    // Playhead of each timeline left, to come back to.
    this._timelineTimes = new Map();
  }

  /**
   * Open another of the project's timelines. Compound clips being edited
   * are closed first. Opening isn't an undo step: undo keeps one history for
   * the whole project and goes back to the timeline an edit was made on.
   */
  openTimeline(id) {
    while (this.nest.length) this.closeCompound();
    const from = this.project.timelineId;
    if (!id || id === from) return false;
    if (!switchTimeline(this.project, id)) return false;
    this._timelineTimes.set(from, this.time);
    this.project.modified = Date.now();
    this._afterSwap(this._timelineTimes.get(id) || 0, 'Open timeline');
    this.emit('timeline', { id });
    return true;
  }

  /** Name of the compound clip being edited (innermost), or null. */
  get compoundName() {
    const f = this.nest.at(-1);
    return f ? findClip(f.outer, f.id)?.clip.name || 'Compound clip' : null;
  }

  /**
   * Edit a compound clip's own timeline: the editor switches to its tracks
   * (sharing the project's media and settings) with a history of its own.
   */
  openCompound(id) {
    const f = findClip(this.project, id);
    if (!f || f.clip.type !== 'compound') return false;
    const outer = this.project;
    const c = f.clip;
    this.nest.push({ outer, history: this.history, id, time: this.time });
    this.project = { ...outer, tracks: structuredClone(c.sequence.tracks), markers: [], range: undefined, transcript: undefined, guides: undefined };
    delete this.project.range;
    delete this.project.transcript;
    delete this.project.guides;
    this.history = new History();
    this._afterSwap(Math.max(0, this.time - c.start + c.in));
    return true;
  }

  /** Back to the timeline holding the compound clip; edits made inside become one undo step there. */
  closeCompound() {
    const frame = this.nest.pop();
    if (!frame) return false;
    const inner = this.project;
    const changed = this.history.canUndo();
    this.project = frame.outer;
    this.history = frame.history;
    const c = findClip(this.project, frame.id)?.clip;
    let t = frame.time;
    if (c) t = c.start + Math.max(0, Math.min(c.duration, this.time - c.in));
    if (changed && c) {
      this.update('Edit compound clip', (p) => {
        const cc = findClip(p, frame.id)?.clip;
        if (!cc) return false;
        cc.sequence = { tracks: structuredClone(inner.tracks) };
        const len = sequenceLength(cc.sequence);
        cc.in = Math.min(cc.in, Math.max(0, len - MIN_CLIP));
        cc.duration = Math.max(MIN_CLIP, Math.min(cc.duration, len - cc.in));
      });
    }
    this._afterSwap(t);
    return true;
  }

  /** The whole project to save: compounds being edited get their current contents. */
  projectForSave() {
    if (!this.nest.length) return structuredClone(this.project);
    let inner = this.project;
    for (let i = this.nest.length - 1; i >= 0; i--) {
      const outer = structuredClone(this.nest[i].outer);
      const c = findClip(outer, this.nest[i].id)?.clip;
      if (c) c.sequence = { tracks: structuredClone(inner.tracks) };
      inner = outer;
    }
    return inner;
  }

  _afterSwap(time, label = 'Open compound clip') {
    this._coalesce = null;
    this.selection.clear();
    this.transition = null;
    this.revision++;
    this.emit('change', { label, structural: true, restore: true });
    this.emit('select', { ids: [] });
    this.emit('nest', { depth: this.nest.length });
    this.time = -1;
    this.seek(time);
  }

  get duration() {
    return projectDuration(this.project);
  }

  get fps() {
    return this.project.settings.fps;
  }

  /** Options timeline operations need. */
  get opts() {
    return { ripple: this.toggles.ripple, linkOverlays: this.toggles.linkOverlays };
  }

  /**
   * Apply an edit. fn(project) mutates the project; return false to cancel
   * (nothing is recorded). opts.coalesce merges consecutive edits with the
   * same key (slider drags) into one undo step.
   */
  update(label, fn, opts = {}) {
    const now = performance.now();
    const merge = opts.coalesce && this._coalesce && this._coalesce.key === opts.coalesce && now - this._coalesce.at < 1200;
    const before = merge ? null : structuredClone(this.project);
    let result;
    try {
      result = fn(this.project);
    } catch (err) {
      if (before) this.project = before;
      throw err;
    }
    if (result === false) {
      if (before) this.project = before;
      return false;
    }
    if (opts.structural !== false) {
      cleanupTransitions(this.project);
      if (!opts.keepEmptyTracks) {
        resolveOverlaps(this.project);
        pruneTracks(this.project);
      }
    }
    if (before) this.history.push(before, label);
    this._coalesce = opts.coalesce ? { key: opts.coalesce, at: now } : null;
    this.project.modified = Date.now();
    this.revision++;
    // Drop selected ids that no longer exist.
    this._dropStaleSelection();
    this.emit('change', { label, structural: opts.structural !== false });
    return result === undefined ? true : result;
  }

  /** End a coalescing run so the next edit starts a new undo step. */
  seal() {
    this._coalesce = null;
  }

  /**
   * Start grouping edits: everything recorded until endBatch(mark, label)
   * becomes one undo step. Returns the mark to pass to endBatch.
   */
  beginBatch() {
    this.seal();
    return this.history.mark();
  }

  /** Fold the edits since beginBatch() into one undo step; returns that step or null. */
  endBatch(mark, label) {
    this.seal();
    const entry = this.history.fold(mark, label);
    if (entry) this.emit('history', { label: entry.label });
    return entry;
  }

  undo() {
    const entry = this.history.undo(structuredClone(this.project));
    if (!entry) return null;
    this.project = entry.snapshot;
    this._afterRestore(entry.label);
    return entry.label;
  }

  redo() {
    const entry = this.history.redo(structuredClone(this.project));
    if (!entry) return null;
    this.project = entry.snapshot;
    this._afterRestore(entry.label);
    return entry.label;
  }

  _afterRestore(label) {
    this._coalesce = null;
    this.revision++;
    this.project.modified = Date.now();
    this._dropStaleSelection();
    this.emit('change', { label, structural: true, restore: true });
    this.emit('select', { ids: [...this.selection] });
  }

  /** Forget selected clips and the selected transition when they no longer exist. */
  _dropStaleSelection() {
    for (const id of this.selection) if (!findClip(this.project, id)) this.selection.delete(id);
    if (this.transition && !findClip(this.project, this.transition)?.clip.transition) this.transition = null;
  }

  /** Replace the whole project (open or import); clears history. */
  load(project) {
    this.project = project;
    this.history.clear();
    this.selection.clear();
    this.transition = null;
    this.time = 0;
    this.revision++;
    this.savedRevision = this.revision;
    this.emit('change', { label: 'Open', structural: true, restore: true });
    this.emit('select', { ids: [] });
    this.emit('time', { time: 0 });
  }

  get dirty() {
    return this.revision !== this.savedRevision;
  }

  /** Select the transition after clipId (shown in the details panel). */
  selectTransition(clipId) {
    this.selection.clear();
    this.transition = clipId;
    this.emit('select', { ids: [], transition: clipId });
  }

  select(ids, { add = false, toggle = false } = {}) {
    this.transition = null;
    const list = Array.isArray(ids) ? ids : ids ? [ids] : [];
    if (!add && !toggle) this.selection.clear();
    for (const id of list) {
      if (toggle && this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
    }
    this.emit('select', { ids: [...this.selection] });
  }

  clearSelection() {
    if (!this.selection.size && !this.transition) return;
    this.selection.clear();
    this.transition = null;
    this.emit('select', { ids: [] });
  }

  /** The single selected clip, or null. */
  get selected() {
    if (this.selection.size !== 1) return null;
    const [id] = this.selection;
    return findClip(this.project, id);
  }

  get selectedIds() {
    return [...this.selection];
  }

  seek(t) {
    const max = Math.max(0, this.duration);
    const time = Math.round(Math.min(Math.max(0, t), max));
    if (time === this.time) return;
    this.time = time;
    this.emit('time', { time });
  }

  setToggle(name, value) {
    this.toggles[name] = value;
    this.emit('toggles', { name, value });
  }
}
