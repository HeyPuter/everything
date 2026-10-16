// SVG reading for "SVG as Grease Pencil": shapes and paths (with transforms and inherited styles)
// flattened into polylines with stroke / fill colours. Pure apart from the DOM parser it is given.

export interface SvgShape {
  /** layer name: the top-level group or element id */
  layer: string;
  /** polylines in SVG user units (y down); several for compound paths */
  subpaths: { pts: [number, number][]; closed: boolean }[];
  /** sRGB 0..1 colours with opacity, or null for none */
  stroke: [number, number, number, number] | null;
  fill: [number, number, number, number] | null;
  /** stroke width in user units (after transforms) */
  width: number;
}

type Mat = [number, number, number, number, number, number]; // a b c d e f
const IDENT: Mat = [1, 0, 0, 1, 0, 0];
const mul = (m: Mat, n: Mat): Mat => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Parse an SVG transform list. */
export function parseTransform(s: string | null): Mat {
  let m: Mat = IDENT;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(s))) {
    const a = (r[2].match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
    let t: Mat = IDENT;
    switch (r[1]) {
      case 'matrix':
        if (a.length >= 6) t = [a[0], a[1], a[2], a[3], a[4], a[5]];
        break;
      case 'translate':
        t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case 'scale':
        t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const k = ((a[0] ?? 0) * Math.PI) / 180;
        const c = Math.cos(k),
          s2 = Math.sin(k);
        t = [c, s2, -s2, c, 0, 0];
        if (a.length >= 3) t = mul(mul([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]);
        break;
      }
      case 'skewX':
        t = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = mul(m, t);
  }
  return m;
}

const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  lime: '#00ff00',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  aqua: '#00ffff',
  magenta: '#ff00ff',
  fuchsia: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  maroon: '#800000',
  olive: '#808000',
  purple: '#800080',
  teal: '#008080',
  navy: '#000080',
  orange: '#ffa500',
  brown: '#a52a2a',
  pink: '#ffc0cb',
};

/** CSS colour → sRGB 0..1 (null for none / unknown). */
export function parseColor(v: string | null | undefined): [number, number, number] | null {
  if (!v) return null;
  let s = v.trim().toLowerCase();
  if (s === 'none' || s === 'transparent' || s.startsWith('url(')) return null;
  s = NAMED[s] ?? s;
  if (s.startsWith('#')) {
    const h = s.slice(1);
    if (h.length === 3 || h.length === 4) return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16) / 255) as [number, number, number];
    if (h.length >= 6) return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
    return null;
  }
  const m = /rgba?\(([^)]*)\)/.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    return [0, 1, 2].map((i) => (p[i]?.endsWith('%') ? parseFloat(p[i]) / 100 : parseFloat(p[i] ?? '0') / 255)) as [number, number, number];
  }
  return null;
}

interface Style {
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  fillOpacity: number;
  strokeOpacity: number;
  display: boolean;
}

function readStyle(el: Element, parent: Style): Style {
  const css: Record<string, string> = {};
  for (const part of (el.getAttribute('style') ?? '').split(';')) {
    const i = part.indexOf(':');
    if (i > 0) css[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  const get = (k: string) => css[k] ?? el.getAttribute(k) ?? undefined;
  const numOr = (v: string | undefined, d: number) => (v !== undefined && v !== 'inherit' && !Number.isNaN(parseFloat(v)) ? parseFloat(v) : d);
  return {
    fill: get('fill') ?? parent.fill,
    stroke: get('stroke') ?? parent.stroke,
    strokeWidth: numOr(get('stroke-width'), parent.strokeWidth),
    opacity: parent.opacity * numOr(get('opacity'), 1),
    fillOpacity: numOr(get('fill-opacity'), parent.fillOpacity),
    strokeOpacity: numOr(get('stroke-opacity'), parent.strokeOpacity),
    display: parent.display && get('display') !== 'none' && get('visibility') !== 'hidden',
  };
}

// ---------------------------------------------------------------------------
// path data

/** Flatten SVG path data into polylines (`res` samples per curve segment). */
export function parsePathData(d: string, res = 10): { pts: [number, number][]; closed: boolean }[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: { pts: [number, number][]; closed: boolean }[] = [];
  let cur: { pts: [number, number][]; closed: boolean } | null = null;
  let x = 0,
    y = 0,
    sx = 0,
    sy = 0;
  let lastCtrl = null as [number, number] | null;
  let lastCmd = '';
  let i = 0;
  const n = () => Number(tokens[i++]);
  const isNum = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i]);
  const push = (px: number, py: number) => {
    if (!cur) {
      cur = { pts: [[x, y]], closed: false };
      out.push(cur);
    }
    cur.pts.push([px, py]);
  };
  const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    for (let k = 1; k <= res; k++) {
      const t = k / res,
        u = 1 - t;
      push(u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey);
    }
  };
  const quad = (x1: number, y1: number, ex: number, ey: number) => {
    for (let k = 1; k <= res; k++) {
      const t = k / res,
        u = 1 - t;
      push(u * u * x + 2 * u * t * x1 + t * t * ex, u * u * y + 2 * u * t * y1 + t * t * ey);
    }
  };
  const arc = (rx: number, ry: number, rot: number, large: number, sweep: number, ex: number, ey: number) => {
    if (rx === 0 || ry === 0) return push(ex, ey);
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    const phi = (rot * Math.PI) / 180,
      cp = Math.cos(phi),
      sp = Math.sin(phi);
    const dx = (x - ex) / 2,
      dy = (y - ey) / 2;
    const x1 = cp * dx + sp * dy,
      y1 = -sp * dx + cp * dy;
    const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (lam > 1) {
      rx *= Math.sqrt(lam);
      ry *= Math.sqrt(lam);
    }
    const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let co = Math.sqrt(Math.max(0, num / den));
    if (large === sweep) co = -co;
    const cxp = (co * rx * y1) / ry,
      cyp = (-co * ry * x1) / rx;
    const cx = cp * cxp - sp * cyp + (x + ex) / 2,
      cy = sp * cxp + cp * cyp + (y + ey) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
    let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    else if (sweep && dt < 0) dt += 2 * Math.PI;
    const steps = Math.max(2, Math.ceil((Math.abs(dt) / (Math.PI / 2)) * res));
    for (let k = 1; k <= steps; k++) {
      const t = t1 + (dt * k) / steps;
      const px = rx * Math.cos(t),
        py = ry * Math.sin(t);
      push(cp * px - sp * py + cx, sp * px + cp * py + cy);
    }
  };
  while (i < tokens.length) {
    let cmd = tokens[i];
    if (/^[a-zA-Z]$/.test(cmd)) i++;
    else cmd = lastCmd === 'M' ? 'L' : lastCmd === 'm' ? 'l' : lastCmd;
    if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0,
      oy = rel ? y : 0;
    switch (C) {
      case 'M': {
        x = ox + n();
        y = oy + n();
        sx = x;
        sy = y;
        cur = { pts: [[x, y]], closed: false };
        out.push(cur);
        lastCtrl = null;
        break;
      }
      case 'L':
        x = ox + n();
        y = oy + n();
        push(x, y);
        lastCtrl = null;
        break;
      case 'H':
        x = (rel ? x : 0) + n();
        push(x, y);
        lastCtrl = null;
        break;
      case 'V':
        y = (rel ? y : 0) + n();
        push(x, y);
        lastCtrl = null;
        break;
      case 'C': {
        const x1 = ox + n(),
          y1 = oy + n(),
          x2 = ox + n(),
          y2 = oy + n(),
          ex = ox + n(),
          ey = oy + n();
        cubic(x1, y1, x2, y2, ex, ey);
        lastCtrl = [x2, y2];
        x = ex;
        y = ey;
        break;
      }
      case 'S': {
        const x1: number = lastCtrl && /[CS]/i.test(lastCmd) ? 2 * x - lastCtrl[0] : x,
          y1: number = lastCtrl && /[CS]/i.test(lastCmd) ? 2 * y - lastCtrl[1] : y;
        const x2 = ox + n(),
          y2 = oy + n(),
          ex = ox + n(),
          ey = oy + n();
        cubic(x1, y1, x2, y2, ex, ey);
        lastCtrl = [x2, y2];
        x = ex;
        y = ey;
        break;
      }
      case 'Q': {
        const x1 = ox + n(),
          y1 = oy + n(),
          ex = ox + n(),
          ey = oy + n();
        quad(x1, y1, ex, ey);
        lastCtrl = [x1, y1];
        x = ex;
        y = ey;
        break;
      }
      case 'T': {
        const x1: number = lastCtrl && /[QT]/i.test(lastCmd) ? 2 * x - lastCtrl[0] : x,
          y1: number = lastCtrl && /[QT]/i.test(lastCmd) ? 2 * y - lastCtrl[1] : y;
        const ex = ox + n(),
          ey = oy + n();
        quad(x1, y1, ex, ey);
        lastCtrl = [x1, y1];
        x = ex;
        y = ey;
        break;
      }
      case 'A': {
        const rx = n(),
          ry = n(),
          rot = n(),
          large = n(),
          sweep = n(),
          ex = ox + n(),
          ey = oy + n();
        arc(rx, ry, rot, large ? 1 : 0, sweep ? 1 : 0, ex, ey);
        x = ex;
        y = ey;
        lastCtrl = null;
        break;
      }
      case 'Z':
        if (cur) cur.closed = true;
        x = sx;
        y = sy;
        cur = null;
        lastCtrl = null;
        break;
      default:
        // unknown command: skip its numbers
        while (isNum()) i++;
    }
    lastCmd = cmd;
    // implicit repeats are handled by the loop (commands reuse lastCmd)
    if (C === 'Z' && isNum()) lastCmd = 'L';
  }
  // drop the duplicate closing point
  for (const s of out) {
    const a = s.pts[0],
      b = s.pts[s.pts.length - 1];
    if (s.closed && s.pts.length > 2 && Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) s.pts.pop();
  }
  return out.filter((s) => s.pts.length >= 2);
}

function ellipse(cx: number, cy: number, rx: number, ry: number, res: number): [number, number][] {
  const n = Math.max(8, res * 4);
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

const num = (el: Element, k: string, d = 0) => {
  const v = parseFloat(el.getAttribute(k) ?? '');
  return Number.isNaN(v) ? d : v;
};

/** Shapes of an SVG document (any object with `getAttribute` / `children` DOM elements). */
export function svgShapes(root: Element, res = 10): { shapes: SvgShape[]; width: number; height: number } {
  const shapes: SvgShape[] = [];
  const base: Style = { fill: 'black', stroke: 'none', strokeWidth: 1, opacity: 1, fillOpacity: 1, strokeOpacity: 1, display: true };
  let layerCount = 0;
  const vb = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  let rootM: Mat = IDENT;
  const W = num(root, 'width', vb[2] || 100),
    H = num(root, 'height', vb[3] || 100);
  if (vb.length === 4 && vb.every((x) => !Number.isNaN(x)) && vb[2] > 0 && vb[3] > 0) rootM = [W / vb[2], 0, 0, H / vb[3], (-vb[0] * W) / vb[2], (-vb[1] * H) / vb[3]];
  const walk = (el: Element, m: Mat, st: Style, layer: string | null, depth: number) => {
    const tag = el.tagName.toLowerCase().replace(/^svg:/, '');
    if (tag === 'defs' || tag === 'clippath' || tag === 'mask' || tag === 'style' || tag === 'title' || tag === 'desc' || tag === 'symbol' || tag === 'metadata') return;
    const style = readStyle(el, st);
    if (!style.display) return;
    const mm = mul(m, parseTransform(el.getAttribute('transform')));
    // top-level elements name the layers
    const lay = layer ?? (depth === 0 ? '' : el.getAttribute('id') || `Layer_${String(layerCount++).padStart(3, '0')}`);
    if (tag === 'g' || tag === 'svg' || tag === 'a') {
      for (const c of Array.from(el.children)) walk(c, mm, style, depth === 0 && tag === 'svg' ? null : lay, depth + 1);
      return;
    }
    let subs: { pts: [number, number][]; closed: boolean }[] = [];
    switch (tag) {
      case 'path':
        subs = parsePathData(el.getAttribute('d') ?? '', res);
        break;
      case 'rect': {
        const x = num(el, 'x'),
          y = num(el, 'y'),
          w = num(el, 'width'),
          h = num(el, 'height');
        if (w > 0 && h > 0) subs = [{ pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], closed: true }];
        break;
      }
      case 'circle':
        subs = [{ pts: ellipse(num(el, 'cx'), num(el, 'cy'), num(el, 'r'), num(el, 'r'), res), closed: true }];
        break;
      case 'ellipse':
        subs = [{ pts: ellipse(num(el, 'cx'), num(el, 'cy'), num(el, 'rx'), num(el, 'ry'), res), closed: true }];
        break;
      case 'line':
        subs = [{ pts: [[num(el, 'x1'), num(el, 'y1')], [num(el, 'x2'), num(el, 'y2')]], closed: false }];
        break;
      case 'polyline':
      case 'polygon': {
        const v = (el.getAttribute('points') ?? '').match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
        const pts: [number, number][] = [];
        for (let k = 0; k + 1 < v.length; k += 2) pts.push([v[k], v[k + 1]]);
        subs = [{ pts, closed: tag === 'polygon' }];
        break;
      }
      default:
        return;
    }
    subs = subs.filter((s) => s.pts.length >= 2).map((s) => ({ closed: s.closed, pts: s.pts.map(([x, y]) => apply(mm, x, y)) }));
    if (!subs.length) return;
    const fill = parseColor(style.fill),
      stroke = parseColor(style.stroke);
    if (!fill && !stroke) return;
    const scale = Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2]));
    shapes.push({
      layer: lay,
      subpaths: subs,
      fill: fill ? [fill[0], fill[1], fill[2], style.fillOpacity * style.opacity] : null,
      stroke: stroke ? [stroke[0], stroke[1], stroke[2], style.strokeOpacity * style.opacity] : null,
      width: style.strokeWidth * scale,
    });
  };
  walk(root, rootM, base, null, 0);
  return { shapes, width: W, height: H };
}
