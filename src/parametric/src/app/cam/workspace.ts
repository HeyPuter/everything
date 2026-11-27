// The CAM state of the open part: the mesh the CAM engine works on, the
// toolpath generated for each operation (kept until the part, the operation,
// its tool or its setup changes), generation in the CAM worker, and the
// toolpaths, stock and work origin drawn in the graphics area.

import { CamCancelled, CamClient } from '../../cam/client';
import { type GenerateJob, type ModelCylinder, stlTriangles } from '../../cam/engine';
import { type MachineFrame, machineFrame, toModel } from '../../cam/frame';
import { PLUNGE, RAPID, type PathStats, type Toolpath, expandMoves, pathStats } from '../../cam/toolpath';
import type { Vec3 } from '../../math/vec';
import { type CamDoc, type CamOperation, type CamSetup, type CamTool, findOp, newCamDoc, opFeeds } from '../../model/cam';
import { allocateId } from '../../model/document';
import type { FaceRef, Id } from '../../model/types';
import type { App } from '../app';

export type OpState = 'none' | 'busy' | 'ok' | 'stale' | 'error' | 'suppressed';

interface OpResult {
  key: string;
  toolpath?: Toolpath;
  stats?: PathStats;
  error?: string;
}

const placementKey = (s: CamSetup) => JSON.stringify([s.axis, s.rotation, s.origin, s.stock]);

/** Colours of the toolpath moves (RGBA). */
const COLORS: Record<number, number[]> = {
  [RAPID]: [225, 150, 30, 235],
  1: [40, 110, 230, 255],
  [PLUNGE]: [30, 160, 90, 255],
};

export class CamWorkspace {
  readonly client = new CamClient();
  /** A second worker for the preview of the operation being edited, so it never waits for (or stops) generation. */
  private readonly previewClient = new CamClient();
  private results = new Map<Id, OpResult>();
  private meshVersion = -1;
  private tris: Float32Array | null = null;
  private loading: Promise<Float32Array | null> | null = null;
  private frames = new Map<string, MachineFrame | null>();
  private queue: Promise<void> = Promise.resolve();
  /** The operation being generated, with its progress. */
  busy: { id: Id; progress: number } | null = null;
  /** The operation or setup whose toolpaths show (null: all). */
  focus: Id | null = null;
  /** Toolpath shown in place of an operation's while its panel is open. */
  preview: { setup: CamSetup; op: CamOperation | null; toolpath: Toolpath | null } | null = null;
  /** Hides the toolpaths (the simulation shows its own). */
  hidePaths = false;
  /** Called when results change (the design tree and panels redraw). */
  readonly listeners = new Set<() => void>();
  private generation = 0;

  constructor(private readonly app: App) {
    app.ribbonTabListeners.push(() => this.redraw());
    app.store.on((reason) => {
      if (reason === 'load') this.reset();
      this.redraw();
    });
    app.commands.onChange(() => {
      if (app.geometryVersion !== this.meshVersion && this.tris) {
        // The part changed: its toolpaths are out of date (kept, marked, until generated again).
        this.tris = null;
        this.frames.clear();
        this.changed();
      }
    });
  }

  private reset() {
    this.client.cancel();
    this.previewClient.cancel();
    this.results.clear();
    this.tris = null;
    this.meshVersion = -1;
    this.frames.clear();
    this.focus = null;
    this.preview = null;
    this.busy = null;
    this.generation++;
  }

  get cam(): CamDoc | null {
    return this.app.store.doc.cam ?? null;
  }

  /** The part's CAM data, created (as an undo step) the first time it is needed. */
  ensureCam(): CamDoc {
    const doc = this.app.store.doc;
    if (!doc.cam) this.app.store.change('Start CAM', (d) => { d.cam = newCamDoc((p) => allocateId(d, p), d.units === 'IPS'); });
    return this.app.store.doc.cam!;
  }

  changed() {
    this.redraw();
    for (const fn of this.listeners) fn();
  }

  // ---------- geometry ----------

  /** Can CAM work on the part now (a body, not rolled back to a feature being edited)? */
  ready(): string | null {
    const app = this.app;
    if (app.assembly) return 'CAM works on parts. Open the part to machine it.';
    if (!app.bbox) return 'The part has no solid body to machine yet.';
    if (app.panel?.editingId || app.sketchEditor) return 'Finish the feature or sketch being edited first.';
    return null;
  }

  /** The part's triangles in model coordinates (a fine mesh from the kernel), current with the model. */
  async mesh(): Promise<Float32Array | null> {
    const app = this.app;
    await app.whenBuilt();
    const version = app.geometryVersion;
    if (this.tris && this.meshVersion === version) return this.tris;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const data = await app.kernel.exportFile('stl', 2);
        const tris = stlTriangles(data);
        if (app.geometryVersion !== version) return this.mesh();
        this.tris = tris.length ? tris : null;
        this.meshVersion = version;
        this.frames.clear();
        if (this.tris) for (const c of [this.client, this.previewClient]) c.setMesh(`g${version}`, this.tris);
        return this.tris;
      } catch {
        return null;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** Where a setup puts the part (its machine frame), from the current mesh. */
  frameOf(setup: CamSetup): MachineFrame | null {
    if (!this.tris) return null;
    const key = placementKey(setup);
    if (!this.frames.has(key)) this.frames.set(key, machineFrame(setup, this.tris));
    return this.frames.get(key) ?? null;
  }

  // ---------- operations ----------

  toolOf(op: CamOperation): CamTool | null {
    return this.cam?.tools.find((t) => t.id === op.tool) ?? null;
  }

  faceIndex(ref: FaceRef): number {
    const faces = this.app.faces;
    const i = faces.findIndex((f) => f.name === ref.name);
    if (i >= 0) return i;
    // A face renamed by a change: the nearest of the same kind and size.
    let best = -1, bd = Infinity;
    faces.forEach((f, k) => {
      if (f.type !== ref.sig.type) return;
      const d = Math.hypot(f.center[0] - ref.sig.c[0], f.center[1] - ref.sig.c[1], f.center[2] - ref.sig.c[2]) + Math.abs(f.area - ref.sig.area) * 1e-3;
      if (d < bd) { bd = d; best = k; }
    });
    return bd < 1e-3 ? best : -1;
  }

  /** The triangles of a face of the shown model. */
  faceTriangles(index: number): Float32Array {
    const m = this.app.modelMesh;
    if (!m) return new Float32Array(0);
    const out: number[] = [];
    const idx = m.indices, P = m.positions, vf = m.vertexFace;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t];
      if (Math.round(vf[a]) !== index) continue;
      for (let k = 0; k < 3; k++) { const v = idx[t + k] * 3; out.push(P[v], P[v + 1], P[v + 2]); }
    }
    return Float32Array.from(out);
  }

  /** Cylindrical faces of the part (hole candidates). */
  cylinders(): ModelCylinder[] {
    return this.app.faces.flatMap((f, i) => (f.type === 'cylinder' && f.axis && f.radius && !f.body
      ? [{ name: f.name, p: f.axis.p, d: f.axis.d, radius: f.radius, tris: this.faceTriangles(i) }]
      : []));
  }

  jobFor(setup: CamSetup, op: CamOperation): GenerateJob {
    const tool = this.toolOf(op);
    if (!tool) throw new Error('The operation\'s tool is no longer in the tool library. Choose another tool.');
    const job: GenerateJob = { setup, op, tool };
    if (op.type === 'pocket') {
      job.floors = op.faces.map((f) => this.faceIndex(f)).filter((i) => i >= 0).map((i) => this.faceTriangles(i)).filter((t) => t.length);
      if (op.faces.length && job.floors.length < op.faces.length) throw new Error('A picked floor is no longer in the part. Pick the floors again.');
    }
    if (op.type === 'drill' || op.type === 'bore') {
      job.cylinders = this.cylinders();
      const names = op.holes.map((h) => this.faceIndex(h.face)).filter((i) => i >= 0).map((i) => this.app.faces[i].name);
      if (op.holes.length && !names.length) throw new Error('The picked holes are no longer in the part. Pick them again.');
      job.picked = names;
    }
    return job;
  }

  private keyOf(setup: CamSetup, op: CamOperation): string {
    const { name: _n, suppressed: _s, rpm: _r, feed: _f, plunge: _p, ...shape } = op;
    void _n; void _s; void _r; void _f; void _p;
    const tool = this.toolOf(op);
    const t = tool ? { ...tool, name: '', number: 0, rpm: 0, feed: 0, plunge: 0, coolant: false } : null;
    return JSON.stringify([this.meshVersion, placementKey(setup), setup.clearance, setup.retract, shape, t]);
  }

  result(id: Id): OpResult | null {
    return this.results.get(id) ?? null;
  }

  state(setup: CamSetup, op: CamOperation): OpState {
    if (op.suppressed) return 'suppressed';
    if (this.busy?.id === op.id) return 'busy';
    const r = this.results.get(op.id);
    if (!r) return 'none';
    if (!this.tris || r.key !== this.keyOf(setup, op)) return 'stale';
    return r.error ? 'error' : 'ok';
  }

  /** Statistics of an operation's toolpath at its feeds. */
  statsOf(op: CamOperation): PathStats | null {
    const r = this.results.get(op.id);
    const tool = this.toolOf(op);
    if (!r?.toolpath || !tool) return null;
    const f = opFeeds(op, tool);
    return pathStats(r.toolpath, f.feed, f.plunge, this.cam?.post.rapidFeed ?? 5000);
  }

  /**
   * Generates the toolpaths of operations that are not up to date (all, or
   * those given). Runs one operation at a time; resolves when they are done.
   */
  generate(ids?: Id[]): Promise<void> {
    const gen = this.generation;
    const run = async () => {
      if (gen !== this.generation) return;
      const why = this.ready();
      if (why) { this.app.setStatus(why, true); return; }
      const tris = await this.mesh();
      if (gen !== this.generation) return;
      if (!tris) { this.app.setStatus('The part has no solid body to machine.', true); return; }
      const cam = this.cam;
      if (!cam) return;
      const list = cam.setups.flatMap((s) => s.ops.filter((o) => !o.suppressed && (!ids || ids.includes(o.id) || ids.includes(s.id))).map((o) => ({ s, o })));
      let failed = 0;
      for (const { o } of list) {
        if (gen !== this.generation) return;
        // Read again: an edit while an earlier one ran may have changed it.
        const now = this.cam && findOp(this.cam, o.id);
        if (!now || now.op.suppressed) continue;
        const key = this.keyOf(now.setup, now.op);
        if (this.results.get(o.id)?.key === key) continue;
        let job: GenerateJob;
        try { job = this.jobFor(now.setup, now.op); } catch (e) { this.results.set(o.id, { key, error: (e as Error).message }); failed++; this.changed(); continue; }
        this.busy = { id: o.id, progress: 0 };
        this.changed();
        this.app.setStatus(`Generating ${now.op.name}...`);
        try {
          const tp = await this.client.generate(job, (v) => {
            if (this.busy?.id === o.id) { this.busy.progress = v; this.app.setStatus(`Generating ${now.op.name}... ${Math.round(v * 100)}%`); for (const fn of this.listeners) fn(); }
          });
          if (gen !== this.generation) return;
          this.results.set(o.id, { key, toolpath: tp });
        } catch (e) {
          if (e instanceof CamCancelled) { this.busy = null; this.changed(); return; }
          this.results.set(o.id, { key, error: (e as Error).message });
          failed++;
        }
        this.busy = null;
        this.changed();
      }
      this.app.setStatus(failed ? `${failed} operation${failed === 1 ? '' : 's'} could not be generated` : 'Toolpaths are up to date', !!failed);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Generates a toolpath for an operation being edited (not stored), for its panel's preview. */
  async previewOf(setup: CamSetup, op: CamOperation): Promise<Toolpath> {
    const tris = await this.mesh();
    if (!tris) throw new Error('The part has no solid body to machine.');
    // Only the newest preview matters.
    this.previewClient.cancel();
    return this.previewClient.generate(this.jobFor(setup, op));
  }

  previewClientCancel() {
    this.previewClient.cancel();
  }

  /** Stops generation in progress. */
  cancel() {
    this.client.cancel();
    this.busy = null;
    this.changed();
  }

  /** Drops the toolpaths of operations that are gone. */
  prune(keep: Set<Id>) {
    const gone = [...this.results.keys()].filter((id) => !keep.has(id));
    if (gone.length) this.forget(gone);
  }

  forget(ids: Id[]) {
    for (const id of ids) this.results.delete(id);
    this.changed();
  }

  // ---------- display ----------

  /** Are CAM overlays wanted now (the CAM tab or a CAM panel)? */
  private shown(): boolean {
    const app = this.app;
    if (app.inDrawing || app.assembly || app.sketchEditor) return false;
    return app.ribbonTabId === 'cam' || !!this.preview || !!(app.panel as { camPanel?: boolean } | null)?.camPanel;
  }

  redraw() {
    const r = this.app.renderer;
    if (!r) return;
    const cam = this.cam;
    if (!cam || !this.shown() || !this.tris) {
      for (const k of ['camRapid', 'camCut', 'camStock', 'camWcs']) r.setLines(k, null);
      if (cam && this.shown() && !this.tris && !this.loading && !this.ready()) void this.mesh().then((t) => { if (t) this.redraw(); });
      return;
    }
    const rapid: number[] = [], rc: number[] = [], cut: number[] = [], cc: number[] = [];
    const focusSetup = this.focus ? cam.setups.find((s) => s.id === this.focus || s.ops.some((o) => o.id === this.focus)) : null;
    const add = (setup: CamSetup, tp: Toolpath) => {
      const f = this.frameOf(setup);
      if (!f) return;
      let prev: Vec3 | null = null;
      expandMoves(tp, (k, x, y, z) => {
        const p = toModel(f, x, y, z);
        if (prev) {
          const into = k === RAPID ? rapid : cut;
          const col = k === RAPID ? rc : cc;
          into.push(...prev, ...p);
          col.push(...(COLORS[k] ?? COLORS[1]));
        }
        prev = p;
      });
    };
    if (!this.hidePaths) {
      if (this.preview) {
        if (this.preview.toolpath) add(this.preview.setup, this.preview.toolpath);
      } else {
        for (const s of cam.setups) {
          if (focusSetup && s !== focusSetup) continue;
          for (const o of s.ops) {
            if (o.suppressed) continue;
            if (this.focus && this.focus !== s.id && this.focus !== o.id) continue;
            const res = this.results.get(o.id);
            if (res?.toolpath) add(s, res.toolpath);
          }
        }
      }
    }
    r.setLines('camRapid', rapid.length ? { positions: new Float32Array(rapid), colors: new Uint8Array(rc), width: 1, depth: 'test', dash: 5, order: 7, clip: false } : null);
    r.setLines('camCut', cut.length ? { positions: new Float32Array(cut), colors: new Uint8Array(cc), width: 1.4, depth: 'test', order: 7, clip: false } : null);
    // The stock and work origin of the setup shown (or the first).
    const setup = this.preview?.setup ?? focusSetup ?? cam.setups[0];
    const f = setup ? this.frameOf(setup) : null;
    if (!f) { r.setLines('camStock', null); r.setLines('camWcs', null); return; }
    const { min, max } = f.stock;
    const c = (i: number): Vec3 => toModel(f, i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]);
    const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const sp: number[] = [], scol: number[] = [];
    for (const [a, b] of edges) { sp.push(...c(a), ...c(b)); scol.push(120, 130, 145, 200); }
    r.setLines('camStock', { positions: new Float32Array(sp), colors: new Uint8Array(scol), width: 1, depth: 'test', dash: 3, order: 6, clip: false });
    const size = Math.max(5, Math.min(30, Math.hypot(max[0] - min[0], max[1] - min[1]) * 0.15));
    const o = toModel(f, 0, 0, 0);
    const wp: number[] = [...o, ...toModel(f, size, 0, 0), ...o, ...toModel(f, 0, size, 0), ...o, ...toModel(f, 0, 0, size)];
    r.setLines('camWcs', { positions: new Float32Array(wp), colors: new Uint8Array([220, 50, 50, 255, 40, 170, 60, 255, 50, 90, 220, 255]), width: 2.5, depth: 'always', order: 8 });
  }
}

