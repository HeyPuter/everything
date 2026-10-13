// Small generated fixtures for the interop tests: PDF files built from object bodies.
import { deflateSync } from 'node:zlib';

export const enc = (s) => new Uint8Array(Buffer.from(s, 'latin1'));

function cat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Build a PDF. `objects` is a list (object 1 first) of strings (bodies) or
 * { dict: '<< ... >>' (without Length), stream: string|Uint8Array, flate: bool }.
 * Options: { root: 1, xrefStream: false, info: null, trailer: '' (extra trailer entries), header }
 */
export function buildPDF(objects, { root = 1, xrefStream = false, trailer = '', header = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', brokenXref = false } = {}) {
  const parts = [enc(header)];
  let pos = parts[0].length;
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(pos);
    let chunk;
    if (typeof o === 'string') chunk = enc(`${i + 1} 0 obj\n${o}\nendobj\n`);
    else {
      let data = typeof o.stream === 'string' ? enc(o.stream) : o.stream;
      let dict = o.dict.replace(/>>\s*$/, '');
      if (o.flate) {
        data = new Uint8Array(deflateSync(Buffer.from(data)));
        dict += ' /Filter /FlateDecode';
      }
      chunk = cat([enc(`${i + 1} 0 obj\n${dict} /Length ${data.length} >>\nstream\n`), data, enc('\nendstream\nendobj\n')]);
    }
    parts.push(chunk);
    pos += chunk.length;
  });
  const size = objects.length + 1;
  if (xrefStream) {
    const rows = [];
    rows.push([0, 0, 255]);
    for (let i = 1; i < size; i++) rows.push([1, offsets[i], 0]);
    const xrefOffset = pos;
    rows.push([1, xrefOffset, 0]);
    const raw = new Uint8Array(rows.length * 6);
    rows.forEach((r, i) => {
      raw[i * 6] = r[0];
      raw[i * 6 + 1] = (r[1] >>> 24) & 255;
      raw[i * 6 + 2] = (r[1] >>> 16) & 255;
      raw[i * 6 + 3] = (r[1] >>> 8) & 255;
      raw[i * 6 + 4] = r[1] & 255;
      raw[i * 6 + 5] = r[2];
    });
    const data = new Uint8Array(deflateSync(Buffer.from(raw)));
    parts.push(enc(`${size} 0 obj\n<< /Type /XRef /Size ${size + 1} /W [1 4 1] /Root ${root} 0 R /Filter /FlateDecode /Length ${data.length} ${trailer} >>\nstream\n`), data, enc(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`));
    return cat(parts);
  }
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) xref += `${String(brokenXref ? offsets[i] + 7 : offsets[i]).padStart(10, '0')} 00000 n \n`;
  parts.push(enc(`${xref}trailer\n<< /Size ${size} /Root ${root} 0 R ${trailer} >>\nstartxref\n${pos}\n%%EOF\n`));
  return cat(parts);
}

/** A one-page PDF with the given content stream and resources (a dictionary string). */
export function onePage(content, { resources = '<< >>', media = '[0 0 200 100]', extra = [], pageExtra = '', flate = false, catalogExtra = '' } = {}) {
  const objs = [
    `<< /Type /Catalog /Pages 2 0 R ${catalogExtra} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox ${media} /Resources ${resources} /Contents 4 0 R ${pageExtra} >>`,
    { dict: '<< >>', stream: content, flate },
    ...extra,
  ];
  return buildPDF(objs);
}

/** Leaves of an imported document (not root, layers or groups). */
export function leaves(doc) {
  return [...doc.nodes.values()].filter((n) => n.type !== 'root' && n.type !== 'layer' && n.type !== 'group' && !(n.type === 'path' && doc.get(n.parent)?.type === 'compound'));
}

/** The node tree as a compact string: type[flags](children). */
export function tree(doc, id = 'root') {
  const n = doc.get(id);
  if (!n) return '';
  let s = n.type;
  if (n.clip) s += '!clip';
  if (n.opacityMask) s += '!mask';
  if (n.children?.length) s += `(${n.children.map((c) => tree(doc, c)).join(',')})`;
  return s;
}
