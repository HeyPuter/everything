// Vector export of grease pencil drawings: strokes (and fills) projected through the camera (or
// the active viewport) and written as SVG or PDF. The writers are pure (unit tested); collecting
// the strokes reads the evaluated scene.

export type RGBA = [number, number, number, number];

export interface ExportPath {
  /** pixels, y down */
  pts: [number, number][];
  /** stroke width per point (pixels) */
  widths: number[];
  /** sRGB colour + opacity of the line, or null */
  stroke: RGBA | null;
  cyclic: boolean;
}

export interface ExportFill {
  /** rings (pixels); several rings fill even-odd (holes) */
  rings: [number, number][][];
  color: RGBA;
}

/** Drawing items in order: fills and lines interleave as they are stacked. */
export type ExportItem = { kind: 'stroke'; path: ExportPath } | { kind: 'fill'; fill: ExportFill };

export interface ExportLayer {
  name: string;
  items: ExportItem[];
}

export interface ExportObject {
  name: string;
  layers: ExportLayer[];
}

export interface WriteOptions {
  /** constant line width (average of the points) instead of filled outlines */
  uniformWidth: boolean;
  /** clip the drawing to the page */
  clip?: boolean;
  /** include fills */
  fill?: boolean;
}

const f2 = (x: number) => (Math.round(x * 100) / 100).toString();
const hex = (c: RGBA) =>
  '#' +
  [0, 1, 2]
    .map((i) =>
      Math.round(Math.max(0, Math.min(1, c[i])) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlId = (s: string) => esc(s.replace(/\s+/g, '_'));

/** Closed outline of a variable-width polyline (round ends), as one or two rings. */
export function strokeOutline(p: ExportPath): [number, number][][] {
  const n = p.pts.length;
  if (n < 2) {
    // a dot
    const [x, y] = p.pts[0];
    const r = (p.widths[0] ?? 1) / 2;
    return [Array.from({ length: 12 }, (_, k) => [x + r * Math.cos((k / 12) * Math.PI * 2), y + r * Math.sin((k / 12) * Math.PI * 2)] as [number, number])];
  }
  const normal = (i: number): [number, number] => {
    const a = p.pts[p.cyclic ? (i - 1 + n) % n : Math.max(0, i - 1)],
      b = p.pts[p.cyclic ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0],
      dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  };
  const left: [number, number][] = [],
    right: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const [nx, ny] = normal(i);
    const h = (p.widths[i] ?? 1) / 2;
    left.push([p.pts[i][0] + nx * h, p.pts[i][1] + ny * h]);
    right.push([p.pts[i][0] - nx * h, p.pts[i][1] - ny * h]);
  }
  if (p.cyclic) return [left, right.reverse()];
  const cap = (c: [number, number], from: [number, number], r: number): [number, number][] => {
    const a0 = Math.atan2(from[1] - c[1], from[0] - c[0]);
    const out: [number, number][] = [];
    for (let k = 1; k < 6; k++) {
      const a = a0 + (Math.PI * k) / 6;
      out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
    return out;
  };
  const ring: [number, number][] = [...left, ...cap(p.pts[n - 1], left[n - 1], (p.widths[n - 1] ?? 1) / 2), ...right.reverse(), ...cap(p.pts[0], right[right.length - 1], (p.widths[0] ?? 1) / 2)];
  return [ring];
}

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 1);
const ringPath = (r: [number, number][], close: boolean) => r.map((q, i) => `${i ? 'L' : 'M'}${f2(q[0])} ${f2(q[1])}`).join('') + (close ? 'Z' : '');

/** One SVG document. */
export function writeSvg(objects: ExportObject[], W: number, H: number, o: WriteOptions): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${f2(W)}" height="${f2(H)}" viewBox="0 0 ${f2(W)} ${f2(H)}">`);
  if (o.clip) lines.push(`<defs><clipPath id="frame"><rect x="0" y="0" width="${f2(W)}" height="${f2(H)}"/></clipPath></defs>`);
  for (const ob of objects) {
    lines.push(`<g id="${xmlId(ob.name)}"${o.clip ? ' clip-path="url(#frame)"' : ''}>`);
    for (const l of ob.layers) {
      lines.push(`<g id="${xmlId(`${ob.name}_${l.name}`)}">`);
      for (const it of l.items) {
        if (it.kind === 'fill') {
          if (o.fill === false) continue;
          const c = it.fill.color;
          lines.push(`<path d="${it.fill.rings.map((r) => ringPath(r, true)).join('')}" fill="${hex(c)}"${c[3] < 1 ? ` fill-opacity="${f2(c[3])}"` : ''} fill-rule="evenodd" stroke="none"/>`);
          continue;
        }
        const p = it.path;
        if (!p.stroke) continue;
        const c = p.stroke;
        if (o.uniformWidth) {
          lines.push(`<path d="${ringPath(p.pts, p.cyclic)}" fill="none" stroke="${hex(c)}"${c[3] < 1 ? ` stroke-opacity="${f2(c[3])}"` : ''} stroke-width="${f2(avg(p.widths))}" stroke-linecap="round" stroke-linejoin="round"/>`);
        } else {
          lines.push(`<path d="${strokeOutline(p).map((r) => ringPath(r, true)).join('')}" fill="${hex(c)}"${c[3] < 1 ? ` fill-opacity="${f2(c[3])}"` : ''} fill-rule="evenodd" stroke="none"/>`);
        }
      }
      lines.push('</g>');
    }
    lines.push('</g>');
  }
  lines.push('</svg>');
  return lines.join('\n');
}

/** A PDF with one page per frame (vector paths, opacity through graphics states). */
export function writePdf(pages: ExportObject[][], W: number, H: number, o: WriteOptions): Uint8Array {
  const alphas = new Map<string, number>();
  const gs = (kind: 'ca' | 'CA', a: number) => {
    const k = `${kind}${f2(a)}`;
    let i = alphas.get(k);
    if (i === undefined) alphas.set(k, (i = alphas.size));
    return `/GS${i} gs`;
  };
  const y = (v: number) => f2(H - v);
  const ring = (r: [number, number][], close: boolean) => r.map((q, i) => `${f2(q[0])} ${y(q[1])} ${i ? 'l' : 'm'}`).join('\n') + (close ? '\nh' : '');
  const rgb = (c: RGBA) => [0, 1, 2].map((i) => f2(Math.max(0, Math.min(1, c[i])))).join(' ');
  const contents = pages.map((objects) => {
    const ops: string[] = ['q'];
    if (o.clip) ops.push(`0 0 ${f2(W)} ${f2(H)} re W n`);
    for (const ob of objects)
      for (const l of ob.layers)
        for (const it of l.items) {
          if (it.kind === 'fill') {
            if (o.fill === false) continue;
            const c = it.fill.color;
            ops.push(`${gs('ca', c[3])} ${rgb(c)} rg`, it.fill.rings.map((r) => ring(r, true)).join('\n'), 'f*');
            continue;
          }
          const p = it.path;
          if (!p.stroke) continue;
          const c = p.stroke;
          if (o.uniformWidth) ops.push(`${gs('CA', c[3])} ${rgb(c)} RG ${f2(avg(p.widths))} w 1 J 1 j`, ring(p.pts, p.cyclic), 'S');
          else ops.push(`${gs('ca', c[3])} ${rgb(c)} rg`, strokeOutline(p).map((r) => ring(r, true)).join('\n'), 'f*');
        }
    ops.push('Q');
    return ops.join('\n');
  });
  // objects: 1 catalog, 2 pages, 3 resources, then page + content pairs
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const states = [...alphas.entries()].map(([k, i]) => `/GS${i} << /Type /ExtGState /${k.slice(0, 2)} ${k.slice(2)} >>`).join(' ');
  objs.push(`<< /ExtGState << ${states} >> >>`);
  contents.forEach((c, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f2(W)} ${f2(H)}] /Resources 3 0 R /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${new TextEncoder().encode(c).length} >>\nstream\n${c}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  const enc = new TextEncoder();
  let size = enc.encode(out).length;
  objs.forEach((body, i) => {
    offsets.push(size);
    const chunk = `${i + 1} 0 obj\n${body}\nendobj\n`;
    out += chunk;
    size += enc.encode(chunk).length;
  });
  const xref = size;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((x) => `${String(x).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return enc.encode(out);
}
