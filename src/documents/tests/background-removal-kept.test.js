// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';

// Encoded pictures stand in for their pixels: the browser codecs are not available here.
const images = new Map();
vi.mock('../src/engine/picture-encoding.js', () => ({
  async encodeImageData(image) { const bytes = new Uint8Array([images.size + 1]); images.set(bytes[0], { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) }); return bytes; },
  async decodeToImageData(bytes) { const image = images.get(bytes[0]); return { ...image, data: new Uint8ClampedArray(image.data) }; },
}));
const { processedEdit, partPixels } = await import('../src/views/picture-adjustments.js');
const { removeBackground } = await import('../src/engine/picture-processing.js');
const { encodeImageData } = await import('../src/engine/picture-encoding.js');

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** White background, a gray ring that only a high sensitivity removes, a dark red disk; the top rows half transparent. */
function picture() {
  const W = 80, data = new Uint8ClampedArray(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const r = Math.hypot(x - 40, y - 40);
    data.set([...(r < 12 ? [150, 20, 20] : r < 22 ? [180, 180, 180] : [255, 255, 255]), y < 4 ? 128 : 255], (y * W + x) * 4);
  }
  return { data, width: W, height: W };
}

async function setup() {
  const drawing = new DOMParser().parseFromString(`<w:drawing ${NS}><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="P"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rOrig"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`, 'application/xml').documentElement;
  const parts = new Map([['rOrig', { bytes: await encodeImageData(picture()), contentType: 'image/png' }]]);
  let n = 0;
  const context = { parts, addPart(bytes, contentType) { const id = `rNew${++n}`; parts.set(id, { bytes, contentType }); return id; } };
  const shown = async () => partPixels(parts.get(drawing.getElementsByTagNameNS(A, 'blip')[0].getAttributeNS(R, 'embed')).bytes, 'image/png');
  return { drawing, context, shown };
}
const alphas = image => Array.from({ length: image.width * image.height }, (_, i) => image.data[i * 4 + 3]);

it('keeps a Remove Background result through later pixel edits', async () => {
  const { drawing, context, shown } = await setup();
  const original = await shown();
  // What the Remove Background dialog applies at 100% sensitivity; the marks it saves do not record that.
  const marks = { keep: [], remove: [], sensitivity: 1, region: { left: 0.08, top: 0.08, right: 0.92, bottom: 0.92 } };
  const mask = removeBackground(original, marks).mask;
  expect(removeBackground(original, { ...marks, sensitivity: 0.5 }).mask).not.toEqual(mask);
  await processedEdit({ background: { ...marks, mask } })(drawing, context);
  const removed = alphas(await shown());
  expect(removed.filter(a => a === 0).length).toBeGreaterThan(0);

  for (const change of [{ saturation: 1.5 }, { temperature: 4000 }, { sharpen: 0.5 }, { artistic: { id: 'blur', amount: 0.5 } }, { saturation: null }]) {
    await processedEdit(change)(drawing, context);
    expect(alphas(await shown()), JSON.stringify(change)).toEqual(removed);
  }
  // Clearing every other edit leaves the removal alone, from the original's colours.
  await processedEdit({ temperature: null, sharpen: null, artistic: null })(drawing, context);
  const back = await shown();
  expect(alphas(back)).toEqual(removed);
  expect(Array.from(back.data.filter((_, i) => i % 4 !== 3))).toEqual(Array.from(original.data.filter((_, i) => i % 4 !== 3)));
});

it('recomputes the removal when the shown picture is not one of this original', async () => {
  const { drawing, context, shown } = await setup();
  const original = await shown();
  const marks = { keep: [], remove: [], sensitivity: 0.5, region: { left: 0.08, top: 0.08, right: 0.92, bottom: 0.92 } };
  await processedEdit({ background: { ...marks, mask: removeBackground(original, marks).mask } })(drawing, context);
  // Another application's result at another size: the saved marks are all there is to go on.
  const blip = drawing.getElementsByTagNameNS(A, 'blip')[0];
  context.parts.set('rOther', { bytes: await encodeImageData({ width: 2, height: 2, data: new Uint8ClampedArray(16) }), contentType: 'image/png' });
  blip.setAttributeNS(R, 'r:embed', 'rOther');
  await processedEdit({ saturation: 1.5 })(drawing, context);
  expect(alphas(await shown())).toEqual(Array.from(removeBackground(original, marks).mask, (m, i) => Math.round(original.data[i * 4 + 3] * m / 255)));
});
