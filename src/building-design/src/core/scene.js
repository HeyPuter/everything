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
import { WallSolver } from './walls.js';
import { RoomSolver } from './rooms.js';
import { build3D } from './build3d.js';
import { planGraphics, planContext, columnOutline, hiddenInView } from './plan.js';
import { hostedBy } from './model.js';

export const MODEL_KINDS = ['wall', 'floor', 'ceiling', 'roof', 'door', 'window', 'column', 'beam', 'stair', 'railing', 'component'];
export const PLAN_KINDS = [...MODEL_KINDS, 'room', 'roomSeparator', 'grid', 'dimension', 'text', 'tag', 'detailLine', 'section', 'elevation'];

const LEVEL_SCOPED = new Set(['wall', 'roomSeparator', 'column', 'room', 'floor', 'ceiling', 'roof', 'stair', 'railing', 'component', 'beam']);

export class Scene {
  constructor(doc) {
    this.doc = doc;
    this.walls = new WallSolver(doc);
    this.rooms = new RoomSolver(doc, this.walls, (c) => columnOutline(doc, c));
    this.meshes = new Map();
    this.plans = new Map();
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
    const levels = new Set();
    for (const id of ev.ids) {
      const now = doc.get(id);
      const before = this.known.get(id);
      const kind = now?.kind ?? before?.kind;
      if (kind === 'level' || kind === 'wallType' || kind === 'material' || kind === 'project') all = true;
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
    if (all) {
      this.walls.invalidate();
      this.rooms.invalidate();
    } else {
      for (const l of levels) {
        this.walls.invalidate(l);
        this.rooms.invalidate(l);
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
      const g = this.walls.wall(el.id);
      d.push(g ? wallSignature(g) : null);
      for (const h of hostedBy(doc, el.id)) d.push(h, doc.get(h.typeId));
      const lvl = this.walls.level(el.levelId);
      for (const hub of lvl.hubs) if (hub.ids.slice().sort()[0] === el.id) d.push(hub.poly.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(';'));
    } else if (el.hostId) {
      const host = doc.get(el.hostId);
      d.push(host, host && doc.get(host.typeId), host && doc.get(host.levelId), host && doc.get(host.topLevelId));
    }
    return d;
  }

  /** Cached mesh of a model element (null when it has no 3D geometry). */
  mesh(el) {
    const deps = this.deps3D(el);
    const c = this.meshes.get(el.id);
    if (c && sameDeps(c.deps, deps)) return c.mesh;
    let mesh = null;
    try {
      mesh = build3D(this.ctx3d(), el);
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
    for (const k of PLAN_KINDS) {
      for (const el of doc.all(k)) {
        if (el.viewId && el.viewId !== view.id) continue;
        if (k === 'section' || k === 'elevation') {
          if (view.kind !== 'plan') continue;
        }
        if (hiddenInView(doc, view, el)) continue;
        out.push(el);
      }
    }
    return out;
  }

  /** Inputs of an element's plan graphics, beyond its 3D inputs. */
  depsPlan(view, el, pc) {
    const doc = this.doc;
    const d = [view, doc.get(view.levelId), ...this.deps3D(el)];
    if (el.kind === 'room') d.push(this.rooms.room(el));
    else if (el.kind === 'dimension') for (const r of el.refs || []) d.push(doc.get(r.id));
    else if (el.kind === 'tag') {
      const t = doc.get(el.targetId);
      d.push(t, t && doc.get(t.hostId), t && doc.get(t.typeId), t?.kind === 'room' ? this.rooms.room(t) : null);
    } else if (el.kind === 'stair') d.push(doc.levelAbove(el.levelId));
    void pc;
    return d;
  }

  /** Cached plan graphics of an element in a view. */
  planOf(view, el, pc = null) {
    let cache = this.plans.get(view.id);
    if (!cache) this.plans.set(view.id, (cache = new Map()));
    const ctx = pc || planContext(this.doc, view, this.walls, this.rooms);
    const deps = this.depsPlan(view, el, ctx);
    const c = cache.get(el.id);
    if (c && sameDeps(c.deps, deps)) return c.g;
    let g = null;
    try {
      g = planGraphics(ctx, el);
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
  }
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
