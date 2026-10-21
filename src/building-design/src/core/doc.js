/**
 * The project document: one store of items keyed by id. Every item has a
 * `kind` (wall, door, level, wallType, plan, sheet, ...). Items are treated
 * as immutable: an update replaces the object, so caches keyed by item
 * objects invalidate themselves.
 *
 * All edits happen inside a transaction, which becomes one undo step.
 * Previews (dragging, live edits) apply changes without recording an undo
 * step until they are committed.
 */
import { DEFAULT_UNITS } from './units.js';

export const FORMAT = 'building-design';
export const FORMAT_VERSION = 1;
const UNDO_LIMIT = 300;

const EMPTY = new Set();
let seq = 0;
const RAND = () => Math.random().toString(36).slice(2, 8);

export function newId(prefix = 'e') {
  seq = (seq + 1) % 1679616;
  return `${prefix}${Date.now().toString(36).slice(-5)}${seq.toString(36)}${RAND()}`;
}

export class Doc {
  constructor() {
    this.items = new Map();
    this.byKind = new Map();
    this.hostIndex = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.revision = 0;
    this.savedRevision = 0;
    this.tx = null;
    this.listeners = new Set();
  }

  // Events -------------------------------------------------------------------

  /** fn({ ids: Set, label, preview, undo, redo, meta }) after every change. */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(ev) {
    for (const fn of this.listeners) fn(ev);
  }

  get modified() {
    return this.revision !== this.savedRevision;
  }

  /** `rev` is the revision that was serialized, so edits made during a slow write stay unsaved. */
  markSaved(rev = this.revision) {
    this.savedRevision = rev;
  }

  // Queries -----------------------------------------------------------------

  get(id) {
    return id == null ? undefined : this.items.get(id);
  }

  has(id) {
    return this.items.has(id);
  }

  /** Items of one or more kinds, in insertion order. */
  all(...kinds) {
    const out = [];
    for (const k of kinds) {
      const ids = this.byKind.get(k);
      if (ids) for (const id of ids) out.push(this.items.get(id));
    }
    return out;
  }

  count(kind) {
    return this.byKind.get(kind)?.size ?? 0;
  }

  find(pred) {
    for (const it of this.items.values()) if (pred(it)) return it;
    return undefined;
  }

  filter(pred) {
    const out = [];
    for (const it of this.items.values()) if (pred(it)) out.push(it);
    return out;
  }

  levels() {
    return this.all('level').sort((a, b) => a.elevation - b.elevation);
  }

  /** The level directly above `levelId`, or null. */
  levelAbove(levelId) {
    const lv = this.levels();
    const i = lv.findIndex((l) => l.id === levelId);
    return i >= 0 ? lv[i + 1] ?? null : null;
  }

  // Transactions --------------------------------------------------------------

  /** Run fn inside one transaction (nested calls join the outer one). */
  transact(label, fn, meta) {
    if (this.tx) return fn();
    this.begin(label, meta);
    try {
      const r = fn();
      this.commit();
      return r;
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  begin(label, meta = {}) {
    if (this.tx) throw new Error('Transaction already open');
    this.tx = { label, meta, changes: new Map(), pending: new Set() };
  }

  get inTransaction() {
    return !!this.tx;
  }

  /** Publish the changes made so far in an open transaction (live preview). */
  flush() {
    if (!this.tx || !this.tx.pending.size) return;
    const ids = this.tx.pending;
    this.tx.pending = new Set();
    this.emit({ ids, label: this.tx.label, preview: true, meta: this.tx.meta });
  }

  commit() {
    const tx = this.tx;
    if (!tx) return false;
    this.tx = null;
    const changes = [];
    for (const [id, c] of tx.changes) {
      const after = this.items.get(id) ?? null;
      if (c.before === after) continue;
      changes.push([id, c.before, after]);
    }
    if (!changes.length) {
      if (tx.pending.size) this.emit({ ids: tx.pending, label: tx.label, meta: tx.meta });
      return false;
    }
    this.undoStack.push({ label: tx.label, changes });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.revision++;
    this.emit({ ids: new Set(changes.map((c) => c[0])), label: tx.label, meta: tx.meta });
    return true;
  }

  rollback() {
    const tx = this.tx;
    if (!tx) return;
    this.tx = null;
    const ids = new Set();
    for (const [id, c] of tx.changes) {
      this._put(id, c.before);
      ids.add(id);
    }
    if (ids.size) this.emit({ ids, label: tx.label, rollback: true, meta: tx.meta });
  }

  _record(id) {
    const tx = this.tx;
    if (!tx) throw new Error('Edits must happen inside a transaction');
    if (!tx.changes.has(id)) tx.changes.set(id, { before: this.items.get(id) ?? null });
    tx.pending.add(id);
  }

  /** Ids of items hosted by (doors and windows in) an element. */
  hosted(hostId) {
    return this.hostIndex.get(hostId) ?? EMPTY;
  }

  _put(id, item) {
    const prev = this.items.get(id);
    if (prev?.hostId && prev.hostId !== item?.hostId) this.hostIndex.get(prev.hostId)?.delete(id);
    if (item?.hostId) {
      let s = this.hostIndex.get(item.hostId);
      if (!s) this.hostIndex.set(item.hostId, (s = new Set()));
      s.add(id);
    }
    if (prev && (!item || prev.kind !== item.kind)) this.byKind.get(prev.kind)?.delete(id);
    if (item) {
      this.items.set(id, item);
      let set = this.byKind.get(item.kind);
      if (!set) this.byKind.set(item.kind, (set = new Set()));
      set.add(id);
    } else this.items.delete(id);
  }

  // Edits ---------------------------------------------------------------------

  add(item) {
    const it = Object.freeze({ ...item, id: item.id || newId(prefixFor(item.kind)) });
    if (!it.kind) throw new Error('Item needs a kind');
    this._record(it.id);
    this._put(it.id, it);
    return it;
  }

  /** Shallow-merge a patch into an item. Returns the new item. */
  update(id, patch) {
    const prev = this.items.get(id);
    if (!prev) return undefined;
    let changed = false;
    for (const k in patch) {
      if (prev[k] !== patch[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return prev;
    this._record(id);
    const next = Object.freeze({ ...prev, ...patch, id, kind: prev.kind });
    this._put(id, next);
    return next;
  }

  /** Replace an item wholesale (keeps id and kind). */
  replace(id, item) {
    const prev = this.items.get(id);
    if (!prev) return undefined;
    this._record(id);
    const next = Object.freeze({ ...item, id, kind: prev.kind });
    this._put(id, next);
    return next;
  }

  remove(id) {
    if (!this.items.has(id)) return false;
    this._record(id);
    this._put(id, null);
    return true;
  }

  // Undo ----------------------------------------------------------------------

  get canUndo() {
    return this.undoStack.length > 0 && !this.tx;
  }

  get canRedo() {
    return this.redoStack.length > 0 && !this.tx;
  }

  get undoLabel() {
    return this.undoStack.at(-1)?.label ?? '';
  }

  get redoLabel() {
    return this.redoStack.at(-1)?.label ?? '';
  }

  undo() {
    if (!this.canUndo) return null;
    const step = this.undoStack.pop();
    for (const [id, before] of step.changes) this._put(id, before);
    this.redoStack.push(step);
    this.revision++;
    this.emit({ ids: new Set(step.changes.map((c) => c[0])), label: step.label, undo: true });
    return step.label;
  }

  redo() {
    if (!this.canRedo) return null;
    const step = this.redoStack.pop();
    for (const [id, , after] of step.changes) this._put(id, after);
    this.undoStack.push(step);
    this.revision++;
    this.emit({ ids: new Set(step.changes.map((c) => c[0])), label: step.label, redo: true });
    return step.label;
  }

  clearHistory() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /** Project-level settings (info, units) change through a pseudo item so they undo too. */
  setInfo(patch) {
    this.transact('Project information', () => {
      const cur = this.get('project') || { id: 'project', kind: 'project' };
      if (!this.has('project')) this.add(cur);
      this.update('project', patch);
    });
  }

  // Serialization ---------------------------------------------------------------

  toJSON() {
    return {
      format: FORMAT,
      version: FORMAT_VERSION,
      items: [...this.items.values()],
    };
  }

  static fromJSON(data) {
    if (!data || data.format !== FORMAT) throw new Error('This file is not a Building Design project.');
    if (data.version > FORMAT_VERSION) throw new Error('This project was saved by a newer version of the app.');
    const doc = new Doc();
    for (const it of data.items || []) {
      if (!it || typeof it.id !== 'string' || typeof it.kind !== 'string') continue;
      doc._put(it.id, Object.freeze(it));
    }
    return doc;
  }

  /** Project information with defaults. */
  get project() {
    return { name: 'Untitled', number: '', client: '', address: '', author: '', status: '', units: DEFAULT_UNITS, ...(this.get('project') || {}) };
  }

  get units() {
    return this.get('project')?.units || DEFAULT_UNITS;
  }
}

function prefixFor(kind) {
  if (kind.endsWith('Type')) return 't';
  if (kind === 'material') return 'm';
  if (VIEW_KINDS.has(kind)) return 'v';
  return 'e';
}

export const VIEW_KINDS = new Set(['plan', 'ceilingPlan', 'areaPlan', 'view3d', 'elevation', 'section', 'schedule', 'sheet']);

/** Views drawn as plans of a level (2D, model cut at a height). */
export const PLAN_VIEW_KINDS = ['plan', 'ceilingPlan', 'areaPlan'];

export const VIEW_LABEL = { plan: 'Floor Plan', ceilingPlan: 'Ceiling Plan', areaPlan: 'Area Plan', view3d: '3D View', elevation: 'Elevation', section: 'Section', schedule: 'Schedule', sheet: 'Sheet' };

export function isView(item) {
  return !!item && VIEW_KINDS.has(item.kind);
}

export function isPlanView(item) {
  return !!item && PLAN_VIEW_KINDS.includes(item.kind);
}
