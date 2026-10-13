import { describe, it, expect } from 'vitest';
import { createHash, createCipheriv } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { buildPDF, onePage, leaves, tree, enc } from './interop-helpers.js';
import { pdfToDocument, pdfToNodes, pdfPages } from '../src/features/interop/pdf/import.js';
import { PDFDocument } from '../src/features/interop/pdf/document.js';
import { writePDF } from '../src/features/io/pdf.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createText } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { dataUrlToBytes } from '../src/features/io/image-info.js';

const FAMILIES = ['Inter', 'Roboto', 'Open Sans', 'Source Serif 4', 'Roboto Mono'];
const open = (bytes, opts = {}) => pdfToDocument(bytes, { families: FAMILIES, ...opts });

/** Decoded RGBA-ish rows of a PNG asset (8-bit RGB or RGBA, filter bytes removed). */
function pngPixels(dataUrl) {
  const { bytes } = dataUrlToBytes(dataUrl);
  expect(Array.from(bytes.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  const w = dv.getUint32(16);
  const h = dv.getUint32(20);
  const type = bytes[25];
  let p = 8;
  const idat = [];
  while (p < bytes.length) {
    const len = dv.getUint32(p);
    const t = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    if (t === 'IDAT') idat.push(bytes.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat.map((x) => Buffer.from(x))));
  const ch = type === 6 ? 4 : 3;
  const rows = [];
  for (let y = 0; y < h; y++) {
    const f = raw[y * (w * ch + 1)];
    const row = [];
    for (let i = 0; i < w * ch; i++) {
      let v = raw[y * (w * ch + 1) + 1 + i];
      if (f === 1 && i >= ch) v = (v + row[i - ch]) & 255;
      row.push(v);
    }
    rows.push(row);
  }
  return { w, h, ch, rows };
}

describe('PDF structure', () => {
  it('reads classic and stream cross-reference tables and lists pages', () => {
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 300 200] >>', '<< /Type /Page /Parent 2 0 R >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 50] /Rotate 90 >>'];
    for (const xrefStream of [false, true]) {
      const info = pdfPages(buildPDF(objs, { xrefStream }));
      expect(info.pages).toHaveLength(2);
      expect(info.pages[0].size).toEqual({ w: 300, h: 200 });
      expect(info.pages[1].size).toEqual({ w: 50, h: 100 });
    }
  });

  it('repairs a damaged cross-reference table', async () => {
    const bytes = onePage('1 0 0 rg 0 0 10 10 re f');
    const s = Buffer.from(bytes).toString('latin1').replace(/startxref\n\d+/, 'startxref\n999999');
    const doc = await open(enc(s));
    expect(leaves(doc)).toHaveLength(1);
    expect(doc.importWarnings.join(' ')).toMatch(/repaired/);
    // Offsets that point at the wrong place are found by scanning.
    const off = await open(buildPDF(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 50 50] /Contents 4 0 R >>', { dict: '<< >>', stream: '0 0 5 5 re f' }], { brokenXref: true }));
    expect(leaves(off)).toHaveLength(1);
  });

  it('reads objects from object streams', async () => {
    // Objects 2 and 3 live in object stream 5.
    const inner = '<< /Type /Pages /Kids [3 0 R] /Count 1 >> << /Type /Page /Parent 2 0 R /MediaBox [0 0 40 40] /Contents 4 0 R >>';
    const first = inner.indexOf('<< /Type /Page ');
    const header = `2 0 3 ${first} `;
    const objstm = header + inner;
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', 'null', 'null', { dict: '<< >>', stream: '0 0 1 rg 1 1 8 8 re f' }, { dict: `<< /Type /ObjStm /N 2 /First ${header.length} >>`, stream: objstm, flate: true }];
    // A cross-reference stream that maps 2 and 3 into the object stream.
    const parts = buildPDF(objs);
    const s = Buffer.from(parts).toString('latin1');
    const off = (n) => s.indexOf(`\n${n} 0 obj`) + 1;
    const rows = [[0, 0, 255], [1, off(1), 0], [2, 5, 0], [2, 5, 1], [1, off(4), 0], [1, off(5), 0]];
    const body = s.slice(0, s.indexOf('xref\n'));
    const xrefAt = body.length;
    rows.push([1, xrefAt, 0]);
    const raw = Buffer.alloc(rows.length * 6);
    rows.forEach((r, i) => {
      raw[i * 6] = r[0];
      raw.writeUInt32BE(r[1], i * 6 + 1);
      raw[i * 6 + 5] = r[2];
    });
    const data = deflateSync(raw);
    const full = Buffer.concat([Buffer.from(body, 'latin1'), Buffer.from(`6 0 obj\n<< /Type /XRef /Size 7 /W [1 4 1] /Root 1 0 R /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`, 'latin1')]);
    const doc = await open(new Uint8Array(full));
    const p = leaves(doc)[0];
    expect(p.fill.color).toBe('#0000ff');
    expect(doc.artboards[0]).toMatchObject({ w: 40, h: 40 });
  });

  it('decrypts files protected only by permissions (AES-128, empty user password)', async () => {
    const PAD = Buffer.from([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);
    const md5 = (b) => createHash('md5').update(b).digest();
    const rc4 = (key, data) => {
      const s = [...Array(256).keys()];
      for (let i = 0, j = 0; i < 256; i++) {
        j = (j + s[i] + key[i % key.length]) & 255;
        [s[i], s[j]] = [s[j], s[i]];
      }
      const out = Buffer.alloc(data.length);
      for (let k = 0, i = 0, j = 0; k < data.length; k++) {
        i = (i + 1) & 255;
        j = (j + s[i]) & 255;
        [s[i], s[j]] = [s[j], s[i]];
        out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
      }
      return out;
    };
    const id = Buffer.from('0123456789abcdef');
    const O = Buffer.alloc(32, 7);
    const P = -44;
    const pb = Buffer.alloc(4);
    pb.writeInt32LE(P);
    let key = md5(Buffer.concat([PAD, O, pb, id]));
    for (let i = 0; i < 50; i++) key = md5(key.subarray(0, 16));
    key = key.subarray(0, 16);
    let u = rc4(key, md5(Buffer.concat([PAD, id])));
    for (let i = 1; i <= 19; i++) u = rc4(Buffer.from(key.map((b) => b ^ i)), u);
    const U = Buffer.concat([u, Buffer.alloc(16)]);
    const objKey = (num) => md5(Buffer.concat([key, Buffer.from([num & 255, (num >> 8) & 255, 0, 0, 0]), Buffer.from('sAlT')])).subarray(0, 16);
    const aes = (num, data) => {
      const iv = Buffer.alloc(16, 3);
      const c = createCipheriv('aes-128-cbc', objKey(num), iv);
      return Buffer.concat([iv, c.update(data), c.final()]);
    };
    const hex = (b) => `<${b.toString('hex')}>`;
    const content = aes(4, Buffer.from('0 1 0 rg 0 0 20 20 re f'));
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 50 50] /Contents 4 0 R >>',
      { dict: '<< >>', stream: new Uint8Array(content) },
      `<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /Length 16 /AuthEvent /DocOpen >> >> /StmF /StdCF /StrF /StdCF /O ${hex(O)} /U ${hex(U)} /P ${P} >>`,
    ];
    const bytes = buildPDF(objs, { trailer: `/Encrypt 5 0 R /ID [${hex(id)} ${hex(id)}]` });
    const doc = await open(bytes);
    expect(leaves(doc)[0].fill.color).toBe('#00ff00');
  });

  it('refuses files that need a password', () => {
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R >>', `<< /Filter /Standard /V 2 /R 3 /Length 128 /O <${'00'.repeat(32)}> /U <${'11'.repeat(32)}> /P -4 >>`];
    expect(() => new PDFDocument(buildPDF(objs, { trailer: '/Encrypt 4 0 R /ID [<00> <00>]' }))).toThrow(/password/);
  });
});

describe('PDF paths and paint', () => {
  it('imports fills, strokes, dashes, caps, joins and fill rules', async () => {
    const doc = await open(onePage('q 1 0 0 rg 0 0 1 RG 4 w 1 J 1 j [6 3] 0 d 10 10 50 30 re B Q 0.5 g 70 10 m 120 10 l 95 60 l h f* 0 1 1 0 K 130 10 m 150 30 160 30 180 10 c S'));
    const [rect, tri, curve] = leaves(doc);
    expect(rect.fill).toEqual({ type: 'solid', color: '#ff0000' });
    expect(rect.stroke).toEqual({ type: 'solid', color: '#0000ff' });
    expect(rect).toMatchObject({ strokeWidth: 4, strokeCap: 'round', strokeJoin: 'round', dash: [6, 3], closed: true });
    // y is flipped: the rectangle spans y 60..90 on a 100 pt tall artboard.
    const ys = rect.anchors.map((a) => a.y).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(60);
    expect(ys[3]).toBeCloseTo(90);
    expect(tri).toMatchObject({ fillRule: 'evenodd', fill: { type: 'solid', color: '#808080' }, stroke: null });
    expect(tri.anchors).toHaveLength(3);
    expect(curve.fill).toBeNull();
    expect(curve.stroke.color).toBe('#ff0000');
    expect(curve.anchors[0]).toMatchObject({ x: 130, y: 90, ox: 150, oy: 70 });
    expect(curve.anchors[1]).toMatchObject({ x: 180, y: 90, ix: 160, iy: 70 });
  });

  it('turns several subpaths into a compound path', async () => {
    const doc = await open(onePage('0 0 0 rg 10 10 80 80 re 30 30 40 40 re f*'));
    const c = [...doc.nodes.values()].find((n) => n.type === 'compound');
    expect(c.fillRule).toBe('evenodd');
    expect(c.children).toHaveLength(2);
  });

  it('makes spot swatches for separation colors', async () => {
    const res = '<< /ColorSpace << /CS0 [/Separation /PANTONE#20Warm#20Red [/ICCBased 5 0 R] << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0.8 1 0] /N 1 >>] >> >>';
    const doc = await open(onePage('/CS0 cs 1 scn 0 0 10 10 re f /CS0 cs 0.5 scn 20 0 10 10 re f', { resources: res, extra: [{ dict: '<< /N 4 /Alternate /DeviceCMYK >>', stream: '' }] }));
    const sw = doc.root.swatches.find((s) => s.name === 'PANTONE Warm Red');
    expect(sw).toMatchObject({ spot: true, global: true });
    const [full, half] = leaves(doc);
    expect(full.fill.swatchId).toBe(sw.id);
    expect(full.fill.tint).toBeUndefined();
    expect(half.fill).toMatchObject({ swatchId: sw.id, tint: 0.5 });
    expect(sw.paint.color).toBe(full.fill.color);
  });

  it('converts Lab, indexed and ICC-based colors', async () => {
    const res = '<< /ColorSpace << /L [/Lab << /WhitePoint [0.9505 1 1.089] /Range [-128 127 -128 127] >>] /I [/Indexed /DeviceRGB 1 <00ff00ff0000>] >> >>';
    const doc = await open(onePage('/L cs 100 0 0 sc 0 0 5 5 re f /I cs 1 sc 10 0 5 5 re f', { resources: res }));
    const [lab, idx] = leaves(doc);
    expect(lab.fill.color).toBe('#ffffff');
    expect(idx.fill.color).toBe('#ff0000');
  });

  it('maps constant alpha and blend modes', async () => {
    const res = '<< /ExtGState << /G0 << /ca 0.5 /CA 0.25 /BM /Multiply >> >> >>';
    const doc = await open(onePage('/G0 gs 1 0 0 rg 0 0 1 RG 0 0 10 10 re B', { resources: res }));
    const p = leaves(doc)[0];
    expect(p.fill.opacity).toBe(0.5);
    expect(p.stroke.opacity).toBe(0.25);
    expect(p.blendMode).toBe('multiply');
  });

  it('turns axial and radial shadings into gradients', async () => {
    const fn = '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>';
    const res = `<< /Shading << /Sh0 << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] /Function ${fn} /Extend [true true] >> >> /Pattern << /P0 << /PatternType 2 /Shading << /ShadingType 3 /ColorSpace /DeviceRGB /Coords [60 50 0 50 50 40] /Function ${fn} >> >> >> >>`;
    const doc = await open(onePage('q 10 10 80 40 re W n /Sh0 sh Q /Pattern cs /P0 scn 110 10 80 80 re f', { resources: res, media: '[0 0 200 100]' }));
    const [lin, rad] = leaves(doc);
    // The shading painted inside a clip becomes the clipping path's own fill.
    expect(lin.type).toBe('path');
    expect(lin.fill).toMatchObject({ type: 'linear', x1: 0, y1: 100, x2: 100, y2: 100 });
    expect(lin.fill.stops.map((s) => s.color)).toEqual(['#ff0000', '#0000ff']);
    expect(rad.fill).toMatchObject({ type: 'radial', x1: 50, y1: 50, x2: 90, y2: 50 });
    expect(rad.fill.focal[0]).toBeCloseTo(0.25);
    expect(tree(doc)).toBe('root(layer(path,path))');
  });

  it('samples stitching functions into stops', async () => {
    const fn = '<< /FunctionType 3 /Domain [0 1] /Functions [<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> << /FunctionType 2 /Domain [0 1] /C0 [1] /C1 [0] /N 1 >>] /Bounds [0.3] /Encode [0 1 0 1] >>';
    const res = `<< /Shading << /S << /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 10 0] /Function ${fn} >> >> >>`;
    const doc = await open(onePage('q 0 0 10 10 re W n /S sh Q', { resources: res }));
    const g = leaves(doc)[0].fill;
    expect(g.stops.map((s) => [Math.round(s.offset * 10) / 10, s.color])).toEqual([[0, '#000000'], [0.3, '#ffffff'], [1, '#000000']]);
  });

  it('turns clipping paths into clip groups (and drops clips that clip nothing)', async () => {
    const doc = await open(onePage('q 0 0 50 50 re W n 1 0 0 rg 25 25 100 100 re f Q q 0 0 200 100 re W n 0 g 1 1 5 5 re f Q'));
    expect(tree(doc)).toBe('root(layer(group!clip(path,path),path))');
  });

  it('turns soft masks into opacity masks', async () => {
    const res = '<< /ExtGState << /M << /SMask << /S /Luminosity /G 5 0 R >> >> >> >>';
    const doc = await open(onePage('/M gs 1 0 0 rg 0 0 100 100 re f', { resources: res, extra: [{ dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /CS /DeviceGray >> >>', stream: '1 g 0 0 50 100 re f' }] }));
    const p = leaves(doc)[0];
    expect(p.opacityMask).toBeTruthy();
    expect(p.opacityMask.clip).toBe(true);
    const art = p.opacityMask.art.nodes.find((n) => n.type === 'path');
    expect(art.fill.color).toBe('#ffffff');
  });

  it('turns tiling patterns into pattern swatches', async () => {
    const res = '<< /Pattern << /T 5 0 R >> >>';
    const doc = await open(onePage('/Pattern cs /T scn 0 0 100 100 re f', { resources: res, extra: [{ dict: '<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >> >>', stream: '1 0 0 rg 0 0 5 5 re f' }] }));
    const p = leaves(doc)[0];
    expect(p.fill.type).toBe('pattern');
    const def = doc.root.patterns.find((x) => x.id === p.fill.id);
    expect(def).toMatchObject({ width: 10, height: 10 });
    expect(def.art.nodes.some((n) => n.fill?.color === '#ff0000')).toBe(true);
    expect(doc.root.swatches.some((s) => s.paint.type === 'pattern' && s.paint.id === def.id)).toBe(true);
  });
});

describe('PDF images, forms and layers', () => {
  it('decodes image XObjects into PNG images placed by the CTM', async () => {
    const px = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const doc = await open(onePage('q 100 0 0 50 10 20 cm /Im0 Do Q', { resources: '<< /XObject << /Im0 5 0 R >> >>', extra: [{ dict: '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 >>', stream: px, flate: true }] }));
    const img = leaves(doc)[0];
    expect(img.type).toBe('image');
    expect(img.transform).toEqual([50, 0, 0, 25, 10, 30]);
    const { rows } = pngPixels(doc.assets.get(img.asset).data);
    expect(rows[0]).toEqual([255, 0, 0, 0, 255, 0]);
    expect(rows[1]).toEqual([0, 0, 255, 255, 255, 255]);
  });

  it('passes JPEG data through and applies soft masks as alpha', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, 0, 4, 0, 0, 0xff, 0xd9]);
    const mask = Uint8Array.from([0, 255]);
    const doc = await open(onePage('q 10 0 0 10 0 0 cm /J Do /A Do Q', {
      resources: '<< /XObject << /J 5 0 R /A 6 0 R >> >>',
      extra: [
        { dict: '<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>', stream: jpeg },
        { dict: '<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /SMask 7 0 R >>', stream: Uint8Array.from([0, 0]) },
        { dict: '<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 >>', stream: mask },
      ],
    }));
    const [j, a] = leaves(doc);
    expect(doc.assets.get(j.asset).mime).toBe('image/jpeg');
    const { rows, ch } = pngPixels(doc.assets.get(a.asset).data);
    expect(ch).toBe(4);
    expect(rows[0]).toEqual([0, 0, 0, 0, 0, 0, 0, 255]);
  });

  it('paints stencil masks and inline images', async () => {
    const doc = await open(onePage('0 0 1 rg q 8 0 0 1 0 0 cm BI /W 8 /H 1 /IM true ID \x0f EI Q q 2 0 0 1 0 10 cm BI /W 2 /H 1 /CS /G /BPC 8 ID \x00\xff EI Q'));
    const [stencil, gray] = leaves(doc);
    const s = pngPixels(doc.assets.get(stencil.asset).data);
    // Sample 0 paints: the first four pixels are blue and opaque, the rest clear.
    expect(s.rows[0].slice(0, 4)).toEqual([0, 0, 255, 255]);
    expect(s.rows[0][7 * 4 + 3]).toBe(0);
    const g = pngPixels(doc.assets.get(gray.asset).data);
    expect(g.rows[0]).toEqual([0, 0, 0, 255, 255, 255]);
  });

  it('replaces images it cannot decode with labeled boxes', async () => {
    const doc = await open(onePage('q 10 0 0 10 0 0 cm /X Do Q', { resources: '<< /XObject << /X 5 0 R >> >>', extra: [{ dict: '<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode >>', stream: 'xxxx' }] }));
    expect(leaves(doc)[0]).toMatchObject({ type: 'path', name: 'JPEG 2000 image' });
    expect(doc.importWarnings.join(' ')).toMatch(/JPEG 2000/);
  });

  it('turns form XObjects into groups (transparency groups keep their opacity)', async () => {
    const doc = await open(onePage('/G gs /Fm Do', {
      resources: '<< /XObject << /Fm 5 0 R >> /ExtGState << /G << /ca 0.4 >> >> >>',
      extra: [{ dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency >> >>', stream: '1 0 0 rg 0 0 10 10 re f 0 0 1 rg 20 0 10 10 re f' }],
    }));
    const g = [...doc.nodes.values()].find((n) => n.type === 'group');
    expect(g.opacity).toBe(0.4);
    expect(g.children).toHaveLength(2);
    expect(leaves(doc).every((n) => n.fill.opacity === undefined)).toBe(true);
  });

  it('maps optional content groups to layers', async () => {
    const doc = await open(onePage('/OC /a BDC 0 0 10 10 re f EMC /OC /b BDC 20 0 10 10 re f EMC /OC /a BDC 40 0 10 10 re f EMC', {
      resources: '<< /Properties << /a 5 0 R /b 6 0 R >> >>',
      catalogExtra: '/OCProperties << /OCGs [5 0 R 6 0 R] /D << /Order [5 0 R 6 0 R] /OFF [6 0 R] >> >>',
      extra: ['<< /Type /OCG /Name (Background) >>', '<< /Type /OCG /Name (Notes) >>'],
    }));
    const layers = doc.layers();
    expect(layers.map((l) => l.name)).toEqual(['Background', 'Notes']);
    expect(layers[0].children).toHaveLength(2);
    expect(layers[1].hidden).toBe(true);
  });

  it('opens pages as artboards side by side, honoring rotation and page choice', async () => {
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 50] /Contents 6 0 R >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 50] /Rotate 90 /Contents 6 0 R >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 80 80] /CropBox [10 10 70 70] /Contents 6 0 R >>',
      { dict: '<< >>', stream: '0 0 10 10 re f' },
    ];
    const doc = await open(buildPDF(objs));
    expect(doc.artboards.map((a) => [a.name, a.w, a.h])).toEqual([['Page 1', 100, 50], ['Page 2', 50, 100], ['Page 3', 60, 60]]);
    expect(doc.artboards[1].x).toBeGreaterThan(doc.artboards[0].x + 100);
    // Rotated 90 degrees clockwise: the page's bottom-left corner is now top-left.
    const rotated = leaves(doc)[1];
    const xs = rotated.anchors.map((a) => a.x - doc.artboards[1].x);
    const ys = rotated.anchors.map((a) => a.y);
    expect(Math.min(...xs)).toBeCloseTo(0);
    expect(Math.min(...ys)).toBeCloseTo(0);
    const two = await open(buildPDF(objs), { pages: [2] });
    expect(two.artboards).toHaveLength(1);
    expect(two.artboards[0].w).toBe(60);
  });

  it('places one page cropped to a chosen box', async () => {
    const bytes = onePage('0 0 0 rg -50 -50 300 200 re f', { media: '[0 0 200 100]', pageExtra: '/TrimBox [10 10 190 90]' });
    const art = await pdfToNodes(bytes, { crop: 'bounding', families: FAMILIES });
    expect(art.bounds).toMatchObject({ w: 300, h: 200 });
    const trim = await pdfToNodes(bytes, { crop: 'trim', families: FAMILIES });
    expect(trim.bounds).toMatchObject({ x: 0, y: 0, w: 180, h: 80 });
    const root = trim.subtree.nodes[0];
    expect(root.clip).toBe(true);
  });

  it('imports annotation appearances', async () => {
    const doc = await open(onePage('', { pageExtra: '/Annots [5 0 R]', extra: ['<< /Type /Annot /Subtype /Stamp /Rect [10 10 60 30] /AP << /N 6 0 R >> >>', { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 100 40] >>', stream: '1 0 0 rg 0 0 100 40 re f' }] }));
    const p = leaves(doc)[0];
    const xs = p.anchors.map((a) => a.x);
    expect(Math.min(...xs)).toBeCloseTo(10);
    expect(Math.max(...xs)).toBeCloseTo(60);
  });
});

/** A tiny TrueType font with glyph 1 (mapped from 'A') a 600x700 rectangle. */
function tinyTrueType() {
  const tables = {};
  const u16 = (v) => [(v >> 8) & 255, v & 255];
  const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const head = new Array(54).fill(0);
  head.splice(18, 2, ...u16(1000));
  head.splice(50, 2, ...u16(0));
  tables.head = head;
  tables.maxp = [...u32(0x00005000), ...u16(2)];
  // Glyph 1: one contour, 4 on-curve points, absolute deltas as 16-bit values.
  const pts = [[0, 0], [600, 0], [600, 700], [0, 700]];
  const glyph = [...u16(1), ...u16(0), ...u16(0), ...u16(600), ...u16(700), ...u16(3), ...u16(0), 1, 1, 1, 1];
  let prev = 0;
  for (const [x] of pts) {
    glyph.push(...u16((x - prev) & 0xffff));
    prev = x;
  }
  prev = 0;
  for (const [, y] of pts) {
    glyph.push(...u16((y - prev) & 0xffff));
    prev = y;
  }
  if (glyph.length % 2) glyph.push(0);
  tables.glyf = glyph;
  tables.loca = [...u16(0), ...u16(0), ...u16(glyph.length / 2)];
  // cmap format 4 with one segment 65..65 -> glyph 1, plus the end segment.
  const seg = [...u16(4), ...u16(32), ...u16(0), ...u16(4), ...u16(4), ...u16(1), ...u16(0), ...u16(65), ...u16(0xffff), ...u16(0), ...u16(65), ...u16(0xffff), ...u16((1 - 65) & 0xffff), ...u16(1), ...u16(0), ...u16(0)];
  tables.cmap = [...u16(0), ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...seg];
  const names = Object.keys(tables);
  let offset = 12 + names.length * 16;
  const dir = [...u32(0x00010000), ...u16(names.length), 0, 0, 0, 0, 0, 0];
  const body = [];
  for (const n of names) {
    const t = tables[n];
    dir.push(...[...n].map((c) => c.charCodeAt(0)), ...u32(0), ...u32(offset), ...u32(t.length));
    body.push(...t);
    while (body.length % 4) body.push(0);
    offset = 12 + names.length * 16 + body.length;
  }
  return Uint8Array.from([...dir, ...body]);
}

describe('PDF text', () => {
  const widths = `[${new Array(95).fill(500).join(' ')}]`;
  const font = (base, extra = '') => `<< /Type /Font /Subtype /TrueType /BaseFont /${base} /FirstChar 32 /LastChar 126 /Widths ${widths} /Encoding /WinAnsiEncoding ${extra} >>`;

  it('keeps text editable in fonts the app has, merging runs on a line', async () => {
    const doc = await open(onePage('BT /F0 24 Tf 10 50 Td (Hello) Tj [( W) 20 (orld)] TJ 0 -30 Td (Next line) Tj ET', { resources: '<< /Font << /F0 5 0 R >> >>', extra: [font('ABCDEF+Roboto-Bold')] }));
    const texts = leaves(doc).filter((n) => n.type === 'text');
    expect(texts.map((t) => t.text)).toEqual(['Hello World', 'Next line']);
    expect(texts[0].char).toMatchObject({ fontFamily: 'Roboto', fontWeight: 700, fontStyle: 'normal', fontSize: 24 });
    expect(texts[0].transform).toEqual([1, 0, 0, 1, 10, 50]);
    expect(texts[1].transform[5]).toBeCloseTo(80);
    expect(doc.importWarnings.join(' ')).not.toMatch(/substituted/);
  });

  it('normalizes scaled text matrices into font sizes and keeps rotation', async () => {
    const doc = await open(onePage('BT /F0 1 Tf 0 12 -12 0 50 20 Tm (Up) Tj ET', { resources: '<< /Font << /F0 5 0 R >> >>', extra: [font('OpenSans-Italic')] }));
    const t = leaves(doc)[0];
    expect(t.char).toMatchObject({ fontFamily: 'Open Sans', fontSize: 12, fontStyle: 'italic' });
    // Rotated 90 degrees counter-clockwise on the page.
    expect(t.transform[0]).toBeCloseTo(0);
    expect(t.transform[1]).toBeCloseTo(-1);
  });

  it('substitutes fonts that are neither available nor embedded', async () => {
    const doc = await open(onePage('BT /F0 10 Tf 0 0 Td (abc) Tj ET', { resources: '<< /Font << /F0 5 0 R >> >>', extra: ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'] }));
    const t = leaves(doc)[0];
    expect(t.char.fontFamily).toBe('Roboto');
    expect(doc.importWarnings.join(' ')).toMatch(/substituted: Helvetica/);
  });

  it('converts text in embedded fonts that are not available to outlines', async () => {
    const ttf = tinyTrueType();
    const doc = await open(onePage('BT /F0 10 Tf 5 5 Td (AA) Tj ET', {
      resources: '<< /Font << /F0 5 0 R >> >>',
      extra: [font('Zzyzx-Regular', '/FontDescriptor 6 0 R'), '<< /Type /FontDescriptor /FontName /Zzyzx-Regular /Flags 32 /FontFile2 7 0 R >>', { dict: '<< >>', stream: ttf, flate: true }],
    }));
    const c = leaves(doc)[0];
    expect(c.type).toBe('compound');
    expect(c.name).toBe('AA');
    const kids = c.children.map((id) => doc.get(id));
    expect(kids).toHaveLength(2);
    const xs = kids[0].anchors.map((a) => a.x);
    expect(Math.min(...xs)).toBeCloseTo(5);
    expect(Math.max(...xs)).toBeCloseTo(11);
    expect(doc.importWarnings.join(' ')).toMatch(/outlines: Zzyzx/);
    // Asking for editable text keeps it as type with a substitute font.
    const editable = await open(onePage('BT /F0 10 Tf 5 5 Td (AA) Tj ET', {
      resources: '<< /Font << /F0 5 0 R >> >>',
      extra: [font('Zzyzx-Regular', '/FontDescriptor 6 0 R'), '<< /Type /FontDescriptor /FontName /Zzyzx-Regular /Flags 32 /FontFile2 7 0 R >>', { dict: '<< >>', stream: ttf, flate: true }],
    }), { textMode: 'text' });
    expect(leaves(editable)[0]).toMatchObject({ type: 'text', text: 'AA' });
  });

  it('draws Type 3 glyphs from their procedures', async () => {
    const doc = await open(onePage('1 0 0 rg BT /F1 10 Tf 0 0 Td (aa) Tj ET', {
      resources: '<< /Font << /F1 5 0 R >> >>',
      extra: ['<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a 6 0 R >> /Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [1000] >>', { dict: '<< >>', stream: '1000 0 d1 0 0 1000 1000 re f' }],
    }));
    const squares = leaves(doc);
    expect(squares).toHaveLength(2);
    expect(squares.every((s) => s.fill.color === '#ff0000')).toBe(true);
    expect(Math.min(...squares[1].anchors.map((a) => a.x))).toBeCloseTo(10);
  });

  it('skips invisible text (scanned documents) and uses ToUnicode maps', async () => {
    const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <ffff> endcodespacerange 2 beginbfchar <0001> <0048> <0002> <0069> endbfchar endcmap end end';
    const doc = await open(onePage('BT /F0 10 Tf 3 Tr 0 0 Td (hidden) Tj 0 Tr 0 20 Td <00010002> Tj ET', {
      resources: '<< /Font << /F0 5 0 R >> >>',
      extra: ['<< /Type /Font /Subtype /Type0 /BaseFont /Roboto /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>', '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Roboto /DW 500 >>', { dict: '<< >>', stream: cmap }],
    }));
    const texts = leaves(doc);
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe('Hi');
  });
});

describe('PDF roundtrip', () => {
  it('imports what the PDF exporter writes', async () => {
    const src = VDocument.create({ width: 200, height: 100 });
    const layer = src.layers()[0];
    src.transact('x', () => {
      src.insert(createPath(rectangle(10, 10, 50, 30), true, { fill: { type: 'solid', color: '#336699' }, stroke: { type: 'solid', color: '#000000' }, strokeWidth: 3, dash: [4, 2] }), layer.id);
      src.insert(createPath(rectangle(100, 20, 60, 40), true, { fill: { type: 'radial', angle: 0, stops: [{ offset: 0, color: '#ffffff', opacity: 1 }, { offset: 1, color: '#ff0000', opacity: 1 }] }, stroke: null, opacity: 0.5 }), layer.id);
      src.insert(createText('Label', 20, 80, { char: { ...createText('').char, fontFamily: 'Inter' } }), layer.id);
    });
    const { bytes } = await writePDF(src, [src.artboards[0]], {});
    const doc = await open(bytes);
    const [a, b, t] = leaves(doc);
    expect(a.fill.color).toBe('#336699');
    expect(a.dash).toEqual([4, 2]);
    expect(a.strokeWidth).toBe(3);
    expect(b.fill.type).toBe('radial');
    expect(b.fill.stops[0].opacity).toBeCloseTo(0.5);
    expect(t.text).toBe('Label');
  });
});
