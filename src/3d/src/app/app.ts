// Application runtime: document, undo, operators, modal handlers, notifications.
import type { DocumentData, ObjectData, Mode, ID } from '../data/types';
import { startupDocument } from '../data/defaults';
import { Depsgraph } from '../eval/depsgraph';
import { UndoStack } from './undo';
import { prefs } from './prefs';
import { modeHandlers } from '../ops/modes';

export type OpResult = 'FINISHED' | 'CANCELLED' | 'RUNNING_MODAL' | 'PASS_THROUGH' | void;

export interface PropDef {
  id: string;
  label?: string;
  type: 'float' | 'int' | 'bool' | 'enum' | 'vec3' | 'vec2' | 'string' | 'color' | 'bools';
  default: unknown;
  min?: number;
  max?: number;
  softMin?: number;
  softMax?: number;
  step?: number;
  precision?: number;
  subtype?: 'distance' | 'angle' | 'factor' | 'percentage' | 'pixel' | 'time' | 'none' | 'xyz';
  items?: [string, string, string?][];
  hidden?: boolean;
  /** Only show when predicate holds for current props */
  showIf?: (p: Record<string, unknown>) => boolean;
}

export interface OpContext {
  app: App;
  doc: DocumentData;
  area: AreaLike | null;
  event?: PointerInfo;
}

export interface PointerInfo {
  x: number; // client coords
  y: number;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
}

export interface AreaLike {
  id: string;
  type: string;
  el: HTMLElement;
  editor: unknown;
}

export interface Operator {
  idname: string;
  label: string;
  description?: string;
  icon?: string;
  props?: PropDef[];
  poll?: (ctx: OpContext) => boolean;
  exec?: (ctx: OpContext, props: Record<string, unknown>) => OpResult;
  invoke?: (ctx: OpContext, props: Record<string, unknown>) => OpResult;
  /** push an undo step after finishing (default true) */
  undo?: boolean;
  /** show in the Adjust Last Operation panel (requires exec) */
  redo?: boolean;
  /** hidden from F3 search */
  internal?: boolean;
}

export interface ModalHandler {
  /** Name shown in the undo history and redo panel */
  label: string;
  onPointerMove?(e: PointerEvent): void;
  onPointerDown?(e: PointerEvent): 'FINISHED' | 'CANCELLED' | void;
  onPointerUp?(e: PointerEvent): 'FINISHED' | 'CANCELLED' | void;
  onWheel?(e: WheelEvent): void;
  onKey?(e: KeyboardEvent): 'FINISHED' | 'CANCELLED' | void | boolean;
  /** Called to undo whatever the modal did so far */
  cancel(): void;
  finish?(): void;
  /** Text shown in the area header / status bar while running */
  header?(): string;
  status?(): [string, string][];
  cursor?: string;
  /** Re-run with new props after finishing (redo panel) */
  redoOp?: { idname: string; props: Record<string, unknown> };
}

export type ChangeKind = 'doc' | 'select' | 'frame' | 'ui' | 'mode' | 'view' | 'geometry';

export interface Report {
  type: 'INFO' | 'WARNING' | 'ERROR' | 'OPERATOR';
  message: string;
  time: number;
}

export const operators = new Map<string, Operator>();
export function registerOperator(op: Operator) {
  operators.set(op.idname, op);
}
export function registerOperators(ops: Operator[]) {
  ops.forEach(registerOperator);
}

/** Notified after an operator finishes (also modal ones), e.g. for the Info editor's operator log. */
export const operatorListeners = new Set<(idname: string, props: Record<string, unknown>) => void>();
function notifyOperator(idname: string, props: Record<string, unknown>) {
  for (const fn of operatorListeners) {
    try {
      fn(idname, props);
    } catch {
      // listeners must never break operator execution
    }
  }
}

export function defaultProps(op: Operator): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const d of op.props ?? []) p[d.id] = structuredClone(d.default);
  return p;
}

export class App {
  doc: DocumentData;
  graph: Depsgraph;
  undo = new UndoStack();
  modal: ModalHandler | null = null;
  reports: Report[] = [];
  lastOp: { idname: string; props: Record<string, unknown>; label: string } | null = null;
  /** Area currently under the pointer */
  hoverArea: AreaLike | null = null;
  activeArea: AreaLike | null = null;
  pointer = { x: 0, y: 0 };
  playing: false | 'forward' | 'reverse' = false;
  dirty = false;
  filename = 'untitled.p3d';
  private listeners = new Set<(kinds: Set<ChangeKind>) => void>();
  private pending = new Set<ChangeKind>();
  private scheduled = false;
  revision = 0;

  constructor(doc: DocumentData = startupDocument()) {
    this.doc = doc;
    this.graph = new Depsgraph(doc);
    this.graph.evaluate(doc);
    this.undo.reset(doc);
  }

  // ---------------------------------------------------------------------
  // notifications

  subscribe(fn: (kinds: Set<ChangeKind>) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed(...kinds: ChangeKind[]) {
    for (const k of kinds.length ? kinds : (['doc'] as ChangeKind[])) this.pending.add(k);
    if (kinds.includes('doc') || kinds.includes('geometry') || kinds.includes('frame') || kinds.includes('select') || kinds.includes('mode')) this.revision++;
    if (kinds.includes('doc') || kinds.includes('geometry')) this.dirty = true;
    if (!this.scheduled) {
      this.scheduled = true;
      requestAnimationFrame(() => this.flush());
    }
  }

  /** Whether changes are waiting to be evaluated (the next animation frame flushes them). */
  get hasPending() {
    return this.scheduled;
  }

  /** Synchronously evaluate and notify (used by tests and modal operators). */
  /** Apply scheduled changes right away (so a shortcut acts on the current frame's state). */
  flushPending() {
    if (this.pending.size) this.flush();
  }

  flush() {
    this.scheduled = false;
    const kinds = new Set(this.pending);
    this.pending.clear();
    if (kinds.has('doc') || kinds.has('frame') || kinds.has('geometry') || kinds.has('mode') || kinds.has('select')) this.evaluate();
    for (const fn of this.listeners) fn(kinds);
  }

  evaluate() {
    this.graph.editObjects.clear();
    if (this.doc.mode === 'EDIT') for (const ob of this.editObjects()) this.graph.editObjects.add(ob.id);
    this.graph.evaluate(this.doc);
  }

  // ---------------------------------------------------------------------
  // reports

  report(type: Report['type'], message: string) {
    this.reports.push({ type, message, time: Date.now() });
    if (this.reports.length > 500) this.reports.splice(0, this.reports.length - 500);
    this.changed('ui');
  }

  // ---------------------------------------------------------------------
  // context helpers

  get scene() {
    return this.doc.scene;
  }

  /**
   * Object that stands in for the active object while a pinned Properties editor draws or handles
   * an event (set and cleared by that editor), so its buttons and operators act on the pinned object.
   */
  contextObject: ObjectData | null = null;

  get activeObject(): ObjectData | null {
    const c = this.contextObject;
    if (c && this.doc.objects[c.id] === c) return c;
    const id = this.doc.scene.active_object;
    return id ? this.doc.objects[id] ?? null : null;
  }

  set activeObject(ob: ObjectData | null) {
    this.doc.scene.active_object = ob ? ob.id : null;
  }

  get mode(): Mode {
    return this.doc.mode;
  }

  /** Visible & selected objects in stable order. */
  selectedObjects(): ObjectData[] {
    return this.doc.object_order.map((id) => this.doc.objects[id]).filter((o) => o && o.select && this.isVisible(o.id));
  }

  /** Objects in edit mode (active + selected of the same type). */
  editObjects(): ObjectData[] {
    const act = this.activeObject;
    if (!act || this.doc.mode !== 'EDIT') return [];
    const others = this.selectedObjects().filter((o) => o.type === act.type && o.id !== act.id);
    return [act, ...others];
  }

  isVisible(id: ID) {
    const ev = this.graph.get(id);
    return ev ? ev.visible : false;
  }

  isSelectable(id: ID) {
    const ev = this.graph.get(id);
    return ev ? ev.selectable : false;
  }

  context(area: AreaLike | null = this.hoverArea ?? this.activeArea, event?: PointerInfo): OpContext {
    return { app: this, doc: this.doc, area, event };
  }

  // ---------------------------------------------------------------------
  // operators

  poll(idname: string, area: AreaLike | null = this.hoverArea ?? this.activeArea) {
    const op = operators.get(idname);
    if (!op) return false;
    try {
      return !op.poll || op.poll(this.context(area));
    } catch {
      return false;
    }
  }

  /**
   * Run an operator. `invoke` (default) lets operators start interactive
   * modal handlers; `exec` runs non-interactively with the given props.
   */
  run(idname: string, props: Record<string, unknown> = {}, opts: { invoke?: boolean; area?: AreaLike | null; event?: PointerInfo } = {}): OpResult {
    const op = operators.get(idname);
    if (!op) {
      this.report('ERROR', `Unknown operator: ${idname}`);
      return 'CANCELLED';
    }
    if (this.modal) return 'CANCELLED';
    const ctx = this.context(opts.area === undefined ? this.hoverArea ?? this.activeArea : opts.area, opts.event ?? { ...this.pointer });
    if (op.poll && !op.poll(ctx)) return 'CANCELLED';
    const full = { ...defaultProps(op), ...props };
    let result: OpResult;
    try {
      result = opts.invoke !== false && op.invoke ? op.invoke(ctx, full) : op.exec ? op.exec(ctx, full) : 'CANCELLED';
    } catch (e) {
      this.report('ERROR', `${op.label}: ${e instanceof Error ? e.message : String(e)}`);
      // restore last good state
      const cur = this.undo.current();
      if (cur && op.undo !== false) this.setDocument(cur, false);
      return 'CANCELLED';
    }
    if (result === 'RUNNING_MODAL') return result;
    if (result === 'FINISHED' || result === undefined) {
      if (op.undo !== false) this.pushUndo(op.label);
      if (op.undo !== false) this.lastOp = op.redo !== false && op.exec && op.props?.some((p) => !p.hidden) ? { idname, props: full, label: op.label } : null;
      this.changed('doc');
      notifyOperator(idname, full);
      return 'FINISHED';
    }
    return result;
  }

  /** Re-run the last operator with new properties (Adjust Last Operation / F9). */
  redoLast(props: Record<string, unknown>) {
    const last = this.lastOp;
    if (!last) return;
    const op = operators.get(last.idname);
    const prev = this.undo.previous();
    if (!op?.exec || !prev) return;
    const area = this.hoverArea ?? this.activeArea;
    this.setDocument(prev, false);
    const merged = { ...last.props, ...props };
    try {
      op.exec(this.context(area), merged);
      this.undo.replaceTop(this.doc, op.label);
      this.lastOp = { ...last, props: merged };
    } catch (e) {
      this.report('ERROR', e instanceof Error ? e.message : String(e));
      const cur = this.undo.current();
      if (cur) this.setDocument(cur, false);
    }
    this.changed('doc');
  }

  startModal(handler: ModalHandler) {
    this.modal = handler;
    this.changed('ui');
  }

  endModal(result: 'FINISHED' | 'CANCELLED') {
    const m = this.modal;
    if (!m) return;
    this.modal = null;
    if (result === 'CANCELLED') m.cancel();
    else {
      m.finish?.();
      this.pushUndo(m.label);
      this.lastOp = m.redoOp ? { idname: m.redoOp.idname, props: m.redoOp.props, label: m.label } : null;
      if (m.redoOp) notifyOperator(m.redoOp.idname, m.redoOp.props);
    }
    this.changed('doc');
  }

  pushUndo(label: string) {
    this.undo.push(this.doc, label);
    this.dirty = true;
  }

  /** Restore an undo state; crossing a mode change runs the modes' exit/enter handlers. */
  private restoreUndo(d: DocumentData) {
    const from = this.doc.mode;
    if (d.mode !== from) modeHandlers[from]?.exit?.();
    this.setDocument(d, false);
    if (d.mode !== from && d.mode !== 'OBJECT') {
      const ob = this.activeObject;
      if (ob) modeHandlers[d.mode]?.enter?.(ob);
    }
  }

  /** Go back to an undo mark (`undo.mark()`), dropping the steps after it, e.g. a failed script's partial changes. */
  revertUndo(mark: object | null): boolean {
    if (this.modal) return false;
    const d = this.undo.revertTo(mark);
    if (!d) return false;
    this.restoreUndo(d);
    this.lastOp = null;
    return true;
  }

  undoStep() {
    if (this.modal) return;
    const d = this.undo.undo();
    if (d) {
      this.restoreUndo(d);
      this.lastOp = null;
      this.report('INFO', `Undo`);
    }
  }

  redoStep() {
    if (this.modal) return;
    const d = this.undo.redo();
    if (d) {
      this.restoreUndo(d);
      this.lastOp = null;
    }
  }

  setDocument(doc: DocumentData, resetUndo = true) {
    this.doc = doc;
    this.graph.doc = doc;
    if (resetUndo) {
      this.undo.reset(doc);
      this.lastOp = null;
      this.graph.invalidate();
    }
    this.changed('doc', 'mode', 'select');
  }

  // ---------------------------------------------------------------------
  // frame / playback

  setFrame(frame: number, subframe = 0) {
    const s = this.doc.scene;
    // Preferences ▸ Animation ▸ Allow Negative Frames
    if (!prefs.use_negative_frames && frame < 0) (frame = 0), (subframe = 0);
    s.frame_current = Math.round(frame);
    s.frame_subframe = subframe;
    this.changed('frame');
  }
}

export let app: App;
const readyCallbacks: ((a: App) => void)[] = [];
export function setApp(a: App) {
  app = a;
  for (const fn of readyCallbacks.splice(0)) fn(a);
}

/** Run once the application instance exists (feature modules are imported before it is created). */
export function onAppReady(fn: (a: App) => void) {
  if (app) fn(app);
  else readyCallbacks.push(fn);
}
