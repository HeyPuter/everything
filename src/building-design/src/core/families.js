/**
 * Procedural component families: furniture, casework, fixtures, equipment,
 * planting and lighting. Each family builds its 3D geometry and its plan
 * symbol from the type's overall width (x), depth (y) and height (z).
 *
 * Local frame: origin at the center of the footprint, +y is the back (the
 * side placed against a wall), the front faces -y.
 */
import { hexToRgba } from './mesh.js';

const ELLIPSE_SEGS = 28;

function ellipse(cx, cy, rx, ry, n = ELLIPSE_SEGS) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}

function rect(x0, y0, x1, y1) {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/**
 * Collects geometry in the family's local frame and emits it through a
 * placement frame. `b` is a MeshBuilder; plan is { loops: [{ pts, closed, dash }], outline }.
 */
class FamilyContext {
  constructor(b, frame, mats) {
    this.b = b;
    this.frame = frame;
    this.mats = mats;
  }

  color(id, fallback = '#c8c8c8') {
    if (typeof id === 'string' && id.startsWith('#')) return hexToRgba(id);
    const m = this.mats(id);
    return hexToRgba(m?.color || fallback, m?.opacity ?? 1);
  }

  box(x0, y0, z0, x1, y1, z1, mat) {
    if (!this.b) return;
    const loop = rect(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)).map((p) => this.frame.apply(p));
    this.b.prism(loop, [], this.frame.z + Math.min(z0, z1), this.frame.z + Math.max(z0, z1), typeof mat === 'string' ? this.color(mat) : mat);
  }

  prism(loop, z0, z1, mat, opts) {
    if (!this.b) return;
    this.b.prism(
      loop.map((p) => this.frame.apply(p)),
      [],
      this.frame.z + z0,
      this.frame.z + z1,
      typeof mat === 'string' ? this.color(mat) : mat,
      opts,
    );
  }

  cyl(cx, cy, r, z0, z1, mat, opts = {}) {
    if (!this.b) return;
    const c = this.frame.apply([cx, cy]);
    this.b.cylinder(c, r, this.frame.z + z0, this.frame.z + z1, typeof mat === 'string' ? this.color(mat) : mat, opts);
  }

  sphere(cx, cy, cz, r, mat, opts) {
    if (!this.b) return;
    const c = this.frame.apply([cx, cy]);
    this.b.sphere([c[0], c[1], this.frame.z + cz], r, typeof mat === 'string' ? this.color(mat) : mat, opts);
  }
}

const F = {
  bed(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    const hw = w / 2;
    const hd = d / 2;
    x.box(-hw, -hd, 0, hw, hd, h * 0.55, 'mat-wood');
    x.box(-hw + 20, -hd + 20, h * 0.55, hw - 20, hd - 60, h, 'mat-fabric-warm');
    x.box(-hw, hd - 60, 0, hw, hd, h + 450, 'mat-wood');
    const pillows = w > 1200 ? 2 : 1;
    const pw = (w - 120 - (pillows - 1) * 60) / pillows;
    for (let i = 0; i < pillows; i++) {
      const px = -hw + 60 + i * (pw + 60);
      x.box(px, hd - 120 - 380, h, px + pw, hd - 120, h + 120, 'mat-porcelain');
      plan.loops.push({ pts: rect(px, hd - 120 - 380, px + pw, hd - 120), closed: true });
    }
    plan.loops.push({ pts: rect(-hw, -hd, hw, hd), closed: true });
    plan.loops.push({ pts: rect(-hw, hd - 60, hw, hd), closed: true });
    plan.loops.push({ pts: [[-hw, hd - d * 0.36], [hw, hd - d * 0.36]] });
    plan.loops.push({ pts: [[-hw, hd - d * 0.36], [-hw + w * 0.18, hd - d * 0.28]] });
  },
  cabinet(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    x.box(-w / 2, -d / 2, 0, w / 2, d / 2, h, 'mat-wood-light');
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
    plan.loops.push({ pts: [[-w / 2, -d / 2 + 25], [w / 2, -d / 2 + 25]] });
    if (w > 700) plan.loops.push({ pts: [[0, -d / 2], [0, -d / 2 + 25]] });
  },
  sofa(t, x, plan, seats = 3) {
    const { width: w, depth: d, height: h } = t;
    const arm = Math.min(180, w * 0.12);
    const back = Math.min(220, d * 0.25);
    const seatH = Math.min(440, h * 0.55);
    x.box(-w / 2, -d / 2, 0, w / 2, d / 2, seatH - 120, 'mat-fabric');
    x.box(-w / 2 + arm, -d / 2 + 30, seatH - 120, w / 2 - arm, d / 2 - back, seatH, 'mat-fabric');
    x.box(-w / 2, d / 2 - back, 0, w / 2, d / 2, h, 'mat-fabric');
    x.box(-w / 2, -d / 2, 0, -w / 2 + arm, d / 2, seatH + 180, 'mat-fabric');
    x.box(w / 2 - arm, -d / 2, 0, w / 2, d / 2, seatH + 180, 'mat-fabric');
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
    plan.loops.push({ pts: [[-w / 2 + arm, d / 2 - back], [w / 2 - arm, d / 2 - back]] });
    plan.loops.push({ pts: [[-w / 2 + arm, -d / 2], [-w / 2 + arm, d / 2 - back]] });
    plan.loops.push({ pts: [[w / 2 - arm, -d / 2], [w / 2 - arm, d / 2 - back]] });
    const sw = (w - 2 * arm) / seats;
    for (let i = 1; i < seats; i++) plan.loops.push({ pts: [[-w / 2 + arm + i * sw, -d / 2 + 30], [-w / 2 + arm + i * sw, d / 2 - back]] });
  },
  armchair(t, x, plan) {
    F.sofa(t, x, plan, 1);
  },
  table(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    const leg = 50;
    const ins = 40;
    x.box(-w / 2, -d / 2, h - 35, w / 2, d / 2, h, 'mat-wood');
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        const cx = sx * (w / 2 - ins - leg / 2);
        const cy = sy * (d / 2 - ins - leg / 2);
        x.box(cx - leg / 2, cy - leg / 2, 0, cx + leg / 2, cy + leg / 2, h - 35, 'mat-wood');
      }
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
  },
  roundTable(t, x, plan) {
    const { width: w, height: h } = t;
    x.cyl(0, 0, w / 2, h - 35, h, 'mat-wood', { segments: 40 });
    x.cyl(0, 0, 45, 30, h - 35, 'mat-wood', { segments: 12 });
    x.cyl(0, 0, w * 0.22, 0, 30, 'mat-wood', { segments: 24 });
    plan.loops.push({ pts: ellipse(0, 0, w / 2, w / 2, 40), closed: true });
  },
  chair(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    const seat = Math.min(460, h * 0.53);
    const leg = 35;
    x.box(-w / 2, -d / 2, seat - 40, w / 2, d / 2, seat, 'mat-wood');
    x.box(-w / 2, d / 2 - 40, seat, w / 2, d / 2, h, 'mat-wood');
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        const cx = sx * (w / 2 - leg / 2);
        const cy = sy * (d / 2 - leg / 2);
        x.box(cx - leg / 2, cy - leg / 2, 0, cx + leg / 2, cy + leg / 2, seat - 40, 'mat-wood');
      }
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
    plan.loops.push({ pts: [[-w / 2, d / 2 - 40], [w / 2, d / 2 - 40]] });
  },
  desk(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    x.box(-w / 2, -d / 2, h - 30, w / 2, d / 2, h, 'mat-wood-light');
    x.box(-w / 2, -d / 2 + 20, 0, -w / 2 + 30, d / 2 - 20, h - 30, 'mat-wood-light');
    x.box(w / 2 - 30, -d / 2 + 20, 0, w / 2, d / 2 - 20, h - 30, 'mat-wood-light');
    x.box(-w / 2 + 30, d / 2 - 60, h * 0.35, w / 2 - 30, d / 2 - 40, h - 30, 'mat-wood-light');
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
  },
  shelf(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    const th = 20;
    x.box(-w / 2, -d / 2, 0, -w / 2 + th, d / 2, h, 'mat-wood-light');
    x.box(w / 2 - th, -d / 2, 0, w / 2, d / 2, h, 'mat-wood-light');
    x.box(-w / 2 + th, d / 2 - 8, 0, w / 2 - th, d / 2, h, 'mat-wood-light');
    const n = Math.max(2, Math.round(h / 350));
    for (let i = 0; i <= n; i++) {
      const z = i === n ? h - th : (i * (h - th)) / n;
      x.box(-w / 2 + th, -d / 2, z, w / 2 - th, d / 2 - 8, z + th, 'mat-wood-light');
    }
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
    plan.loops.push({ pts: [[-w / 2, -d / 2], [w / 2, d / 2]] });
  },
  counter(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    x.box(-w / 2, -d / 2 + 60, 0, w / 2, d / 2, 100, 'mat-wood-frame');
    x.box(-w / 2, -d / 2 + 20, 100, w / 2, d / 2, h - 40, 'mat-paint-white');
    x.box(-w / 2, -d / 2, h - 40, w / 2, d / 2, h, 'mat-stone');
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
    plan.loops.push({ pts: [[-w / 2, -d / 2 + 20], [w / 2, -d / 2 + 20]], dash: 2 });
  },
  upperCabinet(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    x.box(-w / 2, -d / 2, 0, w / 2, d / 2, h, 'mat-paint-white');
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true, dash: 2 });
    plan.loops.push({ pts: [[-w / 2, -d / 2], [w / 2, d / 2]], dash: 2 });
    plan.loops.push({ pts: [[-w / 2, d / 2], [w / 2, -d / 2]], dash: 2 });
    plan.noFill = true;
  },
  fridge(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    x.box(-w / 2, -d / 2, 0, w / 2, d / 2, h, 'mat-aluminum');
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
    plan.loops.push({ pts: [[-w / 2, -d / 2 + 50], [w / 2, -d / 2 + 50]] });
    plan.loops.push({ pts: [[0, -d / 2], [0, -d / 2 + 50]] });
  },
  range(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    x.box(-w / 2, -d / 2, 0, w / 2, d / 2, h, 'mat-aluminum');
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        const cx = (sx * w) / 4.4;
        const cy = (sy * d) / 4.4;
        const r = Math.min(w, d) * 0.15;
        x.cyl(cx, cy, r, h, h + 8, '#2b2f35', { segments: 20 });
        plan.loops.push({ pts: ellipse(cx, cy, r, r, 20), closed: true });
      }
  },
  washer(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    x.box(-w / 2, -d / 2, 0, w / 2, d / 2, h, 'mat-porcelain');
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
    plan.loops.push({ pts: ellipse(0, 0, w * 0.3, w * 0.3, 24), closed: true });
  },
  toilet(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    const tankD = Math.min(200, d * 0.28);
    x.box(-w / 2, d / 2 - tankD, 0, w / 2, d / 2, h, 'mat-porcelain');
    const bowl = ellipse(0, d / 2 - tankD - (d - tankD) / 2 + 20, w * 0.48, (d - tankD) / 2, 24);
    x.prism(bowl, 0, 400, 'mat-porcelain', { edgeAngle: 0.5 });
    plan.loops.push({ pts: rect(-w / 2, d / 2 - tankD, w / 2, d / 2), closed: true });
    plan.loops.push({ pts: bowl, closed: true });
    plan.loops.push({ pts: ellipse(0, d / 2 - tankD - (d - tankD) / 2 + 30, w * 0.34, (d - tankD) * 0.36, 24), closed: true });
  },
  vanity(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    x.box(-w / 2, -d / 2 + 20, 0, w / 2, d / 2, h - 30, 'mat-wood-light');
    x.box(-w / 2, -d / 2, h - 30, w / 2, d / 2, h, 'mat-stone');
    const basin = ellipse(0, -20, w * 0.22, d * 0.28, 24);
    x.prism(basin, h, h + 3, '#d7dde2', { edges: true, edgeAngle: 1 });
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
    plan.loops.push({ pts: basin, closed: true });
  },
  kitchenSink(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    const gap = 40;
    const bw = (w - gap * 3) / 2;
    for (const i of [0, 1]) {
      const x0 = -w / 2 + gap + i * (bw + gap);
      x.box(x0, -d / 2 + gap, h - 10, x0 + bw, d / 2 - gap, h, '#9aa3ab');
      plan.loops.push({ pts: rect(x0, -d / 2 + gap, x0 + bw, d / 2 - gap), closed: true });
    }
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
    plan.noFill = true;
  },
  bathtub(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    x.box(-w / 2, -d / 2, 0, w / 2, d / 2, h, 'mat-porcelain');
    const inner = rect(-w / 2 + 80, -d / 2 + 80, w / 2 - 80, d / 2 - 80);
    x.prism(inner, h, h + 2, '#dfe5ea');
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
    plan.loops.push({ pts: inner, closed: true });
    plan.loops.push({ pts: ellipse(-w / 2 + 180, 0, 30, 30, 12), closed: true });
  },
  shower(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    x.box(-w / 2, -d / 2, 0, w / 2, d / 2, 60, 'mat-porcelain');
    x.box(-w / 2, -d / 2, 60, -w / 2 + 10, d / 2, h, 'mat-glass');
    x.box(-w / 2, -d / 2, 60, w / 2, -d / 2 + 10, h, 'mat-glass');
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
    plan.loops.push({ pts: [[-w / 2, -d / 2], [w / 2, d / 2]] });
    plan.loops.push({ pts: [[-w / 2, d / 2], [w / 2, -d / 2]] });
    plan.loops.push({ pts: ellipse(0, 0, 40, 40, 12), closed: true });
  },
  tree(t, x, plan) {
    const { width: w, height: h } = t;
    x.cyl(0, 0, Math.max(60, w * 0.04), 0, h * 0.45, 'mat-wood', { segments: 10 });
    x.sphere(0, 0, h * 0.62, w / 2, 'mat-foliage', { segments: 14, rings: 9, sz: (h * 0.38) / (w / 2) });
    const n = 14;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = (w / 2) * (i % 2 ? 0.86 : 1);
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    plan.loops.push({ pts, closed: true });
    plan.loops.push({ pts: [[-w * 0.12, 0], [w * 0.12, 0]] });
    plan.loops.push({ pts: [[0, -w * 0.12], [0, w * 0.12]] });
    plan.fillColor = [110, 160, 90, 60];
  },
  shrub(t, x, plan) {
    const { width: w, height: h } = t;
    x.sphere(0, 0, h / 2, w / 2, 'mat-foliage', { segments: 12, rings: 7, sz: h / w });
    plan.loops.push({ pts: ellipse(0, 0, w / 2, w / 2, 18), closed: true });
    plan.fillColor = [110, 160, 90, 60];
  },
  pendant(t, x, plan) {
    const { width: w, height: h } = t;
    x.cyl(0, 0, 4, h, h + 600, 'mat-steel', { segments: 6, edges: false });
    x.cyl(0, 0, w / 2, 0, h, 'mat-paint-white', { r1: w * 0.12, segments: 24 });
    plan.loops.push({ pts: ellipse(0, 0, w / 2, w / 2, 24), closed: true, dash: 2 });
    plan.loops.push({ pts: [[-w / 2, 0], [w / 2, 0]], dash: 2 });
    plan.loops.push({ pts: [[0, -w / 2], [0, w / 2]], dash: 2 });
    plan.noFill = true;
  },
  floorLamp(t, x, plan) {
    const { width: w, height: h } = t;
    x.cyl(0, 0, w * 0.35, 0, 25, 'mat-steel', { segments: 20 });
    x.cyl(0, 0, 12, 25, h - 300, 'mat-steel', { segments: 8 });
    x.cyl(0, 0, w / 2, h - 300, h, 'mat-fabric-warm', { r1: w * 0.32, segments: 24 });
    plan.loops.push({ pts: ellipse(0, 0, w / 2, w / 2, 24), closed: true });
    plan.loops.push({ pts: ellipse(0, 0, w * 0.1, w * 0.1, 10), closed: true });
  },
  downlight(t, x, plan) {
    const { width: w, height: h } = t;
    x.cyl(0, 0, w / 2, h - 20, h, 'mat-paint-white', { segments: 20 });
    x.cyl(0, 0, w * 0.38, 0, h - 20, 'mat-aluminum', { segments: 16 });
    plan.loops.push({ pts: ellipse(0, 0, w / 2, w / 2, 20), closed: true });
    plan.loops.push({ pts: [[-w * 0.35, -w * 0.35], [w * 0.35, w * 0.35]] }, { pts: [[-w * 0.35, w * 0.35], [w * 0.35, -w * 0.35]] });
    plan.noFill = true;
  },
  sprinkler(t, x, plan) {
    // Pendant head: a deflector disc under a short body, hanging below the ceiling.
    const { width: w, height: h } = t;
    x.cyl(0, 0, w / 2, 0, 6, 'mat-steel', { segments: 16 });
    x.cyl(0, 0, w * 0.18, 6, h, 'mat-steel', { segments: 10 });
    x.cyl(0, 0, w * 0.3, h - 12, h, 'mat-paint-white', { segments: 14 });
    plan.loops.push({ pts: ellipse(0, 0, w / 2, w / 2, 16), closed: true });
    plan.loops.push({ pts: [[-w * 0.5, 0], [w * 0.5, 0]] }, { pts: [[0, -w * 0.5], [0, w * 0.5]] });
    plan.noFill = true;
  },
  diffuser(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    x.box(-w / 2, -d / 2, h - 20, w / 2, d / 2, h, 'mat-paint-white');
    x.box(-w * 0.3, -d * 0.3, 0, w * 0.3, d * 0.3, h - 20, 'mat-aluminum');
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
    plan.loops.push({ pts: rect(-w * 0.3, -d * 0.3, w * 0.3, d * 0.3), closed: true });
    plan.loops.push({ pts: [[-w / 2, -d / 2], [w / 2, d / 2]] }, { pts: [[-w / 2, d / 2], [w / 2, -d / 2]] });
    plan.noFill = true;
  },
  grille(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    x.box(-w / 2, -d / 2, h - 20, w / 2, d / 2, h, 'mat-paint-white');
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
    for (let i = 1; i < 6; i++) plan.loops.push({ pts: [[-w / 2 + (w * i) / 6, -d / 2], [-w / 2 + (w * i) / 6, d / 2]] });
    plan.noFill = true;
  },
  mechUnit(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    x.box(-w / 2, -d / 2, 0, w / 2, d / 2, h, '#b9c2cb');
    x.cyl(w * 0.22, 0, Math.min(w, d) * 0.3, h, h + 20, 'mat-steel', { segments: 20 });
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
    plan.loops.push({ pts: ellipse(w * 0.22, 0, Math.min(w, d) * 0.3, Math.min(w, d) * 0.3, 20), closed: true });
    plan.loops.push({ pts: [[-w / 2, -d / 2], [w * 0.22 - Math.min(w, d) * 0.3, 0]] }, { pts: [[-w / 2, d / 2], [w * 0.22 - Math.min(w, d) * 0.3, 0]] });
  },
  waterHeater(t, x, plan) {
    const { width: w, height: h } = t;
    x.cyl(0, 0, w / 2, 0, h, 'mat-paint-white', { segments: 24 });
    plan.loops.push({ pts: ellipse(0, 0, w / 2, w / 2, 24), closed: true });
    plan.loops.push({ pts: ellipse(0, 0, w * 0.15, w * 0.15, 12), closed: true });
  },
  panel(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    x.box(-w / 2, -d / 2, 0, w / 2, d / 2, h, '#8a939c');
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
    plan.fillColor = [60, 66, 74, 220];
  },
  receptacle(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    x.box(-w / 2, d / 2 - 15, 0, w / 2, d / 2, h, 'mat-paint-white');
    // Plan symbol: a circle with two parallel strokes, drawn at a readable size.
    const r = 110;
    plan.loops.push({ pts: ellipse(0, d / 2 - r, r, r, 16), closed: true });
    plan.loops.push({ pts: [[-r * 1.5, d / 2 - r * 0.6], [r * 1.5, d / 2 - r * 0.6]] }, { pts: [[-r * 1.5, d / 2 - r * 1.4], [r * 1.5, d / 2 - r * 1.4]] });
    plan.noFill = true;
  },
  switch(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    x.box(-w / 2, d / 2 - 15, 0, w / 2, d / 2, h, 'mat-paint-white');
    const r = 110;
    plan.loops.push({ pts: ellipse(0, d / 2 - r, r, r, 16), closed: true });
    plan.loops.push({ pts: [[0, d / 2 - r * 2], [r * 1.4, d / 2 - r * 3]] });
    plan.noFill = true;
  },
  bench(t, x, plan) {
    const { width: w, depth: d, height: h } = t;
    for (const sx of [-1, 1]) x.box(sx * (w / 2 - 120) - 40, -d / 2 + 40, 0, sx * (w / 2 - 120) + 40, d / 2 - 40, h - 60, 'mat-steel');
    x.box(-w / 2, -d / 2, h - 60, w / 2, d / 2, h, 'mat-wood');
    plan.loops.push({ pts: rect(-w / 2, -d / 2, w / 2, d / 2), closed: true });
    for (let i = 1; i < 4; i++) plan.loops.push({ pts: [[-w / 2, -d / 2 + (d * i) / 4], [w / 2, -d / 2 + (d * i) / 4]] });
  },
  bollard(t, x, plan) {
    const { width: w, height: h } = t;
    x.cyl(0, 0, w / 2, 0, h, 'mat-concrete', { segments: 18 });
    plan.loops.push({ pts: ellipse(0, 0, w / 2, w / 2, 18), closed: true });
  },
  parking(t, x, plan) {
    const { width: w, depth: d } = t;
    // Painted stripes on the ground: the two sides and the end.
    const s = 100;
    x.box(-w / 2, -d / 2, 0, -w / 2 + s, d / 2, 2, 'mat-paint-white');
    x.box(w / 2 - s, -d / 2, 0, w / 2, d / 2, 2, 'mat-paint-white');
    plan.loops.push({ pts: [[-w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2], [w / 2, -d / 2]] });
    plan.noFill = true;
  },
};

export const FAMILIES = Object.keys(F);

/**
 * Build a component: emits 3D geometry into `builder` (may be null) and
 * returns its plan symbol in local coordinates.
 */
export function buildFamily(type, frame, builder, materialOf) {
  const plan = { loops: [], noFill: false, fillColor: null };
  const fn = F[type?.family] || F.cabinet;
  const t = { width: +type?.width || 600, depth: +type?.depth || 600, height: +type?.height || 900 };
  fn(t, new FamilyContext(builder, frame, materialOf), plan);
  plan.outline = rect(-t.width / 2, -t.depth / 2, t.width / 2, t.depth / 2);
  if (['roundTable', 'tree', 'shrub', 'pendant', 'floorLamp', 'downlight', 'waterHeater', 'bollard', 'sprinkler'].includes(type?.family)) plan.outline = ellipse(0, 0, t.width / 2, t.depth / 2, 24);
  return plan;
}
