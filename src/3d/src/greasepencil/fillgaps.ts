// Fill gap closure (pure, screen space): extension lines from the open ends of strokes, either
// continuing their direction (Extend) or joining ends that are close to each other (Radius).

export type P = [number, number];
export interface ScreenStroke {
  pts: P[];
  cyclic: boolean;
}
export type Seg = [number, number, number, number];

function hit(a: P, b: P, c: P, d: P): number | null {
  const rx = b[0] - a[0],
    ry = b[1] - a[1],
    sx = d[0] - c[0],
    sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den,
    u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return t > 1e-6 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/** Direction leaving the stroke at its start (end = false) or end, from points at least `min` px back. */
function endDir(pts: P[], atEnd: boolean, min = 6): { at: P; dir: P } | null {
  const n = pts.length;
  const at = atEnd ? pts[n - 1] : pts[0];
  for (let k = 1; k < n; k++) {
    const q = atEnd ? pts[n - 1 - k] : pts[k];
    const dx = at[0] - q[0],
      dy = at[1] - q[1];
    const l = Math.hypot(dx, dy);
    if (l >= min || k === n - 1) return l > 1e-9 ? { at, dir: [dx / l, dy / l] } : null;
  }
  return null;
}

/**
 * Extension segments for the open stroke ends. `lengthAt(p)` gives the extension length in pixels
 * at a screen point. With `collide`, Extend lines stop at the first stroke they cross.
 */
export function extensionLines(strokes: ScreenStroke[], mode: 'EXTEND' | 'RADIUS', lengthAt: (p: P) => number, collide: boolean): Seg[] {
  const out: Seg[] = [];
  const ends: { p: P; s: number; end: boolean }[] = [];
  strokes.forEach((st, s) => {
    if (st.cyclic || st.pts.length < 2) return;
    ends.push({ p: st.pts[0], s, end: false }, { p: st.pts[st.pts.length - 1], s, end: true });
  });
  if (mode === 'RADIUS') {
    // join each end to the nearest other end within reach (each pair once)
    const seen = new Set<string>();
    ends.forEach((e, i) => {
      const r = lengthAt(e.p);
      let best = -1,
        bd = r;
      ends.forEach((o, j) => {
        if (i === j || (o.s === e.s && strokes[e.s].pts.length < 3)) return;
        const d = Math.hypot(o.p[0] - e.p[0], o.p[1] - e.p[1]);
        if (d > 0 && d <= bd) [best, bd] = [j, d];
      });
      if (best < 0) return;
      const key = i < best ? `${i}-${best}` : `${best}-${i}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push([e.p[0], e.p[1], ends[best].p[0], ends[best].p[1]]);
    });
    return out;
  }
  for (const e of ends) {
    const d = endDir(strokes[e.s].pts, e.end);
    if (!d) continue;
    const len = lengthAt(e.p);
    if (len <= 0) continue;
    let b: P = [d.at[0] + d.dir[0] * len, d.at[1] + d.dir[1] * len];
    if (collide) {
      let tMin = 1;
      strokes.forEach((st, s) => {
        const P = st.pts;
        const segs = st.cyclic ? P.length : P.length - 1;
        for (let k = 0; k < segs; k++) {
          // skip the stroke's own end segment
          if (s === e.s && ((e.end && k >= P.length - 2) || (!e.end && k === 0))) continue;
          const t = hit(d.at, b, P[k], P[(k + 1) % P.length]);
          if (t !== null && t < tMin) tMin = t;
        }
      });
      b = [d.at[0] + (b[0] - d.at[0]) * tMin, d.at[1] + (b[1] - d.at[1]) * tMin];
    }
    out.push([d.at[0], d.at[1], b[0], b[1]]);
  }
  return out;
}
