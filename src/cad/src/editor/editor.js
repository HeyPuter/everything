/**
 * Interactive editor: turns pointer, touch and keyboard input into precise
 * points, selections and command prompts.
 *
 * Commands are async functions that ask for input:
 *
 *   const p = await ed.getPoint('Start point');
 *   const q = await ed.getPoint('End point', { base: p, preview: (c) => [line(p, c)] });
 *
 * A request resolves with the value, null when the user presses Enter with
 * nothing typed, or { option } when a keyword is chosen. Escape rejects with
 * CancelError, which the command runner swallows.
 */
import { findSnap, DEFAULT_SNAPS } from './snap.js';
import { pickEntity, entityCrossesRect } from './pick.js';
import { gripsOf, applyGrip } from './grips.js';
import { parsePointInput, matchOption, parseNumber } from './input.js';
import { baseProps } from '../core/schema.js';
import { formatLinear, formatAngle, parseAngle } from '../core/units.js';
import { transformEntity } from '../core/geom/index.js';

export class CancelError extends Error {
  constructor() {
    super('Cancelled');
  }
}

const TAU = Math.PI * 2;
const DRAG_PX = 5;
const ACQUIRE_MS = 450;

export const DEFAULT_SETTINGS = {
  osnap: true,
  osnapModes: DEFAULT_SNAPS,
  ortho: false,
  polar: true,
  polarInc: 90,
  otrack: true,
  grid: true,
  snap: false,
  snapSpacing: 10,
  gridSpacing: 10,
  dyn: true,
  lwDisplay: false,
  pickbox: 5,
  aperture: 10,
  gripSize: 5,
  crossSize: 5,
  selPreview: true,
};

export class Editor {
  /**
   * @param {object} o
   *   el        element receiving pointer events (the overlay canvas)
   *   renderer  Renderer
   *   camera    Camera
   *   overlay   Overlay
   *   ui        { prompt(text, options), log(text, kind), coords(x, y), input(): string,
   *               setInput(text), status(), contextMenu(x, y, items), toast(msg), openText(...) }
   *   commands  Map name -> command definition
   */
  constructor(o) {
    Object.assign(this, o);
    this.settings = { ...DEFAULT_SETTINGS, ...(o.settings || {}) };
    this.doc = null;
    this.request = null;
    this.active = null;
    this.lastCommand = null;
    this.lastPoint = null;
    this.previousSelection = new Set();
    this.cursor = { sx: -1, sy: -1, x: 0, y: 0, fx: 0, fy: 0, inside: false };
    this.snap = null;
    this.tracks = [];
    this.acquired = [];
    this._acq = null;
    this.angleLock = null;
    this.window = null;
    this.hoverId = null;
    this.hoverGrip = -1;
    this.pointers = new Map();
    this.gesture = null;
    this.panning = null;
    this._overlayRaf = 0;
    this._hoverTimer = 0;
    // Prompts set aside while a transparent command (pan, zoom) runs.
    this._parked = [];
    this._bind();
  }

  // Document ------------------------------------------------------------

  attach(doc) {
    if (this.active) this.cancelAll();
    this._stashLastPoints();
    // The last point (for @ input and continuing a line) belongs to its drawing.
    this.lastPoint = doc.lastPoint ?? null;
    this.lastLineEnd = doc.lastLineEnd ?? null;
    this.doc = doc;
    this.acquired = [];
    this.renderer.setSelection(doc.selection);
    this.refreshGrips();
    this.drawOverlay();
  }

  _stashLastPoints() {
    if (!this.doc) return;
    this.doc.lastPoint = this.lastPoint;
    this.doc.lastLineEnd = this.lastLineEnd;
  }

  get drawing() {
    return this.doc.drawing;
  }

  get header() {
    return this.doc.drawing.header;
  }

  get selection() {
    return this.doc.selection;
  }

  /** New entity object with the current layer/color/linetype/lineweight. */
  make(type, fields) {
    return { type, ...baseProps(this.header), ...fields };
  }

  /** Run fn as one undoable step (tagged with the running command for grouping). */
  commit(label, fn) {
    const d = this.drawing;
    if (d._tx) return d.transaction(label, fn);
    const prev = d.stepTag;
    d.stepTag = this.active?.token ?? null;
    try {
      return d.transaction(label, fn);
    } finally {
      d.stepTag = prev;
    }
  }

  // Commands ------------------------------------------------------------

  /** Look a command up by name or alias. */
  find(name) {
    const key = String(name).trim().toUpperCase().replace(/^[_.'-]+/, '');
    return this.commands.get(key) ?? null;
  }

  /** Start a command by name (cancels any running command). */
  async run(name, args) {
    const def = typeof name === 'object' ? name : this.find(name);
    if (!def) {
      this.ui.log(`Unknown command "${name}". Type a command name or press F1 for help.`, 'error');
      return;
    }
    if (def.needsDoc !== false && !this.doc) {
      this.ui.log(`${def.label || def.name}: open or create a drawing first.`, 'muted');
      return;
    }
    // File and panel commands never hold the command slot (a file picker
    // may never settle) or group undo steps, and they leave a running
    // command alone (switching drawings cancels it separately).
    if (def.immediate) {
      try {
        await def.run(this, args);
      } catch (err) {
        if (!(err instanceof CancelError)) {
          console.error(err);
          this.ui.log(`${def.label || def.name}: ${err.message || err}`, 'error');
        }
      }
      return;
    }
    if (def.transparent && this.active) return this._transparent(def, args);
    if (this.active) await this._stopActive();
    const token = {};
    const active = { def, token, done: null };
    this.active = active;
    if (!def.noRepeat) this.lastCommand = def.name;
    const drawing = this.drawing;
    const mark = drawing.undoStack.length;
    const shifted = drawing.shifted;
    this.ui.log(def.label || def.name, 'command');
    this.ui.commandChanged?.(def);
    let finish;
    active.done = new Promise((r) => (finish = r));
    try {
      await def.run(this, args);
    } catch (err) {
      if (!(err instanceof CancelError)) {
        console.error(err);
        this.ui.log(`${def.label || def.name}: ${err.message || err}`, 'error');
      } else this.ui.log('Cancelled', 'muted');
    } finally {
      if (this.active === active) {
        const from = Math.max(0, mark - (drawing.shifted - shifted));
        drawing.groupSince(from, token, def.label || def.name);
        this.active = null;
        this._resetCommandState();
        this.ui.prompt(null);
        this.ui.commandChanged?.(null);
        this.refreshGrips();
        this.drawOverlay();
      }
      finish();
    }
  }

  /** Cancel the running command and wait (briefly) for it to unwind. */
  async _stopActive() {
    const prev = this.active;
    this.cancelAll();
    if (prev?.done) await Promise.race([prev.done, new Promise((r) => setTimeout(r, 100))]);
    // A command that did not unwind in time is abandoned; clean up after it.
    if (this.active === prev) {
      this.active = null;
      this._resetCommandState();
    }
  }

  /** Clear everything a command may have left on screen. */
  _resetCommandState() {
    this._endRequest();
    this.window = null;
    this.hotGrip = null;
    this.renderer.setPreview([]);
    this.renderer.setDragMatrix(null);
    this.renderer.setHidden(new Set());
    this.angleLock = null;
    clearTimeout(this._acqTimer);
    this.acquired = [];
  }

  /**
   * Run a view command (zoom, pan) in the middle of another command: the
   * outer prompt is parked and restored afterwards instead of cancelled.
   */
  async _transparent(def, args) {
    const slot = { request: this.request };
    this._parked.push(slot);
    this.request = null;
    try {
      await def.run(this, args);
    } catch (err) {
      if (!(err instanceof CancelError)) console.error(err);
    } finally {
      this.window = null;
      const i = this._parked.indexOf(slot);
      // Still parked: the outer command resumes. Otherwise cancelAll() has
      // already rejected it and the inner prompt.
      if (i >= 0) {
        this._parked.splice(i, 1);
        if (this.request && this.request !== slot.request) {
          const r = this.request;
          this.request = null;
          r.reject(new CancelError());
        }
        const outer = slot.request;
        this.request = outer;
        if (outer) this.ui.prompt(outer.prompt, outer.options, outer.opts.defaultLabel);
      }
      this._updateCursor(this.cursor.sx, this.cursor.sy);
    }
  }

  /** Cancel the current prompt and any prompts parked by transparent commands. */
  cancelAll() {
    const parked = this._parked.splice(0);
    const r = this.cancel();
    for (const p of parked) p.request?.reject(new CancelError());
    return r || parked.length > 0;
  }

  /** Stop using the current document (for example when every drawing is closed). */
  detach() {
    if (this.request || this._parked.length) this.cancelAll();
    const wasActive = !!this.active;
    this.active = null;
    this._resetCommandState();
    this.ui.prompt(null);
    if (wasActive) this.ui.commandChanged?.(null);
    this._stashLastPoints();
    this.lastPoint = this.lastLineEnd = null;
    this.doc = null;
    this.grips = [];
    this.acquired = [];
  }

  /** Cancel the running command (or clear the selection when idle). */
  cancel() {
    if (this.request) {
      const r = this.request;
      this.request = null;
      this.window = null;
      r.reject(new CancelError());
      return true;
    }
    if (this.active) {
      // The command is busy with something other than a prompt (a dialog,
      // the clipboard); it finishes on its own.
      return true;
    }
    if (this.window) {
      this.window = null;
      this.drawOverlay();
      return true;
    }
    if (this.doc && this.selection.size) {
      this.clearSelection();
      return true;
    }
    return false;
  }

  get busy() {
    return !!this.active;
  }

  // Requests --------------------------------------------------------------

  _ask(kind, prompt, opts = {}) {
    if (this.request) this.request.reject(new CancelError());
    return new Promise((resolve, reject) => {
      this.request = { kind, prompt, opts, resolve, reject, options: opts.options || [] };
      this.angleLock = null;
      this.ui.prompt(prompt, this.request.options, opts.defaultLabel);
      this._updateCursor(this.cursor.sx, this.cursor.sy, true);
    });
  }

  _endRequest() {
    this.request = null;
    this.snapOverride = null;
    this.snap = null;
    this.tracks = [];
    this.renderer.setPreview([]);
  }

  _resolve(value) {
    const r = this.request;
    if (!r) return;
    this._endRequest();
    r.resolve(value);
  }

  /** Ask for a point. Returns {x, y} | {option} | null (Enter). */
  getPoint(prompt, opts = {}) {
    return this._ask('point', prompt, opts);
  }

  /**
   * Ask for a distance: typed value, or a pick from base (or two picks).
   * opts.factor shows the default as a plain number (a scale factor, not a length).
   */
  async getDistance(prompt, opts = {}) {
    const def = opts.default;
    const plain = opts.factor && Number.isFinite(def);
    const shown = plain ? String(+def.toPrecision(10)) : formatLinear(def, this.header);
    const label = def !== undefined ? `${prompt} <${shown}>` : prompt;
    const r = await this._ask('distance', label, opts);
    if (r === null) return def ?? null;
    if (typeof r === 'number' || r?.option) return r;
    if (opts.base) return Math.hypot(r.x - opts.base.x, r.y - opts.base.y);
    const q = await this._ask('distance', 'Second point', { ...opts, base: r });
    if (q === null) return def ?? null;
    if (typeof q === 'number' || q?.option) return q;
    return Math.hypot(q.x - r.x, q.y - r.y);
  }

  /** Ask for an angle in radians: typed (degrees by default) or picked from base. */
  async getAngle(prompt, opts = {}) {
    const def = opts.default;
    const label = def !== undefined ? `${prompt} <${formatAngle(def, this.header)}>` : prompt;
    const r = await this._ask('angle', label, opts);
    if (r === null) return def ?? null;
    if (typeof r === 'number' || r?.option) return r;
    if (opts.base) return Math.atan2(r.y - opts.base.y, r.x - opts.base.x);
    const q = await this._ask('angle', 'Second point', { ...opts, base: r });
    if (q === null) return def ?? null;
    if (typeof q === 'number' || q?.option) return q;
    return Math.atan2(q.y - r.y, q.x - r.x);
  }

  /** Ask for a keyword; returns its value or the default on Enter. */
  async getKeyword(prompt, options, def) {
    const r = await this._ask('keyword', prompt, { options, defaultLabel: def });
    if (r === null) return def ?? null;
    return r.option ?? r;
  }

  /** Ask for a number. */
  async getNumber(prompt, opts = {}) {
    const def = opts.default;
    const label = def !== undefined ? `${prompt} <${def}>` : prompt;
    for (;;) {
      const r = await this._ask('number', label, opts);
      if (r === null) return def ?? null;
      if (r?.option) return r;
      if (Number.isFinite(r) && (opts.min === undefined || r >= opts.min) && (opts.max === undefined || r <= opts.max)) return r;
      const { min, max } = opts;
      let range = '';
      if (min !== undefined && max !== undefined) range = ` from ${min} to ${max}`;
      else if (min !== undefined) range = ` of at least ${min}`;
      else if (max !== undefined) range = ` of at most ${max}`;
      this.ui.log(`Enter a number${range}.`, 'error');
    }
  }

  /** Ask for a line of text. */
  async getString(prompt, opts = {}) {
    const r = await this._ask('string', prompt, opts);
    if (r === null) return opts.default ?? '';
    return r;
  }

  /** Pick one object. Returns { id, ent, x, y } | {option} | null. */
  getEntity(prompt, opts = {}) {
    return this._ask('entity', prompt, opts);
  }

  /**
   * Select objects. Uses the current selection when there is one (unless
   * opts.fresh), otherwise lets the user build a selection and press Enter.
   * Returns an array of ids (possibly empty).
   */
  async getSelection(prompt = 'Select objects', opts = {}) {
    if (!opts.fresh && this.selection.size) {
      const ids = [...this.selection].filter((id) => this._editable(id) && (!opts.filter || opts.filter(this.drawing.get(id))));
      if (ids.length) {
        this.previousSelection = new Set(ids);
        return ids;
      }
      // Nothing usable was preselected (for example a locked layer): ask.
    }
    this.clearSelection();
    this.selMode = 'add';
    const options = [
      { key: 'ALL', label: 'All', value: 'all' },
      { key: 'L', label: 'Last', value: 'last' },
      { key: 'P', label: 'Previous', value: 'previous' },
      { key: 'R', label: 'Remove', value: 'remove' },
      { key: 'A', label: 'Add', value: 'add' },
    ];
    for (;;) {
      const r = await this._ask('select', `${prompt}${this.selection.size ? ` (${this.selection.size} found)` : ''}`, { ...opts, options });
      if (r === null) break;
      if (r.option === 'all') this.addToSelection(this._allEditable(opts.filter));
      else if (r.option === 'last') {
        const last = [...this.drawing.entities.keys()].reverse().find((id) => this._editable(id));
        if (last) this.addToSelection([last]);
      } else if (r.option === 'previous') this.addToSelection([...this.previousSelection].filter((id) => this.drawing.entities.has(id)));
      else if (r.option === 'remove') this.selMode = 'remove';
      else if (r.option === 'add') this.selMode = 'add';
      if (opts.single && this.selection.size) break;
    }
    this.selMode = 'add';
    let ids = [...this.selection];
    if (opts.filter) ids = ids.filter((id) => opts.filter(this.drawing.get(id)));
    this.previousSelection = new Set(ids);
    return ids;
  }

  /** Clear the visible selection without touching previousSelection. */
  clearSelection() {
    if (!this.doc) return;
    this.doc.selection = new Set();
    this.renderer.setSelection(this.doc.selection);
    this.refreshGrips();
    this.ui.selectionChanged?.();
    this.drawOverlay();
  }

  setSelection(ids) {
    this.doc.selection = new Set(ids);
    this.renderer.setSelection(this.doc.selection);
    this.refreshGrips();
    this.ui.selectionChanged?.();
    this.drawOverlay();
  }

  addToSelection(ids) {
    const s = new Set(this.selection);
    for (const id of ids) {
      if (this.selMode === 'remove') s.delete(id);
      else if (this._editable(id)) s.add(id);
    }
    this.setSelection(s);
  }

  _editable(id) {
    const e = this.drawing.get(id);
    return !!e && this.drawing.layerEditable(e.layer);
  }

  _allEditable(filter) {
    const out = [];
    for (const [id, e] of this.drawing.entities) if (this.drawing.layerEditable(e.layer) && (!filter || filter(e))) out.push(id);
    return out;
  }

  // Typed input -------------------------------------------------------------

  /** Handle text submitted from the command line (Enter or Space). */
  submit(text) {
    const t = text.trim();
    const r = this.request;
    if (!r) {
      if (!t) {
        if (this.lastCommand) this.run(this.lastCommand);
        return;
      }
      this.run(t);
      return;
    }
    if (!t) {
      // Enter with nothing typed.
      if (r.kind === 'point' && this.angleLock !== null) return;
      this._resolve(null);
      return;
    }
    // 'ZOOM, 'PAN, ...: a view command in the middle of this one.
    if (t[0] === "'" && r.kind !== 'string') {
      const def = this.find(t);
      if (def?.transparent) this.run(def);
      else this.ui.log(`${t.slice(1)} cannot be used inside another command.`, 'error');
      return;
    }
    // Snap overrides typed at a point prompt (END, MID, CEN, ...).
    const ov = SNAP_KEYWORDS[t.toUpperCase()];
    if (ov && (r.kind === 'point' || r.kind === 'distance' || r.kind === 'angle') && !matchOption(t, r.options)) {
      this.setSnapOverride(ov);
      return;
    }
    const opt = matchOption(t, r.options);
    if (opt) {
      this.ui.log(`${r.prompt}: ${t}`, 'input');
      this._resolve({ option: opt });
      return;
    }
    const header = this.header;
    switch (r.kind) {
      case 'point':
      case 'distance':
      case 'angle': {
        if (r.kind === 'angle') {
          const a = parseAngle(t, header);
          if (Number.isFinite(a)) {
            this.ui.log(`${r.prompt}: ${t}`, 'input');
            return this._resolve(a);
          }
        }
        const p = parsePointInput(t, { last: r.opts.base || this.lastPoint, header });
        if (p.kind === 'point') {
          this.ui.log(`${r.prompt}: ${t}`, 'input');
          this.lastPoint = { x: p.x, y: p.y };
          return this._resolve({ x: p.x, y: p.y });
        }
        if (p.kind === 'distance') {
          if (r.kind === 'distance') {
            this.ui.log(`${r.prompt}: ${t}`, 'input');
            return this._resolve(p.d);
          }
          const base = r.opts.base;
          if (r.kind === 'point' && base) {
            // Direct distance entry along the current (tracked) direction.
            const dir = this._direction(base);
            if (dir) {
              const q = { x: base.x + dir.x * p.d, y: base.y + dir.y * p.d };
              this.ui.log(`${r.prompt}: ${t}`, 'input');
              this.lastPoint = q;
              return this._resolve(q);
            }
          }
        }
        if (p.kind === 'angle' && r.kind === 'point' && r.opts.base) {
          this.angleLock = p.a;
          this.ui.log(`Angle locked at ${formatAngle(p.a, header)}`, 'muted');
          this._updateCursor(this.cursor.sx, this.cursor.sy, true);
          return;
        }
        this.ui.log('Invalid point. Use x,y or @dx,dy or @distance<angle.', 'error');
        return;
      }
      case 'number': {
        const v = parseNumber(t, header);
        this.ui.log(`${r.prompt}: ${t}`, 'input');
        return this._resolve(Number.isFinite(v) ? v : NaN);
      }
      case 'string':
        this.ui.log(`${r.prompt}: ${t}`, 'input');
        return this._resolve(text);
      case 'keyword':
        this.ui.log(`Choose one of: ${r.options.map((o) => o.label).join(', ')}`, 'error');
        return;
      case 'select':
      case 'entity':
        this.ui.log('Select objects in the drawing, or press Enter to finish.', 'error');
        return;
    }
  }

  /** Whether Space should act like Enter right now (not while typing text). */
  get spaceSubmits() {
    return !(this.request && this.request.kind === 'string' && this.request.opts.spaces !== false);
  }

  /** Unit vector from base toward the cursor (respecting locks), or null. */
  _direction(base) {
    if (this.angleLock !== null) return { x: Math.cos(this.angleLock), y: Math.sin(this.angleLock) };
    const dx = this.cursor.fx - base.x,
      dy = this.cursor.fy - base.y;
    const l = Math.hypot(dx, dy);
    return l > 1e-12 ? { x: dx / l, y: dy / l } : null;
  }

  // Pointer handling ----------------------------------------------------------

  _bind() {
    const el = this.el;
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    el.addEventListener('pointerup', (e) => this._up(e));
    el.addEventListener('pointercancel', (e) => this._cancelPointer(e));
    el.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') {
        this.cursor.inside = false;
        this.drawOverlay();
      }
    });
    el.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // A touch long-press is part of placing a point, not a menu request.
      if (e.pointerType === 'touch' || e.pointerType === 'pen' || e.sourceCapabilities?.firesTouchEvents) return;
      // Shift+F10 or the Menu key: open the menu at the cursor (or the canvas centre).
      if (performance.now() - (this._rightDownAt || 0) > 400) {
        const r = this.el.getBoundingClientRect();
        const inside = this.cursor.inside && this.cursor.sx >= 0;
        this._contextMenu(r.left + (inside ? this.cursor.sx : r.width / 2), r.top + (inside ? this.cursor.sy : r.height / 2));
      }
    });
    el.addEventListener('dblclick', (e) => this._dblclick(e));
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) e.preventDefault();
    });
  }

  _pos(e) {
    const r = this.el.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  _down(e) {
    this.lastPointerType = e.pointerType;
    this.shiftDown = e.shiftKey;
    this.el.focus({ preventScroll: true });
    const { sx, sy } = this._pos(e);
    this.pointers.set(e.pointerId, { sx, sy, type: e.pointerType, sx0: sx, sy0: sy, t: performance.now(), button: e.button });
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (e.pointerType === 'touch' && this.pointers.size === 2) {
      this._startGesture();
      return;
    }
    if (this.gesture) return;
    if (e.button === 1 || (e.button === 0 && this.panTool)) {
      e.preventDefault();
      this.panning = { sx, sy, moved: false, id: e.pointerId, mid: e.button === 1 };
      this.el.classList.add('is-panning');
      return;
    }
    if (e.button === 2) {
      this._rightDownAt = performance.now();
      this.pointers.delete(e.pointerId);
      this._contextMenu(e.clientX, e.clientY);
      return;
    }
    if (e.button !== 0) return;
    this._updateCursor(sx, sy);
    const p = this.pointers.get(e.pointerId);
    p.downCursor = { ...this.cursor };
    if (e.pointerType === 'touch') {
      // Touch acts on lift so the finger can fine-tune the position first.
      if (!this.request) p.maybePan = true;
      return;
    }
    this._press(e, p);
  }

  /** Primary press at the current cursor (mouse down or touch lift). */
  _press(e, p) {
    const r = this.request;
    const shift = e.shiftKey;
    if (r) {
      if (r.kind === 'point' || r.kind === 'distance' || r.kind === 'angle') {
        if (r.opts.drag && p) {
          p.dragResolve = true;
          return;
        }
        const pt = { x: this.cursor.fx, y: this.cursor.fy };
        this.lastPoint = pt;
        this._resolve(pt);
        return;
      }
      if (r.kind === 'entity') {
        const hit = this._pick(this.cursor.x, this.cursor.y, r.opts.filter);
        if (hit) {
          this._resolve({ id: hit.id, ent: this.drawing.get(hit.id), x: this.cursor.x, y: this.cursor.y });
        }
        return;
      }
      if (r.kind === 'select') {
        this._selectPress(this.cursor.sx, this.cursor.sy, shift, p);
        return;
      }
      return;
    }
    // Idle: grips first, then objects, then a selection window.
    if (this.hoverGrip >= 0) {
      this._startGripEdit(this.hoverGrip, p);
      return;
    }
    this._selectPress(this.cursor.sx, this.cursor.sy, shift, p);
  }

  _selectPress(sx, sy, shift, p) {
    if (this.window) {
      this._finishWindow(sx, sy, shift);
      return;
    }
    const hit = this._pick(this.cursor.x, this.cursor.y);
    if (hit) {
      if (shift || this.selMode === 'remove') {
        const s = new Set(this.selection);
        s.delete(hit.id);
        this.setSelection(s);
      } else this.addToSelection([hit.id]);
      return;
    }
    this.window = { x1: sx, y1: sy, x2: sx, y2: sy, shift, pointer: p };
    if (p) p.windowStart = true;
    this.drawOverlay();
  }

  _finishWindow(sx, sy, shift) {
    const w = this.window;
    this.window = null;
    const a = this.camera.toWorld(Math.min(w.x1, sx), Math.max(w.y1, sy));
    const b = this.camera.toWorld(Math.max(w.x1, sx), Math.min(w.y1, sy));
    const crossing = sx < w.x1;
    const ids = this.windowSelect(a.x, a.y, b.x, b.y, crossing);
    if (shift || w.shift || this.selMode === 'remove') {
      const s = new Set(this.selection);
      for (const id of ids) s.delete(id);
      this.setSelection(s);
    } else this.addToSelection(ids);
    this.drawOverlay();
  }

  /** Ids inside (window) or touching (crossing) the world rectangle. */
  windowSelect(x0, y0, x1, y1, crossing) {
    const idx = this.doc.index;
    const d = this.drawing;
    if (!crossing) {
      const ids = idx.searchInside(x0, y0, x1, y1).filter((id) => this._editable(id));
      return ids;
    }
    const tol = 0.5 / this.camera.scale;
    const out = [];
    for (const id of idx.search(x0, y0, x1, y1, true)) {
      if (!this._editable(id)) continue;
      const ent = d.get(id);
      const b = idx.bounds(id);
      if (b && b[0] >= x0 && b[2] <= x1 && b[1] >= y0 && b[3] <= y1) out.push(id);
      else if (entityCrossesRect(d, ent, [x0, y0, x1, y1], tol)) out.push(id);
    }
    return out;
  }

  _pick(x, y, filter) {
    const r = this.settings.pickbox / this.camera.scale;
    const ids = this.doc.index.search(x - r, y - r, x + r, y + r, true).filter((id) => this._editable(id));
    return pickEntity(this.drawing, ids, x, y, r, filter);
  }

  _move(e) {
    const { sx, sy } = this._pos(e);
    const p = this.pointers.get(e.pointerId);
    if (p) {
      p.sx = sx;
      p.sy = sy;
    }
    if (this.gesture) {
      this._updateGesture();
      return;
    }
    if (this.panning) {
      this.camera.panBy(sx - this.panning.sx, sy - this.panning.sy);
      this.panning.sx = sx;
      this.panning.sy = sy;
      this.panning.moved = true;
      this.viewChanged();
      return;
    }
    if (p && p.maybePan && e.pointerType === 'touch') {
      // One finger drag pans while idle.
      if (Math.hypot(sx - p.sx0, sy - p.sy0) > DRAG_PX * 2 || p.panned) {
        if (!p.panned) {
          p.panned = true;
          p.lx = p.sx0;
          p.ly = p.sy0;
        }
        this.camera.panBy(sx - p.lx, sy - p.ly);
        p.lx = sx;
        p.ly = sy;
        this.viewChanged();
        return;
      }
    }
    this.cursor.inside = true;
    if (this.window) {
      this.window.x2 = sx;
      this.window.y2 = sy;
      if (p && p.windowStart && Math.hypot(sx - p.sx0, sy - p.sy0) > DRAG_PX) p.windowDrag = true;
    }
    this._updateCursor(sx, sy);
  }

  _up(e) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.gesture) {
      if (this.pointers.size < 2) {
        this.gesture = null;
        // The remaining finger keeps panning from where it is now.
        for (const q of this.pointers.values()) {
          q.panned = true;
          q.lx = q.sx;
          q.ly = q.sy;
        }
      }
      return;
    }
    if (this.panning && this.panning.id === e.pointerId) {
      const pan = this.panning;
      this.panning = null;
      this.el.classList.remove('is-panning');
      if (!pan.moved && pan.mid) return;
      return;
    }
    if (!p) return;
    const { sx, sy } = this._pos(e);
    if (e.pointerType === 'touch') {
      if (p.panned) return;
      this._updateCursor(sx, sy);
      this._press(e, p);
      // A touch window needs a second tap; drags pan instead.
      return;
    }
    if ((p.dragResolve || p.gripDrag) && this.request) {
      const moved = Math.hypot(sx - p.sx0, sy - p.sy0) > DRAG_PX;
      if (moved) {
        const pt = { x: this.cursor.fx, y: this.cursor.fy };
        this._resolve(pt);
      } else if (this.request) this.request.opts.drag = false;
      return;
    }
    if (this.window && p.windowDrag) this._finishWindow(sx, sy, e.shiftKey);
  }

  _cancelPointer(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.gesture = null;
    if (this.panning?.id === e.pointerId) this.panning = null;
  }

  _startGesture() {
    const pts = [...this.pointers.values()];
    // A pending window from the first finger is abandoned.
    this.window = null;
    for (const p of pts) {
      p.panned = true;
      p.lx = p.sx;
      p.ly = p.sy;
    }
    this.gesture = { mid: mid(pts), dist: dist(pts) };
  }

  _updateGesture() {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const m = mid(pts),
      d = dist(pts);
    const g = this.gesture;
    this.camera.panBy(m.sx - g.mid.sx, m.sy - g.mid.sy);
    if (g.dist > 0 && d > 0) this.camera.zoomAt(m.sx, m.sy, d / g.dist);
    g.mid = m;
    g.dist = d;
    this.viewChanged();
  }

  _wheel(e) {
    e.preventDefault();
    const { sx, sy } = this._pos(e);
    let dy = e.deltaY,
      dx = e.deltaX;
    if (e.deltaMode === 1) {
      dy *= 16;
      dx *= 16;
    } else if (e.deltaMode === 2) {
      dy *= 400;
      dx *= 400;
    }
    const trackpadPan = !e.ctrlKey && (Math.abs(dx) > 0.5 || (e.deltaMode === 0 && Math.abs(dy) < 40 && !Number.isInteger(dy)));
    if (trackpadPan && this.settings.trackpadPan !== false) {
      this.camera.panBy(-dx, -dy);
    } else {
      const k = e.ctrlKey ? 0.01 : 0.0018;
      this.camera.zoomAt(sx, sy, Math.exp(-dy * k));
    }
    this.viewChanged();
    this._updateCursor(sx, sy);
  }

  _dblclick(e) {
    if (this.request || this.active) return;
    const { sx, sy } = this._pos(e);
    const w = this.camera.toWorld(sx, sy);
    const hit = this._pick(w.x, w.y);
    if (hit) this.ui.editEntity?.(hit.id);
  }

  // Cursor, snaps and tracking -------------------------------------------------

  _updateCursor(sx, sy, force) {
    if (sx < 0 || !this.doc) return;
    const cam = this.camera;
    const c = this.cursor;
    c.sx = sx;
    c.sy = sy;
    const w = cam.toWorld(sx, sy);
    c.x = w.x;
    c.y = w.y;
    const r = this.request;
    const wantsPoint = r && (r.kind === 'point' || r.kind === 'distance' || r.kind === 'angle');
    this.snap = null;
    this.tracks = [];
    let fx = w.x,
      fy = w.y;
    if (wantsPoint) {
      const base = r.opts.base || null;
      const st = this.settings;
      let snapped = false;
      // A one-shot override snaps to that mode only, even with object snap off.
      const modes = this.snapOverride ? new Set([this.snapOverride]) : new Set(st.osnapModes);
      if ((st.osnap || this.snapOverride) && !r.opts.noSnap) {
        const ap = st.aperture / cam.scale;
        const ids = this.doc.index.search(w.x - ap, w.y - ap, w.x + ap, w.y + ap, true);
        // Extension has no point of its own: hovering an end acquires it and
        // the cursor then tracks along the extension (see _track).
        const extOnly = this.snapOverride === 'ext';
        const s = extOnly ? null : findSnap(this.drawing, ids, w.x, w.y, ap, modes, base);
        if (s) {
          fx = s.x;
          fy = s.y;
          snapped = true;
          this.snap = s;
          this._acquire(s);
        } else if (extOnly) {
          this._acquire(findSnap(this.drawing, ids, w.x, w.y, ap, new Set(['end']), base));
        } else this._acquire(null);
      }
      if (!snapped) {
        if (st.snap) {
          const g = st.snapSpacing || 10;
          fx = Math.round(fx / g) * g;
          fy = Math.round(fy / g) * g;
        }
        const t = this._track(base, fx, fy);
        fx = t.x;
        fy = t.y;
      } else if (base && this.angleLock !== null) {
        // A typed <angle lock wins: the snap only sets the distance along it.
        const t = this._track(base, fx, fy);
        fx = t.x;
        fy = t.y;
      }
    } else {
      this._idleHover(w.x, w.y, sx, sy);
    }
    c.fx = fx;
    c.fy = fy;
    if (wantsPoint && r.opts.preview) {
      try {
        const ents = r.opts.preview({ x: fx, y: fy });
        this.renderer.setPreview(ents || []);
      } catch (err) {
        console.warn(err);
      }
    }
    if (wantsPoint && r.opts.onMove) r.opts.onMove({ x: fx, y: fy });
    this.ui.coords(fx, fy, r?.opts.base);
    this.drawOverlay();
    void force;
  }

  /** Polar, ortho, angle lock and object snap tracking. */
  _track(base, x, y) {
    const st = this.settings;
    const cam = this.camera;
    const tolPx = 8;
    let best = null;
    if (base) {
      const dx = x - base.x,
        dy = y - base.y;
      const len = Math.hypot(dx, dy);
      if (this.angleLock !== null) {
        const ux = Math.cos(this.angleLock),
          uy = Math.sin(this.angleLock);
        const t = dx * ux + dy * uy;
        this._trackLine(base, ux, uy);
        return { x: base.x + ux * t, y: base.y + uy * t };
      }
      if (st.ortho) {
        if (Math.abs(dx) >= Math.abs(dy)) return { x, y: base.y };
        return { x: base.x, y };
      }
      if (st.polar && len * cam.scale > 4) {
        const inc = ((st.polarInc || 90) * Math.PI) / 180;
        const ang = Math.atan2(dy, dx);
        const k = Math.round(ang / inc);
        const a = k * inc;
        const ux = Math.cos(a),
          uy = Math.sin(a);
        const t = dx * ux + dy * uy;
        const off = Math.abs(-uy * dx + ux * dy) * cam.scale;
        if (t > 0 && off < tolPx) best = { x: base.x + ux * t, y: base.y + uy * t, line: [base, ux, uy], angle: a, dist: t };
      }
    }
    // Object snap tracking: align with acquired points horizontally or vertically.
    const extOnly = this.snapOverride === 'ext';
    if ((st.otrack || extOnly) && this.acquired.length) {
      const lines = [];
      const ext = extOnly || st.osnapModes.includes('ext');
      for (const p of this.acquired) {
        if (!extOnly) lines.push({ p, ux: 1, uy: 0 }, { p, ux: 0, uy: 1 });
        // Extension: continue straight objects that end at the acquired point.
        if (ext) for (const dir of p.dirs || []) lines.push({ p, ux: dir.x, uy: dir.y, ext: true });
      }
      if (base && st.polar && !extOnly) {
        const inc = ((st.polarInc || 90) * Math.PI) / 180;
        if (Math.abs(inc - Math.PI / 2) > 1e-9) {
          for (const p of this.acquired) for (let a = inc; a < Math.PI - 1e-9; a += inc) if (Math.abs(a - Math.PI / 2) > 1e-9) lines.push({ p, ux: Math.cos(a), uy: Math.sin(a) });
        }
      }
      const near = [];
      for (const l of lines) {
        const dx = x - l.p.x,
          dy = y - l.p.y;
        const off = Math.abs(-l.uy * dx + l.ux * dy) * cam.scale;
        if (off < tolPx) near.push({ ...l, off });
      }
      if (best) near.push({ p: best.line[0], ux: best.line[1], uy: best.line[2], off: 0, polar: true });
      if (near.length >= 2) {
        near.sort((a, b) => a.off - b.off);
        for (let i = 0; i < near.length; i++) {
          for (let j = i + 1; j < near.length; j++) {
            const ip = lineInt(near[i], near[j]);
            if (ip && Math.hypot(ip.x - x, ip.y - y) * cam.scale < tolPx * 1.5) {
              this._trackLine(near[i].p, near[i].ux, near[i].uy, ip);
              this._trackLine(near[j].p, near[j].ux, near[j].uy, ip);
              this.snap = { x: ip.x, y: ip.y, mode: 'int', tracked: true };
              this.trackLabel = null;
              return ip;
            }
          }
        }
      }
      if (near.length && !best) {
        const l = near.sort((a, b) => a.off - b.off)[0];
        const t = (x - l.p.x) * l.ux + (y - l.p.y) * l.uy;
        const q = { x: l.p.x + l.ux * t, y: l.p.y + l.uy * t };
        this._trackLine(l.p, l.ux, l.uy, q);
        this.trackLabel = `Tracking: ${formatLinear(Math.abs(t), this.header)}`;
        return q;
      }
    }
    if (best) {
      this._trackLine(best.line[0], best.line[1], best.line[2]);
      this.trackLabel = `Polar: ${formatLinear(best.dist, this.header)} < ${formatAngle(norm(best.angle), this.header)}`;
      return { x: best.x, y: best.y };
    }
    this.trackLabel = null;
    return { x, y };
  }

  _trackLine(p, ux, uy) {
    const cam = this.camera;
    const s = cam.toScreen(p.x, p.y);
    const L = 5000;
    this.tracks.push({ x1: s.x - ux * L, y1: s.y + uy * L, x2: s.x + ux * L, y2: s.y - uy * L });
  }

  /** Snap to one mode for the next point only. */
  setSnapOverride(mode) {
    this.snapOverride = mode;
    this.ui.log(`Snap to ${SNAP_LABELS[mode] ?? mode} for the next point`, 'muted');
    this._updateCursor(this.cursor.sx, this.cursor.sy);
  }

  /** Directions of lines and straight polyline segments ending at (x, y), pointing away from them. */
  _extensionDirs(x, y) {
    const tol = 1e-6 * Math.max(1, Math.abs(x), Math.abs(y));
    const out = [];
    const add = (ax, ay, bx, by) => {
      // (bx, by) is the end at the point; extend beyond it.
      if (Math.abs(bx - x) > tol || Math.abs(by - y) > tol) return;
      const l = Math.hypot(bx - ax, by - ay);
      if (l > tol) out.push({ x: (bx - ax) / l, y: (by - ay) / l });
    };
    for (const id of this.doc.index.search(x - tol, y - tol, x + tol, y + tol, false)) {
      const e = this.drawing.get(id);
      if (!e) continue;
      if (e.type === 'line') {
        add(e.x1, e.y1, e.x2, e.y2);
        add(e.x2, e.y2, e.x1, e.y1);
      } else if (e.type === 'polyline' && !e.closed) {
        const p = e.pts,
          n = p.length / 3;
        if (n >= 2 && !p[2]) add(p[3], p[4], p[0], p[1]);
        if (n >= 2 && !p[(n - 2) * 3 + 2]) add(p[(n - 2) * 3], p[(n - 2) * 3 + 1], p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
      }
    }
    return out.slice(0, 4);
  }

  /** Hovering an object snap point for a moment acquires it for tracking. */
  _acquire(s) {
    if (!this.settings.otrack && this.snapOverride !== 'ext') return;
    clearTimeout(this._acqTimer);
    if (!s) return;
    const key = `${s.x.toFixed(9)},${s.y.toFixed(9)}`;
    this._acqTimer = setTimeout(() => {
      const i = this.acquired.findIndex((p) => p.key === key);
      if (i >= 0) this.acquired.splice(i, 1);
      else {
        this.acquired.push({ x: s.x, y: s.y, key, dirs: this._extensionDirs(s.x, s.y) });
        if (this.acquired.length > 7) this.acquired.shift();
      }
      this.drawOverlay();
    }, ACQUIRE_MS);
  }

  _idleHover(x, y, sx, sy) {
    // Grips under the cursor.
    this.hoverGrip = -1;
    if (!this.request && this.grips?.length) {
      const g = this.settings.gripSize + 2;
      for (let i = 0; i < this.grips.length; i++) {
        const s = this.camera.toScreen(this.grips[i].x, this.grips[i].y);
        if (Math.abs(s.x - sx) <= g && Math.abs(s.y - sy) <= g) {
          this.hoverGrip = i;
          break;
        }
      }
    }
    // Rollover highlight, throttled to the next frame.
    if (!this.settings.selPreview || this.window || this.pointers.size) {
      this.renderer.setHover(null);
      return;
    }
    cancelAnimationFrame(this._hoverRaf);
    this._hoverRaf = requestAnimationFrame(() => {
      const r = this.request;
      if (r && r.kind !== 'select' && r.kind !== 'entity') {
        this.renderer.setHover(null);
        return;
      }
      const hit = this.hoverGrip < 0 ? this._pick(x, y, r?.opts.filter) : null;
      this.renderer.setHover(hit ? hit.id : null);
      this.hoverId = hit ? hit.id : null;
    });
  }

  // Grips ---------------------------------------------------------------------

  refreshGrips() {
    this.grips = [];
    if (!this.doc) return;
    const sel = this.selection;
    if (!sel.size || sel.size > 200 || this.active) return;
    for (const id of sel) {
      const e = this.drawing.get(id);
      if (!e || !this.drawing.layerEditable(e.layer)) continue;
      const gs = gripsOf(e);
      for (let i = 0; i < gs.length; i++) this.grips.push({ ...gs[i], id, i });
    }
  }

  _startGripEdit(index, p) {
    const g = this.grips[index];
    if (!g) return;
    // Releasing after a mouse drag places the grip; a click (or a tap) waits for a second one.
    const drag = !!p && p.type !== 'touch';
    if (drag) p.gripDrag = true;
    this.run({ name: 'GRIPEDIT', label: 'Grip edit', noRepeat: true, run: (ed) => gripEdit(ed, g, drag) });
  }

  // View ----------------------------------------------------------------------

  viewChanged() {
    this.renderer.invalidate();
    this.ui.viewChanged?.();
    this._updateCursor(this.cursor.sx, this.cursor.sy);
  }

  zoomExtents() {
    const b = this.doc.index.extents((id) => this.drawing.layerVisible(this.drawing.get(id)?.layer));
    if (!b) {
      this.camera.fit(-10, -10, 290, 200);
    } else {
      const pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.02;
      this.fitView(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad, 24);
    }
    this.viewChanged();
  }

  /** Fit a box into the view, clear of the floating command line and navigation bar (ui.viewInsets). */
  fitView(x0, y0, x1, y1, margin) {
    const c = this.camera;
    c.fit(x0, y0, x1, y1, margin);
    const ins = this.ui.viewInsets?.();
    if (!ins) return;
    const s = Math.min((c.width - ins.left - ins.right - 2 * margin) / Math.max(x1 - x0, 1e-9), (c.height - ins.top - ins.bottom - 2 * margin) / Math.max(y1 - y0, 1e-9));
    if (s > 0 && s < c.scale) c.zoomAt(c.width / 2, c.height / 2, s / c.scale);
    c.cx = (x0 + x1) / 2 - (ins.left - ins.right) / (2 * c.scale);
    c.cy = (y0 + y1) / 2 + (ins.top - ins.bottom) / (2 * c.scale);
  }

  zoomBy(factor) {
    this.camera.zoomAt(this.camera.width / 2, this.camera.height / 2, factor);
    this.viewChanged();
  }

  // Overlay -------------------------------------------------------------------

  drawOverlay() {
    if (this._overlayRaf) return;
    this._overlayRaf = requestAnimationFrame(() => {
      this._overlayRaf = 0;
      this._paintOverlay();
    });
  }

  _paintOverlay() {
    if (!this.doc) return;
    const cam = this.camera;
    const c = this.cursor;
    const r = this.request;
    const st = this.settings;
    const wantsPoint = r && (r.kind === 'point' || r.kind === 'distance' || r.kind === 'angle');
    const fs = cam.toScreen(c.fx, c.fy);
    const touch = this.lastPointerType === 'touch';
    const state = {
      cursor: c.inside || touch ? (wantsPoint ? { sx: fs.x, sy: fs.y } : { sx: c.sx, sy: c.sy }) : null,
      cursorStyle: wantsPoint ? 'cross' : r && (r.kind === 'select' || r.kind === 'entity') ? 'pick' : 'both',
      crossSize: wantsPoint ? 40 : 18,
      pickbox: st.pickbox,
      snap: null,
      tracks: this.tracks,
      trackPoints: this.acquired.map((p) => {
        const s = cam.toScreen(p.x, p.y);
        return { sx: s.x, sy: s.y };
      }),
      window: this.window ? { ...this.window, crossing: this.window.x2 < this.window.x1 } : null,
      grips: [],
      gripSize: st.gripSize,
      rubber: [],
      readouts: [],
      ucs: st.showUcs === false ? null : { sx: 28, sy: cam.height - 28 },
    };
    if (this.snap) {
      const s = cam.toScreen(this.snap.x, this.snap.y);
      const label = this.snap.tracked ? 'Intersection' : SNAP_LABELS[this.snap.mode];
      state.snap = { sx: s.x, sy: s.y, mode: this.snap.mode, label };
    }
    if (!this.active && this.grips) {
      for (let i = 0; i < this.grips.length; i++) {
        const g = this.grips[i];
        const s = cam.toScreen(g.x, g.y);
        if (s.x < -10 || s.y < -10 || s.x > cam.width + 10 || s.y > cam.height + 10) continue;
        state.grips.push({ sx: s.x, sy: s.y, state: i === this.hoverGrip ? 'hover' : 'cold' });
      }
    }
    if (this.hotGrip) {
      const s = cam.toScreen(this.hotGrip.x, this.hotGrip.y);
      state.grips.push({ sx: s.x, sy: s.y, state: 'hot' });
    }
    if (wantsPoint && r.opts.base && r.opts.rubber !== false) {
      const b = cam.toScreen(r.opts.base.x, r.opts.base.y);
      state.rubber.push({ x1: b.x, y1: b.y, x2: fs.x, y2: fs.y });
      if (st.dyn && c.inside) {
        const d = Math.hypot(c.fx - r.opts.base.x, c.fy - r.opts.base.y);
        const a = Math.atan2(c.fy - r.opts.base.y, c.fx - r.opts.base.x);
        if (d * cam.scale > 20) {
          state.readouts.push({ sx: (b.x + fs.x) / 2, sy: (b.y + fs.y) / 2 - 14, text: formatLinear(d, this.header) });
          state.readouts.push({ sx: fs.x + 18, sy: fs.y - 18, text: formatAngle(norm(a), this.header), align: 'left' });
        }
      }
    }
    if (st.dyn && c.inside && r && !touch) {
      const lines = [];
      const typed = this.ui.input();
      lines.push(typed ? `${r.prompt}: ${typed}` : r.prompt);
      if (this.trackLabel && wantsPoint) lines.push(this.trackLabel);
      else if (wantsPoint && !r.opts.base) lines.push(`${formatLinear(c.fx, this.header)}, ${formatLinear(c.fy, this.header)}`);
      state.tooltip = { sx: fs.x + 22, sy: fs.y + 30, lines };
    } else if (st.dyn && c.inside && !r && this.ui.input() && !touch) {
      state.tooltip = { sx: c.sx + 22, sy: c.sy + 30, lines: [this.ui.input()] };
    }
    this.overlay.draw(state);
  }

  // Context menu ----------------------------------------------------------------

  _contextMenu(x, y) {
    const r = this.request;
    const items = [];
    if (r) {
      items.push({ label: 'Enter', shortcut: 'Enter', action: () => this.submit('') });
      items.push({ label: 'Cancel', shortcut: 'Esc', action: () => this.cancel() });
      if (r.options.length) {
        items.push({ separator: true });
        for (const o of r.options) items.push({ label: o.label, action: () => this._resolve({ option: o.value ?? o.key }) });
      }
      items.push({ separator: true });
      if (r.kind === 'point' || r.kind === 'distance' || r.kind === 'angle') {
        items.push({
          label: 'Snap overrides',
          icon: 'osnap',
          submenu: Object.entries(SNAP_LABELS).map(([mode, label]) => ({ label, icon: `snap-${mode}`, action: () => this.setSnapOverride(mode) })),
        });
      }
      items.push({ label: 'Zoom extents', icon: 'zoom-extents', action: () => this.zoomExtents() });
    } else {
      this.ui.contextMenu(x, y, null);
      return;
    }
    this.ui.contextMenu(x, y, items);
  }
}

/** Typed snap override keywords. */
const SNAP_KEYWORDS = { END: 'end', MID: 'mid', CEN: 'cen', GCE: 'gcen', NOD: 'node', QUA: 'quad', INT: 'int', EXT: 'ext', INS: 'ins', PER: 'per', TAN: 'tan', NEA: 'nea' };

const SNAP_LABELS = {
  end: 'Endpoint',
  mid: 'Midpoint',
  cen: 'Center',
  gcen: 'Geometric center',
  node: 'Node',
  quad: 'Quadrant',
  int: 'Intersection',
  ext: 'Extension',
  ins: 'Insertion',
  per: 'Perpendicular',
  tan: 'Tangent',
  nea: 'Nearest',
};

function norm(a) {
  return ((a % TAU) + TAU) % TAU;
}

function mid(pts) {
  return { sx: (pts[0].sx + pts[1].sx) / 2, sy: (pts[0].sy + pts[1].sy) / 2 };
}

function dist(pts) {
  return Math.hypot(pts[0].sx - pts[1].sx, pts[0].sy - pts[1].sy);
}

function lineInt(a, b) {
  const den = a.ux * b.uy - a.uy * b.ux;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((b.p.x - a.p.x) * b.uy - (b.p.y - a.p.y) * b.ux) / den;
  return { x: a.p.x + a.ux * t, y: a.p.y + a.uy * t };
}

/**
 * Grip editing: stretch the hot grip, or press Space/Enter to cycle through
 * move, rotate, scale and mirror for the whole selection.
 */
async function gripEdit(ed, grip, fromPointer) {
  const modes = ['stretch', 'move', 'rotate', 'scale', 'mirror'];
  let mode = 0;
  let base = { x: grip.x, y: grip.y };
  let copy = false;
  // Objects on layers locked since they were selected stay put.
  const ids = [...ed.selection].filter((id) => ed._editable(id));
  ed.hotGrip = grip;
  const options = [
    { key: 'B', label: 'Base point', value: 'base' },
    { key: 'C', label: 'Copy', value: 'copy' },
    { key: 'X', label: 'Exit', value: 'exit' },
  ];
  try {
    for (;;) {
      const m = modes[mode];
      const label = { stretch: 'Stretch to point', move: 'Move to point', rotate: 'Rotation angle', scale: 'Scale factor', mirror: 'Second point of mirror line' }[m];
      const matrixFor = (p) => gripMatrix(m, base, p);
      if (m === 'stretch') {
        const hot = coincidentGrips(ed, ids, grip);
        // The grip moves by base -> point (base is the grip unless Base point moved it).
        const stretched = (p) => {
          const x = grip.x + p.x - base.x,
            y = grip.y + p.y - base.y;
          return hot.map((h) => [h.id, h.idx.reduce((e, i) => applyGrip(e, i, x, y), h.ent)]);
        };
        ed.renderer.setHidden(new Set(hot.map((h) => h.id)));
        ed.renderer.setDragMatrix(null);
        const r = await ed.getPoint(`${label} (Space for next mode)`, {
          base,
          options,
          drag: fromPointer,
          preview: (p) => stretched(p).map(([, e]) => e),
        });
        fromPointer = false;
        if (r === null) {
          mode = (mode + 1) % modes.length;
          continue;
        }
        if (r.option === 'exit') return;
        if (r.option === 'base') {
          const b = await ed.getPoint('Base point');
          if (b && !b.option) base = b;
          continue;
        }
        if (r.option === 'copy') {
          copy = true;
          continue;
        }
        ed.commit('Stretch', () => {
          for (const [id, next] of stretched(r)) {
            if (copy) ed.drawing.add({ ...next, id: undefined });
            else ed.drawing.replace(id, next);
          }
        });
        if (!copy) return;
        continue;
      }
      ed.renderer.setHidden(new Set());
      const ask = { base, options, onMove: (p) => ed.renderer.setDragMatrix(matrixFor(p)) };
      const prompt = `${label} (Space for next mode)`;
      let r;
      if (m === 'rotate') {
        r = await ed.getAngle(prompt, ask);
        if (typeof r === 'number') r = { x: base.x + Math.cos(r), y: base.y + Math.sin(r) };
      } else if (m === 'scale') {
        r = await ed.getDistance(prompt, ask);
        if (typeof r === 'number' && !(r > 0)) {
          ed.ui.log('The scale factor must be greater than zero.', 'error');
          continue;
        }
        if (typeof r === 'number') r = { x: base.x + r, y: base.y };
      } else r = await ed.getPoint(prompt, ask);
      if (r === null) {
        mode = (mode + 1) % modes.length;
        continue;
      }
      if (r.option === 'exit') return;
      if (r.option === 'base') {
        const b = await ed.getPoint('Base point');
        if (b && !b.option) base = b;
        continue;
      }
      if (r.option === 'copy') {
        copy = true;
        continue;
      }
      const mtx = matrixFor(r);
      ed.commit(m[0].toUpperCase() + m.slice(1), () => {
        for (const id of ids) {
          const e = ed.drawing.get(id);
          if (!e) continue;
          const t = transformEntity(e, mtx);
          if (copy) ed.drawing.add({ ...t, id: undefined });
          else ed.drawing.replace(id, t);
        }
      });
      if (!copy) return;
    }
  } finally {
    ed.hotGrip = null;
    ed.renderer.setDragMatrix(null);
    ed.renderer.setHidden(new Set());
  }
}

/**
 * Grips of the selection that sit on the picked grip, so a shared corner
 * stretches every object meeting there. Returns [{ id, ent, idx: [grip indices] }].
 */
function coincidentGrips(ed, ids, grip) {
  const tol = 1e-9 * Math.max(1, Math.abs(grip.x), Math.abs(grip.y));
  const out = [{ id: grip.id, ent: ed.drawing.get(grip.id), idx: [grip.i] }];
  for (const id of ids) {
    const ent = ed.drawing.get(id);
    if (!ent || !ed.drawing.layerEditable(ent.layer)) continue;
    const idx = [];
    gripsOf(ent).forEach((g, i) => {
      if (id === grip.id && i === grip.i) return;
      if (Math.abs(g.x - grip.x) <= tol && Math.abs(g.y - grip.y) <= tol) idx.push(i);
    });
    if (!idx.length) continue;
    if (id === grip.id) out[0].idx.push(...idx);
    else out.push({ id, ent, idx });
  }
  return out;
}

function gripMatrix(mode, base, p) {
  const dx = p.x - base.x,
    dy = p.y - base.y;
  switch (mode) {
    case 'move':
      return [1, 0, 0, 1, dx, dy];
    case 'rotate': {
      const a = Math.atan2(dy, dx);
      const c = Math.cos(a),
        s = Math.sin(a);
      return [c, s, -s, c, base.x - c * base.x + s * base.y, base.y - s * base.x - c * base.y];
    }
    case 'scale': {
      const k = Math.max(1e-6, Math.hypot(dx, dy));
      return [k, 0, 0, k, base.x - k * base.x, base.y - k * base.y];
    }
    case 'mirror': {
      const l = Math.hypot(dx, dy);
      if (l < 1e-12) return [1, 0, 0, 1, 0, 0];
      const ux = dx / l,
        uy = dy / l;
      const a = 2 * ux * ux - 1,
        b = 2 * ux * uy,
        d = 2 * uy * uy - 1;
      return [a, b, b, d, base.x - a * base.x - b * base.y, base.y - b * base.x - d * base.y];
    }
  }
  return [1, 0, 0, 1, 0, 0];
}

export { gripMatrix };
