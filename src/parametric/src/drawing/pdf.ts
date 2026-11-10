// Minimal vector PDF writer for drawing sheets: stroked paths (from SVG path
// data), lines, rectangles and text in the built-in Helvetica font. Sheet
// coordinates are millimetres with y pointing down; PDF uses points with y up.

const PT = 72 / 25.4;

// WinAnsiEncoding (the built-in fonts' encoding) is Latin-1 except for 0x80-0x9F.
const WIN_ANSI_HIGH = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

// Advance widths (1/1000 em) of printable ASCII, from the Helvetica and
// Helvetica-Bold font metrics (Arial has the same widths).
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Width of a line of Helvetica text in the units of `size` (other characters count as a digit). */
export function textWidth(str: string, size: number, bold = false): number {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let w = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0)!;
    w += c >= 32 && c < 127 ? table[c - 32] : 556;
  }
  return (w / 1000) * size;
}

/** Text as the body of a PDF literal string in WinAnsiEncoding, ASCII only (octal escapes). */
export function pdfString(str: string): string {
  let out = '';
  for (const ch of str) {
    const u = ch.codePointAt(0)!;
    let b = u >= 0x20 && u < 0x7f ? u : u >= 0xa0 && u <= 0xff ? u : 0x80 + WIN_ANSI_HIGH.indexOf(ch);
    if (b === 0x7f || (b >= 0x80 && b < 0xa0 && WIN_ANSI_HIGH.charCodeAt(b - 0x80) < 0xa0)) b = 0x3f; // not encodable: '?'
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${ch}`;
    else if (b < 0x80) out += String.fromCharCode(b);
    else out += `\\${b.toString(8)}`;
  }
  return out;
}

/** A PDF text string (document information) in UTF-16BE, so any character survives. */
function pdfTextString(str: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < str.length; i++) hex += str.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

export type Seg = { op: 'M' | 'L'; p: [number, number] } | { op: 'C'; c1: [number, number]; c2: [number, number]; p: [number, number] } | { op: 'Z' };

/** Parses SVG path data into absolute move/line/cubic/close segments. */
export function parseSvgPath(d: string): Seg[] {
  const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const out: Seg[] = [];
  let i = 0;
  let cmd = '';
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let lastC: [number, number] | null = null;
  let lastQ: [number, number] | null = null;
  const num = () => Number(toks[i++]);
  const isNum = () => i < toks.length && !/^[a-zA-Z]$/.test(toks[i]);
  while (i < toks.length) {
    if (/^[a-zA-Z]$/.test(toks[i])) cmd = toks[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    switch (C) {
      case 'M': {
        cx = ox + num(); cy = oy + num();
        sx = cx; sy = cy;
        out.push({ op: 'M', p: [cx, cy] });
        cmd = rel ? 'l' : 'L';
        lastC = lastQ = null;
        break;
      }
      case 'L': cx = ox + num(); cy = oy + num(); out.push({ op: 'L', p: [cx, cy] }); lastC = lastQ = null; break;
      case 'H': cx = ox + num(); out.push({ op: 'L', p: [cx, cy] }); lastC = lastQ = null; break;
      case 'V': cy = oy + num(); out.push({ op: 'L', p: [cx, cy] }); lastC = lastQ = null; break;
      case 'C': {
        const c1: [number, number] = [ox + num(), oy + num()];
        const c2: [number, number] = [ox + num(), oy + num()];
        cx = ox + num(); cy = oy + num();
        out.push({ op: 'C', c1, c2, p: [cx, cy] });
        lastC = c2; lastQ = null;
        break;
      }
      case 'S': {
        const c1: [number, number] = lastC ? [2 * cx - lastC[0], 2 * cy - lastC[1]] : [cx, cy];
        const c2: [number, number] = [ox + num(), oy + num()];
        cx = ox + num(); cy = oy + num();
        out.push({ op: 'C', c1, c2, p: [cx, cy] });
        lastC = c2; lastQ = null;
        break;
      }
      case 'Q':
      case 'T': {
        const q: [number, number] = C === 'Q' ? [ox + num(), oy + num()] : lastQ ? [2 * cx - lastQ[0], 2 * cy - lastQ[1]] : [cx, cy];
        const x = ox + num(), y = oy + num();
        out.push({ op: 'C', c1: [cx + (2 / 3) * (q[0] - cx), cy + (2 / 3) * (q[1] - cy)], c2: [x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y)], p: [x, y] });
        cx = x; cy = y; lastQ = q; lastC = null;
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
        const x = ox + num(), y = oy + num();
        out.push(...arcToCubics(cx, cy, rx, ry, rot, !!large, !!sweep, x, y));
        cx = x; cy = y; lastC = lastQ = null;
        break;
      }
      case 'Z': out.push({ op: 'Z' }); cx = sx; cy = sy; lastC = lastQ = null; break;
      default: i++;
    }
    // Numbers that follow repeat the current command (handled by the loop);
    // a stray token after Z is skipped.
    if (C === 'Z' && isNum()) i++;
  }
  return out;
}

/** SVG elliptical arc to cubic Bezier segments (W3C endpoint parameterisation). */
export function arcToCubics(x1: number, y1: number, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): Seg[] {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [{ op: 'L', p: [x2, y2] }];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (rotDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)));
  const step = dt / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const pt = (t: number): [number, number] => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const der = (t: number): [number, number] => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  const out: Seg[] = [];
  for (let i = 0; i < n; i++) {
    const a = t1 + i * step, b = a + step;
    const p0 = pt(a), p3 = pt(b), d0 = der(a), d3 = der(b);
    out.push({ op: 'C', c1: [p0[0] + k * d0[0], p0[1] + k * d0[1]], c2: [p3[0] - k * d3[0], p3[1] - k * d3[1]], p: i === n - 1 ? [x2, y2] : p3 });
  }
  return out;
}

export interface StrokeStyle {
  width: number;
  dash?: number[];
  gray?: number;
}

/** A single-page vector PDF. */
export class PdfPage {
  private ops: string[] = [];

  constructor(readonly widthMm: number, readonly heightMm: number) {}

  private x(v: number) { return (v * PT).toFixed(3); }
  private y(v: number) { return ((this.heightMm - v) * PT).toFixed(3); }

  private style(s: StrokeStyle) {
    this.ops.push(`${(s.width * PT).toFixed(3)} w`, `[${(s.dash ?? []).map((d) => (d * PT).toFixed(2)).join(' ')}] 0 d`, `${(s.gray ?? 0).toFixed(3)} G`, '1 J 1 j');
  }

  /** Strokes SVG path data transformed by sheet = (x * s + tx, y * s + ty). */
  path(d: string, tx: number, ty: number, s: number, style: StrokeStyle) {
    const segs = parseSvgPath(d);
    if (!segs.length) return;
    this.style(style);
    const X = (v: number) => this.x(v * s + tx), Y = (v: number) => this.y(v * s + ty);
    for (const g of segs) {
      if (g.op === 'M') this.ops.push(`${X(g.p[0])} ${Y(g.p[1])} m`);
      else if (g.op === 'L') this.ops.push(`${X(g.p[0])} ${Y(g.p[1])} l`);
      else if (g.op === 'C') this.ops.push(`${X(g.c1[0])} ${Y(g.c1[1])} ${X(g.c2[0])} ${Y(g.c2[1])} ${X(g.p[0])} ${Y(g.p[1])} c`);
      else this.ops.push('h');
    }
    this.ops.push('S');
  }

  line(x1: number, y1: number, x2: number, y2: number, style: StrokeStyle) {
    this.style(style);
    this.ops.push(`${this.x(x1)} ${this.y(y1)} m ${this.x(x2)} ${this.y(y2)} l S`);
  }

  rect(x: number, y: number, w: number, h: number, style: StrokeStyle) {
    this.style(style);
    this.ops.push(`${this.x(x)} ${this.y(y + h)} ${(w * PT).toFixed(3)} ${(h * PT).toFixed(3)} re S`);
  }

  /** Filled triangle (arrowheads). */
  triangle(a: [number, number], b: [number, number], c: [number, number]) {
    this.ops.push('0 g', `${this.x(a[0])} ${this.y(a[1])} m ${this.x(b[0])} ${this.y(b[1])} l ${this.x(c[0])} ${this.y(c[1])} l h f`);
  }

  /** Text with its baseline at (x, y); anchor start, middle or end. */
  text(str: string, x: number, y: number, sizeMm: number, opts: { bold?: boolean; anchor?: 'start' | 'middle' | 'end'; rotate?: number } = {}) {
    const size = sizeMm * PT;
    const w = textWidth(str, sizeMm, opts.bold);
    const dx = opts.anchor === 'middle' ? -w / 2 : opts.anchor === 'end' ? -w : 0;
    const esc = pdfString(str);
    const font = opts.bold ? '/F2' : '/F1';
    if (opts.rotate) {
      const r = (opts.rotate * Math.PI) / 180;
      const c = Math.cos(r), s = Math.sin(r);
      const px = x + dx * c, py = y - dx * s;
      this.ops.push('0 g', 'BT', `${font} ${size.toFixed(2)} Tf`, `${c.toFixed(4)} ${s.toFixed(4)} ${(-s).toFixed(4)} ${c.toFixed(4)} ${this.x(px)} ${this.y(py)} Tm`, `(${esc}) Tj`, 'ET');
    } else this.ops.push('0 g', 'BT', `${font} ${size.toFixed(2)} Tf`, `${this.x(x + dx)} ${this.y(y)} Td`, `(${esc}) Tj`, 'ET');
  }

  /** Serialises the document. */
  build(title = 'Drawing'): Uint8Array {
    const content = this.ops.join('\n');
    const objs: string[] = [];
    objs.push('<< /Type /Catalog /Pages 2 0 R >>');
    objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${(this.widthMm * PT).toFixed(2)} ${(this.heightMm * PT).toFixed(2)}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`);
    objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    objs.push(`<< /Title ${pdfTextString(title)} /Producer (Parametric) >>`);
    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${objs.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(out);
  }
}
