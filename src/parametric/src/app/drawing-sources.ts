// Drawing sources beyond the open part's body (see src/drawing/source.ts): an assembly's
// placed components, collapsed or exploded, with their bill of materials, and a sheet metal
// part's flat pattern.

import { combinedName } from '../assembly/compose';
import { flatEdges, flatProjection } from '../drawing/flat';
import type { BomRow, DrawingSource } from '../drawing/source';
import type { EdgeInfo, ProjectionResult } from '../kernel/protocol';
import { type Vec3, add, normalize, qRotate, scale } from '../math/vec';
import { type AsmComponent, type AsmPart, type Placement, assemblyBom } from '../model/assembly';
import type { FlatPattern } from '../model/flat-pattern';
import { placementMatrix } from '../assembly/compose';
import { applyPlacement } from '../assembly/solver';
import type { App } from './app';
import type { AssemblyMode } from './assembly/mode';

export const ASSEMBLY_SOURCE = 'assembly';
export const EXPLODED_SOURCE = 'assembly:exploded';

interface Placed { comp: AsmComponent; part: AsmPart; pl: Placement }

/**
 * Versions of assembly sources, counted across all of them: a drawing's projections are kept
 * by version, so another assembly opened later must not find the same numbers.
 */
let versions = 0;

/**
 * The components of an open assembly as a drawing shows them: every component that is not
 * suppressed (hidden ones too: hiding is for the graphics area), where the mates put it, or
 * moved by the exploded view's steps. Edges are named as the assembly's graphics area names
 * them (component id, '#', the part's edge name).
 */
export function assemblySource(app: App, m: AssemblyMode, exploded: boolean): DrawingSource {
  let memo: { build: number; doc: unknown; quality: number } | null = null;
  let state: { key: string; items: Placed[]; edges: EdgeInfo[]; bbox: { min: Vec3; max: Vec3 } | null } | null = null;
  let version = 0;
  const current = () => {
    const doc = m.doc;
    if (memo && memo.build === app.buildVersion && memo.doc === app.store.doc && memo.quality === app.settings.quality && state) return state;
    memo = { build: app.buildVersion, doc: app.store.doc, quality: app.settings.quality };
    const items: Placed[] = [];
    for (const c of doc.components) {
      const part = doc.parts.find((p) => p.id === c.part);
      if (c.suppressed || !part || !m.geometryOf(c.part)?.mesh) continue;
      let pl = m.solved.get(c.id) ?? c.placement;
      if (exploded) {
        let off: Vec3 = [0, 0, 0];
        for (const s of doc.explode) {
          if (!s.comps.includes(c.id)) continue;
          let d = 0;
          try { d = app.store.evalParam(s.distance, 'length'); } catch { d = 0; }
          off = add(off, scale(normalize(s.dir), d));
        }
        pl = { p: add(pl.p, off), q: pl.q };
      }
      items.push({ comp: c, part, pl });
    }
    const key = JSON.stringify(items.map((it) => [it.comp.id, m.key(it.part), placementMatrix(it.pl).map((v) => +v.toFixed(9))]));
    if (state?.key === key) return state;
    version = ++versions;
    const edges: EdgeInfo[] = [];
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const { comp, part, pl } of items) {
      const g = m.geometryOf(part.id)!;
      const P = (p: Vec3) => applyPlacement(pl, p);
      const D = (d: Vec3) => qRotate(pl.q, d);
      for (const e of g.edges) {
        const out: EdgeInfo = { ...e, name: combinedName(comp.id, e.name), a: P(e.a), b: P(e.b), mid: P(e.mid) };
        if (e.dir) out.dir = D(e.dir);
        if (e.center) out.center = P(e.center);
        if (e.axis) out.axis = D(e.axis);
        edges.push(out);
      }
      const pos = g.mesh!.positions;
      for (let k = 0; k + 2 < pos.length; k += 3) {
        const q = P([pos[k], pos[k + 1], pos[k + 2]]);
        for (let i = 0; i < 3; i++) { if (q[i] < min[i]) min[i] = q[i]; if (q[i] > max[i]) max[i] = q[i]; }
      }
    }
    state = { key, items, edges, bbox: min[0] <= max[0] ? { min, max } : null };
    return state;
  };
  return {
    version: () => (current(), version),
    bbox: () => current().bbox,
    edges: () => current().edges,
    project: (views) => {
      const s = current();
      const items = s.items.map((it) => ({ part: m.key(it.part), m: placementMatrix(it.pl), name: it.comp.name, color: it.part.color }));
      return app.kernel.assembly<ProjectionResult[]>({ op: 'project', items, views });
    },
    bom: () => assemblyBomRows(m),
  };
}

/** The assembly's bill of materials as drawing rows (each with the edge prefixes of its components). */
export function assemblyBomRows(m: AssemblyMode): BomRow[] {
  const doc = m.doc;
  return assemblyBom(doc, (id) => m.partDoc(id)).map((r) => ({
    item: r.item, name: r.name, material: r.material, qty: r.quantity,
    prefixes: doc.components.filter((c) => c.part === r.part && !c.suppressed).map((c) => combinedName(c.id, '')),
  }));
}

/** A sheet metal part's flat pattern (computed by the geometry worker once per change of the body). */
export function flatSource(app: App): DrawingSource {
  interface Got { version: number; pattern: FlatPattern | null; error?: string; edges: EdgeInfo[] }
  let got: Got | null = null;
  let loading: { version: number; p: Promise<Got> } | null = null;
  const load = (): Promise<Got> => {
    const v = app.geometryVersion;
    if (got?.version === v) return Promise.resolve(got);
    if (loading?.version === v) return loading.p;
    const p = app.kernel.flatPattern(0).then((r) => {
      const g: Got = { version: v, pattern: r.pattern, error: r.error, edges: flatEdges(r.pattern) };
      got = g;
      return g;
    });
    loading = { version: v, p };
    return p;
  };
  return {
    version: () => app.geometryVersion,
    bbox: () => app.bbox,
    edges: () => (got?.version === app.geometryVersion ? got.edges : []),
    project: async (views) => {
      const g = await load();
      return views.map((v) => flatProjection(v.id, g.pattern, g.error));
    },
  };
}
