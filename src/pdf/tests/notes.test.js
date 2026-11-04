import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { addNote, listNotes, editNote, parsePdfDate, NOTE_SIZE } from '../src/core/notes.js';
import { PdfSession, rotateAllPages, rotatePage } from '../src/core/document.js';

async function raster(bytes) {
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    const page = await (await task.promise).getPage(1);
    const canvas = createCanvas(400, 400),
      context = canvas.getContext('2d');
    await page.render({
      canvasContext: context,
      viewport: page.getViewport({ scale: 1 }),
      annotationMode: pdfjs.AnnotationMode.ENABLE,
    }).promise;
    return {
      pixels: context.getImageData(0, 0, 400, 400).data,
      annotations: await page.getAnnotations(),
    };
  } finally {
    await task.destroy();
  }
}
function inked(pixels, box) {
  let inside = 0,
    outside = 0;
  for (let y = 0; y < 400; y++)
    for (let x = 0; x < 400; x++) {
      const i = (y * 400 + x) * 4;
      if (pixels[i] > 245 && pixels[i + 1] > 245 && pixels[i + 2] > 245) continue;
      const pdfY = 400 - y;
      if (x >= box.x && x <= box.x + box.width && pdfY <= box.y && pdfY >= box.y - box.height)
        inside++;
      else outside++;
    }
  return { inside, outside };
}

/**
 * The note icon as the reader sees it: the page rendered at its display orientation, the mark
 * found by its bounding box, and that box sampled onto a fixed grid so two orientations can
 * be compared pixel for pixel.
 */
async function iconSignature(bytes, pageNumber = 1) {
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    const page = await (await task.promise).getPage(pageNumber);
    const viewport = page.getViewport({ scale: 3 });
    const width = Math.ceil(viewport.width),
      height = Math.ceil(viewport.height);
    const canvas = createCanvas(width, height),
      context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    await page.render({
      canvasContext: context,
      viewport,
      annotationMode: pdfjs.AnnotationMode.ENABLE,
    }).promise;
    const data = context.getImageData(0, 0, width, height).data;
    let x0 = width,
      y0 = height,
      x1 = -1,
      y1 = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    if (x1 < 0) return null;
    const size = 12;
    const cells = [];
    for (let row = 0; row < size; row++)
      for (let column = 0; column < size; column++) {
        const x = Math.round(x0 + ((x1 - x0) * (column + 0.5)) / size);
        const y = Math.round(y0 + ((y1 - y0) * (row + 0.5)) / size);
        const i = (y * width + x) * 4;
        cells.push(Math.round((data[i] + data[i + 1] + data[i + 2]) / 3 / 32));
      }
    return { box: [x1 - x0 + 1, y1 - y0 + 1], cells };
  } finally {
    await task.destroy();
  }
}

describe('sticky notes', () => {
  it.each(['stream', 'direct dictionary', 'indirect dictionary'])(
    'turns notes with a shared appearance %s without changing other pages',
    async (sharing) => {
      const doc = await PDFDocument.create();
      for (let i = 0; i < 2; i++) {
        doc.addPage([400, 300]);
        addNote(doc, i, { x: 60, y: 250, text: `Note ${i + 1}` });
      }
      const notes = doc.getPages().map((page) => doc.context.lookup(page.node.Annots().get(0)));
      const ap = notes[0].lookup(PDFName.of('AP'));
      if (sharing === 'stream')
        notes[1].lookup(PDFName.of('AP')).set(PDFName.of('N'), ap.get(PDFName.of('N')));
      else {
        const value = sharing === 'indirect dictionary' ? doc.context.register(ap) : ap;
        for (const note of notes) note.set(PDFName.of('AP'), value);
      }
      const original = await iconSignature(await doc.save());
      rotatePage(doc, 0);
      let saved = await doc.save();
      expect(await iconSignature(saved, 1)).toEqual(original);
      expect(await iconSignature(saved, 2)).toEqual(original);
      // Page 1 and page 2 now need different icon matrices when both turn together.
      rotateAllPages(doc);
      saved = await doc.save();
      expect(await iconSignature(saved, 1)).toEqual(original);
      expect(await iconSignature(saved, 2)).toEqual(original);
      const objects = doc.context.enumerateIndirectObjects().length;
      for (let i = 0; i < 8; i++) rotateAllPages(doc);
      // Once isolated, further turns reuse each note's appearance without file growth.
      expect(doc.context.enumerateIndirectObjects()).toHaveLength(objects);
    },
  );

  it('preserves a note appearance also used as an ordinary page resource', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 300]);
    addNote(doc, 0, { x: 60, y: 250, text: 'Note' });
    const note = doc.context.lookup(page.node.Annots().get(0));
    const ap = note.lookup(PDFName.of('AP'));
    const originalRef = ap.get(PDFName.of('N'));
    page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Icon: originalRef } }));
    rotatePage(doc, 0);
    const original = doc.context.lookup(originalRef);
    expect(
      original.dict
        .lookup(PDFName.of('Matrix'))
        .asArray()
        .map((n) => n.asNumber()),
    ).toEqual([1, 0, 0, 1, 0, 0]);
    const saved = await PDFDocument.load(await doc.save());
    const rotated = saved.context.lookup(saved.getPage(0).node.Annots().get(0));
    expect(rotated.lookup(PDFName.of('AP')).get(PDFName.of('N'))).not.toBe(originalRef);
  });

  it('adds a note with a popup, draws its icon only where it sits, and lists it', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    const id = addNote(doc, 0, { x: 100, y: 300, text: '  Check this figure  ', author: 'Ada' });
    const bytes = await doc.save();
    const notes = listNotes(await PDFDocument.load(bytes), 0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      id,
      x: 100,
      y: 300,
      width: NOTE_SIZE,
      height: NOTE_SIZE,
      text: 'Check this figure',
      author: 'Ada',
      hex: '#f2c438',
      readOnly: false,
    });
    expect(notes[0].modified).toBeInstanceOf(Date);
    const { pixels, annotations } = await raster(bytes);
    expect(annotations.map((a) => a.subtype).sort()).toEqual(['Popup', 'Text']);
    expect(annotations.find((a) => a.subtype === 'Text')).toMatchObject({
      contentsObj: { str: 'Check this figure' },
      titleObj: { str: 'Ada' },
      noRotate: true,
    });
    const { inside, outside } = inked(pixels, {
      x: 100,
      y: 300,
      width: NOTE_SIZE,
      height: NOTE_SIZE,
    });
    expect(inside).toBeGreaterThan(150);
    expect(outside).toBe(0);
  });
  it('edits text, color and position, removes note and popup together, and undoes exactly', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    const id = addNote(doc, 0, { x: 40, y: 380, text: 'First' });
    // Acrobat keeps a rich-text copy of the note and shows it in preference to Contents.
    doc.context
      .lookup(doc.getPage(0).node.Annots().get(0))
      .set(PDFName.of('RC'), PDFHexString.fromText('<body><p>First</p></body>'));
    const original = await doc.save(),
      session = new PdfSession(original);
    await session.change((d) =>
      editNote(d, 0, id, { text: 'Second', hex: '#1144cc', x: 200, y: 200 }),
    );
    const loaded = await PDFDocument.load(session.bytes);
    const [note] = listNotes(loaded, 0);
    expect(note).toMatchObject({ text: 'Second', hex: '#1144cc', x: 200, y: 200 });
    expect(
      loaded.context.lookup(loaded.getPage(0).node.Annots().get(0)).has(PDFName.of('RC')),
    ).toBe(false);
    const popup = loaded.context.lookup(
      loaded.context.lookup(loaded.getPage(0).node.Annots().get(0)).get(PDFName.of('Popup')),
    );
    expect(
      popup
        .lookup(PDFName.of('Rect'))
        .asArray()
        .map((n) => n.asNumber())[0],
    ).toBe(200 + NOTE_SIZE + 4);
    const { pixels } = await raster(session.bytes);
    expect(inked(pixels, { x: 200, y: 200, width: NOTE_SIZE, height: NOTE_SIZE }).outside).toBe(0);
    expect(editNote(loaded, 0, id, { text: 'Second' })).toBe(false);
    await session.change((d) => editNote(d, 0, id, { remove: true }));
    expect((await PDFDocument.load(session.bytes)).getPage(0).node.Annots()?.size() || 0).toBe(0);
    session.undo();
    session.undo();
    expect(session.bytes).toEqual(original);
  });
  it('lists nothing and can still add a note on a page whose Annots is not an array', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]).node.set(PDFName.of('Annots'), PDFNumber.of(5));
    expect(listNotes(doc, 0)).toEqual([]);
    const id = addNote(doc, 0, { x: 40, y: 380, text: 'Here' });
    expect(listNotes(doc, 0).map((note) => note.id)).toEqual([id]);
    editNote(doc, 0, id, { remove: true });
    expect(listNotes(doc, 0)).toEqual([]);
  });
  it('rejects empty, oversized, misplaced, or read-only notes', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    expect(() => addNote(doc, 0, { x: 10, y: 10, text: '   ' })).toThrow('Write something');
    expect(() => addNote(doc, 0, { x: 10, y: 10, text: 'x'.repeat(5001) })).toThrow('5,000');
    expect(() => addNote(doc, 0, { x: NaN, y: 10, text: 'ok' })).toThrow('where the note');
    const id = addNote(doc, 0, { x: 10, y: 30, text: 'ok' });
    doc.context
      .lookup(doc.getPage(0).node.Annots().get(0))
      .set(PDFName.of('F'), doc.context.obj(4 | 64));
    expect(listNotes(doc, 0)[0].readOnly).toBe(true);
    expect(() => editNote(doc, 0, id, { text: 'no' })).toThrow('cannot be edited');
    expect(parsePdfDate('D:20260914120000Z')?.toISOString()).toBe('2026-09-14T12:00:00.000Z');
    // The offset after the seconds is the author's time zone; the instant shown must not shift.
    expect(parsePdfDate("D:20260914120000+02'00'")?.toISOString()).toBe('2026-09-14T10:00:00.000Z');
    expect(parsePdfDate("D:20260914120000-07'00'")?.toISOString()).toBe('2026-09-14T19:00:00.000Z');
    expect(parsePdfDate("D:20260914120000+05'30'")?.toISOString()).toBe('2026-09-14T06:30:00.000Z');
    expect(parsePdfDate("D:20260914003000-01'00")?.toISOString()).toBe('2026-09-14T01:30:00.000Z');
    expect(parsePdfDate('D:20260914120000')?.toISOString()).toBe('2026-09-14T12:00:00.000Z');
    expect(parsePdfDate('D:2026')?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(parsePdfDate('garbage')).toBeNull();
  });

  it('keeps a note icon upright however the page is turned', async () => {
    const shot = async (rotation, turnAfterwards = false) => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([400, 300]);
      if (!turnAfterwards) page.setRotation(degrees(rotation));
      addNote(doc, 0, { x: 60, y: 250, text: 'hello' });
      if (turnAfterwards) for (let turn = 0; turn < rotation / 90; turn++) rotatePage(doc, 0);
      return iconSignature(await doc.save());
    };
    const upright = await shot(0);
    expect(upright).not.toBeNull();
    // Every quarter turn, whether the page came in turned or was turned here, shows the same
    // icon: same footprint and the fold in the same corner.
    for (const rotation of [90, 180, 270])
      for (const turnAfterwards of [false, true]) {
        const turned = await shot(rotation, turnAfterwards);
        expect([rotation, turnAfterwards, turned.box]).toEqual([
          rotation,
          turnAfterwards,
          upright.box,
        ]);
        const differing = turned.cells.filter((cell, i) => cell !== upright.cells[i]).length;
        expect([rotation, turnAfterwards, differing]).toEqual([rotation, turnAfterwards, 0]);
      }
  });
});

it('content-locked notes reject text changes while preserving allowed property changes', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  const id = addNote(doc, 0, { x: 40, y: 300, text: 'Original words' });
  const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
  dict.set(PDFName.of('F'), PDFNumber.of(4 | 512));
  const contents = PDFHexString.fromText(' Original words\n');
  const richText = PDFString.of(
    '<body xmlns="http://www.w3.org/1999/xhtml"><p>Original words</p></body>',
  );
  dict.set(PDFName.of('Contents'), contents);
  dict.set(PDFName.of('RC'), richText);
  expect(() => editNote(doc, 0, id, { text: 'Changed words' })).toThrow('locked');
  expect(dict.get(PDFName.of('Contents'))).toBe(contents);
  editNote(doc, 0, id, { hex: '#1144cc', x: 80 });
  expect(listNotes(doc, 0)[0]).toMatchObject({ text: 'Original words', hex: '#1144cc', x: 80 });
  expect(dict.get(PDFName.of('Contents'))).toBe(contents);
  expect(dict.get(PDFName.of('RC'))).toBe(richText);
  editNote(doc, 0, id, { remove: true });
  expect(listNotes(doc, 0)).toEqual([]);
});

it('a property-locked note permits text edits without rebuilding its icon or moving its popup', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  const id = addNote(doc, 0, { x: 100, y: 300, text: 'Original words' });
  const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
  dict.set(PDFName.of('F'), PDFNumber.of(4 | 128));
  dict.set(PDFName.of('Rect'), doc.context.obj([100, 250, 160, 300]));
  const popup = dict.lookup(PDFName.of('Popup'));
  popup.set(PDFName.of('Rect'), doc.context.obj([170, 100, 350, 280]));
  const preserved = ['Rect', 'C', 'AP'].map((key) => [key, dict.get(PDFName.of(key))]);
  const popupRect = popup.get(PDFName.of('Rect'));
  const hex = listNotes(doc, 0)[0].hex;
  editNote(doc, 0, id, { text: 'Updated words', hex });
  expect(listNotes(doc, 0)[0].text).toBe('Updated words');
  for (const [key, value] of preserved) expect(dict.get(PDFName.of(key))).toBe(value);
  expect(popup.get(PDFName.of('Rect'))).toBe(popupRect);
  for (const change of [
    { text: 'Rejected words', hex: '#1144cc' },
    { x: 120 },
    { y: 320 },
    { remove: true },
  ])
    expect(() => editNote(doc, 0, id, change)).toThrow('locked');
  expect(listNotes(doc, 0)[0]).toMatchObject({
    text: 'Updated words',
    x: 100,
    y: 300,
    width: 60,
    height: 50,
    hex,
  });
});

it.each([64, 64 | 128, 64 | 512, 128 | 512])(
  'note flags %i continue to block all edits',
  async (flags) => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    const id = addNote(doc, 0, { x: 100, y: 300, text: 'Original words' });
    const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
    dict.set(PDFName.of('F'), PDFNumber.of(4 | flags));
    const before = await doc.save();
    expect(listNotes(doc, 0)[0].readOnly).toBe(true);
    for (const change of [
      { text: 'Changed words' },
      { hex: '#1144cc' },
      { x: 120 },
      { remove: true },
    ])
      expect(() => editNote(doc, 0, id, change)).toThrow('cannot be edited');
    expect(await doc.save()).toEqual(before);
  },
);

for (const flags of [0, 512]) {
  for (const [kind, contents] of [
    ['empty', '   \n'],
    ['long', 'x'.repeat(5001)],
    ['rich', ' Original words\n'],
  ]) {
    it(`preserves unchanged ${kind} note text while recoloring with flags ${flags}`, async () => {
      const doc = await PDFDocument.create();
      doc.addPage([400, 400]);
      const id = addNote(doc, 0, { x: 100, y: 300, text: 'Original words' });
      const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
      dict.set(PDFName.of('F'), PDFNumber.of(4 | flags));
      const raw = PDFHexString.fromText(contents);
      const rich = PDFString.of(
        '<body xmlns="http://www.w3.org/1999/xhtml"><p>Original words</p></body>',
      );
      dict.set(PDFName.of('Contents'), raw);
      dict.set(PDFName.of('RC'), rich);
      editNote(doc, 0, id, { text: listNotes(doc, 0)[0].text, hex: '#1144cc' });
      expect(listNotes(doc, 0)[0].hex).toBe('#1144cc');
      expect(dict.get(PDFName.of('Contents'))).toBe(raw);
      expect(dict.get(PDFName.of('RC'))).toBe(rich);
    });
  }
}

it('rejects invalid replacement text without changing a note or its color', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  const id = addNote(doc, 0, { x: 100, y: 300, text: 'Original words' });
  const before = await doc.save();
  for (const [text, message] of [
    ['  ', 'Write something'],
    ['x'.repeat(5001), '5,000'],
  ]) {
    expect(() => editNote(doc, 0, id, { text, hex: '#1144cc' })).toThrow(message);
    expect(await doc.save()).toEqual(before);
  }
});

it.each([0, 90, 270])(
  'text-only note edits preserve custom appearance at rotation %i',
  async (rotation) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    page.setRotation(degrees(rotation));
    const id = addNote(doc, 0, { x: 100, y: 300, text: 'Original words' });
    const dict = doc.context.lookup(page.node.Annots().get(0));
    dict.set(PDFName.of('F'), PDFNumber.of(4));
    dict.set(PDFName.of('Rect'), doc.context.obj([100, 250, 160, 300]));
    const stream = doc.context.flateStream('0 0 1 rg 0 0 m 60 0 l 30 50 l h f', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 60, 50],
    });
    dict.set(PDFName.of('AP'), doc.context.obj({ N: doc.context.register(stream) }));
    const popup = dict.lookup(PDFName.of('Popup'));
    popup.set(PDFName.of('Rect'), doc.context.obj([180, 100, 350, 280]));
    const original = (await raster(await doc.save())).pixels;
    const preserved = ['Rect', 'C', 'AP'].map((key) => [key, dict.get(PDFName.of(key))]);
    const popupRect = popup.get(PDFName.of('Rect'));
    editNote(doc, 0, id, { text: 'Updated words', hex: listNotes(doc, 0)[0].hex });
    const updated = (await raster(await doc.save())).pixels;
    expect(Buffer.from(updated).equals(Buffer.from(original))).toBe(true);
    for (const [key, value] of preserved) expect(dict.get(PDFName.of(key))).toBe(value);
    expect(popup.get(PDFName.of('Rect'))).toBe(popupRect);
    expect(listNotes(doc, 0)[0].text).toBe('Updated words');
  },
);

it('adding a legacy icon after a text edit preserves the existing bounds and popup', async () => {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  const id = addNote(doc, 0, { x: 100, y: 300, text: 'Original words' });
  const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
  dict.delete(PDFName.of('AP'));
  dict.set(PDFName.of('Rect'), doc.context.obj([100, 250, 160, 300]));
  const popup = dict.lookup(PDFName.of('Popup'));
  popup.set(PDFName.of('Rect'), doc.context.obj([180, 100, 350, 280]));
  const popupRect = popup.get(PDFName.of('Rect'));
  editNote(doc, 0, id, { text: 'Updated words' });
  expect(listNotes(doc, 0)[0]).toMatchObject({
    text: 'Updated words',
    width: 60,
    height: 50,
    hasAppearance: true,
  });
  expect(popup.get(PDFName.of('Rect'))).toBe(popupRect);
});

it.each(['custom icon', 'custom opacity'])(
  'text edits preserve legacy notes with %s',
  async (kind) => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    const id = addNote(doc, 0, { x: 100, y: 300, text: 'Original words' });
    const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
    dict.delete(PDFName.of('AP'));
    if (kind === 'custom icon') dict.set(PDFName.of('Name'), PDFName.of('Help'));
    else dict.set(PDFName.of('CA'), PDFNumber.of(0.5));
    const rect = dict.get(PDFName.of('Rect'));
    editNote(doc, 0, id, { text: 'Updated words' });
    expect(dict.has(PDFName.of('AP'))).toBe(false);
    expect(dict.get(PDFName.of('Rect'))).toBe(rect);
    expect(listNotes(doc, 0)[0].text).toBe('Updated words');
  },
);

it.each([0, 0.2, 0.5, 0.8, 1])(
  'recoloring a note preserves its rendered opacity %s',
  async (opacity) => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    const id = addNote(doc, 0, { x: 100, y: 300, text: 'Translucent note', hex: '#ff0000' });
    const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
    dict.set(PDFName.of('CA'), PDFNumber.of(opacity));
    const stream = doc.context.flateStream('/GS gs 1 0 0 rg 0 0 20 20 re f', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 20, 20],
      Resources: { ExtGState: { GS: { Type: 'ExtGState', ca: opacity, CA: opacity } } },
    });
    dict.set(PDFName.of('AP'), doc.context.obj({ N: doc.context.register(stream) }));
    const sample = (pixels) =>
      Array.from(pixels.slice((115 * 400 + 105) * 4, (115 * 400 + 105) * 4 + 3));
    const before = sample((await raster(await doc.save())).pixels);
    expect(Math.abs(before[1] - 255 * (1 - opacity))).toBeLessThanOrEqual(1);
    editNote(doc, 0, id, { hex: '#0000ff' });
    const bytes = await doc.save();
    const after = sample((await raster(bytes)).pixels);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(255);
    if (opacity === 0)
      expect(
        inked((await raster(bytes)).pixels, { x: 100, y: 300, width: 20, height: 20 }),
      ).toEqual({ inside: 0, outside: 0 });
    const saved = await PDFDocument.load(bytes);
    const note = saved.context.lookup(saved.getPage(0).node.Annots().get(0));
    expect(note.lookup(PDFName.of('CA')).asNumber()).toBe(opacity);
  },
);

it.each([undefined, -1, 2])(
  'recoloring a note with opacity %s keeps the opaque fallback',
  async (opacity) => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    const id = addNote(doc, 0, { x: 100, y: 300, text: 'Imported note' });
    const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
    if (opacity === undefined) dict.delete(PDFName.of('CA'));
    else dict.set(PDFName.of('CA'), PDFNumber.of(opacity));
    editNote(doc, 0, id, { hex: '#0000ff' });
    const { pixels } = await raster(await doc.save());
    expect(Array.from(pixels.slice((115 * 400 + 105) * 4, (115 * 400 + 105) * 4 + 3))).toEqual([
      0, 0, 255,
    ]);
  },
);

it.each([false, true])(
  'property edits preserve imported note and popup dimensions (move: %s)',
  async (move) => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    const id = addNote(doc, 0, { x: 100, y: 300, text: 'Imported note' });
    const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
    dict.set(PDFName.of('Rect'), doc.context.obj([100, 250, 160, 300]));
    const popup = dict.lookup(PDFName.of('Popup'));
    popup.set(PDFName.of('Rect'), doc.context.obj([180, 100, 350, 280]));
    editNote(doc, 0, id, { hex: '#0000ff', ...(move ? { x: 120, y: 270 } : {}) });
    expect(listNotes(doc, 0)[0]).toMatchObject({
      x: move ? 120 : 100,
      y: move ? 270 : 300,
      width: 60,
      height: 50,
      hex: '#0000ff',
    });
    expect(
      popup
        .lookup(PDFName.of('Rect'))
        .asArray()
        .map((n) => n.asNumber()),
    ).toEqual(move ? [200, 70, 370, 250] : [180, 100, 350, 280]);
  },
);

it('lists a note once, not its replies and review states that Acrobat leaves visible', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const id = addNote(doc, 0, { x: 100, y: 300, text: 'Check the totals' });
  const parent = page.node.Annots().get(0);
  // Acrobat's replies and states: Text annotations at the parent's spot, flagged to print.
  const thread = (fields) =>
    page.node.Annots().push(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: [100, 280, 120, 300],
          F: 28,
          Name: 'Comment',
          IRT: parent,
          ...fields,
        }),
      ),
    );
  thread({ Contents: PDFHexString.fromText('Done') });
  thread({
    Contents: PDFHexString.fromText('Accepted set by Grace'),
    State: PDFString.of('Accepted'),
    StateModel: PDFString.of('Review'),
  });
  // A note grouped with another comment is drawn as part of it, so it stays listed.
  thread({ Contents: PDFHexString.fromText('Grouped'), RT: 'Group' });
  expect(listNotes(doc, 0).map((note) => [note.id === id, note.text])).toEqual([
    [true, 'Check the totals'],
    [false, 'Grouped'],
  ]);
});

it('lists a reply whose note is gone as a note, so it can still be opened or deleted', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  addNote(doc, 0, { x: 100, y: 300, text: 'Check the totals' });
  const parent = page.node.Annots().get(0);
  const reply = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [100, 280, 120, 300],
      F: 28,
      Name: 'Comment',
      IRT: parent,
      Contents: PDFHexString.fromText('Done'),
    }),
  );
  page.node.Annots().push(reply);
  // Another editor deleted the note and left its reply behind.
  page.node.Annots().remove(1);
  page.node.Annots().remove(0);
  expect(listNotes(doc, 0).map((note) => note.text)).toEqual(['Done']);
  editNote(doc, 0, reply.toString(), { remove: true });
  expect(page.node.Annots().size()).toBe(0);
  // Nor is a note that readers do not show (NoView): the Comments panel lists its reply too.
  addNote(doc, 0, { x: 100, y: 300, text: 'Unseen' });
  const unseen = page.node.Annots().get(0);
  doc.context.lookup(unseen).set(PDFName.of('F'), PDFNumber.of(32));
  doc.context.lookup(reply).set(PDFName.of('IRT'), unseen);
  page.node.Annots().push(reply);
  expect(listNotes(doc, 0).map((note) => note.text)).toEqual(['Done']);
});

it('moving a note keeps its own icon and carries its popup along', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const id = addNote(doc, 0, { x: 100, y: 300, text: 'Moved' });
  const dict = doc.context.lookup(page.node.Annots().get(0));
  // Another editor's icon, which this one cannot draw again.
  const icon = doc.context.register(
    doc.context.stream('0 0 1 rg 0 0 24 24 re f', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 24, 24],
    }),
  );
  dict.set(PDFName.of('AP'), doc.context.obj({ N: icon }));
  dict.set(PDFName.of('Rect'), doc.context.obj([100, 276, 124, 300]));
  const popup = dict.lookup(PDFName.of('Popup'));
  popup.set(PDFName.of('Rect'), doc.context.obj([130, 180, 310, 300]));
  editNote(doc, 0, id, { x: 150, y: 250 });
  const moved = doc.context.lookup(page.node.Annots().get(0));
  const numbersOf = (d) =>
    d
      .lookup(PDFName.of('Rect'))
      .asArray()
      .map((n) => n.asNumber());
  expect(moved.lookup(PDFName.of('AP')).get(PDFName.of('N'))).toBe(icon);
  expect(numbersOf(moved)).toEqual([150, 226, 174, 250]);
  expect(numbersOf(moved.lookup(PDFName.of('Popup')))).toEqual([180, 130, 360, 250]);
  expect(listNotes(doc, 0)[0]).toMatchObject({ x: 150, y: 250, text: 'Moved' });
});
