// Sheet metal in the interface: the Sheet Metal tab of the CommandManager,
// PropertyManager panels for its features, the flat pattern view (with DXF
// export) and the Sheet-Metal and Flat-Pattern rows of the design tree.

import type { Vec3 } from '../math/vec';
import { add, scale } from '../math/vec';
import { Camera } from '../render/camera';
import type { EdgeRef, Feature, Id, SketchFeature } from '../model/types';
import {
  type BaseFlangeFeature, type BendAllowanceType, type EdgeFlangeFeature, type FlangeLengthRef, type FlangePosition, type HemFeature, type ReliefType,
  type SketchedBendFeature, type SketchedBendPosition, newBaseFlange, newEdgeFlange, newHem, newSketchedBend,
} from '../model/sheetmetal';
import { type FlatPattern, bendNote, flatPatternDxf, flatSize } from '../model/flat-pattern';
import { defaultName, nextName } from '../model/features';
import { buildProfiles } from '../sketch/profiles';
import type { FlatPatternResult } from '../kernel/protocol';
import { download, safeName } from '../platform/files';
import { h, nextDomId } from '../ui/dom';
import { toast } from '../ui/overlay';
import type { App } from './app';
import type { Command } from './commands';
import type { RibbonTab } from './shell';
import { FeaturePanel, featurePanelFactories, toEdge } from './panels';
import { PropertyPanel, SelectionBox, type SelBoxItem, checkbox, flipButton, fmt, numberField, section, selectField } from './pm';
import { edgeRef } from './selection';

// ---------- helpers ----------

/**
 * The Base Flange holding the part's sheet metal parameters: as in the
 * rebuild, the first one that is not suppressed and builds (else the first
 * one not suppressed, which is the one to fix). A later one is a Tab.
 */
export function sheetOwner(app: App): BaseFlangeFeature | null {
  const flanges = app.store.doc.features.filter((f): f is BaseFlangeFeature => f.type === 'baseFlange');
  const active = flanges.filter((f) => !f.suppressed && !app.featureStatus(f.id)?.suppressed);
  return active.find((f) => app.featureStatus(f.id)?.ok !== false) ?? active[0] ?? flanges[0] ?? null;
}

const hasSheetMetal = (app: App) => !!sheetOwner(app);

/**
 * A default length in millimetres that shows as a plain number in the part's
 * units (an inch value converted from millimetres showed as 0.060000000000000005).
 */
function plainLength(app: App, mm: number): number {
  const unit = app.store.unitScale;
  return Number((mm / unit).toPrecision(10)) * unit;
}

/** The sheet thickness in millimetres (1 mm, or 0.06 in, without a sheet metal part). */
function sheetThickness(app: App): number {
  const o = sheetOwner(app);
  if (!o) return app.store.doc.units === 'IPS' ? plainLength(app, 1.524) : 1;
  try { return app.store.evalParam(o.sm.thickness, 'length'); } catch { return 1; }
}

/** A plain decimal input (K-factor, ratios). */
function ratioField(label: string, value: number, opts: { min: number; max?: number }, onChange: (v: number) => void): HTMLElement {
  const id = nextDomId('ratio');
  const input = h('input', { class: 'input', id, inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', 'aria-label': label, value: String(value) }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const v = Number(input.value.trim());
    const bad = !Number.isFinite(v) || input.value.trim() === '' ? 'Enter a number' : v < opts.min ? `Must be at least ${opts.min}` : opts.max !== undefined && v > opts.max ? `Must be at most ${opts.max}` : '';
    input.classList.toggle('invalid', !!bad);
    if (bad) { input.setAttribute('aria-invalid', 'true'); input.title = bad; return; }
    input.removeAttribute('aria-invalid');
    input.title = '';
    onChange(v);
  });
  return h('div', {}, h('label', { class: 'field-label', for: id }, label), h('div', { class: 'row' }, h('div', { class: 'spin grow' }, input)));
}

function sketchOf(app: App, id: Id): SketchFeature | null {
  const f = id ? app.store.feature(id) : undefined;
  return f?.type === 'sketch' ? f : null;
}

/** The sketch a new feature uses: the selected one, else the latest one no feature uses yet. */
function pickSketch(app: App): Id | null {
  for (const it of app.selection.items) if (it.kind === 'feature' && app.store.feature(it.id)?.type === 'sketch') return it.id;
  const doc = app.store.doc;
  const used = new Set(doc.features.flatMap((f) => (f.type === 'extrude' || f.type === 'revolve' || f.type === 'hole' || f.type === 'baseFlange' || f.type === 'sketchedBend' ? [f.sketch] : f.type === 'loft' ? f.profiles : f.type === 'sweep' ? [f.profile, f.path] : [])));
  const built = doc.features.slice(0, app.store.builtCount);
  for (let i = built.length - 1; i >= 0; i--) if (built[i].type === 'sketch' && !used.has(built[i].id) && (built[i] as SketchFeature).entities.length) return built[i].id;
  return null;
}

/** Straight edges only. */
const toStraightEdge = (app: App) => (it: import('./selection').SelItem): SelBoxItem | null => {
  const r = toEdge(app)(it);
  return r && app.edges[(it as { index: number }).index]?.type === 'line' ? r : null;
};

function edgeBox(panel: PropertyPanel, app: App, f: { edges: EdgeRef[] }, onChange: () => void): SelectionBox {
  const box = new SelectionBox(panel, 'Edges', { edge: true }, toStraightEdge(app), (items) => { f.edges = items.map((i) => i.data as EdgeRef); onChange(); }, { placeholder: 'Select edges of the sheet', icon: 'edgeFlange' });
  box.setItems(f.edges.map((e) => ({ item: { kind: 'edge', index: app.edges.findIndex((x) => x.name === e.name), name: e.name }, data: e, label: e.sig?.type ? `Edge (${e.sig.type})` : 'Edge' })));
  return box;
}

// ---------- Base Flange / Tab ----------

export class BaseFlangePanel extends FeaturePanel<BaseFlangeFeature> {
  /**
   * Whether this feature holds the part's sheet metal parameters: it is the
   * active Base Flange, or one before it (failed or suppressed) that would be.
   */
  private get owner(): boolean {
    const o = sheetOwner(this.app);
    if (!o || o.id === this.f.id) return true;
    const features = this.app.store.doc.features;
    const at = features.findIndex((f) => f.id === this.f.id);
    return at >= 0 && at < features.findIndex((f) => f.id === o.id);
  }

  get title() {
    return this.editingId ? this.f.name : this.owner ? 'Base Flange' : 'Tab';
  }

  private open(): boolean {
    const sk = sketchOf(this.app, this.f.sketch);
    return !!sk && sk.entities.some((e) => e.t !== 'point' && !e.construction) && !buildProfiles(sk.entities).regions.length;
  }

  render(): HTMLElement[] {
    const f = this.f;
    const ctx = this.ctx();
    const sketch = this.sketchBox('Profile sketch', () => f.sketch, (id) => { f.sketch = id ?? ''; this.app.refreshPanel(); });
    const out: HTMLElement[] = [section('Profile', [sketch.el])];
    if (!this.owner) {
      out.push(section('Tab', [h('p', { class: 'field-label' }, 'Sketch a closed profile on a flat face of the sheet. The tab adds it in the sheet\'s thickness.')]));
      return out;
    }
    const open = this.open();
    if (open) {
      const depth = numberField({ label: 'Depth', icon: 'ruler', value: f.depth, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.depth = v; this.changed(); } });
      out.push(section('Direction 1', [
        h('div', { class: 'row' }, flipButton('Reverse direction', f.depthFlip, (v) => { f.depthFlip = v; this.changed(); }), h('div', { class: 'grow' },
          selectField('End condition', f.depthEnd, [{ value: 'blind' as const, label: 'Blind' }, { value: 'midPlane' as const, label: 'Mid Plane' }], (v) => { f.depthEnd = v; this.changed(); }))),
        depth,
      ]));
    }
    const sm = f.sm;
    const allowance = numberField({ label: sm.allowance === 'bendDeduction' ? 'Bend deduction' : 'Bend allowance', icon: 'ruler', value: sm.allowanceValue, kind: 'length', ctx, onChange: (v) => { sm.allowanceValue = v; this.changed(); } });
    allowance.hidden = sm.allowance === 'kFactor';
    const deductionNote = h('p', { class: 'field-label' }, 'Bends over 90° use the K-factor this deduction gives a 90° bend.');
    deductionNote.hidden = sm.allowance !== 'bendDeduction';
    const k = ratioField('K-factor', sm.kFactor, { min: 0, max: 1 }, (v) => { sm.kFactor = v; this.changed(); });
    k.hidden = sm.allowance !== 'kFactor';
    const ratio = ratioField('Relief ratio', sm.reliefRatio, { min: 0.05, max: 10 }, (v) => { sm.reliefRatio = v; this.changed(); });
    ratio.hidden = sm.relief === 'none';
    out.push(
      section('Sheet Metal Parameters', [
        h('div', { class: 'row' }, flipButton('Reverse thickness direction', f.flip, (v) => { f.flip = v; this.changed(); }), h('div', { class: 'grow' },
          numberField({ label: 'Thickness', icon: 'sheetThickness', value: sm.thickness, kind: 'length', ctx, min: 1e-6, onChange: (v) => { sm.thickness = v; this.changed(); } }))),
        checkbox('Mid-plane thickness', f.mid, (v) => { f.mid = v; this.changed(); }),
        numberField({ label: 'Bend radius', icon: 'bendRadius', value: sm.radius, kind: 'length', ctx, min: 0, onChange: (v) => { sm.radius = v; this.changed(); } }),
      ], { icon: 'sheetMetal' }),
      section('Bend Allowance', [
        selectField<BendAllowanceType>('Bend allowance type', sm.allowance, [
          { value: 'kFactor', label: 'K-Factor' }, { value: 'bendAllowance', label: 'Bend Allowance' }, { value: 'bendDeduction', label: 'Bend Deduction' },
        ], (v) => { sm.allowance = v; this.changed(); this.app.refreshPanel(); }),
        k, allowance, deductionNote,
      ]),
      section('Auto Relief', [
        selectField<ReliefType>('Relief type', sm.relief, [{ value: 'rectangular', label: 'Rectangular' }, { value: 'obround', label: 'Obround' }, { value: 'none', label: 'None' }], (v) => {
          sm.relief = v; ratio.hidden = v === 'none'; this.changed();
        }),
        ratio,
      ]),
    );
    return out;
  }

  protected validate() {
    return this.f.sketch ? null : 'Select a sketch for the base flange';
  }
}

// ---------- Edge Flange ----------

const POSITIONS: { value: FlangePosition; label: string }[] = [
  { value: 'materialInside', label: 'Material Inside' }, { value: 'materialOutside', label: 'Material Outside' }, { value: 'bendOutside', label: 'Bend Outside' },
];

export class EdgeFlangePanel extends FeaturePanel<EdgeFlangeFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const ctx = this.ctx();
    const box = edgeBox(this, this.app, f, () => this.changed());
    return [
      section('Flange Parameters', [box.el, h('div', { class: 'row' }, flipButton('Reverse direction', f.flip, (v) => { f.flip = v; this.changed(); }), h('span', { class: 'field-label' }, 'Reverse direction'))]),
      section('Angle', [numberField({ label: 'Flange angle', icon: 'angle', value: f.angle, kind: 'angle', ctx, min: 1e-6, max: 179.999, onChange: (v) => { f.angle = v; this.changed(); } })]),
      section('Flange Length', [
        numberField({ label: 'Length', icon: 'ruler', value: f.length, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.length = v; this.changed(); } }),
        selectField<FlangeLengthRef>('Measured from', f.lengthRef, [
          { value: 'outer', label: 'Outer Virtual Sharp' }, { value: 'inner', label: 'Inner Virtual Sharp' }, { value: 'tangent', label: 'Tangent Bend' },
        ], (v) => { f.lengthRef = v; this.changed(); }),
      ]),
      section('Flange Position', [selectField<FlangePosition>('Flange position', f.position, POSITIONS, (v) => { f.position = v; this.changed(); })]),
      section('Offsets', [
        h('p', { class: 'field-label' }, 'Stop the flange short of the ends of the edge; reliefs are cut beside its bend.'),
        numberField({ label: 'Offset 1', icon: 'ruler', value: f.offset1, kind: 'length', ctx, min: 0, onChange: (v) => { f.offset1 = v; this.changed(); } }),
        numberField({ label: 'Offset 2', icon: 'ruler', value: f.offset2, kind: 'length', ctx, min: 0, onChange: (v) => { f.offset2 = v; this.changed(); } }),
      ], { collapsed: !Number(f.offset1) && !Number(f.offset2) }),
    ];
  }

  preview() {
    return this.f.edges.length ? this.f : null;
  }

  protected validate() {
    return this.f.edges.length ? null : 'Select one or more edges of the sheet';
  }
}

// ---------- Sketched Bend ----------

export class SketchedBendPanel extends FeaturePanel<SketchedBendFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const ctx = this.ctx();
    const sketch = this.sketchBox('Bend line sketch', () => f.sketch, (id) => { f.sketch = id ?? ''; });
    return [
      section('Bend Parameters', [
        sketch.el,
        h('div', { class: 'row' }, flipButton('Reverse fixed side', f.flipFixed, (v) => { f.flipFixed = v; this.changed(); }), h('span', { class: 'field-label' }, 'Fixed side: reverse')),
        selectField<SketchedBendPosition>('Bend position', f.position, [{ value: 'centerline', label: 'Bend Centerline' }, ...POSITIONS], (v) => { f.position = v; this.changed(); }),
        h('div', { class: 'row' }, flipButton('Reverse direction', f.flip, (v) => { f.flip = v; this.changed(); }), h('div', { class: 'grow' },
          numberField({ label: 'Bend angle', icon: 'angle', value: f.angle, kind: 'angle', ctx, min: 1e-6, max: 179.999, onChange: (v) => { f.angle = v; this.changed(); } }))),
      ]),
    ];
  }

  protected validate() {
    return this.f.sketch ? null : 'Select a sketch with the bend line';
  }
}

// ---------- Hem ----------

export class HemPanel extends FeaturePanel<HemFeature> {
  render(): HTMLElement[] {
    const f = this.f;
    const ctx = this.ctx();
    const box = edgeBox(this, this.app, f, () => this.changed());
    const gap = numberField({ label: 'Gap distance', icon: 'ruler', value: f.gap, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.gap = v; this.changed(); } });
    gap.hidden = f.kind === 'closed';
    return [
      section('Edges', [box.el, h('div', { class: 'row' }, flipButton('Reverse direction', f.flip, (v) => { f.flip = v; this.changed(); }), h('span', { class: 'field-label' }, 'Reverse direction')),
        selectField<HemFeature['position']>('Position', f.position, [{ value: 'materialInside', label: 'Material Inside' }, { value: 'bendOutside', label: 'Bend Outside' }], (v) => { f.position = v; this.changed(); })]),
      section('Type and Size', [
        selectField<HemFeature['kind']>('Hem type', f.kind, [{ value: 'closed', label: 'Closed' }, { value: 'open', label: 'Open' }], (v) => { f.kind = v; gap.hidden = v === 'closed'; this.changed(); }),
        numberField({ label: 'Length', icon: 'ruler', value: f.length, kind: 'length', ctx, min: 1e-6, onChange: (v) => { f.length = v; this.changed(); } }),
        gap,
      ]),
    ];
  }

  preview() {
    return this.f.edges.length ? this.f : null;
  }

  protected validate() {
    return this.f.edges.length ? null : 'Select one or more edges of the sheet';
  }
}

export function sheetMetalPanelFor(app: App, f: Feature, editing: boolean): PropertyPanel | null {
  switch (f.type) {
    case 'baseFlange': return new BaseFlangePanel(app, f, editing);
    case 'edgeFlange': return new EdgeFlangePanel(app, f, editing);
    case 'sketchedBend': return new SketchedBendPanel(app, f, editing);
    case 'hem': return new HemPanel(app, f, editing);
    default: return null;
  }
}

featurePanelFactories.push(sheetMetalPanelFor);

// ---------- flat pattern ----------

/** Shows the part flattened in place of the folded body while it is open. */
export class FlatPatternPanel extends PropertyPanel {
  title = 'Flat Pattern';
  icon = 'flatPattern';
  confirm = false;
  closeLabel = 'Exit Flat Pattern';
  helpText = 'The part unfolded, with bend lines (dashed) and the bend notes.';
  private result: FlatPatternResult | null = null;
  private error: string | null = null;
  private seq = 0;
  private disposed = false;
  private framed = false;

  constructor(private app: App) {
    super();
    app.selection.clear();
  }

  filter() {
    return {};
  }

  mount(): HTMLElement {
    const el = super.mount();
    if (!this.result && !this.error) void this.load();
    return el;
  }

  onBuild() {
    void this.load();
  }

  private async load() {
    const seq = ++this.seq;
    let res: FlatPatternResult;
    try {
      res = await this.app.kernel.flatPattern(this.app.settings.quality);
    } catch (e) {
      res = { pattern: null, mesh: null, error: (e as Error).message };
    }
    if (this.disposed || seq !== this.seq) return;
    this.result = res;
    this.error = res.error ?? null;
    this.show();
    this.app.refreshPanel();
  }

  private show() {
    const app = this.app;
    const r = this.result;
    if (!r?.pattern || !r.mesh) { app.showModelMesh(); app.renderer.setLines('flatBends', null); return; }
    const p = r.pattern;
    app.renderer.setModel(r.mesh, Math.max(1, app.faces.length), Math.max(1, app.edges.length));
    const pos = r.mesh.positions;
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
    app.bbox = { min, max };
    // Bend centre lines on the top face of the flat pattern, dashed: green up, blue down.
    const xf = p.placement;
    const at = (q: [number, number]): Vec3 => add(add(add(xf.o, scale(xf.x, q[0])), scale(xf.y, q[1])), scale(xf.n, p.thickness * 1.001));
    const lines: number[] = [];
    const colors: number[] = [];
    for (const b of p.bends) {
      lines.push(...at(b.a), ...at(b.b));
      colors.push(...(b.up ? [40, 150, 60, 255] : [40, 90, 200, 255]));
    }
    app.renderer.setLines('flatBends', lines.length ? { positions: new Float32Array(lines), colors: new Uint8Array(colors), width: 1.6, depth: 'always', dash: 6, order: 6 } : null);
    if (!this.framed) {
      this.framed = true;
      const cam = app.renderer.camera;
      const center = scale(add(min, max), 0.5);
      const radius = Math.max(1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
      cam.animateTo(cam.fitState(center, radius, Camera.normalTo(xf.n, xf.x)));
    }
    app.renderer.requestRender();
  }

  render(): HTMLElement[] {
    const app = this.app;
    const ctx = app.unitContext();
    const r = this.result;
    if (!r) return [section('Flat Pattern', [h('p', { class: 'field-label' }, 'Flattening the part...')])];
    if (!r.pattern) return [section('Flat Pattern', [h('p', { class: 'pm-msg error', role: 'alert' }, r.error ?? 'The part cannot be flattened')])];
    const p = r.pattern;
    const [w, ht] = flatSize(p);
    const len = (v: number) => `${fmt(v, 'length', ctx)}`;
    const notes = p.notes.length ? p.notes : ['Holes and cuts through flat regions are shown.'];
    return [
      section('Flat Pattern', [
        h('table', { class: 'table flat-size' }, h('tbody', {},
          h('tr', {}, h('th', {}, 'Overall size'), h('td', { class: 'num' }, `${len(w)} × ${len(ht)}`)),
          h('tr', {}, h('th', {}, 'Thickness'), h('td', { class: 'num' }, len(p.thickness))),
          h('tr', {}, h('th', {}, 'Bends'), h('td', { class: 'num' }, String(p.bends.length))))),
        h('button', { class: 'btn small', type: 'button', onclick: () => exportDxf(app, p) }, 'Export DXF...'),
      ], { icon: 'flatPattern' }),
      ...(p.bends.length ? [section('Bend Notes', [
        h('table', { class: 'table flat-bends' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Bend'), h('th', {}, 'Note'), h('th', {}, 'Allowance'))),
          h('tbody', {}, p.bends.map((b, i) => h('tr', {}, h('td', {}, `${app.store.feature(b.feature)?.name ?? 'Bend'} (${i + 1})`), h('td', {}, bendNote(b, (v) => fmt(v, 'length', ctx))), h('td', { class: 'num' }, len(b.allowance)))))),
      ])] : []),
      section('Notes', notes.map((n) => h('p', { class: p.notes.length ? 'pm-msg warn' : 'field-label', role: 'note' }, n))),
    ];
  }

  ok() { return true; }

  dispose() {
    this.disposed = true;
    this.app.renderer.setLines('flatBends', null);
    this.app.showModelMesh();
  }
}

function exportDxf(app: App, p: FlatPattern) {
  download(flatPatternDxf(p), `${safeName(app.store.doc.name)}-flat.dxf`, 'application/dxf');
  toast({ kind: 'success', message: 'Flat pattern exported as DXF' });
}

async function exportFlatDxf(app: App) {
  try {
    const res = await app.kernel.flatPattern(0);
    if (!res.pattern) { toast({ kind: 'error', title: 'Export DXF', message: res.error ?? 'The part cannot be flattened' }); return; }
    exportDxf(app, res.pattern);
  } catch (e) {
    toast({ kind: 'error', title: 'Export DXF', message: (e as Error).message });
  }
}

// ---------- commands ----------

function startFeature(app: App, type: 'baseFlange' | 'edgeFlange' | 'sketchedBend' | 'hem') {
  const doc = app.store.doc;
  const id = app.store.nextId('f');
  const T = sheetThickness(app);
  const edges = app.selection.ofKind('edge').map((s) => app.edges[s.index]).filter((e) => e?.type === 'line').map(edgeRef);
  let f: Feature;
  switch (type) {
    case 'baseFlange': {
      const tab = hasSheetMetal(app);
      f = newBaseFlange(id, tab ? nextName(doc, 'Tab') : defaultName(doc, 'baseFlange'), pickSketch(app) ?? '', T, Math.max(app.typicalSize(), doc.units === 'IPS' ? 12.7 : 10));
      break;
    }
    case 'edgeFlange': f = { ...newEdgeFlange(id, defaultName(doc, 'edgeFlange'), plainLength(app, Math.max(10 * T, app.typicalSize() / 4))), edges }; break;
    case 'sketchedBend': f = newSketchedBend(id, defaultName(doc, 'sketchedBend'), pickSketch(app) ?? ''); break;
    case 'hem': f = { ...newHem(id, defaultName(doc, 'hem'), plainLength(app, 5 * T), plainLength(app, T / 2)), edges }; break;
  }
  const p = sheetMetalPanelFor(app, f, false);
  if (p) void app.openPanel(p);
}

/** The sheet metal commands (ids are the feature types, as other features' are). */
export function sheetMetalCommands(app: App): Command[] {
  const needsSheet = () => hasSheetMetal(app) && !!app.bbox;
  const sketchFirst = (type: 'baseFlange' | 'sketchedBend') => () => {
    if (app.sketchEditor) {
      const id = app.sketchEditor.sketchId;
      app.exitSketch(true);
      app.selection.set([{ kind: 'feature', id }]);
    }
    if (!pickSketch(app)) {
      // No sketch yet: draw one, then carry on with this command.
      app.pendingAfterSketch = type;
      void app.commands.run('sketch');
      return;
    }
    startFeature(app, type);
  };
  return [
    {
      id: 'baseFlange', label: 'Base Flange/Tab', icon: 'baseFlange', keywords: 'sheet metal plate tab thickness bend',
      description: 'Make a sheet metal part from a sketch: a closed profile gives a flat plate, an open one a bent profile. In a sheet metal part, adds a tab on a face.',
      run: sketchFirst('baseFlange'),
    },
    {
      id: 'edgeFlange', label: 'Edge Flange', icon: 'edgeFlange', keywords: 'sheet metal flange bend wall', enabled: needsSheet,
      description: 'Add a bent wall along edges of the sheet.', run: () => startFeature(app, 'edgeFlange'),
    },
    {
      id: 'sketchedBend', label: 'Sketched Bend', icon: 'sketchedBend', keywords: 'sheet metal bend line fold', enabled: needsSheet,
      description: 'Bend the sheet along a line sketched on a flat face.', run: sketchFirst('sketchedBend'),
    },
    {
      id: 'hem', label: 'Hem', icon: 'hem', keywords: 'sheet metal fold back edge', enabled: needsSheet,
      description: 'Fold an edge of the sheet back over itself.', run: () => startFeature(app, 'hem'),
    },
    {
      id: 'flatten', label: 'Flatten', icon: 'flatPattern', keywords: 'sheet metal flat pattern unfold blank', enabled: needsSheet,
      description: 'Show the sheet metal part unfolded, with bend lines and notes.',
      checked: () => app.panel instanceof FlatPatternPanel,
      run: () => {
        if (app.panel instanceof FlatPatternPanel) { void app.closePanel(false); return; }
        app.exitModes();
        void app.openPanel(new FlatPatternPanel(app));
      },
    },
    {
      id: 'exportFlatDxf', label: 'Export DXF', icon: 'export', keywords: 'sheet metal flat pattern dxf laser cut', enabled: needsSheet,
      description: 'Export the flat pattern as a DXF file for cutting.', run: () => { void exportFlatDxf(app); },
    },
    {
      id: 'sheetMetalParameters', label: 'Sheet Metal Parameters', icon: 'sheetMetal', keywords: 'thickness bend radius k-factor', enabled: () => hasSheetMetal(app),
      description: 'Thickness, bend radius, bend allowance and reliefs of the part.', run: () => { const o = sheetOwner(app); if (o) app.editFeature(o.id); },
    },
  ];
}

export const SHEET_METAL_TAB: RibbonTab = {
  id: 'sheetMetal', label: 'Sheet Metal',
  groups: [
    [{ cmd: 'baseFlange' }, { cmd: 'edgeFlange' }, { stack: [{ cmd: 'sketchedBend' }, { cmd: 'hem' }] }],
    [{ cmd: 'flatten' }, { cmd: 'exportFlatDxf' }],
    [{ cmd: 'extrudeCut' }, { cmd: 'sheetMetalParameters' }],
  ],
};

/** Design tree rows of a sheet metal part: its parameters and the flat pattern. */
export function sheetMetalTreeRows(app: App): { key: string; item: null; label: string; icon: string; depth: number; action: () => void }[] {
  const o = sheetOwner(app);
  if (!o) return [];
  return [
    { key: 'sheetMetal', item: null, label: 'Sheet-Metal', icon: 'sheetMetal', depth: 1, action: () => app.editFeature(o.id) },
    { key: 'flatPattern', item: null, label: 'Flat-Pattern', icon: 'flatPattern', depth: 1, action: () => app.commands.run('flatten') },
  ];
}

