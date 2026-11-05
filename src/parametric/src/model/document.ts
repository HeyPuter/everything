// The open part document: change transactions, undo/redo, and evaluation of
// parameters (expressions and global variables) into plain numbers for the
// geometry worker.

import { convertExpressionUnits, evaluate, evaluateVariables } from './expr';
import { PARAM_FIELDS, type ParamKind, getPath, setPath } from './features';
import type { Feature, Id, Param, PartDocument, SkDimension, SketchFeature, UnitSystem } from './types';
import { isDimension } from './types';
import { UNIT_SYSTEMS } from './units';
import { solveSketch } from '../sketch/solver';

export const FORMAT = 'parametric-part';

export function newDocument(name = 'Part1', units: UnitSystem = 'MMGS'): PartDocument {
  const now = Date.now();
  return {
    format: FORMAT,
    version: 1,
    name,
    units,
    decimals: units === 'IPS' ? 3 : 2,
    material: null,
    color: '#b8c4d2',
    variables: [],
    features: [],
    rollback: null,
    blobs: {},
    nextId: 1,
    created: now,
    modified: now,
  };
}

/** Validates and normalises a parsed document (throws a readable error). */
export function parseDocument(text: string): PartDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('This file is not a valid part file.');
  }
  const d = raw as Partial<PartDocument>;
  if (!d || d.format !== FORMAT) throw new Error('This file is not a part created with Parametric.');
  if (typeof d.version === 'number' && d.version > 1) throw new Error('This part was created with a newer version of Parametric.');
  if (d.version !== 1) throw new Error('The part file is damaged (unknown version).');
  if (!Array.isArray(d.features)) throw new Error('The part file is damaged (no feature list).');
  if (!d.features.every((f) => f && typeof f === 'object' && typeof f.id === 'string' && typeof f.type === 'string')) {
    throw new Error('The part file is damaged (invalid feature).');
  }
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  // A sketch without its plane or geometry lists breaks drawing and solving.
  if (!d.features.every((f) => f.type !== 'sketch' || (isObj(f.plane) && typeof f.plane.kind === 'string' && Array.isArray(f.entities) && Array.isArray(f.constraints)))) {
    throw new Error('The part file is damaged (invalid sketch).');
  }
  const units = typeof d.units === 'string' && Object.hasOwn(UNIT_SYSTEMS, d.units) ? d.units : 'MMGS';
  const base = newDocument(typeof d.name === 'string' ? d.name : undefined, units);
  // Global variables that are not variables are dropped rather than breaking every rebuild.
  const variables = (Array.isArray(d.variables) ? d.variables : [])
    .filter((v) => isObj(v) && typeof v.name === 'string')
    .map((v) => ({ ...v, id: typeof v.id === 'string' ? v.id : '', expr: typeof v.expr === 'string' ? v.expr : String(v.expr ?? '') }));
  const blobs = isObj(d.blobs) ? d.blobs : {};
  const doc = { ...base, ...d, units, blobs, variables } as PartDocument;
  if (typeof doc.name !== 'string') doc.name = base.name;
  if (!Number.isInteger(doc.decimals) || doc.decimals < 0 || doc.decimals > 8) doc.decimals = base.decimals;
  if (doc.rollback != null && !Number.isInteger(doc.rollback)) doc.rollback = null;
  if (typeof doc.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(doc.color)) doc.color = base.color;
  if (doc.material != null && !(isObj(doc.material) && typeof doc.material.name === 'string' && Number.isFinite(doc.material.density))) doc.material = null;
  if (doc.drawing != null && !(isObj(doc.drawing) && Array.isArray(doc.drawing.views))) doc.drawing = null;
  for (const f of doc.features) if (typeof f.name !== 'string' || !f.name) f.name = f.id;
  // New feature ids must not collide with existing ones, even when the file's
  // counter is missing or stale.
  let maxId = 0;
  for (const f of [...doc.features, ...doc.variables]) {
    const m = /^[a-z]+(\d+)$/i.exec(String(f?.id ?? ''));
    if (m) maxId = Math.max(maxId, Number(m[1]));
  }
  doc.nextId = Math.max(Number.isInteger(doc.nextId) ? doc.nextId : 1, maxId + 1);
  for (const v of doc.variables) if (!v.id) v.id = `v${doc.nextId++}`;
  return doc;
}

/**
 * Calls fn with every expression in the document (global variables, feature
 * values and sketch dimensions) and stores what it returns in its place.
 */
export function mapExpressions(doc: PartDocument, fn: (src: string, kind: ParamKind | 'variable') => string) {
  for (const v of doc.variables) v.expr = fn(v.expr, 'variable');
  for (const f of doc.features) {
    for (const fd of PARAM_FIELDS[f.type] ?? []) {
      const v = getPath(f, fd.path);
      if (typeof v === 'string') setPath(f, fd.path, fn(v, fd.kind));
    }
    if (f.type === 'sketch') for (const c of f.constraints) if (isDimension(c) && typeof c.value === 'string') c.value = fn(c.value, c.type === 'angle' ? 'angle' : 'length');
  }
}

/**
 * Switches the document's units. Numbers are stored in millimetres and keep
 * their size; expressions are written in display units, so the plain numbers
 * in them that stand for lengths are converted too. A value whose expression
 * cannot be converted keeps its size as a plain number. Returns the names of
 * the values that were unlinked that way.
 */
export function changeUnits(doc: PartDocument, units: UnitSystem): string[] {
  if (doc.units === units || !Object.hasOwn(UNIT_SYSTEMS, units)) return [];
  const k = UNIT_SYSTEMS[doc.units].scale / UNIT_SYSTEMS[units].scale;
  const values = (d: PartDocument) => {
    const st = new DocStore(d);
    const vars = st.resolve().variables;
    const out = new Map<string, number>();
    for (const f of d.features) {
      for (const fd of PARAM_FIELDS[f.type] ?? []) {
        const v = getPath(f, fd.path);
        if (typeof v === 'string') try { out.set(`${f.id}|${fd.path}`, st.evalParam(v, fd.kind, vars)); } catch { /* already an error */ }
      }
      if (f.type === 'sketch') for (const c of f.constraints) if (isDimension(c) && typeof c.value === 'string') try { out.set(`${f.id}|${c.id}`, st.dimensionValue(c, vars)); } catch { /* already an error */ }
    }
    return out;
  };
  const before = values(doc);
  const items: { src: string; dim: number | 'variable'; name?: string }[] = [];
  let vi = 0;
  mapExpressions(doc, (src, kind) => {
    items.push({ src, dim: kind === 'variable' ? 'variable' : kind === 'length' ? 1 : 0, name: kind === 'variable' ? doc.variables[vi++].name : undefined });
    return src;
  });
  const converted = convertExpressionUnits(items, k);
  let i = 0;
  mapExpressions(doc, (src) => converted[i++] ?? src);
  doc.units = units;
  // Whatever did not keep its value becomes the plain number it was.
  const after = values(doc);
  const unlinked: string[] = [];
  const same = (a: number, b: number | undefined) => b !== undefined && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  for (const f of doc.features) {
    for (const fd of PARAM_FIELDS[f.type] ?? []) {
      const was = before.get(`${f.id}|${fd.path}`);
      if (was !== undefined && !same(was, after.get(`${f.id}|${fd.path}`))) { setPath(f, fd.path, was); unlinked.push(`${f.name} ${fd.label}`); }
    }
    if (f.type === 'sketch') for (const c of f.constraints) {
      const was = before.get(`${f.id}|${c.id}`);
      if (isDimension(c) && was !== undefined && !same(was, after.get(`${f.id}|${c.id}`))) { c.value = was; unlinked.push(`${c.name}@${f.name}`); }
    }
  }
  return unlinked;
}

/**
 * The document as file text. Imported file data no feature uses any more (the
 * import was deleted) stays in memory for undo but is left out of the file.
 */
export function serializeDocument(doc: PartDocument): string {
  return JSON.stringify(withUsedBlobs(doc));
}

export function withUsedBlobs(doc: PartDocument): PartDocument {
  const used = new Set(doc.features.map((f) => (f.type === 'import' ? f.blob : null)));
  const keys = Object.keys(doc.blobs ?? {});
  if (keys.every((k) => used.has(k))) return doc;
  return { ...doc, blobs: Object.fromEntries(keys.filter((k) => used.has(k)).map((k) => [k, doc.blobs[k]])) };
}

export interface ResolveResult {
  features: Feature[];
  errors: Map<Id, string>;
  variables: Map<string, number>;
  variableErrors: Map<string, string>;
}

type Listener = (reason: string) => void;

const MAX_UNDO = 120;

export class DocStore {
  doc: PartDocument;
  dirty = false;
  private undoStack: { snap: string; label: string }[] = [];
  private redoStack: { snap: string; label: string }[] = [];
  private listeners = new Set<Listener>();
  private batchDepth = 0;
  private batchSnap: string | null = null;
  private batchLabel = '';
  /** Old steps dropped from the bottom of the undo stack. */
  private dropped = 0;

  constructor(doc: PartDocument = newDocument()) {
    this.doc = doc;
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(reason: string) {
    for (const fn of this.listeners) fn(reason);
  }

  /** Replaces the whole document (open/new); clears history. */
  load(doc: PartDocument) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.dropped = 0;
    this.dirty = false;
    this.emit('load');
  }

  private snapshot(): string {
    const { blobs: _blobs, ...rest } = this.doc;
    void _blobs;
    return JSON.stringify(rest);
  }

  private restore(snap: string) {
    const blobs = this.doc.blobs;
    this.doc = { ...(JSON.parse(snap) as PartDocument), blobs };
  }

  /** Applies a change as one undoable step. */
  change(label: string, fn: (doc: PartDocument) => void, reason = 'change') {
    if (this.batchDepth > 0) {
      fn(this.doc);
      this.doc.modified = Date.now();
      this.dirty = true;
      this.emit(reason);
      return;
    }
    const before = this.snapshot();
    fn(this.doc);
    const after = this.snapshot();
    if (after === before) return;
    this.doc.modified = Date.now();
    this.undoStack.push({ snap: before, label });
    if (this.undoStack.length > MAX_UNDO) { this.undoStack.shift(); this.dropped++; }
    this.redoStack = [];
    this.dirty = true;
    this.emit(reason);
  }

  /** Groups several changes (e.g. a drag) into one undo step. */
  beginBatch(label: string) {
    if (this.batchDepth++ === 0) {
      this.batchSnap = this.snapshot();
      this.batchLabel = label;
    }
  }

  endBatch() {
    if (this.batchDepth === 0) return;
    if (--this.batchDepth === 0 && this.batchSnap) {
      if (this.snapshot() !== this.batchSnap) {
        this.undoStack.push({ snap: this.batchSnap, label: this.batchLabel });
        if (this.undoStack.length > MAX_UNDO) { this.undoStack.shift(); this.dropped++; }
        this.redoStack = [];
      }
      this.batchSnap = null;
    }
  }

  /** Drops a batch, restoring the state from before it started. */
  cancelBatch() {
    if (this.batchDepth === 0) return;
    this.batchDepth = 0;
    if (this.batchSnap) this.restore(this.batchSnap);
    this.batchSnap = null;
    this.emit('change');
  }

  get canUndo() { return this.undoStack.length > 0; }
  get undoDepth() { return this.undoStack.length; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack[this.undoStack.length - 1]?.label ?? ''; }
  get redoLabel() { return this.redoStack[this.redoStack.length - 1]?.label ?? ''; }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push({ snap: this.snapshot(), label: s.label });
    this.restore(s.snap);
    this.dirty = true;
    this.emit('undo');
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push({ snap: this.snapshot(), label: s.label });
    this.restore(s.snap);
    this.dirty = true;
    this.emit('redo');
  }

  /**
   * Position in the undo history that stays valid while steps are added
   * (unlike undoDepth, which stops growing once old steps are dropped).
   */
  get undoMark(): number {
    return this.dropped + this.undoStack.length;
  }

  /**
   * Restores the document as it was at an undo mark, dropping the steps made
   * since (they cannot be redone).
   */
  revertTo(mark: number) {
    const i = mark - this.dropped;
    if (this.batchDepth > 0 || i < 0 || i >= this.undoStack.length) return;
    const snap = this.undoStack[i].snap;
    this.undoStack.length = i;
    this.restore(snap);
    this.dirty = true;
    this.emit('undo');
  }

  /** Merges the undo steps made since an undo mark into one step with this label. */
  squash(mark: number, label: string) {
    const i = Math.max(0, mark - this.dropped);
    if (i >= this.undoStack.length) return;
    const first = this.undoStack[i];
    this.undoStack.length = i;
    this.undoStack.push({ snap: first.snap, label });
  }

  nextId(prefix = 'f'): Id {
    return `${prefix}${this.doc.nextId++}`;
  }

  feature<T extends Feature = Feature>(id: Id): T | undefined {
    return this.doc.features.find((f) => f.id === id) as T | undefined;
  }

  indexOf(id: Id): number {
    return this.doc.features.findIndex((f) => f.id === id);
  }

  /** Number of features that are built (the rollback position). */
  get builtCount(): number {
    const r = this.doc.rollback;
    return r == null ? this.doc.features.length : Math.max(0, Math.min(r, this.doc.features.length));
  }

  get unitScale(): number {
    return UNIT_SYSTEMS[this.doc.units].scale;
  }

  /** Evaluates one parameter. */
  evalParam(p: Param, kind: 'length' | 'angle' | 'count', vars?: Map<string, number>): number {
    if (typeof p === 'number') return p;
    const values = vars ?? evaluateVariables(this.doc.variables).values;
    const src = String(p).replace(/^=/, '');
    const v = evaluate(src, {
      kind: kind === 'count' ? 'none' : kind,
      bareScale: kind === 'length' ? this.unitScale : 1,
      lookup: (n) => values.get(n),
    });
    return kind === 'count' ? Math.round(v) : v;
  }

  dimensionValue(d: SkDimension, vars?: Map<string, number>): number {
    return this.evalParam(d.value, d.type === 'angle' ? 'angle' : 'length', vars);
  }

  /** Features with every parameter evaluated; sketches with expressions re-solved. */
  resolve(): ResolveResult {
    const { values, errors: variableErrors } = evaluateVariables(this.doc.variables);
    const errors = new Map<Id, string>();
    const features = this.doc.features.map((f) => {
      const fields = PARAM_FIELDS[f.type];
      let out: Feature = f;
      if (fields) {
        for (const fd of fields) {
          const v = getPath(f, fd.path);
          if (typeof v !== 'string') continue;
          if (out === f) out = structuredClone(f);
          try {
            setPath(out, fd.path, this.evalParam(v, fd.kind, values));
          } catch (e) {
            errors.set(f.id, `${fd.label}: ${(e as Error).message}`);
            setPath(out, fd.path, 0);
          }
        }
      }
      if (f.type === 'sketch' && f.constraints.some((c) => isDimension(c) && typeof c.value === 'string')) {
        const sk = structuredClone(f) as SketchFeature;
        try {
          solveSketch(sk.entities, sk.constraints, { value: (d) => this.dimensionValue(d, values), analyze: false });
        } catch (e) {
          errors.set(f.id, (e as Error).message);
        }
        out = sk;
      }
      return out;
    });
    return { features, errors, variables: values, variableErrors };
  }
}
