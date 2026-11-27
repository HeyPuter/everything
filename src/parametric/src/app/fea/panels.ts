// PropertyManager panels of the analysis: the study (name, material, mesh),
// fixtures, loads, and the results with their plots, probe and summary.

import type { FieldName } from '../../fea/results';
import type { Vec3 } from '../../fea/static';
import { FIXTURE_ICONS, FIXTURE_LABELS, GRAVITY, LOAD_ICONS, LOAD_LABELS, feaUnits, type FeaDir, type FeaFixture, type FeaLoad, type FixtureType } from '../../model/fea';
import { elasticOf } from '../../model/materials';
import type { FaceRef } from '../../model/types';
import { formatNumber } from '../../model/units';
import { h, nextDomId } from '../../ui/dom';
import { icon } from '../../ui/icons';
import type { App } from '../app';
import { PropertyPanel, type SelBoxItem, SelectionBox, checkbox, section, segmented, selectField } from '../pm';
import { edgeRef, faceRef, type SelItem } from '../selection';
import { faceIndexOf } from './index';
import { FIELD_LABELS, ResultPlot, fieldKind, formatValue } from './plot';
import type { FeaWorkspace } from './workspace';

/** A number in a unit of its own (force, pressure, acceleration), stored in the base unit (value times scale). */
function valueField(label: string, value: number, unit: string, scale: number, onChange: (v: number) => void, opts: { positive?: boolean } = {}): HTMLElement {
  const id = nextDomId('fea');
  const show = (v: number) => Number((v / scale).toPrecision(8)).toString();
  const input = h('input', { class: 'input', id, inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', 'aria-label': `${label} (${unit})`, value: show(value) }) as HTMLInputElement;
  const commit = () => {
    const t = input.value.trim();
    const v = Number(t);
    const bad = !t || !Number.isFinite(v) ? 'Enter a number' : opts.positive && !(v > 0) ? 'Must be greater than 0' : '';
    input.classList.toggle('invalid', !!bad);
    if (bad) { input.setAttribute('aria-invalid', 'true'); input.title = bad; return; }
    input.removeAttribute('aria-invalid');
    input.title = '';
    onChange(v * scale);
  };
  input.addEventListener('input', commit);
  input.addEventListener('change', commit);
  return h('div', {}, h('label', { class: 'field-label', for: id }, `${label} (${unit})`), input);
}

abstract class FeaPanel extends PropertyPanel {
  readonly feaPanel = true;
  constructor(readonly app: App, readonly ws: FeaWorkspace) { super(); }

  protected faceItems(refs: FaceRef[]): SelBoxItem[] {
    return refs.map((r) => {
      const i = faceIndexOf(this.app, r);
      const item: SelItem | null = i >= 0 ? { kind: 'face', index: i, name: this.app.faces[i].name } : null;
      return { item, data: r, label: item ? this.app.describe(item) : `${r.name} (missing)` };
    });
  }

  protected toFace(it: SelItem, type?: string): SelBoxItem | null {
    if (it.kind !== 'face') return null;
    const f = this.app.faces[it.index];
    if (!f || f.body) { this.setMessage('warn', 'Pick faces of the solid.'); return null; }
    if (type && f.type !== type) { this.setMessage('warn', type === 'cylinder' ? 'Pick cylindrical faces (a pin hole or a shaft).' : 'Pick flat faces.'); return null; }
    this.setMessage(null);
    return { item: it, data: faceRef(f), label: this.app.describe(it) };
  }

  dispose() {
    this.ws.redraw();
  }
}

// ---------- study and mesh ----------

export class StudyPanel extends FeaPanel {
  title = 'Static Study';
  icon = 'feaStudy';
  confirm = false;
  private name: string;
  private fineness: number;

  constructor(app: App, ws: FeaWorkspace) {
    super(app, ws);
    const s = ws.study!;
    this.name = s.name;
    this.fineness = s.mesh.fineness;
  }

  /** Shows the progress (the status bar announces it); false when the panel has no progress bar yet (it is drawn again). */
  progress(b: { stage: string; progress: number }): boolean {
    const bar = this.el.querySelector<HTMLProgressElement>('progress');
    const label = this.el.querySelector<HTMLElement>('.fea-stage');
    if (bar) bar.value = b.progress;
    if (label) label.textContent = b.stage;
    return !!bar;
  }

  private commit() {
    const name = this.name.trim();
    this.app.store.change('Edit study', (d) => {
      if (!d.study) return;
      if (name) d.study.name = name;
      d.study.mesh.fineness = this.fineness;
    });
  }

  render(): HTMLElement[] {
    const app = this.app, ws = this.ws;
    const s = ws.study;
    if (!s) return [section('Study', [h('p', { class: 'pm-msg' }, 'The study was deleted.')])];
    const nameInput = h('input', { class: 'input', value: this.name, 'aria-label': 'Study name' }) as HTMLInputElement;
    // Taken after the focus moved on (Tab): the panel is drawn again then, and the focus stays where it went.
    nameInput.addEventListener('change', () => {
      // A study keeps a name: an emptied field shows it again.
      if (!nameInput.value.trim()) nameInput.value = s.name;
      this.name = nameInput.value;
      setTimeout(() => this.commit());
    });
    const mat = app.store.doc.material;
    const el = elasticOf(mat);
    // In the part's stress unit, as the results are (psi in an inch part).
    const su = feaUnits(app.store.doc.units);
    const psi = (v: number) => `${Number((v / su.stressScale).toPrecision(3)).toLocaleString('en-US')} ${su.stress}`;
    const elText = (e: NonNullable<typeof el>) => (su.stressScale === 1 ? `E ${formatNumber(e.E / 1000, 1)} GPa, ν ${e.nu}, yield ${e.yield} MPa` : `E ${psi(e.E)}, ν ${e.nu}, yield ${psi(e.yield)}`);
    const matText = !mat ? 'No material chosen.' : el ? `${mat.name}: ${elText(el)}` : `${mat.name}: no elastic properties (cannot be analyzed).`;
    const matBtn = h('button', { class: 'btn small', type: 'button', onclick: () => app.commands.run('material') }, icon('material', 16), 'Material...');
    // Mesh: coarse to fine.
    const u = feaUnits(app.store.doc.units);
    const slider = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(this.fineness), 'aria-label': 'Mesh density, coarse to fine', class: 'fea-slider' }) as HTMLInputElement;
    const sizeText = h('div', { class: 'field-label', 'aria-live': 'polite' });
    const describe = () => {
      const z = ws.sizes(this.fineness);
      sizeText.textContent = z ? `Element size ${formatNumber(z.size / u.lengthScale, app.store.doc.decimals)} ${u.length} (automatic ${formatNumber(z.auto / u.lengthScale, app.store.doc.decimals)}), about ${z.dofs.toLocaleString('en-US')} unknowns` : 'Element size: found when the part is first meshed.';
    };
    describe();
    slider.addEventListener('input', () => { this.fineness = Number(slider.value); describe(); });
    slider.addEventListener('change', () => this.commit());
    const meshBtn = h('button', { class: 'btn small', type: 'button', disabled: !!ws.busy, onclick: () => void ws.meshNow() }, icon('feaMesh', 16), 'Mesh Now');
    const runBtn = h('button', { class: 'btn small primary', type: 'button', disabled: !!ws.busy, onclick: () => void ws.run() }, icon('feaRun', 16), 'Run');
    const m = ws.mesh;
    const stats: HTMLElement[] = [];
    if (ws.busy) stats.push(h('p', { class: 'field-label fea-stage' }, ws.busy.stage), h('progress', { max: '1', value: String(ws.busy.progress), 'aria-label': 'Progress' }), h('button', { class: 'btn small', type: 'button', onclick: () => ws.cancel() }, 'Cancel'));
    if (m) {
      const st = m.info.stats;
      const volErr = (st.volume / st.surfaceVolume - 1) * 100;
      stats.push(h('table', { class: 'table fea-stats' }, h('tbody', {},
        ...([
          ['Elements', st.elements.toLocaleString('en-US')], ['Nodes', st.nodes.toLocaleString('en-US')],
          ['Element size', `${formatNumber(st.size / u.lengthScale, app.store.doc.decimals)} ${u.length}`],
          ['Quality (worst / mean)', `${st.minQuality.toFixed(2)} / ${st.meanQuality.toFixed(2)}`],
          ['Dihedral angles', `${st.minDihedral.toFixed(1)}° to ${st.maxDihedral.toFixed(1)}°`],
          ['Volume against the part', `${volErr >= 0 ? '+' : ''}${volErr.toFixed(2)}%`],
        ] as [string, string][]).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', { class: 'num' }, v))))));
      if (Math.abs(volErr) > 2) stats.push(h('p', { class: 'pm-msg warn', role: 'note' }, 'The mesh misses part of the volume: some walls are thinner than the elements. Use a finer mesh.'));
      if (!ws.meshCurrent()) stats.push(h('p', { class: 'pm-msg warn', role: 'note' }, 'The part changed since it was meshed.'));
    }
    if (ws.error?.message && !ws.busy) stats.push(h('p', { class: 'pm-msg error', role: 'alert' }, ws.error.message));
    return [
      section('Study', [h('label', { class: 'field-label' }, 'Name'), nameInput, h('p', { class: 'field-label' }, 'Linear static: small displacements, linear elastic isotropic material.')], { icon: 'feaStudy' }),
      section('Material', [h('p', { class: 'field-label fea-material' }, matText), matBtn], { icon: 'material' }),
      section('Mesh', [h('div', { class: 'row fea-slider-row' }, h('span', { class: 'field-label' }, 'Coarse'), slider, h('span', { class: 'field-label' }, 'Fine')), sizeText, h('div', { class: 'row' }, meshBtn, runBtn), ...stats], { icon: 'feaMesh' }),
      section('Delete', [h('button', { class: 'btn small danger', type: 'button', onclick: () => ws.deleteStudy() }, icon('trash', 16), 'Delete Study')], { collapsed: true }),
    ];
  }

  ok() { return true; }

  dispose() {
    super.dispose();
    this.app.renderer.setLines('feaMesh', null);
  }
}

// ---------- fixtures ----------

export class FixturePanel extends FeaPanel {
  title: string;
  icon: string;

  constructor(app: App, ws: FeaWorkspace, private f: FeaFixture, private creating: boolean) {
    super(app, ws);
    this.title = creating ? FIXTURE_LABELS[f.type] : f.name;
    this.icon = FIXTURE_ICONS[f.type];
  }

  get present(): boolean {
    return !!this.ws.study && (this.creating || this.ws.study.fixtures.some((x) => x.id === this.f.id));
  }

  get edited() { return true; }

  render(): HTMLElement[] {
    const f = this.f;
    const type = segmented<FixtureType>('Fixture type', f.type, (['fixed', 'roller', 'hinge'] as FixtureType[]).map((t) => ({ value: t, label: FIXTURE_LABELS[t] })), (t) => {
      f.type = t;
      if (t === 'hinge') f.faces = f.faces.filter((r) => r.sig.type === 'cylinder');
      this.app.refreshPanel();
    });
    const help = f.type === 'fixed' ? 'The faces cannot move in any direction.' : f.type === 'roller' ? 'The faces can slide along themselves but not move off them (no motion normal to the face): also a symmetry plane.' : 'The cylindrical faces can only turn about their axis (a pin): no radial or axial motion.';
    const box = new SelectionBox(this, 'Faces', { face: true }, (it) => this.toFace(it, f.type === 'hinge' ? 'cylinder' : undefined), (items) => { f.faces = items.map((i) => i.data as FaceRef); }, { placeholder: 'Pick the faces to hold', icon: FIXTURE_ICONS[f.type] });
    box.setItems(this.faceItems(f.faces));
    return [section('Type', [type, h('p', { class: 'field-label' }, help)], { icon: FIXTURE_ICONS[f.type] }), section('Faces', [box.el])];
  }

  ok(): boolean {
    const f = this.f;
    if (!f.faces.length) { this.setMessage('error', 'Pick at least one face.'); return false; }
    const label = this.creating ? `Add ${f.name}` : `Edit ${f.name}`;
    this.app.store.change(label, (d) => {
      if (!d.study) return;
      const i = d.study.fixtures.findIndex((x) => x.id === f.id);
      if (i >= 0) d.study.fixtures[i] = structuredClone(f);
      else d.study.fixtures.push(structuredClone(f));
    });
    return true;
  }
}

// ---------- loads ----------

type DirChoice = 'normal' | 'x' | 'y' | 'z' | 'ref';

export class LoadPanel extends FeaPanel {
  title: string;
  icon: string;
  private refItems: SelBoxItem[] = [];

  constructor(app: App, ws: FeaWorkspace, private l: FeaLoad, private creating: boolean) {
    super(app, ws);
    this.title = creating ? LOAD_LABELS[l.type] : l.name;
    this.icon = LOAD_ICONS[l.type];
    if ((l.type === 'force' || l.type === 'gravity') && l.dir && l.dir.kind !== 'base') this.refItems = this.dirItems(l.dir);
  }

  get present(): boolean {
    return !!this.ws.study && (this.creating || this.ws.study.loads.some((x) => x.id === this.l.id));
  }

  get edited() { return true; }

  private dirItems(d: FeaDir): SelBoxItem[] {
    if (d.kind === 'face') return this.faceItems([d.face]).map((x) => ({ ...x, data: d }));
    if (d.kind === 'edge') {
      const i = this.app.edges.findIndex((e) => e.name === d.edge.name);
      const item: SelItem | null = i >= 0 ? { kind: 'edge', index: i, name: d.edge.name } : null;
      return [{ item, data: d, label: item ? this.app.describe(item) : `${d.edge.name} (missing)` }];
    }
    return [];
  }

  private toDir(it: SelItem): SelBoxItem | null {
    if (it.kind === 'face') {
      const f = this.app.faces[it.index];
      if (!f || !(f.normal || f.axis)) { this.setMessage('warn', 'Pick a flat face (its normal) or a cylindrical face (its axis), or a straight edge.'); return null; }
      return { item: it, data: { kind: 'face', face: faceRef(f) } satisfies FeaDir, label: this.app.describe(it) };
    }
    if (it.kind === 'edge') {
      const e = this.app.edges[it.index];
      if (!e || !(e.dir || e.axis)) { this.setMessage('warn', 'Pick a straight edge (its direction) or a circular edge (its axis).'); return null; }
      return { item: it, data: { kind: 'edge', edge: edgeRef(e) } satisfies FeaDir, label: this.app.describe(it) };
    }
    return null;
  }

  render(): HTMLElement[] {
    const l = this.l, app = this.app;
    const u = feaUnits(app.store.doc.units);
    const out: HTMLElement[] = [];
    if (l.type !== 'gravity') {
      const box = new SelectionBox(this, 'Faces', { face: true }, (it) => this.toFace(it), (items) => { l.faces = items.map((i) => i.data as FaceRef); }, { placeholder: 'Pick the faces it acts on', icon: LOAD_ICONS[l.type] });
      box.setItems(this.faceItems(l.faces));
      out.push(section('Faces', [box.el], { icon: LOAD_ICONS[l.type] }));
    }
    const value = l.type === 'force' ? valueField('Total force', l.value, u.force, u.forceScale, (v) => { l.value = v; }, { positive: true })
      : l.type === 'pressure' ? valueField('Pressure', l.value, u.stress, u.stressScale, (v) => { l.value = v; }, { positive: true })
      : valueField('Acceleration', l.value, u.accel, u.accelScale, (v) => { l.value = v; }, { positive: true });
    const items: HTMLElement[] = [value];
    if (l.type === 'force' || l.type === 'gravity') {
      const choice: DirChoice = this.pickRef ? 'ref' : !l.dir ? 'normal' : l.dir.kind === 'base' ? l.dir.axis : 'ref';
      const options: { value: DirChoice; label: string }[] = [
        ...(l.type === 'force' ? [{ value: 'normal' as DirChoice, label: 'Normal to the faces' }] : []),
        { value: 'x', label: 'Along X' }, { value: 'y', label: 'Along Y' }, { value: 'z', label: 'Along Z' },
        { value: 'ref', label: 'Along a picked edge or face' },
      ];
      items.push(selectField<DirChoice>('Direction', choice, options, (v) => {
        if (v === 'normal' && l.type === 'force') l.dir = null;
        else if (v === 'x' || v === 'y' || v === 'z') l.dir = { kind: 'base', axis: v };
        else if (v === 'ref') l.dir = (this.refItems[0]?.data as FeaDir | undefined) ?? (l.type === 'force' ? null : l.dir);
        // Picking a reference: the choice stays shown while the direction is not picked yet.
        this.pickRef = v === 'ref' && !this.refItems.length;
        app.refreshPanel();
      }));
      if (choice === 'ref') {
        const ref = new SelectionBox(this, 'Direction reference', { face: true, edge: true }, (it) => this.toDir(it), (sel) => {
          this.refItems = sel;
          if (sel[0]) l.dir = sel[0].data as FeaDir;
          else this.pickRef = true;
        }, { single: true, placeholder: 'Pick an edge or a face', icon: 'axis' });
        ref.setItems(this.refItems);
        items.push(ref.el);
        queueMicrotask(() => this.activate(ref));
      }
    }
    items.push(checkbox(l.type === 'gravity' ? 'Reverse direction' : l.type === 'pressure' ? 'Reverse direction (pull on the faces)' : 'Reverse direction', l.flip, (v) => { l.flip = v; this.ws.redraw(); }));
    const help = l.type === 'force' ? (l.dir ? 'The total force is spread evenly over the faces\' area.' : 'Normal to the faces, pressing on them: spread as a pressure (on a curved face the pieces point different ways).')
      : l.type === 'pressure' ? 'Pushes into the faces, normal to them everywhere.' : `The part's weight from its density, along the direction (${(GRAVITY / u.accelScale).toFixed(u.accel === 'm/s²' ? 3 : 1)} ${u.accel} is standard gravity).`;
    out.push(section('Value', [...items, h('p', { class: 'field-label' }, help)], { icon: LOAD_ICONS[l.type] }));
    return out;
  }

  private pickRef = false;

  ok(): boolean {
    const l = this.l;
    if (l.type !== 'gravity' && !l.faces.length) { this.setMessage('error', 'Pick at least one face.'); return false; }
    if (!(l.value > 0) || !Number.isFinite(l.value)) { this.setMessage('error', 'Enter a value greater than 0.'); return false; }
    if (this.pickRef && (l.type === 'force' || l.type === 'gravity') && !this.refItems.length) { this.setMessage('error', 'Pick an edge or face for the direction.'); return false; }
    this.app.store.change(this.creating ? `Add ${l.name}` : `Edit ${l.name}`, (d) => {
      if (!d.study) return;
      const i = d.study.loads.findIndex((x) => x.id === l.id);
      if (i >= 0) d.study.loads[i] = structuredClone(l);
      else d.study.loads.push(structuredClone(l));
    });
    return true;
  }
}

// ---------- results ----------

const FIELDS: FieldName[] = ['vonMises', 'p1', 'p2', 'p3', 'disp', 'ux', 'uy', 'uz', 'strain', 'fos'];

export class ResultsPanel extends FeaPanel {
  title = 'Results';
  icon = 'feaResults';
  confirm = false;
  private plot: ResultPlot | null = null;
  private plotted: unknown = null;
  private field: FieldName = 'vonMises';

  /** Shows the progress (the status bar announces it); false when the panel has no progress bar yet (it is drawn again). */
  progress(b: { stage: string; progress: number }): boolean {
    const bar = this.el.querySelector<HTMLProgressElement>('progress');
    const label = this.el.querySelector<HTMLElement>('.fea-stage');
    if (bar) bar.value = b.progress;
    if (label) label.textContent = b.stage;
    return !!bar;
  }

  render(): HTMLElement[] {
    const app = this.app, ws = this.ws;
    if (ws.busy) {
      return [section('Running', [
        h('p', { class: 'field-label fea-stage' }, ws.busy.stage),
        h('progress', { max: '1', value: String(ws.busy.progress), 'aria-label': 'Analysis progress' }),
        h('button', { class: 'btn small', type: 'button', onclick: () => ws.cancel() }, 'Cancel'),
      ], { icon: 'feaRun' })];
    }
    const res = ws.result;
    const err = ws.error;
    const msgs: HTMLElement[] = [];
    if (err) msgs.push(h('p', { class: 'pm-msg error', role: 'alert' }, err.message));
    if (!res) {
      this.disposePlot();
      return [section('Results', [...msgs, h('p', { class: 'field-label' }, 'Run the study to see its results.'), h('button', { class: 'btn small primary', type: 'button', onclick: () => void ws.run() }, icon('feaRun', 16), 'Run')], { icon: 'feaResults' })];
    }
    const s = res.sol.summary;
    for (const w of s.warnings ?? []) msgs.push(h('p', { class: 'pm-msg warn', role: 'note' }, w));
    if (ws.state() === 'stale') msgs.push(h('p', { class: 'pm-msg warn', role: 'note' }, 'Out of date: the part, the study or the material changed since it was run.'), h('button', { class: 'btn small', type: 'button', onclick: () => void ws.run() }, icon('feaRun', 16), 'Run Again'));
    if (s.maxVonMises.value > res.yield) msgs.push(h('p', { class: 'pm-msg error', role: 'alert' }, `The highest von Mises stress (${formatValue(app, s.maxVonMises.value, 'stress')}) is above the yield strength of ${res.material} (${formatValue(app, res.yield, 'stress')}): the part would yield there, and a linear analysis no longer describes it.`));
    const b = app.bbox;
    const size = b ? Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) : 0;
    if (size && s.maxDisplacement.value > 0.05 * size) msgs.push(h('p', { class: 'pm-msg warn', role: 'note' }, 'The part moves by more than 5% of its size: a linear (small displacement) analysis may not describe it well.'));
    // The plot.
    if (!this.plot) {
      this.plot = new ResultPlot(app, res.mesh, res.sol, res.yield);
      this.plot.onProbe = () => this.drawProbes();
      this.plotted = res;
      this.ws.plotting = true;
      const plot = this.plot;
      this.ws.plotCaption = () => plot.caption();
      this.ws.redraw();
      this.plot.field = this.field;
      this.plot.draw();
    } else if (this.plotted !== res) {
      this.plotted = res;
      this.plot.setResult(res.mesh, res.sol, res.yield);
    }
    const plot = this.plot;
    const field = selectField<FieldName>('Plot', plot.field, FIELDS.map((f) => ({ value: f, label: FIELD_LABELS[f] })), (v) => { plot.field = this.field = v; plot.draw(); this.drawProbes(); });
    const deform = selectField<'auto' | 'true' | 'none'>('Deformed shape', plot.deform, [{ value: 'auto', label: 'Deformed (automatic scale)' }, { value: 'true', label: 'Deformed (true scale)' }, { value: 'none', label: 'Undeformed' }], (v) => { plot.deform = v; plot.draw(); });
    const mesh = checkbox('Show the mesh', plot.showMesh, (v) => { plot.showMesh = v; plot.draw(); });
    const probe = h('button', { class: 'btn small', type: 'button', 'aria-pressed': String(plot.probing) }, icon('feaProbe', 16), 'Probe') as HTMLButtonElement;
    probe.addEventListener('click', () => { plot.setProbing(!plot.probing); probe.setAttribute('aria-pressed', String(plot.probing)); this.drawProbes(); });
    const clear = h('button', { class: 'btn small', type: 'button', onclick: () => { plot.probes = []; plot.draw(); this.drawProbes(); } }, 'Clear');
    this.probeList = h('div', { class: 'fea-probes', 'aria-live': 'polite' });
    queueMicrotask(() => this.drawProbes());
    const rows: [string, string][] = [
      ['Max von Mises stress', formatValue(app, s.maxVonMises.value, 'stress')],
      ['  at', this.point(s.maxVonMises.at)],
      ['Yield strength', `${formatValue(app, res.yield, 'stress')} (${res.material})`],
      ['Min factor of safety', s.maxVonMises.value > 0 ? (res.yield / s.maxVonMises.value).toFixed(2) : '∞'],
      ['Max displacement', formatValue(app, s.maxDisplacement.value, 'length')],
      ['  at', this.point(s.maxDisplacement.at)],
      ['Max principal stress', formatValue(app, s.maxP1.value, 'stress')],
      ['Min principal stress', formatValue(app, s.minP3.value, 'stress')],
      ['Max equivalent strain', s.maxStrain.value.toExponential(3)],
    ];
    const u = feaUnits(app.store.doc.units);
    const force = (v: Vec3) => `${v.map((x) => formatNumber(x / u.forceScale, 3)).join(', ')} ${u.force}`;
    const total = s.reactions.reduce<Vec3>((a, r) => [a[0] + r[0], a[1] + r[1], a[2] + r[2]], [0, 0, 0]);
    const imbalance = Math.hypot(total[0] + s.applied[0], total[1] + s.applied[1], total[2] + s.applied[2]) / Math.max(Math.hypot(...s.applied), 1e-30);
    const forces: [string, string][] = [
      ['Applied loads (sum)', force(s.applied)],
      ...res.fixtureNames.map((n, i) => [`Reaction: ${n}`, force(s.reactions[i])] as [string, string]),
      ['Reactions (sum)', force(total)],
      ['Equilibrium error', `${(imbalance * 100).toExponential(1)}%`],
    ];
    const st = res.mesh.stats;
    const solve: [string, string][] = [
      ['Mesh', `${st.elements.toLocaleString('en-US')} elements, ${st.nodes.toLocaleString('en-US')} nodes`],
      ['Unknowns', s.dofs.toLocaleString('en-US')],
      ['Element quality (worst)', st.minQuality.toFixed(2)],
      ['Solver', `${s.iterations} iterations, ${((s.ms.assemble + s.ms.setup + s.ms.solve + s.ms.stress) / 1000).toFixed(1)} s`],
    ];
    const table = (r: [string, string][], cls: string) => h('table', { class: `table ${cls}` }, h('tbody', {}, ...r.map(([k, v]) => h('tr', {}, h('th', {}, k.trim()), h('td', { class: 'num' }, v)))));
    return [
      ...(msgs.length ? [section('Messages', msgs)] : []),
      section('Plot', [field, deform, mesh, h('div', { class: 'row' }, probe, clear), this.probeList], { icon: 'feaResults' }),
      section('Summary', [table(rows, 'fea-summary')], { icon: 'feaStudy' }),
      section('Forces', [table(forces, 'fea-forces')], { collapsed: false }),
      section('Mesh and solver', [table(solve, 'fea-solve')], { collapsed: true }),
      section('Export', [h('div', { class: 'row' }, h('button', { class: 'btn small', type: 'button', onclick: () => ws.report() }, icon('feaReport', 16), 'Report...'))]),
    ];
  }

  private probeList: HTMLElement | null = null;

  private point(p: Vec3): string {
    const u = feaUnits(this.app.store.doc.units);
    return `(${p.map((x) => formatNumber(x / u.lengthScale, this.app.store.doc.decimals)).join(', ')}) ${u.length}`;
  }

  private drawProbes() {
    const list = this.probeList, plot = this.plot;
    if (!list || !plot) return;
    list.textContent = '';
    if (plot.probing && !plot.probes.length) list.append(h('p', { class: 'field-label' }, 'Click the plot to read the value there.'));
    const kind = fieldKind(plot.field);
    plot.probes.forEach((p, i) => list.append(h('div', { class: 'fea-probe' }, h('b', {}, `${i + 1}`), h('span', {}, formatValue(this.app, p.value, kind)), h('span', { class: 'field-label' }, this.point(plot.probePoint(p))))));
  }

  private disposePlot() {
    if (!this.plot) return;
    this.plot.dispose();
    this.plot = null;
    this.ws.plotting = false;
    this.ws.plotCaption = null;
    this.ws.redraw();
  }

  ok() { return true; }

  dispose() {
    this.disposePlot();
    super.dispose();
  }
}
