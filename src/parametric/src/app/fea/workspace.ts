// The stress analysis of the open part: the boundary triangulation from the
// geometry kernel, the mesh and the solution from the analysis worker (kept
// until the part, the study or the material changes, then marked out of
// date), the study's symbols in the graphics area, and the result plots.
// Loaded the first time an analysis command runs.

import { FeaCancelled, FeaClient } from '../../fea/client';
import type { FeaMeshInfo, FeaSolution } from '../../fea/results';
import type { FixtureInput, LoadInput, StaticInput, Vec3 } from '../../fea/static';
import { defaultElementSize, estimateDofs, maxElementSize } from '../../fea/mesher';
import type { FeaSurface } from '../../kernel/protocol';
import { FIXTURE_LABELS, LOAD_LABELS, elementSizeFor, newStudy, nextStudyName, type FeaDir, type FeaFixture, type FeaLoad, type FeaLoadType, type FixtureType, type StaticStudy } from '../../model/fea';
import { elasticOf } from '../../model/materials';
import { allocateId } from '../../model/document';
import type { Id } from '../../model/types';
import { type MenuItem, openMenu } from '../../ui/menu';
import { promptDialog, toast } from '../../ui/overlay';
import type { App } from '../app';
import { faceIndexOf } from './index';
import { FixturePanel, LoadPanel, ResultsPanel, StudyPanel } from './panels';
import { reportDialog } from './report';

export type StudyState = 'none' | 'busy' | 'ok' | 'stale' | 'error';

interface SurfaceState {
  version: number;
  data: FeaSurface;
  auto: number;
  max: number;
  diag: number;
}

export interface FeaResult {
  key: string;
  mesh: FeaMeshInfo;
  sol: FeaSolution;
  input: StaticInput;
  /** Yield and tensile strength (MPa) and material name when it was solved. */
  yield: number;
  uts: number;
  material: string;
  size: number;
  /** Names of the fixtures and loads, in input order. */
  fixtureNames: string[];
  loadNames: string[];
  when: number;
}

const FIX_COLOR = [40, 170, 90];
const LOAD_COLOR = [210, 60, 150];

export class FeaWorkspace {
  readonly client = new FeaClient();
  /** The fixture or load selected in the tree (its faces highlighted). */
  focus: Id | null = null;
  private surface: SurfaceState | null = null;
  private surfaceLoading: Promise<SurfaceState> | null = null;
  mesh: { key: string; info: FeaMeshInfo; size: number } | null = null;
  result: FeaResult | null = null;
  busy: { stage: string; progress: number } | null = null;
  error: { key: string; message: string } | null = null;
  private generation = 0;
  /** Results panel open: it draws the plot (the study's symbols are hidden). */
  plotting = false;

  constructor(readonly app: App) {
    app.store.on((reason) => {
      if (reason === 'load') this.reset();
      const s = this.study;
      if (this.focus && !s?.fixtures.some((f) => f.id === this.focus) && !s?.loads.some((l) => l.id === this.focus)) this.focus = null;
      // A fixture or load deleted (or its study undone) while its panel is open: OK would bring it back.
      const p = app.panel;
      if ((p instanceof FixturePanel || p instanceof LoadPanel) && !p.present) void app.closePanel(false);
      this.changed();
    });
    app.ribbonTabListeners.push(() => this.redraw());
    app.commands.onChange(() => {
      // A new part shape: the surface, the mesh and the results are out of date (results stay, marked).
      if (this.surface && this.surface.version !== app.geometryVersion) { this.surface = null; this.changed(); }
    });
  }

  private reset() {
    this.client.cancel();
    this.surface = null;
    this.mesh = null;
    this.result = null;
    this.busy = null;
    this.error = null;
    this.focus = null;
    this.generation++;
  }

  get study(): StaticStudy | null {
    return this.app.store.doc.study ?? null;
  }

  /** Redraws the tree and the graphics. */
  changed() {
    this.redraw();
    this.app.renderTrees();
    if (this.app.panel instanceof ResultsPanel || this.app.panel instanceof StudyPanel) this.app.refreshPanel();
  }

  // ---------- state ----------

  /** What the results depend on: the part's shape, the mesh size, the study's fixtures and loads, the material. */
  solveKey(size?: number): string {
    const s = this.study;
    const strip = (x: FeaFixture | FeaLoad) => { const { name: _n, ...rest } = x; void _n; return rest; };
    return JSON.stringify([this.app.geometryVersion, size ?? this.sizeOf(), s ? [s.fixtures.map(strip), s.loads.map(strip)] : null, elasticOf(this.app.store.doc.material), this.app.store.doc.material?.density]);
  }

  private sizeOf(): number {
    const s = this.study, sf = this.surface;
    return sf && s ? elementSizeFor(sf.auto, sf.max, s.mesh.fineness) : 0;
  }

  state(): StudyState {
    if (this.busy) return 'busy';
    if (this.error && !this.result) return 'error';
    if (!this.result) return 'none';
    if (!this.surface || this.surface.version !== this.app.geometryVersion || this.result.key !== this.solveKey()) return 'stale';
    return 'ok';
  }

  progressText(): string {
    return this.busy ? `${this.busy.stage}${this.busy.progress > 0 ? ` ${Math.round(this.busy.progress * 100)}%` : ''}` : '';
  }

  errorText(): string {
    return this.error?.message ?? '';
  }

  meshText(): string {
    const m = this.mesh;
    if (!m) return '';
    const st = m.info.stats;
    return `(${st.elements.toLocaleString('en-US')} elements${m.key.startsWith(`${this.app.geometryVersion}|`) ? '' : ', out of date'})`;
  }

  /** Can the study run now (a part with a solid, nothing being edited)? */
  ready(): string | null {
    const app = this.app;
    if (app.assembly) return 'Stress analysis works on parts. Open the part to analyze it.';
    if (!app.bbox) return 'The part has no solid body to analyze yet.';
    if (app.sketchEditor || (app.panel?.editingId)) return 'Finish the feature or sketch being edited first.';
    return null;
  }

  // ---------- geometry ----------

  /** The part's boundary from the kernel, with the automatic and largest element sizes. */
  async surfaceState(): Promise<SurfaceState> {
    const app = this.app;
    await app.whenBuilt();
    const version = app.geometryVersion;
    if (this.surface && this.surface.version === version) return this.surface;
    if (this.surfaceLoading) return this.surfaceLoading;
    this.surfaceLoading = (async () => {
      try {
        const b = app.bbox;
        const diag = b ? Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) : 100;
        const data = await app.kernel.feaSurface(diag * 3e-4);
        let area = 0;
        const P = data.positions, I = data.indices;
        for (let t = 0; t < I.length; t += 3) {
          const a = I[t] * 3, b2 = I[t + 1] * 3, c = I[t + 2] * 3;
          const ux = P[b2] - P[a], uy = P[b2 + 1] - P[a + 1], uz = P[b2 + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
          area += 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx);
        }
        const st: SurfaceState = { version, data, diag, auto: defaultElementSize(data.volume, area, diag), max: maxElementSize(data.volume, area, diag) };
        if (app.geometryVersion !== version) return this.surfaceState();
        this.surface = st;
        return st;
      } finally {
        this.surfaceLoading = null;
      }
    })();
    return this.surfaceLoading;
  }

  /** Element size and estimated size of the problem for a fineness (null before the surface is known). */
  sizes(fineness: number): { size: number; auto: number; dofs: number } | null {
    const sf = this.surface;
    if (!sf) return null;
    const size = elementSizeFor(sf.auto, sf.max, fineness);
    return { size, auto: sf.auto, dofs: estimateDofs(sf.data.volume, size) };
  }

  private setBusy(stage: string, progress: number) {
    const was = this.busy?.stage;
    this.busy = { stage, progress };
    this.app.setStatus(this.progressText());
    // The tree and panel show the stage; redraw them on a new stage or every few percent.
    if (was !== stage || Math.round(progress * 100) % 5 === 0) {
      this.app.renderTrees();
      const p = this.app.panel;
      // A panel drawn before the run started shows it now (its progress bar, Cancel, disabled buttons).
      if ((p instanceof ResultsPanel || p instanceof StudyPanel) && !p.progress(this.busy)) this.app.refreshPanel();
    }
  }

  /** Meshes the part at the study's size if the mesh is not current. */
  async ensureMesh(): Promise<{ info: FeaMeshInfo; size: number } | null> {
    const s = this.study;
    if (!s) return null;
    const gen = this.generation;
    this.setBusy('Preparing the part', 0);
    const sf = await this.surfaceState();
    if (gen !== this.generation) return null;
    const size = elementSizeFor(sf.auto, sf.max, s.mesh.fineness);
    const key = `${sf.version}|${size}`;
    if (this.mesh?.key === key && this.client.meshed) return this.mesh;
    this.setBusy('Meshing', 0);
    // A copy: the surface stays here for the next mesh (the worker gets its own).
    const surface = { positions: sf.data.positions.slice(), indices: sf.data.indices.slice(), triFace: sf.data.triFace.slice() };
    const info = await this.client.mesh(surface, size, (stage, v) => this.setBusy(`Meshing: ${stage.toLowerCase()}`, v));
    if (gen !== this.generation) return null;
    this.mesh = { key, info, size };
    return this.mesh;
  }

  /** Meshes the part (from the mesh panel). */
  async meshNow(): Promise<void> {
    const why = this.ready();
    if (why) { toast({ kind: 'info', message: why }); return; }
    try {
      await this.ensureMesh();
      this.error = null;
    } catch (e) {
      if (!(e instanceof FeaCancelled)) this.error = { key: '', message: (e as Error).message };
    } finally {
      this.busy = null;
      this.app.setStatus(this.mesh ? `Meshed: ${this.mesh.info.stats.elements.toLocaleString('en-US')} elements, ${this.mesh.info.stats.nodes.toLocaleString('en-US')} nodes` : this.error?.message ?? '', !this.mesh);
      this.changed();
    }
  }

  // ---------- the study as solver input ----------

  /** Direction of a reference (unit vector), or null if it cannot be found in the part. */
  dirOf(d: FeaDir): Vec3 | null {
    const app = this.app;
    if (d.kind === 'base') return d.axis === 'x' ? [1, 0, 0] : d.axis === 'y' ? [0, 1, 0] : [0, 0, 1];
    if (d.kind === 'face') {
      const i = faceIndexOf(app, d.face);
      const f = app.faces[i];
      if (!f) return null;
      const v = f.normal ?? f.axis?.d;
      return v ? [v[0], v[1], v[2]] : null;
    }
    const e = app.edges.find((x) => x.name === d.edge.name) ?? null;
    if (!e) return null;
    const v = e.dir ?? e.axis;
    if (v) return [v[0], v[1], v[2]];
    const l = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1], e.b[2] - e.a[2]);
    return l > 0 ? [(e.b[0] - e.a[0]) / l, (e.b[1] - e.a[1]) / l, (e.b[2] - e.a[2]) / l] : null;
  }

  /** The study for the solver: face indices, directions, the material (throws a message for the user). */
  inputOf(s: StaticStudy): { input: StaticInput; fixtureNames: string[]; loadNames: string[] } {
    const app = this.app;
    const mat = app.store.doc.material;
    const el = elasticOf(mat);
    if (!mat) throw new Error('Choose the part\'s material first (Material on the Analysis tab).');
    if (!el) throw new Error(`${mat.name} has no elastic properties for analysis${/oak|pine|wood/i.test(mat.name) ? ' (wood is anisotropic)' : ''}. Choose another material, or give a custom one its elastic modulus, Poisson's ratio and strengths.`);
    const faces = (refs: FeaFixture['faces'], what: string) => {
      const out = refs.map((r) => faceIndexOf(app, r));
      if (!out.length) throw new Error(`${what}: pick the faces it acts on.`);
      if (out.some((i) => i < 0)) throw new Error(`${what}: a face it uses is no longer in the part. Edit it and pick the faces again.`);
      return out;
    };
    const fixtures: FixtureInput[] = [];
    const fixtureNames: string[] = [];
    for (const f of s.fixtures) {
      if (f.suppressed) continue;
      const idx = faces(f.faces, f.name);
      if (f.type === 'hinge') {
        const cyl = app.faces[idx[0]];
        if (!idx.every((i) => app.faces[i].type === 'cylinder') || !cyl.axis) throw new Error(`${f.name}: a fixed hinge goes on cylindrical faces (a pin hole or a shaft).`);
        fixtures.push({ kind: 'hinge', faces: idx, axis: { p: cyl.axis.p, d: cyl.axis.d } });
      } else fixtures.push({ kind: f.type, faces: idx });
      fixtureNames.push(f.name);
    }
    const loads: LoadInput[] = [];
    const loadNames: string[] = [];
    for (const l of s.loads) {
      if (l.suppressed) continue;
      const sign = l.flip ? -1 : 1;
      if (l.type === 'gravity') {
        const d = this.dirOf(l.dir);
        if (!d) throw new Error(`${l.name}: its direction reference is no longer in the part.`);
        loads.push({ kind: 'gravity', accel: [d[0] * l.value * sign, d[1] * l.value * sign, d[2] * l.value * sign] });
      } else if (l.type === 'pressure') {
        loads.push({ kind: 'pressure', faces: faces(l.faces, l.name), value: l.value * sign });
      } else {
        const idx = faces(l.faces, l.name);
        if (!l.dir) loads.push({ kind: 'force', faces: idx, total: l.value * sign, dir: null });
        else {
          const d = this.dirOf(l.dir);
          if (!d) throw new Error(`${l.name}: its direction reference is no longer in the part.`);
          loads.push({ kind: 'force', faces: idx, total: l.value, dir: [d[0] * sign, d[1] * sign, d[2] * sign] });
        }
      }
      loadNames.push(l.name);
    }
    if (!fixtures.length) throw new Error('Add a fixture: without one the part is free to move.');
    if (!loads.length) throw new Error('Add a load: a force, a pressure or gravity.');
    return { input: { E: el.E, nu: el.nu, density: mat.density * 1e-12, fixtures, loads }, fixtureNames, loadNames };
  }

  // ---------- running ----------

  /** Meshes (if needed) and solves the study, then shows the results. */
  async run(): Promise<void> {
    const s = this.study;
    if (!s) { this.openStudy(); return; }
    const why = this.ready();
    if (why) { toast({ kind: 'info', message: why }); return; }
    if (this.busy) return;
    const gen = ++this.generation;
    let resolved: ReturnType<FeaWorkspace['inputOf']>;
    try {
      resolved = this.inputOf(s);
    } catch (e) {
      this.error = { key: this.solveKey(), message: (e as Error).message };
      this.changed();
      void this.openResults();
      return;
    }
    this.error = null;
    void this.openResults();
    try {
      const m = await this.ensureMesh();
      if (!m || gen !== this.generation) return;
      const key = this.solveKey(m.size);
      const t0 = performance.now();
      const sol = await this.client.solve(resolved.input, (stage, v) => this.setBusy(stage, v));
      if (gen !== this.generation) return;
      const el = elasticOf(this.app.store.doc.material)!;
      this.result = {
        key, mesh: m.info, sol, input: resolved.input, yield: el.yield, uts: el.uts, material: this.app.store.doc.material?.name ?? '', size: m.size,
        fixtureNames: resolved.fixtureNames, loadNames: resolved.loadNames, when: Date.now(),
      };
      this.busy = null;
      this.app.setStatus(`Solved in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${sol.summary.dofs.toLocaleString('en-US')} degrees of freedom`);
    } catch (e) {
      if (e instanceof FeaCancelled) { this.app.setStatus('Analysis cancelled'); }
      else { this.error = { key: this.solveKey(), message: (e as Error).message }; this.app.setStatus((e as Error).message, true); }
    } finally {
      if (gen === this.generation) this.busy = null;
      this.changed();
    }
  }

  cancel() {
    this.generation++;
    this.client.cancel();
    this.busy = null;
    this.changed();
  }

  // ---------- panels ----------

  /** Creates the study if there is none (one undo step); returns it. */
  ensureStudy(): StaticStudy {
    if (!this.study) {
      this.app.store.change('New static study', (d) => { d.study = newStudy(allocateId(d, 'st')); });
      this.app.setRibbonTab('analysis');
    }
    return this.study!;
  }

  openStudy() {
    const why = this.ready();
    if (why) { toast({ kind: 'info', message: why }); return; }
    this.ensureStudy();
    this.app.exitModes();
    void this.app.openPanel(new StudyPanel(this.app, this));
    void this.surfaceState().then(() => this.app.panel instanceof StudyPanel && this.app.refreshPanel()).catch(() => {});
  }

  openMesh() {
    this.openStudy();
  }

  newFixture(type: FixtureType) {
    const why = this.ready();
    if (why) { toast({ kind: 'info', message: why }); return; }
    const s = this.ensureStudy();
    const faces = this.app.selection.ofKind('face').map((it) => this.app.faces[it.index]).filter((f) => f && !f.body && (type !== 'hinge' || f.type === 'cylinder'));
    const f: FeaFixture = { id: allocateId(this.app.store.doc, 'fx'), name: nextStudyName(s, FIXTURE_LABELS[type].replace(/\/.*/, '')), type, faces: faces.map((x) => ({ name: x.name, sig: { type: x.type, c: x.center, n: x.normal, area: x.area } })) };
    this.app.exitModes();
    void this.app.openPanel(new FixturePanel(this.app, this, f, true));
  }

  newLoad(type: FeaLoadType) {
    const why = this.ready();
    if (why) { toast({ kind: 'info', message: why }); return; }
    const s = this.ensureStudy();
    const faces = this.app.selection.ofKind('face').map((it) => this.app.faces[it.index]).filter((f) => f && !f.body).map((x) => ({ name: x.name, sig: { type: x.type, c: x.center, n: x.normal, area: x.area } }));
    const id = allocateId(this.app.store.doc, 'ld');
    const name = nextStudyName(s, LOAD_LABELS[type]);
    const inch = this.app.store.doc.units === 'IPS';
    const l: FeaLoad = type === 'force' ? { id, name, type, faces, value: inch ? 444.8221615 : 100, dir: null, flip: false }
      : type === 'pressure' ? { id, name, type, faces, value: inch ? 0.6894757 : 1, flip: false }
      : { id, name, type, value: 9806.65, dir: { kind: 'base', axis: 'y' }, flip: true };
    this.app.exitModes();
    void this.app.openPanel(new LoadPanel(this.app, this, l, true));
  }

  editItem(id: Id) {
    const s = this.study;
    const fx = s?.fixtures.find((x) => x.id === id), ld = s?.loads.find((x) => x.id === id);
    if (!fx && !ld) return;
    this.focus = id;
    this.app.exitModes();
    if (fx) void this.app.openPanel(new FixturePanel(this.app, this, structuredClone(fx), false));
    else void this.app.openPanel(new LoadPanel(this.app, this, structuredClone(ld!), false));
  }

  focusItem(id: Id) {
    this.focus = this.focus === id ? null : id;
    if (this.app.ribbonTabId !== 'analysis') this.app.setRibbonTab('analysis');
    this.changed();
  }

  itemMenu(id: Id, x: number, y: number) {
    const s = this.study;
    const item = s?.fixtures.find((f) => f.id === id) ?? s?.loads.find((l) => l.id === id);
    if (!item) return;
    const mutate = (label: string, fn: (it: FeaFixture | FeaLoad, st: StaticStudy) => void) => this.app.store.change(label, (d) => {
      const st = d.study;
      const it = st?.fixtures.find((f) => f.id === id) ?? st?.loads.find((l) => l.id === id);
      if (st && it) fn(it, st);
    });
    const items: MenuItem[] = [
      { label: 'Edit', icon: 'edit', run: () => this.editItem(id) },
      { label: item.suppressed ? 'Unsuppress' : 'Suppress', icon: item.suppressed ? 'eye' : 'eyeOff', run: () => mutate(item.suppressed ? 'Unsuppress' : 'Suppress', (it) => { it.suppressed = !it.suppressed || undefined; }) },
      {
        label: 'Rename', icon: 'text', run: () => void promptDialog('Rename', 'Name', item.name, (v) => (v.trim() ? null : 'Enter a name'), this.app.documentSignal).then((name) => {
          if (name && name.trim() !== item.name) mutate('Rename', (it) => { it.name = name.trim(); });
        }),
      },
      { separator: true },
      { label: 'Delete', icon: 'trash', run: () => mutate(`Delete ${item.name}`, (_it, st) => { st.fixtures = st.fixtures.filter((f) => f.id !== id); st.loads = st.loads.filter((l) => l.id !== id); }) },
    ];
    openMenu(items, x, y, { label: `${item.name} menu` });
  }

  /** Opens the results panel (it shows progress while the study runs). */
  async openResults() {
    if (this.app.panel instanceof ResultsPanel) { this.app.refreshPanel(); return; }
    this.app.exitModes();
    await this.app.openPanel(new ResultsPanel(this.app, this));
  }

  /** Shows the results, running the study first if it has never run. */
  async showResults() {
    if (!this.result && !this.busy && !this.error) { await this.run(); return; }
    await this.openResults();
  }

  report() {
    if (!this.result) { toast({ kind: 'info', message: 'Run the study first: there are no results to report yet.' }); return; }
    void reportDialog(this.app, this, this.result);
  }

  deleteStudy() {
    if (this.app.panel instanceof ResultsPanel || this.app.panel instanceof StudyPanel) void this.app.closePanel(false);
    this.app.store.change('Delete study', (d) => { d.study = null; });
    this.reset();
    this.changed();
  }

  // ---------- display ----------

  private shown(): boolean {
    const app = this.app;
    if (app.inDrawing || app.assembly || app.sketchEditor || this.plotting) return false;
    return app.ribbonTabId === 'analysis' || app.panel instanceof FixturePanel || app.panel instanceof LoadPanel || app.panel instanceof StudyPanel;
  }

  /** Triangles of a face of the shown model. */
  private faceTris(index: number, out: number[]) {
    const m = this.app.modelMesh;
    if (!m) return;
    const idx = m.indices, P = m.positions, vf = m.vertexFace;
    for (let t = 0; t < idx.length; t += 3) {
      if (Math.round(vf[idx[t]]) !== index) continue;
      for (let k = 0; k < 3; k++) { const v = idx[t + k] * 3; out.push(P[v], P[v + 1], P[v + 2]); }
    }
  }

  /** The fixtures and loads on the model (tinted faces, arrows), and the mesh while its panel is open. */
  redraw() {
    const r = this.app.renderer;
    if (!r) return;
    const s = this.study;
    if (!s || !this.shown()) {
      r.setTris('feaFix', null); r.setLines('feaArrows', null);
      if (!this.plotting) r.setLines('feaMesh', null);
      return;
    }
    const tri: number[] = [], col: number[] = [];
    const arrows: number[] = [], acol: number[] = [];
    const b = this.app.bbox;
    const size = b ? Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) * 0.08 : 10;
    const arrow = (p: Vec3, d: Vec3, c: number[]) => {
      // From the tail to the point it presses on.
      const t: Vec3 = [p[0] - d[0] * size, p[1] - d[1] * size, p[2] - d[2] * size];
      const side: Vec3 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const n: Vec3 = [d[1] * side[2] - d[2] * side[1], d[2] * side[0] - d[0] * side[2], d[0] * side[1] - d[1] * side[0]];
      const nl = Math.hypot(...n) || 1;
      const h = size * 0.25;
      const back: Vec3 = [p[0] - d[0] * h, p[1] - d[1] * h, p[2] - d[2] * h];
      arrows.push(...t, ...p, ...p, back[0] + (n[0] / nl) * h * 0.5, back[1] + (n[1] / nl) * h * 0.5, back[2] + (n[2] / nl) * h * 0.5, ...p, back[0] - (n[0] / nl) * h * 0.5, back[1] - (n[1] / nl) * h * 0.5, back[2] - (n[2] / nl) * h * 0.5);
      for (let k = 0; k < 3; k++) acol.push(...c, 255);
    };
    const tint = (faces: FeaFixture['faces'], c: number[], focused: boolean) => {
      for (const ref of faces) {
        const i = faceIndexOf(this.app, ref);
        if (i < 0) continue;
        const before = tri.length;
        this.faceTris(i, tri);
        for (let k = before; k < tri.length; k += 3) col.push(...c, focused ? 150 : 95);
      }
    };
    for (const f of s.fixtures) if (!f.suppressed) tint(f.faces, FIX_COLOR, this.focus === f.id);
    for (const l of s.loads) {
      if (l.suppressed) continue;
      if (l.type === 'gravity') {
        const d = this.dirOf(l.dir);
        if (d && b) {
          const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
          const sg = l.flip ? -1 : 1;
          arrow(c, [d[0] * sg, d[1] * sg, d[2] * sg], LOAD_COLOR);
        }
        continue;
      }
      tint(l.faces, LOAD_COLOR, this.focus === l.id);
      for (const ref of l.faces) {
        const f = this.app.faces[faceIndexOf(this.app, ref)];
        if (!f) continue;
        let d: Vec3 | null = null;
        const sg = l.flip ? -1 : 1;
        if (l.type === 'force' && l.dir) { const v = this.dirOf(l.dir); if (v) d = [v[0] * sg, v[1] * sg, v[2] * sg]; }
        else if (f.normal) d = [-f.normal[0] * sg, -f.normal[1] * sg, -f.normal[2] * sg];
        if (d) arrow(f.center, d, LOAD_COLOR);
      }
    }
    r.setTris('feaFix', tri.length ? { positions: new Float32Array(tri), colors: new Uint8Array(col), depth: 'test', order: 2 } : null);
    r.setLines('feaArrows', arrows.length ? { positions: new Float32Array(arrows), colors: new Uint8Array(acol), width: 2.5, depth: 'always', order: 8 } : null);
    // The mesh while the study panel is open.
    const m = this.mesh;
    if (m && this.app.panel instanceof StudyPanel && m.key.startsWith(`${this.app.geometryVersion}|`)) {
      r.setLines('feaMesh', { positions: m.info.lines, colors: new Uint8Array((m.info.lines.length / 6) * 4).fill(0).map((_, i) => (i % 4 === 3 ? 200 : 40)), width: 1, depth: 'test', order: 6, bias: 4e-5 });
    } else if (!this.plotting) r.setLines('feaMesh', null);
  }
}
