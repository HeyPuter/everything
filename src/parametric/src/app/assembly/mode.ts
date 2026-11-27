// Assembly mode: what the app does while an assembly document is open.
// Builds the parts its components use (in the geometry worker, each once),
// solves the mates, shows the placed components as one model through the
// part renderer, and lets components be dragged within what their mates
// allow. The design tree, ribbon and panels of assemblies are set up here.

import type { FaceInfo, FeatureStatus } from '../../kernel/protocol';
import type { AsmPartBuild, AsmPartResult } from '../../kernel/assembly';
import { KernelRestartError } from '../../kernel/client';
import { type Quat, type Vec3, add, cross, dot, normalize, qAxisAngle, qMul, scale, sub } from '../../math/vec';
import { DocStore, parseDocument } from '../../model/document';
import { BASE_FRAMES, BASE_PLANE_NAMES } from '../../model/planes';
import type { Id, PartDocument } from '../../model/types';
import { UNIT_SYSTEMS } from '../../model/units';
import {
  type AsmComponent, type AsmPart, type AssemblyDocument, type ExplodeStep, type Mate, type MateRef, type MotionStudy, type Placement, MATE_LABELS, PartCache, asAssembly, mateComps, mateRefs,
} from '../../model/assembly';
import { type ComposedModel, type PartGeometry, combinedName, composeModel, edgeGeo, faceGeo, findEdge, findFace, placementMatrix } from '../../assembly/compose';
import { type AnalysisResult, type DragGoal, type Geo, MateSolver, type SolverBody, type SolverEntity, type SolverMate, applyPlacement, matesMoving } from '../../assembly/solver';
import { type MotionResult, type MotionSetup, type MotorInput, MotionRun, profileOf } from '../../assembly/motion';
import { parseColor } from '../../platform/theme';
import { confirmDialog, toast } from '../../ui/overlay';
import type { App } from '../app';
import { formatGroup } from '../dialogs';
import type { SelItem } from '../selection';
import type { ViewportTool, VPEvent } from '../viewport';
import { AssemblyTree } from './tree';

type Geom = PartGeometry & { status: FeatureStatus[] };

export class AssemblyMode {
  readonly parts = new PartCache(parseDocument);
  private geoms = new Map<string, Geom>();
  private generation = -1;
  model: ComposedModel | null = null;
  /** The components in the worker's scene, in order (hidden ones too: see AsmSceneItem). */
  sceneComps: Id[] = [];
  /** Where the mates put each component (exploded view aside). */
  solved = new Map<Id, Placement>();
  analysis: AnalysisResult | null = null;
  /** Parts that could not be read or built, with why. */
  partErrors = new Map<Id, string>();
  readonly tree: AssemblyTree;
  readonly flyout: AssemblyTree;
  readonly dragTool: ViewportTool;
  /** Drags turn components instead of moving them (Rotate Component). */
  rotateMode = false;
  /** Frame the assembly once its first rebuild shows it. */
  fitPending = true;
  /** The document (but its drawing) the components were last shown for. */
  private shownKey = '';
  private building: Promise<void> | null = null;
  private again = false;
  private restartRetried = false;
  /** Set while a drag shows placements that are not in the document yet. */
  private preview: Map<Id, Placement> | null = null;
  /** An explode step being edited: shown before it is in the document. */
  private explodePreview: { step: ExplodeStep | null; replace: Id | null } | null = null;
  /** Parts whose file could not be found when the assembly was opened (their copies are used). */
  missingParts = new Set<Id>();
  /** Opens the panel that edits a mate or explode step (set by the commands). */
  onEdit: (id: Id) => void = () => {};
  onShow: () => void = () => {};

  constructor(readonly app: App) {
    this.tree = new AssemblyTree(app, this);
    this.flyout = new AssemblyTree(app, this, true);
    this.dragTool = new DragTool(this);
  }

  get doc(): AssemblyDocument {
    return asAssembly(this.app.store.doc)!;
  }

  /** What the worker builds a part by (its embedded copy at the current quality). */
  key(p: AsmPart): string {
    return `${p.blob}|${this.app.settings.quality}`;
  }

  /** What the worker built for a part (null until it is built, or when it failed). */
  geometryOf(partId: Id): Geom | null {
    const p = this.doc.parts.find((x) => x.id === partId);
    return p ? this.geoms.get(this.key(p)) ?? null : null;
  }

  partDoc(partId: Id): PartDocument | null {
    return this.parts.get(this.doc, partId).doc;
  }

  component(id: Id): AsmComponent | undefined {
    return this.doc.components.find((c) => c.id === id);
  }

  // ---------- rebuild ----------

  /** Builds what is missing, solves the mates and shows the result (one at a time). */
  rebuild(): Promise<void> {
    if (this.building) { this.again = true; return this.building; }
    this.building = (async () => {
      do {
        this.again = false;
        await this.rebuildOnce();
      } while (this.again && this.app.assembly === this);
    })().finally(() => { this.building = null; });
    return this.building;
  }

  private async rebuildOnce() {
    const app = this.app;
    const doc = this.doc;
    const signal = app.documentSignal;
    if (app.kernel.generation !== this.generation) { this.geoms.clear(); this.generation = app.kernel.generation; }
    const used = doc.parts.filter((p) => doc.components.some((c) => c.part === p.id && !c.suppressed));
    // Only the drawing changed (a view dragged on the sheet): the components are shown as they are.
    const shownKey = JSON.stringify([app.kernel.generation, app.settings.quality, { ...doc, drawing: undefined, modified: undefined, blobs: undefined, studies: undefined }]);
    if (this.model && shownKey === this.shownKey && used.every((p) => this.geoms.has(this.key(p)))) return;
    this.shownKey = '';
    const builds: AsmPartBuild[] = [];
    this.partErrors.clear();
    for (const p of used) {
      const k = this.key(p);
      if (this.geoms.has(k)) continue;
      const { doc: pd, error } = this.parts.get(doc, p.id);
      if (!pd) { this.partErrors.set(p.id, error ?? 'The part could not be read'); continue; }
      const st = new DocStore(pd);
      const res = st.resolve();
      const invalid = Object.fromEntries([...res.errors].filter(([id]) => st.feature(id)?.type !== 'sketch'));
      builds.push({ key: k, features: res.features, blobs: pd.blobs, quality: app.settings.quality, invalid });
    }
    const t0 = performance.now();
    if (builds.length) {
      app.setStatus(`Building ${builds.length === 1 ? 'a part' : `${builds.length} parts`} of the assembly...`);
      let results: AsmPartResult[];
      try {
        results = await app.kernel.assembly<AsmPartResult[]>({ op: 'build', parts: builds });
      } catch (e) {
        if (signal.aborted || app.assembly !== this) return;
        if (e instanceof KernelRestartError && !this.restartRetried) { this.restartRetried = true; this.again = true; return; }
        toast({ kind: 'error', title: 'Rebuild failed', message: (e as Error).message });
        app.clearStatus();
        return;
      }
      if (signal.aborted || app.assembly !== this) return;
      this.restartRetried = false;
      for (const r of results) this.geoms.set(r.key, { mesh: r.mesh, faces: r.faces, edges: r.edges, bbox: r.bbox, cones: r.cones, status: r.status });
      app.clearStatus();
    }
    for (const p of used) {
      const g = this.geoms.get(this.key(p));
      const bad = g?.status.find((s) => !s.ok);
      if (bad && !this.partErrors.has(p.id)) {
        const f = this.partDoc(p.id)?.features.find((x) => x.id === bad.id);
        this.partErrors.set(p.id, `${p.name} has rebuild errors (${f?.name ?? 'a feature'}: ${bad.error ?? 'failed'}). Open the part to fix it.`);
      } else if (g && !g.mesh && !this.partErrors.has(p.id)) this.partErrors.set(p.id, `${p.name} has no solid body`);
    }
    // The worker forgets parts no longer used (all their components deleted or suppressed, or
    // built at another quality); this side too, so using them again builds them again.
    const keep = used.map((p) => this.key(p));
    for (const k of [...this.geoms.keys()]) if (!keep.includes(k)) this.geoms.delete(k);
    void app.kernel.assembly({ op: 'drop', keep }).catch(() => undefined);
    this.parts.prune(doc);
    this.analyze();
    this.show();
    this.shownKey = shownKey;
    app.shell.statusRebuild.textContent = `${Math.round(performance.now() - t0)} ms`;
    app.renderTrees();
    app.commands.changed();
  }

  // ---------- mates ----------

  /** The size the solver measures lengths against: the assembly's extent. */
  private scale(): number {
    let r = 0;
    for (const c of this.doc.components) {
      const g = this.geometryOf(c.part);
      if (!g?.bbox) continue;
      const pl = this.solved.get(c.id) ?? c.placement;
      for (const p of [g.bbox.min, g.bbox.max]) r = Math.max(r, Math.hypot(...applyPlacement(pl, p)));
    }
    return Math.max(10, r);
  }

  /** A mate reference as solver geometry, or why it cannot be used. */
  entity(ref: MateRef, doc = this.doc): SolverEntity | string {
    if ('plane' in ref) {
      const f = BASE_FRAMES[ref.plane];
      return { body: null, geo: { kind: 'plane', o: f.o, n: f.n } };
    }
    const c = doc.components.find((x) => x.id === ref.comp);
    if (!c) return 'Its component was deleted';
    if ('face' in ref || 'edge' in ref) {
      const g = this.geometryOf(c.part);
      if (!g) return `${c.name} is not built`;
      let geo: Geo | null = null;
      if ('face' in ref) {
        const i = findFace(g.faces, ref.face);
        if (i < 0) return `The face it references on ${c.name} no longer exists`;
        geo = faceGeo(g, i);
      } else {
        const i = findEdge(g.edges, ref.edge);
        if (i < 0) return `The edge it references on ${c.name} no longer exists`;
        geo = edgeGeo(g, i);
      }
      return geo ? { body: c.id, geo } : `The ${'face' in ref ? 'face' : 'edge'} it references on ${c.name} cannot be mated`;
    }
    return { body: c.id, geo: { kind: 'body' } };
  }

  /** Mate value in mm or degrees (a gear's teeth when its ratio is by teeth). */
  mateValue(m: Mate, v = m.value): number {
    if (v === undefined) return 0;
    return this.app.store.evalParam(v, m.type === 'angle' || m.type === 'hinge' ? 'angle' : m.by === 'ratio' ? 'count' : 'length');
  }

  /** What the value of a mate is called (for messages). */
  private valueName(m: Mate): string {
    return m.type === 'angle' || m.type === 'hinge' ? 'Angle' : m.type === 'gear' ? (m.by === 'ratio' ? 'Teeth' : 'Pitch diameter') : m.type === 'screw' ? 'Pitch' : m.type === 'rackPinion' ? (m.by === 'revolution' ? 'Travel per turn' : 'Pitch diameter') : 'Distance';
  }

  /**
   * Solver mates of a document: active mates between components that are
   * not suppressed. Mates that cannot be formed are returned with why.
   */
  solverInput(doc = this.doc): { bodies: SolverBody[]; mates: SolverMate[]; problems: Map<Id, string>; inactive: Set<Id> } {
    const live = doc.components.filter((c) => !c.suppressed);
    const bodies: SolverBody[] = live.map((c) => {
      const b = this.geometryOf(c.part)?.bbox;
      return { id: c.id, fixed: c.fixed, placement: c.placement, center: b ? scale(add(b.min, b.max), 0.5) : [0, 0, 0] };
    });
    const mates: SolverMate[] = [];
    const problems = new Map<Id, string>();
    const inactive = new Set<Id>();
    for (const m of doc.mates) {
      if (m.suppressed || mateComps(m).some((id) => doc.components.find((c) => c.id === id)?.suppressed)) { inactive.add(m.id); continue; }
      const ents = mateRefs(m).map((r) => this.entity(r, doc));
      const bad = ents.find((e): e is string => typeof e === 'string');
      if (bad) { problems.set(m.id, bad); continue; }
      const [a, b] = ents as SolverEntity[];
      const a2 = m.a2 ? (ents[2] as SolverEntity) : undefined, b2 = m.b2 ? (ents[ents.length - 1] as SolverEntity) : undefined;
      let value = 0, value2: number | undefined, limit: { min: number; max: number } | undefined;
      try {
        value = this.mateValue(m);
        if (m.value2 !== undefined) value2 = this.mateValue(m, m.value2);
        if (m.limit) limit = { min: this.mateValue(m, m.limit.min), max: this.mateValue(m, m.limit.max) };
      } catch (e) {
        problems.set(m.id, `${this.valueName(m)}: ${(e as Error).message}`);
        continue;
      }
      mates.push({
        id: m.id, type: m.type, a, b, aligned: m.aligned, value, flip: !!m.flip, rel: m.rel,
        ...(a2 ? { a2 } : {}), ...(b2 ? { b2 } : {}), ...(m.aligned2 !== undefined ? { aligned2: m.aligned2 } : {}),
        ...(value2 !== undefined ? { value2 } : {}), ...(limit ? { limit } : {}), ...(m.by ? { by: m.by } : {}), ...(m.reverse ? { reverse: true } : {}),
      });
    }
    return { bodies, mates, problems, inactive };
  }

  /** Components linked to a fixed one (or the assembly planes) by mates: they move last. */
  private grounded(mates: SolverMate[], bodies: SolverBody[]): Set<Id> {
    const out = new Set(bodies.filter((b) => b.fixed).map((b) => b.id));
    let grew = true;
    let ground = mates.some((m) => !m.a.body || !m.b.body);
    while (grew) {
      grew = false;
      for (const m of mates) {
        const ids = [m.a, m.b, m.a2, m.b2].flatMap((e) => (e ? [e.body] : []));
        const touches = ids.some((id) => (id ? out.has(id) : ground));
        if (!touches) continue;
        for (const id of ids) if (id && !out.has(id)) { out.add(id); grew = true; }
      }
      ground = false;
    }
    return out;
  }

  /** Solves a document's mates; the analysis carries the placements. */
  solveDoc(doc = this.doc): AnalysisResult {
    const { bodies, mates, problems } = this.solverInput(doc);
    const solver = new MateSolver(bodies, mates);
    const grounded = this.grounded(mates, bodies);
    const r = solver.analyze({ scale: this.scale(), weight: (id) => (grounded.has(id) ? 100 : 1) });
    for (const [id, why] of problems) r.invalid.set(id, why);
    // A mate that cannot be formed (a face gone) is an error, not a conflict.
    if (problems.size && r.status !== 'over') r.status = 'error';
    return r;
  }

  /** The analysis a commit just made, reused by the rebuild that follows it when nothing it used changed. */
  private solveCache: { key: string; result: AnalysisResult } | null = null;

  /** What an analysis of a document depends on. */
  private solveKey(doc: AssemblyDocument): string {
    return JSON.stringify([this.app.kernel.generation, this.app.settings.quality, [...this.geoms.keys()], doc.components, doc.mates, doc.variables, doc.units, doc.parts.map((p) => p.blob)]);
  }

  private analyze() {
    // A commit solved this very document already (an over-defined assembly takes long to analyse).
    const hit = this.solveCache?.key === this.solveKey(this.doc) ? this.solveCache.result : null;
    this.solveCache = null;
    this.analysis = hit ?? this.solveDoc();
    this.solved = new Map(this.analysis.placements);
  }

  isDefined(id: Id): boolean {
    return !!this.analysis?.defined.has(id);
  }

  mateError(id: Id): string | null {
    const a = this.analysis;
    if (!a) return null;
    if (a.invalid.has(id)) return a.invalid.get(id)!;
    if (a.conflicts.has(id)) return 'Over defined: this mate cannot hold together with the mates before it';
    return null;
  }

  componentError(id: Id): { kind: 'error' | 'warning'; text: string } | null {
    const c = this.component(id);
    if (!c || c.suppressed) return null;
    const err = this.partErrors.get(c.part);
    if (err) return { kind: 'error', text: err };
    const p = this.doc.parts.find((x) => x.id === c.part);
    if (p && !p.source) return { kind: 'warning', text: `${p.name} exists only inside this assembly (it has no part file).` };
    if (p && this.missingParts.has(p.id)) return { kind: 'warning', text: `The part file of ${p.name} was not found (moved or deleted?): the copy kept in the assembly is used.` };
    return null;
  }

  /** "bracket<1>, pin<1>" for a mate's row. */
  mateLabel(m: Mate): string {
    return [m.a, m.b].map((r) => ('plane' in r ? BASE_PLANE_NAMES[r.plane] : this.component(r.comp)?.name ?? '?')).join(', ');
  }

  // ---------- display ----------

  /** Where a component is shown: where the mates put it, moved by the exploded view. */
  shownPlacement(id: Id, base = this.preview ?? this.solved): Placement | null {
    const c = this.component(id);
    if (!c) return null;
    const pl = base.get(id) ?? c.placement;
    const doc = this.doc;
    const ex = this.explodePreview;
    if (!doc.exploded && !ex) return pl;
    let steps = doc.explode;
    if (ex) {
      steps = steps.flatMap((s) => (s.id === ex.replace ? (ex.step ? [ex.step] : []) : [s]));
      if (ex.step && !ex.replace) steps = [...steps, ex.step];
    }
    let off: Vec3 = [0, 0, 0];
    for (const s of steps) {
      if (!s.comps.includes(id)) continue;
      let d = 0;
      try { d = this.app.store.evalParam(s.distance, 'length'); } catch { d = 0; }
      off = add(off, scale(normalize(s.dir), d));
    }
    return { p: add(pl.p, off), q: pl.q };
  }

  /** Shows the components where they are now (or where a drag puts them). */
  show() {
    const app = this.app;
    const doc = this.doc;
    const all = [];
    for (const c of doc.components) {
      if (c.suppressed) continue;
      const geom = this.geometryOf(c.part);
      const pl = this.shownPlacement(c.id);
      if (!geom || !pl) continue;
      const part = doc.parts.find((p) => p.id === c.part)!;
      all.push({ comp: c, placement: pl, geom, color: parseColor(part.color) as [number, number, number] });
    }
    const items = all.filter((it) => !it.comp.hidden);
    const model = composeModel(items);
    this.model = model;
    app.setModelGeometry(model.mesh, model.faces, model.edges, model.bbox);
    app.renderer.setFaceColors(model.faceColors);
    app.buildVersion++;
    app.geometryVersion++;
    app.selection.revalidate(model.faces, model.edges);
    app.viewport.refreshStates();
    // The worker places the same components, in the same order, for measure, export and
    // interference, and the hidden ones too for mass properties (they are still in the assembly).
    this.sceneComps = all.map((it) => it.comp.id);
    void app.kernel.assembly({
      op: 'scene', items: all.map((it) => {
        const part = doc.parts.find((p) => p.id === it.comp.part)!;
        return { part: this.key(part), m: placementMatrix(it.placement), name: it.comp.name, color: part.color, ...(it.comp.hidden ? { hidden: true } : {}) };
      }),
    }).catch(() => undefined);
    if (this.fitPending && model.bbox) {
      this.fitPending = false;
      app.viewport.zoomToFit(false, false);
    }
    app.panel?.onBuild({ mesh: null, faces: model.faces, edges: model.edges, status: [], frames: {}, bbox: model.bbox, ms: 0, preview: null });
    this.updateStatus();
    this.onShow();
  }

  updateStatus() {
    const btn = this.app.shell.statusSketch;
    const a = this.analysis;
    if (!a || !this.doc.components.length) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.className = `cell status-${a.status === 'error' ? 'over' : a.status}`;
    btn.textContent = a.status === 'over' ? 'Over Defined' : a.status === 'error' ? 'Mate Errors' : a.status === 'full' ? 'Fully Defined' : `Under Defined (${a.dof} DOF)`;
  }

  /** The combined face index of a component's part face, or -1. */
  combinedFace(comp: Id, local: number): number {
    const m = this.model;
    if (!m) return -1;
    const ci = m.comps.indexOf(comp);
    for (let i = 0; i < m.faceComp.length; i++) if (m.faceComp[i] === ci && m.faceLocal[i] === local) return i;
    return -1;
  }

  /** The component a combined face belongs to. */
  faceComponent(index: number): AsmComponent | undefined {
    const m = this.model;
    if (!m || index < 0 || index >= m.faceComp.length) return undefined;
    return this.component(m.comps[m.faceComp[index]]);
  }

  edgeComponent(index: number): AsmComponent | undefined {
    const m = this.model;
    if (!m || index < 0 || index >= m.edgeComp.length) return undefined;
    return this.component(m.comps[m.edgeComp[index]]);
  }

  /** A picked face or edge as a mate reference (by its name in the part). */
  refOf(it: SelItem): MateRef | null {
    if (it.kind === 'plane' && it.ref.kind === 'base') return { plane: it.ref.plane };
    if (it.kind === 'feature' && this.component(it.id)) return { comp: it.id };
    const m = this.model;
    if (!m) return null;
    if (it.kind === 'face') {
      const c = this.faceComponent(it.index);
      const g = c && this.geometryOf(c.part);
      const f = g?.faces[m.faceLocal[it.index]];
      return c && f ? { comp: c.id, face: { name: f.name, sig: { type: f.type, c: f.center, n: f.normal, area: f.area } } } : null;
    }
    if (it.kind === 'edge') {
      const c = this.edgeComponent(it.index);
      const g = c && this.geometryOf(c.part);
      const e = g?.edges[m.edgeLocal[it.index]];
      return c && e ? { comp: c.id, edge: { name: e.name, sig: { type: e.type, m: e.mid, len: e.length } } } : null;
    }
    return null;
  }

  /** The item a mate reference shows as (to highlight it). */
  itemOf(ref: MateRef): SelItem | null {
    if ('plane' in ref) return { kind: 'plane', ref: { kind: 'base', plane: ref.plane } };
    const c = this.component(ref.comp);
    const g = c && this.geometryOf(c.part);
    if (!c || !g) return null;
    if ('face' in ref) {
      const i = this.combinedFace(c.id, findFace(g.faces, ref.face));
      return i >= 0 ? { kind: 'face', index: i, name: combinedName(c.id, ref.face.name) } : null;
    }
    if ('edge' in ref) {
      const m = this.model;
      const local = findEdge(g.edges, ref.edge);
      if (!m || local < 0) return null;
      const ci = m.comps.indexOf(c.id);
      for (let i = 0; i < m.edgeComp.length; i++) if (m.edgeComp[i] === ci && m.edgeLocal[i] === local) return { kind: 'edge', index: i, name: combinedName(c.id, ref.edge.name) };
      return null;
    }
    return { kind: 'feature', id: c.id };
  }

  /** Faces and components highlighted because a mate or explode step is selected. */
  highlights(): SelItem[] {
    const out: SelItem[] = [];
    for (const it of this.app.selection.ofKind('feature')) {
      const m = this.doc.mates.find((x) => x.id === it.id);
      if (m) for (const r of mateRefs(m)) { const x = this.itemOf(r); if (x) out.push(x); }
      const s = this.doc.explode.find((x) => x.id === it.id);
      if (s) for (const id of s.comps) out.push({ kind: 'feature', id });
    }
    return out;
  }

  describe(it: SelItem): string | null {
    const doc = this.app.store.doc;
    const u = UNIT_SYSTEMS[doc.units], dec = doc.decimals;
    if (it.kind === 'face') {
      const f = this.app.faces[it.index];
      const c = this.faceComponent(it.index);
      if (!f || !c) return null;
      return `Face (${f.type}) of ${c.name}  Area ${formatGroup([f.area / u.scale ** 2], dec)[0]} ${u.length}²`;
    }
    if (it.kind === 'edge') {
      const e = this.app.edges[it.index];
      const c = this.edgeComponent(it.index);
      if (!e || !c) return null;
      return `Edge (${e.type}) of ${c.name}  Length ${formatGroup([e.length / u.scale], dec)[0]} ${u.length}`;
    }
    if (it.kind === 'feature') {
      const c = this.component(it.id);
      if (c) return `${c.name}${c.fixed ? ' (fixed)' : this.isDefined(c.id) ? ' (fully defined)' : ' (under defined)'}`;
      const m = this.doc.mates.find((x) => x.id === it.id);
      if (m) return `${MATE_LABELS[m.type]} mate: ${this.mateLabel(m)}`;
      const s = this.doc.explode.find((x) => x.id === it.id);
      if (s) return s.name;
      const st = this.study(it.id);
      if (st) return `Motion study ${st.name}: ${st.duration} s, ${st.motors.length} ${st.motors.length === 1 ? 'motor' : 'motors'}`;
    }
    return null;
  }

  // ---------- editing ----------

  /**
   * Changes the document as one undo step; the mates are solved again and
   * the floating components put where they hold.
   */
  commit(label: string, fn: (d: AssemblyDocument) => void, solve = true) {
    this.app.store.change(label, (raw) => {
      const d = asAssembly(raw)!;
      fn(d);
      if (!solve) return;
      const r = this.solveDoc(d);
      for (const c of d.components) {
        const pl = r.placements.get(c.id);
        if (pl && !c.fixed && !c.suppressed) c.placement = pl;
      }
      this.solveCache = { key: this.solveKey(d), result: r };
    });
  }

  itemName(id: Id): string | null {
    const d = this.doc;
    return d.components.find((x) => x.id === id)?.name ?? d.mates.find((x) => x.id === id)?.name ?? d.explode.find((x) => x.id === id)?.name ?? this.study(id)?.name ?? null;
  }

  nameRefusal(id: Id, name: string): string | null {
    const low = name.toLowerCase();
    const d = this.doc;
    const other = [...d.components, ...d.mates, ...d.explode, ...d.studies ?? []].find((x) => x.id !== id && x.name.toLowerCase() === low);
    return other ? `"${name}" is already the name of another item. Choose another name.` : null;
  }

  rename(id: Id, name: string) {
    this.commit('Rename', (d) => {
      for (const x of [...d.components, ...d.mates, ...d.explode, ...d.studies ?? []]) if (x.id === id) x.name = name;
    }, false);
  }

  study(id: Id): MotionStudy | undefined {
    return this.doc.studies?.find((s) => s.id === id);
  }

  /** Double click or Enter on a tree row. */
  edit(id: Id) {
    if (this.component(id)) this.app.selection.set([{ kind: 'feature', id }]);
    else this.onEdit(id);
  }

  async deleteItems(ids: Id[]) {
    const doc = this.doc;
    const signal = this.app.documentSignal;
    const comps = doc.components.filter((c) => ids.includes(c.id));
    const mates = doc.mates.filter((m) => ids.includes(m.id) || mateComps(m).some((c) => comps.some((x) => x.id === c)));
    const steps = doc.explode.filter((s) => ids.includes(s.id));
    const studies = (doc.studies ?? []).filter((s) => ids.includes(s.id));
    const names = [...comps, ...doc.mates.filter((m) => ids.includes(m.id)), ...steps, ...studies].map((x) => x.name);
    if (!names.length) return;
    const dependent = mates.filter((m) => !ids.includes(m.id));
    const msg = dependent.length ? `Delete ${names.join(', ')}? These mates reference ${comps.length === 1 ? 'it' : 'them'} and are deleted too: ${dependent.map((m) => m.name).join(', ')}.` : `Delete ${names.join(', ')}?`;
    if (!(await confirmDialog('Delete', msg, 'Delete', true, signal)) || signal.aborted) return;
    if (this.app.panel) await this.app.closePanel(false);
    const gone = new Set([...comps.map((c) => c.id), ...mates.map((m) => m.id), ...steps.map((s) => s.id), ...studies.map((s) => s.id)]);
    this.commit('Delete', (d) => {
      d.components = d.components.filter((c) => !gone.has(c.id));
      d.mates = d.mates.filter((m) => !gone.has(m.id));
      // Motors of deleted components and mates go with them (a file keeps none that point nowhere).
      if (d.studies) {
        d.studies = d.studies.filter((s) => !gone.has(s.id)).map((s) => ({ ...s, motors: s.motors.filter((mo) => !(mo.mate && gone.has(mo.mate)) && !(mo.ref && 'comp' in mo.ref && gone.has(mo.ref.comp))) }));
        if (!d.studies.length) delete d.studies;
      }
      d.explode = d.explode.filter((s) => !gone.has(s.id)).map((s) => ({ ...s, comps: s.comps.filter((c) => !gone.has(c)) })).filter((s) => s.comps.length);
      if (!d.explode.length) d.exploded = false;
      d.parts = d.parts.filter((p) => d.components.some((c) => c.part === p.id));
      // The first component left is fixed when none is, so the assembly keeps its ground.
      if (d.components.length && !d.components.some((c) => c.fixed)) d.components[0].fixed = true;
    });
    this.app.selection.clear();
  }

  // ---------- dragging ----------

  /** Shows an explode step being added (or replacing `replace`) before it is in the document. */
  previewExplode(step: ExplodeStep | null, replace: Id | null) {
    this.explodePreview = step || replace ? { step, replace } : null;
    this.show();
  }

  /** Shows a drag's placements without changing the document. */
  previewPlacements(pl: Map<Id, Placement> | null) {
    this.preview = pl;
    this.show();
  }

  /** Solves with a drag goal from where the components are shown. */
  dragSolve(goal: DragGoal, from: Map<Id, Placement>): Map<Id, Placement> {
    const { bodies, mates } = this.solverInput();
    const start = new Map(bodies.map((b) => [b.id, from.get(b.id) ?? b.placement]));
    const active = mates.filter((m) => !this.analysis?.conflicts.has(m.id));
    const solver = new MateSolver(bodies.map((b) => ({ ...b, placement: start.get(b.id)! })), matesMoving(goal.body, bodies, active));
    return solver.solve({ scale: this.scale(), drag: goal, maxIter: 25 }).placements;
  }

  commitPlacements(label: string, pl: Map<Id, Placement>) {
    this.preview = null;
    this.commit(label, (d) => {
      for (const c of d.components) {
        const p = pl.get(c.id);
        if (p && !c.fixed) c.placement = p;
      }
    });
  }

  // ---------- motion studies ----------

  /** Computed motion studies, with what they were computed from (see studyKey). */
  private motions = new Map<Id, { key: string; result: MotionResult }>();

  /** What a study's results depend on: the study and everything the mates are solved from. */
  studyKey(st: MotionStudy): string {
    return JSON.stringify([this.solveKey(this.doc), { ...st, id: undefined, name: undefined }]);
  }

  /** A study's results, and whether they are those of the assembly (and study) as they are now. */
  motionOf(id: Id, st = this.study(id)): { result: MotionResult; current: boolean } | null {
    const r = this.motions.get(id);
    return r && st ? { result: r.result, current: r.key === this.studyKey(st) } : null;
  }

  /** A study added to the document keeps the results computed while it was set up. */
  keepMotion(from: Id, to: Id) {
    const r = this.motions.get(from);
    if (r) this.motions.set(to, r);
  }

  /** The solver input of a study, or why it cannot run. Components start where the mates put them now. */
  motionSetup(st: MotionStudy): MotionSetup | string {
    const motors = st.motors.filter((m) => !m.suppressed);
    if (!motors.length) return 'Add a motor to drive the mechanism.';
    const { bodies, mates } = this.solverInput();
    const a = this.analysis;
    const held = mates.filter((m) => !a?.conflicts.has(m.id) && !a?.invalid.has(m.id));
    const start = bodies.map((b) => ({ ...b, placement: this.solved.get(b.id) ?? b.placement }));
    const names = new Map<Id, string>([...this.doc.mates.map((m) => [m.id, m.name] as [Id, string]), ...motors.map((m) => [m.id, m.name] as [Id, string])]);
    const store = this.app.store;
    const inputs: MotorInput[] = [];
    for (const mo of motors) {
      // Frequencies and rpm are plain numbers: evaluated as angles are (no length unit is applied).
      const values = (kind: 'length' | 'angle') => ({
        profile: mo.profile, rpm: mo.rpm, reverse: mo.reverse,
        ...Object.fromEntries((['speed', 'amplitude', 'from', 'to'] as const).filter((k) => mo[k] !== undefined).map((k) => [k, store.evalParam(mo[k]!, mo.rpm && k === 'speed' ? 'angle' : kind)])),
        ...(mo.frequency !== undefined ? { frequency: store.evalParam(mo.frequency, 'angle') } : {}),
      });
      try {
        if (mo.kind === 'mate') {
          const mt = this.doc.mates.find((x) => x.id === mo.mate);
          const sm = held.find((x) => x.id === mo.mate);
          if (!mt || (mt.type !== 'distance' && mt.type !== 'angle') || mt.limit) return `${mo.name}: the mate it drives must be a distance or angle mate without limits.`;
          if (!sm) return `${mo.name}: ${mt.name} does not hold (suppressed, or with an error). Fix it to drive it.`;
          inputs.push({ id: mo.id, name: mo.name, kind: 'mate', mate: mt.id, at: profileOf('mate', values(mt.type === 'angle' ? 'angle' : 'length'), st.duration, sm.value) });
          continue;
        }
        const e = mo.ref ? this.entity(mo.ref) : 'It has no axis or direction';
        if (typeof e === 'string') return `${mo.name}: ${e}.`;
        const comp = e.body ? this.component(e.body) : undefined;
        if (!comp || comp.suppressed) return `${mo.name}: its component is suppressed.`;
        if (comp.fixed) return `${mo.name}: ${comp.name} is fixed. Float it, or pick a face or edge of the component to move.`;
        if (e.geo.kind !== 'axis' && e.geo.kind !== 'line' && e.geo.kind !== 'plane') return `${mo.name}: pick a round face or edge, a straight edge or a planar face for its ${mo.kind === 'rotary' ? 'axis' : 'direction'}.`;
        inputs.push({ id: mo.id, name: mo.name, kind: mo.kind, body: comp.id, entity: e, at: profileOf(mo.kind, values(mo.kind === 'rotary' ? 'angle' : 'length'), st.duration) });
      } catch (err) {
        return `${mo.name}: ${(err as Error).message}`;
      }
    }
    return { bodies: start, mates: held, motors: inputs, duration: st.duration, fps: st.fps, scale: this.scale(), names };
  }

  /**
   * Computes a study in slices of a few milliseconds, yielding to the
   * interface between them (it stays responsive, and the progress shows).
   * Null when cancelled; a message when it cannot run.
   */
  async computeMotion(st: MotionStudy, id: Id, onProgress: (f: number) => void, cancelled: () => boolean): Promise<MotionResult | string | null> {
    const setup = this.motionSetup(st);
    if (typeof setup === 'string') return setup;
    const key = this.studyKey(st);
    const run = new MotionRun(setup);
    onProgress(0);
    while (!run.done) {
      const t0 = performance.now();
      while (!run.done && performance.now() - t0 < 12) run.step();
      onProgress(run.progress);
      await yieldToUI();
      if (cancelled() || this.app.assembly !== this) return null;
    }
    this.motions.set(id, { key, result: run.result });
    return run.result;
  }

  dispose() {
    this.preview = null;
    this.explodePreview = null;
  }
}

/** Lets the browser handle input and paint before going on (a message, not a timer: timers are slowed in background tabs). */
function yieldToUI(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(0);
  });
}

/**
 * Dragging components in the graphics area: the grabbed point follows the
 * cursor (Alt, or Rotate Component: the component turns), within what the
 * mates allow. Fixed components do not move; the view turns instead.
 */
class DragTool implements ViewportTool {
  private drag: {
    comp: Id; local: Vec3; plane: { o: Vec3; n: Vec3 }; rotate: boolean; x: number; y: number;
    q0: Quat; from: Map<Id, Placement>; last: Map<Id, Placement> | null;
  } | null = null;

  constructor(private mode: AssemblyMode) {}

  pointerDown(e: VPEvent): boolean {
    const mode = this.mode;
    const app = mode.app;
    if (e.button !== 0 || (e.pointerType === 'touch' && !app.panel?.title.endsWith('Component'))) return false;
    if (app.sketchEditor) return false;
    const hit = app.renderer.pick(e.x, e.y, { face: true }, 0);
    if (!hit || hit.kind !== 'face' || !hit.point) return false;
    const c = mode.faceComponent(hit.index);
    if (!c) return false;
    if (c.fixed) { app.setStatus(`${c.name} is fixed. Float it to move it.`, true); return false; }
    // Its mates leave it no freedom: the view turns, as for a fixed one (a drag would only add an empty undo step).
    if (mode.isDefined(c.id)) { app.setStatus(`${c.name} is fully defined by its mates. Suppress or edit a mate to move it.`, true); return false; }
    if (mode.doc.exploded) { app.setStatus('Collapse the exploded view to move components.', true); return false; }
    const pl = mode.solved.get(c.id) ?? c.placement;
    const inv = { q: [-pl.q[0], -pl.q[1], -pl.q[2], pl.q[3]] as Quat };
    const local = rotateBy(inv.q, sub(hit.point, pl.p));
    this.drag = { comp: c.id, local, plane: { o: hit.point, n: app.renderer.camera.back }, rotate: e.alt || mode.rotateMode, x: e.x, y: e.y, q0: pl.q, from: new Map(mode.solved), last: null };
    return true;
  }

  pointerMove(e: VPEvent, dragging: boolean) {
    const d = this.drag;
    if (!d || !dragging) return;
    const mode = this.mode;
    let goal: DragGoal;
    if (d.rotate) {
      const cam = mode.app.renderer.camera;
      const k = 0.01;
      const q = qMul(qAxisAngle(cam.up, (e.x - d.x) * k), qMul(qAxisAngle(cam.right, (e.y - d.y) * k), d.q0));
      goal = { kind: 'rotate', body: d.comp, q };
    } else {
      const t = rayPlane(e.ray.o, e.ray.d, d.plane.o, d.plane.n);
      if (!t) return;
      goal = { kind: 'move', body: d.comp, local: d.local, target: t };
    }
    d.last = mode.dragSolve(goal, d.last ?? d.from);
    mode.previewPlacements(d.last);
  }

  pointerUp() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.last) this.mode.commitPlacements(d.rotate ? 'Rotate component' : 'Move component', d.last);
    else this.mode.previewPlacements(null);
  }

  click(): boolean {
    this.drag = null;
    return false;
  }
}

function rotateBy(q: Quat, v: Vec3): Vec3 {
  // q v q*, written out to avoid importing another helper.
  const [x, y, z, w] = q;
  const uv = cross([x, y, z], v);
  const uuv = cross([x, y, z], uv);
  return add(v, add(scale(uv, 2 * w), scale(uuv, 2)));
}

function rayPlane(o: Vec3, d: Vec3, p: Vec3, n: Vec3): Vec3 | null {
  const den = dot(d, n);
  if (Math.abs(den) < 1e-9) return null;
  const t = dot(sub(p, o), n) / den;
  return add(o, scale(d, t));
}

/** Faces of a model's face list that belong to a component (tests and panels). */
export function facesOf(faces: FaceInfo[], comp: Id): number[] {
  return faces.map((f, i) => (f.feature === comp ? i : -1)).filter((i) => i >= 0);
}
