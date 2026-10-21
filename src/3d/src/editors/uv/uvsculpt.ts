// UV sculpt brushes for the UV editor: Grab, Relax and Pinch strokes over the shown UVs.
import { app, registerOperators, type OpContext } from '../../app/app';
import { UVTopo, isPinned } from './uvcore';
import { uvLayers, uvEditPoll, ctxUVEditor, uvChanged } from './uvcontext';
import { falloff } from './uvtransform';

export const uvSculpt = { size: 50, strength: 1, falloff: 'SMOOTH', lock_borders: false, all_islands: false };

/**
 * Keep only the UV island nearest to (u, v) movable (brushes work on one island unless All Islands
 * is on). Islands are found per layer; the nearest vertex over all layers decides.
 */
export function limitToNearestIsland(layers: Layer[], u: number, v: number) {
  let best: { li: number; id: number; d: number } | null = null;
  layers.forEach((l, li) => {
    for (let id = 0; id < l.t.vertCount; id++) {
      const [x, y] = l.t.vertUV(id);
      const d = Math.hypot(x - u, y - v);
      if (!best || d < best.d) best = { li, id, d };
    }
  });
  if (!best) return;
  const b = best as { li: number; id: number; d: number };
  layers.forEach((l, li) => {
    if (li !== b.li) return l.movable.fill(0);
    const fi = l.t.islands.faceIsland;
    const island = fi[l.t.cornerFace[l.t.vertCorners[b.id][0]]];
    for (let id = 0; id < l.t.vertCount; id++) if (!l.t.vertCorners[id].some((c) => fi[l.t.cornerFace[c]] === island)) l.movable[id] = 0;
  });
}

export type Brush = 'GRAB' | 'RELAX' | 'PINCH';

interface Layer {
  t: UVTopo;
  uvs: Float32Array;
  movable: Uint8Array;
  neighbors: number[][];
}

function prepare(): Layer[] {
  return uvLayers().map((layer) => {
    const t = new UVTopo(layer);
    const uvs = new Float32Array(layer.me.uvs);
    const movable = new Uint8Array(t.vertCount);
    const neighbors: number[][] = Array.from({ length: t.vertCount }, () => []);
    for (const corners of t.edges.values()) {
      const c = corners[0];
      const a = t.uvVert[c],
        b = t.uvVert[t.next(c)];
      neighbors[a].push(b);
      neighbors[b].push(a);
    }
    for (let id = 0; id < t.vertCount; id++) {
      const cs = t.vertCorners[id];
      if (cs.some((c) => isPinned(layer.me, c))) continue;
      if (uvSculpt.lock_borders && cs.some((c) => t.isBoundary(c) || t.isBoundary(t.prev(c)))) continue;
      movable[id] = 1;
    }
    return { t, uvs, movable, neighbors };
  });
}

function setVert(l: Layer, id: number, u: number, v: number) {
  for (const c of l.t.vertCorners[id]) {
    l.uvs[c * 2] = u;
    l.uvs[c * 2 + 1] = v;
  }
}

/** One relax step on UV vertices within the brush (exported for tests). */
export function relaxStep(l: Layer, cu: number, cv: number, radius: number, strength: number) {
  const next: [number, number, number][] = [];
  for (let id = 0; id < l.t.vertCount; id++) {
    if (!l.movable[id]) continue;
    const c = l.t.vertCorners[id][0];
    const u = l.uvs[c * 2],
      v = l.uvs[c * 2 + 1];
    const d = Math.hypot(u - cu, v - cv);
    if (d >= radius) continue;
    const nb = l.neighbors[id];
    if (!nb.length) continue;
    let su = 0,
      sv = 0;
    for (const o of nb) {
      const k = l.t.vertCorners[o][0];
      su += l.uvs[k * 2];
      sv += l.uvs[k * 2 + 1];
    }
    const w = falloff(uvSculpt.falloff, d / radius) * strength * 0.5;
    next.push([id, u + (su / nb.length - u) * w, v + (sv / nb.length - v) * w]);
  }
  for (const [id, u, v] of next) setVert(l, id, u, v);
}

export function makeLayerForTest(t: UVTopo): Layer {
  const uvs = new Float32Array(t.me.uvs);
  const movable = new Uint8Array(t.vertCount).fill(1);
  const neighbors: number[][] = Array.from({ length: t.vertCount }, () => []);
  for (const corners of t.edges.values()) {
    const c = corners[0];
    const a = t.uvVert[c],
      b = t.uvVert[t.next(c)];
    neighbors[a].push(b);
    neighbors[b].push(a);
  }
  return { t, uvs, movable, neighbors };
}

/** Brush cursor state for the editor overlay. */
export const brushCursor = { active: false };

function startStroke(brush: Brush, ctx: OpContext, invert: boolean) {
  const view = ctxUVEditor(ctx);
  if (!view) return 'CANCELLED' as const;
  const layers = prepare();
  if (!layers.some((l) => l.t.vertCount)) return 'CANCELLED' as const;
  const bases = layers.map((l) => l.t.me.uvs);
  const r = view.el.getBoundingClientRect();
  const ev = ctx.event ?? app.pointer;
  let last = view.toUV(ev.x - r.left, ev.y - r.top);
  if (!uvSculpt.all_islands) limitToNearestIsland(layers, last.u, last.v);
  const radius = () => uvSculpt.size / view.scale();
  // grab: remember the weights of the UVs under the brush at the start
  const grabbed = layers.map((l) => {
    const out: [number, number][] = [];
    for (let id = 0; id < l.t.vertCount; id++) {
      if (!l.movable[id]) continue;
      const [u, v] = l.t.vertUV(id);
      const d = Math.hypot(u - last.u, v - last.v);
      if (d < radius()) out.push([id, falloff(uvSculpt.falloff, d / radius()) * uvSculpt.strength]);
    }
    return out;
  });
  const write = () => {
    layers.forEach((l) => (l.t.me.uvs = new Float32Array(l.uvs)));
    uvChanged();
  };
  const dab = (u: number, v: number) => {
    const rad = radius();
    for (const [li, l] of layers.entries()) {
      if (brush === 'GRAB') {
        const du = u - last.u,
          dv = v - last.v;
        for (const [id, w] of grabbed[li]) {
          const [x, y] = [l.uvs[l.t.vertCorners[id][0] * 2], l.uvs[l.t.vertCorners[id][0] * 2 + 1]];
          setVert(l, id, x + du * w * (invert ? -1 : 1), y + dv * w * (invert ? -1 : 1));
        }
      } else if (brush === 'RELAX') relaxStep(l, u, v, rad, uvSculpt.strength);
      else {
        for (let id = 0; id < l.t.vertCount; id++) {
          if (!l.movable[id]) continue;
          const c = l.t.vertCorners[id][0];
          const x = l.uvs[c * 2],
            y = l.uvs[c * 2 + 1];
          const d = Math.hypot(x - u, y - v);
          if (d >= rad || d < 1e-12) continue;
          const k = falloff(uvSculpt.falloff, d / rad) * uvSculpt.strength * 0.05 * (invert ? -1 : 1);
          setVert(l, id, x + (u - x) * k, y + (v - y) * k);
        }
      }
    }
    last = { u, v };
    write();
  };
  if (brush !== 'GRAB') dab(last.u, last.v);
  app.startModal({
    label: brush === 'GRAB' ? 'Grab UVs' : brush === 'RELAX' ? 'Relax UVs' : 'Pinch UVs',
    cursor: 'crosshair',
    onPointerMove(e) {
      const p = view.toUV(e.clientX - r.left, e.clientY - r.top);
      dab(p.u, p.v);
      view.draw();
    },
    onPointerUp() {
      return 'FINISHED';
    },
    onPointerDown() {
      return 'FINISHED';
    },
    onKey(e) {
      if (e.type === 'keydown' && e.key === 'Escape') return 'CANCELLED';
      return true;
    },
    cancel() {
      layers.forEach((l, i) => (l.t.me.uvs = bases[i]));
      uvChanged();
    },
  });
  return 'RUNNING_MODAL' as const;
}

function brushOp(brush: Brush, idname: string, label: string, description: string) {
  return {
    idname,
    label,
    description,
    props: [{ id: 'use_invert', label: 'Invert', type: 'bool' as const, default: false }],
    poll: (ctx: OpContext) => uvEditPoll() && !!ctxUVEditor(ctx),
    invoke: (ctx: OpContext, p: Record<string, unknown>) => startStroke(brush, ctx, !!p.use_invert),
  };
}

registerOperators([
  brushOp('GRAB', 'sculpt.uv_sculpt_grab', 'Grab UVs', 'Drag UVs under the brush'),
  brushOp('RELAX', 'sculpt.uv_sculpt_relax', 'Relax UVs', 'Smooth out UVs under the brush'),
  brushOp('PINCH', 'sculpt.uv_sculpt_pinch', 'Pinch UVs', 'Pull UVs under the brush toward its center'),
]);

/** F / Shift F: drag to set the brush radius or strength (click or Enter to confirm). */
export function radialControl(kind: 'size' | 'strength', view: { el: HTMLElement; draw(): void }) {
  const start = { ...app.pointer };
  const before = uvSculpt[kind];
  const r = view.el.getBoundingClientRect();
  // the pointer starts on the circle edge for the radius, at the strength's distance otherwise
  const center = kind === 'size' ? { x: start.x - before, y: start.y } : { x: start.x - before * 200, y: start.y };
  const ring = document.createElement('div');
  Object.assign(ring.style, { position: 'absolute', border: '1.5px solid rgba(255, 255, 255,.85)', borderRadius: '50%', pointerEvents: 'none' });
  view.el.append(ring);
  const show = () => {
    const rad = kind === 'size' ? uvSculpt.size : uvSculpt.strength * 200;
    Object.assign(ring.style, { left: `${center.x - r.left - rad}px`, top: `${center.y - r.top - rad}px`, width: `${rad * 2}px`, height: `${rad * 2}px` });
  };
  show();
  let keep = false;
  app.startModal({
    label: kind === 'size' ? 'Brush Radius' : 'Brush Strength',
    header: () => (kind === 'size' ? `Radius: ${Math.round(uvSculpt.size)} px` : `Strength: ${uvSculpt.strength.toFixed(3)}`),
    onPointerMove(e) {
      const d = Math.hypot(e.clientX - center.x, e.clientY - center.y);
      if (kind === 'size') uvSculpt.size = Math.max(1, Math.min(500, Math.round(d)));
      else uvSculpt.strength = Math.max(0, Math.min(1, d / 200));
      show();
      app.changed('ui');
    },
    // brush settings are not part of the document: end without an undo step either way
    onPointerDown(e) {
      keep = e.button === 0;
      return 'CANCELLED';
    },
    onKey(e) {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') {
        keep = true;
        return 'CANCELLED';
      }
      return true;
    },
    cancel() {
      if (!keep) uvSculpt[kind] = before;
      ring.remove();
      app.changed('ui');
    },
  });
}
