// DXF export of a drawing sheet (AutoCAD R12 ASCII, millimetres, y up): lines, true arcs
// and circles, text and filled arrowheads, on layers by line kind, so the sheet opens in
// any 2D CAD program.

import { parseSvgPath } from './pdf';
import type { Item } from './sheet';
import { flattenPath } from './views';

type P2 = [number, number];

/** Layer of an item by its line weight and pattern. */
function layerOf(it: Item): string {
  if (it.t === 'text') return 'TEXT';
  if (it.t === 'rect') return 'BORDER';
  if (it.t === 'tri') return 'DIM';
  const dash = 'dash' in it ? it.dash : undefined;
  const w = it.t === 'path' || it.t === 'line' || it.t === 'circle' ? it.w : 0.25;
  if (dash && dash.length >= 4) return 'CENTER';
  if (dash) return 'HIDDEN';
  return w >= 0.3 ? 'VISIBLE' : 'THIN';
}

const LAYERS: [string, number, string][] = [
  ['VISIBLE', 7, 'CONTINUOUS'], ['HIDDEN', 8, 'DASHED'], ['CENTER', 4, 'CENTER'], ['THIN', 7, 'CONTINUOUS'],
  ['DIM', 7, 'CONTINUOUS'], ['TEXT', 7, 'CONTINUOUS'], ['BORDER', 7, 'CONTINUOUS'],
];

/** Text in the DXF's code page: diameter, degree and plus-minus as their control codes, an ellipsis as three dots, else ASCII. */
export function dxfText(s: string): string {
  return s.replace(/Ø|⌀/g, '%%c').replace(/°/g, '%%d').replace(/±/g, '%%p').replace(/…/g, '...').replace(/[^\x20-\x7e]/g, '?');
}

const n = (v: number) => (Math.abs(v) < 1e-10 ? '0' : String(+v.toFixed(6)));

export function toDxf(items: Item[], w: number, h: number): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), typeof value === 'number' ? n(value) : value);
  const Y = (y: number) => h - y;
  const head = (type: string, layer: string, color?: string) => {
    g(0, type); g(8, layer);
    if (color) g(62, '1');
  };
  const line = (a: P2, b: P2, layer: string, color?: string) => {
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) return;
    head('LINE', layer, color);
    g(10, a[0]); g(20, Y(a[1])); g(30, 0); g(11, b[0]); g(21, Y(b[1])); g(31, 0);
  };
  const poly = (pts: P2[], layer: string, color?: string) => { for (let i = 0; i + 1 < pts.length; i++) line(pts[i], pts[i + 1], layer, color); };
  /** A circular arc from the sheet (y down): centre, radius, start angle, signed sweep (radians, y down). */
  const arc = (c: P2, r: number, a0: number, sweep: number, layer: string, color?: string) => {
    if (Math.abs(sweep) >= 2 * Math.PI - 1e-9) {
      head('CIRCLE', layer, color); g(10, c[0]); g(20, Y(c[1])); g(30, 0); g(40, r);
      return;
    }
    // y flips: angles change sign, and DXF arcs run counterclockwise.
    const s = -(sweep > 0 ? a0 + sweep : a0), e = -(sweep > 0 ? a0 : a0 + sweep);
    const deg = (x: number) => ((((x * 180) / Math.PI) % 360) + 360) % 360;
    head('ARC', layer, color); g(10, c[0]); g(20, Y(c[1])); g(30, 0); g(40, r); g(50, deg(s)); g(51, deg(e));
  };

  out.push('0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSBASE', '10', '0', '20', '0', '30', '0',
    '9', '$EXTMIN', '10', '0', '20', '0', '30', '0', '9', '$EXTMAX', '10', n(w), '20', n(h), '30', '0', '9', '$MEASUREMENT', '70', '1', '0', 'ENDSEC');
  out.push('0', 'SECTION', '2', 'TABLES');
  out.push('0', 'TABLE', '2', 'LTYPE', '70', '3');
  const ltype = (name: string, desc: string, pattern: number[]) => {
    out.push('0', 'LTYPE', '2', name, '70', '0', '3', desc, '72', '65', '73', String(pattern.length), '40', n(pattern.reduce((s, x) => s + Math.abs(x), 0)));
    for (const p of pattern) out.push('49', n(p));
  };
  ltype('CONTINUOUS', 'Solid line', []);
  ltype('DASHED', '__ __ __', [1.6, -0.8]);
  ltype('CENTER', '____ _ ____', [6, -1.2, 1, -1.2]);
  out.push('0', 'ENDTAB');
  out.push('0', 'TABLE', '2', 'LAYER', '70', String(LAYERS.length));
  for (const [name, color, lt] of LAYERS) out.push('0', 'LAYER', '2', name, '70', '0', '62', String(color), '6', lt);
  out.push('0', 'ENDTAB', '0', 'ENDSEC');
  out.push('0', 'SECTION', '2', 'ENTITIES');

  for (const it of items) {
    const layer = layerOf(it);
    const color = (it as { color?: string }).color;
    switch (it.t) {
      case 'line': line([it.x1, it.y1], [it.x2, it.y2], layer, color); break;
      case 'rect': poly([[it.x, it.y], [it.x + it.w, it.y], [it.x + it.w, it.y + it.h], [it.x, it.y + it.h], [it.x, it.y]], layer); break;
      case 'circle': arc([it.cx, it.cy], it.r, 0, 2 * Math.PI, layer, color); break;
      case 'tri':
        head('SOLID', layer, color);
        g(10, it.a[0]); g(20, Y(it.a[1])); g(30, 0); g(11, it.b[0]); g(21, Y(it.b[1])); g(31, 0);
        g(12, it.c[0]); g(22, Y(it.c[1])); g(32, 0); g(13, it.c[0]); g(23, Y(it.c[1])); g(33, 0);
        break;
      case 'text': {
        const just = it.anchor === 'middle' ? 1 : it.anchor === 'end' ? 2 : 0;
        head('TEXT', layer, color);
        g(10, it.x); g(20, Y(it.y)); g(30, 0); g(40, it.size * 0.72); g(1, dxfText(it.s));
        if (it.rotate) g(50, -it.rotate);
        if (it.bold) g(7, 'STANDARD');
        if (just) { g(72, String(just)); g(11, it.x); g(21, Y(it.y)); g(31, 0); }
        break;
      }
      case 'path': pathEntities(it, layer, color, line, arc, poly); break;
    }
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n') + '\n';
}

/** A path's lines and circular arcs as DXF lines and arcs; curves and elliptical arcs as short lines. */
function pathEntities(
  it: Extract<Item, { t: 'path' }>,
  layer: string,
  color: string | undefined,
  line: (a: P2, b: P2, layer: string, color?: string) => void,
  arc: (c: P2, r: number, a0: number, sweep: number, layer: string, color?: string) => void,
  poly: (pts: P2[], layer: string, color?: string) => void,
) {
  const { d, tx, ty, s } = it;
  if (/[CcSsQqTt]/.test(d)) {
    for (const pl of flattenPath(d, tx, ty, s, 0.01)) poly(pl, layer, color);
    return;
  }
  const T = (p: P2): P2 => [p[0] * s + tx, p[1] * s + ty];
  const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  let i = 0, cmd = '';
  let cur: P2 = [0, 0], start: P2 = [0, 0];
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/^[a-zA-Z]$/.test(toks[i])) cmd = toks[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const o: P2 = rel ? cur : [0, 0];
    if (C === 'M') { cur = [o[0] + num(), o[1] + num()]; start = cur; cmd = rel ? 'l' : 'L'; }
    else if (C === 'L') { const p: P2 = [o[0] + num(), o[1] + num()]; line(T(cur), T(p), layer, color); cur = p; }
    else if (C === 'H') { const p: P2 = [(rel ? cur[0] : 0) + num(), cur[1]]; line(T(cur), T(p), layer, color); cur = p; }
    else if (C === 'V') { const p: P2 = [cur[0], (rel ? cur[1] : 0) + num()]; line(T(cur), T(p), layer, color); cur = p; }
    else if (C === 'Z') { line(T(cur), T(start), layer, color); cur = start; }
    else if (C === 'A') {
      const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
      const p: P2 = [o[0] + num(), o[1] + num()];
      const c = Math.abs(rx - ry) < 1e-9 * (1 + rx) ? circleArc(cur, p, rx, !!large, !!sweep) : null;
      if (c) arc(T(c.c), c.r * s, c.a0, c.sweep, layer, color);
      else {
        // An ellipse: as lines along its curve.
        const segs = parseSvgPath(`M${cur[0]} ${cur[1]}A${rx} ${ry} ${rot} ${large} ${sweep} ${p[0]} ${p[1]}`);
        const sub = segs.map((q) => ('p' in q ? `${q.op}${'c1' in q ? `${q.c1[0]} ${q.c1[1]} ${q.c2[0]} ${q.c2[1]} ` : ''}${q.p[0]} ${q.p[1]}` : '')).join('');
        for (const pl of flattenPath(sub, tx, ty, s, 0.01)) poly(pl, layer, color);
      }
      cur = p;
    } else i++;
  }
}

/** Centre, radius, start angle and signed sweep of an SVG circular arc (y down). */
export function circleArc(a: P2, b: P2, r: number, large: boolean, sweep: boolean): { c: P2; r: number; a0: number; sweep: number } | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const dd = Math.hypot(dx, dy);
  if (dd < 1e-12 || r <= 0) return null;
  r = Math.max(r, dd / 2);
  const h = Math.sqrt(Math.max(0, r * r - (dd * dd) / 4));
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  // SVG: with the sweep flag the arc turns toward positive angles (clockwise on paper, y down).
  const sgn = large === sweep ? -1 : 1;
  const c: P2 = [mx - (sgn * h * dy) / dd, my + (sgn * h * dx) / dd];
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  let a1 = Math.atan2(b[1] - c[1], b[0] - c[0]) - a0;
  if (sweep && a1 < 0) a1 += 2 * Math.PI;
  if (!sweep && a1 > 0) a1 -= 2 * Math.PI;
  return { c, r, a0, sweep: a1 };
}
