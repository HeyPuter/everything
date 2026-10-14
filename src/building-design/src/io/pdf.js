/**
 * Minimal PDF writer: vector paths, filled polygons, text in the standard
 * Helvetica font, and JPEG images. Coordinates are in millimetres from the
 * bottom-left of the page.
 */
const MM = 72 / 25.4;

function n(v) {
  return (Math.round(v * 1000) / 1000).toString();
}

/** WinAnsi-encoded literal string. */
function pdfString(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    let b = c < 256 ? c : 63;
    if (ch === '–' || ch === '—') b = 45;
    if (b === 40 || b === 41 || b === 92) out += `\\${String.fromCharCode(b)}`;
    else if (b < 32 || b > 126) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(b);
  }
  return `(${out})`;
}

export class PdfPage {
  constructor(wMM, hMM) {
    this.w = wMM;
    this.h = hMM;
    this.ops = [];
    this.images = [];
  }

  color(rgb, stroke = true) {
    this.ops.push(`${n(rgb[0])} ${n(rgb[1])} ${n(rgb[2])} ${stroke ? 'RG' : 'rg'}`);
  }

  lineWidth(mm) {
    this.ops.push(`${n(mm * MM)} w`);
  }

  dash(pattern) {
    this.ops.push(pattern?.length ? `[${pattern.map((x) => n(x * MM)).join(' ')}] 0 d` : '[] 0 d');
  }

  line(a, b) {
    this.ops.push(`${n(a[0] * MM)} ${n(a[1] * MM)} m ${n(b[0] * MM)} ${n(b[1] * MM)} l S`);
  }

  polygon(pts, holes = [], fill = true, stroke = false) {
    const loop = (p) => p.map((q, i) => `${n(q[0] * MM)} ${n(q[1] * MM)} ${i ? 'l' : 'm'}`).join(' ') + ' h';
    this.ops.push([loop(pts), ...holes.map(loop)].join(' ') + (fill && stroke ? ' B*' : fill ? ' f*' : ' S'));
  }

  alpha(a) {
    const key = `GS${Math.round(a * 100)}`;
    this.gstates = this.gstates || new Map();
    this.gstates.set(key, a);
    this.ops.push(`/${key} gs`);
  }

  text(at, str, sizeMM, rot = 0, align = 'left', bold = false) {
    const s = sizeMM * MM;
    const w = approxWidth(str, s);
    const dx = align === 'center' ? -w / 2 : align === 'right' ? -w : 0;
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    const x = at[0] * MM + dx * c - (-s * 0.35) * sn;
    const y = at[1] * MM + dx * sn + (-s * 0.35) * c;
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${n(s)} Tf ${n(c)} ${n(sn)} ${n(-sn)} ${n(c)} ${n(x)} ${n(y)} Tm ${pdfString(str)} Tj ET`);
  }

  /** JPEG bytes placed in a rectangle (mm). */
  image(jpeg, wPx, hPx, x, y, w, h) {
    const name = `Im${this.images.length + 1}`;
    this.images.push({ name, jpeg, wPx, hPx });
    this.ops.push(`q ${n(w * MM)} 0 0 ${n(h * MM)} ${n(x * MM)} ${n(y * MM)} cm /${name} Do Q`);
  }
}

function approxWidth(str, size) {
  // Helvetica average glyph width.
  let w = 0;
  for (const ch of String(str)) w += /[il.,:;'|!]/.test(ch) ? 0.28 : /[mwMW]/.test(ch) ? 0.85 : /[A-Z0-9]/.test(ch) ? 0.66 : 0.55;
  return w * size;
}

export function buildPdf(pages, title = 'Drawing') {
  const objs = [];
  const add = (body) => {
    objs.push(body);
    return objs.length;
  };
  const enc = new TextEncoder();
  const font1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const font2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pagesId = objs.length + 1;
  objs.push(null);
  const pageIds = [];
  for (const p of pages) {
    const xo = [];
    for (const im of p.images) {
      const id = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${im.wPx} /Height ${im.hPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpeg.length} >>`, bytes: im.jpeg });
      xo.push(`/${im.name} ${id} 0 R`);
    }
    const gs = p.gstates ? [...p.gstates].map(([k, a]) => `/${k} << /Type /ExtGState /ca ${n(a)} /CA ${n(a)} >>`).join(' ') : '';
    const content = enc.encode(p.ops.join('\n'));
    const cid = add({ dict: `<< /Length ${content.length} >>`, bytes: content });
    const res = `<< /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >>${xo.length ? ` /XObject << ${xo.join(' ')} >>` : ''}${gs ? ` /ExtGState << ${gs} >>` : ''} >>`;
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(p.w * MM)} ${n(p.h * MM)}] /Resources ${res} /Contents ${cid} 0 R >>`));
  }
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const info = add(`<< /Title ${pdfString(title)} /Producer (Building Design) >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const chunks = [enc.encode('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  let offset = chunks[0].length;
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(offset);
    let part;
    if (typeof o === 'string') part = [enc.encode(`${i + 1} 0 obj\n${o}\nendobj\n`)];
    else part = [enc.encode(`${i + 1} 0 obj\n${o.dict}\nstream\n`), o.bytes, enc.encode('\nendstream\nendobj\n')];
    for (const c of part) {
      chunks.push(c);
      offset += c.length;
    }
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  chunks.push(enc.encode(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return new Blob(chunks, { type: 'application/pdf' });
}
