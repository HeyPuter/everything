// File ▸ Import ▸ SVG as Curves: paths and basic shapes become Bézier curve objects (one per
// element) on the XY plane, keeping the exact control points; arcs are converted to cubic
// segments. Filled shapes become filled 2D curves with a material of their fill colour.
import type { BezierPoint, CurveData, DocumentData, HandleType, ObjectData, Spline } from '../../data/types';
import { newCollection, newCurve, newMaterial, newObject } from '../../data/defaults';
import { parseColor, parseTransform } from '../../lines/svgparse';
import { uniqueName } from './common';

type Mat = [number, number, number, number, number, number];
type P2 = [number, number];
const IDENT: Mat = [1, 0, 0, 1, 0, 0];
const mul = (m: Mat, n: Mat): Mat => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m: Mat, p: P2): P2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

/** A cubic segment from the previous point: two control points, the end, and whether it is straight. */
export interface Seg {
  c1: P2;
  c2: P2;
  to: P2;
  line: boolean;
}
export interface SubPath {
  start: P2;
  segs: Seg[];
  closed: boolean;
}

const lineSeg = (a: P2, b: P2): Seg => ({ c1: [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3], c2: [a[0] + ((b[0] - a[0]) * 2) / 3, a[1] + ((b[1] - a[1]) * 2) / 3], to: b, line: true });

/** Elliptical arc (SVG endpoint parameters) as cubic segments of at most 90°. */
export function arcToCubics(p0: P2, rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, p1: P2): Seg[] {
  if (rx === 0 || ry === 0 || (p0[0] === p1[0] && p0[1] === p1[1])) return [lineSeg(p0, p1)];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi),
    sin = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2,
    dy = (p0[1] - p1[1]) / 2;
  const x1 = cos * dx + sin * dy,
    y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let co = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) co = -co;
  const cx1 = (co * rx * y1) / ry,
    cy1 = (-co * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (p0[0] + p1[0]) / 2,
    cy = sin * cx1 + cos * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= Math.PI * 2;
  else if (sweep && dt < 0) dt += Math.PI * 2;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const step = dt / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const pt = (t: number): P2 => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const der = (t: number): P2 => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  const out: Seg[] = [];
  for (let i = 0; i < n; i++) {
    const a = t1 + i * step,
      b = a + step;
    const pa = pt(a),
      pb = i === n - 1 ? p1 : pt(b),
      da = der(a),
      db = der(b);
    out.push({ c1: [pa[0] + k * da[0], pa[1] + k * da[1]], c2: [pb[0] - k * db[0], pb[1] - k * db[1]], to: pb, line: false });
  }
  return out;
}

/** Parse SVG path data into sub-paths of cubic segments (control points preserved). */
export function parsePathCubics(d: string): SubPath[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: SubPath[] = [];
  let i = 0;
  let cur: P2 = [0, 0];
  let sub: SubPath | null = null;
  let cmd = '';
  let lastCubic: P2 | null = null;
  let lastQuad: P2 | null = null;
  const isNum = (t: string | undefined) => t !== undefined && !/^[a-zA-Z]$/.test(t);
  const n = () => Number(tokens[i++]);
  const flag = () => {
    // flags may be packed without separators ("a1 1 0 01 10 10")
    const t = tokens[i];
    if (t.length > 1 && /^[01]/.test(t)) {
      tokens[i] = t.slice(1);
      return t[0] === '1';
    }
    i++;
    return t === '1';
  };
  const begin = (p: P2) => {
    sub = { start: p, segs: [], closed: false };
    out.push(sub);
  };
  const push = (s: Seg) => {
    if (!sub) begin(cur);
    sub!.segs.push(s);
    cur = s.to;
  };
  while (i < tokens.length) {
    if (!isNum(tokens[i])) cmd = tokens[i++];
    else if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const R = (x: number, y: number): P2 => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    const C = cmd.toUpperCase();
    if (C === 'Z') {
      if (sub) {
        const s: SubPath = sub;
        if (cur[0] !== s.start[0] || cur[1] !== s.start[1]) push(lineSeg(cur, s.start));
        s.closed = true;
        cur = s.start;
      }
      sub = null;
      lastCubic = lastQuad = null;
      continue;
    }
    if (!isNum(tokens[i])) {
      // a command without enough numbers: skip it
      continue;
    }
    if (C === 'M') {
      cur = R(n(), n());
      begin(cur);
      cmd = rel ? 'l' : 'L'; // following pairs are line-tos
      lastCubic = lastQuad = null;
    } else if (C === 'L') {
      push(lineSeg(cur, R(n(), n())));
      lastCubic = lastQuad = null;
    } else if (C === 'H') {
      const x = n();
      push(lineSeg(cur, [rel ? cur[0] + x : x, cur[1]]));
      lastCubic = lastQuad = null;
    } else if (C === 'V') {
      const y = n();
      push(lineSeg(cur, [cur[0], rel ? cur[1] + y : y]));
      lastCubic = lastQuad = null;
    } else if (C === 'C') {
      const c1 = R(n(), n()),
        c2 = R(n(), n()),
        to = R(n(), n());
      push({ c1, c2, to, line: false });
      lastCubic = c2;
      lastQuad = null;
    } else if (C === 'S') {
      const c1: P2 = lastCubic ? [2 * cur[0] - lastCubic[0], 2 * cur[1] - lastCubic[1]] : cur;
      const c2 = R(n(), n()),
        to = R(n(), n());
      push({ c1, c2, to, line: false });
      lastCubic = c2;
      lastQuad = null;
    } else if (C === 'Q' || C === 'T') {
      const q: P2 = C === 'Q' ? R(n(), n()) : lastQuad ? [2 * cur[0] - lastQuad[0], 2 * cur[1] - lastQuad[1]] : cur;
      const to = R(n(), n());
      push({ c1: [cur[0] + ((q[0] - cur[0]) * 2) / 3, cur[1] + ((q[1] - cur[1]) * 2) / 3], c2: [to[0] + ((q[0] - to[0]) * 2) / 3, to[1] + ((q[1] - to[1]) * 2) / 3], to, line: false });
      lastQuad = q;
      lastCubic = null;
    } else if (C === 'A') {
      const rx = n(),
        ry = n(),
        rot = n(),
        large = flag(),
        sweep = flag();
      const to = R(n(), n());
      for (const s of arcToCubics(cur, rx, ry, rot, large, sweep, to)) push(s);
      lastCubic = lastQuad = null;
    } else i++;
  }
  return out.filter((s) => s.segs.length > 0 || s.closed);
}

/** Closed ellipse as four cubic quarter arcs, starting at the leftmost point. */
function ellipsePath(cx: number, cy: number, rx: number, ry: number): SubPath {
  // quarter-arc handle length with the smallest radial error
  const k = 0.551915024494;
  const p: P2[] = [
    [cx - rx, cy],
    [cx, cy - ry],
    [cx + rx, cy],
    [cx, cy + ry],
  ];
  const segs: Seg[] = [
    { c1: [cx - rx, cy - k * ry], c2: [cx - k * rx, cy - ry], to: p[1], line: false },
    { c1: [cx + k * rx, cy - ry], c2: [cx + rx, cy - k * ry], to: p[2], line: false },
    { c1: [cx + rx, cy + k * ry], c2: [cx + k * rx, cy + ry], to: p[3], line: false },
    { c1: [cx - k * rx, cy + ry], c2: [cx - rx, cy + k * ry], to: p[0], line: false },
  ];
  return { start: p[0], segs, closed: true };
}

function polyPath(pts: P2[], closed: boolean): SubPath {
  const segs: Seg[] = [];
  for (let k = 1; k < pts.length; k++) segs.push(lineSeg(pts[k - 1], pts[k]));
  if (closed && pts.length > 2) segs.push(lineSeg(pts[pts.length - 1], pts[0]));
  return { start: pts[0], segs, closed };
}

export interface SvgCurveShape {
  name: string;
  paths: SubPath[];
  /** sRGB fill (null = not filled) */
  fill: [number, number, number] | null;
}

interface Style {
  fill: string;
  display: boolean;
}

/** Shapes of an SVG document in document pixels (y down), with their transforms applied. */
export function svgCurveShapes(root: Element): { shapes: SvgCurveShape[]; width: number; height: number } {
  const num = (el: Element, k: string, d = 0) => {
    const v = parseFloat(el.getAttribute(k) ?? '');
    return Number.isNaN(v) ? d : v;
  };
  const vb = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const hasVb = vb.length === 4 && vb.every((x) => !Number.isNaN(x)) && vb[2] > 0 && vb[3] > 0;
  const W = num(root, 'width', hasVb ? vb[2] : 100),
    H = num(root, 'height', hasVb ? vb[3] : 100);
  const rootM: Mat = hasVb ? [W / vb[2], 0, 0, H / vb[3], (-vb[0] * W) / vb[2], (-vb[1] * H) / vb[3]] : IDENT;
  const shapes: SvgCurveShape[] = [];
  const styleOf = (el: Element, parent: Style): Style => {
    const css: Record<string, string> = {};
    for (const part of (el.getAttribute('style') ?? '').split(';')) {
      const i = part.indexOf(':');
      if (i > 0) css[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    const get = (k: string) => css[k] ?? el.getAttribute(k) ?? undefined;
    return { fill: get('fill') ?? parent.fill, display: parent.display && get('display') !== 'none' && get('visibility') !== 'hidden' };
  };
  const walk = (el: Element, m: Mat, st: Style) => {
    const tag = el.tagName.toLowerCase().replace(/^svg:/, '');
    if (['defs', 'clippath', 'mask', 'style', 'title', 'desc', 'symbol', 'metadata', 'pattern', 'lineargradient', 'radialgradient', 'marker'].includes(tag)) return;
    const style = styleOf(el, st);
    if (!style.display) return;
    const mm = mul(m, parseTransform(el.getAttribute('transform')));
    if (tag === 'g' || tag === 'svg' || tag === 'a' || tag === 'switch') {
      for (const c of Array.from(el.children)) walk(c, mm, style);
      return;
    }
    let paths: SubPath[] = [];
    switch (tag) {
      case 'path':
        paths = parsePathCubics(el.getAttribute('d') ?? '');
        break;
      case 'rect': {
        const x = num(el, 'x'),
          y = num(el, 'y'),
          w = num(el, 'width'),
          h = num(el, 'height');
        let rx = Math.min(num(el, 'rx', num(el, 'ry', 0)), w / 2),
          ry = Math.min(num(el, 'ry', num(el, 'rx', 0)), h / 2);
        if (w <= 0 || h <= 0) break;
        if (rx > 0 && ry > 0) {
          rx = Math.max(0, rx);
          ry = Math.max(0, ry);
          const d = `M ${x + rx} ${y} H ${x + w - rx} A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry} V ${y + h - ry} A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} H ${x + rx} A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry} V ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`;
          paths = parsePathCubics(d);
        } else
          paths = [
            polyPath(
              [
                [x, y],
                [x + w, y],
                [x + w, y + h],
                [x, y + h],
              ],
              true,
            ),
          ];
        break;
      }
      case 'circle':
        if (num(el, 'r') > 0) paths = [ellipsePath(num(el, 'cx'), num(el, 'cy'), num(el, 'r'), num(el, 'r'))];
        break;
      case 'ellipse':
        if (num(el, 'rx') > 0 && num(el, 'ry') > 0) paths = [ellipsePath(num(el, 'cx'), num(el, 'cy'), num(el, 'rx'), num(el, 'ry'))];
        break;
      case 'line':
        paths = [
          polyPath(
            [
              [num(el, 'x1'), num(el, 'y1')],
              [num(el, 'x2'), num(el, 'y2')],
            ],
            false,
          ),
        ];
        break;
      case 'polyline':
      case 'polygon': {
        const v = (el.getAttribute('points') ?? '').match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
        const pts: P2[] = [];
        for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k], v[k + 1]]);
        if (pts.length >= 2) paths = [polyPath(pts, tag === 'polygon')];
        break;
      }
      default:
        return;
    }
    if (!paths.length) return;
    const tr = (p: P2) => apply(mm, p);
    paths = paths.map((s) => ({ start: tr(s.start), closed: s.closed, segs: s.segs.map((g) => ({ c1: tr(g.c1), c2: tr(g.c2), to: tr(g.to), line: g.line })) }));
    shapes.push({ name: el.getAttribute('id') || 'Curve', paths, fill: parseColor(style.fill) });
  };
  walk(root, rootM, { fill: 'black', display: true });
  return { shapes, width: W, height: H };
}

/** Metres per SVG pixel (90 pixels per inch). */
export const SVG_PX = 0.0254 / 90;

/** Bézier spline (document XY plane) of one sub-path. */
export function subPathSpline(s: SubPath, height: number, scale = SVG_PX): Spline {
  const to3 = (p: P2): [number, number, number] => [p[0] * scale, (height - p[1]) * scale, 0];
  const pts: { co: P2; left: P2; right: P2; lt: HandleType; rt: HandleType }[] = [{ co: s.start, left: s.start, right: s.start, lt: 'VECTOR', rt: 'VECTOR' }];
  for (const g of s.segs) {
    const prev = pts[pts.length - 1];
    prev.right = g.c1;
    prev.rt = g.line ? 'VECTOR' : 'FREE';
    pts.push({ co: g.to, left: g.c2, right: g.to, lt: g.line ? 'VECTOR' : 'FREE', rt: 'VECTOR' });
  }
  let cyclic = false;
  if (s.closed && pts.length > 2) {
    // the closing segment ends where the path began: fold its last point into the first
    const last = pts.pop()!;
    pts[0].left = last.left;
    pts[0].lt = last.lt;
    cyclic = true;
  }
  // open ends: handles sit on the point
  if (!cyclic) {
    pts[0].left = pts[0].co;
    pts[0].lt = pts[0].rt;
    const e = pts[pts.length - 1];
    e.right = e.co;
    e.rt = e.lt;
  }
  const bezier_points: BezierPoint[] = pts.map((p) => ({
    co: to3(p.co),
    handle_left: to3(p.left),
    handle_right: to3(p.right),
    handle_left_type: p.lt,
    handle_right_type: p.rt,
    radius: 1,
    tilt: 0,
  }));
  return { type: 'BEZIER', bezier_points, points: [], use_cyclic_u: cyclic, resolution_u: 12, order_u: 4, use_smooth: true, material_index: 0 };
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Import an SVG document as curve objects in a new collection named after the file. */
export function importSvgCurves(doc: DocumentData, text: string, fileName: string, parentCollection: string, o: { scale?: number } = {}): ObjectData[] {
  const xml = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = xml.documentElement;
  if (!root || root.tagName.toLowerCase().replace(/^svg:/, '') !== 'svg') throw new Error('Not an SVG document');
  const { shapes, height } = svgCurveShapes(root);
  const col = newCollection(uniqueName(doc, fileName, 'collections'));
  doc.collections[col.id] = col;
  doc.collections[parentCollection].children.push(col.id);
  const mats = new Map<string, string>();
  const objects: ObjectData[] = [];
  for (const sh of shapes) {
    const splines = sh.paths.filter((p) => p.segs.length > 0).map((p) => subPathSpline(p, height, SVG_PX * (o.scale ?? 1)));
    if (!splines.length) continue;
    const name = uniqueName(doc, sh.name, 'objects');
    const cu: CurveData = newCurve(uniqueName(doc, sh.name, 'curves'));
    cu.splines = splines;
    if (sh.fill) {
      cu.dimensions = '2D';
      cu.fill_mode = 'BOTH';
      const key = sh.fill.map((v) => v.toFixed(4)).join(',');
      let mid = mats.get(key);
      if (!mid) {
        const ma = newMaterial(uniqueName(doc, 'SVGMat', 'materials'), [toLinear(sh.fill[0]), toLinear(sh.fill[1]), toLinear(sh.fill[2]), 1]);
        doc.materials[ma.id] = ma;
        mid = ma.id;
        mats.set(key, mid);
      }
      cu.materials = [mid];
    }
    doc.curves[cu.id] = cu;
    const ob = newObject(name, 'CURVE', cu.id);
    doc.objects[ob.id] = ob;
    doc.object_order.push(ob.id);
    col.objects.push(ob.id);
    objects.push(ob);
  }
  return objects;
}
