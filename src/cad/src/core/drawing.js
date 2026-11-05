/**
 * In-memory drawing with transactional edits and undo/redo.
 *
 * Entities are treated as immutable: an edit replaces the stored object with
 * a new one. That makes undo records cheap (before/after references) and
 * lets caches key on object identity.
 *
 * Every committed change is reported to listeners as
 *   { ids: Set<number>, tables: boolean, header: boolean, blocks: Set<string> }
 */
import { defaultHeader, defaultLayer } from './schema.js';
import { STANDARD_LINETYPES } from './linetypes.js';
import { defaultTextStyle, defaultDimStyle } from './styles.js';

const TABLES = ['layers', 'linetypes', 'textStyles', 'dimStyles'];
const UNDO_LIMIT = 500;

export class Drawing {
  constructor(data) {
    this.header = defaultHeader();
    /** @type {Map<number, object>} model space entities in draw order */
    this.entities = new Map();
    /** Draw-order key per id, kept after removal so undo can put an object back in place. */
    this.orderKey = new Map();
    this.nextOrder = 0;
    this.layers = new Map();
    this.linetypes = new Map();
    this.textStyles = new Map();
    this.dimStyles = new Map();
    /** @type {Map<string, {name, bx, by, entities: object[], description}>} */
    this.blocks = new Map();
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this._tx = null;
    this._depth = 0;
    /** Tag stored on steps committed now (the running command), see groupSince(). */
    this.stepTag = null;
    /** Incremented on every committed change; used for "modified" tracking. */
    this.revision = 0;
    /** Count of steps dropped off the bottom of the undo stack (keeps saved indices valid). */
    this.shifted = 0;
    this.savedRevision = 0;
    if (data) this.load(data);
    this.ensureDefaults();
  }

  ensureDefaults() {
    if (!this.layers.has('0')) this.layers.set('0', defaultLayer('0'));
    for (const lt of STANDARD_LINETYPES.slice(0, 1)) if (!this.linetypes.has(lt.name)) this.linetypes.set(lt.name, { ...lt });
    if (!this.textStyles.has('Standard')) this.textStyles.set('Standard', defaultTextStyle());
    if (!this.dimStyles.has('Standard')) this.dimStyles.set('Standard', defaultDimStyle());
    if (!this.layers.has(this.header.clayer)) this.header.clayer = '0';
  }

  /** Replace all content from a plain object (see schema.js). Clears history. */
  load(data) {
    this.header = { ...defaultHeader(), ...(data.header || {}) };
    this.entities = new Map();
    let maxId = 0;
    this.orderKey = new Map();
    this.nextOrder = 0;
    for (const e of data.entities || []) {
      if (!e || typeof e.id !== 'number') continue;
      this.entities.set(e.id, e);
      this.orderKey.set(e.id, ++this.nextOrder);
      if (e.id > maxId) maxId = e.id;
    }
    if (this.header.nextId <= maxId) this.header.nextId = maxId + 1;
    this.layers = new Map((data.layers || []).map((l) => [l.name, { ...defaultLayer(l.name), ...l }]));
    this.linetypes = new Map((data.linetypes || []).map((l) => [l.name, l]));
    this.textStyles = new Map((data.textStyles || []).map((s) => [s.name, { ...defaultTextStyle(s.name), ...s }]));
    this.dimStyles = new Map((data.dimStyles || []).map((s) => [s.name, { ...defaultDimStyle(s.name), ...s }]));
    this.blocks = new Map((data.blocks || []).map((b) => [b.name, b]));
    this.undoStack = [];
    this.redoStack = [];
    this.ensureDefaults();
    this.revision++;
    this.savedRevision = this.revision;
  }

  /** Plain JSON-serializable snapshot. */
  toJSON() {
    return {
      version: 1,
      header: { ...this.header },
      layers: [...this.layers.values()],
      linetypes: [...this.linetypes.values()],
      textStyles: [...this.textStyles.values()],
      dimStyles: [...this.dimStyles.values()],
      blocks: [...this.blocks.values()],
      entities: [...this.entities.values()],
    };
  }

  get modified() {
    return this.revision !== this.savedRevision;
  }

  /** Record the revision that was written (defaults to the current one). */
  markSaved(rev = this.revision) {
    this.savedRevision = rev;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Put re-added objects back in their draw-order place before reporting:
   * they were appended, the rest is still in order, so merge them in.
   */
  _finish(change) {
    if (change.resort) {
      const key = this.orderKey;
      const ents = this.entities;
      const back = new Set(change.restored.filter((id) => ents.has(id)));
      const ins = [...back].sort((a, b) => key.get(a) - key.get(b));
      const out = new Map();
      let i = 0;
      for (const [id, e] of ents) {
        if (back.has(id)) continue;
        const k = key.get(id);
        for (; i < ins.length && key.get(ins[i]) < k; i++) out.set(ins[i], ents.get(ins[i]));
        out.set(id, e);
      }
      for (; i < ins.length; i++) out.set(ins[i], ents.get(ins[i]));
      this.entities = out;
    }
    delete change.restored;
    return change;
  }

  _emit(change) {
    for (const fn of this.listeners) fn(change);
  }

  newId() {
    return this.header.nextId++;
  }

  /**
   * Run `fn` as one undoable step. Nested calls join the outer transaction.
   * Returns whatever fn returns.
   */
  transaction(label, fn) {
    if (this._tx) {
      this._depth++;
      try {
        return fn();
      } finally {
        this._depth--;
      }
    }
    this._tx = { label, records: [], change: newChange() };
    let result;
    try {
      result = fn();
    } catch (err) {
      // Roll back whatever was applied, then rethrow.
      const tx = this._tx;
      this._tx = null;
      for (let i = tx.records.length - 1; i >= 0; i--) this._apply(tx.records[i], true, tx.change);
      if (tx.records.length) this._emit(this._finish(tx.change));
      throw err;
    }
    const tx = this._tx;
    this._tx = null;
    if (tx.records.length) {
      this.undoStack.push({ label, records: tx.records, tag: this.stepTag });
      if (this.undoStack.length > UNDO_LIMIT) {
        this.undoStack.shift();
        this.shifted++;
      }
      this.redoStack.length = 0;
      this.revision++;
      this._emit(this._finish(tx.change));
    }
    return result;
  }

  _record(rec) {
    if (!this._tx) throw new Error('Drawing edits must run inside transaction()');
    this._tx.records.push(rec);
    this._apply(rec, false, this._tx.change);
  }

  _apply(rec, reverse, change) {
    const value = reverse ? rec.before : rec.after;
    switch (rec.kind) {
      case 'ent':
        if (value) {
          if (!this.entities.has(rec.id)) {
            const key = this.orderKey.get(rec.id);
            if (key === undefined) this.orderKey.set(rec.id, ++this.nextOrder);
            // Coming back (undo of an erase): restore its place in the draw order.
            else if (key < this.nextOrder) {
              change.resort = true;
              (change.restored ??= []).push(rec.id);
            }
          }
          this.entities.set(rec.id, value);
        } else this.entities.delete(rec.id);
        change.ids.add(rec.id);
        break;
      case 'table':
        if (value) this[rec.table].set(rec.key, value);
        else this[rec.table].delete(rec.key);
        change.tables = true;
        change.tableNames.add(rec.table);
        change.tableKeys.add(`${rec.table}:${rec.key}`);
        break;
      case 'block':
        if (value) this.blocks.set(rec.key, value);
        else this.blocks.delete(rec.key);
        change.blocks.add(rec.key);
        break;
      case 'header': {
        const prev = reverse ? rec.after : rec.before;
        for (const k of Object.keys(value)) if (prev[k] !== value[k]) change.headerKeys.add(k);
        this.header = value;
        change.header = true;
        break;
      }
      case 'order': {
        this.entities = new Map(value.map((id) => [id, this.entities.get(id)]));
        // Fill the slots of the reordered ids in the full key order, so erased
        // entities keep their place between neighbours if they come back.
        const inSeq = new Set(value);
        const all = [...this.orderKey.keys()].sort((a, b) => this.orderKey.get(a) - this.orderKey.get(b));
        let i = 0;
        const merged = all.map((id) => (inSeq.has(id) ? value[i++] : id));
        while (i < value.length) merged.push(value[i++]);
        let n = 0;
        for (const id of merged) this.orderKey.set(id, ++n);
        this.nextOrder = n;
        change.order = true;
        break;
      }
    }
  }

  // Entity edits -------------------------------------------------------

  /** Add an entity (an id is assigned when missing). Returns the stored entity. */
  add(ent) {
    const e = ent.id && !this.entities.has(ent.id) ? ent : { ...ent, id: this.newId() };
    this._record({ kind: 'ent', id: e.id, before: null, after: e });
    return e;
  }

  remove(id) {
    const before = this.entities.get(id);
    if (!before) return;
    this._record({ kind: 'ent', id, before, after: null });
  }

  /** Replace an entity with a new object (same id). */
  replace(id, next) {
    const before = this.entities.get(id);
    if (!before || before === next) return before;
    const after = next.id === id ? next : { ...next, id };
    this._record({ kind: 'ent', id, before, after });
    return after;
  }

  /** Shallow-merge `patch` into an entity. */
  update(id, patch) {
    const before = this.entities.get(id);
    if (!before) return null;
    return this.replace(id, { ...before, ...patch, id });
  }

  get(id) {
    return this.entities.get(id);
  }

  /** Reorder: move the given ids to the front (drawn last) or back. */
  reorder(ids, toFront) {
    const set = new Set(ids);
    const before = [...this.entities.keys()];
    const moved = before.filter((id) => set.has(id));
    const rest = before.filter((id) => !set.has(id));
    const after = toFront ? rest.concat(moved) : moved.concat(rest);
    this._record({ kind: 'order', before, after });
  }

  /** Reorder: move the given ids to just before `target` (drawn under it). */
  moveBefore(ids, target) {
    const set = new Set(ids);
    if (set.has(target) || !this.entities.has(target)) return;
    const before = [...this.entities.keys()];
    const after = [];
    for (const id of before) {
      if (id === target) for (const m of before) if (set.has(m)) after.push(m);
      if (!set.has(id)) after.push(id);
    }
    this._record({ kind: 'order', before, after });
  }

  // Tables -------------------------------------------------------------

  /** Set or delete (value = null) a table entry. table: layers | linetypes | textStyles | dimStyles */
  setTable(table, key, value) {
    if (!TABLES.includes(table)) throw new Error(`Unknown table ${table}`);
    const before = this[table].get(key) ?? null;
    if (before === value) return;
    this._record({ kind: 'table', table, key, before, after: value });
  }

  setBlock(name, block) {
    const before = this.blocks.get(name) ?? null;
    this._record({ kind: 'block', key: name, before, after: block });
  }

  setHeader(patch) {
    const before = this.header;
    const after = { ...before, ...patch };
    this._record({ kind: 'header', before, after });
  }

  // History ------------------------------------------------------------

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const step = this.undoStack.pop();
    if (!step) return null;
    const change = newChange();
    for (let i = step.records.length - 1; i >= 0; i--) this._apply(step.records[i], true, change);
    this.redoStack.push(step);
    this.revision++;
    this._emit(this._finish(change));
    return step.label;
  }

  redo() {
    const step = this.redoStack.pop();
    if (!step) return null;
    const change = newChange();
    for (const rec of step.records) this._apply(rec, false, change);
    this.undoStack.push(step);
    this.revision++;
    this._emit(this._finish(change));
    return step.label;
  }

  /**
   * Merge every undo step pushed after `index` (an earlier undoStack.length)
   * into one step, so a multi-step command undoes as a unit.
   */
  mergeSince(index, label) {
    const n = this.undoStack.length - index;
    if (n <= 1) {
      if (n === 1 && label) this.undoStack.at(-1).label = label;
      return;
    }
    const steps = this.undoStack.splice(index, n);
    this.undoStack.push({ label: label || steps.at(-1).label, records: steps.flatMap((s) => s.records) });
  }

  /**
   * Merge each run of consecutive steps after `index` tagged `tag` into one
   * step, so a command undoes as a unit while changes made outside it in the
   * meantime (a palette edit, a redo) stay separate steps.
   */
  groupSince(index, tag, label) {
    const out = this.undoStack.slice(0, index);
    let run = null;
    for (let i = index; i < this.undoStack.length; i++) {
      const s = this.undoStack[i];
      if (tag == null || s.tag !== tag) {
        run = null;
        out.push(s);
      } else if (!run) {
        run = { label: label || s.label, records: s.records.slice(), tag };
        out.push(run);
      } else for (const r of s.records) run.records.push(r);
    }
    this.undoStack = out;
  }

  /** Label of the step undo() would revert. */
  get undoLabel() {
    return this.undoStack.at(-1)?.label ?? null;
  }

  get redoLabel() {
    return this.redoStack.at(-1)?.label ?? null;
  }

  // Lookups ------------------------------------------------------------

  layer(name) {
    return this.layers.get(name) ?? this.layers.get('0');
  }

  /** True if entities on this layer are drawn. */
  layerVisible(name) {
    const l = this.layers.get(name);
    return !l || (l.on && !l.frozen);
  }

  /** True if entities on this layer can be selected and edited. */
  layerEditable(name) {
    const l = this.layers.get(name);
    return !l || (l.on && !l.frozen && !l.locked);
  }
}

function newChange() {
  return { ids: new Set(), tables: false, tableNames: new Set(), tableKeys: new Set(), header: false, headerKeys: new Set(), blocks: new Set(), order: false, resort: false };
}
