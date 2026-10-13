import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { buildPDF, leaves } from './interop-helpers.js';
import { pdfToDocument } from '../src/features/interop/pdf/import.js';
import { dataUrlToBytes } from '../src/features/io/image-info.js';
import { decodeCCITT } from '../src/features/interop/codec/ccitt.js';
import { decodeJBIG2 } from '../src/features/interop/codec/jbig2.js';
import { decodeJPX } from '../src/features/interop/codec/jpx.js';
import * as F from './interop2-codec-fixtures.js';

const open = (bytes) => pdfToDocument(bytes, { families: ['Inter'] });

/** Pixels of a PNG asset as rows of channel values. */
function pngPixels(dataUrl) {
  const { bytes } = dataUrlToBytes(dataUrl);
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  const w = dv.getUint32(16);
  const h = dv.getUint32(20);
  const ch = bytes[25] === 6 ? 4 : 3;
  let p = 8;
  const idat = [];
  while (p < bytes.length) {
    const len = dv.getUint32(p);
    if (String.fromCharCode(...bytes.subarray(p + 4, p + 8)) === 'IDAT') idat.push(Buffer.from(bytes.subarray(p + 8, p + 8 + len)));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch + 1;
  const rows = [];
  let prev = new Array(w * ch).fill(0);
  for (let y = 0; y < h; y++) {
    const f = raw[y * stride];
    const row = [];
    for (let i = 0; i < w * ch; i++) {
      const x = raw[y * stride + 1 + i];
      const a = i >= ch ? row[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      row.push((x + [0, a, b, (a + b) >> 1, pr][f]) & 255);
    }
    rows.push(row);
    prev = row;
  }
  return { w, h, ch, rows, at: (x, y) => rows[y].slice(x * ch, x * ch + ch) };
}

/** A page drawing one image XObject (object 5) scaled to 100 x 100, plus extra objects from 6 on. */
function imagePDF(imageDict, data, extra = [], content = 'q 100 0 0 100 0 0 cm /Im0 Do Q') {
  return buildPDF([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    { dict: '<< >>', stream: content },
    { dict: `<< /Type /XObject /Subtype /Image ${imageDict} >>`, stream: new Uint8Array(data) },
    ...extra,
  ]);
}

const imageOf = async (bytes) => {
  const doc = await open(bytes);
  const img = leaves(doc).find((n) => n.type === 'image');
  expect(img).toBeTruthy();
  return { doc, img, px: pngPixels(doc.assets.get(img.asset).data) };
};

const rowsOf = (bm) => Array.from({ length: bm.h }, (_, y) => Array.from(bm.d.subarray(y * bm.w, (y + 1) * bm.w)));

describe('CCITT fax decoding', () => {
  const bm = F.randomBitmap(53, 21, 3);
  const rows = rowsOf(bm);
  const check = (r) => {
    const rb = (bm.w + 7) >> 3;
    for (let y = 0; y < bm.h; y++) for (let x = 0; x < bm.w; x++) expect(((r.data[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1) ^ 1, `pixel ${x},${y}`).toBe(bm.d[y * bm.w + x]);
  };

  it('decodes Group 4, Group 3 one- and two-dimensional data, with end-of-line codes and byte alignment', () => {
    check(decodeCCITT(Uint8Array.from(F.encodeCCITT(rows, bm.w, { k: -1, eofb: true })), { K: -1, columns: bm.w }));
    check(decodeCCITT(Uint8Array.from(F.encodeCCITT(rows, bm.w, { k: -1, byteAlign: true })), { K: -1, columns: bm.w, rows: bm.h, byteAlign: true }));
    check(decodeCCITT(Uint8Array.from(F.encodeCCITT(rows, bm.w, { k: 0 })), { K: 0, columns: bm.w, rows: bm.h }));
    check(decodeCCITT(Uint8Array.from(F.encodeCCITT(rows, bm.w, { k: 0, eol: true, eofb: true })), { K: 0, columns: bm.w }));
    check(decodeCCITT(Uint8Array.from(F.encodeCCITT(rows, bm.w, { k: 3, eol: true, byteAlign: true })), { K: 3, columns: bm.w, rows: bm.h, byteAlign: true }));
    check(decodeCCITT(Uint8Array.from(F.encodeCCITT(rows, bm.w, { k: 4 })), { K: 4, columns: bm.w, rows: bm.h }));
  });

  it('keeps decoded rows of damaged data and leaves the rest white', () => {
    const data = Uint8Array.from(F.encodeCCITT(rows, bm.w, { k: -1 }));
    const r = decodeCCITT(data.subarray(0, 20), { K: -1, columns: bm.w, rows: bm.h });
    expect(r.data.length).toBe(((bm.w + 7) >> 3) * bm.h);
    expect(r.data[r.data.length - 1]).toBe(0xff);
  });

  it('imports CCITT images, inverted ones and stencil masks', async () => {
    const data = F.encodeCCITT(rows, bm.w, { k: -1 });
    const dict = `/Width ${bm.w} /Height ${bm.h} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns ${bm.w} >>`;
    const { px, doc } = await imageOf(imagePDF(dict, data));
    for (const [x, y] of [[0, 0], [5, 3], [20, 10], [52, 20]]) expect(px.at(x, y)[0]).toBe(bm.d[y * bm.w + x] ? 0 : 255);
    expect(doc.importWarnings.join(' ')).not.toMatch(/gray boxes/);
    // BlackIs1 flips the meaning of the bits.
    const inv = await imageOf(imagePDF(dict.replace('/Columns', '/BlackIs1 true /Columns'), data));
    expect(inv.px.at(5, 3)[0]).toBe(bm.d[3 * bm.w + 5] ? 255 : 0);
    // A stencil mask paints the fill color where the mask is black.
    const mask = await imageOf(imagePDF(`/Width ${bm.w} /Height ${bm.h} /ImageMask true /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns ${bm.w} >>`, data, [], 'q 1 0 0 rg 100 0 0 100 0 0 cm /Im0 Do Q'));
    for (const [x, y] of [[5, 3], [20, 10]]) {
      const p = mask.px.at(x, y);
      expect(p[3]).toBe(bm.d[y * bm.w + x] ? 255 : 0);
      if (p[3]) expect(p.slice(0, 3)).toEqual([255, 0, 0]);
    }
  });
});

describe('JBIG2 decoding', () => {
  const W = 61;
  const H = 37;
  const bm = F.randomBitmap(W, H, 5);
  const same = (r, want) => {
    expect([r.width, r.height]).toEqual([want.w, want.h]);
    let diff = 0;
    for (let i = 0; i < want.d.length; i++) if (r.data[i] !== want.d[i]) diff++;
    expect(diff).toBe(0);
  };

  it('decodes generic regions: templates 0-3, typical prediction, adaptive pixels and MMR', () => {
    for (const template of [0, 1, 2, 3]) same(decodeJBIG2(F.jbig2Stream(W, H, [F.genericSegment(1, bm, { template })])), bm);
    same(decodeJBIG2(F.jbig2Stream(W, H, [F.genericSegment(1, bm, { tpgdon: true })])), bm);
    same(decodeJBIG2(F.jbig2Stream(W, H, [F.genericSegment(1, bm, { at: [-4, -1, 3, -2, -1, -2, 4, -1] })])), bm);
    same(decodeJBIG2(F.jbig2Stream(W, H, [F.genericMMRSegment(1, bm)])), bm);
  });

  it('decodes regions placed on the page and refinements of the page', () => {
    const small = F.randomBitmap(20, 10, 8);
    const want = { w: W, h: H, d: new Uint8Array(W * H) };
    for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) want.d[(y + 7) * W + x + 13] = small.d[y * 20 + x];
    same(decodeJBIG2(F.jbig2Stream(W, H, [F.genericSegment(1, small, { x: 13, y: 7 })])), want);
    const next = F.randomBitmap(W, H, 77);
    const or = { w: W, h: H, d: bm.d.map((v, i) => v | next.d[i]) };
    for (const template of [0, 1]) same(decodeJBIG2(F.jbig2Stream(W, H, [F.genericSegment(1, bm), F.refinementSegment(2, next, bm, { template })])), or);
  });

  const syms = [F.randomBitmap(7, 9, 1), F.randomBitmap(5, 9, 2), F.randomBitmap(8, 6, 3), F.randomBitmap(3, 4, 4)];
  const inst = [{ id: 0, x: 2, y: 3 }, { id: 1, x: 12, y: 8 }, { id: 2, x: 30, y: 10 }, { id: 3, x: 50, y: 25 }, { id: 0, x: 40, y: 20 }];
  const draw = (symbols, list) => {
    const page = { w: W, h: H, d: new Uint8Array(W * H) };
    for (const i of list) {
      const s = i.refine ? i.refine.bitmap : symbols[i.id];
      for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (s.d[y * s.w + x]) page.d[(i.y + y) * W + i.x + x] = 1;
    }
    return page;
  };

  it('decodes symbol dictionaries and text regions (arithmetic and Huffman coded, with refinement)', () => {
    const dict = F.symbolDictSegment(1, syms);
    const ex = dict.order.map((i) => syms[i]);
    same(decodeJBIG2(F.jbig2Stream(W, H, [dict.bytes, F.textRegionSegment(2, W, H, ex, inst, { dictRef: 1 })])), draw(ex, inst));
    for (const refineTemplate of [0, 1]) {
      const list = [{ id: 1, x: 2, y: 3 }, { id: 0, x: 20, y: 5, refine: { bitmap: F.randomBitmap(ex[0].w + 1, ex[0].h, 9), dx: 0, dy: 0 } }];
      same(decodeJBIG2(F.jbig2Stream(W, H, [dict.bytes, F.textRegionSegment(2, W, H, ex, list, { dictRef: 1, refineTemplate })])), draw(ex, list));
    }
    const hd = F.symbolDictHuffmanSegment(1, syms);
    const hex = hd.order.map((i) => syms[i]);
    same(decodeJBIG2(F.jbig2Stream(W, H, [hd.bytes, F.textRegionHuffmanSegment(2, W, H, hex, inst, { dictRef: 1 })])), draw(hex, inst));
  });

  it('decodes pattern dictionaries and halftone regions', () => {
    const pats = [0, 1, 2, 3].map((g) => ({ w: 4, h: 4, d: Uint8Array.from({ length: 16 }, (_, i) => (i < g * 4 ? 1 : 0)) }));
    const gw = 10;
    const gh = 6;
    const grid = Uint8Array.from({ length: gw * gh }, (_, i) => (i * 7) % 4);
    const want = { w: gw * 4, h: gh * 4, d: new Uint8Array(gw * 4 * gh * 4) };
    for (let m = 0; m < gh; m++) for (let n = 0; n < gw; n++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) want.d[(m * 4 + y) * want.w + n * 4 + x] = pats[grid[m * gw + n]].d[y * 4 + x];
    same(decodeJBIG2(F.jbig2Stream(want.w, want.h, [F.halftoneSegments(1, pats, grid, { gw, gh, cell: 4 })])), want);
  });

  it('imports JBIG2 images with global segments, and JBIG2 soft masks', async () => {
    const dict = F.symbolDictSegment(1, syms);
    const ex = dict.order.map((i) => syms[i]);
    const page = new Uint8Array(F.segment(0, 48, F.pageInfo(W, H)));
    const body = [...page, ...F.textRegionSegment(2, W, H, ex, inst, { dictRef: 1 }), ...F.segment(3, 49, [])];
    const pdf = imagePDF(`/Width ${W} /Height ${H} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode /DecodeParms << /JBIG2Globals 6 0 R >>`, body, [{ dict: '<< >>', stream: new Uint8Array(dict.bytes) }]);
    const { px } = await imageOf(pdf);
    const want = draw(ex, inst);
    for (const [x, y] of [[2, 3], [4, 6], [31, 11], [51, 26], [60, 36]]) expect(px.at(x, y)[0]).toBe(want.d[y * W + x] ? 0 : 255);
    // A red image whose soft mask is JBIG2 coded: opaque where the mask is white (1.0).
    const rgb = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) rgb[i * 3] = 255;
    const mask = F.jbig2Stream(W, H, [F.genericSegment(1, bm)]);
    const masked = imagePDF(`/Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 6 0 R`, rgb, [{ dict: `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode >>`, stream: mask }]);
    const m = await imageOf(masked);
    for (const [x, y] of [[0, 0], [3, 1], [30, 20]]) expect(m.px.at(x, y)[3]).toBe(bm.d[y * W + x] ? 0 : 255);
  });
});

// JPEG 2000 files written by an independent encoder (OpenJPEG) from generated images.
const JP2_RGB = 'AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAABwAAAAkAAwcHAAAAAAAPY29scgEAAAAAABAAAAC8anAyY/9P/1EALwAAAAAACQAAAAcAAAAAAAAAAAAAAAkAAAAHAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAAIEBAAB/1wACkBASEhQSEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS4z/5AACgAAAAAAPgAB/5PfgCgJJtlif9+AMAaqzhRW39+AQAf4yhbP4Ea3gKPtBAALPCOjofUCAAs7mqOAgID/2Q==';
const JP2_RGB_LOSSY = 'AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAABwAAAAkAAwcHAAAAAAAPY29scgEAAAAAABAAAAD3anAyY/9P/1EALwAAAAAACQAAAAcAAAAAAAAAAAAAAAkAAAAHAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAAIEBAAA/1wAEUJfUlAFUAVQR1fTV9NXYv9kACUAAUNyZWF0ZWQgYnkgT3BlbkpQRUcgdmVyc2lvbiAyLjUuM/+QAAoAAAAAAHIAAf+Tx+YUCPK1Pk8juID/f8fmEAaAn6kCvCCDx+YSB3YPb3/qx/dXwPnCAAFsCX+h9oMACzmFNut3wHyAoPqBQAFhCzkMMg3APhDAFBBWoD5AwAK6xm6Yz8A+ESAfCIAUEFyfArrGH//Z';
const JP2_GRAY_ALPHA = 'AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAABDanAyaAAAABZpaGRyAAAABQAAAAYAAgcHAAAAAAAPY29scgEAAAAAABEAAAAWY2RlZgACAAAAAAABAAEAAQAAAAAAqWpwMmP/T/9RACwAAAAAAAYAAAAFAAAAAAAAAAAAAAAGAAAABQAAAAAAAAAAAAIHAQEHAQH/UgAMAAAAAQACBAQAAf9cAApAQEhIUEhIUP9kACUAAUNyZWF0ZWQgYnkgT3BlbkpQRUcgdmVyc2lvbiAyLjUuM/+QAAoAAAAAAC4AAf+T34AoCPFAUHXfgCgGQnwFT8B8IQAIf4DD6gQAFYr8h4D/2Q==';
const J2K_GRAY = '/0//UQApAAAAAAAJAAAABwAAAAAAAAAAAAAACQAAAAcAAAAAAAAAAAABBwEB/1IADAAAAAEAAQQEAAH/XAAHQEBISFD/ZAAlAAFDcmVhdGVkIGJ5IE9wZW5KUEVHIHZlcnNpb24gMi41LjP/kAAKAAAAAAA6AAH/k8+0VBDiIhAKIEYSBVrZThUHvAySRSAfn8ASwDosAIwTlw/tPyKQBwt/Aai//9k=';
const J2K_GRAY_PIXELS = [0, 10, 21, 31, 41, 52, 62, 72, 82, 25, 36, 46, 56, 67, 77, 87, 98, 108, 51, 61, 71, 82, 92, 102, 113, 123, 133, 76, 87, 97, 107, 117, 128, 138, 148, 159, 102, 112, 122, 133, 143, 153, 164, 174, 184, 127, 137, 148, 158, 168, 179, 189, 199, 210, 153, 163, 173, 183, 194, 204, 214, 225, 235];
const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const rgbAt = (x, y) => [(x * 28) % 256, (y * 40) % 256, ((x + y) * 17) % 256];

describe('JPEG 2000 decoding', () => {
  it('decodes reversible and irreversible color images, gray with alpha, and raw codestreams', () => {
    const r = decodeJPX(b64(JP2_RGB));
    expect(r).toMatchObject({ width: 9, height: 7, comps: 3, colorSpace: 'rgb', alpha: false });
    for (let y = 0; y < 7; y++) for (let x = 0; x < 9; x++) expect(Array.from(r.data.subarray((y * 9 + x) * 3, (y * 9 + x) * 3 + 3))).toEqual(rgbAt(x, y));
    const lossy = decodeJPX(b64(JP2_RGB_LOSSY));
    let worst = 0;
    for (let y = 0; y < 7; y++) for (let x = 0; x < 9; x++) for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(lossy.data[(y * 9 + x) * 3 + k] - rgbAt(x, y)[k]));
    expect(worst).toBeLessThanOrEqual(2);
    const la = decodeJPX(b64(JP2_GRAY_ALPHA));
    expect(la).toMatchObject({ width: 6, height: 5, comps: 2, colorSpace: 'gray', alpha: true });
    expect(Array.from(la.data.subarray((2 * 6 + 3) * 2, (2 * 6 + 3) * 2 + 2))).toEqual([150, 120]);
    const raw = decodeJPX(b64(J2K_GRAY));
    expect(Array.from(raw.data)).toEqual(J2K_GRAY_PIXELS);
  });

  it('imports JPX images with their own colors, alpha (SMaskInData) and the dictionary color space', async () => {
    const { px } = await imageOf(imagePDF('/Width 9 /Height 7 /Filter /JPXDecode', b64(JP2_RGB)));
    expect(px.at(4, 5).slice(0, 3)).toEqual(rgbAt(4, 5));
    const a = await imageOf(imagePDF('/Width 6 /Height 5 /SMaskInData 1 /Filter /JPXDecode', b64(JP2_GRAY_ALPHA)));
    expect(a.px.at(3, 2)).toEqual([150, 150, 150, 120]);
    // A raw codestream drawn through an Indexed space given by the dictionary.
    const lookup = Array.from({ length: 256 }, (_, i) => `${(255 - i).toString(16).padStart(2, '0')}0000`).join('');
    const ix = await imageOf(imagePDF(`/Width 9 /Height 7 /ColorSpace [/Indexed /DeviceRGB 255 <${lookup}>] /Filter /JPXDecode`, b64(J2K_GRAY)));
    expect(ix.px.at(1, 0).slice(0, 3)).toEqual([255 - J2K_GRAY_PIXELS[1], 0, 0]);
  });
});

describe('PostScript fax images', () => {
  it('decodes CCITTFaxDecode filters once the codec is loaded', async () => {
    const { interpretEPS } = await import('../src/features/interop/ps/eps.js');
    const { loadImageCodecs } = await import('../src/features/interop/pdf/images.js');
    await loadImageCodecs(['CCITTFaxDecode']);
    const bm = F.randomBitmap(24, 10, 4);
    const data = F.encodeCCITT(rowsOf(bm), bm.w, { k: -1 });
    const hex = Buffer.from(data).toString('hex');
    const body = `gsave 24 10 scale /DeviceGray setcolorspace << /ImageType 1 /Width 24 /Height 10 /BitsPerComponent 1 /Decode [0 1] /ImageMatrix [24 0 0 -10 0 10] /DataSource currentfile /ASCIIHexDecode filter << /K -1 /Columns 24 >> /CCITTFaxDecode filter >> image\n${hex}>\ngrestore`;
    const eps = new TextEncoder().encode(`%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 24 10\n%%EndComments\n${body}\n%%EOF\n`);
    const r = interpretEPS(eps, { families: ['Inter'] });
    const img = r.images[0].img;
    expect([img.width, img.height]).toEqual([24, 10]);
    for (const [x, y] of [[0, 0], [3, 1], [10, 5], [23, 9]]) expect(img.data[(y * 24 + x) * 4]).toBe(bm.d[y * 24 + x] ? 0 : 255);
  });
});
