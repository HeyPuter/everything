/**
 * SmartArt layouts: each one turns a diagram's outline (its top-level items and their sub-items) into the
 * shapes that draw it in a w × h frame. A layout only places shapes and says what text each holds and
 * what part it plays (see `role` below); colours, styles, text sizes and Right to Left are applied after
 * it by smartart.js, the same for every layout.
 *
 * A shape: { kind, x, y, w, h, rot?, adj?, role, item?, ci?, paras?, text?, fit?, align?, valign?, points?, arrow?, opacity? }
 *   role  'node' an item's own shape · 'sub' a box of sub-items · 'text' text alone · 'conn' an arrow between
 *         nodes · 'deco' a background shape · 'line' a connector line (points) · 'ring' an outline only
 *   item  the index in the flat item list of the item the shape stands for (a click picks it)
 *   ci    which colour of a colourful scheme it takes (the top-level item's place, as a rule)
 *   paras the text: [{ text, level, bullet, item }] · text: the box the text goes in (the shape's own by default)
 */

const rad = (d) => (d * Math.PI) / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ---------- Outline helpers ---------- */

/** The sub-items of a node, depth first, each with its depth below the node (1 for a child). */
function descendants(node, depth = 1, out = []) {
  for (const c of node.children) { out.push({ node: c, depth }); descendants(c, depth + 1, out); }
  return out;
}
const own = (n) => [{ text: n.text, level: 0, item: n.i }];
const bullets = (n, base = 1) => descendants(n).map(({ node, depth }) => ({ text: node.text, level: base + depth - 1, bullet: true, item: node.i }));
const all = (n) => [...own(n), ...bullets(n)];
const hasKids = (roots) => roots.some((r) => r.children.length);

const shape = (kind, x, y, w, h, o = {}) => ({ kind, x, y, w, h, role: 'node', ...o });
const node = (kind, x, y, w, h, n, ci, o = {}) => shape(kind, x, y, w, h, { item: n.i, ci, paras: all(n), ...o });
const line = (points, o = {}) => {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { kind: 'line', role: 'line', points, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, ...o };
};

/** The best grid for n boxes of about `aspect` (w / h) in a W × H area: { cols, rows, w, h, gap }. */
function bestGrid(n, W, H, aspect = 1.6, gapRatio = 0.12) {
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = W / (cols + (cols - 1) * gapRatio), chMax = H / (rows + (rows - 1) * gapRatio);
    const h = Math.min(chMax, cw / aspect), w = Math.min(cw, h * aspect * 1.35);
    const score = w * h;
    if (!best || score > best.score + 1e-6) best = { cols, rows, w, h, score };
  }
  return { ...best, gap: Math.min(best.w, best.h) * gapRatio * 1.4 };
}

/** Rows of boxes centred in the area, the last row centred under the others. */
function gridRects(n, X, Y, W, H, aspect, gapRatio) {
  const g = bestGrid(n, W, H, aspect, gapRatio);
  const totalH = g.rows * g.h + (g.rows - 1) * g.gap, top = Y + (H - totalH) / 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / g.cols), col = i % g.cols, inRow = Math.min(g.cols, n - row * g.cols);
    const rowW = inRow * g.w + (inRow - 1) * g.gap, left = X + (W - rowW) / 2;
    out.push({ x: left + col * (g.w + g.gap), y: top + row * (g.h + g.gap), w: g.w, h: g.h });
  }
  return out;
}

/* ---------- List ---------- */

function blockList(roots, A) {
  return gridRects(roots.length, A.x, A.y, A.w, A.h, 1.6, 0.1).map((r, i) => node('rect', r.x, r.y, r.w, r.h, roots[i], i));
}

function verticalBulletList(roots, A) {
  const n = roots.length, gapU = 0.28, kidU = 0.58;
  const units = roots.reduce((s, r) => s + 1 + (r.children.length ? 0.3 + descendants(r).length * kidU : 0), 0) + (n - 1) * gapU;
  const u = Math.min(A.h / units, A.w * 0.22);
  let y = A.y + (A.h - units * u) / 2;
  const out = [];
  roots.forEach((r, i) => {
    const kids = descendants(r).length;
    if (kids) out.push(shape('rect', A.x + u * 0.25, y + u * 0.7, A.w - u * 0.5, u * (0.3 + kids * kidU) + u * 0.3,
      { role: 'sub', ci: i, paras: bullets(r), valign: 'top', align: 'left', text: { x: A.x + u * 0.55, y: y + u * 1.08, w: A.w - u * 1.1, h: u * (kids * kidU + 0.1) } }));
    out.push(node('roundRect', A.x, y, A.w, u, r, i, { paras: own(r), align: 'left', adj: { r: 0.3 } }));
    y += u * (1 + (kids ? 0.3 + kids * kidU : 0)) + u * gapU;
  });
  return out;
}

function horizontalBulletList(roots, A) {
  const n = roots.length, kids = hasKids(roots), gap = A.w * 0.025;
  const cw = (A.w - gap * (n - 1)) / n;
  const head = kids ? Math.min(A.h * 0.3, cw * 0.62) : Math.min(A.h, cw * 0.75);
  const top = kids ? A.y : A.y + (A.h - head) / 2;
  const out = [];
  roots.forEach((r, i) => {
    const x = A.x + i * (cw + gap);
    out.push(node('rect', x, top, cw, head, r, i, { paras: own(r) }));
    if (kids) out.push(shape('rect', x, top + head, cw, A.y + A.h - top - head, { role: 'sub', ci: i, paras: bullets(r, 1), align: 'left', valign: 'top' }));
  });
  return out;
}

function stackedList(roots, A) {
  const n = roots.length, gap = A.w * 0.04, cw = (A.w - gap * (n - 1)) / n;
  const d = Math.min(cw * 0.86, A.h * 0.42);
  const out = [];
  roots.forEach((r, i) => {
    const x = A.x + i * (cw + gap);
    const panelTop = A.y + d * 0.55;
    out.push(shape('roundRect', x, panelTop, cw, A.y + A.h - panelTop, { role: 'sub', ci: i, adj: { r: 0.1 }, paras: bullets(r, 1), align: 'left', valign: 'top',
      text: { x: x + cw * 0.08, y: A.y + d * 1.08, w: cw * 0.84, h: A.y + A.h - (A.y + d * 1.08) - cw * 0.05 } }));
    out.push(node('ellipse', x + (cw - d) / 2, A.y, d, d, r, i, { paras: own(r) }));
  });
  return out;
}

function linedList(roots, A) {
  const weights = roots.map((r) => Math.max(1, descendants(r).length * 0.75));
  const total = weights.reduce((a, b) => a + b, 0), out = [];
  let y = A.y;
  roots.forEach((r, i) => {
    const h = (A.h * weights[i]) / total;
    out.push(line([[A.x, y], [A.x + A.w, y]], { ci: i, weight: i ? 1.25 : 3 }));
    const kids = descendants(r).length;
    const left = kids ? A.w * 0.32 : A.w;
    out.push(shape('rect', A.x, y, left, h, { role: 'text', item: r.i, ci: i, paras: own(r), align: 'left', valign: 'top', fit: 'title' }));
    if (kids) out.push(shape('rect', A.x + left, y, A.w - left, h, { role: 'text', ci: i, paras: bullets(r, 1), align: 'left', valign: 'top' }));
    y += h;
  });
  return out;
}

function accentList(roots, A) {
  const n = roots.length, gap = A.h * 0.035;
  const weights = roots.map((r) => 1 + descendants(r).length * 0.55);
  const total = weights.reduce((a, b) => a + b, 0), avail = A.h - gap * (n - 1), out = [];
  let y = A.y;
  roots.forEach((r, i) => {
    const h = (avail * weights[i]) / total, bar = Math.min(A.w * 0.035, 14);
    out.push(shape('rect', A.x, y, A.w, h, { role: 'sub', ci: i }));
    out.push(shape('rect', A.x, y, bar, h, { role: 'node', ci: i, item: r.i }));
    out.push(shape('rect', A.x + bar, y, A.w - bar, h, { role: 'text', item: r.i, ci: i, paras: all(r), align: 'left', valign: 'middle', fit: 'title' }));
    y += h + gap;
  });
  return out;
}

function verticalChevronList(roots, A) {
  const n = roots.length;
  const cw = Math.min(A.w * 0.24, (A.h / n) * 1.25), depth = cw * 0.28;
  const step = (A.h - depth) / n, out = [];
  roots.forEach((r, i) => {
    const y = A.y + i * step;
    if (r.children.length) out.push(shape('roundRect', A.x + cw + A.w * 0.02, y + depth * 0.45, A.w - cw - A.w * 0.02, step - depth * 0.15,
      { role: 'sub', ci: i, adj: { r: 0.08 }, paras: bullets(r, 1), align: 'left', valign: 'middle' }));
    out.push(node('downChevron', A.x, y, cw, step + depth, r, i, { paras: own(r), adj: { depth }, text: { x: A.x + cw * 0.06, y: y + depth, w: cw * 0.88, h: step - depth } }));
  });
  return out;
}

/* ---------- Process ---------- */

function basicProcess(roots, A) {
  const n = roots.length, arrowRatio = 0.34;
  const w = A.w / (n + (n - 1) * arrowRatio), h = Math.min(A.h, w * (hasKids(roots) ? 1.1 : 0.66));
  const y = A.y + (A.h - h) / 2, out = [];
  roots.forEach((r, i) => {
    const x = A.x + i * w * (1 + arrowRatio);
    out.push(node('roundRect', x, y, w, h, r, i, { adj: { r: 0.08 } }));
    if (i < n - 1) {
      const aw = w * arrowRatio * 0.62, ah = Math.min(h * 0.38, aw * 1.25);
      out.push(shape('rightArrow', x + w + (w * arrowRatio - aw) / 2, y + (h - ah) / 2, aw, ah, { role: 'conn', ci: i, adj: { shaft: 0.55 } }));
    }
  });
  return out;
}

function stepUpProcess(roots, A) {
  const n = roots.length, gap = A.w * 0.02, sw = (A.w - gap * (n - 1)) / n, out = [];
  roots.forEach((r, i) => {
    const h = A.h * (0.38 + 0.62 * ((i + 1) / n)), x = A.x + i * (sw + gap), y = A.y + A.h - h;
    out.push(node('rect', x, y, sw, h, r, i, { valign: 'top', text: { x: x + sw * 0.08, y: y + sw * 0.1, w: sw * 0.84, h: h - sw * 0.14 } }));
  });
  return out;
}

function chevronProcess(roots, A) {
  const n = roots.length, kids = hasKids(roots);
  let cw = A.w / n, ch = 0, d = 0, gap = 0;
  for (let k = 0; k < 3; k++) {
    ch = kids ? Math.min(A.h * 0.36, cw * 0.55) : Math.min(A.h, cw * 0.58);
    d = ch * 0.5; gap = d * 0.14;
    cw = (A.w + (n - 1) * (d - gap)) / n;
  }
  const y = kids ? A.y : A.y + (A.h - ch) / 2, out = [];
  roots.forEach((r, i) => {
    const x = A.x + i * (cw - d + gap);
    out.push(node('chevron', x, y, cw, ch, r, i, { paras: own(r), adj: { depth: d }, text: { x: x + d * 0.95, y, w: Math.max(cw - d * 1.9, cw * 0.3), h: ch } }));
    if (r.children.length) out.push(shape('rect', x + d * 0.4, y + ch + A.h * 0.04, cw - d * 0.9, A.y + A.h - (y + ch + A.h * 0.04),
      { role: 'text', ci: i, paras: bullets(r, 1), align: 'left', valign: 'top' }));
  });
  return out;
}

function verticalProcess(roots, A) {
  const n = roots.length, arrowRatio = 0.42;
  const h = A.h / (n + (n - 1) * arrowRatio), w = Math.min(A.w, h * (hasKids(roots) ? 5 : 3.6));
  const x = A.x + (A.w - w) / 2, out = [];
  roots.forEach((r, i) => {
    const y = A.y + i * h * (1 + arrowRatio);
    out.push(node('roundRect', x, y, w, h, r, i, { adj: { r: 0.12 } }));
    if (i < n - 1) {
      const ah = h * arrowRatio * 0.7, aw = Math.min(w * 0.3, ah * 1.3);
      out.push(shape('downArrow', x + (w - aw) / 2, y + h + (h * arrowRatio - ah) / 2, aw, ah, { role: 'conn', ci: i, adj: { shaft: 0.55 } }));
    }
  });
  return out;
}

function continuousArrow(roots, A) {
  const n = roots.length, ah = Math.min(A.h, A.w * 0.5), ay = A.y + (A.h - ah) / 2, head = Math.min(A.w * 0.45, ah * 0.6);
  const out = [shape('rightArrow', A.x, ay, A.w, ah, { role: 'deco', ci: 0, adj: { shaft: 0.62 } })];
  const shaftH = ah * 0.62, avail = A.w - head * 0.75 - A.w * 0.03, gap = avail * 0.035;
  const w = (avail - gap * (n - 1)) / n, h = shaftH * 0.78, y = ay + (ah - h) / 2;
  roots.forEach((r, i) => out.push(node('roundRect', A.x + A.w * 0.03 + i * (w + gap), y, w, h, r, i, { adj: { r: 0.14 } })));
  return out;
}

function timeline(roots, A) {
  const n = roots.length, cy = A.y + A.h / 2, bar = Math.min(A.h * 0.07, 18);
  const out = [shape('rightArrow', A.x, cy - bar, A.w, bar * 2, { role: 'conn', ci: 0, adj: { shaft: 0.5 } })];
  const span = (A.w - bar * 2.2) / n, dot = Math.min(bar * 1.5, span * 0.4);
  const labelW = Math.min(span * 1.9, A.w * 0.45), labelH = A.h / 2 - dot / 2 - A.h * 0.06;
  roots.forEach((r, i) => {
    const cx = A.x + span * (i + 0.5), above = i % 2 === 0;
    const ly = above ? A.y : cy + dot / 2 + A.h * 0.06;
    const lx = clamp(cx - labelW / 2, A.x, A.x + A.w - labelW);
    out.push(line(above ? [[cx, cy - dot / 2], [cx, ly + labelH]] : [[cx, cy + dot / 2], [cx, ly]], { ci: i }));
    out.push(shape('rect', lx, ly, labelW, labelH, { role: 'text', item: r.i, ci: i, paras: all(r), valign: above ? 'bottom' : 'top' }));
    out.push(shape('ellipse', cx - dot / 2, cy - dot / 2, dot, dot, { role: 'node', item: r.i, ci: i }));
  });
  return out;
}

function bendingProcess(roots, A) {
  const n = roots.length, hgap = 0.32, vgap = 0.38;
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const h = Math.min(A.h / (rows + (rows - 1) * vgap), (A.w / (cols + (cols - 1) * hgap)) * 0.64);
    const w = Math.min(A.w / (cols + (cols - 1) * hgap), h * 2.2);
    if (!best || w * h > best.score) best = { cols, rows, w, h, score: w * h };
  }
  const { cols, rows, w, h } = best, gx = w * hgap, gy = h * vgap;
  const top = A.y + (A.h - (rows * h + (rows - 1) * gy)) / 2, out = [];
  const at = (i) => ({ x: A.x + (i % cols) * (w + gx), y: top + Math.floor(i / cols) * (h + gy) });
  roots.forEach((r, i) => {
    const p = at(i);
    out.push(node('roundRect', p.x, p.y, w, h, r, i, { adj: { r: 0.1 } }));
    if (i === n - 1) return;
    const q = at(i + 1);
    if (q.y === p.y) {
      const aw = gx * 0.6, ah = Math.min(h * 0.36, aw * 1.2);
      out.push(shape('rightArrow', p.x + w + (gx - aw) / 2, p.y + (h - ah) / 2, aw, ah, { role: 'conn', ci: i, adj: { shaft: 0.55 } }));
    } else {
      const mid = p.y + h + gy / 2;
      out.push(line([[p.x + w / 2, p.y + h], [p.x + w / 2, mid], [q.x + w / 2, mid], [q.x + w / 2, q.y]], { ci: i, arrow: true, weight: 2 }));
    }
  });
  return out;
}

/* ---------- Cycle ---------- */

/** Points round a circle, the first at the top, clockwise. */
const around = (n, start = -90) => Array.from({ length: n }, (_, i) => start + (360 * i) / n);

function ringArrows(n, cx, cy, R, band, gapDeg, angles, o = {}) {
  const out = [], Ro = R + band / 2;
  for (let i = 0; i < n; i++) {
    const a0 = angles[i] + gapDeg, a1 = (i === n - 1 ? angles[0] + 360 : angles[i + 1]) - gapDeg;
    if (a1 - a0 < 4) continue;
    out.push(shape('arcArrow', cx - Ro, cy - Ro, Ro * 2, Ro * 2, { role: 'conn', ci: i, adj: { a0, a1, inner: (R - band / 2) / Ro }, ...o }));
  }
  return out;
}

function basicCycle(roots, A) {
  const n = roots.length, cx = A.x + A.w / 2, cy = A.y + A.h / 2, S = Math.min(A.w, A.h);
  if (n === 1) return [node('ellipse', cx - S / 2, cy - S / 2, S, S, roots[0], 0)];
  const f = Math.min(2 * Math.sin(Math.PI / n) * 0.62, 0.9), R = S / 2 / (1 + f / 2), d = f * R;
  // The arrows run round the ring between the circles, clear of each by a few degrees.
  const angles = around(n), gapDeg = (Math.asin(Math.min(1, d / 2 / R)) * 180) / Math.PI + 4;
  const out = ringArrows(n, cx, cy, R, R * 0.13, gapDeg, angles);
  angles.forEach((a, i) => out.push(node('ellipse', cx + R * Math.cos(rad(a)) - d / 2, cy + R * Math.sin(rad(a)) - d / 2, d, d, roots[i], i)));
  return out;
}

/** The centre and the items round it: the first item's sub-items when it has them, else the other items. */
function hubAndSpokes(roots) {
  if (roots[0].children.length) return { hub: roots[0], spokes: roots[0].children, hubParas: own(roots[0]) };
  return { hub: roots[0], spokes: roots.slice(1), hubParas: own(roots[0]) };
}

function radialCycle(roots, A) {
  const { hub, spokes, hubParas } = hubAndSpokes(roots), m = spokes.length;
  const cx = A.x + A.w / 2, cy = A.y + A.h / 2, S = Math.min(A.w, A.h);
  if (!m) return [node('ellipse', cx - S / 2, cy - S / 2, S, S, hub, 0, { paras: hubParas })];
  const ds = Math.min(S * 0.3, 2 * (S / 2) * Math.sin(Math.PI / Math.max(m, 2)) * 0.62), R = S / 2 - ds / 2;
  const dc = Math.min(R * 0.95, (R - ds / 2) * 1.6);
  const out = [shape('ellipse', cx - R, cy - R, R * 2, R * 2, { role: 'ring', ci: 0 })];
  const angles = around(m);
  angles.forEach((a, i) => {
    const ux = Math.cos(rad(a)), uy = Math.sin(rad(a));
    out.push(line([[cx + ux * dc / 2, cy + uy * dc / 2], [cx + ux * (R - ds / 2), cy + uy * (R - ds / 2)]], { ci: i + 1, weight: 1.5 }));
  });
  out.push(node('ellipse', cx - dc / 2, cy - dc / 2, dc, dc, hub, 0, { paras: hubParas }));
  angles.forEach((a, i) => out.push(node('ellipse', cx + R * Math.cos(rad(a)) - ds / 2, cy + R * Math.sin(rad(a)) - ds / 2, ds, ds, spokes[i], i + 1)));
  return out;
}

function segmentedCycle(roots, A) {
  const n = roots.length, cx = A.x + A.w / 2, cy = A.y + A.h / 2, R = Math.min(A.w, A.h) / 2;
  if (n === 1) return [node('ellipse', cx - R, cy - R, R * 2, R * 2, roots[0], 0)];
  const step = 360 / n, gap = Math.min(3, step * 0.06), out = [];
  roots.forEach((r, i) => {
    const a0 = -90 + i * step + gap / 2, a1 = a0 + step - gap, mid = (a0 + a1) / 2;
    const tr = R * (n === 2 ? 0.5 : 0.58), tw = Math.min(R * 0.8, 2 * tr * Math.sin(rad(Math.min(step, 160) / 2)) * 0.9), th = R * 0.5;
    out.push(node('sector', cx - R, cy - R, R * 2, R * 2, r, i, { adj: { a0, a1, inner: 0 },
      text: { x: cx + tr * Math.cos(rad(mid)) - tw / 2, y: cy + tr * Math.sin(rad(mid)) - th / 2, w: tw, h: th } }));
  });
  return out;
}

function textCycle(roots, A) {
  const n = roots.length, cx = A.x + A.w / 2, cy = A.y + A.h / 2, S = Math.min(A.w, A.h);
  if (n === 1) return [shape('rect', A.x, A.y, A.w, A.h, { role: 'text', item: roots[0].i, ci: 0, paras: all(roots[0]) })];
  const box = Math.min(S * 0.3, 2 * (S / 2) * Math.sin(Math.PI / n) * 0.7), R = Math.min(A.w / 2 - box * 0.65, A.h / 2 - box / 2);
  const angles = around(n), gapDeg = (Math.asin(Math.min(1, (box * 0.5) / R)) * 180) / Math.PI + 3;
  const out = ringArrows(n, cx, cy, R, R * 0.09, gapDeg, angles);
  angles.forEach((a, i) => out.push(shape('rect', cx + R * Math.cos(rad(a)) - box * 0.65, cy + R * Math.sin(rad(a)) - box / 2, box * 1.3, box,
    { role: 'text', item: roots[i].i, ci: i, paras: all(roots[i]) })));
  return out;
}

function blockCycle(roots, A) {
  const n = roots.length, cx = A.x + A.w / 2, cy = A.y + A.h / 2, S = Math.min(A.w, A.h);
  const bw = Math.min(S * 0.42, n > 1 ? 2 * (S / 2) * Math.sin(Math.PI / n) * 0.78 : S * 0.5), bh = bw * 0.6;
  const R = Math.min(A.w / 2 - bw / 2, A.h / 2 - bh / 2) - S * 0.02;
  const angles = around(n), gapDeg = n > 1 ? (Math.asin(Math.min(1, (bw * 0.42) / R)) * 180) / Math.PI : 0;
  const out = n > 1 ? ringArrows(n, cx, cy, R, R * 0.24, gapDeg, angles, { role: 'deco' }) : [shape('ellipse', cx - R, cy - R, R * 2, R * 2, { role: 'ring', ci: 0 })];
  angles.forEach((a, i) => out.push(node('roundRect', cx + R * Math.cos(rad(a)) - bw / 2, cy + R * Math.sin(rad(a)) - bh / 2, bw, bh, roots[i], i, { adj: { r: 0.18 } })));
  return out;
}

/* ---------- Hierarchy ---------- */

const leaves = (n) => (n.children.length ? n.children.reduce((s, c) => s + leaves(c), 0) : 1);
const depthOf = (n) => 1 + (n.children.length ? Math.max(...n.children.map(depthOf)) : 0);

/** Tree layout along an axis: each node centred over its leaves. `place(n, at, level)` gets the leaf span and the level. */
function walk(roots, place) {
  let at = 0;
  const visit = (n, level, parent) => {
    const start = at;
    if (!n.children.length) at += 1;
    else for (const c of n.children) visit(c, level + 1, n);
    place(n, start, at, level, parent);
  };
  roots.forEach((r) => visit(r, 0, null));
}

function treeChart(roots, A, horizontal) {
  const L = roots.reduce((s, r) => s + leaves(r), 0), D = Math.max(...roots.map(depthOf));
  const across = horizontal ? A.h : A.w, along = horizontal ? A.w : A.h;
  const cell = across / L, band = along / D;
  const size = horizontal
    ? { w: Math.min(band * 0.72, cell * 2.6), h: Math.min(cell * 0.78, band * 0.5) }
    : { w: Math.min(cell * 0.86, band * 2.1), h: Math.min(band * 0.6, cell * 0.66) };
  const boxes = new Map(), out = [], lines = [];
  walk(roots, (n, start, end, level) => {
    const c = (start + end) / 2 * cell, b = (level + 0.5) * band;
    const x = horizontal ? A.x + b - size.w / 2 : A.x + c - size.w / 2;
    const y = horizontal ? A.y + c - size.h / 2 : A.y + b - size.h / 2;
    boxes.set(n, { x, y, ...size });
  });
  walk(roots, (n, s, e, level, parent) => {
    const b = boxes.get(n), ci = level === 0 ? 0 : level;
    out.push(node('rect', b.x, b.y, b.w, b.h, n, ci, { paras: own(n), fit: level ? 'levels' : 'level0' }));
    if (!parent) return;
    const p = boxes.get(parent);
    if (horizontal) {
      const mid = (p.x + p.w + b.x) / 2;
      lines.push(line([[p.x + p.w, p.y + p.h / 2], [mid, p.y + p.h / 2], [mid, b.y + b.h / 2], [b.x, b.y + b.h / 2]], { ci: level }));
    } else {
      const mid = (p.y + p.h + b.y) / 2;
      lines.push(line([[p.x + p.w / 2, p.y + p.h], [p.x + p.w / 2, mid], [b.x + b.w / 2, mid], [b.x + b.w / 2, b.y]], { ci: level }));
    }
  });
  return [...lines, ...out];
}

const orgChart = (roots, A) => treeChart(roots, A, false);
const horizontalHierarchy = (roots, A) => treeChart(roots, A, true);

function hierarchyList(roots, A) {
  const n = roots.length, gap = A.w * 0.03, cw = (A.w - gap * (n - 1)) / n;
  const most = Math.max(1, ...roots.map((r) => descendants(r).length));
  const unit = A.h / (1.3 + most * 1.25), out = [];
  roots.forEach((r, i) => {
    const x = A.x + i * (cw + gap), headH = unit * 1.3;
    out.push(node('roundRect', x, A.y, cw, headH * 0.92, r, i, { paras: own(r), adj: { r: 0.15 } }));
    const kids = descendants(r), spine = x + cw * 0.08;
    let lastY = null;
    kids.forEach(({ node: k, depth }, j) => {
      const y = A.y + headH + unit * 0.25 + j * unit * 1.25, indent = cw * 0.16 * depth, bx = x + indent, bw = cw - indent;
      out.push(line([[spine + cw * 0.16 * (depth - 1), y + unit / 2], [bx, y + unit / 2]], { ci: i }));
      out.push(node('roundRect', bx, y, bw, unit, k, i, { role: 'sub', paras: own(k), adj: { r: 0.15 } }));
      lastY = y + unit / 2;
    });
    if (lastY != null) out.unshift(line([[spine, A.y + headH * 0.92], [spine, lastY]], { ci: i }));
  });
  return out;
}

function tableHierarchy(roots, A) {
  const L = roots.reduce((s, r) => s + leaves(r), 0), D = Math.max(...roots.map(depthOf));
  const g = Math.min(A.w, A.h) * 0.025, cw = (A.w + g) / L, bh = (A.h + g) / D, out = [];
  walk(roots, (n, start, end, level) => {
    out.push(node('rect', A.x + start * cw, A.y + level * bh, (end - start) * cw - g, bh - g, n, level, { paras: own(n), fit: `level${Math.min(level, 2)}` }));
  });
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/* ---------- Relationship ---------- */

function basicVenn(roots, A) {
  const n = roots.length, cx = A.x + A.w / 2, cy = A.y + A.h / 2;
  if (n === 1) { const S = Math.min(A.w, A.h); return [node('ellipse', cx - S / 2, cy - S / 2, S, S, roots[0], 0, { opacity: 0.72 })]; }
  const start = n === 2 ? 180 : -90, angles = around(n, start), k = 2 * Math.sin(Math.PI / n);
  // Lay the circles out for a centre ring of radius 1, then scale the whole to the frame.
  const pts = angles.map((a) => [Math.cos(rad(a)), Math.sin(rad(a))]);
  const minX = Math.min(...pts.map((p) => p[0] - k)), maxX = Math.max(...pts.map((p) => p[0] + k));
  const minY = Math.min(...pts.map((p) => p[1] - k)), maxY = Math.max(...pts.map((p) => p[1] + k));
  const s = Math.min(A.w / (maxX - minX), A.h / (maxY - minY)), ox = cx - ((minX + maxX) / 2) * s, oy = cy - ((minY + maxY) / 2) * s;
  const r = k * s;
  return roots.map((root, i) => {
    const [px, py] = pts[i], x = ox + px * s, y = oy + py * s;
    const tx = x + px * r * 0.32, ty = y + py * r * 0.32, tw = r * 1.15, th = r * 0.8;
    return node('ellipse', x - r, y - r, r * 2, r * 2, root, i, { opacity: 0.72, text: { x: tx - tw / 2, y: ty - th / 2, w: tw, h: th } });
  });
}

function radialVenn(roots, A) {
  const { hub, spokes, hubParas } = hubAndSpokes(roots), m = spokes.length;
  const cx = A.x + A.w / 2, cy = A.y + A.h / 2, S = Math.min(A.w, A.h);
  if (!m) return [node('ellipse', cx - S / 2, cy - S / 2, S, S, hub, 0, { paras: hubParas, opacity: 0.72 })];
  const rs = Math.min(S * 0.2, (S / 2) * Math.sin(Math.PI / Math.max(m, 3)) * 0.95), R = S / 2 - rs, rc = R * 0.62;
  const out = [node('ellipse', cx - rc, cy - rc, rc * 2, rc * 2, hub, 0, { paras: hubParas, opacity: 0.72 })];
  around(m).forEach((a, i) => out.push(node('ellipse', cx + R * Math.cos(rad(a)) - rs, cy + R * Math.sin(rad(a)) - rs, rs * 2, rs * 2, spokes[i], i + 1, { opacity: 0.72 })));
  return out;
}

function target(roots, A) {
  const n = roots.length, S = Math.min(A.h, A.w * 0.48), R = S / 2, cx = A.x + R, cy = A.y + A.h / 2;
  const out = [], labelX = A.x + S + A.w * 0.06, labelW = A.x + A.w - labelX, rowH = A.h / n;
  roots.forEach((r, i) => {
    const ri = R * (1 - i / n);
    out.push(shape('ellipse', cx - ri, cy - ri, ri * 2, ri * 2, { role: 'node', item: r.i, ci: i }));
  });
  roots.forEach((r, i) => {
    const ri = R * (1 - i / n), next = R * (1 - (i + 1) / n), m = (ri + next) / 2;
    const ly = A.y + rowH * (i + 0.5), dy = clamp(ly - cy, -m * 0.92, m * 0.92);
    const px = cx + Math.sqrt(Math.max(0, m * m - dy * dy)) * (i === n - 1 ? 0 : 1), py = cy + dy;
    out.push(line([[px, py], [labelX - A.w * 0.015, ly]], { ci: i }));
    out.push(shape('rect', labelX, A.y + rowH * i, labelW, rowH, { role: 'text', item: r.i, ci: i, paras: all(r), align: 'left' }));
  });
  return out;
}

function opposingArrows(roots, A) {
  const g = A.w * 0.03, w = (A.w - g) / 2, h = Math.min(A.h, w * 0.75), y = A.y + (A.h - h) / 2;
  return roots.slice(0, 2).map((r, i) => node(i ? 'rightArrow' : 'leftArrow', A.x + i * (w + g), y, w, h, r, i, { adj: { shaft: 0.68 },
    text: { x: A.x + i * (w + g) + (i ? w * 0.06 : w * 0.3), y: y + h * 0.18, w: w * 0.64, h: h * 0.64 } }));
}

function balance(roots, A) {
  const [left, right] = roots, weight = (r) => (r ? 1 + r.children.length : 0);
  const tilt = clamp((weight(right) - weight(left)) * 6, -18, 18);
  const cx = A.x + A.w / 2, fw = A.w * 0.12, fh = A.h * 0.2, beamL = A.w * 0.84, beamT = Math.max(4, A.h * 0.035);
  const pivotY = A.y + A.h - fh, out = [];
  out.push(shape('triangle', cx - fw / 2, pivotY, fw, fh, { role: 'deco', ci: 0 }));
  out.push(shape('rect', cx - beamL / 2, pivotY - beamT, beamL, beamT, { role: 'deco', ci: 0, rot: tilt }));
  const headH = A.h * 0.17, headW = A.w * 0.38, ux = Math.cos(rad(tilt)), uy = Math.sin(rad(tilt));
  [left, right].forEach((r, side) => {
    if (!r) return;
    const sign = side ? 1 : -1;
    out.push(node('roundRect', side ? A.x + A.w - headW : A.x, A.y, headW, headH, r, side, { paras: own(r), adj: { r: 0.15 } }));
    const ex = cx + sign * ux * beamL * 0.3, ey = pivotY - beamT / 2 + sign * uy * beamL * 0.3;
    const bw = A.w * 0.3, room = ey - (A.y + headH * 1.2), bh = Math.min(A.h * 0.12, room / Math.max(1, r.children.length) - 2);
    r.children.forEach((k, j) => {
      const dist = beamT / 2 + bh * (j + 0.5) + j * 2;
      const bx = ex + uy * dist, by = ey - ux * dist;
      out.push(node('rect', bx - bw / 2, by - bh / 2, bw, bh, k, side, { role: 'sub', paras: all(k), rot: tilt }));
    });
  });
  return out;
}

function equation(roots, A) {
  const n = roots.length;
  if (n === 1) { const S = Math.min(A.w, A.h); return [node('ellipse', A.x + (A.w - S) / 2, A.y + (A.h - S) / 2, S, S, roots[0], 0)]; }
  const sym = 0.5, d = Math.min(A.h, A.w / (n + (n - 1) * (sym + 0.16))), s = d * sym, g = d * 0.08;
  const total = n * d + (n - 1) * (s + 2 * g);
  let x = A.x + (A.w - total) / 2;
  const y = A.y + (A.h - d) / 2, out = [];
  roots.forEach((r, i) => {
    out.push(node('ellipse', x, y, d, d, r, i));
    x += d + g;
    if (i < n - 1) {
      out.push(shape(i === n - 2 ? 'equal' : 'plus', x, y + (d - s) / 2, s, s, { role: 'conn', ci: i }));
      x += s + g;
    }
  });
  return out;
}

/* ---------- Matrix ---------- */

function quadrants(A, aspect = 1.5) {
  const g = Math.min(A.w, A.h) * 0.03;
  let cw = (A.w - g) / 2, ch = (A.h - g) / 2;
  cw = Math.min(cw, ch * aspect); ch = Math.min(ch, cw * 1.2);
  const x0 = A.x + (A.w - (cw * 2 + g)) / 2, y0 = A.y + (A.h - (ch * 2 + g)) / 2;
  return { g, cw, ch, x0, y0, cells: [0, 1, 2, 3].map((i) => ({ x: x0 + (i % 2) * (cw + g), y: y0 + Math.floor(i / 2) * (ch + g), w: cw, h: ch })) };
}

function basicMatrix(roots, A) {
  return quadrants(A).cells.slice(0, roots.length).map((c, i) => node('roundRect', c.x, c.y, c.w, c.h, roots[i], i, { adj: { r: 0.1 } }));
}

function titledMatrix(roots, A) {
  const title = roots[0], cells = title.children.length ? title.children : roots.slice(1);
  const q = quadrants(A, 1.35), out = [];
  q.cells.forEach((c, i) => {
    const r = cells[i];
    out.push(r ? node('rect', c.x, c.y, c.w, c.h, r, i + 1, { text: { x: c.x + c.w * (i % 2 ? 0.3 : 0.06), y: c.y + c.h * (i < 2 ? 0.06 : 0.3), w: c.w * 0.64, h: c.h * 0.64 } })
      : shape('rect', c.x, c.y, c.w, c.h, { role: 'deco', ci: i + 1 }));
  });
  const tw = (q.cw * 2 + q.g) * 0.42, th = (q.ch * 2 + q.g) * 0.26, cx = q.x0 + q.cw + q.g / 2, cy = q.y0 + q.ch + q.g / 2;
  out.push(node('roundRect', cx - tw / 2, cy - th / 2, tw, th, title, 0, { paras: own(title), adj: { r: 0.2 } }));
  return out;
}

function gridMatrix(roots, A) {
  const cx = A.x + A.w / 2, cy = A.y + A.h / 2, t = Math.min(A.w, A.h) * 0.07, out = [];
  out.push(shape('leftRightArrow', A.x, cy - t, A.w, t * 2, { role: 'conn', ci: 0, adj: { shaft: 0.45 } }));
  out.push(shape('upDownArrow', cx - t, A.y, t * 2, A.h, { role: 'conn', ci: 0, adj: { shaft: 0.45 } }));
  const g = t * 1.4, w = A.w / 2 - g - A.w * 0.04, h = A.h / 2 - g - A.h * 0.04;
  roots.slice(0, 4).forEach((r, i) => {
    const x = i % 2 ? cx + g : cx - g - w, y = i < 2 ? cy - g - h : cy + g;
    out.push(node('roundRect', x, y, w, h, r, i, { adj: { r: 0.1 } }));
  });
  return out;
}

function cycleMatrix(roots, A) {
  const kids = hasKids(roots.slice(0, 4)), S = kids ? Math.min(A.h, A.w * 0.5) : Math.min(A.w, A.h);
  const R = S / 2, cx = A.x + A.w / 2, cy = A.y + A.h / 2, out = [];
  const starts = [180, 270, 90, 0];
  roots.slice(0, 4).forEach((r, i) => {
    if (kids && r.children.length) {
      const bw = (A.w - S) / 2 - A.w * 0.02, bh = A.h / 2 - A.h * 0.02;
      const bx = i % 2 ? cx + R + A.w * 0.02 : A.x, by = i < 2 ? A.y : cy + A.h * 0.02;
      out.push(shape('roundRect', bx, by, bw, bh, { role: 'sub', ci: i, adj: { r: 0.08 }, paras: bullets(r, 1), align: 'left', valign: i < 2 ? 'top' : 'bottom' }));
    }
  });
  roots.slice(0, 4).forEach((r, i) => {
    const a0 = starts[i] + 1.5, a1 = starts[i] + 88.5, mid = rad((a0 + a1) / 2), tr = R * 0.55, tw = R * 0.62, th = R * 0.46;
    out.push(node('sector', cx - R, cy - R, R * 2, R * 2, r, i, { paras: own(r), adj: { a0, a1, inner: 0 },
      text: { x: cx + tr * Math.cos(mid) - tw / 2, y: cy + tr * Math.sin(mid) - th / 2, w: tw, h: th } }));
  });
  return out;
}

/* ---------- Pyramid ---------- */

function bands(roots, A, inverted) {
  const n = roots.length, H = Math.min(A.h, A.w / 1.15), B = H * 1.15;
  const x0 = A.x + (A.w - B) / 2, y0 = A.y + (A.h - H) / 2, g = H * 0.02, bh = (H - g * (n - 1)) / n;
  return roots.map((r, i) => {
    const top = i * (bh + g), bottom = top + bh;
    // Widths at the band's top and bottom edges, from the apex.
    const at = (y) => (inverted ? B * (1 - y / H) : (B * y) / H);
    const wTop = at(top), wBottom = at(bottom), wide = Math.max(wTop, wBottom), narrow = Math.min(wTop, wBottom);
    const x = x0 + (B - wide) / 2, y = y0 + top, inset = (wide - narrow) / 2;
    const apex = narrow < 1;
    const kind = inverted ? (apex ? 'invTriangle' : 'invTrapezoid') : (apex ? 'triangle' : 'trapezoid');
    // The apex's text sits in its broad half, as wide as the triangle there allows.
    const tw = apex ? wide * 0.56 : (wide + narrow) / 2 * 0.86;
    return node(kind, x, y, wide, bh, r, i, { adj: { inset }, fit: apex ? 'apex' : 'band',
      text: { x: x + (wide - tw) / 2, y: apex ? y + bh * (inverted ? 0.04 : 0.4) : y, w: tw, h: apex ? bh * 0.56 : bh } });
  });
}

const basicPyramid = (roots, A) => bands(roots, A, false);
const invertedPyramid = (roots, A) => bands(roots, A, true);

function pyramidList(roots, A) {
  const n = roots.length, H = Math.min(A.h, A.w * 0.6), B = H * 1.1, x0 = A.x + (A.w - Math.max(B, A.w * 0.9)) / 2;
  const y0 = A.y + (A.h - H) / 2, out = [shape('triangle', x0, y0, B, H, { role: 'deco', ci: 0 })];
  const g = H * 0.04, top = y0 + H * 0.22, bh = (y0 + H - top - g * (n - 1)) / n, bx = x0 + B / 2, bw = A.x + A.w - bx;
  roots.forEach((r, i) => out.push(node('roundRect', bx, top + i * (bh + g), bw, bh, r, i, { role: 'sub', adj: { r: 0.2 } })));
  return out;
}

function segmentedPyramid(roots, A) {
  const n = roots.length, rows = Math.max(1, Math.ceil(Math.sqrt(n)));
  const H = Math.min(A.h, A.w / 1.15), B = H * 1.15, x0 = A.x + (A.w - B) / 2, y0 = A.y + (A.h - H) / 2;
  const th = H / rows, tw = B / rows, g = Math.min(th, tw) * 0.04, out = [];
  let k = 0;
  for (let row = 0; row < rows; row++) {
    const count = 2 * row + 1, left = x0 + B / 2 - (tw * (row + 1)) / 2;
    for (let j = 0; j < count; j++) {
      const up = j % 2 === 0, x = left + (j * tw) / 2, y = y0 + row * th;
      const r = roots[k++];
      const box = { x: x + g, y: y + g, w: tw - 2 * g, h: th - 2 * g };
      const text = up ? { x: box.x + box.w * 0.22, y: box.y + box.h * 0.42, w: box.w * 0.56, h: box.h * 0.52 }
        : { x: box.x + box.w * 0.22, y: box.y + box.h * 0.06, w: box.w * 0.56, h: box.h * 0.52 };
      out.push(r ? node(up ? 'triangle' : 'invTriangle', box.x, box.y, box.w, box.h, r, k - 1, { text })
        : shape(up ? 'triangle' : 'invTriangle', box.x, box.y, box.w, box.h, { role: 'deco', ci: k - 1 }));
    }
  }
  return out;
}

/* ---------- The gallery ---------- */

export const SMARTART_CATEGORIES = [
  ['list', 'List'], ['process', 'Process'], ['cycle', 'Cycle'], ['hierarchy', 'Hierarchy'],
  ['relationship', 'Relationship'], ['matrix', 'Matrix'], ['pyramid', 'Pyramid'],
];

const ideas = ['Idea one', 'Idea two', 'Idea three'];
const withPoints = (heads, points = 2) => heads.flatMap((t, i) => [{ text: t, level: 0 }, ...Array.from({ length: points }, (_, j) => ({ text: `Point ${i + 1}.${j + 1}`, level: 1 }))]);
const flat = (texts) => texts.map((text) => ({ text, level: 0 }));
const team = () => [{ text: 'Director', level: 0 }, { text: 'Design', level: 1 }, { text: 'Research', level: 2 }, { text: 'Visual', level: 2 },
  { text: 'Engineering', level: 1 }, { text: 'Platform', level: 2 }, { text: 'Apps', level: 2 }, { text: 'Operations', level: 1 }];

/**
 * Every layout: id, name, category, a one-line description (the gallery's), how many top-level items it
 * shows (the rest wait in the text), the outline a new diagram starts with, and its builder.
 */
export const SMARTART_LAYOUTS = [
  { id: 'blockList', name: 'Block List', category: 'list', build: blockList, sample: () => flat(['Planning', 'Budget', 'People', 'Tools', 'Review']),
    description: 'Equal blocks in rows, for items that need no order. Sub-items list inside their block.' },
  { id: 'verticalBulletList', name: 'Stacked Headings', category: 'list', build: verticalBulletList, sample: () => withPoints(['Goals', 'Approach']),
    description: 'Wide headings down the page, each over a panel listing its sub-items.' },
  { id: 'horizontalBulletList', name: 'Column Headings', category: 'list', build: horizontalBulletList, sample: () => withPoints(ideas),
    description: 'A heading for each column with its sub-items listed beneath.' },
  { id: 'stackedList', name: 'Badge Columns', category: 'list', build: stackedList, sample: () => withPoints(['Plan', 'Do', 'Check']),
    description: 'A round badge crowns each column of sub-items.' },
  { id: 'linedList', name: 'Ruled List', category: 'list', build: linedList, sample: () => withPoints(['Summary', 'Details']),
    description: 'Text on ruled lines: each heading on the left, its sub-items to the right.' },
  { id: 'accentList', name: 'Accent Bar List', category: 'list', build: accentList, sample: () => withPoints(['First topic', 'Second topic', 'Third topic'], 1),
    description: 'Rows of text, each marked by a coloured bar at its edge.' },
  { id: 'verticalChevronList', name: 'Chevron Rows', category: 'list', build: verticalChevronList, sample: () => withPoints(['Stage 1', 'Stage 2', 'Stage 3'], 1),
    description: 'Downward chevrons, one per row, with the sub-items beside them.' },

  { id: 'basicProcess', name: 'Steps', category: 'process', build: basicProcess, sample: () => flat(['Plan', 'Build', 'Test', 'Launch']),
    description: 'Boxes joined by arrows, for steps taken in order.' },
  { id: 'stepUpProcess', name: 'Rising Steps', category: 'process', build: stepUpProcess, sample: () => flat(['Start', 'Grow', 'Scale', 'Lead']),
    description: 'Columns that climb from left to right, for progress or growth.' },
  { id: 'chevronProcess', name: 'Chevron Steps', category: 'process', build: chevronProcess, sample: () => withPoints(['Discover', 'Define', 'Deliver'], 1),
    description: 'Chevrons that point the way, with sub-items listed under each.' },
  { id: 'verticalProcess', name: 'Downward Steps', category: 'process', build: verticalProcess, sample: () => flat(['Request', 'Review', 'Approve']),
    description: 'Boxes from top to bottom joined by arrows.' },
  { id: 'continuousArrow', name: 'Arrow Track', category: 'process', build: continuousArrow, sample: () => flat(['Phase 1', 'Phase 2', 'Phase 3']),
    description: 'Steps laid along one broad arrow, for continuous progress.' },
  { id: 'timeline', name: 'Timeline', category: 'process', build: timeline, sample: () => flat(['Q1 Kickoff', 'Q2 Beta', 'Q3 Launch', 'Q4 Review']),
    description: 'Milestones on a line, their labels above and below in turn.' },
  { id: 'bendingProcess', name: 'Winding Steps', category: 'process', build: bendingProcess, sample: () => flat(['One', 'Two', 'Three', 'Four', 'Five', 'Six']),
    description: 'Many steps in rows that wrap, read like lines of text.' },

  { id: 'basicCycle', name: 'Cycle', category: 'cycle', build: basicCycle, sample: () => flat(['Research', 'Design', 'Build', 'Review']),
    description: 'Circles round a ring with curved arrows: a repeating sequence.' },
  { id: 'radialCycle', name: 'Hub and Spokes', category: 'cycle', build: radialCycle, sample: () => [{ text: 'Customer', level: 0 }, ...flat(['Sales', 'Support', 'Product', 'Billing']).map((x) => ({ ...x, level: 1 }))],
    description: 'A central item with related items round it. The first item is the hub; its sub-items are the spokes.' },
  { id: 'segmentedCycle', name: 'Segmented Circle', category: 'cycle', build: segmentedCycle, sample: () => flat(['Plan', 'Act', 'Measure']),
    description: 'Wedges of one circle, for the parts of a whole that repeat.' },
  { id: 'textCycle', name: 'Text Cycle', category: 'cycle', build: textCycle, sample: () => flat(['Listen', 'Learn', 'Improve', 'Share']),
    description: 'Words round a circle linked by thin arrows, with room for more text.' },
  { id: 'blockCycle', name: 'Ring Cycle', category: 'cycle', build: blockCycle, sample: () => flat(['Collect', 'Analyse', 'Decide', 'Act']),
    description: 'Labels sit on a broad ring of arrows that turns continuously.' },

  { id: 'orgChart', name: 'Organization Chart', category: 'hierarchy', build: orgChart, sample: team,
    description: 'Who reports to whom, from the top down. Sub-items become the boxes below.' },
  { id: 'horizontalHierarchy', name: 'Sideways Tree', category: 'hierarchy', build: horizontalHierarchy, sample: team,
    description: 'A tree that branches from left to right, for decisions and breakdowns.' },
  { id: 'hierarchyList', name: 'Tree List', category: 'hierarchy', build: hierarchyList, sample: () => withPoints(['Team A', 'Team B'], 3),
    description: 'Headings across the top with their sub-items in indented boxes below.' },
  { id: 'tableHierarchy', name: 'Stacked Tree', category: 'hierarchy', build: tableHierarchy, sample: team,
    description: 'Each item spans the items beneath it, like a table of levels.' },

  { id: 'basicVenn', name: 'Overlapping Circles', category: 'relationship', build: basicVenn, sample: () => flat(['People', 'Process', 'Tools']),
    description: 'Circles that overlap, for ideas that share ground.' },
  { id: 'radialVenn', name: 'Centre Overlap', category: 'relationship', build: radialVenn, sample: () => [{ text: 'Core', level: 0 }, ...flat(['Speed', 'Quality', 'Cost']).map((x) => ({ ...x, level: 1 }))],
    description: 'Circles that overlap a central one. The first item is the centre.' },
  { id: 'target', name: 'Target', category: 'relationship', build: target, sample: () => flat(['Market', 'Segment', 'Customer']),
    description: 'Rings that close in on a centre, each labelled to the side.' },
  { id: 'opposingArrows', name: 'Opposing Arrows', category: 'relationship', build: opposingArrows, maxRoots: 2, sample: () => flat(['Supply', 'Demand']),
    description: 'Two arrows pointing apart, for opposing forces or choices. Shows two items.' },
  { id: 'balance', name: 'Balance', category: 'relationship', build: balance, maxRoots: 2, sample: () => [{ text: 'Pros', level: 0 }, { text: 'Faster', level: 1 }, { text: 'Cheaper', level: 1 }, { text: 'Cons', level: 0 }, { text: 'Riskier', level: 1 }],
    description: 'A beam that tips toward the side with more sub-items. Shows two items.' },
  { id: 'equation', name: 'Equation', category: 'relationship', build: equation, sample: () => flat(['Idea', 'Effort', 'Result']),
    description: 'Items that add up to a result: the last item follows the equals sign.' },

  { id: 'basicMatrix', name: 'Quadrants', category: 'matrix', build: basicMatrix, maxRoots: 4, sample: () => flat(['Strengths', 'Weaknesses', 'Opportunities', 'Threats']),
    description: 'Four blocks in a square. Shows four items.' },
  { id: 'titledMatrix', name: 'Titled Quadrants', category: 'matrix', build: titledMatrix, sample: () => [{ text: 'Priorities', level: 0 }, ...flat(['Urgent', 'Important', 'Later', 'Drop']).map((x) => ({ ...x, level: 1 }))],
    description: 'Four quadrants round a title. The first item is the title; its sub-items fill the quadrants.' },
  { id: 'gridMatrix', name: 'Axis Grid', category: 'matrix', build: gridMatrix, maxRoots: 4, sample: () => flat(['High value', 'Quick win', 'Low value', 'Hard work']),
    description: 'Four boxes placed by two crossing axes. Shows four items.' },
  { id: 'cycleMatrix', name: 'Quartered Circle', category: 'matrix', build: cycleMatrix, maxRoots: 4, sample: () => withPoints(['North', 'East', 'West', 'South'], 1),
    description: 'A circle in four parts, with sub-items in the corners. Shows four items.' },

  { id: 'basicPyramid', name: 'Pyramid', category: 'pyramid', build: basicPyramid, sample: () => flat(['Vision', 'Strategy', 'Tactics', 'Tasks']),
    description: 'Levels from a narrow top to a broad base.' },
  { id: 'invertedPyramid', name: 'Funnel Pyramid', category: 'pyramid', build: invertedPyramid, sample: () => flat(['Visitors', 'Leads', 'Customers']),
    description: 'Levels from a broad top narrowing downward.' },
  { id: 'pyramidList', name: 'Pyramid Labels', category: 'pyramid', build: pyramidList, sample: () => flat(['Foundation', 'Growth', 'Excellence']),
    description: 'A pyramid with a labelled box for each level across it.' },
  { id: 'segmentedPyramid', name: 'Tiled Pyramid', category: 'pyramid', build: segmentedPyramid, sample: () => flat(['A', 'B', 'C', 'D']),
    description: 'A pyramid of triangle tiles, one for each item.' },
];

export const layoutById = (id) => SMARTART_LAYOUTS.find((l) => l.id === id) || null;
export const DEFAULT_LAYOUT = 'basicProcess';
