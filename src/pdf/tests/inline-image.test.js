import { afterEach, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { inspectText, pageSource, parseContent, replaceText } from '../src/core/text-edit.js';
import { editImage, inspectImages } from '../src/core/image-edit.js';
import { editPath, inspectPaths } from '../src/core/path-edit.js';

const tasks = [];
afterEach(async () => {
  await Promise.all(tasks.splice(0).map((task) => task.destroy()));
});
const latin1 = (bytes) => String.fromCharCode(...bytes);
// Sample bytes that spell " EI " and "EI\n" inside the picture, as binary data can.
const samples = latin1([
  0x10, 0x20, 0x45, 0x49, 0x20, 0x80, 0x45, 0x49, 0x0a, 0xff, 0x00, 0x7f, 0x20, 0x45, 0x49, 0x20,
]);
const images = {
  raw: `BI /W 8 /H 2 /BPC 8 /CS /G ID ${samples} EI`,
  length: `BI /W 8 /H 2 /BPC 8 /CS /G /L 16 ID ${samples} EI`,
  // Stored deflate blocks keep the samples, " EI " included, as they are.
  flate: `BI /W 8 /H 2 /BPC 8 /CS /G /F /Fl ID ${latin1(deflateSync(Buffer.from(samples, 'latin1'), { level: 0 }))} EI`,
  // Complete Flate data followed by bytes in which an EI is followed by what is not content.
  flateTail: `BI /W 8 /H 2 /BPC 8 /CS /G /F /Fl ID ${latin1(deflateSync(Buffer.from(samples, 'latin1')))} EI q Q ${latin1([0x80, 0x81])} EI`,
  hex: `BI /W 8 /H 2 /BPC 8 /CS /G /F /AHx ID ${Buffer.from(samples, 'latin1').toString('hex')}> EI`,
  runLength: `BI /W 8 /H 2 /BPC 8 /CS /G /F /RL ID ${latin1([15])}${samples}${latin1([128])} EI`,
};
const text = (image) =>
  `q 80 0 0 40 100 100 cm ${image} Q 0 0 1 rg 200 100 60 30 re f ` +
  'BT /F 18 Tf 40 300 Td (Before) Tj ET q 80 0 0 40 100 200 cm ' +
  image +
  ' Q BT /F 18 Tf 40 340 Td (After) Tj ET';
async function fixture(source) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F: font.ref } }));
  page.node.set(
    PDFName.of('Contents'),
    doc.context.register(doc.context.flateStream(Uint8Array.from(source, (c) => c.charCodeAt(0)))),
  );
  return doc.save();
}
async function open(bytes) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  tasks.push(task);
  return (await task.promise).getPage(1);
}
async function read(bytes) {
  const doc = await PDFDocument.load(bytes);
  return { doc, runs: await inspectText(doc, 0, await open(bytes), pdfjs.OPS) };
}
/** The pixels of the page area where the inline images are painted. */
async function picture(bytes) {
  const page = await open(bytes);
  const viewport = page.getViewport({ scale: 1 });
  const canvas = createCanvas(400, 400);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return Array.from(canvas.getContext('2d').getImageData(100, 160, 80, 140).data);
}

for (const [kind, image] of Object.entries(images))
  it(`edits text, pictures and shapes around ${kind} inline image data that contains EI`, async () => {
    const bytes = await fixture(text(image));
    const { doc, runs } = await read(bytes);
    expect(runs.filter((run) => run.text).map((run) => [run.text, run.editable])).toEqual([
      ['Before', true],
      ['After', true],
    ]);
    const painted = await picture(bytes);
    // An untouched line saves as it was.
    expect(await replaceText(doc, 0, runs[0], 'Before')).toBe(false);
    await replaceText(
      doc,
      0,
      runs.find((run) => run.text === 'After'),
      'Later',
    );
    const edited = await doc.save();
    const source = pageSource((await PDFDocument.load(edited)).getPage(0));
    // Both inline images keep every byte, and still paint exactly the same pixels.
    expect(source.split(image).length).toBe(3);
    expect(await picture(edited)).toEqual(painted);
    expect((await read(edited)).runs.map((run) => run.text)).toContain('Later');
    // The shape after the first picture is found, and moves without touching the pictures.
    const after = await PDFDocument.load(edited);
    const [shape] = inspectPaths(after, 0);
    expect(shape.editable).toBe(true);
    editPath(after, 0, shape, { transform: shape.transform.map((n, i) => (i === 4 ? n + 5 : n)) });
    expect(pageSource(after.getPage(0)).split(image).length).toBe(3);
    expect(await picture(await after.save())).toEqual(painted);
  });

it('reads a JPEG inline image to its end-of-image marker', async () => {
  const canvas = createCanvas(8, 4);
  canvas.getContext('2d').fillStyle = '#c04020';
  canvas.getContext('2d').fillRect(0, 0, 8, 4);
  const jpeg = latin1(await canvas.encode('jpeg'));
  const image = `BI /W 8 /H 4 /BPC 8 /CS /RGB /F /DCT ID ${jpeg} EI`;
  const bytes = await fixture(text(image));
  const { doc, runs } = await read(bytes);
  const painted = await picture(bytes);
  await replaceText(
    doc,
    0,
    runs.find((run) => run.text === 'After'),
    'Later',
  );
  const edited = await doc.save();
  expect(pageSource((await PDFDocument.load(edited)).getPage(0)).split(image).length).toBe(3);
  expect(await picture(edited)).toEqual(painted);
});

it('refuses a page whose inline image does not say where its data ends', async () => {
  for (const image of [
    // Fax data has no end of its own to check, and no stated length.
    `BI /W 8 /H 2 /IM true /F /CCF ID ${samples} EI`,
    // Samples in a named color space have an unknown size.
    `BI /W 8 /H 2 /BPC 8 /CS /Cs1 ID ${samples} EI`,
    // A stated length that stops at an EI inside the data.
    `BI /W 8 /H 2 /BPC 8 /CS /G /L 12 ID ${samples} EI`,
    // Flate data cut short by an EI inside it.
    `BI /W 8 /H 2 /BPC 8 /CS /G /F /Fl ID ${samples} EI`,
  ]) {
    const bytes = await fixture(text(image));
    const doc = await PDFDocument.load(bytes);
    expect((await read(bytes)).runs).toEqual([]);
    expect(inspectImages(doc, 0)).toEqual([]);
    expect(inspectPaths(doc, 0)).toEqual([]);
  }
  // Other readers of content streams still refuse inline images outright.
  expect(() => parseContent(text(images.raw))).toThrow();
});

it('moves a picture on a page that also has inline images', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const png = await doc.embedPng(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { P: png.ref } }));
  const source = `q 80 0 0 40 100 100 cm ${images.raw} Q q 50 0 0 50 250 250 cm /P Do Q`;
  page.node.set(
    PDFName.of('Contents'),
    doc.context.register(doc.context.flateStream(Uint8Array.from(source, (c) => c.charCodeAt(0)))),
  );
  const loaded = await PDFDocument.load(await doc.save());
  const [picture] = inspectImages(loaded, 0);
  expect(picture.editable).toBe(true);
  editImage(loaded, 0, picture, {
    transform: picture.transform.map((n, i) => (i === 4 ? n - 20 : n)),
  });
  expect(pageSource(loaded.getPage(0)).startsWith(`q 80 0 0 40 100 100 cm ${images.raw} Q`)).toBe(
    true,
  );
});
