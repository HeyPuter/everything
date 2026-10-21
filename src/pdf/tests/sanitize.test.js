import { afterEach, describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
  StandardFontEmbedder,
  StandardFonts,
  decodePDFRawStream,
} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PdfSession } from '../src/core/document.js';
import { SANITIZE_DEFAULTS, sanitizeDocument } from '../src/core/sanitize.js';

const n = PDFName.of;
const tasks = [];
afterEach(async () => {
  await Promise.all(tasks.splice(0).map((task) => task.destroy()));
});
async function textItems(bytes) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    useSystemFonts: false,
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  tasks.push(task);
  const pdf = await task.promise;
  return (await (await pdf.getPage(1)).getTextContent()).items.filter((i) => i.str !== undefined);
}
const helvetica = StandardFontEmbedder.for(StandardFonts.Helvetica);
const advance = (text, size = 12) =>
  [...text].reduce((sum, c) => sum + helvetica.widthOfTextAtSize(c, size), 0);

async function recoverable(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let text = Buffer.from(bytes).toString('latin1');
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) {
      text += object.dict.toString();
      try {
        text += Buffer.from(decodePDFRawStream(object).decode()).toString('latin1');
      } catch {
        // Encoded images stay as they are.
      }
    } else text += object.toString();
  }
  return text;
}
const utf16 = (s) => Buffer.from(s, 'utf16le').swap16().toString('hex');
const hexOf = (s) => Buffer.from(s, 'latin1').toString('hex');
const contains = (corpus, text) => {
  const lower = corpus.toLowerCase();
  return corpus.includes(text) || lower.includes(hexOf(text)) || lower.includes(utf16(text));
};

/** A document carrying one example of everything Sanitize removes. */
async function cluttered() {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  doc.setTitle('Merger plan');
  doc.setAuthor('Secret Author');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 400]);
  const js = (code) => ctx.obj({ S: 'JavaScript', JS: PDFString.of(code) });
  const goTo = ctx.obj({ S: 'GoTo', D: [page.ref, 'Fit'] });
  const hidden = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Drafts') }));
  const shown = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Visible') }));
  doc.catalog.set(
    n('OCProperties'),
    ctx.obj({ OCGs: [hidden, shown], D: { OFF: [hidden], Order: [hidden, shown] } }),
  );
  const image = (oc) =>
    ctx.register(
      ctx.flateStream(new Uint8Array(4).fill(90), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 2,
        Height: 2,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
        ...(oc ? { OC: oc } : {}),
        Metadata: ctx.register(
          ctx.stream('<x:xmpmeta>CameraOwner</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' }),
        ),
        Alternates: [{ Image: ctx.register(ctx.flateStream('ALTERNATEPIXELS')) }],
      }),
    );
  page.node.set(
    n('Resources'),
    ctx.obj({
      Font: { F: font.ref },
      Properties: { Off: hidden, On: shown },
      XObject: { Draft: image(hidden), Photo: image() },
    }),
  );
  const content = [
    'BT /F 12 Tf 50 300 Td (Visible ) Tj 3 Tr (OCRSECRET) Tj 0 Tr (after) Tj ET',
    '/OC /Off BDC BT /F 12 Tf 50 250 Td (HIDDENLAYER) Tj ET 0 0 1 rg 50 200 40 40 re f EMC',
    '/OC /On BDC BT /F 12 Tf 50 150 Td (Shown layer) Tj ET EMC',
    'q 20 0 0 20 300 300 cm /Draft Do Q q 20 0 0 20 300 250 cm /Photo Do Q',
  ].join('\n');
  page.node.set(n('Contents'), ctx.register(ctx.flateStream(content)));
  page.node.set(n('PieceInfo'), ctx.obj({ Illustrator: { Private: PDFString.of('LAYERDATA') } }));
  page.node.set(n('Thumb'), ctx.register(ctx.flateStream('THUMBPIXELS')));
  page.node.set(n('AA'), ctx.obj({ O: js('app.alert("page open")') }));
  doc.catalog.set(n('OpenAction'), js('app.alert("opened")'));
  doc.catalog.set(n('AA'), ctx.obj({ WC: js('app.alert("closing")') }));
  doc.catalog.set(n('PieceInfo'), ctx.obj({ App: { Private: PDFString.of('CATALOGPRIVATE') } }));
  doc.catalog.set(n('SpiderInfo'), ctx.obj({ V: 1.0 }));
  doc.catalog.set(
    n('Metadata'),
    ctx.register(
      ctx.stream('<x:xmpmeta>DocumentXMP</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' }),
    ),
  );
  const file = ctx.register(ctx.flateStream('ATTACHMENTDATA', { Type: 'EmbeddedFile' }));
  const spec = ctx.register(
    ctx.obj({ Type: 'Filespec', F: PDFString.of('notes.txt'), EF: { F: file } }),
  );
  doc.catalog.set(
    n('Names'),
    ctx.obj({
      JavaScript: { Names: [PDFString.of('init'), js('app.alert("doc script")')] },
      EmbeddedFiles: { Names: [PDFString.of('notes.txt'), spec] },
      IDS: { Names: [] },
    }),
  );
  doc.catalog.set(n('AF'), ctx.obj([spec]));
  // Bookmark with a script.
  const outline = ctx.register(ctx.obj({}));
  const item = ctx.register(
    ctx.obj({ Title: PDFString.of('Intro'), Parent: outline, A: js('app.alert("bookmark")') }),
  );
  ctx.assign(outline, ctx.obj({ Type: 'Outlines', First: item, Last: item, Count: 1 }));
  doc.catalog.set(n('Outlines'), outline);

  const annots = [
    // A link whose script runs before a page jump: the jump stays.
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [10, 10, 60, 30],
      A: { ...{ S: 'JavaScript', JS: PDFString.of('app.alert("link")') }, Next: goTo },
    }),
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [10, 40, 60, 60],
      A: { S: 'URI', URI: PDFString.of('https://tracker.example') },
    }),
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [10, 70, 60, 90],
      A: { S: 'Launch', F: PDFString.of('calc.exe') },
    }),
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [100, 10, 120, 30],
      Contents: PDFHexString.fromText('Private comment'),
    }),
    ctx.obj({ Type: 'Annot', Subtype: 'FileAttachment', Rect: [130, 10, 150, 30], FS: spec }),
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Square',
      Rect: [160, 10, 180, 30],
      OC: hidden,
      Contents: PDFString.of('Layer note'),
    }),
  ].map((annot) => ctx.register(annot));
  const note = annots[3];
  const popup = ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [100, 40, 200, 90], Parent: note }),
  );
  ctx.lookup(note).set(n('Popup'), popup);
  page.node.set(n('Annots'), ctx.obj([...annots, popup]));
  const field = doc.getForm().createTextField('salary');
  field.setText('98765');
  field.addToPage(page, { x: 200, y: 100, width: 100, height: 20 });
  field.acroField.dict.set(n('AA'), ctx.obj({ K: js('AFNumber_Keystroke()') }));
  return doc.save();
}

async function sanitize(bytes, options) {
  const session = new PdfSession(bytes);
  let report;
  await session.change(async (doc) => {
    report = await sanitizeDocument(doc, options);
  });
  return { bytes: session.bytes, report };
}

describe('sanitizeDocument', () => {
  it('removes everything Acrobat sanitizes by default', async () => {
    const original = await cluttered();
    const before = await textItems(original);
    const { bytes, report } = await sanitize(original);
    expect(report).toMatchObject({
      hiddenText: 9,
      formFields: 1,
      thumbnails: 1,
      webCapture: 2,
      alternateImages: 2,
      bookmarks: 0,
    });
    expect(report.javascript).toBeGreaterThanOrEqual(6);
    expect(report.actions).toBe(2);
    // The note and the square (which is also on the hidden layer).
    expect(report.comments).toBe(2);
    expect(report.attachments).toBeGreaterThanOrEqual(3);
    expect(report.metadata).toBeGreaterThanOrEqual(4);
    expect(report.privateData).toBe(2);
    expect(report.hiddenLayers).toBeGreaterThanOrEqual(3);

    const corpus = await recoverable(bytes);
    for (const secret of [
      'Secret Author',
      'Merger plan',
      'DocumentXMP',
      'CameraOwner',
      'LAYERDATA',
      'CATALOGPRIVATE',
      'app.alert',
      'AFNumber_Keystroke',
      'ATTACHMENTDATA',
      'notes.txt',
      'THUMBPIXELS',
      'Private comment',
      'Layer note',
      'OCRSECRET',
      'HIDDENLAYER',
      'ALTERNATEPIXELS',
      'tracker.example',
      'calc.exe',
      '98765',
      'Drafts',
    ])
      expect(contains(corpus, secret), secret).toBe(false);

    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);
    // The scripted link keeps its page jump; the external links are gone.
    const annots = page.node.lookup(n('Annots'))?.asArray() ?? [];
    expect(annots).toHaveLength(1);
    const kept = doc.context.lookup(annots[0]).lookup(n('A'));
    expect(kept.lookup(n('S'))).toBe(n('GoTo'));
    expect(doc.catalog.has(n('AcroForm'))).toBe(false);
    expect(doc.catalog.has(n('OpenAction'))).toBe(false);
    // Bookmarks stay navigable, without the script.
    const item = doc.catalog.lookup(n('Outlines')).lookup(n('First'));
    expect(item.lookup(n('Title')).decodeText()).toBe('Intro');
    expect(item.has(n('A'))).toBe(false);
    // Only the visible layer remains; its content too.
    const ocgs = doc.catalog.lookup(n('OCProperties')).lookup(n('OCGs'));
    expect(ocgs.size()).toBe(1);
    expect(doc.catalog.lookup(n('OCProperties')).lookup(n('D')).lookup(n('Order')).size()).toBe(1);
    const xobjects = page.node.Resources().lookup(n('XObject'));
    expect(xobjects.keys().map((k) => k.decodeText())).toEqual(['Photo']);

    const items = await textItems(bytes);
    const text = items.map((i) => i.str).join('');
    expect(text).toContain('Visible');
    expect(text).toContain('Shown layer');
    const after = (list) => list.find((i) => i.str.includes('after'));
    const x = (item) =>
      item.transform[4] +
      (item.str.indexOf('after') > 0 ? advance(item.str.slice(0, item.str.indexOf('after'))) : 0);
    expect(x(after(items))).toBeCloseTo(50 + advance('Visible OCRSECRET'), 3);
    expect(x(after(before))).toBeCloseTo(50 + advance('Visible OCRSECRET'), 3);
  });

  it('keeps the categories that are switched off', async () => {
    const { bytes, report } = await sanitize(await cluttered(), {
      comments: false,
      formFields: false,
      hiddenText: false,
      hiddenLayers: false,
      metadata: false,
      actions: false,
      bookmarks: true,
    });
    expect(report).toMatchObject({
      comments: 0,
      formFields: 0,
      hiddenText: 0,
      hiddenLayers: 0,
      metadata: 0,
      actions: 0,
      bookmarks: 1,
    });
    const corpus = await recoverable(bytes);
    for (const kept of [
      'Private comment',
      'OCRSECRET',
      'HIDDENLAYER',
      'Secret Author',
      'tracker.example',
      'calc.exe',
    ])
      expect(contains(corpus, kept), kept).toBe(true);
    expect(contains(corpus, 'app.alert')).toBe(false);
    const doc = await PDFDocument.load(bytes);
    expect(
      doc
        .getForm()
        .getFields()
        .map((f) => f.getName()),
    ).toEqual(['salary']);
    expect(doc.catalog.has(n('Outlines'))).toBe(false);
  });

  it('removes images and drawings that resources list but nothing draws', async () => {
    // An editor took a drawing and a picture off the page but left them in its resources.
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 400]);
    const drawing = (text) =>
      doc.context.register(
        doc.context.stream(`BT /F1 12 Tf 10 10 Td (${text}) Tj ET`, {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [0, 0, 400, 400],
          Resources: { Font: { F1: font.ref } },
        }),
      );
    const picture = doc.context.register(
      doc.context.stream('LEFTOVERPIXELS', {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 14,
        Height: 1,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
      }),
    );
    const resources = { Font: { F1: font.ref } };
    resources.XObject = { Kept: drawing('Shown'), Old: drawing('LEFTOVERTEXT'), Pic: picture };
    page.node.set(n('Resources'), doc.context.obj(resources));
    page.node.set(n('Contents'), doc.context.register(doc.context.stream('q /Kept Do Q')));
    const { bytes, report } = await sanitize(await doc.save());
    expect(report.unusedContent).toBe(2);
    const corpus = await recoverable(bytes);
    expect(corpus).not.toContain('LEFTOVERTEXT');
    expect(corpus).not.toContain('LEFTOVERPIXELS');
    expect((await textItems(bytes)).map((item) => item.str)).toEqual(['Shown']);
  });

  it('removes files embedded in rich media annotations', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const file = doc.context.register(
      doc.context.stream('EMBEDDEDCLIP', { Type: 'EmbeddedFile', Subtype: 'video/mp4' }),
    );
    const spec = doc.context.obj({ Type: 'Filespec', F: 'clip.mp4', EF: { F: file } });
    const media = doc.context.obj({
      Type: 'Annot',
      Subtype: 'RichMedia',
      Rect: [0, 0, 100, 100],
      RichMediaContent: {
        Type: 'RichMediaContent',
        Assets: { Names: [PDFString.of('clip.mp4'), spec] },
        Configurations: [],
      },
    });
    page.node.set(n('Annots'), doc.context.obj([doc.context.register(media)]));
    const { bytes, report } = await sanitize(await doc.save());
    expect(report.attachments).toBe(1);
    expect(await recoverable(bytes)).not.toContain('EMBEDDEDCLIP');
  });

  it('has Acrobat-like defaults', () => {
    expect(
      Object.entries(SANITIZE_DEFAULTS)
        .filter(([, on]) => !on)
        .map(([key]) => key),
    ).toEqual(['bookmarks']);
  });
});
