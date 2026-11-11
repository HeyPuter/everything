import { describe, it, expect } from 'vitest';
import { writePDF, PDFWriter, pdfNum, pdfText, subtractOver } from '../src/features/io/pdf.js';
import { createZip, crc32 } from '../src/features/io/zip.js';
import { parseRange, pdfBleed } from '../src/features/io/jobs.js';
import { safeFileName } from '../src/features/io/deliver.js';
import { imageSize, dataUrlToBytes, jpegInfo } from '../src/features/io/image-info.js';
import { normalizeSubpaths, normalizeTextOutlines, RecordingPath2D } from '../src/features/io/outlines.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createCompound, createGroup, createText } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { inflateSync, inflateRawSync } from 'node:zlib';

const latin1 = (bytes) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');

/** Check the xref table: every in-use entry points at "n 0 obj". */
function validatePdf(bytes) {
  const s = latin1(bytes);
  expect(s.startsWith('%PDF-1.7')).toBe(true);
  expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
  const sx = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(s);
  expect(sx).toBeTruthy();
  const xrefAt = Number(sx[1]);
  expect(s.slice(xrefAt, xrefAt + 4)).toBe('xref');
  const head = /xref\n0 (\d+)\n/.exec(s.slice(xrefAt));
  const count = Number(head[1]);
  const table = s.slice(xrefAt + head[0].length);
  for (let i = 0; i < count; i++) {
    const entry = table.slice(i * 20, i * 20 + 20);
    expect(entry).toHaveLength(20);
    expect(entry.endsWith(' \n') || entry.endsWith('\r\n')).toBe(true);
    if (i === 0) {
      expect(entry.slice(17, 18)).toBe('f');
      continue;
    }
    const off = Number(entry.slice(0, 10));
    expect(s.slice(off, off + `${i} 0 obj`.length)).toBe(`${i} 0 obj`);
  }
  const trailer = /trailer\s*<<([\s\S]*?)>>/.exec(s)[1];
  expect(trailer).toContain(`/Size ${count}`);
  // Stream lengths match.
  const re = /\/Length (\d+) >>\nstream\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    expect(s.slice(start + Number(m[1]), start + Number(m[1]) + 10)).toBe('\nendstream');
  }
  return s;
}

/** Decompressed content of every stream. */
function streams(bytes) {
  const s = latin1(bytes);
  const out = [];
  const re = /<<([^]*?)\/Length (\d+) >>\nstream\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const raw = bytes.subarray(start, start + Number(m[2]));
    out.push({ dict: m[1], data: /FlateDecode/.test(m[1]) ? latin1(inflateSync(raw)) : latin1(raw) });
  }
  return out;
}

function sampleDoc() {
  const doc = VDocument.create({ width: 300, height: 200, artboards: 2 });
  const layer = doc.layers()[0].id;
  doc.transact('build', () => {
    doc.insert(createPath(rectangle(10, 10, 100, 50), true, { fill: { type: 'solid', color: '#ff0000' }, stroke: { type: 'solid', color: '#0000ff' }, strokeWidth: 4, strokeJoin: 'round', strokeCap: 'square', dash: [5, 3], opacity: 0.5 }), layer);
    doc.insert(createPath(ellipse(150, 20, 80, 80), true, { fill: { type: 'linear', angle: 45, stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 0.5, color: '#00ff00', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }] }, stroke: { type: 'radial', stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 1 }] }, strokeWidth: 3 }), layer);
    const kids = [createPath(rectangle(10, 100, 50, 50), true), createPath(rectangle(20, 110, 30, 30), true)];
    doc.insert(createCompound(kids.map((k) => k.id), { fill: { type: 'solid', color: '#00aa00' }, stroke: null }, { fillRule: 'evenodd' }), layer, Infinity, kids);
    const inner = createPath(rectangle(100, 100, 80, 80), true, { fill: { type: 'solid', color: '#333333' }, stroke: null });
    const mask = createPath(ellipse(100, 100, 60, 60), true, { fill: null, stroke: null });
    const clip = createGroup([inner.id, mask.id], { clip: true });
    doc.insert(createGroup([clip.id], { opacity: 0.7, blendMode: 'multiply' }), layer, Infinity, [clip, inner, mask]);
    doc.insert(createText('Hello (PDF) \\ café', 20, 180), layer);
    // Something on the second artboard.
    doc.insert(createPath(rectangle(330, 20, 40, 40), true, { fill: { type: 'solid', color: '#123456' }, stroke: null }), layer);
  });
  doc.repairParents();
  return doc;
}

describe('PDF export', () => {
  it('formats numbers and strings', () => {
    expect(pdfNum(1.23456789)).toBe('1.2346');
    expect(pdfNum(-0.00001)).toBe('0');
    expect(pdfNum(10)).toBe('10');
    expect(pdfText('a(b)')).toBe('(a\\(b\\))');
    expect(pdfText('é✓')).toMatch(/^<FEFF/);
  });

  it('writes a structurally valid file with correct xref offsets', async () => {
    const w = new PDFWriter({ compress: false });
    const root = w.alloc();
    const pages = w.add('<< /Type /Pages /Kids [] /Count 0 >>');
    w.set(root, `<< /Type /Catalog /Pages ${pages} 0 R >>`);
    w.addStream('', 'q Q');
    validatePdf(await w.build({ root }));
  });

  it('renders artboards as pages with vector content', async () => {
    const doc = sampleDoc();
    const { bytes, warnings } = await writePDF(doc, doc.artboards, { title: 'Test' });
    const s = validatePdf(bytes);
    expect(s).toContain('/Count 2');
    expect(s).toContain('/MediaBox [0 0 300 200]');
    expect(s).toMatch(/\/ShadingType 2/);
    expect(s).toMatch(/\/ShadingType 3/);
    expect(s).toMatch(/\/FunctionType 3/);
    expect(s).toMatch(/\/BM \/Multiply/);
    expect(s).toMatch(/\/S \/Transparency/);
    expect(s).toMatch(/\/BaseFont \/Helvetica/);
    expect(s).toContain('/Title (Test)');
    const content = streams(bytes).map((x) => x.data).join('\n');
    expect(content).toContain('1 0 0 -1 0 200 cm'); // flip to document space
    expect(content).toMatch(/\[5 3\] 0 d/);
    expect(content).toMatch(/2 J 1 j/);
    expect(content).toMatch(/\nf\*\n/); // even-odd compound fill
    expect(content).toMatch(/W n\n/); // clip group
    expect(content).toContain('(Hello \\(PDF\\) \\\\ caf\\351) Tj');
    // Page 2 is shifted to its own artboard.
    expect(content).toContain('1 0 0 -1 -320 200 cm');
    expect(Array.isArray(warnings)).toBe(true);
  });

  it('adds bleed boxes and uses text outlines when given', async () => {
    const doc = sampleDoc();
    const text = doc.leaves().find((n) => n.type === 'text');
    const outlines = new Map([[text.id, normalizeTextOutlines([{ index: 0, fill: { type: 'solid', color: '#000000' }, stroke: null, strokeWidth: 0, contours: [{ anchors: rectangle(20, 170, 30, 10), closed: true }] }], text)]]);
    const { bytes } = await writePDF(doc, [doc.artboards[0]], { bleed: 9, outlines });
    const s = validatePdf(bytes);
    expect(s).toContain('/MediaBox [0 0 318 218]');
    expect(s).toContain('/TrimBox [9 9 309 209]');
    expect(s).not.toMatch(/\/Helvetica/);
  });
});

describe('clip groups in PDF export', () => {
  it('keeps the alignment of a clipping path\'s stroke', async () => {
    const doc = VDocument.create({ width: 120, height: 120 });
    const layer = doc.layers()[0].id;
    const content = createPath(rectangle(0, 0, 120, 120), true, { fill: { type: 'solid', color: '#ff0000' }, stroke: null });
    const mask = createPath(ellipse(20, 20, 80, 80), true, { fill: null, stroke: { type: 'solid', color: '#0000ff' }, strokeWidth: 10, strokeAlign: 'inside' });
    doc.transact('build', () => doc.insert(createGroup([content.id, mask.id], { clip: true }), layer, Infinity, [content, mask]));
    doc.repairParents();
    const { bytes } = await writePDF(doc, [doc.artboards[0]], { compress: false });
    const page = streams(bytes).find((st) => /0 0 1 RG/.test(st.data)).data;
    // An inside stroke is a double-width stroke inside a clip to the shape (a centered 10pt stroke would spill outside).
    expect(page).toMatch(/W n\n20 w [^]*0 0 1 RG/);
    expect(page).not.toMatch(/\n10 w /);
  });
});

describe('transparency groups in PDF export', () => {
  it('writes Isolate Blending and Knockout Group groups as isolated and knockout transparency groups', async () => {
    const doc = VDocument.create({ width: 120, height: 120 });
    const layer = doc.layers()[0].id;
    const kids = (color) => [createPath(rectangle(10, 10, 70, 70), true, { fill: { type: 'solid', color: '#ffff00' }, stroke: null }), createPath(rectangle(40, 40, 70, 70), true, { fill: { type: 'solid', color }, stroke: null, blendMode: 'multiply', opacity: 0.6 })];
    const a = kids('#00ffff');
    const b = kids('#ff00ff');
    const c = kids('#00ff00');
    doc.transact('build', () => {
      doc.insert(createGroup(a.map((k) => k.id), { isolate: true }), layer, Infinity, a);
      doc.insert(createGroup(b.map((k) => k.id), { knockout: true }), layer, Infinity, b);
      doc.insert(createGroup(c.map((k) => k.id)), layer, Infinity, c);
    });
    doc.repairParents();
    const { bytes } = await writePDF(doc, [doc.artboards[0]], { compress: false });
    const forms = streams(bytes).filter((st) => /\/Subtype \/Form/.test(st.dict));
    const form = (color) => forms.find((f) => f.data.includes(color));
    // The multiply blends only with the group's own contents.
    expect(form('0 1 1 rg').dict).toMatch(/\/Group << \/S \/Transparency [^>]*\/I true >>/);
    expect(form('1 0 1 rg').dict).toMatch(/\/I true \/K true >>/);
    // A plain group stays inline.
    expect(form('0 1 0 rg')).toBeUndefined();
  });
});

describe('document bleed in PDF export', () => {
  it('uses the document bleed per side with Use Document Bleed Settings', async () => {
    const doc = sampleDoc();
    doc.transact('Bleed', () => doc.updateRoot({ bleed: { top: 9, bottom: 18, left: 3, right: 6 } }));
    expect(pdfBleed(doc, {})).toBe(0);
    expect(pdfBleed(doc, { useDocBleed: true, bleed: 1 })).toEqual({ top: 9, bottom: 18, left: 3, right: 6 });
    expect(pdfBleed(doc, { useDocBleed: false, bleed: 4 })).toBe(4);
    const { bytes } = await writePDF(doc, [doc.artboards[0]], { bleed: pdfBleed(doc, { useDocBleed: true }) });
    const s = validatePdf(bytes);
    expect(s).toContain('/MediaBox [0 0 309 227]');
    expect(s).toContain('/TrimBox [3 18 303 218]');
    expect(s).toContain('/BleedBox [0 0 309 227]');
  });
});

describe('effects in PDF export', () => {
  it('recovers what lies under a partly transparent object', () => {
    // A 50% black shadow under a 50% red object: all = red over shadow.
    const shadow = [0, 0, 0, 128];
    const obj = [255, 0, 0, 128];
    const a = obj[3] / 255;
    const sa = shadow[3] / 255;
    const outA = a + sa * (1 - a);
    const all = [Math.round(((255 * a) + 0) / outA), 0, 0, Math.round(outA * 255)];
    const px = (...p) => new Uint8ClampedArray(p.flat());
    const s = subtractOver(px(all, [0, 0, 0, 255], [10, 20, 30, 200]), px(obj, [0, 0, 0, 255], [0, 0, 0, 0]));
    expect(Math.abs(s[3] - 128)).toBeLessThanOrEqual(2);
    expect(s[0]).toBeLessThanOrEqual(3);
    // Fully covered: nothing underneath is needed.
    expect(s[7]).toBe(0);
    // Uncovered: unchanged.
    expect([...s.slice(8)]).toEqual([10, 20, 30, 200]);
  });

  it('reports effects it cannot rasterize', async () => {
    const doc = sampleDoc();
    const p = doc.leaves().find((n) => n.type === 'path');
    doc.transact('fx', () => doc.update(p.id, { effects: [{ type: 'dropShadow', mode: 'multiply', opacity: 0.75, x: 7, y: 7, blur: 5, color: '#000000' }] }));
    const { bytes, warnings } = await writePDF(doc, [doc.artboards[0]], {});
    validatePdf(bytes);
    // jsdom cannot render pixels, so the object stays vector and the user is told.
    expect(warnings.join(' ')).toMatch(/could not be included/);
  });
});

describe('zip writer', () => {
  it('computes CRC-32', () => {
    expect(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });

  it('writes stored and deflated entries that unzip', async () => {
    const text = 'hello '.repeat(200);
    const blob = await createZip([
      { name: 'a.txt', data: text },
      { name: 'b.png', data: new Uint8Array([1, 2, 3]) },
      { name: 'a.txt', data: 'dup' },
    ]);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    const eocd = buf.length - 22;
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 10, true)).toBe(3);
    let cd = dv.getUint32(eocd + 16, true);
    const names = [];
    for (let i = 0; i < 3; i++) {
      expect(dv.getUint32(cd, true)).toBe(0x02014b50);
      const method = dv.getUint16(cd + 10, true);
      const crc = dv.getUint32(cd + 16, true);
      const csize = dv.getUint32(cd + 20, true);
      const nlen = dv.getUint16(cd + 28, true);
      const off = dv.getUint32(cd + 42, true);
      const name = new TextDecoder().decode(buf.subarray(cd + 46, cd + 46 + nlen));
      names.push(name);
      expect(dv.getUint32(off, true)).toBe(0x04034b50);
      const lnlen = dv.getUint16(off + 26, true);
      const data = buf.subarray(off + 30 + lnlen, off + 30 + lnlen + csize);
      const raw = method === 8 ? new Uint8Array(inflateRawSync(data)) : data;
      expect(crc32(raw)).toBe(crc);
      if (name === 'a.txt') {
        expect(new TextDecoder().decode(raw)).toBe(text);
        if (typeof CompressionStream !== 'undefined') expect(method).toBe(8);
      }
      cd += 46 + nlen;
    }
    expect(names).toEqual(['a.txt', 'b.png', 'a-2.txt']);
  });
});

describe('helpers', () => {
  it('parses artboard ranges', () => {
    expect(parseRange('1-3, 5', 5)).toEqual([0, 1, 2, 4]);
    expect(parseRange('3-1', 3)).toEqual([0, 1, 2]);
    expect(parseRange('6', 5)).toBe(null);
    expect(parseRange('x', 5)).toBe(null);
  });

  it('sanitizes file names', () => {
    expect(safeFileName('a/b:c?.svg')).toBe('a-b-c-.svg');
    expect(safeFileName('   ')).toBe('Untitled');
  });

  it('reads image sizes from headers', () => {
    const png = dataUrlToBytes('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
    expect(imageSize(png.bytes)).toEqual({ width: 1, height: 1 });
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 3, 0, 0, 0, 0]);
    expect(jpegInfo(jpg)).toMatchObject({ width: 30, height: 20, components: 3 });
  });

  it('normalizes outline results and records Path2D calls', () => {
    expect(normalizeSubpaths('M0 0L10 0L10 10Z')[0].anchors).toHaveLength(3);
    expect(normalizeSubpaths({ paths: [{ anchors: rectangle(0, 0, 1, 1), closed: true }] })).toHaveLength(1);
    const p = new RecordingPath2D();
    p.moveTo(0, 0);
    p.lineTo(10, 0);
    p.lineTo(5, 5);
    p.closePath();
    p.arc(20, 20, 5, 0, Math.PI * 2);
    const subs = p.subpaths();
    expect(subs[0].closed).toBe(true);
    expect(subs[0].anchors).toHaveLength(3);
    expect(subs[1].anchors.length).toBeGreaterThan(3);
  });
});

describe('delivering exports to Puter', () => {
  it('treats a cancelled Puter picker as cancelled instead of waiting forever', async () => {
    const { deliverFiles } = await import('../src/features/io/deliver.js');
    const never = new Promise(() => {});
    never.undefinedOnCancel = Promise.resolve(undefined);
    const app = { user: { username: 'u' }, puter: { ui: { showSaveFilePicker: () => never } } };
    const r = await deliverFiles(app, [{ name: 'a.svg', blob: new Blob(['x']) }], { dest: 'puter' });
    expect(r).toBe(null);
  });
});

describe('printing', () => {
  it('prints each artboard on a page of its own size', async () => {
    const { buildPrintRoot, pageRules } = await import('../src/features/io/print.js');
    const doc = VDocument.create({ name: 'P', width: 400, height: 300 });
    doc.transact('AB', () => doc.updateRoot({ artboards: [...doc.artboards, { id: 'b', name: 'Two', x: 450, y: 0, w: 200, h: 100 }] }));
    const css = pageRules(doc, [0, 1]);
    expect(css).toContain('@page vs-artboard-1 { size: 200pt 100pt; margin: 0; }');
    expect(css).toContain('@page { size: 400pt 300pt; margin: 0; }');
    const root = buildPrintRoot(doc, [0, 1]);
    expect([...root.children].map((p) => p.style.page)).toEqual(['vs-artboard-0', 'vs-artboard-1']);
  });
});
