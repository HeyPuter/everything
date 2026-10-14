import { ribbonGeometry } from './ribbon-geometry.js';

/**
 * More preset geometries from ECMA-376 Part 1 §20.1.10.56 (ST_ShapeType), each written from the guide
 * formulas of the standard's preset shape definitions: adjustment defaults and pins, the outline paths
 * and the text rectangle. Same format as PRESET_GEOMETRIES: build(w, h, adj) returns { points, text } or,
 * for presets with several paths (stroke-only details, shaded faces, fixed coordinate grids),
 * { paths: [{ points, fill, stroke, fillMode?, width?, height? }], text } — text is [l, t, r, b] in shape units.
 */
const pin = (low, value, high) => Math.max(low, Math.min(high, value));
const rad = angle => angle * Math.PI / 180;
const deg = angle => angle * 180 / Math.PI;
const cos = (r, angle) => r * Math.cos(rad(angle)), sin = (r, angle) => r * Math.sin(rad(angle));
/** DrawingML "at2 x y": the angle of (x, y) in degrees. */
const at2 = (x, y) => deg(Math.atan2(y, x));
const poly = (...pts) => [...pts.map(([x, y], i) => [i ? 'L' : 'M', x, y]), ['Z']];

/**
 * Append a DrawingML arcTo as cubic Béziers (at most 45° each). Angles are in degrees, clockwise
 * with y down, and are visual angles: they are mapped onto the ellipse's own parameter first.
 */
export function appendArc(points, x, y, rx, ry, start, sweep) {
  if (!sweep) return [x, y];
  if (!(rx > 0 && ry > 0)) {
    // A collapsed ellipse moves only along its remaining axis.
    const nx = x + rx * (Math.cos(rad(start + sweep)) - Math.cos(rad(start))), ny = y + ry * (Math.sin(rad(start + sweep)) - Math.sin(rad(start)));
    points.push(['L', nx, ny]);
    return [nx, ny];
  }
  const parameter = angle => Math.atan2(rx * Math.sin(rad(angle)), ry * Math.cos(rad(angle)));
  const a = parameter(start);
  let delta = parameter(start + sweep) - a;
  if (Math.abs(sweep) >= 360) delta = Math.sign(sweep) * 2 * Math.PI;
  else if (sweep > 0 && delta <= 0) delta += 2 * Math.PI;
  else if (sweep < 0 && delta >= 0) delta -= 2 * Math.PI;
  const cx = x - rx * Math.cos(a), cy = y - ry * Math.sin(a), count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 4) - 1e-9));
  for (let i = 0; i < count; i++) {
    const from = a + delta * i / count, to = a + delta * (i + 1) / count, k = 4 / 3 * Math.tan((to - from) / 4);
    x = cx + rx * Math.cos(to); y = cy + ry * Math.sin(to);
    points.push(['C', cx + rx * (Math.cos(from) - k * Math.sin(from)), cy + ry * (Math.sin(from) + k * Math.cos(from)), x + rx * k * Math.sin(to), y - ry * k * Math.cos(to), x, y]);
  }
  return [x, y];
}

/** A small path recorder mirroring CT_Path2D's moveTo/lnTo/cubicBezTo/quadBezTo/arcTo/close. */
function pen() {
  const points = []; let x = 0, y = 0;
  const p = {
    points,
    M(a, b) { points.push(['M', a, b]); x = a; y = b; return p; },
    L(a, b) { points.push(['L', a, b]); x = a; y = b; return p; },
    C(a, b, c, d, e, f) { points.push(['C', a, b, c, d, e, f]); x = e; y = f; return p; },
    Q(a, b, c, d) { points.push(['Q', a, b, c, d]); x = c; y = d; return p; },
    A(rx, ry, start, sweep) { [x, y] = appendArc(points, x, y, rx, ry, start, sweep); return p; },
    Z() { points.push(['Z']); return p; },
  };
  return p;
}
/** One path of a preset: options.fill/stroke default to true; mode is the path's fill mode; w/h a fixed grid. */
function path(draw, { fill = true, stroke = true, mode, w, h } = {}) {
  const p = pen(); draw(p);
  return { points: p.points, fill, stroke, ...(mode ? { fillMode: mode } : {}), ...(w ? { width: w, height: h } : {}) };
}
const FILL = { stroke: false }, LINE = { fill: false };
/** The text rectangle inscribed in the w × h ellipse at 45°. */
const inscribed = (w, h, cx = w / 2, cy = h / 2) => [cx - w / 2 * Math.SQRT1_2, cy - h / 2 * Math.SQRT1_2, cx + w / 2 * Math.SQRT1_2, cy + h / 2 * Math.SQRT1_2];
/** The point of an ellipse centred at (cx, cy) at a visual angle. */
function onEllipse(cx, cy, rx, ry, angle) {
  const t = Math.atan2(rx * Math.sin(rad(angle)), ry * Math.cos(rad(angle)));
  return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
}
/** A positive sweep from start to end, a full turn when they coincide (the standard's "?: sw1 sw1 sw2"). */
const sweepBetween = (start, end) => end - start > 0 ? end - start : end - start + 360;
const angleAdj = value => pin(0, value, 21599999) / 60000;

/** A filled outline with a separately stroked detail path (flowchart internals, can rims, folds). */
const outlined = (body, details, size = {}) => [path(body, { ...FILL, ...size }), path(details, { ...LINE, ...size }), path(body, { ...LINE, ...size })];

/** An n-point star; text(ix, iy) gives the text box's half extents from the inner radii (default: the inner ellipse at 45°). */
function star(n, defaults, text = (ix, iy) => [cos(ix, 45), sin(iy, 45)]) {
  return {
    defaults,
    build: (w, h, adj) => {
      const a = pin(0, adj('adj'), 50000), hf = 'hf' in defaults ? adj('hf') : 100000, vf = 'vf' in defaults ? adj('vf') : 100000;
      // hf/vf stretch the outer ellipse so the outermost points reach the frame; the centre moves with vf.
      const rx = w / 2 * hf / 100000, ry = h / 2 * vf / 100000, cy = h / 2 * vf / 100000, ix = rx * a / 50000, iy = ry * a / 50000;
      const points = [];
      for (let k = 0; k < n; k++) {
        const outer = 270 + 360 * k / n, inner = outer + 180 / n;
        points.push([k ? 'L' : 'M', w / 2 + cos(rx, outer), cy + sin(ry, outer)], ['L', w / 2 + cos(ix, inner), cy + sin(iy, inner)]);
      }
      points.push(['Z']);
      const [tx, ty] = text(ix, iy);
      return { points, text: [w / 2 - tx, cy - ty, w / 2 + tx, cy + ty] };
    },
  };
}

/** The four arrowhead callouts share their adjustment pins; `along` is the arrow's axis extent. */
function arrowCallout(w, h, adj, vertical) {
  const ss = Math.min(w, h), across = vertical ? w : h, along = vertical ? h : w;
  const a2 = pin(0, adj('adj2'), 50000 * across / ss), a1 = pin(0, adj('adj1'), a2 * 2), a3 = pin(0, adj('adj3'), 100000 * along / ss);
  const a4 = pin(0, adj('adj4'), 100000 - a3 * ss / along);
  return { ss, a1, a2, a3, a4, dy1: ss * a2 / 100000, dy2: ss * a1 / 200000, head: ss * a3 / 100000, box: along * a4 / 100000 };
}

/** Shared tail-placement guides of wedgeRectCallout and wedgeRoundRectCallout. */
function wedgeTail(w, h, adj) {
  const dxPos = w * adj('adj1') / 100000, dyPos = h * adj('adj2') / 100000, xPos = w / 2 + dxPos, yPos = h / 2 + dyPos;
  const dz = Math.abs(dyPos) - Math.abs(dxPos * h / w);
  const x1 = w * (dxPos > 0 ? 7 : 2) / 12, x2 = w * (dxPos > 0 ? 10 : 5) / 12, y1 = h * (dyPos > 0 ? 7 : 2) / 12, y2 = h * (dyPos > 0 ? 10 : 5) / 12;
  // The tail leaves the edge facing the tip: vertical edges when the tip is further off sideways.
  return {
    x1, x2, y1, y2,
    left: [dz > 0 ? 0 : dxPos > 0 ? 0 : xPos, dz > 0 ? y1 : dxPos > 0 ? y1 : yPos],
    top: [dz > 0 ? (dyPos > 0 ? x1 : xPos) : x1, dz > 0 ? (dyPos > 0 ? 0 : yPos) : 0],
    right: [dz > 0 ? w : dxPos > 0 ? xPos : w, dz > 0 ? y1 : dxPos > 0 ? yPos : y1],
    bottom: [dz > 0 ? (dyPos > 0 ? xPos : x1) : x1, dz > 0 ? (dyPos > 0 ? yPos : h) : h],
  };
}

/** Line callouts: the box (bordered or not), an optional accent bar, and the stroke-only leader. */
function lineCallout(border, accent) {
  return {
    defaults: { adj1: 18750, adj2: -8333, adj3: 112500, adj4: -38333 },
    build: (w, h, adj) => {
      const y1 = h * adj('adj1') / 100000, x1 = w * adj('adj2') / 100000, y2 = h * adj('adj3') / 100000, x2 = w * adj('adj4') / 100000;
      return { paths: [
        path(p => p.M(0, 0).L(w, 0).L(w, h).L(0, h).Z(), border ? {} : FILL),
        ...(accent ? [path(p => p.M(x1, 0).L(x1, h), LINE)] : []),
        path(p => p.M(x1, y1).L(x2, y2), LINE),
      ], text: [0, 0, w, h] };
    },
  };
}

/** horizontalScroll; verticalScroll is its transpose (rolls along the left and right instead of top and bottom). */
function scroll(w, h, adj) {
  const ch = Math.min(w, h) * pin(0, adj('adj'), 25000) / 100000, ch2 = ch / 2, ch4 = ch / 4;
  const y3 = ch + ch2, y4 = ch + ch, y6 = h - ch, y7 = h - ch2, y5 = y6 - ch2, x3 = w - ch, x4 = w - ch2;
  const curl = p => p.M(ch2, y4).A(ch2, ch2, 90, -90).A(ch4, ch4, 0, -180).Z();
  return { paths: [
    path(p => { p.M(w, ch2).A(ch2, ch2, 0, 90).L(x4, ch2).A(ch4, ch4, 0, 180).L(x3, ch).L(ch2, ch).A(ch2, ch2, 270, -90).L(0, y7).A(ch2, ch2, 180, -180)
      .L(ch, y6).L(x4, y6).A(ch2, ch2, 90, -90).Z(); curl(p); }, FILL),
    path(p => { curl(p); p.M(x4, ch).A(ch2, ch2, 90, -270).A(ch4, ch4, 180, -180).Z(); }, { ...FILL, mode: 'darkenLess' }),
    path(p => {
      p.M(0, y3).A(ch2, ch2, 180, 90).L(x3, ch).L(x3, ch2).A(ch2, ch2, 180, 180).L(w, y5).A(ch2, ch2, 0, 90).L(ch, y6).L(ch, y7).A(ch2, ch2, 0, 180).Z();
      p.M(x3, ch).L(x4, ch).A(ch2, ch2, 90, -90);
      p.M(x4, ch).L(x4, ch2).A(ch4, ch4, 0, 180);
      p.M(ch2, y4).L(ch2, y3).A(ch4, ch4, 180, 180).A(ch2, ch2, 0, 180);
      p.M(ch, y3).L(ch, y6);
    }, LINE),
  ], text: [ch, ch, x4, y6] };
}

export const MORE_PRESET_GEOMETRIES = {
  // Rectangles
  snip1Rect: {
    defaults: { adj: 16667 },
    build: (w, h, adj) => {
      const dx1 = Math.min(w, h) * pin(0, adj('adj'), 50000) / 100000, x1 = w - dx1;
      return { points: poly([0, 0], [x1, 0], [w, dx1], [w, h], [0, h]), text: [0, dx1 / 2, (w + x1) / 2, h] };
    },
  },
  snip2SameRect: {
    defaults: { adj1: 16667, adj2: 0 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), tx1 = ss * pin(0, adj('adj1'), 50000) / 100000, bx1 = ss * pin(0, adj('adj2'), 50000) / 100000;
      const tx2 = w - tx1, bx2 = w - bx1, by1 = h - bx1, il = (tx1 - bx1 > 0 ? tx1 : bx1) / 2;
      return { points: poly([tx1, 0], [tx2, 0], [w, tx1], [w, by1], [bx2, h], [bx1, h], [0, by1], [0, tx1]), text: [il, tx1 / 2, w - il, (by1 + h) / 2] };
    },
  },
  snip2DiagRect: {
    defaults: { adj1: 0, adj2: 16667 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), lx1 = ss * pin(0, adj('adj1'), 50000) / 100000, rx1 = ss * pin(0, adj('adj2'), 50000) / 100000;
      const il = (lx1 - rx1 > 0 ? lx1 : rx1) / 2;
      return { points: poly([lx1, 0], [w - rx1, 0], [w, rx1], [w, h - lx1], [w - lx1, h], [rx1, h], [0, h - rx1], [0, lx1]), text: [il, il, w - il, h - il] };
    },
  },
  snipRoundRect: {
    defaults: { adj1: 16667, adj2: 16667 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), x1 = ss * pin(0, adj('adj1'), 50000) / 100000, dx2 = ss * pin(0, adj('adj2'), 50000) / 100000, x2 = w - dx2;
      return { points: pen().M(x1, 0).L(x2, 0).L(w, dx2).L(w, h).L(0, h).L(0, x1).A(x1, x1, 180, 90).Z().points, text: [x1 / 2, x1 / 2, (x2 + w) / 2, h] };
    },
  },
  round1Rect: {
    defaults: { adj: 16667 },
    build: (w, h, adj) => {
      const dx1 = Math.min(w, h) * pin(0, adj('adj'), 50000) / 100000, x1 = w - dx1;
      return { points: pen().M(0, 0).L(x1, 0).A(dx1, dx1, 270, 90).L(w, h).L(0, h).Z().points, text: [0, 0, w - dx1 * 29289 / 100000, h] };
    },
  },
  round2DiagRect: {
    defaults: { adj1: 16667, adj2: 0 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), x1 = ss * pin(0, adj('adj1'), 50000) / 100000, a = ss * pin(0, adj('adj2'), 50000) / 100000;
      const dx = Math.max(x1, a) * 29289 / 100000;
      return { points: pen().M(x1, 0).L(w - a, 0).A(a, a, 270, 90).L(w, h - x1).A(x1, x1, 0, 90).L(a, h).A(a, a, 90, 90).L(0, x1).A(x1, x1, 180, 90).Z().points, text: [dx, dx, w - dx, h - dx] };
    },
  },

  // Basic shapes
  heptagon: {
    defaults: { hf: 102572, vf: 105210 },
    build: (w, h, adj) => {
      const swd2 = w / 2 * adj('hf') / 100000, shd2 = h / 2 * adj('vf') / 100000, svc = h / 2 * adj('vf') / 100000, hc = w / 2;
      const x1 = hc - swd2 * .97493, x2 = hc - swd2 * .78183, x3 = hc - swd2 * .43388, x4 = hc + swd2 * .43388, x5 = hc + swd2 * .78183, x6 = hc + swd2 * .97493;
      const y1 = svc - shd2 * .62349, y2 = svc + shd2 * .22252, y3 = svc + shd2 * .90097;
      return { points: poly([x1, y2], [x2, y1], [hc, 0], [x5, y1], [x6, y2], [x4, y3], [x3, y3]), text: [x2, y1, x5, y3] };
    },
  },
  decagon: {
    defaults: { vf: 105146 },
    build: (w, h, adj) => {
      const shd2 = h / 2 * adj('vf') / 100000, hc = w / 2, vc = h / 2;
      const x1 = hc - cos(w / 2, 36), x2 = hc - cos(w / 2, 72), x3 = hc + cos(w / 2, 72), x4 = hc + cos(w / 2, 36);
      const y1 = vc - sin(shd2, 72), y2 = vc - sin(shd2, 36), y3 = vc + sin(shd2, 36), y4 = vc + sin(shd2, 72);
      return { points: poly([0, vc], [x1, y2], [x2, y1], [x3, y1], [x4, y2], [w, vc], [x4, y3], [x3, y4], [x2, y4], [x1, y3]), text: [x1, y2, x4, y3] };
    },
  },
  dodecagon: {
    defaults: {},
    build: (w, h) => {
      const x = n => w * n / 21600, y = n => h * n / 21600;
      return { points: poly([0, y(7906)], [x(2894), y(2894)], [x(7906), 0], [x(13694), 0], [x(18706), y(2894)], [w, y(7906)], [w, y(13694)], [x(18706), y(18706)], [x(13694), h], [x(7906), h], [x(2894), y(18706)], [0, y(13694)]),
        text: [x(2894), y(2894), x(18706), y(18706)] };
    },
  },
  can: {
    defaults: { adj: 25000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), y1 = ss * pin(0, adj('adj'), 50000 * h / ss) / 200000, y3 = h - y1, wd2 = w / 2;
      return { paths: [
        path(p => p.M(0, y1).A(wd2, y1, 180, -180).L(w, y3).A(wd2, y1, 0, 90).A(wd2, y1, 90, 90).Z(), FILL),
        path(p => p.M(0, y1).A(wd2, y1, 180, 180).A(wd2, y1, 0, 180).Z(), { ...FILL, mode: 'lighten' }),
        path(p => p.M(w, y1).A(wd2, y1, 0, 180).A(wd2, y1, 180, 180).L(w, y3).A(wd2, y1, 0, 180).L(0, y1), LINE),
      ], text: [0, y1 * 2, w, y3] };
    },
  },
  cube: {
    defaults: { adj: 25000 },
    build: (w, h, adj) => {
      const y1 = Math.min(w, h) * pin(0, adj('adj'), 100000) / 100000, y4 = h - y1, x4 = w - y1;
      return { paths: [
        path(p => p.M(0, y1).L(x4, y1).L(x4, h).L(0, h).Z(), FILL),
        path(p => p.M(x4, y1).L(w, 0).L(w, y4).L(x4, h).Z(), { ...FILL, mode: 'darkenLess' }),
        path(p => p.M(0, y1).L(y1, 0).L(w, 0).L(x4, y1).Z(), { ...FILL, mode: 'lightenLess' }),
        path(p => p.M(0, y1).L(y1, 0).L(w, 0).L(w, y4).L(x4, h).L(0, h).Z().M(0, y1).L(x4, y1).L(w, 0).M(x4, y1).L(x4, h), LINE),
      ], text: [0, y1, x4, h] };
    },
  },
  bevel: {
    defaults: { adj: 12500 },
    build: (w, h, adj) => {
      const x1 = Math.min(w, h) * pin(0, adj('adj'), 50000) / 100000, x2 = w - x1, y2 = h - x1;
      return { paths: [
        path(p => p.M(x1, x1).L(x2, x1).L(x2, y2).L(x1, y2).Z(), FILL),
        path(p => p.M(0, 0).L(w, 0).L(x2, x1).L(x1, x1).Z(), { ...FILL, mode: 'lightenLess' }),
        path(p => p.M(0, h).L(x1, y2).L(x2, y2).L(w, h).Z(), { ...FILL, mode: 'darkenLess' }),
        path(p => p.M(0, 0).L(x1, x1).L(x1, y2).L(0, h).Z(), { ...FILL, mode: 'lighten' }),
        path(p => p.M(w, 0).L(w, h).L(x2, y2).L(x2, x1).Z(), { ...FILL, mode: 'darken' }),
        path(p => p.M(0, 0).L(w, 0).L(w, h).L(0, h).Z().M(x1, x1).L(x2, x1).L(x2, y2).L(x1, y2).Z()
          .M(0, 0).L(x1, x1).M(0, h).L(x1, y2).M(w, 0).L(x2, x1).M(w, h).L(x2, y2), LINE),
      ], text: [x1, x1, x2, y2] };
    },
  },
  foldedCorner: {
    defaults: { adj: 16667 },
    build: (w, h, adj) => {
      const dy2 = Math.min(w, h) * pin(0, adj('adj'), 50000) / 100000, dy1 = dy2 / 5, x1 = w - dy2, x2 = x1 + dy1, y2 = h - dy2, y1 = y2 + dy1;
      return { paths: [
        path(p => p.M(0, 0).L(w, 0).L(w, y2).L(x1, h).L(0, h).Z(), FILL),
        path(p => p.M(x1, h).L(x2, y1).L(w, y2).Z(), { ...FILL, mode: 'darkenLess' }),
        path(p => p.M(x1, h).L(x2, y1).L(w, y2).M(x1, h).L(0, h).L(0, 0).L(w, 0).L(w, y2), LINE),
      ], text: [0, 0, w, y2] };
    },
  },
  smileyFace: {
    defaults: { adj: 4653 },
    build: (w, h, adj) => {
      const a = pin(-4653, adj('adj'), 4653), x = n => w * n / 21600, y = n => h * n / 21600;
      const y1 = y(7570), y3 = y(16515), dy2 = h * a / 100000, y2 = y3 - dy2, y5 = y3 + dy2 + h * a / 50000, wR = x(1125), hR = y(1125);
      const face = p => p.M(0, h / 2).A(w / 2, h / 2, 180, 360).Z();
      return { paths: [
        path(face, FILL),
        path(p => p.M(x(6215), y1).A(wR, hR, 180, 360).M(x(13135), y1).A(wR, hR, 180, 360), { mode: 'darkenLess' }),
        path(p => p.M(x(4969), y2).Q(w / 2, y5, x(16640), y2), LINE),
        path(face, LINE),
      ], text: inscribed(w, h) };
    },
  },
  heart: {
    defaults: {},
    build: (w, h) => {
      const hc = w / 2, dx1 = w * 49 / 48, dx2 = w * 10 / 48, y1 = -h / 3;
      return { points: pen().M(hc, h / 4).C(hc + dx2, y1, hc + dx1, h / 4, hc, h).C(hc - dx1, h / 4, hc - dx2, y1, hc, h / 4).Z().points, text: [w / 6, h / 4, w * 5 / 6, h * 2 / 3] };
    },
  },
  lightningBolt: {
    defaults: {},
    build: (w, h) => ({
      paths: [path(p => { p.points.push(...poly([8472, 0], [12860, 6080], [11050, 6797], [16577, 12007], [14767, 12877], [21600, 21600], [10012, 14915], [12222, 13987], [5022, 9705], [7602, 8382], [0, 3890])); }, { w: 21600, h: 21600 })],
      text: [w * 8757 / 21600, h * 7437 / 21600, w * 13917 / 21600, h * 14277 / 21600],
    }),
  },
  sun: {
    defaults: { adj: 25000 },
    build: (w, h, adj) => {
      const a = pin(12500, adj('adj'), 46875), g0 = 50000 - a, g1 = g0 * 30274 / 32768, g2 = g0 * 12540 / 32768;
      const g5 = 50000 - g1, g6 = 50000 - g2, g10 = g5 * 3 / 4, g11 = g6 * 3 / 4, g12 = g10 + 3662, g13 = g11 + 3662, g14 = g11 + 12500;
      const g15 = 100000 - g10, g16 = 100000 - g12, g17 = 100000 - g13, g18 = 100000 - g14;
      const X = g => w * g / 100000, Y = g => h * g / 100000, ox1 = w * 18436 / 21600, oy1 = h * 3163 / 21600, ox2 = w * 3163 / 21600, oy2 = h * 18436 / 21600;
      const rays = [
        [[w, h / 2], [X(g15), Y(g18)], [X(g15), Y(g14)]], [[ox1, oy1], [X(g16), Y(g13)], [X(g17), Y(g12)]],
        [[w / 2, 0], [X(g18), Y(g10)], [X(g14), Y(g10)]], [[ox2, oy1], [X(g13), Y(g12)], [X(g12), Y(g13)]],
        [[0, h / 2], [X(g10), Y(g14)], [X(g10), Y(g18)]], [[ox2, oy2], [X(g12), Y(g17)], [X(g13), Y(g16)]],
        [[w / 2, h], [X(g14), Y(g15)], [X(g18), Y(g15)]], [[ox1, oy2], [X(g17), Y(g16)], [X(g16), Y(g17)]],
      ];
      const wR = X(g0), hR = Y(g0);
      return { points: [...rays.flatMap(r => poly(...r)), ...pen().M(X(a), h / 2).A(wR, hR, 180, 360).Z().points], text: inscribed(2 * wR, 2 * hR, w / 2, h / 2) };
    },
  },
  moon: {
    defaults: { adj: 50000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), hd2 = h / 2, g0 = ss * pin(0, adj('adj'), 87500) / 100000, g0w = g0 * w / ss, g1 = ss - g0;
      const g5 = ss * ss / g1 * 2 - g0 * g0 / g1, g6w = (g5 - g0) * w / ss, dy1 = (g5 / 2 - g0) * hd2 / ss;
      const g12 = g0 * 9598 / 32768, dy4 = Math.sqrt(Math.max(0, ss * ss - (ss - g12) ** 2)) * hd2 / ss;
      // The inner edge is an ellipse arc through both tips and the crescent's innermost point.
      const g18w = (g6w - g0w) / 2, dx2 = -(g0w + g18w - w), stAng = at2(dx2, -hd2), swAng = at2(dx2, hd2) - 360 - stAng;
      return { points: pen().M(w, h).A(w, hd2, 90, 180).A(g18w, dy1, stAng, swAng).Z().points, text: [g12 * w / ss, hd2 - dy4, g0w, hd2 + dy4] };
    },
  },
  blockArc: {
    defaults: { adj1: 10800000, adj2: 0, adj3: 25000 },
    build: (w, h, adj) => {
      const start = angleAdj(adj('adj1')), innerStart = angleAdj(adj('adj2')), dr = Math.min(w, h) * pin(0, adj('adj3'), 50000) / 100000;
      const swAng = sweepBetween(start, innerStart), iw = w / 2 - dr, ih = h / 2 - dr;
      const outer = onEllipse(w / 2, h / 2, w / 2, h / 2, start), inner = onEllipse(w / 2, h / 2, iw, ih, innerStart);
      const points = pen().M(...outer).A(w / 2, h / 2, start, swAng).L(...inner).A(iw, ih, innerStart, -swAng).Z().points;
      // The text box bounds the band: both arcs' ends plus every axis crossing inside the sweep.
      const xs = [], ys = [];
      for (const [rx, ry] of [[w / 2, h / 2], [iw, ih]]) {
        for (const angle of [start, start + swAng, ...[0, 90, 180, 270, 360, 450, 540, 630].filter(q => q > start && q < start + swAng)]) {
          const [px, py] = onEllipse(w / 2, h / 2, rx, ry, angle); xs.push(px); ys.push(py);
        }
      }
      return { points, text: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
    },
  },
  teardrop: {
    defaults: { adj: 100000 },
    build: (w, h, adj) => {
      const a = pin(0, adj('adj'), 200000), hc = w / 2, vc = h / 2, wd2 = w / 2, hd2 = h / 2;
      const x1 = hc + cos(Math.SQRT2 * wd2 * a / 100000, 45), y1 = vc - sin(Math.SQRT2 * hd2 * a / 100000, 45), x2 = (hc + x1) / 2, y2 = (vc + y1) / 2;
      return { points: pen().M(0, vc).A(wd2, hd2, 180, 90).Q(x2, 0, x1, y1).Q(w, y2, w, vc).A(wd2, hd2, 0, 90).A(wd2, hd2, 90, 90).Z().points, text: inscribed(w, h) };
    },
  },
  pie: {
    defaults: { adj1: 0, adj2: 16200000 },
    build: (w, h, adj) => {
      const start = angleAdj(adj('adj1')), sweep = sweepBetween(start, angleAdj(adj('adj2')));
      return { points: pen().M(...onEllipse(w / 2, h / 2, w / 2, h / 2, start)).A(w / 2, h / 2, start, sweep).L(w / 2, h / 2).Z().points, text: inscribed(w, h) };
    },
  },
  chord: {
    defaults: { adj1: 2700000, adj2: 16200000 },
    build: (w, h, adj) => {
      const start = angleAdj(adj('adj1')), sweep = sweepBetween(start, angleAdj(adj('adj2')));
      return { points: pen().M(...onEllipse(w / 2, h / 2, w / 2, h / 2, start)).A(w / 2, h / 2, start, sweep).Z().points, text: inscribed(w, h) };
    },
  },
  noSmoking: {
    defaults: { adj: 18750 },
    build: (w, h, adj) => {
      const dr = Math.min(w, h) * pin(0, adj('adj'), 50000) / 100000, iw = w / 2 - dr, ih = h / 2 - dr, diagonal = at2(w, h);
      const polar = angle => iw * ih / Math.hypot(cos(ih, angle), sin(iw, angle));
      // Each hole is the inner ellipse cut by a chord parallel to the bar, dr/2 from the centre line.
      const dang = at2(polar(diagonal), dr / 2), swAng = -180 + 2 * dang, st1 = diagonal - dang, n1 = polar(st1);
      const dx1 = cos(n1, st1), dy1 = sin(n1, st1);
      const p = pen().M(0, h / 2).A(w / 2, h / 2, 180, 360).Z();
      if (iw > 0 && ih > 0) p.M(w / 2 + dx1, h / 2 + dy1).A(iw, ih, st1, swAng).Z().M(w / 2 - dx1, h / 2 - dy1).A(iw, ih, st1 - 180, swAng).Z();
      return { points: p.points, text: inscribed(w, h) };
    },
  },
  bracketPair: {
    defaults: { adj: 16667 },
    build: (w, h, adj) => {
      const x1 = Math.min(w, h) * pin(0, adj('adj'), 50000) / 100000, x2 = w - x1, y2 = h - x1, il = x1 * 29289 / 100000;
      return { paths: [
        path(p => p.M(0, x1).A(x1, x1, 180, 90).L(x2, 0).A(x1, x1, 270, 90).L(w, y2).A(x1, x1, 0, 90).L(x1, h).A(x1, x1, 90, 90).Z(), FILL),
        path(p => p.M(x1, h).A(x1, x1, 90, 90).L(0, x1).A(x1, x1, 180, 90).M(x2, 0).A(x1, x1, 270, 90).L(w, y2).A(x1, x1, 0, 90), LINE),
      ], text: [il, il, w - il, h - il] };
    },
  },
  bracePair: {
    defaults: { adj: 8333 },
    build: (w, h, adj) => {
      const x1 = Math.min(w, h) * pin(0, adj('adj'), 25000) / 100000, x2 = 2 * x1, x3 = w - x2, x4 = w - x1, vc = h / 2, y2 = vc - x1, y3 = vc + x1, y4 = h - x1;
      const left = p => p.M(x2, h).A(x1, x1, 90, 90).L(x1, y3).A(x1, x1, 0, -90).A(x1, x1, 90, -90).L(x1, x1).A(x1, x1, 180, 90);
      const right = p => p.L(x3, 0).A(x1, x1, 270, 90).L(x4, y2).A(x1, x1, 180, -90).A(x1, x1, 270, -90).L(x4, y4).A(x1, x1, 0, 90);
      const it = x1 * 29289 / 100000;
      return { paths: [
        path(p => { left(p); right(p); p.Z(); }, FILL),
        path(p => { left(p); p.M(x3, 0); right(p); }, LINE),
      ], text: [x1 + it, it, w - x1 - it, h - it] };
    },
  },
  leftBracket: {
    defaults: { adj: 8333 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), y1 = ss * pin(0, adj('adj'), 50000 * h / ss) / 100000, it = y1 * 29289 / 100000;
      const draw = p => p.M(w, h).A(w, y1, 90, 90).L(0, y1).A(w, y1, 180, 90);
      return { paths: [path(p => draw(p).Z(), FILL), path(draw, LINE)], text: [w * 29289 / 100000, it, w, h - it] };
    },
  },
  rightBracket: {
    defaults: { adj: 8333 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), y1 = ss * pin(0, adj('adj'), 50000 * h / ss) / 100000, it = y1 * 29289 / 100000;
      const draw = p => p.M(0, 0).A(w, y1, 270, 90).L(w, h - y1).A(w, y1, 0, 90);
      return { paths: [path(p => draw(p).Z(), FILL), path(draw, LINE)], text: [0, it, w * 70711 / 100000, h - it] };
    },
  },
  leftBrace: {
    defaults: { adj1: 8333, adj2: 50000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a2 = pin(0, adj('adj2'), 100000), a1 = pin(0, adj('adj1'), Math.min(100000 - a2, a2) / 2 * h / ss);
      const y1 = ss * a1 / 100000, y3 = h * a2 / 100000, hc = w / 2, it = y1 * 29289 / 100000;
      const draw = p => p.M(w, h).A(hc, y1, 90, 90).L(hc, y3 + y1).A(hc, y1, 0, -90).A(hc, y1, 90, -90).L(hc, y1).A(hc, y1, 180, 90);
      return { paths: [path(p => draw(p).Z(), FILL), path(draw, LINE)], text: [w * 29289 / 100000, it, w, h - it] };
    },
  },
  rightBrace: {
    defaults: { adj1: 8333, adj2: 50000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a2 = pin(0, adj('adj2'), 100000), a1 = pin(0, adj('adj1'), Math.min(100000 - a2, a2) / 2 * h / ss);
      const y1 = ss * a1 / 100000, y3 = h * a2 / 100000, hc = w / 2, it = y1 * 29289 / 100000;
      const draw = p => p.M(0, 0).A(hc, y1, 270, 90).L(hc, y3 - y1).A(hc, y1, 180, -90).A(hc, y1, 270, -90).L(hc, h - y1).A(hc, y1, 0, 90);
      return { paths: [path(p => draw(p).Z(), FILL), path(draw, LINE)], text: [0, it, w * 70711 / 100000, h - it] };
    },
  },
  corner: {
    defaults: { adj1: 50000, adj2: 50000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), dy1 = ss * pin(0, adj('adj1'), 100000 * h / ss) / 100000, x1 = ss * pin(0, adj('adj2'), 100000 * w / ss) / 100000, y1 = h - dy1;
      return { points: poly([0, 0], [x1, 0], [x1, y1], [w, y1], [w, h], [0, h]), text: [0, y1, w, h] };
    },
  },
  diagStripe: {
    defaults: { adj: 50000 },
    build: (w, h, adj) => {
      const a = pin(0, adj('adj'), 100000), x2 = w * a / 100000, y2 = h * a / 100000;
      return { points: poly([0, y2], [x2, 0], [w, 0], [0, h]), text: [0, 0, (x2 + w) / 2, (y2 + h) / 2] };
    },
  },
  arc: {
    defaults: { adj1: 16200000, adj2: 0 },
    build: (w, h, adj) => {
      // The standard's arc has a wedge fill (unstroked) and the stroked arc itself.
      const start = angleAdj(adj('adj1')), sweep = sweepBetween(start, angleAdj(adj('adj2'))), from = onEllipse(w / 2, h / 2, w / 2, h / 2, start);
      return { paths: [
        path(p => p.M(...from).A(w / 2, h / 2, start, sweep).L(w / 2, h / 2).Z(), FILL),
        path(p => p.M(...from).A(w / 2, h / 2, start, sweep), LINE),
      ], text: inscribed(w, h) };
    },
  },

  // Block arrows
  upDownArrow: {
    defaults: { adj1: 50000, adj2: 50000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a1 = pin(0, adj('adj1'), 100000), y2 = ss * pin(0, adj('adj2'), 50000 * h / ss) / 100000, y3 = h - y2;
      const dx1 = w * a1 / 200000, x1 = w / 2 - dx1, x2 = w / 2 + dx1, dy1 = x1 * y2 / (w / 2);
      return { points: poly([0, y2], [w / 2, 0], [w, y2], [x2, y2], [x2, y3], [w, y3], [w / 2, h], [0, y3], [x1, y3], [x1, y2]), text: [x1, y2 - dy1, x2, y3 + dy1] };
    },
  },
  quadArrow: {
    defaults: { adj1: 22500, adj2: 22500, adj3: 22500 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a2 = pin(0, adj('adj2'), 50000), a1 = pin(0, adj('adj1'), a2 * 2), a3 = pin(0, adj('adj3'), (100000 - a2 * 2) / 2);
      const x1 = ss * a3 / 100000, dx2 = ss * a2 / 100000, dx3 = ss * a1 / 200000, hc = w / 2, vc = h / 2;
      const x2 = hc - dx2, x5 = hc + dx2, x3 = hc - dx3, x4 = hc + dx3, x6 = w - x1, y2 = vc - dx2, y5 = vc + dx2, y3 = vc - dx3, y4 = vc + dx3, y6 = h - x1;
      const il = dx2 ? dx3 * x1 / dx2 : 0;
      return { points: poly([0, vc], [x1, y2], [x1, y3], [x3, y3], [x3, x1], [x2, x1], [hc, 0], [x5, x1], [x4, x1], [x4, y3], [x6, y3], [x6, y2], [w, vc], [x6, y5], [x6, y4], [x4, y4], [x4, y6], [x5, y6], [hc, h], [x2, y6], [x3, y6], [x3, y4], [x1, y4], [x1, y5]),
        text: [il, y3, w - il, y4] };
    },
  },
  leftRightUpArrow: {
    defaults: { adj1: 25000, adj2: 25000, adj3: 25000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a2 = pin(0, adj('adj2'), 50000), a1 = pin(0, adj('adj1'), a2 * 2), a3 = pin(0, adj('adj3'), (100000 - a2 * 2) / 2);
      const x1 = ss * a3 / 100000, dx2 = ss * a2 / 100000, dx3 = ss * a1 / 200000, hc = w / 2;
      const x2 = hc - dx2, x5 = hc + dx2, x3 = hc - dx3, x4 = hc + dx3, x6 = w - x1, y2 = h - ss * a2 / 50000, y4 = h - dx2, y3 = y4 - dx3, y5 = y4 + dx3;
      const il = dx2 ? dx3 * x1 / dx2 : 0;
      return { points: poly([0, y4], [x1, y2], [x1, y3], [x3, y3], [x3, x1], [x2, x1], [hc, 0], [x5, x1], [x4, x1], [x4, y3], [x6, y3], [x6, y2], [w, y4], [x6, h], [x6, y5], [x1, y5], [x1, h]),
        text: [il, y3, w - il, y5] };
    },
  },
  leftUpArrow: {
    defaults: { adj1: 25000, adj2: 25000, adj3: 25000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a2 = pin(0, adj('adj2'), 50000), a1 = pin(0, adj('adj1'), a2 * 2), a3 = pin(0, adj('adj3'), 100000 - a2 * 2);
      const x1 = ss * a3 / 100000, dx2 = ss * a2 / 50000, x2 = w - dx2, y2 = h - dx2, dx4 = ss * a2 / 100000, x4 = w - dx4, y4 = h - dx4;
      const dx3 = ss * a1 / 200000, x3 = x4 - dx3, x5 = x4 + dx3, y3 = y4 - dx3, y5 = y4 + dx3, il = dx4 ? dx3 * x1 / dx4 : 0;
      return { points: poly([0, y4], [x1, y2], [x1, y3], [x3, y3], [x3, x1], [x2, x1], [x4, 0], [w, x1], [x5, x1], [x5, y5], [x1, y5], [x1, h]), text: [il, y3, x4, y5] };
    },
  },
  bentUpArrow: {
    defaults: { adj1: 25000, adj2: 25000, adj3: 25000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a1 = pin(0, adj('adj1'), 50000), a2 = pin(0, adj('adj2'), 50000), a3 = pin(0, adj('adj3'), 50000);
      const y1 = ss * a3 / 100000, x1 = w - ss * a2 / 50000, x3 = w - ss * a2 / 100000, dx2 = ss * a1 / 200000, x2 = x3 - dx2, x4 = x3 + dx2, y2 = h - ss * a1 / 100000;
      return { points: poly([0, y2], [x2, y2], [x2, y1], [x1, y1], [x3, 0], [w, y1], [x4, y1], [x4, h], [0, h]), text: [0, y2, x4, h] };
    },
  },
  notchedRightArrow: {
    defaults: { adj1: 50000, adj2: 50000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a1 = pin(0, adj('adj1'), 100000), dx2 = ss * pin(0, adj('adj2'), 100000 * w / ss) / 100000, x2 = w - dx2;
      const dy1 = h * a1 / 200000, y1 = h / 2 - dy1, y2 = h / 2 + dy1, x1 = dy1 * dx2 / (h / 2);
      return { points: poly([0, y1], [x2, y1], [x2, 0], [w, h / 2], [x2, h], [x2, y2], [0, y2], [x1, h / 2]), text: [x1, y1, w - x1, y2] };
    },
  },
  stripedRightArrow: {
    defaults: { adj1: 50000, adj2: 50000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a1 = pin(0, adj('adj1'), 100000), dx5 = ss * pin(0, adj('adj2'), 84375 * w / ss) / 100000, x5 = w - dx5, x4 = ss * 5 / 32;
      const dy1 = h * a1 / 200000, y1 = h / 2 - dy1, y2 = h / 2 + dy1, x6 = w - dy1 * dx5 / (h / 2);
      return { points: [...poly([0, y1], [ss / 32, y1], [ss / 32, y2], [0, y2]), ...poly([ss / 16, y1], [ss / 8, y1], [ss / 8, y2], [ss / 16, y2]),
        ...poly([x4, y1], [x5, y1], [x5, 0], [w, h / 2], [x5, h], [x5, y2], [x4, y2])], text: [x4, y1, x6, y2] };
    },
  },
  bentArrow: {
    defaults: { adj1: 25000, adj2: 25000, adj3: 25000, adj4: 43750 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a2 = pin(0, adj('adj2'), 50000), a1 = pin(0, adj('adj1'), a2 * 2), a3 = pin(0, adj('adj3'), 50000);
      const th = ss * a1 / 100000, aw2 = ss * a2 / 100000, dh2 = aw2 - th / 2, ah = ss * a3 / 100000, bs = Math.min(w - ah, h - dh2);
      const bd = ss * pin(0, adj('adj4'), 100000 * bs / ss) / 100000, bd2 = Math.max(bd - th, 0), x3 = th + bd2, x4 = w - ah, y3 = dh2 + th, y4 = y3 + dh2, y5 = dh2 + bd;
      return { points: pen().M(0, h).L(0, y5).A(bd, bd, 180, 90).L(x4, dh2).L(x4, 0).L(w, aw2).L(x4, y4).L(x4, y3).L(x3, y3).A(bd2, bd2, 270, -90).L(th, h).Z().points, text: [0, 0, x4, y4] };
    },
  },
  uturnArrow: {
    defaults: { adj1: 25000, adj2: 25000, adj3: 25000, adj4: 43750, adj5: 75000 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a2 = pin(0, adj('adj2'), 25000), a1 = pin(0, adj('adj1'), a2 * 2), a3 = pin(0, adj('adj3'), (100000 - a1 * ss / h) * h / ss);
      const a5 = pin((a3 + a1) * ss / h, adj('adj5'), 100000), th = ss * a1 / 100000, aw2 = ss * a2 / 100000, dh2 = aw2 - th / 2;
      const y5 = h * a5 / 100000, ah = ss * a3 / 100000, y4 = y5 - ah, x9 = w - dh2, bs = Math.min(x9 / 2, y4);
      const bd = ss * pin(0, adj('adj4'), 100000 * bs / ss) / 100000, bd2 = Math.max(bd - th, 0), x3 = th + bd2, x8 = w - aw2, x6 = x8 - aw2, x7 = x6 + dh2, x4 = x9 - bd;
      return { points: pen().M(0, h).L(0, bd).A(bd, bd, 180, 90).L(x4, 0).A(bd, bd, 270, 90).L(x9, y4).L(w, y4).L(x8, y5).L(x6, y4).L(x7, y4).L(x7, x3)
        .A(bd2, bd2, 0, -90).L(x3, th).A(bd2, bd2, 270, -90).L(th, h).Z().points, text: [0, 0, x6, y4] };
    },
  },
  rightArrowCallout: {
    defaults: { adj1: 25000, adj2: 25000, adj3: 25000, adj4: 64977 },
    build: (w, h, adj) => {
      const { dy1, dy2, head, box: x2 } = arrowCallout(w, h, adj, false), vc = h / 2, x3 = w - head;
      return { points: poly([0, 0], [x2, 0], [x2, vc - dy2], [x3, vc - dy2], [x3, vc - dy1], [w, vc], [x3, vc + dy1], [x3, vc + dy2], [x2, vc + dy2], [x2, h], [0, h]), text: [0, 0, x2, h] };
    },
  },
  leftArrowCallout: {
    defaults: { adj1: 25000, adj2: 25000, adj3: 25000, adj4: 64977 },
    build: (w, h, adj) => {
      const { dy1, dy2, head: x1, box } = arrowCallout(w, h, adj, false), vc = h / 2, x2 = w - box;
      return { points: poly([0, vc], [x1, vc - dy1], [x1, vc - dy2], [x2, vc - dy2], [x2, 0], [w, 0], [w, h], [x2, h], [x2, vc + dy2], [x1, vc + dy2], [x1, vc + dy1]), text: [x2, 0, w, h] };
    },
  },
  upArrowCallout: {
    defaults: { adj1: 25000, adj2: 25000, adj3: 25000, adj4: 64977 },
    build: (w, h, adj) => {
      const { dy1: dx1, dy2: dx2, head: y1, box } = arrowCallout(w, h, adj, true), hc = w / 2, y2 = h - box;
      return { points: poly([0, y2], [hc - dx2, y2], [hc - dx2, y1], [hc - dx1, y1], [hc, 0], [hc + dx1, y1], [hc + dx2, y1], [hc + dx2, y2], [w, y2], [w, h], [0, h]), text: [0, y2, w, h] };
    },
  },
  downArrowCallout: {
    defaults: { adj1: 25000, adj2: 25000, adj3: 25000, adj4: 64977 },
    build: (w, h, adj) => {
      const { dy1: dx1, dy2: dx2, head, box: y2 } = arrowCallout(w, h, adj, true), hc = w / 2, y3 = h - head;
      return { points: poly([0, 0], [w, 0], [w, y2], [hc + dx2, y2], [hc + dx2, y3], [hc + dx1, y3], [hc, h], [hc - dx1, y3], [hc - dx2, y3], [hc - dx2, y2], [0, y2]), text: [0, 0, w, y2] };
    },
  },
  leftRightArrowCallout: {
    defaults: { adj1: 25000, adj2: 25000, adj3: 25000, adj4: 48123 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a2 = pin(0, adj('adj2'), 50000 * h / ss), a1 = pin(0, adj('adj1'), a2 * 2), a3 = pin(0, adj('adj3'), 50000 * w / ss);
      const a4 = pin(0, adj('adj4'), 100000 - a3 * ss / (w / 2)), dy1 = ss * a2 / 100000, dy2 = ss * a1 / 200000, vc = h / 2;
      const y1 = vc - dy1, y2 = vc - dy2, y3 = vc + dy2, y4 = vc + dy1, x1 = ss * a3 / 100000, x4 = w - x1, dx2 = w * a4 / 200000, x2 = w / 2 - dx2, x3 = w / 2 + dx2;
      return { points: poly([0, vc], [x1, y1], [x1, y2], [x2, y2], [x2, 0], [x3, 0], [x3, y2], [x4, y2], [x4, y1], [w, vc], [x4, y4], [x4, y3], [x3, y3], [x3, h], [x2, h], [x2, y3], [x1, y3], [x1, y4]),
        text: [x2, 0, x3, h] };
    },
  },
  quadArrowCallout: {
    defaults: { adj1: 18515, adj2: 18515, adj3: 18515, adj4: 48123 },
    build: (w, h, adj) => {
      const ss = Math.min(w, h), a2 = pin(0, adj('adj2'), 50000), a1 = pin(0, adj('adj1'), a2 * 2), a3 = pin(0, adj('adj3'), 50000 - a2), a4 = pin(a1, adj('adj4'), 100000 - a3 * 2);
      const dx2 = ss * a2 / 100000, dx3 = ss * a1 / 200000, ah = ss * a3 / 100000, dx1 = w * a4 / 200000, dy1 = h * a4 / 200000, hc = w / 2, vc = h / 2;
      const x8 = w - ah, x2 = hc - dx1, x7 = hc + dx1, x3 = hc - dx2, x6 = hc + dx2, x4 = hc - dx3, x5 = hc + dx3;
      const y8 = h - ah, y2 = vc - dy1, y7 = vc + dy1, y3 = vc - dx2, y6 = vc + dx2, y4 = vc - dx3, y5 = vc + dx3;
      return { points: poly([0, vc], [ah, y3], [ah, y4], [x2, y4], [x2, y2], [x4, y2], [x4, ah], [x3, ah], [hc, 0], [x6, ah], [x5, ah], [x5, y2], [x7, y2], [x7, y4], [x8, y4], [x8, y3], [w, vc],
        [x8, y6], [x8, y5], [x7, y5], [x7, y7], [x5, y7], [x5, y8], [x6, y8], [hc, h], [x3, y8], [x4, y8], [x4, y7], [x2, y7], [x2, y5], [ah, y5], [ah, y6]), text: [x2, y2, x7, y7] };
    },
  },

  // Equation shapes
  mathPlus: {
    defaults: { adj1: 23520 },
    build: (w, h, adj) => {
      const dx1 = w * 73490 / 200000, dy1 = h * 73490 / 200000, dx2 = Math.min(w, h) * pin(0, adj('adj1'), 73490) / 200000, hc = w / 2, vc = h / 2;
      const x1 = hc - dx1, x2 = hc - dx2, x3 = hc + dx2, x4 = hc + dx1, y1 = vc - dy1, y2 = vc - dx2, y3 = vc + dx2, y4 = vc + dy1;
      return { points: poly([x1, y2], [x2, y2], [x2, y1], [x3, y1], [x3, y2], [x4, y2], [x4, y3], [x3, y3], [x3, y4], [x2, y4], [x2, y3], [x1, y3]), text: [x1, y2, x4, y3] };
    },
  },
  mathMinus: {
    defaults: { adj1: 23520 },
    build: (w, h, adj) => {
      const dy1 = h * pin(0, adj('adj1'), 100000) / 200000, dx1 = w * 73490 / 200000, x1 = w / 2 - dx1, x2 = w / 2 + dx1, y1 = h / 2 - dy1, y2 = h / 2 + dy1;
      return { points: poly([x1, y1], [x2, y1], [x2, y2], [x1, y2]), text: [x1, y1, x2, y2] };
    },
  },
  mathMultiply: {
    defaults: { adj1: 23520 },
    build: (w, h, adj) => {
      const th = Math.min(w, h) * pin(0, adj('adj1'), 51965) / 100000, angle = Math.atan2(h, w), sa = Math.sin(angle), ca = Math.cos(angle), ta = Math.tan(angle);
      // Two bars along the diagonals, each 51.965% of the diagonal long and th thick.
      const lM = Math.hypot(w, h) * (1 - .51965), xM = ca * lM / 2, yM = sa * lM / 2, xA = xM - sa * th / 2, yA = yM + ca * th / 2, xB = xM + sa * th / 2, yB = yM - ca * th / 2;
      const yC = (w / 2 - xB) * ta + yB, xD = w - xB, xE = w - xA, xFE = (h / 2 - yA) / ta, xF = xE - xFE, xL = xA + xFE, yG = h - yA, yH = h - yB, yI = h - yC;
      return { points: poly([xA, yA], [xB, yB], [w / 2, yC], [xD, yB], [xE, yA], [xF, h / 2], [xE, yG], [xD, yH], [w / 2, yI], [xB, yH], [xA, yG], [xL, h / 2]), text: [xA, yB, xE, yH] };
    },
  },
  mathDivide: {
    defaults: { adj1: 23520, adj2: 5880, adj3: 11760 },
    build: (w, h, adj) => {
      const a1 = pin(1000, adj('adj1'), 36745), a3 = pin(1000, adj('adj3'), Math.min((73490 - a1) / 4, 36745 * w / h)), a2 = pin(0, adj('adj2'), 73490 - 4 * a3 - a1);
      const dy1 = h * a1 / 200000, yg = h * a2 / 100000, r = h * a3 / 100000, dx1 = w * 73490 / 200000, hc = w / 2, vc = h / 2;
      const y3 = vc - dy1, y4 = vc + dy1, y1 = y3 - yg - r - r, y5 = h - y1, x1 = hc - dx1, x3 = hc + dx1;
      return { points: [...pen().M(hc, y1).A(r, r, 270, 360).Z().M(hc, y5).A(r, r, 90, 360).Z().points, ...poly([x1, y3], [x3, y3], [x3, y4], [x1, y4])], text: [x1, y3, x3, y4] };
    },
  },
  mathEqual: {
    defaults: { adj1: 23520, adj2: 11760 },
    build: (w, h, adj) => {
      const a1 = pin(0, adj('adj1'), 36745), a2 = pin(0, adj('adj2'), 100000 - a1 * 2), dy1 = h * a1 / 100000, dy2 = h * a2 / 200000, dx1 = w * 73490 / 200000;
      const y2 = h / 2 - dy2, y3 = h / 2 + dy2, y1 = y2 - dy1, y4 = y3 + dy1, x1 = w / 2 - dx1, x2 = w / 2 + dx1;
      return { points: [...poly([x1, y1], [x2, y1], [x2, y2], [x1, y2]), ...poly([x1, y3], [x2, y3], [x2, y4], [x1, y4])], text: [x1, y1, x2, y4] };
    },
  },
  mathNotEqual: {
    defaults: { adj1: 23520, adj2: 6600000, adj3: 11760 },
    build: (w, h, adj) => {
      const a1 = pin(0, adj('adj1'), 50000), crAng = pin(4200000, adj('adj2'), 6600000) / 60000, a3 = pin(0, adj('adj3'), 100000 - a1 * 2);
      const dy1 = h * a1 / 100000, dy2 = h * a3 / 200000, dx1 = w * 73490 / 200000, hc = w / 2, vc = h / 2, hd2 = h / 2;
      const x1 = hc - dx1, x8 = hc + dx1, y2 = vc - dy2, y3 = vc + dy2, y1 = y2 - dy1, y4 = y3 + dy1;
      // The slash leans by crAng from horizontal; its ends are cut square to it at the frame's top and bottom.
      const cadj2 = crAng - 90, xadj2 = hd2 * Math.tan(rad(cadj2)), len = Math.hypot(xadj2, hd2), bhw = len * dy1 / hd2, x7 = hc + xadj2 - bhw / 2;
      const x6 = x7 - xadj2 * y1 / hd2, x5 = x7 - xadj2 * y2 / hd2, x4 = x7 - xadj2 * y3 / hd2, x3 = x7 - xadj2 * y4 / hd2;
      const dx7 = dy1 * hd2 / len, rx = cadj2 > 0 ? x7 + dx7 : x7 + bhw, lx = cadj2 > 0 ? x7 : x7 + bhw - dx7, dy3 = dy1 * xadj2 / len, ry = cadj2 > 0 ? dy3 : 0, ly = cadj2 > 0 ? 0 : -dy3;
      return { points: poly([x1, y1], [x6, y1], [lx, ly], [rx, ry], [x6 + bhw, y1], [x8, y1], [x8, y2], [x5 + bhw, y2], [x4 + bhw, y3], [x8, y3], [x8, y4], [x3 + bhw, y4], [w - lx, h - ly], [w - rx, h - ry], [x3, y4], [x1, y4], [x1, y3], [x4, y3], [x5, y2], [x1, y2]),
        text: [x1, y1, x8, y4] };
    },
  },

  // Flowchart (fixed coordinate grids per the standard, scaled by each path's own width and height)
  flowChartProcess: { defaults: {}, build: (w, h) => ({ points: poly([0, 0], [w, 0], [w, h], [0, h]), text: [0, 0, w, h] }) },
  flowChartAlternateProcess: {
    defaults: {},
    build: (w, h) => {
      const r = Math.min(w, h) / 6, il = r * 29289 / 100000;
      return { points: pen().M(0, r).A(r, r, 180, 90).L(w - r, 0).A(r, r, 270, 90).L(w, h - r).A(r, r, 0, 90).L(r, h).A(r, r, 90, 90).Z().points, text: [il, il, w - il, h - il] };
    },
  },
  flowChartDecision: { defaults: {}, build: (w, h) => ({ paths: [path(p => p.M(0, 1).L(1, 0).L(2, 1).L(1, 2).Z(), { w: 2, h: 2 })], text: [w / 4, h / 4, w * 3 / 4, h * 3 / 4] }) },
  flowChartInputOutput: { defaults: {}, build: (w, h) => ({ paths: [path(p => p.M(0, 5).L(1, 0).L(5, 0).L(4, 5).Z(), { w: 5, h: 5 })], text: [w / 5, 0, w * 4 / 5, h] }) },
  flowChartPredefinedProcess: {
    defaults: {},
    build: (w, h) => ({ paths: outlined(p => p.M(0, 0).L(8, 0).L(8, 8).L(0, 8).Z(), p => p.M(1, 0).L(1, 8).M(7, 0).L(7, 8), { w: 8, h: 8 }), text: [w / 8, 0, w * 7 / 8, h] }),
  },
  flowChartInternalStorage: {
    defaults: {},
    build: (w, h) => ({ paths: outlined(p => p.M(0, 0).L(8, 0).L(8, 8).L(0, 8).Z(), p => p.M(1, 0).L(1, 8).M(0, 1).L(8, 1), { w: 8, h: 8 }), text: [w / 8, h / 8, w, h] }),
  },
  flowChartDocument: {
    defaults: {},
    build: (w, h) => ({ paths: [path(p => p.M(0, 0).L(21600, 0).L(21600, 17322).C(10800, 17322, 10800, 23922, 0, 20172).Z(), { w: 21600, h: 21600 })], text: [0, 0, w, h * 17322 / 21600] }),
  },
  flowChartMultidocument: {
    defaults: {},
    build: (w, h) => {
      const size = { w: 21600, h: 21600 };
      const front = p => p.M(0, 20782).C(9298, 23542, 9298, 18022, 18595, 18022).L(18595, 3675).L(0, 3675).Z();
      const middle = p => p.M(1532, 3675).L(1532, 1815).L(20000, 1815).L(20000, 16252).C(19298, 16252, 18595, 16352, 18595, 16352);
      const back = p => p.M(2972, 1815).L(2972, 0).L(21600, 0).L(21600, 14392).C(20800, 14392, 20000, 14467, 20000, 14467);
      return { paths: [
        path(p => { front(p); middle(p); p.L(18595, 3675).Z(); back(p); p.L(20000, 1815).Z(); }, { ...FILL, ...size }),
        path(p => { front(p); middle(p); back(p); }, { ...LINE, ...size }),
      ], text: [0, h * 3675 / 21600, w * 18595 / 21600, h * 17322 / 21600] };
    },
  },
  flowChartTerminator: {
    defaults: {},
    build: (w, h) => ({ paths: [path(p => p.M(3475, 0).L(18125, 0).A(3475, 10800, 270, 180).L(3475, 21600).A(3475, 10800, 90, 180).Z(), { w: 21600, h: 21600 })],
      text: [w * 1018 / 21600, h * 3163 / 21600, w * 20582 / 21600, h * 18437 / 21600] }),
  },
  flowChartPreparation: { defaults: {}, build: (w, h) => ({ paths: [path(p => p.M(0, 5).L(2, 0).L(8, 0).L(10, 5).L(8, 10).L(2, 10).Z(), { w: 10, h: 10 })], text: [w / 5, 0, w * 4 / 5, h] }) },
  flowChartManualInput: { defaults: {}, build: (w, h) => ({ paths: [path(p => p.M(0, 1).L(5, 0).L(5, 5).L(0, 5).Z(), { w: 5, h: 5 })], text: [0, h / 5, w, h] }) },
  flowChartManualOperation: { defaults: {}, build: (w, h) => ({ paths: [path(p => p.M(0, 0).L(5, 0).L(4, 5).L(1, 5).Z(), { w: 5, h: 5 })], text: [w / 5, 0, w * 4 / 5, h] }) },
  flowChartConnector: { defaults: {}, build: (w, h) => ({ points: pen().M(0, h / 2).A(w / 2, h / 2, 180, 360).Z().points, text: inscribed(w, h) }) },
  flowChartPunchedCard: { defaults: {}, build: (w, h) => ({ paths: [path(p => p.M(0, 1).L(1, 0).L(5, 0).L(5, 5).L(0, 5).Z(), { w: 5, h: 5 })], text: [0, h / 5, w, h] }) },
  flowChartPunchedTape: {
    defaults: {},
    build: (w, h) => ({ paths: [path(p => p.M(0, 2).A(5, 2, 180, -180).A(5, 2, 180, 180).L(20, 18).A(5, 2, 0, -180).A(5, 2, 0, 180).Z(), { w: 20, h: 20 })], text: [0, h / 5, w, h * 4 / 5] }),
  },
  flowChartSummingJunction: {
    defaults: {},
    build: (w, h) => {
      const [il, it, ir, ib] = inscribed(w, h);
      return { paths: outlined(p => p.M(0, h / 2).A(w / 2, h / 2, 180, 360).Z(), p => p.M(il, it).L(ir, ib).M(ir, it).L(il, ib)), text: [il, it, ir, ib] };
    },
  },
  flowChartOr: {
    defaults: {},
    build: (w, h) => ({ paths: outlined(p => p.M(0, h / 2).A(w / 2, h / 2, 180, 360).Z(), p => p.M(w / 2, 0).L(w / 2, h).M(0, h / 2).L(w, h / 2)), text: inscribed(w, h) }),
  },
  flowChartCollate: { defaults: {}, build: (w, h) => ({ paths: [path(p => p.M(0, 0).L(2, 0).L(1, 1).L(2, 2).L(0, 2).L(1, 1).Z(), { w: 2, h: 2 })], text: [w / 4, h / 4, w * 3 / 4, h * 3 / 4] }) },
  flowChartSort: {
    defaults: {},
    build: (w, h) => ({ paths: outlined(p => p.M(0, 1).L(1, 0).L(2, 1).L(1, 2).Z(), p => p.M(0, 1).L(2, 1), { w: 2, h: 2 }), text: [w / 4, h / 4, w * 3 / 4, h * 3 / 4] }),
  },
  flowChartExtract: { defaults: {}, build: (w, h) => ({ paths: [path(p => p.M(0, 2).L(1, 0).L(2, 2).Z(), { w: 2, h: 2 })], text: [w / 4, h / 2, w * 3 / 4, h] }) },
  flowChartMerge: { defaults: {}, build: (w, h) => ({ paths: [path(p => p.M(0, 0).L(2, 0).L(1, 2).Z(), { w: 2, h: 2 })], text: [w / 4, 0, w * 3 / 4, h / 2] }) },
  flowChartOnlineStorage: {
    defaults: {},
    build: (w, h) => ({ paths: [path(p => p.M(1, 0).L(6, 0).A(1, 3, 270, -180).L(1, 6).A(1, 3, 90, 180).Z(), { w: 6, h: 6 })], text: [w / 6, 0, w * 5 / 6, h] }),
  },
  flowChartDelay: {
    defaults: {},
    build: (w, h) => {
      const [, it, ir, ib] = inscribed(w, h);
      return { points: pen().M(0, 0).L(w / 2, 0).A(w / 2, h / 2, 270, 180).L(0, h).Z().points, text: [0, it, ir, ib] };
    },
  },
  flowChartMagneticTape: {
    defaults: {},
    build: (w, h) => {
      const [il, it, ir, ib] = inscribed(w, h), wd2 = w / 2, hd2 = h / 2;
      // The tape leaves the reel at the frame diagonal's angle and runs to the bottom-right corner.
      return { points: pen().M(wd2, h).A(wd2, hd2, 90, 90).A(wd2, hd2, 180, 90).A(wd2, hd2, 270, 90).A(wd2, hd2, 0, at2(w, h)).L(w, ib).L(w, h).Z().points, text: [il, it, ir, ib] };
    },
  },
  flowChartMagneticDisk: {
    defaults: {},
    build: (w, h) => ({ paths: outlined(p => p.M(0, 1).A(3, 1, 180, 180).L(6, 5).A(3, 1, 0, 180).Z(), p => p.M(6, 1).A(3, 1, 0, 180), { w: 6, h: 6 }), text: [0, h / 3, w, h * 5 / 6] }),
  },
  flowChartMagneticDrum: {
    defaults: {},
    build: (w, h) => ({ paths: outlined(p => p.M(1, 0).L(5, 0).A(1, 3, 270, 180).L(1, 6).A(1, 3, 90, 180).Z(), p => p.M(5, 6).A(1, 3, 90, 180), { w: 6, h: 6 }), text: [w / 6, 0, w * 2 / 3, h] }),
  },
  flowChartDisplay: {
    defaults: {},
    build: (w, h) => ({ paths: [path(p => p.M(0, 3).L(1, 0).L(5, 0).A(1, 3, 270, 180).L(1, 6).Z(), { w: 6, h: 6 })], text: [w / 6, 0, w * 5 / 6, h] }),
  },

  // Stars and banners
  // star6's text box spans the inner points at 0° and 180°, between the inner points at ±60°.
  star6: star(6, { adj: 28868, hf: 115470 }, (ix, iy) => [ix, sin(iy, 60)]),
  star7: star(7, { adj: 34601, hf: 102572, vf: 105210 }),
  star8: star(8, { adj: 38250 }),
  star10: star(10, { adj: 42533, hf: 105146 }),
  star12: star(12, { adj: 37500 }),
  star16: star(16, { adj: 37500 }),
  star24: star(24, { adj: 37500 }),
  star32: star(32, { adj: 37500 }),
  irregularSeal1: {
    defaults: {},
    build: (w, h) => ({
      paths: [path(p => { p.points.push(...poly([10800, 5800], [14522, 0], [14155, 5325], [18380, 4457], [16702, 7315], [21097, 8137], [17607, 10475], [21600, 13290], [16837, 12942], [18145, 18095], [14020, 14457],
        [13247, 19737], [10532, 14935], [8485, 21600], [7715, 15627], [4762, 17617], [5667, 13937], [135, 14587], [3722, 11775], [0, 8615], [4627, 7617], [370, 2295], [7312, 6320], [8352, 2295])); }, { w: 21600, h: 21600 })],
      text: [w * 4627 / 21600, h * 6320 / 21600, w * 16702 / 21600, h * 13937 / 21600],
    }),
  },
  irregularSeal2: {
    defaults: {},
    build: (w, h) => ({
      paths: [path(p => { p.points.push(...poly([11462, 4342], [14790, 0], [14525, 5777], [18007, 3172], [16380, 6532], [21600, 6645], [16985, 9402], [18270, 11290], [16380, 12310], [18877, 15632], [14640, 14350],
        [14942, 17370], [12180, 15935], [11612, 18842], [9872, 17370], [8700, 19712], [7527, 18125], [4917, 21600], [4805, 18240], [1285, 17825], [3330, 15370], [0, 12877], [3935, 11592], [1172, 8270],
        [5372, 7817], [4502, 3625], [8550, 6382], [9722, 1887])); }, { w: 21600, h: 21600 })],
      text: [w * 5372 / 21600, h * 6382 / 21600, w * 16380 / 21600, h * 15370 / 21600],
    }),
  },
  ribbon: {
    defaults: { adj1: 16667, adj2: 50000 },
    build: (w, h, adj) => {
      if (!(w > 0 && h > 0)) return { points: [], text: [0, 0, w, h] };
      // ribbon is ribbon2 reflected top to bottom: the centre panel hangs below the tails.
      const g = ribbonGeometry(w, h, adj('adj1'), adj('adj2')), flip = ([op, ...v]) => [op, ...v.map((n, i) => i % 2 ? h - n : n)];
      return { paths: g.paths.map(({ width, height, ...p }) => ({ ...p, points: p.points.map(flip) })), text: [g.textRect.left * w, (1 - g.textRect.bottom) * h, g.textRect.right * w, (1 - g.textRect.top) * h] };
    },
  },
  wave: {
    defaults: { adj1: 12500, adj2: 0 },
    build: (w, h, adj) => {
      const a1 = pin(0, adj('adj1'), 20000), a2 = pin(-10000, adj('adj2'), 10000), y1 = h * a1 / 100000, dy2 = y1 * 10 / 3, y2 = y1 - dy2, y3 = y1 + dy2;
      const y4 = h - y1, y5 = y4 - dy2, y6 = y4 + dy2, of2 = w * a2 / 50000, dx2 = of2 > 0 ? 0 : of2, x2 = -dx2, dx5 = of2 > 0 ? of2 : 0, x5 = w - dx5;
      const dx3 = (dx2 + x5) / 3, x3 = x2 + dx3, x4 = (x3 + x5) / 2, x6 = dx5, x10 = w + dx2, x7 = x6 + dx3, x8 = (x7 + x10) / 2, it = h * a1 / 50000;
      return { points: pen().M(x2, y1).C(x3, y2, x4, y3, x5, y1).L(x10, y4).C(x8, y6, x7, y5, x6, y4).Z().points, text: [Math.max(x2, x6), it, Math.min(x5, x10), h - it] };
    },
  },
  doubleWave: {
    defaults: { adj1: 6250, adj2: 0 },
    build: (w, h, adj) => {
      const a1 = pin(0, adj('adj1'), 12500), a2 = pin(-10000, adj('adj2'), 10000), y1 = h * a1 / 100000, dy2 = y1 * 10 / 3, y2 = y1 - dy2, y3 = y1 + dy2;
      const y4 = h - y1, y5 = y4 - dy2, y6 = y4 + dy2, of2 = w * a2 / 50000, dx2 = of2 > 0 ? 0 : of2, x2 = -dx2, dx8 = of2 > 0 ? of2 : 0, x8 = w - dx8;
      const dx3 = (dx2 + x8) / 6, x3 = x2 + dx3, dx4 = (dx2 + x8) / 3, x4 = x2 + dx4, x5 = (x2 + x8) / 2, x6 = x5 + dx3, x7 = (x6 + x8) / 2;
      const x9 = dx8, x15 = w + dx2, x10 = x9 + dx3, x11 = x9 + dx4, x12 = (x9 + x15) / 2, x13 = x12 + dx3, x14 = (x13 + x15) / 2, it = h * a1 / 50000;
      return { points: pen().M(x2, y1).C(x3, y2, x4, y3, x5, y1).C(x6, y2, x7, y3, x8, y1).L(x15, y4).C(x14, y6, x13, y5, x12, y4).C(x11, y6, x10, y5, x9, y4).Z().points,
        text: [Math.max(x2, x9), it, Math.min(x8, x15), h - it] };
    },
  },
  horizontalScroll: { defaults: { adj: 12500 }, build: scroll },
  verticalScroll: {
    defaults: { adj: 12500 },
    build: (w, h, adj) => {
      const g = scroll(h, w, adj), swap = ([op, ...v]) => [op, ...v.map((_, i) => v[i % 2 ? i - 1 : i + 1])];
      return { paths: g.paths.map(p => ({ ...p, points: p.points.map(swap) })), text: [g.text[1], g.text[0], g.text[3], g.text[2]] };
    },
  },

  // Callouts
  wedgeRectCallout: {
    defaults: { adj1: -20833, adj2: 62500 },
    build: (w, h, adj) => {
      const { x1, x2, y1, y2, left, top, right, bottom } = wedgeTail(w, h, adj);
      return { points: poly([0, 0], [x1, 0], top, [x2, 0], [w, 0], [w, y1], right, [w, y2], [w, h], [x2, h], bottom, [x1, h], [0, h], [0, y2], left, [0, y1]), text: [0, 0, w, h] };
    },
  },
  wedgeRoundRectCallout: {
    defaults: { adj1: -20833, adj2: 62500, adj3: 16667 },
    build: (w, h, adj) => {
      const { x1, x2, y1, y2, left, top, right, bottom } = wedgeTail(w, h, adj), r = Math.min(w, h) * adj('adj3') / 100000, il = r * 29289 / 100000;
      return { points: pen().M(0, r).A(r, r, 180, 90).L(x1, 0).L(...top).L(x2, 0).L(w - r, 0).A(r, r, 270, 90).L(w, y1).L(...right).L(w, y2).L(w, h - r).A(r, r, 0, 90)
        .L(x2, h).L(...bottom).L(x1, h).L(r, h).A(r, r, 90, 90).L(0, y2).L(...left).L(0, y1).Z().points, text: [il, il, w - il, h - il] };
    },
  },
  wedgeEllipseCallout: {
    defaults: { adj1: -20833, adj2: 62500 },
    build: (w, h, adj) => {
      const dxPos = w * adj('adj1') / 100000, dyPos = h * adj('adj2') / 100000, wd2 = w / 2, hd2 = h / 2;
      // The tail's base spans 11° either side of the direction to the tip.
      const pang = at2(dxPos * h, dyPos * w), dx1 = cos(wd2, pang + 11), dy1 = sin(hd2, pang + 11), dx2 = cos(wd2, pang - 11), dy2 = sin(hd2, pang - 11);
      const stAng = at2(dx1, dy1), sw = at2(dx2, dy2) - stAng;
      return { points: pen().M(wd2 + dxPos, hd2 + dyPos).L(wd2 + dx1, hd2 + dy1).A(wd2, hd2, stAng, sw > 0 ? sw : sw + 360).Z().points, text: inscribed(w, h) };
    },
  },
  borderCallout1: lineCallout(true, false),
  callout1: lineCallout(false, false),
  accentCallout1: lineCallout(false, true),
};

/** The presets above by gallery category. */
export const PRESET_CATEGORIES = {
  rectangles: ['snip1Rect', 'snip2SameRect', 'snip2DiagRect', 'snipRoundRect', 'round1Rect', 'round2DiagRect'],
  basic: ['heptagon', 'decagon', 'dodecagon', 'can', 'cube', 'bevel', 'foldedCorner', 'smileyFace', 'heart', 'lightningBolt', 'sun', 'moon', 'blockArc', 'teardrop', 'pie', 'chord',
    'noSmoking', 'bracketPair', 'bracePair', 'leftBracket', 'rightBracket', 'leftBrace', 'rightBrace', 'corner', 'diagStripe', 'arc'],
  blockArrows: ['upDownArrow', 'quadArrow', 'leftRightUpArrow', 'leftUpArrow', 'bentUpArrow', 'notchedRightArrow', 'stripedRightArrow', 'bentArrow', 'uturnArrow',
    'rightArrowCallout', 'leftArrowCallout', 'upArrowCallout', 'downArrowCallout', 'leftRightArrowCallout', 'quadArrowCallout'],
  equation: ['mathPlus', 'mathMinus', 'mathMultiply', 'mathDivide', 'mathEqual', 'mathNotEqual'],
  flowchart: ['flowChartProcess', 'flowChartAlternateProcess', 'flowChartDecision', 'flowChartInputOutput', 'flowChartPredefinedProcess', 'flowChartInternalStorage', 'flowChartDocument',
    'flowChartMultidocument', 'flowChartTerminator', 'flowChartPreparation', 'flowChartManualInput', 'flowChartManualOperation', 'flowChartConnector', 'flowChartPunchedCard', 'flowChartPunchedTape',
    'flowChartSummingJunction', 'flowChartOr', 'flowChartCollate', 'flowChartSort', 'flowChartExtract', 'flowChartMerge', 'flowChartOnlineStorage', 'flowChartDelay', 'flowChartMagneticTape',
    'flowChartMagneticDisk', 'flowChartMagneticDrum', 'flowChartDisplay'],
  starsBanners: ['star6', 'star7', 'star8', 'star10', 'star12', 'star16', 'star24', 'star32', 'irregularSeal1', 'irregularSeal2', 'ribbon', 'wave', 'doubleWave', 'verticalScroll', 'horizontalScroll'],
  callouts: ['wedgeRectCallout', 'wedgeRoundRectCallout', 'wedgeEllipseCallout', 'borderCallout1', 'callout1', 'accentCallout1'],
};
