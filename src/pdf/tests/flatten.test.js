import { commentPdf } from './fixtures/indirect-comments.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFBool, PDFName, PDFHexString, PDFString, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { flattenCounts, flattenDocument } from '../src/core/flatten.js';
import { addNote, listNotes } from '../src/core/notes.js';
import { addHighlight, listHighlights, rectQuad } from '../src/core/highlight.js';
import { addLink, listLinks } from '../src/core/links.js';
import { extractPages } from '../src/core/pages.js';
import { addReply, addShapeAnnotation, setReviewState } from '../src/core/annotations.js';

afterEach(() => vi.restoreAllMocks());
async function view(bytes, intent = 'display') {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  try {
    const page = await (await task.promise).getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport, intent }).promise;
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
      annotations: await page.getAnnotations(),
    };
  } finally {
    await task.destroy();
  }
}
function difference(a, b) {
  let sum = 0;
  for (let i = 0; i < a.pixels.length; i += 4)
    for (let c = 0; c < 3; c++) sum += Math.abs(a.pixels[i + c] - b.pixels[i + c]);
  return sum / ((a.pixels.length / 4) * 3);
}
async function reviewed() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url))),
  );
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  page.drawText('Name of the applicant', { x: 40, y: 340, size: 14, font });
  const field = doc.getForm().createTextField('applicant');
  field.setText('Ada Lovelace');
  field.addToPage(page, { x: 40, y: 280, width: 220, height: 30, font });
  addHighlight(doc, 0, {
    quads: [rectQuad({ x: 40, y: 336, width: 150, height: 18 })],
    hex: '#ffff00',
  });
  addNote(doc, 0, { x: 300, y: 340, text: 'Check spelling', hex: '#f2c438', author: 'Grace' });
  addLink(doc, 0, { rect: { x: 40, y: 40, width: 100, height: 20 }, url: 'example.com' });
  return PDFDocument.load(await doc.save());
}

describe('flattening', () => {
  it('bakes fields and comments into the page, keeps links, and looks the same afterwards', async () => {
    const doc = await reviewed();
    expect(flattenCounts(doc)).toEqual({ fields: 1, annotations: 2 });
    const before = await view(await doc.save());
    expect(flattenDocument(doc)).toEqual({ fields: 1, annotations: 2 });
    const bytes = await doc.save();
    const after = await view(bytes);
    expect(after.annotations.map((a) => a.subtype)).toEqual(['Link']);
    expect(difference(before, after)).toBeLessThan(1.5);
    const reopened = await PDFDocument.load(bytes);
    expect(reopened.getForm().getFields()).toHaveLength(0);
    expect(listNotes(reopened, 0)).toEqual([]);
    expect(listHighlights(reopened, 0)).toEqual([]);
    expect(listLinks(reopened, 0)).toHaveLength(1);
    // The highlight is now in the content: its translucent yellow still tints the line.
    const y = 400 - 345,
      i = (y * after.width + 100) * 4;
    expect(after.pixels[i]).toBeGreaterThan(200);
    expect(after.pixels[i + 2]).toBeLessThan(200);
    expect(flattenDocument(reopened)).toBe(false);
  });
  it('counts a comment with its replies and review states as one', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    const id = addShapeAnnotation(doc, 0, {
      kind: 'square',
      rect: { x: 50, y: 50, width: 100, height: 80 },
      text: 'Check',
    });
    addReply(doc, 0, addReply(doc, 0, id, { text: 'Done' }), { text: 'Thanks' });
    setReviewState(doc, 0, id, { state: 'Completed', author: 'Ada' });
    expect(flattenCounts(doc)).toEqual({ fields: 0, annotations: 1 });
    expect(flattenDocument(doc)).toEqual({ fields: 0, annotations: 1 });
    expect(doc.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
  });
  it('flattens only what was asked for', async () => {
    const onlyFields = await reviewed();
    expect(flattenDocument(onlyFields, { annotations: false })).toEqual({
      fields: 1,
      annotations: 0,
    });
    expect(onlyFields.getForm().getFields()).toHaveLength(0);
    expect(listNotes(onlyFields, 0)).toHaveLength(1);
    const onlyComments = await reviewed();
    expect(flattenDocument(onlyComments, { fields: false })).toEqual({ fields: 0, annotations: 2 });
    expect(onlyComments.getForm().getFields()).toHaveLength(1);
    expect(listNotes(onlyComments, 0)).toEqual([]);
    const plain = await PDFDocument.create();
    plain.addPage([100, 100]);
    expect(flattenCounts(plain)).toEqual({ fields: 0, annotations: 0 });
    expect(flattenDocument(plain)).toBe(false);
  });
  it('keeps a signature field without an appearance and flattens the other fields', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const form = doc.getForm();
    form.createTextField('name').addToPage(page, { x: 50, y: 700, width: 200, height: 24 });
    // An unsigned signature field with a widget but no appearance stream, as blank forms have.
    const signature = doc.context.register(
      doc.context.obj({
        FT: 'Sig',
        T: 'Signature1',
        Type: 'Annot',
        Subtype: 'Widget',
        Rect: [50, 600, 250, 650],
        F: 4,
        P: page.ref,
      }),
    );
    doc.catalog.getOrCreateAcroForm().Fields().push(signature);
    page.node.addAnnot(signature);
    const reopened = await PDFDocument.load(await doc.save());
    expect(
      reopened
        .getForm()
        .getFields()
        .map((f) => f.constructor.name),
    ).toEqual(['PDFTextField', 'PDFSignature']);
    expect(flattenCounts(reopened)).toEqual({ fields: 2, annotations: 0 });
    expect(flattenDocument(reopened)).toEqual({
      fields: 1,
      annotations: 0,
      unflattened: { fields: 1, annotations: 0 },
    });
    expect(
      reopened
        .getForm()
        .getFields()
        .map((f) => f.constructor.name),
    ).toEqual(['PDFSignature']);
    const sheet = reopened.getPage(0);
    expect(sheet.node.Annots()?.size() ?? 0).toBe(1);
    // The text field is drawn into the page; the signature remains available to other readers.
    expect(sheet.node.Resources()?.lookup(PDFName.of('XObject'))?.entries().length).toBe(1);
    const seen = await view(await reopened.save());
    expect(seen.annotations.map((a) => a.subtype)).toEqual(['Widget']);
  });
  it('drops hidden annotations without drawing them and handles a missing appearance', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const hidden = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [10, 10, 100, 100],
        F: 2,
        AP: {
          N: doc.context.register(
            doc.context.flateStream('1 0 0 rg 0 0 90 90 re f', {
              Type: 'XObject',
              Subtype: 'Form',
              BBox: [0, 0, 90, 90],
            }),
          ),
        },
      }),
    );
    const bare = doc.context.register(
      doc.context.obj({ Type: 'Annot', Subtype: 'Circle', Rect: [110, 110, 190, 190] }),
    );
    page.node.addAnnot(hidden);
    page.node.addAnnot(bare);
    expect(flattenDocument(doc)).toEqual({
      fields: 0,
      annotations: 1,
      unflattened: { fields: 0, annotations: 1 },
    });
    expect(page.node.Annots().size()).toBe(1);
    const seen = await view(await doc.save());
    // The hidden red square never appeared.
    const i = (150 * seen.width + 50) * 4;
    expect(Array.from(seen.pixels.subarray(i, i + 3))).toEqual([255, 255, 255]);
    expect(page.node.Resources()?.lookup(PDFName.of('XObject'))?.entries().length ?? 0).toBe(0);
  });
});

describe('flattening without losing unpainted content', () => {
  it('generates a visible appearance for a legacy note without one', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const note = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [10, 10, 30, 30],
        Contents: PDFHexString.fromText('Keep this comment'),
        F: 4,
      }),
    );
    page.node.addAnnot(note);
    expect(flattenDocument(doc)).toEqual({ fields: 0, annotations: 1 });
    const saved = await PDFDocument.load(await doc.save());
    expect(saved.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
    expect(saved.getPage(0).node.Contents()).toBeDefined();
    const seen = await view(await saved.save());
    const pixel = (180 * seen.width + 20) * 4;
    expect(Array.from(seen.pixels.subarray(pixel, pixel + 3))).not.toEqual([255, 255, 255]);
  });
  it.each([
    'missing',
    'rect',
    'bbox',
    'matrix-type',
    'matrix-singular',
    'state',
    'compressed-stream',
  ])('preserves an annotation and its popup with an unusable %s appearance', async (bad) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const ctx = doc.context;
    const stream =
      bad === 'compressed-stream'
        ? ctx.stream(Uint8Array.of(1, 2, 3), {
            Subtype: 'Form',
            BBox: [0, 0, 20, 20],
            Filter: 'FlateDecode',
          })
        : ctx.flateStream('1 0 0 rg 0 0 20 20 re f', { Subtype: 'Form', BBox: [0, 0, 20, 20] });
    const streamRef = ctx.register(stream);
    const dict = ctx.obj({
      Type: 'Annot',
      Subtype: 'FreeText',
      Rect: [10, 10, 30, 30],
      Contents: PDFHexString.fromText('Keep this content'),
      F: 4,
      AP: { N: streamRef },
    });
    if (bad === 'missing') dict.delete(PDFName.of('AP'));
    if (bad === 'rect') dict.set(PDFName.of('Rect'), ctx.obj([10, 10, 10, 30]));
    if (bad === 'bbox') stream.dict.set(PDFName.of('BBox'), ctx.obj([0, 0, 'bad', 20]));
    if (bad === 'matrix-type') stream.dict.set(PDFName.of('Matrix'), ctx.obj(4));
    if (bad === 'matrix-singular')
      stream.dict.set(PDFName.of('Matrix'), ctx.obj([1, 1, 1, 1, 0, 0]));
    if (bad === 'state') {
      dict.set(PDFName.of('AP'), ctx.obj({ N: { On: streamRef } }));
      dict.set(PDFName.of('AS'), PDFName.of('Off'));
    }
    const ref = ctx.register(dict);
    const popup = ctx.register(
      ctx.obj({ Type: 'Annot', Subtype: 'Popup', Parent: ref, Rect: [40, 10, 150, 100] }),
    );
    dict.set(PDFName.of('Popup'), popup);
    page.node.addAnnot(ref);
    page.node.addAnnot(popup);
    const before = dict.toString();
    expect(flattenDocument(doc)).toEqual({
      fields: 0,
      annotations: 0,
      unflattened: { fields: 0, annotations: 1 },
    });
    const saved = await PDFDocument.load(await doc.save());
    expect(saved.getPage(0).node.Annots().size()).toBe(2);
    expect(saved.context.lookup(saved.getPage(0).node.Annots().get(0)).toString()).toBe(before);
    expect(saved.getPage(0).node.Contents()).toBeUndefined();
  });
  it('keeps an entire shared field if any of its visible widgets cannot be painted', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const second = doc.addPage([200, 200]);
    const field = doc.getForm().createTextField('shared');
    field.setText('Keep this value');
    field.addToPage(page, { x: 20, y: 30, width: 140, height: 30 });
    field.addToPage(second, { x: 20, y: 30, width: 140, height: 30 });
    const loaded = await PDFDocument.load(await doc.save());
    const widgets = loaded.getForm().getTextField('shared').acroField.getWidgets();
    widgets[1].dict.set(PDFName.of('Rect'), loaded.context.obj([20, 30, 20, 30]));
    expect(flattenDocument(loaded)).toEqual({
      fields: 0,
      annotations: 0,
      unflattened: { fields: 1, annotations: 0 },
    });
    const saved = await PDFDocument.load(await loaded.save());
    expect(saved.getForm().getTextField('shared').getText()).toBe('Keep this value');
    expect(saved.getPages().map((p) => p.node.Annots().size())).toEqual([1, 1]);
    expect(saved.getPage(0).node.Contents()).toBeUndefined();
  });
  it('keeps a field when appearance generation fails rather than flattening a stale value', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const field = doc.getForm().createTextField('name');
    field.setText('Old');
    field.addToPage(page, { x: 20, y: 30, width: 140, height: 30 });
    field.setText('漢字');
    expect(flattenDocument(doc)).toEqual({
      fields: 0,
      annotations: 0,
      unflattened: { fields: 1, annotations: 0 },
    });
    const saved = await PDFDocument.load(await doc.save());
    expect(saved.getForm().getTextField('name').getText()).toBe('漢字');
    expect(saved.getPage(0).node.Annots().size()).toBe(1);
    expect(saved.getPage(0).node.Contents()).toBeUndefined();
  });
  it('flattens safe content while retaining an unsupported comment, with the same rendering after save/reopen', async () => {
    const doc = await reviewed();
    const ref = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'FreeText',
        Rect: [10, 10, 100, 30],
        Contents: PDFHexString.fromText('Keep me'),
        DA: PDFString.of('/Helv 10 Tf 0 g'),
        F: 4,
      }),
    );
    doc.getPage(0).node.addAnnot(ref);
    const before = await view(await doc.save());
    expect(flattenDocument(doc)).toEqual({
      fields: 1,
      annotations: 2,
      unflattened: { fields: 0, annotations: 1 },
    });
    const after = await view(await doc.save());
    expect(after.annotations.map((a) => a.subtype)).toEqual(['Link', 'FreeText']);
    expect(difference(before, after)).toBeLessThan(1.5);
  });
  it.each(['highlight', 'underline', 'strikeout'])(
    'regenerates a supported %s with missing appearance, keeping its opacity',
    async (kind) => {
      const doc = await PDFDocument.create();
      doc.addPage([200, 200]);
      addHighlight(doc, 0, {
        kind,
        quads: [rectQuad({ x: 20, y: 40, width: 100, height: 20 })],
        hex: '#ff0000',
      });
      const dict = doc.context.lookup(doc.getPage(0).node.Annots().get(0));
      const before = await view(await doc.save());
      dict.delete(PDFName.of('AP'));
      expect(flattenDocument(doc)).toEqual({ fields: 0, annotations: 1 });
      const after = await view(await doc.save());
      expect(difference(before, after)).toBeLessThan(0.01);
    },
  );
});

it('regenerates missing field appearances and appearances the form says are stale', async () => {
  for (const stale of [false, true]) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const field = doc.getForm().createTextField('name');
    field.setText('Old');
    field.addToPage(page, { x: 20, y: 40, width: 150, height: 30 });
    const loaded = await PDFDocument.load(await doc.save());
    const savedField = loaded.getForm().getTextField('name');
    savedField.acroField.setValue(PDFHexString.fromText('New value'));
    if (stale) loaded.getForm().acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
    else savedField.acroField.getWidgets()[0].dict.delete(PDFName.of('AP'));
    expect(flattenDocument(loaded)).toEqual({ fields: 1, annotations: 0 });
    const task = pdfjs.getDocument({
      data: await loaded.save(),
      standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
        .pathname,
    });
    try {
      const page = await (await task.promise).getPage(1);
      expect((await page.getTextContent()).items.map((item) => item.str).join('')).toContain(
        'New value',
      );
    } finally {
      await task.destroy();
    }
  }
});

it.each([2, 32])(
  'intentionally removes hidden/no-view fields and annotations (flag %s) without painting',
  async (flag) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const field = doc.getForm().createTextField('hidden');
    field.addToPage(page, { x: 10, y: 40, width: 100, height: 20 });
    field.setText('漢字');
    field.acroField.getWidgets()[0].dict.set(PDFName.of('F'), doc.context.obj(flag));
    const hidden = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'FreeText',
        Rect: [10, 100, 100, 120],
        F: flag,
        Contents: PDFHexString.fromText('Hidden'),
      }),
    );
    page.node.addAnnot(hidden);
    expect(flattenDocument(doc)).toEqual({ fields: 1, annotations: 1 });
    const saved = await PDFDocument.load(await doc.save());
    expect(saved.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
    expect(saved.getPage(0).node.Contents()).toBeUndefined();
  },
);

for (const flags of [0, 4, 32, 36, 6, 38]) {
  it(`preserves screen and print visibility for fields and comments with flags ${flags}`, async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const field = doc.getForm().createTextField('name');
    field.setText('Ada');
    field.addToPage(page, { x: 20, y: 20, width: 140, height: 30 });
    field.acroField.getWidgets()[0].dict.set(PDFName.of('F'), doc.context.obj(flags));
    const appearance = doc.context.register(
      doc.context.flateStream('1 0 0 rg 0 0 40 40 re f', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 40, 40],
        Resources: {},
      }),
    );
    page.node.addAnnot(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Square',
          Rect: [20, 100, 60, 140],
          F: flags,
          AP: { N: appearance },
        }),
      ),
    );
    const before = await doc.save();
    expect(flattenDocument(doc)).toEqual({ fields: 1, annotations: 1 });
    const after = await doc.save();
    for (const intent of ['display', 'print']) {
      expect(
        difference(await view(before, intent), await view(after, intent)),
        intent,
      ).toBeLessThan(0.01);
    }
    const saved = await PDFDocument.load(after);
    expect(saved.getForm().getFields()).toHaveLength(0);
    expect(saved.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
  });
}

for (const base of ['ON', 'OFF']) {
  for (const flags of [0, 36]) {
    it(`combines annotation flags ${flags} with existing layers whose base state is ${base}`, async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([200, 200]);
      const ctx = doc.context;
      const hidden = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Hidden') }));
      const visible = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Visible') }));
      doc.catalog.set(
        PDFName.of('OCProperties'),
        ctx.obj({
          OCGs: [hidden, visible],
          D: { BaseState: base, ON: [visible], OFF: [hidden], Order: [hidden, visible] },
          Configs: [{ Name: PDFString.of('Review'), BaseState: 'OFF', ON: [hidden] }],
        }),
      );
      const appearance = ctx.register(
        ctx.flateStream('1 0 0 rg 0 0 30 30 re f', {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 30, 30],
          Resources: {},
        }),
      );
      for (const [i, layer] of [undefined, visible, hidden].entries()) {
        page.node.addAnnot(
          ctx.register(
            ctx.obj({
              Type: 'Annot',
              Subtype: 'Square',
              Rect: [20 + i * 50, 100, 50 + i * 50, 130],
              F: flags,
              ...(layer && { OC: layer }),
              AP: { N: appearance },
            }),
          ),
        );
      }
      const before = await doc.save();
      expect(flattenDocument(doc)).toEqual({ fields: 0, annotations: 3 });
      const after = await doc.save();
      for (const intent of ['display', 'print'])
        expect(
          difference(await view(before, intent), await view(after, intent)),
          intent,
        ).toBeLessThan(0.01);
      const layers = doc.catalog.lookup(PDFName.of('OCProperties'));
      // One shared new group, without changing the original default or alternate settings.
      const groups = layers.lookup(PDFName.of('OCGs')).asArray();
      expect(groups).toHaveLength(3);
      expect(layers.lookup(PDFName.of('D')).lookup(PDFName.of('OFF')).asArray()).toEqual([hidden]);
      const alternate = layers.lookup(PDFName.of('Configs')).lookup(0);
      expect(alternate.lookup(PDFName.of('ON')).asArray()).toEqual([hidden, groups[2]]);
      expect(alternate.lookup(PDFName.of('OFF')).asArray()).toEqual([visible]);
      expect(alternate.lookup(PDFName.of('AS')).size()).toBe(2);
    });
  }
}

it.each([0, 36])('extraction preserves a form field visibility mode (%s)', async (flags) => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const field = doc.getForm().createTextField('name');
  field.setText('Ada');
  field.addToPage(page, { x: 20, y: 20, width: 140, height: 30 });
  field.acroField.getWidgets()[0].dict.set(PDFName.of('F'), doc.context.obj(flags));
  const before = await doc.save();
  const extracted = await extractPages(before, [0]);
  for (const intent of ['display', 'print'])
    expect(
      difference(await view(before, intent), await view(extracted, intent)),
      intent,
    ).toBeLessThan(0.01);
  expect((await PDFDocument.load(extracted)).getForm().getFields()).toHaveLength(0);
});

it('keeps print-only content when its appearance cannot be flattened safely', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const field = doc.getForm().createTextField('print-only');
  field.addToPage(page, { x: 20, y: 20, width: 100, height: 30 });
  field.setText('漢字');
  const widget = field.acroField.getWidgets()[0].dict;
  widget.set(PDFName.of('F'), doc.context.obj(36));
  widget.delete(PDFName.of('AP'));
  const annotation = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'FreeText',
      Rect: [20, 100, 100, 120],
      F: 36,
      Contents: PDFHexString.fromText('Keep for printing'),
    }),
  );
  page.node.addAnnot(annotation);
  expect(flattenDocument(doc)).toEqual({
    fields: 0,
    annotations: 0,
    unflattened: { fields: 1, annotations: 1 },
  });
  expect(doc.getForm().getTextField('print-only').getText()).toBe('漢字');
  expect(page.node.Annots().size()).toBe(2);
  expect(doc.catalog.has(PDFName.of('OCProperties'))).toBe(false);
});

for (const kind of ['note', 'highlight', 'underline', 'strikeout'])
  for (const legacy of [false, true])
    it(`flattens indirect ${kind} subtypes with the same appearance (legacy=${legacy})`, async () => {
      const pictures = [];
      for (const indirect of [false, true]) {
        const { doc, dict } = await commentPdf(kind, indirect);
        if (legacy) dict.delete(PDFName.of('AP'));
        expect(flattenCounts(doc)).toEqual({ fields: 0, annotations: 1 });
        expect(flattenDocument(doc, { fields: false })).toEqual({ fields: 0, annotations: 1 });
        expect(doc.getPage(0).node.Annots().size()).toBe(0);
        const bytes = await doc.save();
        const picture = await view(bytes);
        expect(picture.annotations).toEqual([]);
        pictures.push(picture);
        expect(flattenDocument(await PDFDocument.load(bytes))).toBe(false);
      }
      expect(difference(...pictures)).toBe(0);
    });

it('removes indirectly typed popups that only identify their parent annotation', async () => {
  const { doc, dict } = await commentPdf('note');
  dict.delete(PDFName.of('Popup'));
  expect(flattenDocument(doc)).toEqual({ fields: 0, annotations: 1 });
  expect(doc.getPage(0).node.Annots().size()).toBe(0);
});

it('leaves indirect links and retained field widgets interactive when flattening comments', async () => {
  const { doc } = await commentPdf('note');
  const page = doc.getPage(0);
  addLink(doc, 0, { rect: { x: 10, y: 10, width: 40, height: 20 }, url: 'example.com' });
  const field = doc.getForm().createTextField('Name');
  field.addToPage(page, { x: 100, y: 100, width: 100, height: 20 });
  for (const ref of page.node.Annots().asArray()) {
    const dict = doc.context.lookup(ref);
    const subtype = dict.lookup(PDFName.of('Subtype'));
    dict.set(PDFName.of('Subtype'), doc.context.register(subtype));
  }
  expect(flattenCounts(doc)).toEqual({ fields: 1, annotations: 1 });
  expect(flattenDocument(doc, { fields: false })).toEqual({ fields: 0, annotations: 1 });
  expect(doc.getForm().getFields()).toHaveLength(1);
  const saved = await view(await doc.save());
  expect(saved.annotations.map((a) => a.subtype)).toEqual(['Link', 'Widget']);
});

for (const hidden of [false, true])
  it(`reports unsupported indirect annotations honestly (hidden=${hidden})`, async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([100, 100]);
    page.node.addAnnot(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: doc.context.register(PDFName.of('Square')),
          Rect: [10, 10, 50, 50],
          F: hidden ? 2 : 4,
        }),
      ),
    );
    expect(flattenCounts(doc)).toEqual({ fields: 0, annotations: 1 });
    expect(flattenDocument(doc)).toEqual(
      hidden
        ? { fields: 0, annotations: 1 }
        : { fields: 0, annotations: 0, unflattened: { fields: 0, annotations: 1 } },
    );
    expect(page.node.Annots().size()).toBe(hidden ? 0 : 1);
  });
