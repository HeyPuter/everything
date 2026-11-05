// PropertyManager panels for creating and editing features.

import type { Vec3 } from '../math/vec';
import { dot, sub, toLocal } from '../math/vec';
import {
  defaultName, newChamfer, newCircularPattern, newDraft, newExtrude, newFillet, newHole, newLinearPattern, newLoft,
  newMirror, newPlane, newRevolve, newShell, newSketch, newSweep, FEATURE_LABELS, featureIcon,
} from '../model/features';
import { BASE_PLANE_NAMES } from '../model/planes';
import type {
  AxisRef, ChamferFeature, CircularPatternFeature, DraftFeature, EdgeRef, ExtrudeFeature, FaceRef, Feature, FilletFeature,
  HoleFeature, Id, LinearPatternFeature, LoftFeature, MirrorFeature, PatternDir, PlaneFeature, PlaneRef, RevolveFeature,
  ShellFeature, SketchFeature, SweepFeature,
} from '../model/types';
import { h } from '../ui/dom';
import type { App } from './app';
import {
  PropertyPanel, SelectionBox, type SelBoxItem, checkbox, flipButton, numberField, section, selectField,
} from './pm';
import { type SelItem, edgeRef, faceRef } from './selection';

// ---------- conversions from picks ----------

function faceLabel(app: App, i: number): string {
  const f = app.faces[i];
  const owner = f ? app.store.feature(f.feature) : null;
  return `Face <${i + 1}>${owner ? ` of ${owner.name}` : ''}`;
}

export const toFace = (app: App, planarOnly = false) => (it: SelItem): SelBoxItem | null => {
  if (it.kind !== 'face') return null;
  const f = app.faces[it.index];
  if (!f || (planarOnly && f.type !== 'plane')) return null;
  return { item: it, data: faceRef(f), label: faceLabel(app, it.index) };
};

export const toEdge = (app: App) => (it: SelItem): SelBoxItem | null => {
  if (it.kind !== 'edge') return null;
  const e = app.edges[it.index];
  if (!e) return null;
  return { item: it, data: edgeRef(e), label: `Edge <${it.index + 1}> (${e.type})` };
};

export const toEdgeOrFace = (app: App) => (it: SelItem): SelBoxItem | null => toEdge(app)(it) ?? toFace(app)(it);

export const toPlane = (app: App) => (it: SelItem): SelBoxItem | null => {
  if (it.kind === 'plane') {
    const label = it.ref.kind === 'base' ? BASE_PLANE_NAMES[it.ref.plane] : app.store.feature(it.ref.id)?.name ?? 'Plane';
    return { item: it, data: it.ref as PlaneRef, label };
  }
  if (it.kind === 'feature') {
    const f = app.store.feature(it.id);
    if (f?.type === 'plane') return { item: { kind: 'plane', ref: { kind: 'feature', id: f.id } }, data: { kind: 'feature', id: f.id } as PlaneRef, label: f.name };
  }
  if (it.kind === 'face') {
    const f = app.faces[it.index];
    if (f?.type !== 'plane') return null;
    return { item: it, data: { kind: 'face', face: faceRef(f) } as PlaneRef, label: faceLabel(app, it.index) };
  }
  return null;
};

export const toAxis = (app: App) => (it: SelItem): SelBoxItem | null => {
  if (it.kind === 'edge') {
    const e = app.edges[it.index];
    if (!e || (e.type !== 'line' && e.type !== 'circle')) return null;
    return { item: it, data: { kind: 'edge', edge: edgeRef(e) } as AxisRef, label: `Edge <${it.index + 1}> (${e.type})` };
  }
  if (it.kind === 'face') {
    const f = app.faces[it.index];
    if (!f || (f.type !== 'cylinder' && f.type !== 'plane')) return null;
    return { item: it, data: { kind: 'face', face: faceRef(f) } as AxisRef, label: faceLabel(app, it.index) };
  }
  if (it.kind === 'plane' && it.ref.kind === 'base') {
    const axis = it.ref.plane === 'front' ? 'z' : it.ref.plane === 'top' ? 'y' : 'x';
    return { item: it, data: { kind: 'base', axis } as AxisRef, label: `${BASE_PLANE_NAMES[it.ref.plane]} normal` };
  }
  return null;
};

export const toFeature = (app: App, filter?: (f: Feature) => boolean) => (it: SelItem): SelBoxItem | null => {
  let id: Id | null = null;
  if (it.kind === 'feature') id = it.id;
  else if (it.kind === 'face') id = app.faces[it.index]?.feature ?? null;
  const f = id ? app.store.feature(id) : null;
  if (!f || (filter && !filter(f))) return null;
  return { item: { kind: 'feature', id: f.id }, data: f.id, label: f.name };
};

const isSketch = (f: Feature) => f.type === 'sketch';
const isSeed = (f: Feature) => ['extrude', 'revolve', 'hole', 'loft', 'sweep', 'linearPattern', 'circularPattern', 'mirror'].includes(f.type);

function planeLabel(app: App, ref: PlaneRef | null): string {
  if (!ref) return '';
  if (ref.kind === 'base') return BASE_PLANE_NAMES[ref.plane];
  if (ref.kind === 'feature') return app.store.feature(ref.id)?.name ?? 'Plane';
  return `Face of ${app.store.feature(app.faces.find((f) => f.name === ref.face.name)?.feature ?? '')?.name ?? 'part'}`;
}

function axisLabel(app: App, ref: AxisRef | null): string {
  if (!ref) return '';
  switch (ref.kind) {
    case 'base': return `${ref.axis.toUpperCase()} axis`;
    case 'edge': return `Edge (${ref.edge.sig.type})`;
    case 'face': return `Face of ${app.store.feature(app.faces.find((f) => f.name === ref.face.name)?.feature ?? '')?.name ?? 'part'}`;
    case 'sketchLine': return `${app.store.feature(ref.sketch)?.name ?? 'Sketch'} line`;
  }
}

/** Index of a face/edge reference in the current model, for highlighting. */
function faceItem(app: App, r: FaceRef): SelItem | null {
  const i = app.faces.findIndex((f) => f.name === r.name);
  return i >= 0 ? { kind: 'face', index: i, name: r.name } : null;
}

function edgeItem(app: App, r: EdgeRef): SelItem | null {
  const i = app.edges.findIndex((e) => e.name === r.name);
  return i >= 0 ? { kind: 'edge', index: i, name: r.name } : null;
}

// ---------- base ----------

abstract class FeaturePanel<T extends Feature> extends PropertyPanel {
  f: T;
  constructor(protected app: App, f: T, editing: boolean) {
    super();
    this.f = structuredClone(f);
    this.editingId = editing ? f.id : null;
    this.icon = featureIcon(f);
  }

  get title() {
    return this.editingId ? this.f.name : FEATURE_LABELS[this.f.type];
  }

  /** The feature as the panel first showed it, to tell whether it was changed. */
  private initial: string | null = null;

  mount(): HTMLElement {
    const el = super.mount();
    this.initial ??= JSON.stringify(this.f);
    return el;
  }

  get edited(): boolean {
    return this.initial !== null && JSON.stringify(this.f) !== this.initial;
  }

  preview(): Feature | null {
    return this.f;
  }

  /** Re-runs the preview after a parameter change. */
  protected changed() {
    this.app.requestRebuild();
  }

  protected validate(): string | null {
    return null;
  }

  ok(): boolean {
    const err = this.validate();
    if (err) { this.setMessage('error', err); return false; }
    if (this.editingId) this.app.replaceFeature(this.f);
    else this.app.insertFeature(this.f);
    return true;
  }

  protected ctx() {
    return this.app.unitContext();
  }

  protected sketchBox(label: string, get: () => Id | null, set: (id: Id | null) => void): SelectionBox {
    const box = new SelectionBox(this, label, { feature: true, sketch: true }, toFeature(this.app, isSketch), (items) => { set((items[0]?.data as Id) ?? null); this.changed(); }, { single: true, placeholder: 'Select a sketch in the design tree', icon: 'sketchFeature' });
    const id = get();
    const sk = id ? this.app.store.feature(id) : null;
    if (sk) box.setItems([{ item: { kind: 'feature', id: sk.id }, data: sk.id, label: sk.name }]);
    return box;
  }
}

// ---------- extrude ----------

export class ExtrudePanel extends FeaturePanel<ExtrudeFeature> {
  helpText = '';
  render(): HTMLElement[] {
    const f = this.f;
    const ctx = this.ctx();
    const sketch = this.sketchBox('Profile sketch', () => f.sketch, (id) => { f.sketch = id ?? ''; });
    const endOpts = [{ value: 'blind' as const, label: 'Blind' }, { value: 'throughAll' as const, label: 'Through All' }, { value: 'midPlane' as const, label: 'Mid Plane' }];
    const depth = numberField({ label: 'Depth', icon: 'ruler', value: f.depth, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.depth = v; this.changed(); } });
    depth.hidden = f.end === 'throughAll';
    // A draft linked to an equation ("=Angle") is on too.
    const hasDraft = String(f.draft).trim().startsWith('=') || Number(f.draft) > 0;
    const draftAngle = numberField({ label: 'Draft angle', icon: 'draft', value: f.draft || 3, kind: 'angle', ctx, min: 0, onChange: (v) => { f.draft = v; this.changed(); } });
    draftAngle.hidden = !hasDraft;
    const outward = checkbox('Draft outward', f.draftOutward, (v) => { f.draftOutward = v; this.changed(); });
    outward.hidden = !hasDraft;
    const dir1 = section('Direction 1', [
      h('div', { class: 'row' }, flipButton('Reverse direction', f.flip, (v) => { f.flip = v; this.changed(); }), h('div', { class: 'grow' },
        selectField('End condition', f.end, endOpts, (v) => {
          f.end = v;
          depth.hidden = v === 'throughAll';
          dir2sec.hidden = v === 'midPlane';
          this.changed();
        }))),
      depth,
      checkbox('Draft', hasDraft, (v) => {
        f.draft = v ? 3 : 0;
        draftAngle.hidden = !v;
        outward.hidden = !v;
        this.changed();
      }),
      draftAngle, outward,
    ]);
    const d2depth = numberField({ label: 'Depth', icon: 'ruler', value: f.dir2?.depth ?? f.depth, kind: 'length', ctx, min: 1e-6, onChange: (v) => { if (f.dir2) { f.dir2.depth = v; this.changed(); } } });
    const dir2sec = section('Direction 2', [
      selectField('End condition', f.dir2?.end ?? 'blind', [{ value: 'blind' as const, label: 'Blind' }, { value: 'throughAll' as const, label: 'Through All' }], (v) => {
        if (f.dir2) { f.dir2.end = v; d2depth.hidden = v === 'throughAll'; this.changed(); }
      }),
      d2depth,
    ], { collapsed: !f.dir2, checkbox: { checked: !!f.dir2, onChange: (v) => { f.dir2 = v ? { end: 'blind', depth: f.depth } : null; this.changed(); } } });
    dir2sec.hidden = f.end === 'midPlane';
    return [section('Profile', [sketch.el]), dir1, dir2sec];
  }

  protected validate() {
    return this.f.sketch ? null : 'Select a sketch to extrude';
  }
}

// ---------- revolve ----------

export class RevolvePanel extends FeaturePanel<RevolveFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const ctx = this.ctx();
    const sketch = this.sketchBox('Profile sketch', () => f.sketch, (id) => { f.sketch = id ?? ''; });
    const axis = new SelectionBox(this, 'Axis of revolution', { edge: true, face: true }, toAxis(this.app), (items) => { f.axis = (items[0]?.data as AxisRef) ?? null; this.changed(); }, { single: true, placeholder: 'Uses the sketch centerline (or pick an edge)', icon: 'axis' });
    if (f.axis) axis.setItems([{ item: null, data: f.axis, label: axisLabel(this.app, f.axis) }]);
    const angle = numberField({ label: 'Angle', icon: 'revolve', value: f.angle, kind: 'angle', ctx, min: 1e-6, onChange: (v) => { f.angle = v; this.changed(); } });
    return [
      section('Profile', [sketch.el]),
      section('Axis', [axis.el]),
      section('Direction 1', [
        h('div', { class: 'row' }, flipButton('Reverse direction', f.flip, (v) => { f.flip = v; this.changed(); }), h('div', { class: 'grow' },
          selectField('Type', f.end, [{ value: 'blind' as const, label: 'Blind' }, { value: 'midPlane' as const, label: 'Mid Plane' }], (v) => { f.end = v; this.changed(); }))),
        angle,
      ]),
    ];
  }

  protected validate() {
    return this.f.sketch ? null : 'Select a sketch to revolve';
  }
}

// ---------- fillet / chamfer ----------

function edgeFaceBox(panel: PropertyPanel, app: App, label: string, f: { edges: EdgeRef[]; faces: FaceRef[] }, onChange: () => void): SelectionBox {
  const box = new SelectionBox(panel, label, { edge: true, face: true }, toEdgeOrFace(app), (items) => {
    f.edges = items.filter((i) => i.item?.kind === 'edge').map((i) => i.data as EdgeRef);
    f.faces = items.filter((i) => i.item?.kind === 'face').map((i) => i.data as FaceRef);
    onChange();
  }, { placeholder: 'Select edges or faces', icon: 'fillet' });
  box.setItems([
    ...f.edges.map((e) => ({ item: edgeItem(app, e), data: e, label: `Edge (${e.sig.type})` })),
    ...f.faces.map((r) => ({ item: faceItem(app, r), data: r, label: 'Face' })),
  ]);
  return box;
}

export class FilletPanel extends FeaturePanel<FilletFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const box = edgeFaceBox(this, this.app, 'Items to fillet', f, () => this.changed());
    return [section('Fillet Parameters', [
      box.el,
      numberField({ label: 'Radius', icon: 'fillet', value: f.radius, kind: 'length', ctx: this.ctx(), min: 1e-6, onChange: (v) => { f.radius = v; this.changed(); } }),
    ])];
  }

  protected validate() {
    return this.f.edges.length || this.f.faces.length ? null : 'Select edges or faces to fillet';
  }

  preview() {
    return this.f.edges.length || this.f.faces.length ? this.f : null;
  }
}

export class ChamferPanel extends FeaturePanel<ChamferFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const ctx = this.ctx();
    const box = edgeFaceBox(this, this.app, 'Items to chamfer', f, () => this.changed());
    const d2 = numberField({ label: 'Distance 2', icon: 'ruler', value: f.distance2, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.distance2 = v; this.changed(); } });
    const ang = numberField({ label: 'Angle', icon: 'chamfer', value: f.angle, kind: 'angle', ctx, min: 1e-6, onChange: (v) => { f.angle = v; this.changed(); } });
    const flip = flipButton('Flip direction', f.flip, (v) => { f.flip = v; this.changed(); });
    const sync = () => { d2.hidden = f.mode !== 'twoDistance'; ang.hidden = f.mode !== 'distanceAngle'; flip.hidden = f.mode === 'distance'; };
    sync();
    return [section('Chamfer Parameters', [
      box.el,
      h('div', { class: 'row' }, flip, h('div', { class: 'grow' }, selectField('Chamfer type', f.mode, [
        { value: 'distance' as const, label: 'Equal distance' },
        { value: 'twoDistance' as const, label: 'Distance distance' },
        { value: 'distanceAngle' as const, label: 'Angle distance' },
      ], (v) => { f.mode = v; sync(); this.changed(); }))),
      numberField({ label: 'Distance', icon: 'ruler', value: f.distance, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.distance = v; this.changed(); } }),
      d2, ang,
    ])];
  }

  protected validate() {
    return this.f.edges.length || this.f.faces.length ? null : 'Select edges or faces to chamfer';
  }

  preview() {
    return this.f.edges.length || this.f.faces.length ? this.f : null;
  }
}

// ---------- shell ----------

export class ShellPanel extends FeaturePanel<ShellFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const box = new SelectionBox(this, 'Faces to remove', { face: true }, toFace(this.app), (items) => { f.faces = items.map((i) => i.data as FaceRef); this.changed(); }, { placeholder: 'Select faces to open (optional)', icon: 'shell' });
    box.setItems(f.faces.map((r) => ({ item: faceItem(this.app, r), data: r, label: 'Face' })));
    return [section('Parameters', [
      numberField({ label: 'Thickness', icon: 'ruler', value: f.thickness, kind: 'length', ctx: this.ctx(), min: 1e-6, onChange: (v) => { f.thickness = v; this.changed(); } }),
      box.el,
      checkbox('Shell outward', f.outward, (v) => { f.outward = v; this.changed(); }),
    ])];
  }
}

// ---------- draft ----------

export class DraftPanel extends FeaturePanel<DraftFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const neutral = new SelectionBox(this, 'Neutral plane', { plane: true, planarOnly: true }, toPlane(this.app), (items) => { f.neutral = (items[0]?.data as PlaneRef) ?? null; this.changed(); }, { single: true, icon: 'plane' });
    if (f.neutral) neutral.setItems([{ item: null, data: f.neutral, label: planeLabel(this.app, f.neutral) }]);
    const faces = new SelectionBox(this, 'Faces to draft', { face: true }, toFace(this.app), (items) => { f.faces = items.map((i) => i.data as FaceRef); this.changed(); }, { icon: 'draft' });
    faces.setItems(f.faces.map((r) => ({ item: faceItem(this.app, r), data: r, label: 'Face' })));
    return [section('Draft', [
      numberField({ label: 'Draft angle', icon: 'draft', value: f.angle, kind: 'angle', ctx: this.ctx(), onChange: (v) => { f.angle = v; this.changed(); } }),
      h('div', { class: 'row' }, flipButton('Reverse direction', f.flip, (v) => { f.flip = v; this.changed(); }), h('span', { class: 'field-label' }, 'Reverse pull direction')),
      neutral.el, faces.el,
    ])];
  }

  protected validate() {
    if (!this.f.neutral) return 'Select a neutral plane';
    return this.f.faces.length ? null : 'Select faces to draft';
  }

  preview() {
    return this.f.neutral && this.f.faces.length ? this.f : null;
  }
}

// ---------- hole ----------

export class HolePanel extends FeaturePanel<HoleFeature> {
  /** Sketch created by this panel to hold hole positions. */
  private createdSketch: Id | null = null;

  constructor(app: App, f: HoleFeature, editing: boolean) {
    super(app, f, editing);
    this.helpText = editing ? '' : 'Click a planar face to place holes. Each click adds a hole. Edit the positions sketch afterwards to dimension them.';
  }

  render(): HTMLElement[] {
    const f = this.f;
    const ctx = this.ctx();
    const kinds = [{ value: 'simple' as const, label: 'Simple' }, { value: 'counterbore' as const, label: 'Counterbore' }, { value: 'countersink' as const, label: 'Countersink' }];
    const cb = [
      numberField({ label: 'Counterbore diameter', value: f.cbDiameter, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.cbDiameter = v; this.changed(); } }),
      numberField({ label: 'Counterbore depth', value: f.cbDepth, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.cbDepth = v; this.changed(); } }),
    ];
    const cs = [
      numberField({ label: 'Countersink diameter', value: f.csDiameter, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.csDiameter = v; this.changed(); } }),
      numberField({ label: 'Countersink angle', value: f.csAngle, kind: 'angle', ctx, min: 1, onChange: (v) => { f.csAngle = v; this.changed(); } }),
    ];
    const depth = numberField({ label: 'Depth', value: f.depth, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.depth = v; this.changed(); } });
    const sync = () => {
      cb.forEach((x) => { x.hidden = f.kind !== 'counterbore'; });
      cs.forEach((x) => { x.hidden = f.kind !== 'countersink'; });
      depth.hidden = f.end === 'throughAll';
    };
    sync();
    const positions = new SelectionBox(this, 'Positions', { face: true, planarOnly: true, feature: true }, (it) => this.pickPosition(it), () => this.changed(), { placeholder: 'Click a planar face to place a hole', icon: 'point', single: true });
    const sk = f.sketch ? this.app.store.feature<SketchFeature>(f.sketch) : null;
    if (sk) positions.setItems([{ item: null, data: sk.id, label: `${sk.name} (${sk.entities.filter((e) => e.t === 'point').length} points)` }]);
    return [
      section('Hole Type', [
        selectField('Type', f.kind, kinds, (v) => { f.kind = v; sync(); this.changed(); }, 'hole'),
        numberField({ label: 'Diameter', value: f.diameter, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.diameter = v; this.changed(); } }),
        ...cb, ...cs,
      ]),
      section('End Condition', [
        h('div', { class: 'row' }, flipButton('Reverse direction', f.flip, (v) => { f.flip = v; this.changed(); }), h('div', { class: 'grow' },
          selectField('End condition', f.end, [{ value: 'throughAll' as const, label: 'Through All' }, { value: 'blind' as const, label: 'Blind' }], (v) => { f.end = v; sync(); this.changed(); }))),
        depth,
      ]),
      section('Positions', [positions.el]),
    ];
  }

  /** A face click adds a hole point to the positions sketch. */
  private pickPosition(it: SelItem): SelBoxItem | null {
    const f = this.f;
    if (it.kind === 'feature') {
      const sk = this.app.store.feature(it.id);
      if (sk?.type !== 'sketch') return null;
      f.sketch = sk.id;
      return { item: it, data: sk.id, label: sk.name };
    }
    if (it.kind !== 'face') return null;
    const face = this.app.faces[it.index];
    if (!face?.frame) return null;
    const p = this.app.lastPickPoint ?? face.center;
    const frame = face.frame;
    const local = toLocal(frame, p);
    const app = this.app;
    if (!f.sketch || !this.createdSketch) {
      const id = app.store.nextId('s');
      const name = defaultName(app.store.doc, 'sketch');
      const sk = newSketch(id, name, { kind: 'face', face: faceRef(face) });
      sk.frame = frame;
      sk.entities.push({ id: 'p1', t: 'point', x: local[0], y: local[1] });
      app.insertFeature(sk);
      this.createdSketch = id;
      f.sketch = id;
    } else {
      app.store.change('Add hole position', (doc) => {
        const sk = doc.features.find((x) => x.id === f.sketch) as SketchFeature;
        let n = sk.entities.length + 1;
        while (sk.entities.some((e) => e.id === `p${n}`)) n++;
        // Positions are on the sketch's face plane; convert through its frame.
        const fr = app.frames[sk.id] ?? sk.frame ?? frame;
        const q = toLocal(fr, p);
        sk.entities.push({ id: `p${n}`, t: 'point', x: q[0], y: q[1] });
      });
    }
    const sk = app.store.feature<SketchFeature>(f.sketch)!;
    void dot; void sub;
    return { item: null, data: sk.id, label: `${sk.name} (${sk.entities.length} points)` };
  }

  cancel() {
    if (this.createdSketch) {
      const id = this.createdSketch;
      this.app.store.change('Remove hole positions', (doc) => { doc.features = doc.features.filter((x) => x.id !== id); if (doc.rollback != null) doc.rollback = Math.max(0, doc.rollback - 1); });
    }
  }

  protected validate() {
    return this.f.sketch ? null : 'Click a planar face to place at least one hole';
  }

  preview() {
    return this.f.sketch ? this.f : null;
  }
}

// ---------- patterns and mirror ----------

function seedBox(panel: PropertyPanel, app: App, ids: Id[], onChange: (ids: Id[]) => void, label = 'Features to pattern'): SelectionBox {
  const box = new SelectionBox(panel, label, { face: true, feature: true }, toFeature(app, isSeed), (items) => onChange(items.map((i) => i.data as Id)), { placeholder: 'Select features in the tree or a face of the feature', icon: 'part' });
  box.setItems(ids.map((id) => ({ item: { kind: 'feature', id }, data: id, label: app.store.feature(id)?.name ?? id })));
  return box;
}

function directionSection(panel: FeaturePanel<Feature>, app: App, title: string, d: PatternDir, onChange: () => void, extra?: { checkbox: { checked: boolean; onChange: (v: boolean) => void } }): HTMLElement {
  const ctx = app.unitContext();
  const dir = new SelectionBox(panel, 'Direction', { edge: true, face: true, plane: true }, toAxis(app), (items) => { d.ref = (items[0]?.data as AxisRef) ?? null; onChange(); }, { single: true, placeholder: 'Select an edge, face or plane', icon: 'axis' });
  if (d.ref) dir.setItems([{ item: null, data: d.ref, label: axisLabel(app, d.ref) }]);
  return section(title, [
    h('div', { class: 'row' }, flipButton('Reverse direction', d.flip, (v) => { d.flip = v; onChange(); }), h('div', { class: 'grow' }, dir.el)),
    numberField({ label: 'Spacing', icon: 'ruler', value: d.spacing, kind: 'length', ctx, onChange: (v) => { d.spacing = v; onChange(); } }),
    numberField({ label: 'Number of instances', icon: 'linearPattern', value: d.count, kind: 'count', ctx, min: 1, onChange: (v) => { d.count = v; onChange(); } }),
  ], extra ? { checkbox: extra.checkbox, collapsed: !extra.checkbox.checked } : {});
}

export class LinearPatternPanel extends FeaturePanel<LinearPatternFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const seeds = seedBox(this, this.app, f.seeds, (ids) => { f.seeds = ids; this.changed(); });
    const dir2: PatternDir = f.dir2 ?? { ref: null, spacing: f.dir1.spacing, count: 2, flip: false };
    return [
      directionSection(this as unknown as FeaturePanel<Feature>, this.app, 'Direction 1', f.dir1, () => this.changed()),
      directionSection(this as unknown as FeaturePanel<Feature>, this.app, 'Direction 2', dir2, () => { if (f.dir2) this.changed(); }, { checkbox: { checked: !!f.dir2, onChange: (v) => { f.dir2 = v ? dir2 : null; this.changed(); } } }),
      section('Features', [seeds.el]),
    ];
  }

  protected validate() {
    if (!this.f.dir1.ref) return 'Select a direction';
    return this.f.seeds.length ? null : 'Select features to pattern';
  }

  preview() {
    return this.f.dir1.ref && this.f.seeds.length ? this.f : null;
  }
}

export class CircularPatternPanel extends FeaturePanel<CircularPatternFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const ctx = this.ctx();
    const axis = new SelectionBox(this, 'Pattern axis', { edge: true, face: true, plane: true }, toAxis(this.app), (items) => { f.axis = (items[0]?.data as AxisRef) ?? null; this.changed(); }, { single: true, placeholder: 'Select a circular edge, cylindrical face or axis', icon: 'axis' });
    if (f.axis) axis.setItems([{ item: null, data: f.axis, label: axisLabel(this.app, f.axis) }]);
    const seeds = seedBox(this, this.app, f.seeds, (ids) => { f.seeds = ids; this.changed(); });
    return [
      section('Parameters', [
        h('div', { class: 'row' }, flipButton('Reverse direction', f.flip, (v) => { f.flip = v; this.changed(); }), h('div', { class: 'grow' }, axis.el)),
        numberField({ label: 'Angle', icon: 'circularPattern', value: f.angle, kind: 'angle', ctx, onChange: (v) => { f.angle = v; this.changed(); } }),
        numberField({ label: 'Number of instances', icon: 'circularPattern', value: f.count, kind: 'count', ctx, min: 2, onChange: (v) => { f.count = v; this.changed(); } }),
        checkbox('Equal spacing', f.equal, (v) => { f.equal = v; this.changed(); }),
      ]),
      section('Features', [seeds.el]),
    ];
  }

  protected validate() {
    if (!this.f.axis) return 'Select a pattern axis';
    return this.f.seeds.length ? null : 'Select features to pattern';
  }

  preview() {
    return this.f.axis && this.f.seeds.length ? this.f : null;
  }
}

export class MirrorPanel extends FeaturePanel<MirrorFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const plane = new SelectionBox(this, 'Mirror plane', { plane: true, planarOnly: true }, toPlane(this.app), (items) => { f.plane = (items[0]?.data as PlaneRef) ?? null; this.changed(); }, { single: true, icon: 'plane' });
    if (f.plane) plane.setItems([{ item: null, data: f.plane, label: planeLabel(this.app, f.plane) }]);
    const seeds = seedBox(this, this.app, f.seeds, (ids) => { f.seeds = ids; this.changed(); }, 'Features to mirror');
    return [section('Mirror Face/Plane', [plane.el]), section('Features to Mirror', [seeds.el, h('p', { class: 'field-label' }, 'Leave empty to mirror the whole body.')])];
  }

  protected validate() {
    return this.f.plane ? null : 'Select a mirror plane';
  }

  preview() {
    return this.f.plane ? this.f : null;
  }
}

// ---------- reference plane ----------

export class PlanePanel extends FeaturePanel<PlaneFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const ref = new SelectionBox(this, 'First reference', { plane: true, planarOnly: true }, toPlane(this.app), (items) => { f.ref = (items[0]?.data as PlaneRef) ?? null; this.changed(); }, { single: true, icon: 'plane' });
    if (f.ref) ref.setItems([{ item: null, data: f.ref, label: planeLabel(this.app, f.ref) }]);
    return [section('First Reference', [
      ref.el,
      numberField({ label: 'Offset distance', icon: 'ruler', value: f.offset, kind: 'length', ctx: this.ctx(), onChange: (v) => { f.offset = v; this.changed(); } }),
      checkbox('Flip offset', f.flip, (v) => { f.flip = v; this.changed(); }),
    ])];
  }

  protected validate() {
    return this.f.ref ? null : 'Select a plane or planar face';
  }

  onBuild() {
    // Show the resulting plane while editing.
    this.app.viewport.drawReferenceGeometry();
  }
}

// ---------- loft / sweep ----------

export class LoftPanel extends FeaturePanel<LoftFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const box = new SelectionBox(this, 'Profiles', { feature: true }, toFeature(this.app, isSketch), (items) => { f.profiles = items.map((i) => i.data as Id); this.changed(); }, { placeholder: 'Select two or more sketches in order', icon: 'loft' });
    box.setItems(f.profiles.map((id) => ({ item: { kind: 'feature', id }, data: id, label: this.app.store.feature(id)?.name ?? id })));
    return [section('Profiles', [box.el, checkbox('Ruled (straight) sections', f.ruled, (v) => { f.ruled = v; this.changed(); })])];
  }

  protected validate() {
    return this.f.profiles.length >= 2 ? null : 'Select at least two profile sketches';
  }

  preview() {
    return this.f.profiles.length >= 2 ? this.f : null;
  }
}

export class SweepPanel extends FeaturePanel<SweepFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const profile = this.sketchBox('Profile', () => f.profile, (id) => { f.profile = id; });
    const path = new SelectionBox(this, 'Path', { feature: true }, toFeature(this.app, isSketch), (items) => { f.path = (items[0]?.data as Id) ?? null; this.changed(); }, { single: true, placeholder: 'Select the path sketch', icon: 'sweep' });
    if (f.path) path.setItems([{ item: { kind: 'feature', id: f.path }, data: f.path, label: this.app.store.feature(f.path)?.name ?? '' }]);
    return [section('Profile and Path', [profile.el, path.el])];
  }

  protected validate() {
    return this.f.profile && this.f.path ? null : 'Select a profile and a path';
  }

  preview() {
    return this.f.profile && this.f.path ? this.f : null;
  }
}

// ---------- factory ----------

export function panelFor(app: App, f: Feature, editing: boolean): PropertyPanel | null {
  switch (f.type) {
    case 'extrude': return new ExtrudePanel(app, f, editing);
    case 'revolve': return new RevolvePanel(app, f, editing);
    case 'fillet': return new FilletPanel(app, f, editing);
    case 'chamfer': return new ChamferPanel(app, f, editing);
    case 'shell': return new ShellPanel(app, f, editing);
    case 'hole': return new HolePanel(app, f, editing);
    case 'linearPattern': return new LinearPatternPanel(app, f, editing);
    case 'circularPattern': return new CircularPatternPanel(app, f, editing);
    case 'mirror': return new MirrorPanel(app, f, editing);
    case 'plane': return new PlanePanel(app, f, editing);
    case 'loft': return new LoftPanel(app, f, editing);
    case 'sweep': return new SweepPanel(app, f, editing);
    case 'draft': return new DraftPanel(app, f, editing);
    default: return null;
  }
}

/** Creates a new feature panel, pre-filling from the current selection. */
export function startFeature(app: App, type: Feature['type'], opts: { cut?: boolean } = {}): PropertyPanel | null {
  const doc = app.store.doc;
  const id = app.store.nextId('f');
  const size = app.typicalSize();
  const sel = app.selection.items;
  const selSketch = (() => {
    for (const it of sel) if (it.kind === 'feature' && app.store.feature(it.id)?.type === 'sketch') return it.id;
    // Default to the most recent unconsumed sketch.
    const used = new Set(doc.features.flatMap((f) => (f.type === 'extrude' || f.type === 'revolve' || f.type === 'hole' ? [f.sketch] : f.type === 'loft' ? f.profiles : f.type === 'sweep' ? [f.profile, f.path] : [])));
    const built = doc.features.slice(0, app.store.builtCount);
    for (let i = built.length - 1; i >= 0; i--) if (built[i].type === 'sketch' && !used.has(built[i].id)) return built[i].id;
    return null;
  })();
  const name = defaultName(doc, type, opts.cut);
  const edges = app.selection.ofKind('edge').map((s) => app.edges[s.index]).filter(Boolean).map(edgeRef);
  const faces = app.selectedFaceRefs();
  const seeds = [...new Set(sel.flatMap((it) => (it.kind === 'feature' ? [it.id] : it.kind === 'face' ? [app.faces[it.index]?.feature] : [])).filter((x): x is Id => !!x && isSeed(app.store.feature(x)!)))];
  let f: Feature;
  switch (type) {
    case 'extrude': {
      const e = newExtrude(id, name, selSketch ?? '', !!opts.cut, size);
      if (opts.cut) e.flip = cutFlip(app, selSketch);
      f = e;
      break;
    }
    case 'revolve': f = newRevolve(id, name, selSketch ?? '', !!opts.cut); break;
    case 'fillet': { const x = newFillet(id, name, Math.max(size / 10, app.store.unitScale)); x.edges = edges; x.faces = faces; f = x; break; }
    case 'chamfer': { const x = newChamfer(id, name, Math.max(size / 10, app.store.unitScale)); x.edges = edges; x.faces = faces; f = x; break; }
    case 'shell': { const x = newShell(id, name, shellThickness(app, Math.max(size / 20, app.store.unitScale))); x.faces = faces; f = x; break; }
    case 'hole': f = newHole(id, name, '', Math.max(size / 5, app.store.unitScale * 2)); break;
    case 'linearPattern': {
      const x = newLinearPattern(id, name, seeds, size);
      const e = app.selection.ofKind('edge')[0];
      if (e && app.edges[e.index]?.type === 'line') x.dir1.ref = { kind: 'edge', edge: edgeRef(app.edges[e.index]) };
      f = x;
      break;
    }
    case 'circularPattern': f = newCircularPattern(id, name, seeds); break;
    case 'mirror': { const x = newMirror(id, name, seeds); x.plane = app.selectedPlaneRef(); f = x; break; }
    case 'plane': f = newPlane(id, name, app.selectedPlaneRef(), size); break;
    case 'loft': f = newLoft(id, name, sel.filter((it) => it.kind === 'feature' && app.store.feature(it.id)?.type === 'sketch').map((it) => (it as { id: Id }).id), !!opts.cut); break;
    case 'sweep': f = newSweep(id, name, !!opts.cut); break;
    case 'draft': { const x = newDraft(id, name); x.faces = faces; f = x; break; }
    default: return null;
  }
  // Features that add depth are easier to judge in a 3D view.
  const flat = ['front', 'back', 'left', 'right', 'top', 'bottom'];
  if (['extrude', 'revolve', 'loft', 'sweep'].includes(type) && flat.includes(app.renderer.camera.viewName() ?? '')) app.viewport.setView('trimetric');
  return panelFor(app, f, false);
}

/**
 * A default shell thickness below the radius of every fillet built so far:
 * a wall as thick as a fillet's radius cannot be offset (the default fillet
 * and shell sizes are equal on small parts).
 */
function shellThickness(app: App, size: number): number {
  let t = size;
  for (const f of app.store.doc.features.slice(0, app.store.builtCount)) {
    if (f.type !== 'fillet' || f.suppressed) continue;
    let r: number;
    try { r = app.store.evalParam(f.radius, 'length'); } catch { continue; }
    if (r > 0 && r <= t) t = r / 2;
  }
  return t;
}

/** Whether a new cut should be flipped so that it goes into the material. */
function cutFlip(app: App, sketchId: Id | null): boolean {
  if (!sketchId || !app.bbox) return false;
  const sk = app.store.feature<SketchFeature>(sketchId);
  const fr = sk ? app.frameOfSketch(sk) : null;
  if (!fr) return false;
  const c: Vec3 = [(app.bbox.min[0] + app.bbox.max[0]) / 2, (app.bbox.min[1] + app.bbox.max[1]) / 2, (app.bbox.min[2] + app.bbox.max[2]) / 2];
  // Cuts go against the normal by default; flip when the material is in front.
  return dot(sub(c, fr.o), fr.n) > 1e-6;
}
