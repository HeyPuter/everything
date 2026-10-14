/**
 * One browser's copy of a shared workbook (see docs/collaboration.md).
 *
 * The room keeps one ordered log of changes; every browser applies the same changes in the same order, through
 * the workbook's own code, and so holds the same workbook. A change made here is applied at once and kept as
 * pending until the room has it: when someone else's change arrives first, the pending changes are taken back
 * (with the workbook's exact undo steps), the other change applied, and the pending ones transformed to apply
 * after it (their rows and columns moved, their formulas rewritten) and applied again. They are then sent in
 * their new form; the room accepts a change only on top of the latest state, so its order is everyone's.
 *
 * Capturing a change. The workbook knows nothing of sharing: this module watches it. It keeps a shadow of the
 * state already shared (each sheet's cells, by identity and formula text, and its settings), and after each
 * undo step the workbook records it compares the sheets that step touched with the shadow: what differs becomes
 * register writes (cells, settings, lines). Inserting, deleting and moving rows or columns, and renaming,
 * deleting and moving sheets, are recorded as such instead, before what they did to formulas and ranges
 * elsewhere is folded into the shadow: everyone replays them, so a formula someone else typed at the same
 * moment is rewritten by the replay rather than overwritten by this browser's copy of it.
 *
 * Undo. The workbook's own undo would put back whole sheets, other people's edits included. Here each change
 * keeps its inverse (the values it replaced, and the opposite structural step), which is transformed through
 * every change that arrives from someone else afterwards; a register someone else wrote since is dropped from
 * it, so undo takes back only what this person did and only where nobody has changed it since. Undoing is an
 * ordinary change, shared like any other, and its own inverse is the redo.
 */

import { Workbook, sheetShapeJSON, sameJSON, cloneCell } from '../core/workbook.js';
import { cellKey, parseKey } from '../core/cell.js';
import { LINE_PROPS, SHEET_PROPS, BOOK_PROPS, mapCellKey, mapLineKey, mergeRuns, transformStructure, isStructure } from './ops.js';
import { applyOps, contentOf, sheetJSON, lineValues } from './apply.js';

const UNDO_LIMIT = 100;
const EMPTY = Object.freeze({});
/** Book settings large enough to compare by identity first (an edit replaces them rather than changing them in place). */
const BIG_BOOK = new Set(['dataModel', 'nativePivots', 'externalWorkbooks', 'queries']);
const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const parse = (json) => (json == null ? null : JSON.parse(json));
const json = (v) => JSON.stringify(v === undefined ? null : v);

export function changeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
}

/** Row/column settings as maps of key → JSON, from a sheet's serialized shape. Heights of rows fitted to their contents are each screen's own. */
function linesOf(shape) {
  const modes = shape.rowHeightModes || {};
  const map = (o, keep = () => true) => new Map(Object.entries(o || {}).filter(([k]) => keep(k)).map(([k, v]) => [k, json(v)]));
  const set = (list) => new Map((list || []).map((i) => [String(i), 'true']));
  return {
    colWidths: map(shape.colWidths), colStyles: map(shape.colStyles), hiddenCols: set(shape.hiddenCols),
    rowHeights: map(shape.rowHeights, (k) => modes[k] !== 'auto'), rowHeightModes: map(shape.rowHeightModes), rowStyles: map(shape.rowStyles),
    hiddenRows: set(shape.hiddenRows), notes: map(shape.notes),
  };
}

/** The shadow of one sheet: what is already shared of it. */
function shadowSheet(live) {
  const cells = new Map(live.cells);
  const f = new Map();
  for (const [k, c] of cells) if (c.f != null) f.set(k, c.f);
  const shape = sheetShapeJSON(live);
  const props = new Map(SHEET_PROPS.map((p) => [p, json(shape[p])]));
  return { cells, f, props, lines: linesOf(shape), shape };
}

/** A sheet as the shadow holds it, whole (for putting back a sheet someone deleted). */
function shadowSheetJSON(sh) {
  const cells = {};
  for (const [k, c] of sh.cells) cells[k] = cloneCell({ ...c, f: sh.f.get(k) ?? null });
  return { ...sh.shape, cells };
}

export class Replica extends EventTarget {
  /**
   * `wb` is the workbook at revision `rev` of the room. `readOnly` (a viewer) takes back every local edit at once.
   * Events: 'local' (a change was made here; send it), 'refused' (an edit a viewer cannot make), 'remote'
   * (someone else's change was applied), 'history' (what Undo and Redo would do changed).
   */
  constructor(wb, { rev = 0, readOnly = false } = {}) {
    super();
    this.wb = wb;
    this.rev = rev;
    this.readOnly = readOnly;
    this.pending = []; // [{ id, label, ops, rollback: [fn] }] applied here, not yet in the room's log
    this.undoStack = []; // [{ id, label, ops }]: each local change's inverse
    this.redoStack = [];
    this.mode = 'local'; // 'local' | 'remote' | 'replay' | 'rollback'
    this.depth = 0; // structural operations under way (only the outermost is recorded)
    this.building = []; // operations of the step under way
    this.buildingInv = []; // and their inverses, one list per operation
    this.undoing = null; // 'undo' | 'redo' while one is applied
    this._resetDirty();
    this.shadow = this._fullShadow();
    this._attach();
  }

  /* ---------- Hooks into the workbook ---------- */

  _attach() {
    const wb = this.wb;
    const proto = Object.getPrototypeOf(wb);
    const self = this;
    this._saved = {};
    const hook = (name, fn) => { this._saved[name] = Object.prototype.hasOwnProperty.call(wb, name) ? wb[name] : undefined; wb[name] = fn; };
    hook('_push', function (entry) {
      if (this._group) { this._group.push(entry); return; }
      self._step(entry);
    });
    hook('_changed', function (type, sheetId = null, detail = null) {
      if (self.mode === 'local') self._mark(type, sheetId, detail);
      return proto._changed.call(this, type, sheetId, detail);
    });
    hook('_announce', function (type, sheetId = null, extra = null) {
      // Settings changed outside an undo step (Protect Workbook, calculation mode, the Watch Window) are shared too.
      if (self.mode === 'local' && type !== 'view' && type !== 'active-sheet' && type !== 'history' && type !== 'protected') {
        if (type !== 'cells' && type !== 'layout' && type !== 'structure') self.dirty.book = true;
        self._loose();
      }
      return proto._announce.call(this, type, sheetId, extra);
    });
    const semantic = (name, describe) => hook(name, function (...args) {
      if (self.mode !== 'local' || self.depth) return proto[name].apply(this, args);
      return self._semantic(() => proto[name].apply(this, args), args, describe);
    });
    semantic('_insert', {
      op: ([s, axis, at, n], ok) => ok && { t: 'insert', s, axis, at, n },
    });
    semantic('_deleteLines', {
      before: ([s, axis]) => { const sh = wb.sheet(s); return sh ? (axis === 'row' ? sh.rows : sh.cols) : 0; },
      op: ([s, axis, asked], ok, total) => {
        if (!ok) return null;
        const runs = mergeRuns(asked.map(({ from, to }) => ({ from: Math.max(0, from), to: Math.min(to, total - 1) })));
        return runs.length ? { t: 'delete', s, axis, runs } : null;
      },
    });
    semantic('_moveLines', {
      op: ([s, axis, from, count, to], at) => at != null && { t: 'move', s, axis, from, count, to },
    });
    semantic('renameSheet', {
      before: ([id]) => wb.sheet(id)?.name,
      op: ([id, name], ok, old) => ok && old != null && String(name) !== old && { t: 'rename', s: id, name: String(name) },
    });
    semantic('deleteSheet', {
      before: ([id]) => wb.sheets.findIndex((s) => s.id === id),
      op: ([id], ok) => ok && { t: 'drop', s: id },
    });
    semantic('moveSheet', {
      before: ([id]) => wb.sheets.findIndex((s) => s.id === id),
      op: ([id], _, from) => { const to = wb.sheets.findIndex((s) => s.id === id); return from >= 0 && to >= 0 && to !== from && { t: 'order', s: id, to }; },
    });
    // Undo and Redo take back this person's own changes (see the top of this file).
    hook('undo', () => this.undo());
    hook('redo', () => this.redo());
    hook('canUndo', () => this.undoStack.length > 0);
    hook('canRedo', () => this.redoStack.length > 0);
    hook('undoLabel', () => this.undoStack.at(-1)?.label ?? null);
    hook('redoLabel', () => this.redoStack.at(-1)?.label ?? null);
    hook('undoLabels', (n = 10) => this.undoStack.slice(-n).reverse().map((e) => e.label));
    hook('redoLabels', (n = 10) => this.redoStack.slice(-n).reverse().map((e) => e.label));
    hook('historySince', (mark) => {
      if (mark == null) return this.undoStack.slice();
      const i = this.undoStack.lastIndexOf(mark);
      return i < 0 ? null : this.undoStack.slice(i + 1);
    });
    hook('clearHistory', () => { this.undoStack = []; this.redoStack = []; wb._history = []; wb._future = []; wb._snapshotCells = 0; });
    Object.defineProperty(wb, 'historyTop', { configurable: true, get: () => this.undoStack.at(-1) ?? null });
    // A whole workbook put in place (a version restored) is one change.
    this._onLoad = (e) => { if (e.detail?.type === 'load' && this.mode === 'local') { this.dirty.all = true; this.dirty.book = true; this._flushStep('Restore'); } };
    wb.addEventListener('change', this._onLoad);
    wb._history = [];
    wb._future = [];
  }

  /** Give the workbook back its own behavior. */
  detach() {
    const wb = this.wb;
    for (const [name, value] of Object.entries(this._saved || {})) { if (value === undefined) delete wb[name]; else wb[name] = value; }
    delete wb.historyTop;
    wb.removeEventListener('change', this._onLoad);
    this._saved = null;
  }

  /* ---------- Capture ---------- */

  _resetDirty() {
    this.dirty = { all: false, book: false, list: false, sheets: new Map() };
  }

  _mark(type, sheetId, detail) {
    const d = this.dirty;
    if (type === 'view' || type === 'active-sheet') return;
    if (sheetId == null) { d.all = true; d.book = true; return; }
    let s = d.sheets.get(sheetId);
    if (!s) d.sheets.set(sheetId, (s = { cells: false, boxes: [], props: false }));
    if (type === 'cells' && detail?.box) { s.boxes.push(detail.box); return; }
    if (type === 'cells') { s.cells = true; return; }
    s.props = true;
    if (type !== 'layout') s.cells = true;
  }

  _loose() {
    if (this._looseQueued) return;
    this._looseQueued = true;
    queueMicrotask(() => {
      this._looseQueued = false;
      if (this.mode === 'local' && !this.wb._group && !this.depth) this._flushStep('Edit', { undoable: false });
    });
  }

  _fullShadow() {
    const wb = this.wb;
    const sheets = new Map(wb.sheets.map((s) => [s.id, shadowSheet(s)]));
    const fields = wb.bookFields();
    const state = wb.bookState(BOOK_PROPS);
    const book = new Map(BOOK_PROPS.map((k) => [k, { ref: fields[k], json: json(state[k]) }]));
    return { sheets, order: wb.sheets.map((s) => ({ id: s.id, name: s.name })), book };
  }

  _record(op, inverse) {
    this.building.push(op);
    this.buildingInv.push(inverse);
  }

  /** Compare what changed since the shadow, record it as register writes, and bring the shadow up to date. */
  _diff() {
    const wb = this.wb, sh = this.shadow, d = this.dirty;
    // The sheet list: sheets gone, sheets added, renamed and moved.
    const listChanged = wb.sheets.length !== sh.order.length || wb.sheets.some((s, i) => s.id !== sh.order[i].id || s.name !== sh.order[i].name);
    if (listChanged) {
      d.all = true;
      for (let i = sh.order.length - 1; i >= 0; i--) {
        const { id } = sh.order[i];
        if (wb.sheet(id)) continue;
        const was = sh.sheets.get(id);
        this._record({ t: 'drop', s: id }, [{ t: 'put', s: id, at: i, sheet: shadowSheetJSON(was) }]);
        sh.order.splice(i, 1);
        sh.sheets.delete(id);
      }
      wb.sheets.forEach((s, i) => {
        if (sh.sheets.has(s.id)) return;
        const at = Math.min(i, sh.order.length);
        this._record({ t: 'put', s: s.id, at, sheet: sheetJSON(s) }, [{ t: 'drop', s: s.id }]);
        sh.order.splice(at, 0, { id: s.id, name: s.name });
        sh.sheets.set(s.id, shadowSheet(s));
      });
      for (const entry of sh.order) {
        const live = wb.sheet(entry.id);
        if (live.name !== entry.name) {
          this._record({ t: 'rename', s: entry.id, name: live.name }, [{ t: 'rename', s: entry.id, name: entry.name }]);
          entry.name = live.name;
        }
      }
      wb.sheets.forEach((s, i) => {
        if (sh.order[i].id === s.id) return;
        const j = sh.order.findIndex((e) => e.id === s.id);
        this._record({ t: 'order', s: s.id, to: i }, [{ t: 'order', s: s.id, to: j }]);
        const [moved] = sh.order.splice(j, 1);
        sh.order.splice(i, 0, moved);
      });
    }
    const ids = d.all ? wb.sheets.map((s) => s.id) : [...d.sheets.keys()];
    for (const id of ids) {
      const live = wb.sheet(id);
      const shadow = sh.sheets.get(id);
      if (!live || !shadow) continue;
      const mark = d.all ? { cells: true, props: true, boxes: [] } : d.sheets.get(id);
      if (mark.cells || mark.boxes.length) this._diffCells(live, shadow, mark);
      if (mark.props || mark.cells) this._diffProps(live, shadow);
    }
    this._diffBook(d.book || d.all);
    this._resetDirty();
  }

  _diffCells(live, shadow, mark) {
    const v = {}, st = {}, iv = {}, ist = {};
    let any = false;
    const check = (key) => {
      const cur = live.cells.get(key), old = shadow.cells.get(key);
      const curF = cur?.f ?? null, oldF = old ? shadow.f.get(key) ?? null : null;
      if (cur === old && curF === oldF) return;
      const cc = contentOf(cur), oc = old ? contentOf(old, oldF) : null;
      if (!sameJSON(cc, oc)) { v[key] = cc; iv[key] = oc; any = true; }
      const cs = cur?.s || EMPTY, os = old?.s || EMPTY;
      let patch = null, back = null;
      for (const p of new Set([...Object.keys(cs), ...Object.keys(os)])) {
        if (sameJSON(cs[p] ?? null, os[p] ?? null)) continue;
        (patch ||= {})[p] = cs[p] ?? null;
        (back ||= {})[p] = os[p] ?? null;
      }
      if (patch) { st[key] = patch; ist[key] = back; any = true; }
      if (cur) { shadow.cells.set(key, cur); if (curF != null) shadow.f.set(key, curF); else shadow.f.delete(key); }
      else { shadow.cells.delete(key); shadow.f.delete(key); }
    };
    const area = mark.cells ? Infinity : mark.boxes.reduce((n, b) => n + (b.r2 - b.r1 + 1) * (b.c2 - b.c1 + 1), 0);
    if (area <= 4096) {
      for (const b of mark.boxes) for (let r = b.r1; r <= b.r2; r++) for (let c = b.c1; c <= b.c2; c++) check(cellKey(r, c));
    } else {
      for (const key of live.cells.keys()) check(key);
      for (const key of [...shadow.cells.keys()]) if (!live.cells.has(key)) check(key);
    }
    if (!any) return;
    const op = { t: 'cells', s: live.id }, inv = { t: 'cells', s: live.id };
    if (Object.keys(v).length) { op.v = v; inv.v = iv; }
    if (Object.keys(st).length) { op.st = st; inv.st = ist; }
    this._record(op, [inv]);
  }

  _diffProps(live, shadow) {
    const shape = sheetShapeJSON(live);
    const v = {}, iv = {};
    for (const p of SHEET_PROPS) {
      const now = json(shape[p]);
      const was = shadow.props.get(p);
      if (now === was) continue;
      v[p] = parse(now);
      iv[p] = parse(was);
      shadow.props.set(p, now);
    }
    if (Object.keys(v).length) this._record({ t: 'props', s: live.id, v }, [{ t: 'props', s: live.id, v: iv }]);
    const lines = linesOf(shape);
    for (const p of Object.keys(LINE_PROPS)) {
      const now = lines[p], was = shadow.lines[p];
      const lv = {}, liv = {};
      let any = false;
      for (const k of new Set([...now.keys(), ...was.keys()])) {
        if (now.get(k) === was.get(k)) continue;
        lv[k] = parse(now.get(k));
        liv[k] = parse(was.get(k));
        any = true;
      }
      if (any) this._record({ t: 'lines', s: live.id, p, v: lv }, [{ t: 'lines', s: live.id, p, v: liv }]);
    }
    shadow.lines = lines;
    shadow.shape = shape;
  }

  _diffBook(all) {
    const fields = this.wb.bookFields();
    const v = {}, iv = {};
    for (const key of BOOK_PROPS) {
      const entry = this.shadow.book.get(key);
      if (BIG_BOOK.has(key) && entry.ref === fields[key] && !all) continue;
      const now = json(this.wb.bookState([key])[key]);
      entry.ref = fields[key];
      if (now === entry.json) continue;
      v[key] = parse(now);
      iv[key] = parse(entry.json);
      entry.json = now;
    }
    if (Object.keys(v).length) this._record({ t: 'book', v }, [{ t: 'book', v: iv }]);
  }

  /** A structural operation made here (see _attach): recorded as itself, with what it did elsewhere folded into the shadow. */
  _semantic(run, args, describe) {
    this._diff();
    const before = describe.before ? describe.before(args) : undefined;
    const old = this.shadow;
    this.depth++;
    let result;
    try { result = run(); } finally { this.depth--; }
    const op = describe.op(args, result, before);
    // The operation's own undo step was recorded inside it (outside a transaction): it finishes the change now.
    const step = this.deferred;
    this.deferred = null;
    if (op) {
      this.shadow = this._fullShadow();
      this._resetDirty();
      this._record(op, this._inverseOf(op, old, result, before));
    }
    if (step) this._flushStep(step.label || 'Edit', { rollback: () => step.undo() });
    return result;
  }

  /**
   * The inverse of a structural operation: the opposite operation and, for deletions, the writes that put back
   * what went with the deleted lines or sheet (cells, formulas elsewhere that turned to #REF!, settings).
   */
  _inverseOf(op, old, result, before) {
    switch (op.t) {
      case 'insert':
        return [{ t: 'delete', s: op.s, axis: op.axis, runs: [{ from: op.at, to: op.at + op.n - 1 }] }];
      case 'move':
        return [{ t: 'move', s: op.s, axis: op.axis, from: result, count: op.count, to: op.from < result ? op.from : op.from + op.count }];
      case 'rename':
        return [{ t: 'rename', s: op.s, name: before }];
      case 'order':
        return [{ t: 'order', s: op.s, to: before }];
      case 'delete':
        return [...op.runs.map((r) => ({ t: 'insert', s: op.s, axis: op.axis, at: r.from, n: r.to - r.from + 1 })), ...this._restoration(op, old)];
      case 'drop':
        return [{ t: 'put', s: op.s, at: before, sheet: shadowSheetJSON(old.sheets.get(op.s)) }, ...this._restoration(op, old)];
    }
    return [];
  }

  _restoration(op, old) {
    const cur = this.shadow;
    const out = [];
    for (const [id, o] of old.sheets) {
      const n = cur.sheets.get(id);
      if (!n) continue;
      const v = {}, st = {};
      let any = false;
      for (const [key, cell] of o.cells) {
        const at = mapCellKey(op, id, key);
        const was = o.f.get(key) ?? null;
        if (at == null) {
          v[key] = contentOf(cell, was);
          if (cell.s && Object.keys(cell.s).length) st[key] = { ...cell.s };
          any = true;
        } else if (was != null) {
          const now = n.f.get(at) ?? null;
          if (now !== was && /#REF!/i.test(now ?? '') && !/#REF!/i.test(was)) { v[key] = contentOf(cell, was); any = true; }
        }
      }
      const pv = {};
      for (const p of SHEET_PROPS) if (o.props.get(p) !== n.props.get(p)) pv[p] = parse(o.props.get(p));
      const lines = [];
      if (op.t === 'delete' && op.s === id) {
        for (const p of Object.keys(LINE_PROPS)) {
          const lv = {};
          for (const [k, val] of o.lines[p]) if (mapLineKey(op, id, p, k) == null) lv[k] = parse(val);
          if (Object.keys(lv).length) lines.push({ t: 'lines', s: id, p, v: lv });
        }
      }
      if (any) out.push({ t: 'cells', s: id, ...(Object.keys(v).length ? { v } : {}), ...(Object.keys(st).length ? { st } : {}) });
      if (Object.keys(pv).length) out.push({ t: 'props', s: id, v: pv });
      out.push(...lines);
    }
    const bv = {};
    for (const [k, entry] of old.book) if (entry.json !== cur.book.get(k).json) bv[k] = parse(entry.json);
    if (Object.keys(bv).length) out.push({ t: 'book', v: bv });
    return out;
  }

  /** The workbook recorded an undo step: the step under way is finished. */
  _step(entry) {
    if (this.mode === 'replay') { this.replayParts.push(() => entry.undo()); return; }
    if (this.mode !== 'local') return;
    if (this.depth) { this.deferred = entry; return; }
    this._flushStep(entry.label || 'Edit', { rollback: () => entry.undo() });
  }

  /** Finish the change under way: what it changed becomes a pending change and its inverse an undo entry. */
  _flushStep(label, { rollback = null, undoable = true } = {}) {
    this._diff();
    const ops = this.building;
    const inverse = this.buildingInv.slice().reverse().flat();
    this.building = [];
    this.buildingInv = [];
    if (!ops.length) return null;
    if (this.readOnly) {
      // A viewer's edit is taken back at once: the room would refuse it anyway.
      this._withMode('rollback', () => this.wb._coalesce(() => (rollback ? rollback() : applyOps(this.wb, inverse))));
      this.shadow = this._fullShadow();
      this._resetDirty();
      this.dispatchEvent(new CustomEvent('refused', { detail: { label } }));
      return null;
    }
    const change = { id: changeId(), label, ops, rollback: [rollback || (() => this._withMode('rollback', () => applyOps(this.wb, inverse)))] };
    this.pending.push(change);
    if (undoable) {
      const entry = { id: change.id, label, ops: inverse };
      if (this.undoing === 'undo') this.redoStack.push(entry);
      else {
        this.undoStack.push(entry);
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
        if (this.undoing !== 'redo') this.redoStack = [];
      }
    }
    this.dispatchEvent(new CustomEvent('local', { detail: change }));
    // A new step, announced as the workbook announces its own (Undo and Redo announce theirs when done).
    if (undoable && !this.undoing) this.wb._emit('history');
    return change;
  }

  _withMode(mode, fn) {
    const was = this.mode, wasOff = this.wb._recordingOff;
    this.mode = mode;
    // Taking this person's pending changes back and putting them on again is no new edit for Show Changes: each
    // was recorded when it was made.
    if (mode === 'rollback' || mode === 'replay') this.wb._recordingOff = true;
    try { return fn(); } finally { this.mode = was; this.wb._recordingOff = wasOff; }
  }

  /* ---------- Receiving ---------- */

  /** The changes not yet in the room's log, in the form to send (on top of revision `rev`). */
  outgoing() {
    return this.pending.map(({ id, label, ops }) => ({ id, label, ops }));
  }

  /**
   * Records of the room's log, from revision rev + 1 on: { rev, user, changes: [{ id, label, ops }] }. Own changes
   * among them are confirmed; anyone else's are applied, the pending changes rebased on top of them. Returns
   * whether anything someone else did was applied.
   */
  receive(records) {
    const list = records.filter((r) => r.rev > this.rev).sort((a, b) => a.rev - b.rev);
    if (!list.length) return false;
    if (list[0].rev !== this.rev + 1) throw new Error(`Shared workbook log gap: have ${this.rev}, got ${list[0].rev}`);
    // Anything changed outside an undo step is a change of its own, before the others land.
    if (this.mode === 'local' && !this.wb._group) this._flushStep('Edit', { undoable: false });
    const wb = this.wb;
    let rolled = false, applied = false, structural = false;
    const touched = []; // what was applied, when nothing structural was: the shadow is brought up to date for it alone
    const moved = []; // structural operations as they landed here (past the pending changes), for the view to follow
    wb._coalesce(() => {
      for (const rec of list) {
        if (rec.rev !== this.rev + 1) break;
        for (const ch of rec.changes || []) {
          if (this.pending[0]?.id === ch.id) {
            this.pending.shift();
            // Taken back for an earlier change: the room's copy is the one to apply.
            if (rolled) this._applyRemote(ch.ops, null, null, { quiet: true });
            continue;
          }
          if (!rolled && this.pending.length) { this._rollback(); rolled = true; }
          let theirs = ch.ops;
          for (const p of this.pending) {
            const [mine, past] = this._xform(p.ops, theirs, true);
            p.ops = mine;
            theirs = past;
          }
          this._applyRemote(ch.ops, rec.username, ch.label);
          for (const e of [...this.undoStack, ...this.redoStack]) e.ops = this._xform(e.ops, theirs, false)[0];
          applied = true;
          if (ch.ops.some((o) => isStructure(o) || o.t === 'put')) structural = true;
          else touched.push(...ch.ops);
          moved.push(...theirs.filter(isStructure));
        }
        this.rev = rec.rev;
      }
      if (rolled) this._replay();
    });
    if (rolled || structural) this.shadow = this._fullShadow();
    else this._refreshShadow(touched);
    this._resetDirty();
    if (applied) this.dispatchEvent(new CustomEvent('remote', { detail: { structural, ops: moved } }));
    // Not a step of this person's: the workbook's 'history' event (which the editor counts steps by) is not sent.
    this.dispatchEvent(new CustomEvent('history'));
    return applied;
  }

  /**
   * Changes this browser kept from an earlier visit (see outbox.js), made on top of the current revision: applied
   * as pending changes again, to be sent. They are not undoable here.
   */
  restorePending(changes) {
    for (const ch of changes) {
      if (!ch?.ops?.length || this.pending.some((p) => p.id === ch.id)) continue;
      const p = { id: ch.id, label: ch.label || 'Edit', ops: ch.ops, rollback: [] };
      this.replayParts = [];
      this._withMode('replay', () => this.wb.transaction(p.label, () => applyOps(this.wb, p.ops, p.label)));
      p.rollback = this.replayParts;
      this.replayParts = null;
      this.pending.push(p);
    }
    this.shadow = this._fullShadow();
    this._resetDirty();
  }

  /** Take back every pending change (the room refused one for good; later ones may build on it). */
  discardPending() {
    if (!this.pending.length) return;
    this.wb._coalesce(() => this._rollback());
    this.pending = [];
    this.undoStack = [];
    this.redoStack = [];
    this.shadow = this._fullShadow();
    this._resetDirty();
    this.wb._emit('history');
  }

  /** Bring the shadow up to date for the registers `ops` wrote (none of them structural). */
  _refreshShadow(ops) {
    const wb = this.wb, sh = this.shadow;
    const sheets = new Set();
    let book = false;
    for (const op of ops) {
      if (op.t === 'book') { book = true; continue; }
      const live = wb.sheet(op.s), shadow = sh.sheets.get(op.s);
      if (!live || !shadow) continue;
      sheets.add(op.s);
      if (op.t !== 'cells') continue;
      for (const key of new Set([...Object.keys(op.v || {}), ...Object.keys(op.st || {})])) {
        const cur = live.cells.get(key);
        if (cur) { shadow.cells.set(key, cur); if (cur.f != null) shadow.f.set(key, cur.f); else shadow.f.delete(key); }
        else { shadow.cells.delete(key); shadow.f.delete(key); }
      }
    }
    // Settings (a cell write can clear a sheet's ignored errors, say) are read again for each sheet written.
    for (const id of sheets) {
      const live = wb.sheet(id), shadow = sh.sheets.get(id);
      const shape = sheetShapeJSON(live);
      for (const p of SHEET_PROPS) shadow.props.set(p, json(shape[p]));
      shadow.lines = linesOf(shape);
      shadow.shape = shape;
    }
    if (book) {
      const fields = wb.bookFields(), state = wb.bookState(BOOK_PROPS);
      for (const k of BOOK_PROPS) sh.book.set(k, { ref: fields[k], json: json(state[k]) });
    }
  }

  _rollback() {
    this._withMode('rollback', () => {
      for (const p of [...this.pending].reverse()) for (const fn of [...p.rollback].reverse()) fn();
    });
  }

  /**
   * Someone else's change, shown in Show Changes as theirs (`who`, `label`); `quiet` for this person's own change put
   * back after a rollback, which was recorded when it was made.
   */
  _applyRemote(ops, who = null, label = null, { quiet = false } = {}) {
    const wb = this.wb;
    const active = wb.activeSheetId;
    const author = wb.changeAuthor, off = wb._recordingOff;
    if (who) wb.changeAuthor = who;
    if (quiet) wb._recordingOff = true;
    try {
      this._withMode('remote', () => wb.transaction(label || 'Shared edit', () => applyOps(wb, ops, label || 'Shared edit')));
    } finally { wb.changeAuthor = author; wb._recordingOff = off; }
    // Someone else adding a sheet does not take this person to it.
    if (wb.activeSheetId !== active && wb.sheet(active) && !wb.sheet(active).hidden) wb.activeSheetId = active;
  }

  _replay() {
    const wb = this.wb;
    const active = wb.activeSheetId;
    for (const p of this.pending) {
      this.replayParts = [];
      this._withMode('replay', () => wb.transaction(p.label, () => applyOps(wb, p.ops, p.label)));
      p.rollback = this.replayParts;
      this.replayParts = null;
    }
    this.pending = this.pending.filter((p) => p.ops.length);
    if (wb.sheet(active) && !wb.sheet(active).hidden) wb.activeSheetId = active;
  }

  /* ---------- Transforming ---------- */

  /**
   * Two lists of operations made at once on the same state: [a after b, b after a]. Where both write one
   * register, `aWins` says whose value stands: a pending change wins over the one that came before it in the
   * room's order (it lands after it); an undo entry loses to every change made since.
   */
  _xform(a, b, aWins) {
    if (!a.length || !b.length) return [a, b];
    if (a.length > 1) {
      const [a0, b1] = this._xform([a[0]], b, aWins);
      const [rest, b2] = this._xform(a.slice(1), b1, aWins);
      return [[...a0, ...rest], b2];
    }
    if (b.length > 1) {
      const [a1, b0] = this._xform(a, [b[0]], aWins);
      const [a2, rest] = this._xform(a1, b.slice(1), aWins);
      return [a2, [...b0, ...rest]];
    }
    const x = a[0], y = b[0];
    const xs = isStructure(x), ys = isStructure(y);
    if (!xs && !ys) return writesAgainst(x, y, aWins);
    if (!xs) return [this._mapWrites([x], y), [y]];
    if (!ys) return [[x], this._mapWrites([y], x)];
    return transformStructure(x, y, false, aWins);
  }

  /** Writes made before structural operation `s` was applied, moved to apply after it. */
  _mapWrites(ops, s) {
    const moved = [];
    let sandbox = false;
    for (const op of ops) {
      if (op.s != null && s.t === 'drop' && s.s === op.s && op.t !== 'put') continue;
      if (op.t === 'put') { moved.push(op); continue; }
      if (op.t === 'book' || op.t === 'props') { moved.push(op); sandbox = true; continue; }
      if (op.t === 'lines') {
        const v = {};
        for (const [k, val] of Object.entries(op.v)) { const at = mapLineKey(s, op.s, op.p, k); if (at != null) v[at] = val; }
        if (Object.keys(v).length) moved.push({ ...op, v });
        continue;
      }
      // Cells: positions move by the operation; formulas and links are rewritten by the workbook itself.
      const v = {}, st = {};
      for (const [k, val] of Object.entries(op.v || {})) {
        const at = mapCellKey(s, op.s, k);
        if (at == null) continue;
        v[at] = val;
        if (val && (val.f != null || val.hyperlink?.startsWith('#'))) sandbox = true;
      }
      for (const [k, val] of Object.entries(op.st || {})) { const at = mapCellKey(s, op.s, k); if (at != null) st[at] = val; }
      if (Object.keys(v).length || Object.keys(st).length) moved.push({ t: 'cells', s: op.s, ...(Object.keys(v).length ? { v } : {}), ...(Object.keys(st).length ? { st } : {}) });
    }
    return sandbox ? this._sandbox(ops, s, moved) : moved;
  }

  /**
   * Let the workbook itself carry formulas and settings through a structural operation: the writes go into a
   * scratch workbook with the same sheets, the operation runs there, and the rewritten values are read back at
   * the positions `moved` already gives them.
   */
  _sandbox(ops, s, moved) {
    const wb = this.wb;
    const scratch = new Workbook({ sheets: wb.sheets.map((x) => ({ id: x.id, name: x.name, hidden: x.hidden, veryHidden: x.veryHidden })) });
    // Only the formulas move; values and formats are kept as written.
    const formulas = ops.filter((op) => op.t !== 'cells' || op.v).map((op) => (op.t === 'cells' ? { t: 'cells', s: op.s, v: op.v } : op));
    applyOps(scratch, formulas);
    applyOps(scratch, [s]);
    return moved.map((op) => {
      const sheet = op.s != null ? scratch.sheet(op.s) : null;
      if (op.t === 'cells' && op.v && sheet) {
        const v = {};
        for (const [k, val] of Object.entries(op.v)) v[k] = val && (val.f != null || val.hyperlink?.startsWith('#')) ? contentOf(sheet.cells.get(k)) ?? val : val;
        return { ...op, v };
      }
      if (op.t === 'props' && sheet) {
        const shape = sheetShapeJSON(sheet);
        return { ...op, v: Object.fromEntries(Object.keys(op.v).map((k) => [k, op.v[k] == null ? null : shape[k] === undefined ? null : JSON.parse(JSON.stringify(shape[k]))])) };
      }
      if (op.t === 'book') {
        const state = scratch.bookState(Object.keys(op.v));
        return { ...op, v: Object.fromEntries(Object.keys(op.v).map((k) => [k, op.v[k] == null ? null : state[k]])) };
      }
      return op;
    });
  }

  /* ---------- Undo ---------- */

  undo() { return this._takeBack('undo'); }
  redo() { return this._takeBack('redo'); }

  _takeBack(kind) {
    const stack = kind === 'undo' ? this.undoStack : this.redoStack;
    const entry = stack.pop();
    if (!entry) return false;
    this.undoing = kind;
    try {
      this.wb.transaction(entry.label, () => applyOps(this.wb, entry.ops, entry.label));
      this._flushStep(entry.label);
    } finally { this.undoing = null; }
    this.wb._emit('history');
    return true;
  }

  /* ---------- State ---------- */

  /** The workbook as the room's checkpoint holds it: what everyone shares, without this person's view. Only while nothing is pending. */
  checkpoint() {
    const state = this.wb.toJSON();
    delete state.workbookView;
    for (const s of state.sheets) for (const k of ['viewZoom', 'viewMode', 'viewSelection', 'viewOrigin', 'split']) delete s[k];
    return state;
  }
}

/** Two register writes made at once: where both write one register, the winner's value stands. */
function writesAgainst(a, b, aWins) {
  if (a.t === 'put' || b.t === 'put' || a.t !== b.t || (a.s ?? null) !== (b.s ?? null) || (a.t === 'lines' && a.p !== b.p)) return [[a], [b]];
  const [win, lose] = aWins ? [a, b] : [b, a];
  const rest = without(lose, win);
  return aWins ? [[a], rest ? [rest] : []] : [rest ? [rest] : [], [b]];
}

/** `lose` with every register `win` also writes taken out (null when nothing is left). */
function without(lose, win) {
  if (lose.t === 'cells') {
    const v = { ...(lose.v || {}) }, st = {};
    for (const k of Object.keys(win.v || {})) delete v[k];
    for (const [k, patch] of Object.entries(lose.st || {})) {
      const theirs = win.st?.[k];
      const kept = theirs ? Object.fromEntries(Object.entries(patch).filter(([p]) => !own(theirs, p))) : patch;
      if (Object.keys(kept).length) st[k] = kept;
    }
    if (!Object.keys(v).length && !Object.keys(st).length) return null;
    return { t: 'cells', s: lose.s, ...(Object.keys(v).length ? { v } : {}), ...(Object.keys(st).length ? { st } : {}) };
  }
  const v = Object.fromEntries(Object.entries(lose.v).filter(([k]) => !own(win.v, k)));
  return Object.keys(v).length ? { ...lose, v } : null;
}

export { lineValues, parseKey };
