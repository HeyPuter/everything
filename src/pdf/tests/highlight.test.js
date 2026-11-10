import { expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFNumber, PDFString, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import {
  addHighlight,
  listHighlights,
  editHighlight,
  rectQuad,
  ensureMarkupAppearance,
} from '../src/core/highlight.js';
import { PdfSession } from '../src/core/document.js';

async function raster(bytes) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  try {
    const page = await (await task.promise).getPage(1);
    const canvas = createCanvas(400, 400),
      context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport: page.getViewport({ scale: 1 }) }).promise;
    return {
      pixels: context.getImageData(0, 0, 400, 400).data,
      annotations: await page.getAnnotations(),
      text: (await page.getTextContent()).items.map((i) => i.str).join(''),
    };
  } finally {
    await task.destroy();
  }
}

it('recolors highlights from other editors using counterclockwise QuadPoints without folding the shape', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  page.node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Highlight',
        F: 4,
        Rect: [40, 80, 140, 100],
        QuadPoints: [40, 80, 140, 80, 140, 100, 40, 100],
        C: [1, 1, 0],
        CA: 0.32,
      }),
    ),
  );
  const entry = listHighlights(doc, 0)[0];
  editHighlight(doc, 0, entry.id, { hex: '#00ffff' });
  const { pixels } = await raster(await doc.save());
  let filled = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 255) filled++;
  expect(filled).toBe(2000);
});

it('exports multiline highlight annotations without changing text or pixels outside the selected lines', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  page.drawRectangle({ x: 0, y: 0, width: 400, height: 400, color: rgb(0.7, 0.8, 0.9) });
  page.drawText('First line\nSecond line', { x: 40, y: 300, size: 20, lineHeight: 35 });
  const before = await raster(await doc.save());
  addHighlight(doc, 0, {
    quads: [
      rectQuad({ x: 38, y: 296, width: 110, height: 24 }),
      rectQuad({ x: 38, y: 261, width: 125, height: 24 }),
    ],
    text: 'First line\nSecond line',
  });
  const after = await raster(await doc.save());
  expect(after.text).toBe(before.text);
  expect(after.annotations).toHaveLength(1);
  expect(after.annotations[0]).toMatchObject({
    subtype: 'Highlight',
    contentsObj: { str: 'First line\nSecond line' },
  });
  let changed = 0,
    outside = 0;
  for (let y = 0; y < 400; y++)
    for (let x = 0; x < 400; x++) {
      const i = (y * 400 + x) * 4;
      if (after.pixels.slice(i, i + 4).some((n, j) => n !== before.pixels[i + j])) {
        changed++;
        if (!(
          (x >= 38 && x < 148 && y >= 80 && y < 104) ||
          (x >= 38 && x < 163 && y >= 115 && y < 139)
        ))
          outside++;
      }
    }
  expect(changed).toBeGreaterThan(4000);
  expect(outside).toBe(0);
});

it('preserves oblique geometry, recolors and deletes reopened highlights with exact undo', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  const quad = [40, 120, 140, 170, 50, 100, 150, 150];
  addHighlight(doc, 0, { quads: [quad], hex: '#ffff00', text: '斜め' });
  const original = await doc.save(),
    session = new PdfSession(original);
  const entry = listHighlights(await PDFDocument.load(original), 0)[0];
  expect(entry).toMatchObject({ quads: [quad], text: '斜め' });
  await session.change((d) => editHighlight(d, 0, entry.id, { hex: '#00ffff' }));
  const changed = listHighlights(await PDFDocument.load(session.bytes), 0)[0];
  expect(changed).toMatchObject({ hex: '#00ffff', quads: [quad], opacity: 0.32 });
  const view = await raster(session.bytes);
  const pixel = (x, y) => [...view.pixels.slice((y * 400 + x) * 4, (y * 400 + x) * 4 + 3)];
  expect(pixel(45, 235)).toEqual([255, 255, 255]);
  expect(pixel(95, 265)[0]).toBeLessThan(255);
  await session.change((d) => editHighlight(d, 0, changed.id, { remove: true }));
  expect(listHighlights(await PDFDocument.load(session.bytes), 0)).toEqual([]);
  session.undo();
  session.undo();
  expect(session.bytes).toEqual(original);
});

it('keeps unrelated annotations and rejects locked or invalid highlight changes atomically', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const link = doc.context.register(
    doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 30, 30] }),
  );
  page.node.addAnnot(link);
  addHighlight(doc, 0, { quads: [rectQuad({ x: 40, y: 60, width: 100, height: 20 })] });
  const id = listHighlights(doc, 0)[0].id;
  const highlightRef = page.node.Annots().get(1);
  const popupRef = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Popup',
      Parent: highlightRef,
      Rect: [10, 10, 100, 100],
    }),
  );
  doc.context.lookup(highlightRef).set(PDFName.of('Popup'), popupRef);
  page.node.addAnnot(popupRef);
  doc.context.lookup(page.node.Annots().get(1)).set(PDFName.of('F'), doc.context.obj(4 | 128));
  const session = new PdfSession(await doc.save());
  await expect(session.change((d) => editHighlight(d, 0, id, { remove: true }))).rejects.toThrow(
    'cannot be edited',
  );
  await expect(
    session.change((d) => addHighlight(d, 0, { quads: [[NaN]], hex: '#ffff00' })),
  ).rejects.toThrow();
  expect(session.dirty).toBe(false);
  expect(session.past).toHaveLength(0);
  const reopened = await PDFDocument.load(session.bytes);
  expect(reopened.getPage(0).node.Annots().size()).toBe(3);
  reopened.context
    .lookup(reopened.getPage(0).node.Annots().get(1))
    .set(PDFName.of('F'), reopened.context.obj(4));
  editHighlight(reopened, 0, id, { remove: true });
  const after = await PDFDocument.load(await reopened.save());
  expect(after.getPage(0).node.Annots().size()).toBe(1);
  expect(
    after.context.lookup(after.getPage(0).node.Annots().get(0)).get(PDFName.of('Subtype')),
  ).toBe(PDFName.of('Link'));
});

it('reads CMYK highlight colors so recoloring to the shown swatch is not a silent no-op', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  page.node.addAnnot(
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Highlight',
        F: 4,
        Rect: [40, 80, 140, 100],
        QuadPoints: [40, 100, 140, 100, 40, 80, 140, 80],
        C: [0, 1, 1, 0],
      }),
    ),
  );
  const [entry] = listHighlights(doc, 0);
  expect(entry.hex).toBe('#ff0000');
  expect(editHighlight(doc, 0, entry.id, { hex: '#ff0000' })).toBe(false);
  editHighlight(doc, 0, entry.id, { hex: '#00ff00' });
  expect(listHighlights(doc, 0)[0].hex).toBe('#00ff00');
});

it('lists nothing and can still add a highlight on a page whose Annots is not an array', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]).node.set(PDFName.of('Annots'), PDFNumber.of(5));
  expect(listHighlights(doc, 0)).toEqual([]);
  addHighlight(doc, 0, {
    quads: [rectQuad({ x: 20, y: 195, width: 40, height: 14 })],
    hex: '#ffff00',
  });
  expect(listHighlights(doc, 0)).toHaveLength(1);
});
it('creates uniquely named highlights without crypto.randomUUID, as in plain-http contexts', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
  try {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    addHighlight(doc, 0, { quads: [rectQuad({ x: 40, y: 80, width: 100, height: 20 })] });
    addHighlight(doc, 0, { quads: [rectQuad({ x: 40, y: 120, width: 100, height: 20 })] });
    expect(listHighlights(doc, 0)).toHaveLength(2);
    const names = doc
      .getPage(0)
      .node.Annots()
      .asArray()
      .map((ref) => doc.context.lookup(ref).lookup(PDFName.of('NM')).decodeText());
    expect(new Set(names).size).toBe(2);
    for (const name of names)
      expect(name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    if (original) Object.defineProperty(globalThis.crypto, 'randomUUID', original);
  }
});

it('underlines and strikes through text with native annotations whose lines stay inside the glyph box', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  page.drawText('Marked words', { x: 40, y: 300, size: 20 });
  const before = await raster(await doc.save());
  const quad = rectQuad({ x: 40, y: 296, width: 110, height: 24 });
  addHighlight(doc, 0, { quads: [quad], hex: '#d92626', kind: 'underline', text: 'Marked' });
  addHighlight(doc, 0, { quads: [quad], hex: '#1144cc', kind: 'strikeout' });
  const after = await raster(await doc.save());
  expect(after.text).toBe(before.text);
  expect(after.annotations.map((a) => a.subtype)).toEqual(['Underline', 'StrikeOut']);
  expect(listHighlights(doc, 0)).toMatchObject([
    { kind: 'underline', hex: '#d92626', text: 'Marked', opacity: 1 },
    { kind: 'strikeout', hex: '#1144cc', opacity: 1 },
  ]);
  const rows = { red: new Set(), blue: new Set() };
  let outside = 0;
  for (let y = 0; y < 400; y++)
    for (let x = 0; x < 400; x++) {
      const i = (y * 400 + x) * 4;
      const [r, g, b] = after.pixels.slice(i, i + 3);
      if (after.pixels.slice(i, i + 4).every((n, j) => n === before.pixels[i + j])) continue;
      if (x < 40 || x >= 150) outside++;
      if (r > 150 && g < 120 && b < 120) rows.red.add(y);
      else if (b > 150 && r < 120) rows.blue.add(y);
    }
  expect(outside).toBe(0);
  // The underline occupies the bottom of the 24 pt box (PDF y 297.2–298.9 → rows 101–103),
  // the strike its middle (PDF y 306.1–307.8 → rows 92–94).
  expect(Math.min(...rows.red)).toBeGreaterThanOrEqual(100);
  expect(Math.max(...rows.red)).toBeLessThanOrEqual(103);
  expect(Math.min(...rows.blue)).toBeGreaterThanOrEqual(91);
  expect(Math.max(...rows.blue)).toBeLessThanOrEqual(95);
  expect(rows.red.size).toBeGreaterThanOrEqual(1);
  expect(rows.blue.size).toBeGreaterThanOrEqual(1);
});

it('follows oblique quads for underlines and recolors or removes reopened markups with exact undo', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  const quad = [40, 120, 140, 170, 50, 100, 150, 150];
  addHighlight(doc, 0, { quads: [quad], hex: '#d92626', kind: 'strikeout' });
  const original = await doc.save(),
    session = new PdfSession(original);
  const entry = listHighlights(await PDFDocument.load(original), 0)[0];
  expect(entry).toMatchObject({ kind: 'strikeout', quads: [quad] });
  const view = await raster(original);
  const pixel = (x, y) => [...view.pixels.slice((y * 400 + x) * 4, (y * 400 + x) * 4 + 3)];
  // Halfway along the slanted box the strike sits about 45% up its height, not in the middle
  // of the page-aligned rectangle.
  expect(pixel(95, 266)[1]).toBeLessThan(200);
  expect(pixel(95, 250)).toEqual([255, 255, 255]);
  expect(pixel(95, 285)).toEqual([255, 255, 255]);
  await session.change((d) => editHighlight(d, 0, entry.id, { hex: '#00aa00' }));
  const changed = listHighlights(await PDFDocument.load(session.bytes), 0)[0];
  expect(changed).toMatchObject({ kind: 'strikeout', hex: '#00aa00', quads: [quad] });
  await session.change((d) => editHighlight(d, 0, changed.id, { remove: true }));
  expect(listHighlights(await PDFDocument.load(session.bytes), 0)).toEqual([]);
  session.undo();
  session.undo();
  expect(session.bytes).toEqual(original);
  expect(() => addHighlight(doc, 0, { quads: [quad], kind: 'wavy' })).toThrow('Choose a');
});

for (const kind of ['highlight', 'underline', 'strikeout'])
  for (const opacity of [0, 0.2, 0.7, 1, undefined])
    it(`recoloring ${kind} preserves opacity ${opacity ?? 'default'}`, async () => {
      const doc = await PDFDocument.create();
      doc.addPage([400, 400]);
      addHighlight(doc, 0, {
        kind,
        hex: '#ff0000',
        quads: [rectQuad({ x: 40, y: 200, width: 100, height: 30 })],
      });
      const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
      dict.delete(PDFName.of('AP'));
      if (opacity === undefined) dict.delete(PDFName.of('CA'));
      else dict.set(PDFName.of('CA'), PDFNumber.of(opacity));
      // Build a consistent source appearance with the imported annotation's opacity.
      ensureMarkupAppearance(doc, dict);
      const before = await raster(await doc.save());
      const entry = listHighlights(doc, 0)[0];
      editHighlight(doc, 0, entry.id, { hex: '#0000ff' });
      const bytes = await doc.save();
      const saved = await PDFDocument.load(bytes);
      expect(listHighlights(saved, 0)[0].opacity).toBe(opacity ?? 1);
      const after = await raster(bytes);
      // Red and blue both have a zero green component. Only a changed opacity changes
      // this channel, so compare all pixels, including the antialiased mark edges.
      let difference = 0;
      for (let i = 1; i < before.pixels.length; i += 4)
        difference = Math.max(difference, Math.abs(after.pixels[i] - before.pixels[i]));
      expect(difference).toBe(0);
    });

it('recoloring a markup with invalid opacity retains the default fallback', async () => {
  for (const kind of ['highlight', 'underline', 'strikeout'])
    for (const opacity of [-1, 2]) {
      const doc = await PDFDocument.create();
      doc.addPage([400, 400]);
      addHighlight(doc, 0, {
        kind,
        hex: '#ff0000',
        quads: [rectQuad({ x: 40, y: 200, width: 100, height: 30 })],
      });
      const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
      dict.set(PDFName.of('CA'), PDFNumber.of(opacity));
      editHighlight(doc, 0, listHighlights(doc, 0)[0].id, { hex: '#0000ff' });
      expect(listHighlights(await PDFDocument.load(await doc.save()), 0)[0].opacity).toBe(
        kind === 'highlight' ? 0.32 : 1,
      );
    }
});

for (const kind of ['highlight', 'underline', 'strikeout'])
  it(`content-locked ${kind} still permits recoloring and deletion without editing text`, async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    addHighlight(doc, 0, {
      kind,
      text: 'Keep these words',
      quads: [rectQuad({ x: 40, y: 200, width: 100, height: 30 })],
    });
    const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
    dict.set(PDFName.of('F'), PDFNumber.of(4 | 512));
    const contents = dict.get(PDFName.of('Contents'));
    const richText = PDFString.of(
      '<body xmlns="http://www.w3.org/1999/xhtml"><p>Keep these words</p></body>',
    );
    dict.set(PDFName.of('RC'), richText);
    const id = listHighlights(doc, 0)[0].id;
    editHighlight(doc, 0, id, { hex: '#1144cc' });
    expect(listHighlights(doc, 0)[0]).toMatchObject({ text: 'Keep these words', hex: '#1144cc' });
    expect(dict.get(PDFName.of('Contents'))).toBe(contents);
    expect(dict.get(PDFName.of('RC'))).toBe(richText);
    editHighlight(doc, 0, id, { remove: true });
    expect(listHighlights(doc, 0)).toEqual([]);
  });

it('read-only and locked markup flags still prohibit recoloring and deletion', async () => {
  for (const flag of [64, 128, 64 | 512, 128 | 512]) {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    addHighlight(doc, 0, { quads: [rectQuad({ x: 40, y: 200, width: 100, height: 30 })] });
    const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
    dict.set(PDFName.of('F'), PDFNumber.of(4 | flag));
    const id = listHighlights(doc, 0)[0].id;
    expect(() => editHighlight(doc, 0, id, { hex: '#1144cc' })).toThrow('cannot be edited');
    expect(() => editHighlight(doc, 0, id, { remove: true })).toThrow('cannot be edited');
    expect(doc.getPage(0).node.Annots().size()).toBe(1);
  }
});

// Recoloring a highlight left its modified date as it was, so the Comments panel and exported
// comments dated the change to when the highlight was first made.
it('records when a recolored markup was changed', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  addHighlight(doc, 0, { quads: [rectQuad({ x: 20, y: 200, width: 60, height: 14 })] });
  const dict = () => doc.context.lookup(doc.getPage(0).node.Annots().get(0));
  dict().set(PDFName.of('M'), PDFString.of('D:20200101000000Z'));
  const [entry] = listHighlights(doc, 0);
  editHighlight(doc, 0, entry.id, { hex: '#00ff00' });
  const modified = dict().lookup(PDFName.of('M')).decodeText();
  expect(modified).not.toBe('D:20200101000000Z');
  expect(modified.slice(2, 6)).toBe(String(new Date().getUTCFullYear()));
});
