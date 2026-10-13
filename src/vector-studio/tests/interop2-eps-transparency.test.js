import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setGeomSource, loadGeom } from '../src/features/geometry/engine/index.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createImage } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { writeEPS, pdfToPostScript } from '../src/features/interop/ps/eps-export.js';
import { transparencyClusters, flattenForOutput } from '../src/features/interop/ps/eps-flatten.js';
import { interpretEPS } from '../src/features/interop/ps/eps.js';
import { onePage } from './interop-helpers.js';

const solid = (color) => ({ type: 'solid', color });
const enc = (s) => new TextEncoder().encode(s);
const noRaster = { render: async () => { throw new Error('no raster expected'); } };

function sample() {
  const doc = VDocument.create({ width: 300, height: 200 });
  const layer = doc.layers()[0];
  const ids = {};
  doc.transact('x', () => {
    ids.base = doc.insert(createPath(rectangle(10, 10, 100, 60), true, { fill: solid('#0000ff'), stroke: null }), layer.id).id;
    ids.glass = doc.insert(createPath(rectangle(60, 30, 100, 60), true, { fill: solid('#ff0000'), stroke: null, opacity: 0.5 }), layer.id).id;
    ids.cover = doc.insert(createPath(rectangle(150, 20, 40, 40), true, { fill: solid('#00ff00'), stroke: null }), layer.id).id;
    ids.away = doc.insert(createPath(rectangle(220, 120, 50, 50), true, { fill: solid('#ffff00'), stroke: null }), layer.id).id;
  });
  return { doc, ids };
}

describe('EPS export transparency', () => {
  beforeAll(async () => {
    setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
    await loadGeom();
  });

  it('groups each transparent object with the backdrop it overlaps', () => {
    const { doc, ids } = sample();
    expect(transparencyClusters(doc, null)).toEqual([[ids.base, ids.glass]]);
    // A transparent object above joins the cluster it overlaps.
    doc.transact('o', () => doc.update(ids.cover, { blendMode: 'multiply' }));
    expect(transparencyClusters(doc, null)).toEqual([[ids.base, ids.glass, ids.cover]]);
    // Exporting a selection considers only the selected objects.
    expect(transparencyClusters(doc, [ids.glass, ids.away])).toEqual([[ids.glass]]);
  });

  it('flattens a copy of the document and leaves the original alone', async () => {
    const { doc, ids } = sample();
    const r = await flattenForOutput(doc, null, { balance: 100, resolution: 72 }, noRaster);
    expect(r.flattened).toBe(1);
    expect(r.doc).not.toBe(doc);
    expect(doc.get(ids.glass).opacity).toBe(0.5);
    expect(r.doc.get(ids.glass)).toBeUndefined();
    expect(r.doc.get(ids.cover)).toBeTruthy();
    const colors = [...r.doc.nodes.values()].filter((n) => n.fill?.type === 'solid').map((n) => n.fill.color);
    expect(colors).toEqual(expect.arrayContaining(['#800080', '#ff8080', '#0000ff', '#00ff00', '#ffff00']));
    expect([...r.doc.nodes.values()].some((n) => (n.opacity ?? 1) < 1)).toBe(false);
    // Selection exports get the flattened group in place of the cluster.
    const sel = await flattenForOutput(doc, [ids.base, ids.glass, ids.away], { balance: 100, resolution: 72 }, noRaster);
    expect(sel.ids).toHaveLength(2);
    expect(sel.ids[1]).toBe(ids.away);
    expect(sel.doc.get(sel.ids[0]).type).toBe('group');
  });

  it('writes flattened transparency as opaque PostScript, or reports it when not flattening', async () => {
    const { doc } = sample();
    const flat = await writeEPS(doc, { rect: doc.artboards[0], level: 3, flatten: { balance: 100, resolution: 72 }, flattenDeps: noRaster });
    expect(flat.warnings.join(' ')).not.toMatch(/transparency|opacity/);
    const back = interpretEPS(enc(flat.text), { families: ['Inter'] });
    const colors = [...back.nodes.values()].filter((n) => n.fill?.type === 'solid').map((n) => n.fill.color);
    expect(colors).toContain('#800080');
    const plain = await writeEPS(doc, { rect: doc.artboards[0], level: 3 });
    expect(plain.warnings.join(' ')).toMatch(/no transparency/);
  });
});

describe('EPS masked images', () => {
  const alpha = Uint8Array.from([255, 0, 255, 0]);
  const pdf = (smaskLevelExtra = '') =>
    onePage('q 40 0 0 10 10 10 cm /A Do Q q 10 0 0 10 60 10 cm /J Do Q', {
      resources: '<< /XObject << /A 5 0 R /J 6 0 R >> >>',
      extra: [
        { dict: '<< /Type /XObject /Subtype /Image /Width 4 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 7 0 R >>', stream: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]) },
        { dict: `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /SMask 8 0 R ${smaskLevelExtra}>>`, stream: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]) },
        { dict: '<< /Type /XObject /Subtype /Image /Width 4 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 >>', stream: alpha },
        { dict: '<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 >>', stream: Uint8Array.from([255, 0]) },
      ],
    });

  it('writes images with transparency and JPEG images with a soft mask as Level 3 masked images', () => {
    const { text, warnings } = pdfToPostScript(pdf(), { level: 3 });
    expect(text.match(/\/ImageType 3/g)).toHaveLength(2);
    expect(text).toContain('/ReusableStreamDecode filter');
    expect(warnings.join(' ')).not.toMatch(/skipped/);
    const r = interpretEPS(enc(text), { families: ['Inter'] });
    const px = r.images.find((e) => e.img.kind === 'rgba' && e.img.width === 4).img;
    expect(Array.from(px.data.filter((_, i) => i % 4 === 3))).toEqual([255, 0, 255, 0]);
    expect(Array.from(px.data.subarray(0, 3))).toEqual([255, 0, 0]);
    const jpegNode = [...r.nodes.values()].find((n) => n.type === 'image' && r.images.find((e) => e.id === n.asset)?.img.kind === 'jpeg');
    expect(jpegNode.opacityMask).toBeTruthy();
    const maskImg = jpegNode.opacityMask.art.nodes[0];
    const mask = r.images.find((e) => e.id === maskImg.asset).img;
    expect([mask.width, mask.height]).toEqual([2, 1]);
    expect([mask.data[0], mask.data[4]]).toEqual([255, 0]);
  });

  it('draws them opaque for Level 2 and says so', () => {
    const { text, warnings } = pdfToPostScript(pdf(), { level: 2 });
    expect(text).not.toContain('/ImageType 3');
    expect(warnings.join(' ')).toMatch(/Level 2/);
  });
});
