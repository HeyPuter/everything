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
import { cellKey, parseKey, cutText } from '../core/cell.js';
import { LINE_PROPS, SHEET_PROPS, BOOK_PROPS, MAX_LABEL, MAX_CHANGE, MAX_OPS, MAX_RUNS, mapCellKey, mapLineKey, mergeRuns, transformStructure, isStructure, parseCellKey } from './ops.js';
import { applyOps, contentOf, sheetJSON, lineValues, sheetProps } from './apply.js';

const UNDO_LIMIT = 100;
const EMPTY = Object.freeze({});
/** Book settings large enough to compare by identity first (an edit replaces them rather than changing them in place). */
const BIG_BOOK = new Set(['dataModel', 'nativePivots', 'externalWorkbooks', 'queries']);
const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const parse = (json) => (json == null ? null : JSON.parse(json));
const json = (v) => JSON.stringify(v === undefined ? null : v);

/** Does the operation change the sheets Protect Workbook locks: which there are, their order, names, visibility or tab colors? */
const SHEET_OPS = new Set(['put', 'drop', 'rename', 'order']);
const changesSheets = (op) => SHEET_OPS.has(op.t) || (op.t === 'props' && (own(op.v, 'hidden') || own(op.v, 'veryHidden') || own(op.v, 'color')));

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
   * (someone else's change was applied), 'incoming' ({ ops, moved }: someone else's operations, just applied, before the
   * workbook announces them or anything is calculated, and their structural ones as they landed here), 'history' (what
   * Undo and Redo would do changed).
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
    // Several insertions at once, as taking back a deletion of many runs applies them (see applyOps): each recorded as itself.
    semantic('_insertSequence', {
      op: ([s, axis, inserts], ok) => ok && inserts.map(({ at, n }) => ({ t: 'insert', s, axis, at, n })),
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
      for (const one of Array.isArray(op) ? op : [op]) this._recordStructure(one, old, result, before);
    }
    if (step) this._flushStep(step.label || 'Edit', { rollback: () => step.undo() });
    return result;
  }

  /** Record a structural operation made here with its inverse. */
  _recordStructure(op, old, result, before) {
    const inverse = this._inverseOf(op, old, result, before);
    if (op.t === 'delete' && op.runs.length > MAX_RUNS) {
      // More runs than the room takes in one deletion (the rows a filter shows, deleted): several deletions, the lowest
      // rows first so that each one's positions still hold. Taken back, the rows go back from the top, then what was on them.
      const rest = inverse.slice(op.runs.length);
      for (let end = op.runs.length; end > 0; end -= MAX_RUNS / 2) {
        const from = Math.max(0, end - MAX_RUNS / 2);
        this._record({ ...op, runs: op.runs.slice(from, end) }, [...inverse.slice(from, end), ...(end === op.runs.length ? rest : [])]);
      }
    } else this._record(op, inverse);
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
    const inverses = this.buildingInv;
    const inverse = inverses.slice().reverse().flat();
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
    // A step larger than the room takes in one change (a paste of a long list, say) travels in several.
    const parts = splitChange(ops, inverses);
    const change = { id: changeId(), label, ops: parts ? parts[0].ops : ops, rollback: [rollback || (() => this._withMode('rollback', () => applyOps(this.wb, inverse)))] };
    if (parts) {
      // Each part is taken back by its own inverse: a room's change can arrive between them.
      const undoPart = (inv) => () => this._withMode('rollback', () => applyOps(this.wb, inv));
      change.rollback = [undoPart(parts[0].inverse)];
      this.pending.push(change, ...parts.slice(1).map((p) => ({ id: changeId(), label, ops: p.ops, rollback: [undoPart(p.inverse)] })));
    } else this.pending.push(change);
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

  /**
   * The changes not yet in the room's log, in the form to send (on top of revision `rev`). A step's name can be
   * longer than the room keeps ("Show scenario" and a long scenario name): it travels cut to the room's length.
   */
  outgoing() {
    return this.pending.map(({ id, label, ops }) => ({ id, label: label == null ? label : cutText(label, MAX_LABEL), ops }));
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
    const reshapes = (ops) => ops.some((o) => isStructure(o) || o.t === 'put');
    const moved = []; // structural operations as they landed here (past the pending changes), for the view to follow
    const incoming = []; // everything someone else's changes did
    wb._coalesce(() => {
      for (const rec of list) {
        if (rec.rev !== this.rev + 1) break;
        for (const ch of rec.changes || []) {
          if (this.pending[0]?.id === ch.id) {
            this.pending.shift();
            // Taken back for an earlier change: the room's copy is the one to apply.
            if (rolled) { this._applyRemote(ch.ops, null, null, { quiet: true }); touched.push(...ch.ops); }
            continue;
          }
          if (!rolled && this.pending.length) {
            // What the pending changes wrote is what taking them back and putting them on again touches.
            for (const p of this.pending) touched.push(...p.ops);
            this._rollback();
            rolled = true;
          }
          let theirs = ch.ops;
          const bases = new Map(); // sheet and list → the list as the pending change being transformed found it
          for (const p of this.pending) {
            const merged = mergeLists(p.ops, theirs, bases, this.wb);
            this._rebaseInverse(p.id, merged.mine, merged.theirs);
            const [mine, past] = this._xform(merged.mine, merged.theirs, true);
            p.ops = mine;
            theirs = [...past, ...merged.after];
          }
          this._applyRemote(ch.ops, rec.username, ch.label);
          incoming.push(...ch.ops);
          for (const e of [...this.undoStack, ...this.redoStack]) e.ops = keepOthersWork(this._xform(e.ops, theirs, false)[0], theirs);
          applied = true;
          if (ch.ops.some((o) => isStructure(o) || o.t === 'put')) structural = true;
          else touched.push(...ch.ops);
          moved.push(...theirs.filter(isStructure));
        }
        this.rev = rec.rev;
      }
      if (rolled) this._replay();
      if (incoming.length) this.dispatchEvent(new CustomEvent('incoming', { detail: { ops: incoming, moved } }));
    });
    // Read again in full only when rows, columns or sheets moved: a long workbook's shadow takes a while to build,
    // and someone else's edit arriving while this person's own is on its way is the usual case while both type.
    if (rolled) for (const p of this.pending) touched.push(...p.ops);
    if (structural || reshapes(touched)) this.shadow = this._fullShadow();
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
    // One operation at a time, folded along the list (an undone deletion of the rows a filter showed is thousands of
    // insertions): taken by recursion, each step copied the rest of the list, which grew with the square of its length.
    if (a.length > 1) {
      const out = [];
      let rest = b;
      for (const x of a) { const [x2, b2] = this._xform([x], rest, aWins); out.push(...x2); rest = b2; }
      return [out, rest];
    }
    if (b.length > 1) {
      let cur = a;
      const out = [];
      for (let k = 0; k < b.length; k++) {
        if (cur.length > 1) { const [a2, rest] = this._xform(cur, b.slice(k), aWins); return [a2, [...out, ...rest]]; }
        const [a1, y] = this._xform(cur, [b[k]], aWins);
        out.push(...y);
        cur = a1;
      }
      return [cur, out];
    }
    const x = a[0], y = b[0];
    const xs = isStructure(x), ys = isStructure(y);
    if (!xs && !ys) return writesAgainst(x, y, aWins);
    if (!xs) return [this._mapWrites([x], y), [y]];
    if (!ys) return [[x], this._mapWrites([y], x)];
    return transformStructure(x, y, false, aWins);
  }

  /**
   * The pending change `id` lands after `theirs`, someone else's operations made at the same time on the same state: where
   * both write one register, what it replaces is what `theirs` wrote there, and that is what its Undo puts back, not what
   * was there before either of them (which would wipe out the other person's change too). Redo still does again what
   * was undone. Not where either moves rows, columns or sheets: the inverse is kept in positions those would have to be
   * matched through.
   */
  _rebaseInverse(id, mine, theirs) {
    const entry = this.undoStack.find((e) => e.id === id);
    if (!entry) return;
    // A sheet renamed by both at once has the later name, this one: its Undo puts back the other's, as for a register.
    const renamed = new Map(theirs.filter((t) => t.t === 'rename' && mine.some((m) => m.t === 'rename' && m.s === t.s)).map((t) => [t.s, t.name]));
    if (renamed.size) entry.ops = entry.ops.map((op) => (op.t === 'rename' && renamed.has(op.s) ? { ...op, name: renamed.get(op.s) } : op));
    if ([...mine, ...theirs].some((op) => isStructure(op) || op.t === 'put')) return;
    for (const t of theirs) for (const m of mine) { const o = overlap(t, m); if (o) entry.ops.push(o); }
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
    // One that adds, removes, renames, moves, hides or recolors a sheet waits while the structure is protected (see Workbook.undo).
    if (stack.at(-1)?.ops.some(changesSheets) && this.wb._structureLocked()) return false;
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

/**
 * A sheet's comments, objects (charts, pictures, shapes, text boxes), conditional formats, validation and merged
 * cells are one register each, but people add them in different places at the same time: where a pending change
 * and someone else's change made at once both write one of these lists, each writes the two merged instead (item
 * by item, and a thread reply by reply), so that neither person's additions are lost and what someone deleted
 * stays deleted. `bases` keeps what each list was before the pending change in hand (the state the room's change
 * was made on, for the first); `after` is what the room's change does once the pending one is in, for the
 * pending changes after it. Nothing is merged across rows, columns or sheets that move: the later list stands.
 */
const MERGED_LISTS = { comments: (b, x, y) => mergeThreads(b, x, y), charts: (b, x, y) => mergeItems(b, x, y, (i) => i?.id),
  rules: (b, x, y) => mergeItems(b, x, y, (i) => i?.id), validations: (b, x, y) => mergeItems(b, x, y, (i) => i?.id), merges: (b, x, y) => mergeMerges(b, x, y) };

function mergeLists(mine, theirs, bases, wb) {
  const none = { mine, theirs, after: [] };
  const listsOf = (op) => (op.t === 'props' ? Object.keys(op.v).filter((k) => own(MERGED_LISTS, k)) : []);
  if (bases.blocked) return none;
  if (mine.some(isStructure) || theirs.some(isStructure) || theirs.some((op) => op.t === 'put')) { bases.blocked = true; return none; }
  if (!mine.some((op) => listsOf(op).length)) return none;
  const after = [];
  const next = mine.map((op) => {
    const keys = listsOf(op);
    if (!keys.length) return op;
    const v = { ...op.v };
    for (const k of keys) {
      const at = `${op.s}\u0000${k}`;
      const base = bases.has(at) ? bases.get(at) : wb.sheet(op.s) ? sheetProps(wb.sheet(op.s), [k])[k] : null;
      bases.set(at, op.v[k]);
      const other = theirs.filter((t) => t.t === 'props' && t.s === op.s && own(t.v, k)).at(-1);
      if (!other) continue;
      const ours = op.v[k], their = other.v[k];
      // Unchanged on one side, the other's list stands (an emptied list is merged like any other).
      v[k] = sameJSON(ours, base) ? their : sameJSON(their, base) || sameJSON(ours, their) ? ours : MERGED_LISTS[k](base, ours, their);
      if (!sameJSON(v[k], op.v[k])) after.push({ t: 'props', s: op.s, v: { [k]: v[k] } });
    }
    return { ...op, v };
  });
  return { mine: next, theirs, after };
}

/**
 * Two edits of a list of items (each known by `idOf`) made at once on `base`, `b` the earlier in the room's order:
 * the items either kept or added, in the order of `a`, with those `b` added before the first that `a` added.
 */
function mergeItems(base, a, b, idOf) {
  const lists = [base, a, b].map((l) => (Array.isArray(l) ? l : []));
  // Items not told apart by an id cannot be merged: the later list stands.
  if (lists.some((l) => l.some((i) => idOf(i) == null)) || lists.some((l) => new Set(l.map(idOf)).size !== l.length)) return a;
  const [was, mine, theirs] = lists.map((l) => new Map(l.map((i) => [idOf(i), i])));
  const added = [];
  for (const [id, item] of theirs) { if (mine.has(id)) continue; const kept = merge3(was.get(id) ?? null, null, item, (x) => x); if (kept) added.push(kept); }
  const out = [];
  for (const [id, item] of mine) {
    if (!was.has(id)) out.push(...added.splice(0));
    const kept = merge3(was.get(id) ?? null, item, theirs.get(id) ?? null, (x) => x);
    if (kept) out.push(kept);
  }
  return [...out, ...added];
}

/** Merged cells from two edits: as items, but one of `b`'s that overlaps a block kept from `a` gives way to it (a cell is in one merge). */
function mergeMerges(base, a, b) {
  const key = (m) => (m ? `${m.r1},${m.c1},${m.r2},${m.c2}` : null);
  const all = mergeItems(base, a, b, key);
  if (all === a) return a;
  const mine = new Set((Array.isArray(a) ? a : []).map(key));
  const kept = all.filter((m) => mine.has(key(m)));
  const overlaps = (m, n) => m.r1 <= n.r2 && n.r1 <= m.r2 && m.c1 <= n.c2 && n.c1 <= m.c2;
  for (const m of all) if (!mine.has(key(m)) && !kept.some((n) => overlaps(m, n))) kept.push(m);
  return kept;
}

/** Three versions of one record: the base, and two edits of it made at once. Unchanged on one side, the other's stands. */
function merge3(base, a, b, both) {
  if (sameJSON(a, base)) return b;
  if (sameJSON(b, base) || sameJSON(a, b)) return a;
  // Deleted on one side and changed on the other: the change stays, rather than losing what was written.
  if (a == null || b == null) return a ?? b;
  return both(a, b);
}

/** A sheet's stored comments ({ "r,c": { done, items, assignee } }) merged from two edits of `base`. */
function mergeThreads(base, a, b) {
  const out = {};
  for (const key of new Set([...Object.keys(a || {}), ...Object.keys(b || {}), ...Object.keys(base || {})])) {
    const t = merge3(base?.[key] ?? null, a?.[key] ?? null, b?.[key] ?? null, (x, y) => mergeThread(base?.[key] ?? null, x, y));
    if (t?.items?.length) out[key] = t;
  }
  return Object.keys(out).length ? out : null;
}

/** One thread changed on both sides: replies added by either are kept, in time order after those both had. */
function mergeThread(base, a, b) {
  const byId = (t) => new Map((t?.items || []).map((i) => [i.id, i]));
  const was = byId(base), mine = byId(a), theirs = byId(b);
  const items = [];
  for (const [id, old] of was) {
    const item = merge3(old, mine.get(id) ?? null, theirs.get(id) ?? null, (x) => x);
    // A reply deleted on either side is gone, unless the other side rewrote it meanwhile.
    if (item && mine.has(id) && theirs.has(id)) items.push(item);
    else if (item && !sameJSON(item, old)) items.push(item);
  }
  const added = [...[...mine.values()].filter((i) => !was.has(i.id)), ...[...theirs.values()].filter((i) => !was.has(i.id) && !mine.has(i.id))];
  added.sort((x, y) => String(x.time).localeCompare(String(y.time)));
  const pick = (k) => (sameJSON(a[k] ?? null, base?.[k] ?? null) ? b[k] : a[k]);
  const done = pick('done'), assignee = pick('assignee');
  return { done: done === true, items: [...items, ...added], ...(assignee ? { assignee } : {}) };
}

/** A step whose operations take more characters than this travels in parts (the room takes MAX_CHANGE in one change). */
const SPLIT_AT = MAX_CHANGE * 0.8;
/** About the most characters of operations one part carries. */
const PART = MAX_CHANGE / 4;
const REGISTERS = new Set(['cells', 'lines', 'props', 'book']);

/**
 * A step too large for one change, as parts that each fit, to apply in order: [{ ops, inverse }]. Null when it
 * fits, or when it is not register writes alone (rows, columns or sheets that move are taken back by the
 * workbook's own undo step, whole). A write to many cells or lines is cut into runs of its keys; each part's
 * inverse puts back what its own registers held, so a part the room has not confirmed is taken back alone.
 */
export function splitChange(ops, inverses, limit = PART) {
  // A sheet added whole (a copy of a long sheet, say) can be larger than a change on its own: it travels as the sheet
  // without its cells, then its cells as writes like any other, which split as theirs do.
  if (ops.some((op) => op.t === 'put')) {
    const split = ops.flatMap((op, i) => (op.t === 'put' && inverses[i]?.length === 1 && inverses[i][0].t === 'drop' ? putInParts(op, inverses[i]) : [[op, inverses[i]]]));
    ops = split.map(([op]) => op);
    inverses = split.map(([, inv]) => inv);
  }
  // Rows, columns or sheets that move go whole, each in the part it falls in, with its own inverse (an undone deletion
  // of many rows puts them back, then writes back what was on them, which splits as any write does).
  if (!ops.every((op, i) => (REGISTERS.has(op.t) ? inverses[i]?.length === 1 && inverses[i][0].t === op.t : (isStructure(op) || op.t === 'put') && Array.isArray(inverses[i])))) return null;
  const keysOf = (op) => (op.t === 'cells' ? (op.st ? [...new Set([...Object.keys(op.v || {}), ...Object.keys(op.st)])] : Object.keys(op.v || {})) : op.t === 'lines' ? Object.keys(op.v) : null);
  // Fewer cells or lines than this cannot make a change too large (a cell holds 32,767 characters at most), nor can
  // deletions of fewer runs of lines; more operations than a change carries (an undone deletion of many runs) split too.
  let count = 0, runs = 0;
  for (const op of ops) {
    if (op.t === 'cells' || op.t === 'lines') count += Object.keys(op.v || {}).length + Object.keys(op.st || {}).length;
    else if (op.t === 'delete') runs += op.runs.length;
  }
  if (count < 64 && runs < 10_000 && ops.length <= MAX_OPS) return null;
  // What each operation, and each key of a write to cells or lines, takes when sent.
  let total = 0;
  const sized = ops.map((op) => {
    const keys = keysOf(op);
    if (!keys) { const size = JSON.stringify(op).length; total += size; return { size }; }
    const sizes = keys.map((k) => k.length + 8 + JSON.stringify(op.v?.[k] ?? null).length + (op.st ? JSON.stringify(op.st[k] ?? null).length : 0));
    const size = sizes.reduce((a, b) => a + b, 0) + 40;
    total += size;
    return { size, keys, sizes };
  });
  if (total <= SPLIT_AT && ops.length <= MAX_OPS) return null;
  const parts = [];
  let cur = null;
  const add = (op, inv, size) => {
    if (!cur || cur.ops.length >= MAX_OPS || (cur.size && cur.size + size > limit)) parts.push((cur = { ops: [], inverse: [], size: 0 }));
    cur.ops.push(op);
    cur.inverse.unshift(...inv);
    cur.size += size;
  };
  const piece = (op, keys) => {
    const out = { ...op };
    for (const field of ['v', 'st']) {
      if (!op[field]) continue;
      const kept = {};
      let any = false;
      for (const k of keys) if (own(op[field], k)) { kept[k] = op[field][k]; any = true; }
      if (any) out[field] = kept; else delete out[field];
    }
    return out;
  };
  ops.forEach((op, i) => {
    const { size, keys, sizes } = sized[i];
    if (!keys || size <= limit) { add(op, inverses[i], size); return; }
    const inv = inverses[i][0];
    let run = [], runSize = 0;
    const flush = () => { if (run.length) add(piece(op, run), [piece(inv, run)], runSize); run = []; runSize = 0; };
    keys.forEach((k, j) => {
      if (runSize && runSize + sizes[j] > limit) flush();
      run.push(k);
      runSize += sizes[j];
    });
    flush();
  });
  return parts.length > 1 ? parts.map(({ ops: o, inverse }) => ({ ops: o, inverse })) : null;
}

/**
 * An undo (or redo) entry ending in a deletion of lines, as one taking back an insertion does, leaves out the lines
 * someone else has since written something into (`theirs`, a change just applied), and one ending in a deletion of a
 * sheet (taking back an added sheet) leaves the sheet if someone else has worked on it: Undo takes back only what this
 * person did, and only where nobody has changed it since, so another person's entries are not deleted with it.
 */
function keepOthersWork(ops, theirs) {
  const last = ops.at(-1);
  if (last?.t === 'drop') return theirs.some((t) => t.s === last.s && t.t !== 'drop') ? ops.slice(0, -1) : ops;
  if (last?.t !== 'delete') return ops;
  const written = new Set();
  const line = (key) => { const p = parseCellKey(key); if (p) written.add(last.axis === 'row' ? p.r : p.c); };
  for (const t of theirs) {
    if (t.s !== last.s) continue;
    if (t.t === 'cells') {
      for (const [k, v] of Object.entries(t.v || {})) if (v != null) line(k);
      for (const [k, patch] of Object.entries(t.st || {})) if (Object.values(patch).some((v) => v != null)) line(k);
    } else if (t.t === 'lines') {
      for (const [k, v] of Object.entries(t.v)) {
        if (v == null) continue;
        if (LINE_PROPS[t.p] === 'cell') line(k);
        else if (LINE_PROPS[t.p] === last.axis) written.add(Number(k));
      }
    }
  }
  if (!written.size) return ops;
  const kept = [...written].sort((a, b) => a - b);
  const runs = [];
  for (const r of mergeRuns(last.runs)) {
    let from = r.from;
    for (const i of kept) if (i >= from && i <= r.to) { if (i > from) runs.push({ from, to: i - 1 }); from = i + 1; }
    if (from <= r.to) runs.push({ from, to: r.to });
  }
  return runs.length ? [...ops.slice(0, -1), { ...last, runs }] : ops.slice(0, -1);
}

/** A sheet added whole as [operation, inverse] pairs: the sheet without its cells, taken back by dropping it, then its cells. */
function putInParts(op, inverse) {
  const cells = op.sheet?.cells || {};
  const keys = Object.keys(cells);
  if (!keys.length) return [[op, inverse]];
  const v = {}, st = {}, iv = {}, ist = {};
  for (const key of keys) {
    const cell = cells[key];
    v[key] = contentOf(cell);
    iv[key] = null;
    if (cell?.s && Object.keys(cell.s).length) { st[key] = { ...cell.s }; ist[key] = Object.fromEntries(Object.keys(cell.s).map((k) => [k, null])); }
  }
  const write = { t: 'cells', s: op.s, v, ...(Object.keys(st).length ? { st } : {}) };
  const undo = { t: 'cells', s: op.s, v: iv, ...(Object.keys(ist).length ? { st: ist } : {}) };
  return [[{ ...op, sheet: { ...op.sheet, cells: {} } }, inverse], [write, [undo]]];
}

/** Two register writes made at once: where both write one register, the winner's value stands. */
function writesAgainst(a, b, aWins) {
  if (a.t === 'put' || b.t === 'put' || a.t !== b.t || (a.s ?? null) !== (b.s ?? null) || (a.t === 'lines' && a.p !== b.p)) return [[a], [b]];
  const [win, lose] = aWins ? [a, b] : [b, a];
  const rest = without(lose, win);
  return aWins ? [[a], rest ? [rest] : []] : [rest ? [rest] : [], [b]];
}

/** The part of register write `a` whose registers `b` also writes (null when none). */
function overlap(a, b) {
  if (a.t !== b.t || (a.s ?? null) !== (b.s ?? null) || (a.t === 'lines' && a.p !== b.p)) return null;
  if (a.t === 'cells') {
    const v = {}, st = {};
    for (const [k, val] of Object.entries(a.v || {})) if (own(b.v, k)) v[k] = val;
    for (const [k, patch] of Object.entries(a.st || {})) {
      const both = b.st?.[k] ? Object.fromEntries(Object.entries(patch).filter(([p]) => own(b.st[k], p))) : {};
      if (Object.keys(both).length) st[k] = both;
    }
    if (!Object.keys(v).length && !Object.keys(st).length) return null;
    return { t: 'cells', s: a.s, ...(Object.keys(v).length ? { v } : {}), ...(Object.keys(st).length ? { st } : {}) };
  }
  const v = Object.fromEntries(Object.entries(a.v).filter(([k]) => own(b.v, k)));
  return Object.keys(v).length ? { ...a, v } : null;
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
