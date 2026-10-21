/**
 * Scene: derived data for a document, kept in sync with its edits.
 *
 *   - wall joins and room regions per level (WallSolver, RoomSolver)
 *   - 3D meshes per element
 *   - plan graphics per (view, element)
 *
 * Each cached result remembers the inputs it was built from (the element,
 * its type, levels, host, solved wall outline...). Items are immutable, so
 * comparing those inputs by identity tells whether to rebuild.
 */
import { WallSolver, hubsOf } from './walls.js';
import { RoomSolver, AreaSolver } from './rooms.js';
import { build3D } from './build3d.js';
import { planGraphics, planContext, columnOutline, hiddenInView, PlanBuilder } from './plan.js';
import { phasesInOrder, phaseLook, phased } from './phases.js';
import { hostedBy } from './model.js';
import { ANNOTATION_KINDS } from './annotate.js';
import { hiddenByFilters, viewGraphics, restyle, viewFilterItems } from './graphics.js';
import { worksharingOn, worksetable, worksetOf, worksetColor } from './worksets.js';
import { cropGraphics } from './crop.js';
import { MEP_KINDS, connected } from './mep.js';
import { isView, Doc } from './doc.js';
import { upgradeDoc } from './template.js';
import { linkFrame, linkedLevel, appendPlan, combineMeshes } from './links.js';

export const MODEL_KINDS = ['topo', 'wall', 'floor', 'ceiling', 'roof', 'door', 'window', 'column', 'beam', 'brace', 'footing', 'wallFooting', 'stair', 'ramp', 'railing', 'component', 'modelLine', ...MEP_KINDS, 'mass', 'link'];
export const PLAN_KINDS = [...MODEL_KINDS, 'space', 'room', 'roomSeparator', 'area', 'areaBoundary', 'grid', 'refPlane', 'propertyLine', 'region', 'dimension', 'text', 'tag', 'treadNumbers', 'detailLine', ...ANNOTATION_KINDS, 'section', 'elevation'];

const LEVEL_SCOPED = new Set(['wall', 'roomSeparator', 'column', 'room', 'space', 'floor', 'ceiling', 'roof', 'stair', 'ramp', 'railing', 'component', 'beam', 'brace', 'footing', 'modelLine', 'area', 'areaBoundary', 'mass', ...MEP_KINDS]);

/** 2D views that show only their own annotations. */
export const DRAWN_ONLY = new Set(['drafting', 'legend']);

/** Kinds drawn only in area plans, and kinds area plans leave out. */
const AREA_ONLY = new Set(['area', 'areaBoundary']);
const NOT_IN_AREA_PLANS = new Set(['room', 'roomSeparator']);

export class Scene {
  constructor(doc) {
    this.doc = doc;
    this.walls = new WallSolver(doc);
    this.rooms = new RoomSolver(doc, this.walls, (c) => columnOutline(doc, c));
    this.areas = new AreaSolver(doc);
    this.meshes = new Map();
    this.plans = new Map();
    this.links = new Map();
    this.known = new Map();
    this.version = 0;
    this.listeners = new Set();
    this.index = new Map();
    this.ids = [];
    for (const it of doc.items.values()) this.remember(it);
    this.off = doc.on((ev) => this.changed(ev));
  }

  dispose() {
    this.off?.();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Small integer per element id, for GPU picking and state textures. */
  indexOf(id) {
    let i = this.index.get(id);
    if (i === undefined) {
      i = this.ids.length + 1;
      this.ids.push(id);
      this.index.set(id, i);
    }
    return i;
  }

  idAt(index) {
    return index > 0 ? this.ids[index - 1] ?? null : null;
  }

  remember(it) {
    this.known.set(it.id, { kind: it.kind, levelId: it.levelId ?? this.doc.get(it.hostId)?.levelId ?? null });
  }

  changed(ev) {
    const doc = this.doc;
    let all = false;
    let columnType = false;
    const levels = new Set();
    for (const id of ev.ids) {
      const now = doc.get(id);
      const before = this.known.get(id);
      const kind = now?.kind ?? before?.kind;
      if (kind === 'level' || kind === 'wallType' || kind === 'material' || kind === 'project') all = true;
      if (kind === 'phase') this.plans.clear();
      // Column outlines bound rooms, and their size lives on the type.
      if (kind === 'columnType') columnType = true;
      if (LEVEL_SCOPED.has(kind)) {
        if (before?.levelId) levels.add(before.levelId);
        if (now?.levelId) levels.add(now.levelId);
      }
      if (now) this.remember(now);
      else this.known.delete(id);
      if (kind === 'material' || kind === 'project') {
        this.meshes.clear();
        this.plans.clear();
      }
    }
    // Room boundaries are recomputed when an edit is committed, not on every
    // frame of a drag (they are the most expensive derived data).
    const rooms = !ev.preview;
    if (all) {
      this.walls.invalidate();
      if (rooms) this.rooms.invalidate();
      this.areas.invalidate();
    } else {
      if (columnType && rooms) this.rooms.invalidate();
      for (const l of levels) {
        this.walls.invalidate(l);
        if (rooms) this.rooms.invalidate(l);
        this.areas.invalidate(l);
      }
    }
    for (const id of ev.ids) if (!doc.has(id)) this.meshes.delete(id);
    this.version++;
    for (const fn of this.listeners) fn(ev);
  }

  /** Inputs a 3D mesh depends on. */
  deps3D(el) {
    const doc = this.doc;
    const d = [el, doc.get(el.typeId), doc.get(el.levelId), doc.get(el.topLevelId)];
    if (el.kind === 'wall') {
      if (el.attachTopId) {
        const roof = doc.get(el.attachTopId);
        d.push(roof, roof && doc.get(roof.typeId), roof && doc.get(roof.levelId));
      }
      const g = this.walls.wall(el.id);
      d.push(g ? wallSignature(g) : null);
      for (const h of hostedBy(doc, el.id)) d.push(h, doc.get(h.typeId));
      for (const hub of hubsOf(this.walls.level(el.levelId), el.id)) d.push(hub.poly.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(';'));
    } else if (el.hostId) {
      const host = doc.get(el.hostId);
      d.push(host, host && doc.get(host.typeId), host && doc.get(host.levelId), host && doc.get(host.topLevelId));
    } else if (el.kind === 'wallFooting') {
      const w = doc.get(el.wallId);
      d.push(w, w && doc.get(w.typeId), w && doc.get(w.levelId));
    } else if (MEP_KINDS.includes(el.kind)) d.push(`${connected(doc, el, el.a)}|${connected(doc, el, el.b)}`);
    return d;
  }

  /** Cached mesh of a model element (null when it has no 3D geometry). */
  mesh(el) {
    const deps = this.deps3D(el);
    const c = this.meshes.get(el.id);
    if (c && sameDeps(c.deps, deps)) return c.mesh;
    let mesh = null;
    try {
      mesh = el.kind === 'link' ? this.linkMesh(el) : build3D(this.ctx3d(), el);
    } catch (err) {
      console.warn('Could not build', el.kind, el.id, err);
    }
    this.meshes.set(el.id, { deps, mesh });
    return mesh;
  }

  ctx3d() {
    return { doc: this.doc, walls: this.walls, material: (id) => this.doc.get(id) };
  }

  /** Elements that a plan view could show (filtering by view rules happens per element). */
  planCandidates(view) {
    const doc = this.doc;
    const out = [];
    // Drafting views and legends show only what is drawn in them.
    if (DRAWN_ONLY.has(view.kind)) {
      for (const el of doc.items.values()) if (el.viewId === view.id && !hiddenInView(doc, view, el)) out.push(el);
      return out;
    }
    // Callouts made in this view show their marker here.
    for (const v of doc.all(view.kind)) if (v.calloutOf === view.id) out.push(v);
    const areaPlan = view.kind === 'areaPlan';
    const phases = phasesInOrder(doc);
    for (const k of PLAN_KINDS) {
      if (areaPlan ? NOT_IN_AREA_PLANS.has(k) : AREA_ONLY.has(k)) continue;
      for (const el of doc.all(k)) {
        if (el.viewId && el.viewId !== view.id) continue;
        if (areaPlan && AREA_ONLY.has(k) && (el.scheme || 'gross') !== (view.scheme || 'gross')) continue;
        if (k === 'section' || k === 'elevation') {
          if (view.kind !== 'plan' && view.kind !== 'areaPlan') continue;
        }
        if (hiddenInView(doc, view, el) || hiddenByFilters(doc, view, el)) continue;
        if (phases.length > 1 && phased(el) && phaseLook(doc, view, el, phases) === 'hidden') continue;
        out.push(el);
      }
    }
    return out;
  }

  /** Inputs of an element's plan graphics, beyond its 3D inputs. */
  depsPlan(view, el, pc) {
    const doc = this.doc;
    const d = [view, doc.get(view.levelId), ...this.deps3D(el), ...viewFilterItems(doc, view)];
    if (el.kind === 'room' || el.kind === 'space') d.push(this.rooms.room(el), doc.get(el.zoneId));
    else if (el.kind === 'area') d.push(this.areas.area(el));
    else if (el.kind === 'dimension') for (const r of el.refs || []) d.push(doc.get(r.id));
    else if (el.kind === 'tag') {
      const t = doc.get(el.targetId);
      d.push(t, t && doc.get(t.hostId), t && doc.get(t.typeId), t?.kind === 'room' ? this.rooms.room(t) : t?.kind === 'area' ? this.areas.area(t) : null);
    } else if (el.kind === 'stair') d.push(doc.levelAbove(el.levelId));
    else if (el.kind === 'treadNumbers') d.push(doc.get(el.stairId), doc.get(doc.get(el.stairId)?.typeId), doc.get(doc.get(el.stairId)?.topLevelId));
    else if (el.kind === 'radialDim') d.push(doc.get(el.targetId), doc.get(doc.get(el.targetId)?.typeId));
    else if (el.kind === 'revisionCloud') d.push(doc.get(el.revisionId));
    // These read other elements of the model: redraw them after any change.
    else if (el.kind === 'spot' || el.kind === 'colorLegend') d.push(this.version, doc.get('project'));
    void pc;
    return d;
  }

  /** Cached plan graphics of an element in a view. */
  planOf(view, el, pc = null) {
    let cache = this.plans.get(view.id);
    if (!cache) this.plans.set(view.id, (cache = new Map()));
    const ctx = pc || planContext(this.doc, view, this.walls, this.rooms, this.areas);
    const deps = this.depsPlan(view, el, ctx);
    const c = cache.get(el.id);
    if (c && sameDeps(c.deps, deps)) return c.g;
    let g = null;
    try {
      g = el.kind === 'link' ? this.linkPlan(view, el) : planGraphics(ctx, el);
      if (g && (view.overrides || view.filters?.length || view.elOverrides || this.doc.get('project')?.objectStyles)) g = restyle(g, viewGraphics(this.doc, view, el));
      if (g && view.cropOn && view.crop && !el.viewId && !isView(el) && el.kind !== 'section' && el.kind !== 'elevation') g = cropGraphics(g, view.crop);
      if (g && phased(el) && phaseLook(this.doc, view, el) === 'dashed') g = dashed(g);
      if (g && view.wsDisplay === 'worksets' && worksharingOn(this.doc) && worksetable(this.doc, el)) g = restyle(g, { color: worksetColor(this.doc, worksetOf(this.doc, el)?.id) });
    } catch (err) {
      console.warn('Could not draw', el.kind, el.id, err);
    }
    cache.set(el.id, { deps, g, bounds: g?.bounds() ?? null });
    return g;
  }

  planBounds(view, id) {
    return this.plans.get(view.id)?.get(id)?.bounds ?? null;
  }

  /** Drop caches of views that no longer exist. */
  prune() {
    for (const id of this.plans.keys()) if (!this.doc.has(id)) this.plans.delete(id);
    for (const id of this.links.keys()) if (!this.doc.has(id)) this.links.delete(id);
  }

  // Linked projects ---------------------------------------------------------------------

  /** The linked project of a link element: { doc, scene } (parsed once per snapshot). */
  link(el) {
    let e = this.links.get(el.id);
    if (e && e.data === el.data) return e;
    let doc = null;
    try {
      doc = upgradeDoc(Doc.fromJSON(JSON.parse(el.data)));
    } catch {
      doc = null;
    }
    e = { data: el.data, doc, scene: doc ? new Scene(doc) : null, views: new Map() };
    this.links.set(el.id, e);
    return e;
  }

  linkMesh(el) {
    const { scene } = this.link(el);
    if (!scene) return null;
    const meshes = [];
    for (const k of MODEL_KINDS) {
      if (k === 'link') continue;
      for (const x of scene.doc.all(k)) {
        const m = scene.mesh(x);
        if (m?.pos) meshes.push(m);
      }
    }
    return combineMeshes(meshes, linkFrame(el));
  }

  linkPlan(view, el) {
    const e = this.link(el);
    const out = new PlanBuilder();
    const host = this.doc.get(view.levelId);
    if (!e.scene || !host) return out;
    const level = linkedLevel(e.doc, el, host.elevation);
    if (!level) return out;
    // One stand-in view per host view, kept while the host view is unchanged (for caching).
    let v = e.views.get(view.id);
    if (!v || v.src !== view || v.view.levelId !== level.id) {
      v = { src: view, view: { id: `${view.id}~${el.id}`, kind: view.kind === 'ceilingPlan' ? 'ceilingPlan' : 'plan', levelId: level.id, name: level.name, scale: view.scale, detail: view.detail, cutHeight: view.cutHeight, viewDepth: view.viewDepth } };
      e.views.set(view.id, v);
    }
    const f = linkFrame(el);
    const pc = planContext(e.doc, v.view, e.scene.walls, e.scene.rooms, e.scene.areas);
    for (const x of e.scene.planCandidates(v.view)) {
      if (x.kind === 'link' || x.viewId || isView(x) || !MODEL_KINDS.includes(x.kind)) continue;
      const g = e.scene.planOf(v.view, x, pc);
      if (g) appendPlan(out, g, f);
    }
    return out;
  }
}

/** Demolished elements: every line dashed, cut fills left out. */
function dashed(g) {
  const b = new PlanBuilder();
  for (const l of g.lines) b.lines.push({ ...l, d: 2, w: Math.min(l.w, 3) });
  b.picks = g.picks;
  b.texts = g.texts;
  return b;
}

function wallSignature(g) {
  const r = (p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
  return `${r(g.L0)} ${r(g.L1)} ${r(g.R0)} ${r(g.R1)} ${g.base} ${g.top} ${g.ends.map((e) => e.kind + (e.angle ?? '')).join('/')} ${JSON.stringify(g.cuts)}`;
}

function sameDeps(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
