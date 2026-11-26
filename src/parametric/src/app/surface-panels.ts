// Surface modeling in the interface: the commands of the Surfaces tab, their
// PropertyManager panels, and how surface bodies are shown (tinted, hidden
// with their feature).

import type { Vec3 } from '../math/vec';
import { consumedSketches, defaultName, nextName } from '../model/features';
import {
  SURFACE_LABELS, bodyFeatureOf, newSurfaceFeature, type SurfaceFeature, type SurfaceFeatureType,
} from '../model/surfaces';
import type {
  AxisRef, DeleteFaceFeature, EdgeRef, FaceRef, Id, PlaneRef, SurfaceCutFeature, SurfaceExtendFeature,
  SurfaceExtrudeFeature, SurfaceFillFeature, SurfaceKnitFeature, SurfaceLoftFeature, SurfaceOffsetFeature, SurfacePlanarFeature,
  SurfaceRevolveFeature, SurfaceSweepFeature, SurfaceTrimFeature, ThickenFeature, TrimTool,
} from '../model/types';
import { h } from '../ui/dom';
import type { App } from './app';
import type { Command } from './commands';
import {
  FeaturePanel, axisItem, axisLabel, edgeItem, faceItem, isSketch, planeItem, planeLabel, toAxis, toEdge, toFace, toFeature, toPlane,
} from './panels';
import { PropertyPanel, SelectionBox, type SelBoxItem, checkbox, flipButton, numberField, section, segmented, selectField } from './pm';
import { type SelItem, edgeRef, faceRef } from './selection';

// ---------- picks ----------

/** The feature name of a surface body ("Surface-Loft1"). */
function bodyName(app: App, body: Id): string {
  return app.store.feature(bodyFeatureOf(body))?.name ?? 'surface';
}

/** A face of a surface body as a pick naming the body. */
const toSurfaceFace = (app: App) => (it: SelItem): SelBoxItem | null => {
  if (it.kind !== 'face') return null;
  const f = app.faces[it.index];
  if (!f?.body) return null;
  return { item: it, data: faceRef(f), label: bodyName(app, f.body) };
};

/** A face of the solid. */
const toSolidFace = (app: App) => (it: SelItem): SelBoxItem | null => {
  if (it.kind !== 'face') return null;
  const f = app.faces[it.index];
  if (!f || f.body) return null;
  return toFace(app)(it);
};

/** An edge on the boundary of a surface body. */
const toSurfaceEdge = (app: App) => (it: SelItem): SelBoxItem | null => {
  if (it.kind !== 'edge') return null;
  const e = app.edges[it.index];
  if (!e?.body || e.faces.length !== 1) return null;
  return { item: it, data: edgeRef(e), label: `Edge <${it.index + 1}> of ${bodyName(app, e.body)}` };
};

/** One pick per surface body: a second face of a body already listed toggles it off. */
function bodyBox(panel: PropertyPanel, app: App, label: string, refs: FaceRef[], onChange: (refs: FaceRef[]) => void, opts: { single?: boolean; placeholder?: string; icon?: string } = {}): SelectionBox {
  const bodyOf = (r: FaceRef) => app.faces.find((f) => f.name === r.name)?.body ?? null;
  let box: SelectionBox;
  const convert = (it: SelItem): SelBoxItem | null => {
    const x = toSurfaceFace(app)(it);
    if (!x) return null;
    // Another face of a body that is listed stands for the same body.
    const body = app.faces[(it as { index: number }).index]?.body;
    const listed = box.items.find((i) => bodyOf(i.data as FaceRef) === body);
    return listed ?? x;
  };
  box = new SelectionBox(panel, label, { face: true }, convert, (items) => onChange(items.map((i) => i.data as FaceRef)), { placeholder: 'Select a surface in the graphics area', ...opts });
  box.setItems(refs.map((r) => ({ item: faceItem(app, r), data: r, label: bodyName(app, bodyOf(r) ?? r.name.split(':')[0]) })));
  return box;
}

const surfaceFaceLabel = (app: App, r: FaceRef) => {
  const f = app.faces.find((x) => x.name === r.name);
  return f?.body ? bodyName(app, f.body) : 'Face';
};

// ---------- panels ----------

abstract class SurfacePanel<T extends SurfaceFeature> extends FeaturePanel<T> {}

export class SurfaceExtrudePanel extends SurfacePanel<SurfaceExtrudeFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const ctx = this.ctx();
    const sketch = this.sketchBox('Profile sketch', () => f.sketch || null, (id) => { f.sketch = id ?? ''; });
    const dir2 = f.dir2 ?? { depth: f.depth };
    const dir2sec = section('Direction 2', [
      numberField({ label: 'Depth', icon: 'ruler', value: dir2.depth, kind: 'length', ctx, min: 1e-6, onChange: (v) => { dir2.depth = v; if (f.dir2) this.changed(); } }),
    ], { collapsed: !f.dir2, checkbox: { checked: !!f.dir2, onChange: (v) => { f.dir2 = v ? dir2 : null; this.changed(); } } });
    dir2sec.hidden = f.end === 'midPlane';
    return [
      section('Profile', [sketch.el, h('p', { class: 'field-label' }, 'Open or closed curves; each becomes a face.')]),
      section('Direction 1', [
        h('div', { class: 'row' }, flipButton('Reverse direction', f.flip, (v) => { f.flip = v; this.changed(); }), h('div', { class: 'grow' },
          selectField('End condition', f.end, [{ value: 'blind' as const, label: 'Blind' }, { value: 'midPlane' as const, label: 'Mid Plane' }], (v) => {
            f.end = v;
            dir2sec.hidden = v === 'midPlane';
            this.changed();
          }))),
        numberField({ label: 'Depth', icon: 'ruler', value: f.depth, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.depth = v; this.changed(); } }),
      ]),
      dir2sec,
    ];
  }

  protected validate() {
    return this.f.sketch ? null : 'Select a sketch to extrude';
  }

  preview() {
    return this.f.sketch ? this.f : null;
  }
}

export class SurfaceRevolvePanel extends SurfacePanel<SurfaceRevolveFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const sketch = this.sketchBox('Profile sketch', () => f.sketch || null, (id) => { f.sketch = id ?? ''; });
    const axis = new SelectionBox(this, 'Axis of revolution', { edge: true, face: true }, toAxis(this.app), (items) => { f.axis = (items[0]?.data as AxisRef) ?? null; this.changed(); }, { single: true, placeholder: 'Uses the sketch centerline (or pick an edge)', icon: 'axis' });
    if (f.axis) axis.setItems([{ item: axisItem(this.app, f.axis), data: f.axis, label: axisLabel(this.app, f.axis) }]);
    return [
      section('Profile', [sketch.el]),
      section('Axis', [axis.el]),
      section('Direction 1', [
        h('div', { class: 'row' }, flipButton('Reverse direction', f.flip, (v) => { f.flip = v; this.changed(); }), h('div', { class: 'grow' },
          selectField('Type', f.end, [{ value: 'blind' as const, label: 'Blind' }, { value: 'midPlane' as const, label: 'Mid Plane' }], (v) => { f.end = v; this.changed(); }))),
        numberField({ label: 'Angle', icon: 'revolve', value: f.angle, kind: 'angle', ctx: this.ctx(), min: 1e-6, max: 360, onChange: (v) => { f.angle = v; this.changed(); } }),
      ]),
    ];
  }

  protected validate() {
    return this.f.sketch ? null : 'Select a sketch to revolve';
  }

  preview() {
    return this.f.sketch ? this.f : null;
  }
}

export class SurfaceSweepPanel extends SurfacePanel<SurfaceSweepFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const profile = this.sketchBox('Profile', () => f.profile, (id) => { f.profile = id; });
    const path = new SelectionBox(this, 'Path', { feature: true }, toFeature(this.app, isSketch), (items) => { f.path = (items[0]?.data as Id) ?? null; this.changed(); }, { single: true, placeholder: 'Select the path sketch', icon: 'sweep' });
    if (f.path) path.setItems([{ item: { kind: 'feature', id: f.path }, data: f.path, label: this.app.store.feature(f.path)?.name ?? '' }]);
    return [section('Profile and Path', [profile.el, path.el, h('p', { class: 'field-label' }, 'The profile may be an open curve.')])];
  }

  protected validate() {
    return this.f.profile && this.f.path ? null : 'Select a profile and a path';
  }

  preview() {
    return this.f.profile && this.f.path ? this.f : null;
  }
}

export class SurfaceLoftPanel extends SurfacePanel<SurfaceLoftFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const box = new SelectionBox(this, 'Profiles', { feature: true }, toFeature(this.app, isSketch), (items) => { f.profiles = items.map((i) => i.data as Id); this.changed(); }, { placeholder: 'Select two or more sketches in order', icon: 'surfaceLoft' });
    box.setItems(f.profiles.map((id) => ({ item: { kind: 'feature', id }, data: id, label: this.app.store.feature(id)?.name ?? id })));
    return [section('Profiles', [box.el, h('p', { class: 'field-label' }, 'Open or closed curves, one chain per sketch.'), checkbox('Ruled (straight) sections', f.ruled, (v) => { f.ruled = v; this.changed(); })])];
  }

  protected validate() {
    return this.f.profiles.length >= 2 ? null : 'Select at least two profile sketches';
  }

  preview() {
    return this.f.profiles.length >= 2 ? this.f : null;
  }
}

export class SurfacePlanarPanel extends SurfacePanel<SurfacePlanarFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const app = this.app;
    // A sketch, or edges (of the solid or of surfaces) closing a loop: either kind replaces the other.
    const convert = (it: SelItem): SelBoxItem | null => toFeature(app, isSketch)(it.kind === 'face' ? { kind: 'feature', id: '' } : it) ?? toEdge(app)(it);
    const box = new SelectionBox(this, 'Bounding entities', { feature: true, edge: true }, convert, (items) => {
      const sk = items.filter((i) => typeof i.data === 'string');
      const last = items[items.length - 1];
      if (sk.length && last && typeof last.data === 'string') {
        f.sketch = last.data as Id;
        f.edges = [];
        if (items.length > 1) box.setItems([last]);
      } else {
        f.sketch = null;
        f.edges = items.filter((i) => typeof i.data !== 'string').map((i) => i.data as EdgeRef);
        if (sk.length) box.setItems(items.filter((i) => typeof i.data !== 'string'));
      }
      this.changed();
    }, { placeholder: 'Select a sketch, or edges forming a closed loop', icon: 'surfacePlanar' });
    if (f.sketch) box.setItems([{ item: { kind: 'feature', id: f.sketch }, data: f.sketch, label: app.store.feature(f.sketch)?.name ?? f.sketch }]);
    else box.setItems(f.edges.map((e) => ({ item: edgeItem(app, e), data: e, label: e.sig.type ? `Edge (${e.sig.type})` : 'Edge' })));
    return [section('Bounding Entities', [box.el])];
  }

  protected validate() {
    return this.f.sketch || this.f.edges.length ? null : 'Select a sketch or a closed loop of edges';
  }

  preview() {
    return this.f.sketch || this.f.edges.length ? this.f : null;
  }
}

export class SurfaceOffsetPanel extends SurfacePanel<SurfaceOffsetFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const app = this.app;
    const box = new SelectionBox(this, 'Faces to offset', { face: true }, (it) => toSurfaceFace(app)(it) ?? toFace(app)(it), (items) => { f.faces = items.map((i) => i.data as FaceRef); this.changed(); }, { placeholder: 'Select faces of the part or of surfaces', icon: 'surfaceOffset' });
    box.setItems(f.faces.map((r) => ({ item: faceItem(app, r), data: r, label: surfaceFaceLabel(app, r) })));
    return [section('Offset Parameters', [
      box.el,
      h('div', { class: 'row' }, flipButton('Flip offset direction', f.flip, (v) => { f.flip = v; this.changed(); }), h('div', { class: 'grow' },
        numberField({ label: 'Offset distance', icon: 'ruler', value: f.distance, kind: 'length', ctx: this.ctx(), min: 0, onChange: (v) => { f.distance = v; this.changed(); } }))),
      h('p', { class: 'field-label' }, 'A distance of 0 copies the faces.'),
    ])];
  }

  protected validate() {
    return this.f.faces.length ? null : 'Select faces to offset';
  }

  preview() {
    return this.f.faces.length ? this.f : null;
  }
}

export class SurfaceFillPanel extends SurfacePanel<SurfaceFillFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const box = new SelectionBox(this, 'Patch boundary', { edge: true }, toEdge(this.app), (items) => { f.edges = items.map((i) => i.data as EdgeRef); this.changed(); }, { placeholder: 'Select the edges around the opening', icon: 'surfaceFill' });
    box.setItems(f.edges.map((e) => ({ item: edgeItem(this.app, e), data: e, label: e.sig.type ? `Edge (${e.sig.type})` : 'Edge' })));
    return [section('Patch Boundary', [box.el])];
  }

  protected validate() {
    return this.f.edges.length ? null : 'Select the edges around the opening';
  }

  preview() {
    return this.f.edges.length ? this.f : null;
  }
}

export class SurfaceTrimPanel extends SurfacePanel<SurfaceTrimFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const app = this.app;
    const toTool = (it: SelItem): SelBoxItem | null => {
      const s = toSurfaceFace(app)(it);
      if (s) return { ...s, data: { kind: 'surface', face: s.data as FaceRef } as TrimTool };
      const sk = toFeature(app, isSketch)(it);
      if (sk) return { ...sk, data: { kind: 'sketch', sketch: sk.data as Id } as TrimTool };
      const p = toPlane(app)(it);
      if (p) return { ...p, data: { kind: 'plane', plane: p.data as PlaneRef } as TrimTool };
      return null;
    };
    const tool = new SelectionBox(this, 'Trim tool', { face: true, plane: true, feature: true, sketch: true }, toTool, (items) => { f.tool = (items[0]?.data as TrimTool) ?? null; this.changed(); }, { single: true, placeholder: 'Select a plane, a sketch or a surface', icon: 'surfaceTrim' });
    if (f.tool) tool.setItems([{ item: f.tool.kind === 'surface' ? faceItem(app, f.tool.face) : f.tool.kind === 'plane' ? planeItem(app, f.tool.plane) : { kind: 'feature', id: f.tool.sketch }, data: f.tool, label: this.toolLabel(f.tool) }]);
    const targets = bodyBox(this, app, 'Surfaces to trim', f.faces, (refs) => { f.faces = refs; this.changed(); }, { icon: 'surfaceExtrude' });
    const flip = checkbox('Keep the other side', f.flip, (v) => { f.flip = v; this.changed(); });
    flip.hidden = f.keep.length > 0;
    const keep = new SelectionBox(this, 'Pieces to keep', { face: true }, (it) => {
      const s = toSurfaceFace(app)(it);
      if (!s) return null;
      const p: Vec3 = app.lastPickPoint ?? app.faces[(it as { index: number }).index].center;
      return { item: null, data: p, label: `Piece of ${s.label} at ${p.map((x) => +x.toFixed(2)).join(', ')}` };
    }, (items) => { f.keep = items.map((i) => i.data as Vec3); flip.hidden = f.keep.length > 0; this.changed(); }, { placeholder: 'Optional: click the pieces to keep', icon: 'select' });
    keep.setItems(f.keep.map((p) => ({ item: null, data: p, label: `Piece at ${p.map((x) => +x.toFixed(2)).join(', ')}` })));
    return [
      section('Trim Tool', [tool.el]),
      section('Surfaces', [targets.el]),
      section('Keep', [keep.el, flip, h('p', { class: 'field-label' }, 'Without picked pieces, the side the tool’s normal points to is kept.')]),
    ];
  }

  private toolLabel(t: TrimTool): string {
    if (t.kind === 'sketch') return this.app.store.feature(t.sketch)?.name ?? 'Sketch';
    if (t.kind === 'plane') return planeLabel(this.app, t.plane);
    return surfaceFaceLabel(this.app, t.face);
  }

  protected validate() {
    if (!this.f.tool) return 'Select a trim tool';
    return this.f.faces.length ? null : 'Select the surfaces to trim';
  }

  preview() {
    return this.f.tool && this.f.faces.length ? this.f : null;
  }
}

export class SurfaceExtendPanel extends SurfacePanel<SurfaceExtendFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const box = new SelectionBox(this, 'Edges to extend', { edge: true }, toSurfaceEdge(this.app), (items) => { f.edges = items.map((i) => i.data as EdgeRef); this.changed(); }, { placeholder: 'Select boundary edges of a surface', icon: 'surfaceExtend' });
    box.setItems(f.edges.map((e) => ({ item: edgeItem(this.app, e), data: e, label: e.sig.type ? `Edge (${e.sig.type})` : 'Edge' })));
    return [
      section('Edges to Extend', [box.el]),
      section('End Condition', [
        numberField({ label: 'Distance', icon: 'ruler', value: f.distance, kind: 'length', ctx: this.ctx(), min: 1e-6, onChange: (v) => { f.distance = v; this.changed(); } }),
      ]),
      section('Extension Type', [segmented('Extension type', f.mode, [{ value: 'same' as const, label: 'Same surface' }, { value: 'linear' as const, label: 'Linear' }], (v) => { f.mode = v; this.changed(); })]),
    ];
  }

  protected validate() {
    return this.f.edges.length ? null : 'Select edges to extend';
  }

  preview() {
    return this.f.edges.length ? this.f : null;
  }
}

export class SurfaceKnitPanel extends SurfacePanel<SurfaceKnitFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const box = bodyBox(this, this.app, 'Surfaces to knit', f.faces, (refs) => { f.faces = refs; this.changed(); }, { icon: 'surfaceKnit' });
    return [section('Selections', [
      box.el,
      checkbox('Create solid', f.solid, (v) => { f.solid = v; this.changed(); }),
      h('p', { class: 'field-label' }, 'A solid is made when the surfaces close a volume; it is added to the part.'),
      numberField({ label: 'Knit tolerance', icon: 'ruler', value: f.tolerance, kind: 'length', ctx: this.ctx(), min: 1e-7, onChange: (v) => { f.tolerance = v; this.changed(); } }),
    ])];
  }

  protected validate() {
    return this.f.faces.length ? null : 'Select the surfaces to knit';
  }

  preview() {
    return this.f.faces.length ? this.f : null;
  }
}

export class ThickenPanel extends SurfacePanel<ThickenFeature> {
  get title() {
    return this.editingId ? this.f.name : this.f.cut ? 'Thickened Cut' : 'Thicken';
  }

  render(): HTMLElement[] {
    const f = this.f;
    const box = bodyBox(this, this.app, 'Surface to thicken', f.faces, (refs) => { f.faces = refs; this.changed(); }, { single: true, icon: 'thicken' });
    return [section('Thicken Parameters', [
      box.el,
      segmented('Thicken side', f.side, [{ value: 'front' as const, label: 'Side 1' }, { value: 'back' as const, label: 'Side 2' }, { value: 'both' as const, label: 'Both' }], (v) => { f.side = v; this.changed(); }),
      numberField({ label: 'Thickness', icon: 'ruler', value: f.thickness, kind: 'length', ctx: this.ctx(), min: 1e-6, onChange: (v) => { f.thickness = v; this.changed(); } }),
      h('p', { class: 'field-label' }, f.cut ? 'The thickened surface is cut from the part.' : 'The thickened surface is added to the part.'),
    ])];
  }

  protected validate() {
    return this.f.faces.length ? null : 'Select a surface to thicken';
  }

  preview() {
    return this.f.faces.length ? this.f : null;
  }
}

export class SurfaceCutPanel extends SurfacePanel<SurfaceCutFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const box = bodyBox(this, this.app, 'Cutting surface', f.face ? [f.face] : [], (refs) => { f.face = refs[0] ?? null; this.changed(); }, { single: true, icon: 'surfaceCut' });
    return [section('Surface Cut Parameters', [
      box.el,
      h('div', { class: 'row' }, flipButton('Flip side to cut', f.flip, (v) => { f.flip = v; this.changed(); }), h('span', { class: 'field-label' }, 'Flip side to cut')),
      h('p', { class: 'field-label' }, 'Material on the side the surface’s normal points to is removed.'),
    ])];
  }

  protected validate() {
    return this.f.face ? null : 'Select the surface to cut with';
  }

  preview() {
    return this.f.face ? this.f : null;
  }
}

export class DeleteFacePanel extends SurfacePanel<DeleteFaceFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const box = new SelectionBox(this, 'Faces to delete', { face: true }, toSolidFace(this.app), (items) => { f.faces = items.map((i) => i.data as FaceRef); this.changed(); }, { placeholder: 'Select faces of the solid', icon: 'deleteFace' });
    box.setItems(f.faces.map((r) => ({ item: faceItem(this.app, r), data: r, label: 'Face' })));
    return [section('Selections', [
      box.el,
      selectField('Options', f.mode, [{ value: 'delete' as const, label: 'Delete (the solid becomes a surface)' }, { value: 'patch' as const, label: 'Delete and Patch' }], (v) => { f.mode = v; this.changed(); }),
    ])];
  }

  protected validate() {
    return this.f.faces.length ? null : 'Select faces to delete';
  }

  preview() {
    return this.f.faces.length ? this.f : null;
  }
}

export function surfacePanelFor(app: App, f: SurfaceFeature, editing: boolean): PropertyPanel {
  switch (f.type) {
    case 'surfaceExtrude': return new SurfaceExtrudePanel(app, f, editing);
    case 'surfaceRevolve': return new SurfaceRevolvePanel(app, f, editing);
    case 'surfaceSweep': return new SurfaceSweepPanel(app, f, editing);
    case 'surfaceLoft': return new SurfaceLoftPanel(app, f, editing);
    case 'surfacePlanar': return new SurfacePlanarPanel(app, f, editing);
    case 'surfaceOffset': return new SurfaceOffsetPanel(app, f, editing);
    case 'surfaceFill': return new SurfaceFillPanel(app, f, editing);
    case 'surfaceTrim': return new SurfaceTrimPanel(app, f, editing);
    case 'surfaceExtend': return new SurfaceExtendPanel(app, f, editing);
    case 'surfaceKnit': return new SurfaceKnitPanel(app, f, editing);
    case 'thicken': return new ThickenPanel(app, f, editing);
    case 'surfaceCut': return new SurfaceCutPanel(app, f, editing);
    case 'deleteFace': return new DeleteFacePanel(app, f, editing);
  }
}

// ---------- starting a feature ----------

/** The selected sketch, or the last sketch built that no feature uses yet. */
function profileSketch(app: App): Id | null {
  for (const it of app.selection.items) if (it.kind === 'feature' && app.store.feature(it.id)?.type === 'sketch') return it.id;
  const doc = app.store.doc;
  const used = new Set(doc.features.flatMap((f) => consumedSketches(f)));
  const built = doc.features.slice(0, app.store.builtCount);
  for (let i = built.length - 1; i >= 0; i--) if (built[i].type === 'sketch' && !used.has(built[i].id)) return built[i].id;
  return null;
}

/** A new surface feature, filled in from the selection, in its panel. */
export function startSurfaceFeature(app: App, type: SurfaceFeatureType, opts: { cut?: boolean } = {}): PropertyPanel {
  const doc = app.store.doc;
  const id = app.store.nextId('f');
  const name = type === 'thicken' && opts.cut ? nextName(doc, 'Thicken-Cut') : defaultName(doc, type);
  const f = newSurfaceFeature(type, id, name, app.typicalSize());
  const sel = app.selection.items;
  const faces = sel.flatMap((it) => (it.kind === 'face' && app.faces[it.index] ? [app.faces[it.index]] : []));
  const surfaceFaces = faces.filter((x) => x.body);
  const solidFaces = faces.filter((x) => !x.body);
  const edges = app.selection.ofKind('edge').map((s) => app.edges[s.index]).filter(Boolean).map(edgeRef);
  const sketches = sel.filter((it) => it.kind === 'feature' && app.store.feature(it.id)?.type === 'sketch').map((it) => (it as { id: Id }).id);
  // One face per surface body.
  const perBody = surfaceFaces.filter((x, i) => surfaceFaces.findIndex((y) => y.body === x.body) === i).map(faceRef);
  switch (f.type) {
    case 'surfaceExtrude': case 'surfaceRevolve': f.sketch = profileSketch(app) ?? ''; break;
    case 'surfacePlanar': if (edges.length) f.edges = edges; else f.sketch = profileSketch(app); break;
    case 'surfaceLoft': f.profiles = sketches; break;
    case 'surfaceSweep': if (sketches.length) { f.profile = sketches[0]; f.path = sketches[1] ?? null; } break;
    case 'surfaceOffset': f.faces = faces.map(faceRef); break;
    case 'surfaceFill': f.edges = edges; break;
    case 'surfaceExtend': f.edges = app.selection.ofKind('edge').map((s) => app.edges[s.index]).filter((e) => e?.body && e.faces.length === 1).map(edgeRef); break;
    case 'surfaceTrim': f.faces = perBody; break;
    case 'surfaceKnit': f.faces = perBody; break;
    case 'thicken': f.faces = perBody.slice(0, 1); f.cut = !!opts.cut; break;
    case 'surfaceCut': f.face = perBody[0] ?? null; break;
    case 'deleteFace': f.faces = solidFaces.map(faceRef); break;
  }
  const flat = ['front', 'back', 'left', 'right', 'top', 'bottom'];
  if (['surfaceExtrude', 'surfaceRevolve', 'surfaceLoft', 'surfaceSweep'].includes(type) && flat.includes(app.renderer.camera.viewName() ?? '')) app.viewport.setView('trimetric');
  return surfacePanelFor(app, f, false);
}

// ---------- commands ----------

const DESCRIPTIONS: Record<SurfaceFeatureType, string> = {
  surfaceExtrude: 'Extrude open or closed sketch curves into a surface.',
  surfaceRevolve: 'Revolve sketch curves around an axis into a surface.',
  surfaceSweep: 'Sweep an open or closed profile along a path into a surface.',
  surfaceLoft: 'Blend a surface through two or more open or closed profiles.',
  surfacePlanar: 'Fill a closed sketch profile or a closed loop of edges with a flat surface.',
  surfaceOffset: 'Offset faces of the part or of surfaces into a new surface. A distance of 0 copies them.',
  surfaceFill: 'Patch an opening bounded by a closed loop of edges.',
  surfaceTrim: 'Trim surfaces with a plane, a sketch or another surface.',
  surfaceExtend: 'Extend a surface past its boundary edges.',
  surfaceKnit: 'Join surfaces along their edges into one, or into a solid when they close a volume.',
  thicken: 'Give a surface thickness, adding it to the part.',
  surfaceCut: 'Cut the part with a surface, removing the material on one side of it.',
  deleteFace: 'Delete faces of the solid, leaving a surface body, or delete and patch them.',
};

const KEYWORDS: Partial<Record<SurfaceFeatureType, string>> = {
  surfaceExtrude: 'surface extrude sheet',
  surfaceRevolve: 'surface revolve sheet',
  surfaceSweep: 'surface sweep sheet',
  surfaceLoft: 'surface loft blend boundary',
  surfacePlanar: 'surface planar plane fill flat',
  surfaceOffset: 'surface offset copy',
  surfaceFill: 'surface fill patch boundary',
  surfaceTrim: 'surface trim split cut',
  surfaceExtend: 'surface extend',
  surfaceKnit: 'surface knit sew stitch solid',
  thicken: 'surface thicken solid',
  surfaceCut: 'surface cut split body replace',
  deleteFace: 'surface delete face remove patch',
};

/** The Surfaces tab's commands. */
export function surfaceCommands(app: App): Command[] {
  const start = (type: SurfaceFeatureType, cut = false) => () => {
    if (app.sketchEditor) {
      // Finish the sketch first; it becomes the profile.
      const id = app.sketchEditor.sketchId;
      app.exitSketch(true);
      app.selection.set([{ kind: 'feature', id }]);
    }
    void app.openPanel(startSurfaceFeature(app, type, { cut }));
  };
  const types = Object.keys(SURFACE_LABELS) as SurfaceFeatureType[];
  return [
    ...types.map((type): Command => ({
      id: type, label: SURFACE_LABELS[type], icon: type, description: DESCRIPTIONS[type], keywords: KEYWORDS[type],
      enabled: () => !['surfaceCut', 'deleteFace'].includes(type) || !!app.bbox,
      run: start(type),
    })),
    {
      id: 'thickenCut', label: 'Thickened Cut', icon: 'thickenCut', description: 'Give a surface thickness and cut it from the part.', keywords: 'surface thicken cut remove',
      enabled: () => !!app.bbox, run: start('thicken', true),
    },
  ];
}
