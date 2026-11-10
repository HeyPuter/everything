/**
 * Join: merge collinear lines, co-circular arcs, and chains of touching
 * lines, arcs and open polylines into polylines.
 */
import { TWO_PI, normAngle, ccwSweep } from './vec.js';
import { derive, polylineFrom } from './entity.js';
import { reversePolyPts, vertexCount } from './poly.js';

/** Merge collinear overlapping or touching lines. Returns [{ ent, ids }]. */
function mergeLines(lines, tol) {
  const recs = [];
  let maxLen = 0;
  for (const e of lines) {
    const dx = e.x2 - e.x1,
      dy = e.y2 - e.y1;
    const len = Math.hypot(dx, dy);
    if (!(len > tol)) continue;
    let th = Math.atan2(dy, dx);
    if (th < 0) th += Math.PI;
    if (th >= Math.PI) th -= Math.PI;
    let c = -Math.sin(th) * e.x1 + Math.cos(th) * e.y1;
    if (th > Math.PI - 1e-12) {
      th -= Math.PI;
      c = -c;
    }
    recs.push({ e, th, c, len });
    if (len > maxLen) maxLen = len;
  }
  const angTol = Math.max(1e-12, tol / Math.max(maxLen, tol));
  recs.sort((a, b) => a.th - b.th);
  const groups = [];
  // Angle runs (also join the wrap-around run near 0 / PI).
  let run = [];
  const runs = [];
  for (const r of recs) {
    if (run.length && r.th - run[run.length - 1].th > angTol) {
      runs.push(run);
      run = [];
    }
    run.push(r);
  }
  if (run.length) runs.push(run);
  if (runs.length > 1) {
    const first = runs[0],
      last = runs[runs.length - 1];
    if (first[0].th + Math.PI - last[last.length - 1].th <= angTol) {
      for (const r of last) {
        r.th -= Math.PI;
        r.c = -r.c;
      }
      runs[0] = last.concat(first);
      runs.pop();
    }
  }
  for (const rr of runs) {
    rr.sort((a, b) => a.c - b.c);
    let g = [rr[0]];
    for (let i = 1; i < rr.length; i++) {
      if (rr[i].c - g[g.length - 1].c > tol) {
        groups.push(g);
        g = [];
      }
      g.push(rr[i]);
    }
    groups.push(g);
  }
  const out = [];
  for (const g of groups) {
    const th = g[0].th;
    const ux = Math.cos(th),
      uy = Math.sin(th);
    const iv = g.map((r) => {
      const s1 = r.e.x1 * ux + r.e.y1 * uy,
        s2 = r.e.x2 * ux + r.e.y2 * uy;
      return s1 <= s2
        ? { s0: s1, s1: s2, p0: [r.e.x1, r.e.y1], p1: [r.e.x2, r.e.y2], e: r.e, fwd: true }
        : { s0: s2, s1: s1, p0: [r.e.x2, r.e.y2], p1: [r.e.x1, r.e.y1], e: r.e, fwd: false };
    });
    iv.sort((a, b) => a.s0 - b.s0);
    let cur = null;
    const flush = () => {
      if (!cur) return;
      const src = cur.members[0];
      let ent;
      if (cur.members.length === 1) ent = src.e;
      else {
        // Keep the direction of the first member.
        const [a, b] = src.fwd ? [cur.p0, cur.p1] : [cur.p1, cur.p0];
        ent = derive(src.e, 'line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
      }
      out.push({ ent, ids: cur.members.map((m) => m.e.id), srcs: cur.members.map((m) => m.e), merged: cur.members.length > 1 });
    };
    for (const v of iv) {
      if (cur && v.s0 <= cur.s1 + tol) {
        if (v.s1 > cur.s1) {
          cur.s1 = v.s1;
          cur.p1 = v.p1;
        }
        cur.members.push(v);
      } else {
        flush();
        cur = { s0: v.s0, s1: v.s1, p0: v.p0, p1: v.p1, members: [v] };
      }
    }
    flush();
  }
  return out;
}

/** Merge arcs on the same circle that touch or overlap. Returns [{ ent, ids }]. */
function mergeArcs(arcs, tol) {
  const recs = arcs.filter((e) => e.r > tol).map((e) => ({ e, a0: normAngle(e.start), sw: ccwSweep(e.start, e.end), used: false }));
  recs.sort((a, b) => a.e.cx - b.e.cx);
  const out = [];
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].used) continue;
    const ri = recs[i].e;
    const grp = [recs[i]];
    recs[i].used = true;
    for (let j = i + 1; j < recs.length && recs[j].e.cx - ri.cx <= tol; j++) {
      const rj = recs[j];
      if (rj.used) continue;
      if (Math.abs(rj.e.cy - ri.cy) <= tol && Math.abs(rj.e.r - ri.r) <= tol) {
        rj.used = true;
        grp.push(rj);
      }
    }
    const angTol = tol / ri.r;
    grp.sort((a, b) => a.a0 - b.a0);
    const iv = [];
    for (const g of grp) {
      const last = iv[iv.length - 1];
      if (last && g.a0 <= last.end + angTol) {
        last.end = Math.max(last.end, g.a0 + g.sw);
        last.members.push(g.e);
      } else iv.push({ start: g.a0, end: g.a0 + g.sw, members: [g.e] });
    }
    if (iv.length > 1) {
      const f = iv[0],
        l = iv[iv.length - 1];
      if (l.end + angTol >= f.start + TWO_PI) {
        f.start = l.start - TWO_PI;
        f.end = Math.max(f.end, l.end - TWO_PI);
        f.members = l.members.concat(f.members);
        iv.pop();
      }
    }
    for (const v of iv) {
      const src = v.members[0];
      let ent;
      if (v.members.length === 1) ent = src;
      else if (v.end - v.start >= TWO_PI - angTol) ent = derive(src, 'circle', { cx: src.cx, cy: src.cy, r: src.r });
      else ent = derive(src, 'arc', { cx: src.cx, cy: src.cy, r: src.r, start: normAngle(v.start), end: normAngle(v.end) });
      out.push({ ent, ids: v.members.map((m) => m.id), srcs: v.members, merged: v.members.length > 1 });
    }
  }
  return out;
}

/** Stride-3 forward point list of a chain piece. */
function piecePts(e) {
  if (e.type === 'line') return [e.x1, e.y1, 0, e.x2, e.y2, 0];
  if (e.type === 'arc') {
    const sw = ccwSweep(e.start, e.end);
    return [
      e.cx + e.r * Math.cos(e.start),
      e.cy + e.r * Math.sin(e.start),
      Math.tan(sw / 4),
      e.cx + e.r * Math.cos(e.end),
      e.cy + e.r * Math.sin(e.end),
      0,
    ];
  }
  const p = e.pts.slice();
  p[p.length - 1] = 0;
  return p;
}

/**
 * Join entities. Collinear touching / overlapping lines merge into one line,
 * touching arcs on the same circle merge (into a circle when they close),
 * and chains of lines, arcs and open polylines meeting end to end within tol
 * become polylines (closed when the chain closes). Returns
 * { result: new entities (no ids), consumedIds: ids of replaced inputs }.
 */
export function joinEntities(ents, tol) {
  if (!(tol > 0)) {
    // Relative to the size of the selection (not its distance from the
    // origin), above float noise at its position; matches the JOIN command.
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    const add = (x, y, r = 0) => {
      x0 = Math.min(x0, x - r);
      y0 = Math.min(y0, y - r);
      x1 = Math.max(x1, x + r);
      y1 = Math.max(y1, y + r);
    };
    for (const e of ents) {
      if (e.type === 'line') {
        add(e.x1, e.y1);
        add(e.x2, e.y2);
      } else if (e.type === 'arc') add(e.cx, e.cy, e.r);
      else if (e.type === 'polyline') {
        for (let i = 0; i + 1 < e.pts.length; i += 3) add(e.pts[i], e.pts[i + 1]);
      }
    }
    const ok = Number.isFinite(x0) && Number.isFinite(x1);
    const size = ok ? Math.hypot(x1 - x0, y1 - y0) : 1;
    const far = ok ? Math.max(Math.abs(x0), Math.abs(y0), Math.abs(x1), Math.abs(y1)) : 1;
    tol = Math.max(1e-6 * Math.max(size, 1e-3), 1e-11 * far, 1e-12);
  }
  const lines = ents.filter((e) => e.type === 'line');
  const arcs = ents.filter((e) => e.type === 'arc');
  const polys = ents.filter((e) => e.type === 'polyline' && !e.closed && vertexCount(e.pts) >= 2);
  const items = [...mergeLines(lines, tol), ...mergeArcs(arcs, tol)];
  for (const p of polys) items.push({ ent: p, ids: [p.id], srcs: [p], merged: false, poly: true });
  const index = new Map(ents.map((e, i) => [e, i]));
  for (const it of items) it.order = it.srcs.reduce((m, s) => Math.min(m, index.get(s)), Infinity);
  const result = [];
  const consumed = [];
  // Circles produced by arc merging are final.
  const pieces = [];
  for (const it of items) {
    if (it.ent.type === 'circle') {
      result.push(it.ent);
      consumed.push(...it.ids);
    } else pieces.push({ ...it, pts: piecePts(it.ent) });
  }
  const m = pieces.length;
  // Endpoints: 2k = start of piece k, 2k + 1 = end.
  const ex = new Float64Array(2 * m),
    ey = new Float64Array(2 * m);
  for (let k = 0; k < m; k++) {
    const p = pieces[k].pts;
    ex[2 * k] = p[0];
    ey[2 * k] = p[1];
    ex[2 * k + 1] = p[p.length - 3];
    ey[2 * k + 1] = p[p.length - 2];
  }
  const cell = tol * 4;
  const grid = new Map();
  const key = (i, j) => i * 73856093 + j * 19349663;
  for (let q = 0; q < 2 * m; q++) {
    const k = key(Math.floor(ex[q] / cell), Math.floor(ey[q] / cell));
    let b = grid.get(k);
    if (!b) grid.set(k, (b = []));
    b.push(q);
  }
  const partner = new Int32Array(2 * m).fill(-1);
  for (let q = 0; q < 2 * m; q++) {
    if (partner[q] >= 0) continue;
    const ci = Math.floor(ex[q] / cell),
      cj = Math.floor(ey[q] / cell);
    let best = -1,
      bd = Infinity;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const b = grid.get(key(ci + di, cj + dj));
        if (!b) continue;
        for (const o of b) {
          if (o === q || partner[o] >= 0) continue;
          if (o >> 1 === q >> 1 && !pieces[q >> 1].poly) continue;
          const d = Math.hypot(ex[o] - ex[q], ey[o] - ey[q]);
          if (d <= tol && d < bd) {
            bd = d;
            best = o;
          }
        }
      }
    }
    if (best >= 0) {
      partner[q] = best;
      partner[best] = q;
    }
  }
  const visited = new Uint8Array(m);
  const emitChain = (startQ) => {
    // startQ: an endpoint index where the chain begins (entering piece startQ >> 1).
    const chain = [];
    let q = startQ;
    let closed = false;
    for (;;) {
      const k = q >> 1;
      if (visited[k]) {
        closed = true;
        break;
      }
      visited[k] = 1;
      const fwd = (q & 1) === 0;
      chain.push({ k, fwd });
      const exitQ = fwd ? 2 * k + 1 : 2 * k;
      const nq = partner[exitQ];
      if (nq < 0) break;
      q = nq;
    }
    if (closed && chain.length && (chain[0].fwd ? 2 * chain[0].k : 2 * chain[0].k + 1) !== q) closed = false;
    return { chain, closed };
  };
  const chains = [];
  for (let k = 0; k < m; k++) {
    if (visited[k]) continue;
    if (partner[2 * k] < 0) chains.push(emitChain(2 * k));
    else if (partner[2 * k + 1] < 0) chains.push(emitChain(2 * k + 1));
  }
  for (let k = 0; k < m; k++) if (!visited[k]) chains.push(emitChain(2 * k));
  for (const c of chains) {
    // Orient and rotate the chain so the earliest input piece keeps its direction.
    let chain = c.chain;
    const closed = c.closed;
    let best = 0;
    for (let i = 1; i < chain.length; i++) if (pieces[chain[i].k].order < pieces[chain[best].k].order) best = i;
    if (!chain[best].fwd) {
      chain = chain.map((s) => ({ k: s.k, fwd: !s.fwd })).reverse();
      best = chain.length - 1 - best;
    }
    if (closed && best) {
      chain = chain.slice(best).concat(chain.slice(0, best));
      best = 0;
    }
    const first = pieces[chain[best].k];
    if (chain.length === 1 && !closed) {
      if (first.merged) {
        result.push(first.ent);
        consumed.push(...first.ids);
      }
      continue;
    }
    const pts = [];
    for (let i = 0; i < chain.length; i++) {
      const pc = pieces[chain[i].k];
      const p = chain[i].fwd ? pc.pts : reversePolyPts(pc.pts, false);
      const last = i === chain.length - 1;
      const upto = last && !closed ? p.length : p.length - 3;
      for (let j = 0; j < upto; j++) pts.push(p[j]);
      consumed.push(...pc.ids);
    }
    result.push(polylineFrom(first.ent, pts, closed));
  }
  return { result, consumedIds: consumed.filter((id) => id !== undefined) };
}
