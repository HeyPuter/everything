import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { pictureFragment } from '../src/engine/picture-insert.js';
import { materializeDrawing, drawingParts } from '../src/engine/drawing-format.js';
import { setCrop } from '../src/engine/drawing-xml.js';
import { compressEdit } from '../src/views/picture-adjustments.js';

// Compress Pictures with "Delete cropped areas" on a cropped icon (a PNG with an SVG companion).
let dom;
const png = new Uint8Array(readFileSync('icon-128.png'));
beforeAll(() => {
  dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer;
  // Pixels without a browser: a canvas that hands back white pixels and the PNG.
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  globalThis.OffscreenCanvas = class { constructor(width, height) { Object.assign(this, { width, height }); }
    getContext() { return { drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }), putImageData() {} }; }
    async convertToBlob() { return new Blob([png]); } };
  globalThis.createImageBitmap = async () => ({ width: 128, height: 128, close() {} });
});
afterAll(() => { dom.window.close(); delete globalThis.ImageData; delete globalThis.OffscreenCanvas; delete globalThis.createImageBitmap; });

it('drops the SVG companion of a cropped icon whose cropped areas it deletes, so the crop stays deleted', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="64" height="128" fill="red"/><rect x="64" width="64" height="128" fill="blue"/></svg>';
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const fragment = await pictureFragment(doc, pkg.parts, { png, svg, width: 914400, height: 914400, id: 1, name: 'Icon 1' });
  Object.assign(doc.assets, fragment.assets); const { assetId, id, ...properties } = fragment.image; doc.insertImage(assetId, properties);
  const image = doc.paragraphs.flatMap(p => p.runs).find(r => r.image).image;
  const { drawing, parts } = materializeDrawing(pkg, doc, image);
  const { blip, blipFill } = drawingParts(drawing);
  const vector = blip.getElementsByTagNameNS('*', 'svgBlip')[0].getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
  setCrop(blipFill, { right: 50000 });
  const released = [];
  const context = { parts, addPart: () => 'rCompressed', partBytes: rel => parts.get(rel)?.bytes, release: rel => released.push(rel) };
  expect(await compressEdit({ ppi: 150, deleteCropped: true })(drawing, context)).toBe(true);
  // The bitmap is cropped and its crop removed; the uncropped vector must not be painted in its place.
  expect(blipFill.getElementsByTagNameNS('*', 'srcRect')).toHaveLength(0);
  expect(blip.getElementsByTagNameNS('*', 'svgBlip')).toHaveLength(0);
  expect(released).toContain(vector);
});
