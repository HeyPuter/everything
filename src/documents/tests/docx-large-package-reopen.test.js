import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zlibSync, strToU8, unzipSync } from 'fflate';
import { DocxPackage, createDocx } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { validateImageAssets } from '../src/engine/images.js';

// An editing session holds up to 50 MB of pictures (validateImageAssets), and Insert > Pictures takes
// files up to 10 MB each. Three photographs as PNG made a .docx of about 29 MB, which saved, and then
// would not open again: "This editor currently opens DOCX files up to 20 MB." The open limits now
// admit every package the session can write.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

// A PNG of noise, which no compressor shrinks: about width × height × 3 bytes.
function noisePng(width, height, seed) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer); view.setUint32(0, data.length); out.set(strToU8(type), 4); out.set(data, 8); view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length))); return out; };
  const raw = new Uint8Array((width * 3 + 1) * height); let x = seed;
  for (let i = 0; i < raw.length; i++) { if (i % (width * 3 + 1) === 0) continue; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; raw[i] = x & 255; }
  const header = new Uint8Array(13), view = new DataView(header.buffer); view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlibSync(raw, { level: 1 })), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out;
}

it('reopens a document saved with as many pictures as a session holds', async () => {
  const pkg = createDocx([paragraph('Site photographs')]);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  for (const name of ['north', 'east', 'south']) {
    const asset = { bytes: noisePng(1700, 1700, name.length * 7919 + 13), mime: 'image/png' };
    expect(asset.bytes.length).toBeLessThan(10 * 1024 * 1024);
    validateImageAssets(doc.assets, asset);
    doc.assets[name] = asset;
    doc.select(doc.text.length); doc.insertImage(name, { width: 914400, height: 914400 });
  }
  const saved = new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer());
  expect(saved.length).toBeGreaterThan(20 * 1024 * 1024);
  const reopened = await DocxPackage.open(saved);
  expect(reopened.readOnly).toBeFalsy();
  expect(Object.keys(reopened.assets)).toHaveLength(3);
  expect(Object.keys(unzipSync(saved)).filter(name => name.startsWith('word/media/'))).toHaveLength(3);
});
