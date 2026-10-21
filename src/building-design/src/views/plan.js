/**
 * Plan view controller (floor and ceiling plans): 2D camera, graphics kept
 * in sync with the scene, picking, window selection, snapping features and
 * text overlay.
 */
import { viewMatrix2D } from '../render/renderer2d.js';
import { planContext, PlanBuilder, W } from '../core/plan.js';
import { pointInPolygon, distToSegment, bboxIntersects, bboxContains, segmentIntersectsBox, bboxUnion } from '../core/geom.js';
import { snapFeatures } from '../editor/snap.js';
import { drawLayerTexts } from './overlay.js';

/** Pick priority: lower wins when several elements are under the cursor. */
const PICK_RANK = {
  text: 0,
  tag: 0,
  dimension: 0,
  door: 1,
  window: 1,
  component: 2,
  column: 2,
  stair: 2,
  ramp: 2,
  railing: 2,
  detailLine: 2,
  modelLine: 2,
  roomSeparator: 2,
  areaBoundary: 2,
  wall: 3,
  beam: 3,
  grid: 4,
  refPlane: 4,
  plan: 4,
  ceilingPlan: 4,
  area: 5,
  section: 4,
  elevation: 4,
  room: 5,
  ceiling: 6,
  roof: 6,
  floor: 7,
};

const CELL = 3000;

export class PlanController {
  constructor(app, view) {
    this.app = app;
    this.viewId = view.id;
    this.graphical = true;
    this.is2D = true;
    this.vp = app.viewport;
    this.layer = this.vp.r2.layer();
    this.syncedVersion = -1;
    this.syncedView = null;
    this.grid = new Map();
    this.bounds = new Map();
    this.featureCache = new Map();
    const saved = app.viewStates.get(view.id);
    this.cam = saved ? { ...saved } : null;
  }

  get view() {
    return this.app.doc.get(this.viewId);
  }

  get scene() {
    return this.app.scene;
  }

  activate() {
    if (!this.cam) {
      this.sync();
      this.zoomExtents(false);
    }
  }

  deactivate() {
    this.app.viewStates.set(this.viewId, { ...this.cam });
  }

  dispose() {
    this.layer.dispose();
  }

  // Graphics ----------------------------------------------------------------------

  sync() {
    const view = this.view;
    if (!view) return;
    const scene = this.scene;
    if (this.syncedVersion === scene.version && this.syncedView === view) return;
    const pc = planContext(scene.doc, view, scene.walls, scene.rooms, scene.areas);
    const keep = new Set();
    this.grid.clear();
    this.bounds.clear();
    for (const el of scene.planCandidates(view)) {
      const g = scene.planOf(view, el, pc);
      if (!g) continue;
      keep.add(el.id);
      this.layer.set(el.id, scene.indexOf(el.id), el.kind, g);
      const b = scene.planBounds(view, el.id);
      if (b) {
        this.bounds.set(el.id, b);
        this.index(el.id, b);
      }
    }
    // Underlay: the plan of another level, drawn in halftone and not selectable.
    const under = this.underlayView(view);
    if (under) {
      const upc = planContext(scene.doc, under, scene.walls, scene.rooms);
      for (const el of scene.planCandidates(under)) {
        if (el.viewId || ['section', 'elevation', 'grid', 'room', 'roomSeparator'].includes(el.kind) || keep.has(el.id)) continue;
        const g = scene.planOf(under, el, upc);
        if (!g) continue;
        const key = `u:${el.id}`;
        keep.add(key);
        this.layer.set(key, scene.indexOf(key), el.kind === 'wall' ? 'floor' : el.kind, g);
      }
    }
    // The crop region's outline, when it is shown (not an element: not selectable).
    if (view.cropShow && view.crop) {
      const key = `crop:${view.id}`;
      const r = view.crop;
      const b = new PlanBuilder();
      b.poly(
        [
          [r.x0, r.y0],
          [r.x1, r.y0],
          [r.x1, r.y1],
          [r.x0, r.y1],
        ],
        true,
        W.light,
        1,
      );
      keep.add(key);
      this.layer.set(key, scene.indexOf(key), 'overlay', b);
    }
    this.layer.retain(keep);
    this.syncedVersion = scene.version;
    this.syncedView = view;
    this.featureCache.clear();
  }

  /** Plan view of the underlay level (view.underlay: 'below' | levelId | null). */
  underlayView(view) {
    const doc = this.app.doc;
    let levelId = view.underlay;
    if (!levelId) return null;
    if (levelId === 'below') {
      const lv = doc.levels();
      const i = lv.findIndex((l) => l.id === view.levelId);
      levelId = i > 0 ? lv[i - 1].id : null;
    }
    if (!levelId || levelId === view.levelId) return null;
    const base = doc.all('plan').find((p) => p.levelId === levelId);
    if (!base) return null;
    // Same object while its inputs are unchanged, so cached graphics stay valid.
    if (this._under?.base === base && this._under.view === view) return this._under.v;
    const v = { ...base, id: `${view.id}:underlay`, hiddenIds: view.hiddenIds, hiddenCats: view.hiddenCats, scale: view.scale, detail: 'coarse' };
    this._under = { base, view, v };
    return v;
  }

  index(id, b) {
    const x0 = Math.floor(b.x0 / CELL);
    const x1 = Math.floor(b.x1 / CELL);
    const y0 = Math.floor(b.y0 / CELL);
    const y1 = Math.floor(b.y1 / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4000) {
      // Very large items live in a catch-all bucket.
      if (!this.grid.has('big')) this.grid.set('big', new Set());
      this.grid.get('big').add(id);
      return;
    }
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        if (!this.grid.has(k)) this.grid.set(k, new Set());
        this.grid.get(k).add(id);
      }
  }

  /** Ids whose bounds touch a model-space box. */
  query(box) {
    const out = new Set(this.grid.get('big') || []);
    const x0 = Math.floor(box.x0 / CELL);
    const x1 = Math.floor(box.x1 / CELL);
    const y0 = Math.floor(box.y0 / CELL);
    const y1 = Math.floor(box.y1 / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 2500) {
      for (const id of this.bounds.keys()) out.add(id);
      return [...out].filter((id) => bboxIntersects(this.bounds.get(id) || box, box));
    }
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const s = this.grid.get(`${x},${y}`);
        if (s) for (const id of s) out.add(id);
      }
    return [...out].filter((id) => {
      const b = this.bounds.get(id);
      return b && bboxIntersects(b, box);
    });
  }

  render(vp) {
    this.sync();
    if (!this.cam) this.zoomExtents(false);
    const view = this.view;
    const scale = +view?.scale || 100;
    this.vp.r2.draw(this.layer, this.camera(), vp.theme, { dashScale: scale, spacing: scale * 1.6, thin: this.app.settings.thinLines });
  }

  camera() {
    const vp = this.vp;
    const { cx, cy, zoom } = this.cam;
    return {
      matrix: viewMatrix2D(cx, cy, zoom, vp.width, vp.height, this.layer.origin),
      width: vp.canvas.width,
      height: vp.canvas.height,
      dpr: vp.dpr,
    };
  }

  drawOverlay(ctx, vp) {
    if (this.app.settings.workPlaneGrid) this.drawWorkPlane(ctx, vp);
    drawLayerTexts(ctx, this.layer, (p) => this.modelToScreen(p), this.cam.zoom, vp.theme, (id) => this.app.flagsOf(id));
  }

  /** A light grid on the level, spaced so lines stay at least ~28 px apart. */
  drawWorkPlane(ctx, vp) {
    const imp = this.app.doc.units.system === 'imperial';
    const steps = imp ? [152.4, 304.8, 609.6, 1524, 3048, 6096, 15240, 30480] : [100, 250, 500, 1000, 2500, 5000, 10000, 25000];
    const step = steps.find((s) => s * this.cam.zoom >= 28) ?? steps.at(-1);
    const a = this.screenToModel(0, vp.height);
    const b = this.screenToModel(vp.width, 0);
    ctx.save();
    ctx.strokeStyle = vp.theme.inkCss;
    ctx.lineWidth = 1;
    for (const major of [false, true]) {
      const s = major ? step * 5 : step;
      ctx.globalAlpha = major ? 0.14 : 0.06;
      ctx.beginPath();
      for (let x = Math.ceil(a[0] / s) * s; x <= b[0]; x += s) {
        const px = Math.round(this.modelToScreen([x, 0]).x) + 0.5;
        ctx.moveTo(px, 0);
        ctx.lineTo(px, vp.height);
      }
      for (let y = Math.ceil(a[1] / s) * s; y <= b[1]; y += s) {
        const py = Math.round(this.modelToScreen([0, y]).y) + 0.5;
        ctx.moveTo(0, py);
        ctx.lineTo(vp.width, py);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // Coordinates -----------------------------------------------------------------------

  screenToModel(x, y) {
    const { cx, cy, zoom } = this.cam;
    return [cx + (x - this.vp.width / 2) / zoom, cy - (y - this.vp.height / 2) / zoom];
  }

  modelToScreen(p) {
    const { cx, cy, zoom } = this.cam;
    return { x: (p[0] - cx) * zoom + this.vp.width / 2, y: this.vp.height / 2 - (p[1] - cy) * zoom };
  }

  mmPerPx() {
    return 1 / this.cam.zoom;
  }

  /** Until the user navigates, keep the view fitted when the canvas resizes. */
  resized() {
    if (!this.userMoved && this.cam) this.zoomExtents(false);
  }

  pan(dx, dy) {
    this.userMoved = true;
    this.cam.cx -= dx / this.cam.zoom;
    this.cam.cy += dy / this.cam.zoom;
  }

  zoomAt(x, y, f) {
    this.userMoved = true;
    const before = this.screenToModel(x, y);
    this.cam.zoom = Math.max(1e-5, Math.min(50, this.cam.zoom * f));
    const after = this.screenToModel(x, y);
    this.cam.cx += before[0] - after[0];
    this.cam.cy += before[1] - after[1];
  }

  zoomBy(f) {
    this.zoomAt(this.vp.width / 2, this.vp.height / 2, f);
    this.vp.requestRender();
  }

  extents(ids = null) {
    let b = null;
    for (const [id, bb] of this.bounds) {
      if (ids && !ids.has(id)) continue;
      const el = this.app.doc.get(id);
      // Markers far from the model would make the fit too loose.
      if (!ids && (el?.kind === 'elevation' || el?.kind === 'section')) continue;
      b = bboxUnion(b, bb);
    }
    return b;
  }

  zoomExtents(render = true, ids = null) {
    this.sync();
    const b = this.extents(ids) || { x0: -5000, y0: -5000, x1: 15000, y1: 12000 };
    this.zoomToBox(b, render);
  }

  zoomToBox(b, render = true) {
    const w = Math.max(1000, b.x1 - b.x0);
    const h = Math.max(1000, b.y1 - b.y0);
    const zoom = Math.min((this.vp.width * 0.86) / w, (this.vp.height * 0.86) / h);
    this.cam = { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, zoom: Math.max(1e-5, Math.min(50, zoom)) };
    if (render) this.vp.requestRender();
  }

  // Picking ----------------------------------------------------------------------------

  /** Ids under a screen point, best first. */
  hitTest(x, y, tolPx = 6) {
    this.sync();
    const p = this.screenToModel(x, y);
    const tol = tolPx / this.cam.zoom;
    const cands = this.query({ x0: p[0] - tol, y0: p[1] - tol, x1: p[0] + tol, y1: p[1] + tol });
    const hits = [];
    for (const id of cands) {
      const it = this.layer.items.get(id);
      if (!it || !this.app.doc.has(id)) continue;
      if (this.app.flagsOf(id) & 4) continue;
      const g = it.g;
      let d = Infinity;
      for (const poly of g.picks) if (pointInPolygon(p, poly)) d = 0;
      if (d > 0) for (const l of g.lines) d = Math.min(d, distToSegment(p, l.a, l.b));
      if (d > tol) continue;
      hits.push({ id, d, rank: PICK_RANK[it.kind] ?? 3 });
    }
    hits.sort((a, b) => a.rank - b.rank || a.d - b.d);
    return hits.map((h) => h.id);
  }

  /** Window (inside) or crossing selection with a model-space box. */
  boxSelect(box, crossing) {
    this.sync();
    const out = [];
    for (const id of this.query(box)) {
      const it = this.layer.items.get(id);
      if (!it || !this.app.doc.has(id) || this.app.flagsOf(id) & 4) continue;
      const b = this.bounds.get(id);
      if (!b) continue;
      if (bboxContains(box, b)) {
        out.push(id);
        continue;
      }
      if (!crossing) continue;
      const g = it.g;
      let hit = g.lines.some((l) => segmentIntersectsBox(l.a, l.b, box));
      if (!hit) for (const poly of g.picks) if (pointInPolygon([box.x0, box.y0], poly) || poly.some((q) => q[0] >= box.x0 && q[0] <= box.x1 && q[1] >= box.y0 && q[1] <= box.y1)) hit = true;
      if (hit) out.push(id);
    }
    return out;
  }

  /** Snap features of elements near a model point. */
  snapFeaturesNear(p, r, exclude) {
    this.sync();
    const out = [];
    for (const id of this.query({ x0: p[0] - r, y0: p[1] - r, x1: p[0] + r, y1: p[1] + r })) {
      if (exclude?.has(id)) continue;
      const el = this.app.doc.get(id);
      if (!el) continue;
      let f = this.featureCache.get(id);
      if (!f) {
        f = snapFeatures(this.scene, el);
        this.featureCache.set(id, f);
      }
      out.push(f);
    }
    return out;
  }
}
