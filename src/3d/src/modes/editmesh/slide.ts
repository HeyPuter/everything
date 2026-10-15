// Edge Slide and Vertex Slide. Edge slide moves the selected edges along the faces on either side
// (the side is consistent along each selected chain); Vertex Slide moves each selected vertex
// along the connected edge that best follows the mouse.
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators } from '../../app/app';
import { activeView3D } from '../../editors/view3d/view3d';
import { MeshEdit, edgeKey } from './meshedit';
import { editMeshObjects, withEdit } from './context';
import { editPoll } from './ops-basic';
import { V, edgeChains } from './geom';

export interface SlideVert {
  v: number;
  /** targets on side A (factor > 0) and side B (factor < 0); null when that side has no edge */
  a: number | null;
  b: number | null;
}

/** Slide targets for every selected vertex, with sides consistent along each selected edge chain. */
export function edgeSlideTargets(m: MeshEdit): SlideVert[] {
  const sel = m.selectedEdges();
  const out: SlideVert[] = [];
  const ef = m.edgeFaces();
  const isSel = (v: number) => !!m.sel[v] && !m.hide[v];
  for (const chain of edgeChains(sel)) {
    const vs = chain.verts;
    const n = vs.length;
    for (let i = 0; i < n; i++) {
      const v = vs[i];
      // a chain edge through v, oriented along the chain
      const [x, y] = i + 1 < n || chain.closed ? [v, vs[(i + 1) % n]] : [vs[i - 1], v];
      const sides: (number | null)[] = [null, null];
      for (const [fi, c] of ef.get(edgeKey(x, y)) ?? []) {
        const f = m.faces[fi];
        const k = f.verts.length;
        const forward = f.verts[c] === x; // the face runs x→y: side A
        const at = f.verts.indexOf(v);
        // the face's other edge at v leads to the slide target
        const prev = f.verts[(at + k - 1) % k],
          next = f.verts[(at + 1) % k];
        const other = prev === (v === x ? y : x) ? next : prev;
        if (isSel(other) && k > 3) continue;
        sides[forward ? 0 : 1] = other;
      }
      if (sides[0] === null && sides[1] === null) continue;
      out.push({ v, a: sides[0], b: sides[1] });
    }
  }
  return out;
}

/** Apply an edge slide: factor in [-1, 1]; `even` keeps the same distance for every vertex. */
export function applyEdgeSlide(m: MeshEdit, base: number[], slides: SlideVert[], factor: number, even: boolean, flipped: boolean) {
  const P = (i: number) => new Vector3(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]);
  // even: the distance is the factor of the longest slide edge on that side
  let dist = 0;
  if (even) for (const s of slides) {
    const t = factor >= 0 ? s.a : s.b;
    if (t !== null) dist = Math.max(dist, P(s.v).distanceTo(P(t)));
  }
  for (const s of slides) {
    const t = factor >= 0 ? s.a : s.b;
    if (t === null) continue;
    const from = P(s.v),
      to = P(t);
    let p: Vector3;
    if (even) {
      const d = to.clone().sub(from);
      const len = d.length() || 1;
      const amount = Math.min(len, Math.abs(factor) * dist);
      p = flipped ? to.clone().addScaledVector(d, -(len - amount) / len) : from.clone().addScaledVector(d, amount / len);
    } else p = from.lerp(to, Math.abs(factor));
    m.setP(s.v, [p.x, p.y, p.z]);
  }
}

function startSlide(vertexMode: boolean, event?: { x: number; y: number }) {
  const v = activeView3D();
  if (!v) return 'CANCELLED' as const;
  const r = v.el.getBoundingClientRect();
  const data = editMeshObjects().map(({ ob, me }) => {
    const m = MeshEdit.from(me);
    return { ob, me, m, base: m.pos.slice(), world: app.graph.get(ob.id)?.world ?? new Matrix4(), slides: vertexMode ? [] : edgeSlideTargets(m), vchoice: new Map<number, number>() };
  });
  // vertex slide works on single vertices too: candidates are all connected edges
  const nbs = data.map((d) => d.m.neighbors());
  if (!vertexMode && !data.some((d) => d.slides.length)) {
    app.report('WARNING', 'Select edges with faces on at least one side to slide');
    return 'CANCELLED' as const;
  }
  if (vertexMode && !data.some((d) => d.m.selectedVerts().length)) return 'CANCELLED' as const;
  const start = event ? { x: event.x - r.left, y: event.y - r.top } : { x: app.pointer.x - r.left, y: app.pointer.y - r.top };
  let factor = 0;
  let even = false,
    flipped = false;
  let typed = '';
  // edge slide: the screen direction of the first slide edge sets the sign
  let dir = { x: 1, y: 0 };
  const proj = (d: (typeof data)[number], i: number) => v.project(new Vector3(d.base[i * 3], d.base[i * 3 + 1], d.base[i * 3 + 2]).applyMatrix4(d.world));
  if (!vertexMode) {
    const d0 = data.find((d) => d.slides.length)!;
    const s0 = d0.slides.find((s) => s.a !== null) ?? d0.slides[0];
    const A = proj(d0, s0.v),
      B = proj(d0, (s0.a ?? s0.b)!);
    dir = { x: B.x - A.x, y: B.y - A.y };
    if (s0.a === null) dir = { x: -dir.x, y: -dir.y };
  }
  const apply = () => {
    data.forEach((d, di) => {
      d.m.pos = d.base.slice();
      if (vertexMode) {
        for (const [vi, t] of d.vchoice) {
          const p = V(d.m.p(vi)).lerp(new Vector3(d.base[t * 3], d.base[t * 3 + 1], d.base[t * 3 + 2]), Math.max(0, Math.min(1, factor)));
          d.m.setP(vi, [p.x, p.y, p.z]);
        }
      } else applyEdgeSlide(d.m, d.base, d.slides, factor, even, flipped);
      d.me.positions = Float32Array.from(d.m.pos);
      void di;
    });
    app.changed('geometry');
  };
  /** vertex slide: per vertex, the edge pointing most along the mouse movement */
  const chooseVertexEdges = (mx: number, my: number) => {
    const md = { x: mx - start.x, y: my - start.y };
    const ml = Math.hypot(md.x, md.y) || 1;
    data.forEach((d, di) => {
      d.vchoice.clear();
      for (const vi of d.m.selectedVerts()) {
        const a = proj(d, vi);
        let best = -1,
          bd = -Infinity;
        for (const w of nbs[di][vi]) {
          const b = proj(d, w);
          const ex = b.x - a.x,
            ey = b.y - a.y;
          const dot = (ex * md.x + ey * md.y) / ((Math.hypot(ex, ey) || 1) * ml);
          if (dot > bd) {
            bd = dot;
            best = w;
          }
        }
        if (best >= 0) d.vchoice.set(vi, best);
      }
    });
  };
  const on = (b: boolean) => (b ? 'On' : 'Off');
  app.startModal({
    label: vertexMode ? 'Vertex Slide' : 'Edge Slide',
    header: () => `${vertexMode ? 'Vertex' : 'Edge'} Slide: ${typed ? typed + '|' : factor.toFixed(3)}${vertexMode ? '' : `   [E] Even: ${on(even)}   [F] Flipped: ${on(flipped)}`}`,
    status: () => (vertexMode ? [['LMB', 'Confirm'], ['RMB', 'Cancel']] : [['LMB', 'Confirm'], ['RMB', 'Cancel'], ['E', 'Even'], ['F', 'Flip']]),
    onPointerMove(e) {
      if (typed) return;
      const x = e.clientX - r.left - start.x,
        y = e.clientY - r.top - start.y;
      if (vertexMode) {
        chooseVertexEdges(e.clientX - r.left, e.clientY - r.top);
        // distance along the chosen edge of the first vertex
        const d = data.find((dd) => dd.vchoice.size);
        if (!d) return;
        const [vi, t] = d.vchoice.entries().next().value as [number, number];
        const a = proj(d, vi),
          b = proj(d, t);
        const ex = b.x - a.x,
          ey = b.y - a.y;
        factor = Math.max(0, Math.min(1, (x * ex + y * ey) / (ex * ex + ey * ey || 1)));
      } else {
        const len2 = dir.x * dir.x + dir.y * dir.y || 1;
        factor = Math.max(-1, Math.min(1, (x * dir.x + y * dir.y) / len2));
      }
      apply();
    },
    onPointerDown(e) {
      return e.button === 0 ? 'FINISHED' : e.button === 2 ? 'CANCELLED' : undefined;
    },
    onKey(e) {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Escape') return 'CANCELLED';
      if (e.key === 'Enter') return 'FINISHED';
      const k = e.key.toLowerCase();
      if (!vertexMode && k === 'e') even = !even;
      else if (!vertexMode && k === 'f') flipped = !flipped;
      else if (/^[0-9.]$/.test(e.key) || (e.key === '-' && !typed)) typed += e.key;
      else if (e.key === 'Backspace') typed = typed.slice(0, -1);
      else return true;
      if (typed) {
        const n = parseFloat(typed);
        factor = Number.isFinite(n) ? Math.max(vertexMode ? 0 : -1, Math.min(1, n)) : 0;
      }
      apply();
      return true;
    },
    cancel() {
      for (const d of data) d.me.positions = Float32Array.from(d.base);
      app.changed('geometry');
    },
    finish() {
      // the result is already in place; the shape key basis follows the edit
      for (const d of data)
        if (d.me.shape_keys.length) {
          const m = MeshEdit.from(d.me);
          m.keys[0] = m.pos.slice();
          m.write(d.me);
        }
      if (!vertexMode) this.redoOp = { idname: 'transform.edge_slide', props: { value: factor, use_even: even, flipped } };
    },
  });
  return 'RUNNING_MODAL' as const;
}

registerOperators([
  {
    idname: 'transform.edge_slide',
    label: 'Edge Slide',
    description: 'Slide the selected edges along the faces next to them',
    props: [
      { id: 'value', label: 'Factor', type: 'float', default: 0, min: -10, max: 10, softMin: -1, softMax: 1, subtype: 'factor' },
      { id: 'use_even', label: 'Even', type: 'bool', default: false },
      { id: 'flipped', label: 'Flipped', type: 'bool', default: false, showIf: (p) => !!p.use_even },
    ],
    poll: editPoll,
    invoke: (ctx) => startSlide(false, ctx.event),
    exec: (_ctx, p) =>
      withEdit((m) => {
        const slides = edgeSlideTargets(m);
        if (!slides.length) return false;
        applyEdgeSlide(m, m.pos.slice(), slides, Math.max(-1, Math.min(1, p.value as number)), !!p.use_even, !!p.flipped);
        if (m.keys.length) m.keys[0] = m.pos.slice();
      })
        ? 'FINISHED'
        : 'CANCELLED',
  },
  {
    idname: 'transform.vert_slide',
    label: 'Vertex Slide',
    description: 'Slide each selected vertex along the connected edge that follows the mouse',
    poll: editPoll,
    invoke: (ctx) => startSlide(true, ctx.event),
  },
]);
