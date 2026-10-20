import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFStream,
  PDFString,
  StandardFontEmbedder,
  StandardFonts,
  decodePDFRawStream,
  degrees,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { JpegImage } from 'pdfjs-dist/image_decoders/pdf.image_decoders.mjs';
import { PdfSession } from '../src/core/document.js';
import { pageSource } from '../src/core/text-edit.js';
import {
  REDACTION_PATTERNS,
  addRedactionMarks,
  applyRedactions,
  findRedactionMatches,
  findTextRects,
  listRedactionMarks,
  removeRedactionMark,
} from '../src/core/redact.js';

const n = PDFName.of;
const tasks = [];
afterEach(async () => {
  await Promise.all(tasks.splice(0).map((task) => task.destroy()));
});
async function pdfPages(bytes) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    useSystemFonts: false,
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  tasks.push(task);
  return task.promise;
}
async function textItems(bytes, index = 0) {
  const pdf = await pdfPages(bytes);
  return (await (await pdf.getPage(index + 1)).getTextContent()).items.filter(
    (i) => i.str !== undefined,
  );
}
const pageText = async (bytes, index = 0) =>
  (await textItems(bytes, index)).map((i) => i.str).join('');
/** x of the item whose text starts with `prefix`. */
const itemX = (items, prefix) =>
  items.find((i) => i.str.replace(/\s+/g, '').startsWith(prefix))?.transform[4];

const helvetica = StandardFontEmbedder.for(StandardFonts.Helvetica);
const width = (text, size = 12) => helvetica.widthOfTextAtSize(text, size);
// Standard-font text is drawn without kerning, so measure glyph by glyph.
const advance = (text, size = 12) =>
  [...text].reduce((sum, c) => sum + helvetica.widthOfTextAtSize(c, size), 0);

/** Every byte a recipient could recover: the file, each object, and every decoded stream. */
async function recoverable(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let text = Buffer.from(bytes).toString('latin1');
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) {
      text += object.dict.toString();
      try {
        text += Buffer.from(decodePDFRawStream(object).decode()).toString('latin1');
      } catch {
        // Image codecs (DCT) stay encoded; their bytes are part of the file text above.
      }
    } else text += object.toString();
  }
  return text;
}
const hexOf = (s) => Buffer.from(s, 'latin1').toString('hex');
const utf16 = (s) => Buffer.from(s, 'utf16le').swap16().toString('hex');
const contains = (corpus, text) => {
  const lower = corpus.toLowerCase();
  return (
    corpus.includes(text) ||
    lower.includes(hexOf(text).toLowerCase()) ||
    lower.includes(utf16(text))
  );
};
function expectGone(corpus, secret) {
  expect(corpus).not.toContain(secret);
  const lower = corpus.toLowerCase();
  expect(lower).not.toContain(hexOf(secret).toLowerCase());
  expect(lower).not.toContain(utf16(secret));
}

async function makePdf(pages, { setup } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const shared = await setup?.(doc, font);
  for (const { content, resources = {}, size = [400, 400] } of pages) {
    const page = doc.addPage(size);
    const extra = typeof resources === 'function' ? resources(doc, shared) : resources;
    page.node.set(n('Resources'), doc.context.obj({ Font: { F: font.ref }, ...extra }));
    const bytes = typeof content === 'string' ? Buffer.from(content, 'latin1') : content;
    page.node.set(n('Contents'), doc.context.register(doc.context.flateStream(bytes)));
  }
  return doc.save();
}

/** Apply marks through a real editing session (which sweeps and rewrites the file). */
async function redact(bytes, marks, options) {
  const session = new PdfSession(bytes);
  let report;
  await session.change(async (doc) => {
    for (const [page, rects, style] of marks) addRedactionMarks(doc, page, rects, style);
    report = await applyRedactions(doc, options);
    return report;
  });
  return { bytes: session.bytes, report };
}

describe('redaction marks', () => {
  it('stores standard Redact annotations and lists marks from other writers', async () => {
    const bytes = await makePdf([{ content: 'BT /F 12 Tf 72 300 Td (Hello) Tj ET' }]);
    const doc = await PDFDocument.load(bytes);
    const id = addRedactionMarks(
      doc,
      0,
      [
        [10, 20, 110, 40],
        [10, 50, 60, 70],
      ],
      { overlayText: 'Confidential', fill: '#102030', repeat: true, fontSize: 8 },
    );
    // A mark as another application might write it: Rect only, gray interior.
    const foreign = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Redact',
        Rect: [200, 200, 250, 220],
        IC: [0.5],
        OverlayText: PDFString.of('X'),
      }),
    );
    doc.getPage(0).node.lookup(n('Annots')).push(foreign);
    const saved = await PDFDocument.load(await doc.save());
    const marks = listRedactionMarks(saved);
    expect(marks).toEqual([
      {
        page: 0,
        id,
        rects: [
          [10, 20, 110, 40],
          [10, 50, 60, 70],
        ],
        overlayText: 'Confidential',
        fill: '#102030',
        outline: '#ff0000',
        repeat: true,
        fontSize: 8,
        textColor: '#ffffff',
        align: 0,
      },
      expect.objectContaining({ rects: [[200, 200, 250, 220]], fill: '#808080', overlayText: 'X' }),
    ]);
    const annot = saved.context.lookup(saved.getPage(0).node.lookup(n('Annots')).get(0));
    expect(annot.lookup(n('Subtype'))).toBe(n('Redact'));
    expect(annot.lookup(n('QuadPoints')).size()).toBe(16);
    expect(annot.lookup(n('AP')).lookup(n('N'))).toBeInstanceOf(PDFStream);
    // The marked state only outlines the area; nothing is hidden before applying.
    expect(await pageText(await saved.save())).toBe('Hello');
    expect(removeRedactionMark(saved, 0, id)).toBeUndefined();
    expect(listRedactionMarks(saved)).toHaveLength(1);
    expect(removeRedactionMark(saved, 0, 'nope')).toBe(false);
  });

  it('rejects empty areas and resolves to false when nothing is marked', async () => {
    const doc = await PDFDocument.load(await makePdf([{ content: '' }]));
    expect(() => addRedactionMarks(doc, 0, [[1, 1, 1, 50]])).toThrow('Select an area');
    expect(() => addRedactionMarks(doc, 3, [[1, 1, 50, 50]])).toThrow('Choose a page');
    expect(await applyRedactions(doc)).toBe(false);
  });
});

describe('text', () => {
  it('removes only the covered glyphs and keeps the following text in place', async () => {
    const content = [
      'BT /F 12 Tf 72 300 Td (Account SECRET end) Tj ET',
      'BT /F 12 Tf 72 280 Td [(Name: ) -250 (SECRET) 120 ( after)] TJ ET',
      // Spacing, scaling, and the quote operators all change the advance of each glyph.
      'BT /F 12 Tf 2 Tc 3 Tw 90 Tz 14 TL 72 260 Td (Spaced SECRET tail) \' 1 0.5 (Quoted SECRET last) " ET',
    ].join('\n');
    const bytes = await makePdf([{ content }]);
    const secretX = 72 + advance('Account ');
    const tjX = 72 + advance('Name: ') + (250 * 12) / 1000;
    // Tc 2 and Tw 3 (on the space) under 90 % horizontal scaling.
    const spaced = (text) =>
      [...text].reduce((s, c) => s + (advance(c) + 2 + (c === ' ' ? 3 : 0)) * 0.9, 0);
    const quoted = (text) =>
      [...text].reduce((s, c) => s + (advance(c) + 0.5 + (c === ' ' ? 1 : 0)) * 0.9, 0);
    const { bytes: out, report } = await redact(bytes, [
      [
        0,
        [
          [secretX + 0.5, 296, secretX + advance('SECRET') - 0.5, 310],
          [tjX + 0.5, 276, tjX + advance('SECRET') - 1.5, 290],
          [72 + spaced('Spaced ') + 0.5, 244, 72 + spaced('Spaced SECRET') - 0.5, 252],
          [72 + quoted('Quoted ') + 0.5, 230, 72 + quoted('Quoted SECRET') - 0.5, 238],
        ],
      ],
    ]);
    expect(report).toMatchObject({ pages: [0], text: 24, annotations: 0 });
    const items = await textItems(out);
    expect(items.map((i) => i.str).join('')).not.toContain('SECRET');
    const expected = {
      end: 72 + advance('Account SECRET '),
      // The TJ adjustment 120 pulls " after" 1.44 pt back under the word.
      after: tjX + advance('SECRET') - 1.44 + advance(' '),
      tail: 72 + spaced('Spaced SECRET '),
      last: 72 + quoted('Quoted SECRET '),
    };
    for (const [word, x] of Object.entries(expected)) expect(itemX(items, word)).toBeCloseTo(x, 3);
    expect(itemX(items, 'Account')).toBeCloseTo(72, 3);
    expect(itemX(items, 'Name')).toBeCloseTo(72, 3);
    expectGone(await recoverable(out), 'SECRET');
  });

  it('removes invisible OCR text and text in rotated, scaled coordinates', async () => {
    const content = [
      // A scan's hidden text layer (render mode 3).
      'BT 3 Tr /F 10 Tf 1 0 0 1 50 100 Tm (OCR hidden PASSWORD layer) Tj ET',
      // Rotated 90 degrees about (300, 50) and drawn at twice the size.
      'q 0 2 -2 0 300 50 cm BT /F 10 Tf 0 0 Td (Rotated PASSWORD ok) Tj ET Q',
    ].join('\n');
    const bytes = await makePdf([{ content }]);
    const x = 50 + advance('OCR hidden ', 10);
    const start = advance('Rotated ', 10) * 2;
    const { bytes: out, report } = await redact(bytes, [
      [
        0,
        [
          [x + 1, 98, x + advance('PASSWORD', 10) - 1, 106],
          [285, 50 + start + 1, 299, 50 + start + advance('PASSWORD', 10) * 2 - 1],
        ],
      ],
    ]);
    expect(report.text).toBe(16);
    const text = await pageText(out);
    expect(text).toContain('OCR hidden');
    expect(text).toContain('layer');
    expect(text).toContain('Rotated');
    expect(text).not.toContain('PASSWORD');
    expectGone(await recoverable(out), 'PASSWORD');
  });

  it('copies a shared Form XObject, leaving its other uses intact', async () => {
    const bytes = await makePdf(
      [
        {
          content: 'q 1 0 0 1 0 0 cm /Shared Do Q q 1 0 0 1 0 -100 cm /Shared Do Q',
          resources: (doc, form) => ({ XObject: { Shared: form } }),
        },
        { content: '/Shared Do', resources: (doc, form) => ({ XObject: { Shared: form } }) },
      ],
      {
        setup: (doc, font) =>
          doc.context.register(
            doc.context.flateStream('BT /F 12 Tf 72 300 Td (Shared CLASSIFIED words) Tj ET', {
              Type: 'XObject',
              Subtype: 'Form',
              BBox: [0, 0, 400, 400],
              Resources: { Font: { F: font.ref } },
            }),
          ),
      },
    );
    const x = 72 + advance('Shared ');
    // Only the first placement on page 1 is covered; the copy 100 pt lower is not.
    const { bytes: out } = await redact(bytes, [[0, [[x, 295, x + advance('CLASSIFIED'), 312]]]]);
    const first = await textItems(out, 0);
    const text = first.map((i) => i.str).join('|');
    expect(text.match(/CLASSIFIED/g)).toHaveLength(1);
    expect(
      first.filter((i) => i.str.includes('words') || i.str.includes('CLASSIFIED words')).length,
    ).toBe(2);
    expect(await pageText(out, 1)).toBe('Shared CLASSIFIED words');
    // Page 1's own content tree no longer contains the word anywhere but the lower placement.
    const doc = await PDFDocument.load(out);
    const objects = doc.getPage(0).node.Resources().lookup(n('XObject'));
    const forms = objects.entries().map(([, ref]) => decodeText(doc.context.lookup(ref)));
    expect(
      forms.filter((s) => s.includes('CLASSIFIED') || s.includes(hexOf('CLASSIFIED'))),
    ).toHaveLength(1);
    expect(objects.entries()).toHaveLength(2);
  });

  it('clears ActualText and Alt for marked content that lost glyphs', async () => {
    const content = [
      '/Span << /ActualText (TOPSECRET) /MCID 0 >> BDC BT /F 12 Tf 72 300 Td (TOPSECRET) Tj ET EMC',
      '/Span /P1 BDC BT /F 12 Tf 72 200 Td (TOPSECRET) Tj ET EMC',
      '/Span << /ActualText (KEEPME) >> BDC BT /F 12 Tf 72 100 Td (KEEPME) Tj ET EMC',
    ].join('\n');
    const tagged = await PDFDocument.load(
      await makePdf([
        {
          content,
          resources: (doc) => ({
            Properties: {
              P1: doc.context.obj({ Alt: PDFString.of('TOPSECRET'), Lang: PDFString.of('en') }),
            },
          }),
        },
      ]),
    );
    // The structure element owning MCID 0 repeats the text as its ActualText and Alt.
    const page = tagged.getPage(0);
    const span = tagged.context.register(
      tagged.context.obj({
        Type: 'StructElem',
        S: 'Span',
        Pg: page.ref,
        K: 0,
        ActualText: PDFString.of('TOPSECRET'),
        Alt: PDFString.of('TOPSECRET'),
      }),
    );
    tagged.catalog.set(
      n('StructTreeRoot'),
      tagged.context.register(tagged.context.obj({ Type: 'StructTreeRoot', K: [span] })),
    );
    const bytes = await tagged.save();
    const w = advance('TOPSECRET');
    const { bytes: out } = await redact(bytes, [
      [
        0,
        [
          [72, 296, 72 + w, 310],
          [72, 196, 72 + w, 210],
        ],
      ],
    ]);
    const corpus = await recoverable(out);
    expectGone(corpus, 'TOPSECRET');
    expect(contains(corpus, 'KEEPME')).toBe(true);
    expect(corpus).toContain('/Lang');
  });

  it('redacts embedded CID (Type0) text and keeps neighbouring glyph positions', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(
      await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
      { subset: false },
    );
    const page = doc.addPage([400, 400]);
    page.drawText('Card 4111 1111 1111 1111 expires', { x: 40, y: 300, size: 14, font });
    page.drawText('Untouched line', { x: 40, y: 270, size: 14, font });
    const bytes = await doc.save();
    const before = await textItems(bytes);
    const start = 40 + font.widthOfTextAtSize('Card ', 14);
    const end = 40 + font.widthOfTextAtSize('Card 4111 1111 1111 1111', 14);
    const { bytes: out, report } = await redact(bytes, [[0, [[start + 0.5, 296, end - 0.5, 312]]]]);
    expect(report.text).toBe(19);
    const items = await textItems(out);
    const text = items.map((i) => i.str).join('');
    expect(text).not.toMatch(/4111/);
    expect(text).toContain('Card');
    expect(text).toContain('expires');
    expect(text).toContain('Untouched line');
    expect(itemX(items, 'expires')).toBeCloseTo(
      40 + font.widthOfTextAtSize('Card 4111 1111 1111 1111 ', 14),
      1,
    );
    expect(itemX(items, 'Untouched')).toBeCloseTo(itemX(before, 'Untouched'), 3);
    // The glyph codes of the number no longer appear in any content stream.
    const codes = font.encodeText('4111').toString().slice(1, -1).toLowerCase();
    const contents = pageSource((await PDFDocument.load(out)).getPage(0)).toLowerCase();
    expect(Buffer.from(contents, 'latin1').toString('hex')).not.toContain(codes);
    expect(contents).not.toContain(codes);
  });

  it('redacts vertical (Identity-V) text and keeps the glyphs below in place', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(
      await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
    );
    const page = doc.addPage([400, 400]);
    page.drawText('ABC', { x: 100, y: 300, size: 20, font });
    await doc.flush();
    // Turn the same glyphs into a vertical column (default metrics: 1 em down per glyph).
    doc.context.lookup(font.ref).set(n('Encoding'), n('Identity-V'));
    const before = await doc.save();
    const { bytes: out, report } = await redact(before, [[0, [[90, 262, 110, 276]]]]);
    expect(report.text).toBe(1);
    const items = await textItems(out);
    expect(
      items
        .map((i) => i.str)
        .join('')
        .replace(/\s/g, ''),
    ).toBe('AC');
    const [c] = (await textItems(before)).filter((i) => i.str.includes('C'));
    const after = items.find((i) => i.str === 'C');
    expect(after.transform[5]).toBeCloseTo(c.transform[5] - (c.str.indexOf('C') > 0 ? 40 : 0), 3);
  });

  it('redacts Type 3 font glyphs', async () => {
    const bytes = await makePdf([
      {
        content: 'BT /T3 20 Tf 50 200 Td (ABC) Tj ET',
        resources: (doc) => {
          const glyph = (w) =>
            doc.context.register(
              doc.context.flateStream(`${w} 0 0 0 ${w} 700 d1 0 0 ${w} 700 re f`),
            );
          return {
            Font: {
              T3: doc.context.obj({
                Type: 'Font',
                Subtype: 'Type3',
                FontBBox: [0, 0, 1000, 1000],
                FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
                CharProcs: { A: glyph(600), B: glyph(800), C: glyph(700) },
                Encoding: { Type: 'Encoding', Differences: [65, 'A', 'B', 'C'] },
                FirstChar: 65,
                LastChar: 67,
                Widths: [600, 800, 700],
                Resources: {},
              }),
            },
          };
        },
      },
    ]);
    // B spans 62–78 at 20 pt.
    const { bytes: out, report } = await redact(bytes, [[0, [[63, 195, 77, 215]]]]);
    expect(report.text).toBe(1);
    const items = await textItems(out);
    expect(items.map((i) => i.str).join('')).toMatch(/^A\s*C$/);
    expect(itemX(items, 'C')).toBeCloseTo(78, 3);
  });
});

function decodeText(stream) {
  return Buffer.from(
    stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents(),
  ).toString('latin1');
}
function decodeSamples(stream) {
  return Uint8Array.from(decodePDFRawStream(stream).decode());
}
/** The image streams page 1 draws, by name. */
function pageImages(doc, index = 0) {
  const objects = doc.getPage(index).node.Resources().lookup(n('XObject'));
  return Object.fromEntries(
    objects.entries().map(([key, ref]) => [key.decodeText(), doc.context.lookup(ref)]),
  );
}

describe('images', () => {
  const rgbImage = (doc, width, height, pixel, extra = {}) =>
    doc.context.register(
      doc.context.flateStream(
        Uint8Array.from({ length: width * height * 3 }, (_, i) =>
          pixel(Math.floor(i / 3) % width, Math.floor(i / 3 / width), i % 3),
        ),
        {
          Type: 'XObject',
          Subtype: 'Image',
          Width: width,
          Height: height,
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 8,
          ...extra,
        },
      ),
    );
  const pattern = (x, y, c) => (x * 20 + y * 3 + c * 50) % 256;

  it('paints only the covered pixels and their soft mask, on a copy when the image is shared', async () => {
    const bytes = await makePdf(
      [
        {
          content: 'q 100 0 0 100 50 50 cm /Im Do Q',
          resources: (doc, image) => ({ XObject: { Im: image } }),
        },
        {
          content: 'q 100 0 0 100 50 50 cm /Im Do Q',
          resources: (doc, image) => ({ XObject: { Im: image } }),
        },
      ],
      {
        setup: (doc) => {
          const mask = doc.context.register(
            doc.context.flateStream(new Uint8Array(100).fill(128), {
              Type: 'XObject',
              Subtype: 'Image',
              Width: 10,
              Height: 10,
              ColorSpace: 'DeviceGray',
              BitsPerComponent: 8,
            }),
          );
          return rgbImage(doc, 10, 10, pattern, { SMask: mask });
        },
      },
    );
    // x 50–75 covers pixel columns 0–2 (column 2 partly); y 120–150 covers rows 0–2 (top down).
    const { bytes: out, report } = await redact(bytes, [
      [0, [[50, 120, 75, 150]], { fill: '#ff8000' }],
    ]);
    expect(report.images).toEqual({ redacted: 1, removed: 0 });
    const doc = await PDFDocument.load(out);
    const [image] = Object.values(pageImages(doc, 0));
    const pixels = decodeSamples(image),
      alpha = decodeSamples(image.dict.lookup(n('SMask')));
    for (let y = 0; y < 10; y++)
      for (let x = 0; x < 10; x++) {
        const covered = x <= 2 && y <= 2;
        const at = (y * 10 + x) * 3;
        expect([...pixels.subarray(at, at + 3)]).toEqual(
          covered ? [255, 128, 0] : [0, 1, 2].map((c) => pattern(x, y, c)),
        );
        expect(alpha[y * 10 + x]).toBe(covered ? 255 : 128);
      }
    // Page 2 still shows the original picture.
    const [original] = Object.values(pageImages(doc, 1));
    expect([...decodeSamples(original).subarray(0, 3)]).toEqual([0, 50, 100]);
    expect(decodeSamples(original.dict.lookup(n('SMask')))[0]).toBe(128);
  });

  it('decodes JPEGs, paints the area, and stores the result losslessly', async () => {
    const canvas = createCanvas(40, 20);
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 40, 20);
    gradient.addColorStop(0, '#2060c0');
    gradient.addColorStop(1, '#e0a020');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 40, 20);
    const jpeg = canvas.toBuffer('image/jpeg');
    const decoder = new JpegImage();
    decoder.parse(jpeg);
    const original = decoder.getData({ width: 40, height: 20 });
    const bytes = await makePdf([
      {
        content: 'q 200 0 0 100 0 0 cm /Photo Do Q',
        resources: (doc) => ({
          XObject: {
            Photo: doc.context.register(
              doc.context.stream(jpeg, {
                Type: 'XObject',
                Subtype: 'Image',
                Width: 40,
                Height: 20,
                ColorSpace: 'DeviceRGB',
                BitsPerComponent: 8,
                Filter: 'DCTDecode',
              }),
            ),
          },
        }),
      },
    ]);
    // Five points per pixel: x 0–50 is columns 0–9, every row.
    const { bytes: out, report } = await redact(bytes, [[0, [[0, 0, 50, 100]]]]);
    expect(report.images.redacted).toBe(1);
    const doc = await PDFDocument.load(out);
    const [image] = Object.values(pageImages(doc));
    expect(image.dict.lookup(n('Filter'))).toBe(n('FlateDecode'));
    const pixels = decodeSamples(image);
    for (let y = 0; y < 20; y++)
      for (let x = 0; x < 40; x++) {
        const at = (y * 40 + x) * 3;
        expect([...pixels.subarray(at, at + 3)]).toEqual(
          x < 10 ? [0, 0, 0] : [...original.subarray(at, at + 3)],
        );
      }
    // The original JPEG is not left behind in the file.
    expect(Buffer.from(out).includes(jpeg.subarray(200, 260))).toBe(false);
  });

  it('redacts inline images and stencil masks', async () => {
    const data = Buffer.from(Uint8Array.from({ length: 4 * 4 * 3 }, (_, i) => 60 + i));
    const content = Buffer.concat([
      Buffer.from('q 40 0 0 40 100 100 cm BI /W 4 /H 4 /CS /RGB /BPC 8 ID '),
      data,
      Buffer.from(' EI Q\nq 40 0 0 40 200 100 cm /Stencil Do Q'),
    ]);
    const bytes = await makePdf([
      {
        content,
        resources: (doc) => ({
          XObject: {
            Stencil: doc.context.register(
              doc.context.flateStream(new Uint8Array(8).fill(0), {
                Type: 'XObject',
                Subtype: 'Image',
                Width: 8,
                Height: 8,
                ImageMask: true,
              }),
            ),
          },
        }),
      },
    ]);
    // Left half of the inline image (columns 0–1) and left quarter of the stencil (columns 0–1).
    const { bytes: out, report } = await redact(bytes, [
      [
        0,
        [
          [100, 100, 120, 140],
          [200, 100, 210, 140],
        ],
      ],
    ]);
    expect(report.images.redacted).toBe(2);
    const doc = await PDFDocument.load(out);
    const source = pageSource(doc.getPage(0));
    const hex = source.match(/\/F \/AHx\nID\n([\s\S]*?)>\nEI/)[1].replace(/\s/g, '');
    const pixels = Buffer.from(hex, 'hex');
    for (let i = 0; i < 16; i++)
      expect([...pixels.subarray(i * 3, i * 3 + 3)]).toEqual(
        i % 4 < 2 ? [0, 0, 0] : [...data.subarray(i * 3, i * 3 + 3)],
      );
    const stencil = Object.values(pageImages(doc)).find((s) => s.dict.lookup(n('ImageMask')));
    // Covered stencil bits no longer paint (1 with the default Decode).
    expect([...decodeSamples(stencil)]).toEqual(Array(8).fill(0b11000000));
  });

  it('removes images it cannot decode, or redacts them through a rendering codec', async () => {
    const pdf = () =>
      makePdf([
        {
          content: 'q 100 0 0 100 0 0 cm /Scan Do Q',
          resources: (doc) => ({
            XObject: {
              Scan: doc.context.register(
                doc.context.stream(new Uint8Array([1, 2, 3, 4]), {
                  Type: 'XObject',
                  Subtype: 'Image',
                  Width: 2,
                  Height: 2,
                  ColorSpace: 'DeviceGray',
                  BitsPerComponent: 1,
                  Filter: 'JBIG2Decode',
                }),
              ),
            },
          }),
        },
      ]);
    const removed = await redact(await pdf(), [[0, [[0, 0, 20, 20]]]]);
    expect(removed.report.images).toEqual({ redacted: 0, removed: 1 });
    expect(removed.report.warnings.join(' ')).toMatch(/could not be decoded/);
    expect(pageSource((await PDFDocument.load(removed.bytes)).getPage(0))).not.toContain('Do');

    const codec = {
      render: async (bytes, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(200) }),
    };
    const rendered = await redact(await pdf(), [[0, [[0, 0, 20, 20]]]], { codec });
    expect(rendered.report.images).toEqual({ redacted: 1, removed: 0 });
    const [image] = Object.values(pageImages(await PDFDocument.load(rendered.bytes)));
    expect(image.dict.lookup(n('ColorSpace'))).toBe(n('DeviceRGB'));
    // Pixel (0, 1) — bottom left — is under the area; the rest keep the rendered colour.
    expect([...decodeSamples(image)]).toEqual([
      200, 200, 200, 200, 200, 200, 0, 0, 0, 200, 200, 200,
    ]);
  });
});

describe('vector graphics, annotations, and fields', () => {
  it('removes paths entirely inside an area and keeps clips and partly covered paths', async () => {
    const content = [
      'q 10 10 380 380 re W n',
      '0 0 1 rg 100 100 20 20 re f',
      '1 0 0 RG 4 w 90 110 m 300 110 l S',
      '0 1 0 rg 150 100 m 160 120 l 170 100 l h f',
      'Q',
    ].join('\n');
    const bytes = await makePdf([{ content }]);
    const { bytes: out, report } = await redact(bytes, [[0, [[95, 95, 180, 125]], { fill: null }]]);
    expect(report.paths).toBe(2);
    const source = pageSource((await PDFDocument.load(out)).getPage(0));
    expect(source).toContain('10 10 380 380 re W n');
    expect(source).toContain('90 110 m 300 110 l S');
    expect(source).not.toContain('100 100 20 20 re');
    expect(source).not.toContain('160 120 l');
  });

  it('removes links, comments, and form fields under the area, with their structure', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const form = doc.getForm();
    const secret = form.createTextField('ssn');
    secret.setText('123-45-6789');
    secret.addToPage(page, { x: 50, y: 300, width: 120, height: 20 });
    const kept = form.createTextField('name');
    kept.setText('Visible Person');
    kept.addToPage(page, { x: 50, y: 100, width: 120, height: 20 });
    const link = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [60, 250, 120, 270],
        StructParent: 1,
        A: { S: 'URI', URI: PDFString.of('https://example.com/private') },
      }),
    );
    const note = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [70, 240, 90, 260],
        Contents: PDFHexString.fromText('Private remark'),
      }),
    );
    page.node.lookup(n('Annots')).push(link);
    page.node.lookup(n('Annots')).push(note);
    const objr = doc.context.obj({ Type: 'OBJR', Obj: link, Pg: page.ref });
    const element = doc.context.register(
      doc.context.obj({ Type: 'StructElem', S: 'Link', K: [objr], Pg: page.ref }),
    );
    doc.catalog.set(
      n('StructTreeRoot'),
      doc.context.register(
        doc.context.obj({
          Type: 'StructTreeRoot',
          K: [element],
          ParentTree: { Nums: [1, element] },
        }),
      ),
    );
    const { bytes: out, report } = await redact(await doc.save(), [[0, [[40, 230, 200, 330]]]]);
    expect(report).toMatchObject({ annotations: 3, fields: 1 });
    const result = await PDFDocument.load(out);
    expect(
      result
        .getForm()
        .getFields()
        .map((f) => f.getName()),
    ).toEqual(['name']);
    const annots = result.getPage(0).node.lookup(n('Annots'));
    expect(annots.size()).toBe(1);
    const root = result.catalog.lookup(n('StructTreeRoot'));
    expect(root.lookup(n('K')).lookup(0).has(n('K'))).toBe(false);
    expect(root.lookup(n('ParentTree')).lookup(n('Nums')).size()).toBe(0);
    const corpus = await recoverable(out);
    expectGone(corpus, '123-45-6789');
    expectGone(corpus, 'Private remark');
    expectGone(corpus, 'example.com/private');
    expect(contains(corpus, 'Visible Person')).toBe(true);
  });

  it('draws the fill and fitted overlay text and deletes the marks', async () => {
    const bytes = await makePdf([
      {
        content: 'q 1 0 0 1 0 0 cm q\nBT /F 12 Tf 72 300 Td (Unbalanced SECRET) Tj ET',
        size: [400, 400],
      },
    ]);
    const x = 72 + advance('Unbalanced ');
    const { bytes: out } = await redact(bytes, [
      [
        0,
        [[x, 290, x + advance('SECRET'), 315]],
        { overlayText: 'Exempt (b)(6)', fill: '#000000', textColor: '#ffffff' },
      ],
    ]);
    const doc = await PDFDocument.load(out);
    expect(listRedactionMarks(doc)).toEqual([]);
    expect(doc.getPage(0).node.lookup(n('Annots'))?.size() ?? 0).toBe(0);
    const source = pageSource(doc.getPage(0));
    // The open states are closed before painting in page space.
    expect(source).toMatch(/Q\nQ\nQ\nq 0 0 0 rg [\d.]+ 290 [\d.]+ 25 re f Q/);
    const items = await textItems(out);
    expect(items.map((i) => i.str)).toContain('Exempt (b)(6)');
    const overlay = items.find((i) => i.str === 'Exempt (b)(6)');
    expect(overlay.transform[4]).toBeGreaterThanOrEqual(x);
    expect(overlay.transform[4] + overlay.width).toBeLessThanOrEqual(x + advance('SECRET') + 0.01);
  });

  it('sets overlay text upright on rotated pages and clears Alt text of redacted figures', async () => {
    const bytes = await makePdf([
      {
        content:
          '/Figure << /Alt (Photo of WITNESS) /MCID 0 >> BDC q 100 0 0 100 50 50 cm /Im Do Q EMC',
        resources: (doc) => ({
          XObject: {
            Im: doc.context.register(
              doc.context.flateStream(new Uint8Array(4).fill(200), {
                Type: 'XObject',
                Subtype: 'Image',
                Width: 2,
                Height: 2,
                ColorSpace: 'DeviceGray',
                BitsPerComponent: 8,
              }),
            ),
          },
        }),
      },
    ]);
    const rotated = await PDFDocument.load(bytes);
    rotated.getPage(0).setRotation(degrees(90));
    const { bytes: out } = await redact(await rotated.save(), [
      [0, [[50, 50, 100, 150]], { overlayText: 'Withheld' }],
    ]);
    expectGone(await recoverable(out), 'WITNESS');
    const overlay = (await textItems(out)).find((i) => i.str === 'Withheld');
    // Drawn along +y in user space, which reads left to right once the page is turned.
    expect(Math.abs(overlay.transform[0])).toBeLessThan(1e-6);
    expect(overlay.transform[1]).toBeGreaterThan(0);
  });

  it('applies only the chosen pages', async () => {
    const bytes = await makePdf([
      { content: 'BT /F 12 Tf 72 300 Td (One) Tj ET' },
      { content: 'BT /F 12 Tf 72 300 Td (Two) Tj ET' },
    ]);
    const session = new PdfSession(bytes);
    let report;
    await session.change(async (doc) => {
      addRedactionMarks(doc, 0, [[70, 295, 100, 315]]);
      addRedactionMarks(doc, 1, [[70, 295, 100, 315]]);
      report = await applyRedactions(doc, { pages: [1] });
    });
    expect(report.pages).toEqual([1]);
    expect(await pageText(session.bytes, 0)).toBe('One');
    expect(await pageText(session.bytes, 1)).toBe('');
    expect(listRedactionMarks(await PDFDocument.load(session.bytes))).toHaveLength(1);
  });
});

describe('find text & redact', () => {
  it('finds patterns in PDF.js text content and redacts them end to end', async () => {
    const lines = [
      'Call (555) 123-4567 or mail jane.doe@example.org today',
      'Card 4111 1111 1111 1111 and fake 4111 1111 1111 1112',
      'SSN 078-05-1120 born March 5, 2024 and 2024-03-05',
    ];
    const bytes = await makePdf([
      {
        content: lines
          .map(
            (line, i) =>
              `BT /F 10 Tf 30 ${300 - i * 30} Td (${line.replace(/[()]/g, '\\$&')}) Tj ET`,
          )
          .join('\n'),
      },
    ]);
    const items = await textItems(bytes);
    const measure = (text) => advance(text, 10);
    const found = (pattern) =>
      findRedactionMatches(items, REDACTION_PATTERNS[pattern], { measure }).map((m) => m.text);
    expect(found('phone')).toEqual(['(555) 123-4567']);
    expect(found('email')).toEqual(['jane.doe@example.org']);
    expect(found('creditCard')).toEqual(['4111 1111 1111 1111']);
    expect(found('ssn')).toEqual(['078-05-1120']);
    expect(found('date')).toEqual(['March 5, 2024', '2024-03-05']);
    const literal = findRedactionMatches(items, 'JANE.DOE', { measure });
    expect(literal).toHaveLength(1);
    const [rect] = literal[0].rects;
    expect(rect[0]).toBeCloseTo(30 + advance('Call (555) 123-4567 or mail ', 10), 3);
    expect(rect[2]).toBeCloseTo(30 + advance('Call (555) 123-4567 or mail jane.doe', 10), 3);
    expect(rect[1]).toBeCloseTo(298, 3);
    expect(rect[3]).toBeCloseTo(308, 3);

    const marks = ['phone', 'email', 'creditCard', 'ssn', 'date'].flatMap((p) =>
      findRedactionMatches(items, REDACTION_PATTERNS[p], { measure }).map((m) => [0, m.rects]),
    );
    const { bytes: out } = await redact(bytes, marks);
    const text = (await textItems(out)).map((i) => i.str).join(' ');
    for (const secret of ['555', 'jane', '4111 1111 1111 1111', '078-05', 'March', '2024'])
      expect(text).not.toContain(secret);
    for (const kept of ['Call', 'today', 'fake 4111 1111 1111 1112', 'SSN', 'born'])
      expect(text.replace(/\s+/g, ' ')).toContain(kept);
    const corpus = await recoverable(out);
    for (const secret of ['jane.doe@example.org', '078-05-1120', '4111 1111 1111 1111'])
      expectGone(corpus, secret);
  });

  it('places exact rects on the matched glyphs from the page content itself', async () => {
    const bytes = await makePdf([
      {
        content: [
          'BT /F 10 Tf 30 300 Td [(Call: ) -500 (jane.doe@example.org) ( today)] TJ ET',
          // Invisible OCR text is found too, and a phrase that wraps gets one rect per line.
          'BT 3 Tr /F 10 Tf 30 250 Td (Wrapping phrase) Tj 0 -12 Td (continues here) Tj ET',
        ].join('\n'),
      },
    ]);
    const doc = await PDFDocument.load(bytes);
    const [email] = await findTextRects(doc, 0, REDACTION_PATTERNS.email);
    expect(email.text).toBe('jane.doe@example.org');
    const start = 30 + advance('Call: ', 10) + 5;
    const [rect] = email.rects;
    expect(rect[0]).toBeCloseTo(start + advance('j', 10) * 0.1, 3);
    expect(rect[2]).toBeCloseTo(
      start + advance('jane.doe@example.org', 10) - advance('g', 10) * 0.1,
      3,
    );
    expect(rect[1]).toBeCloseTo(300 - 2.07 * 0.6, 2);
    expect(rect[3]).toBeCloseTo(300 + 7.18 * 0.85, 2);
    const wrapped = await findTextRects(doc, 0, 'phrase continues');
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0].rects).toHaveLength(2);
    expect(await findTextRects(doc, 0, 'exam', { wholeWord: true })).toHaveLength(0);
    expect(await findTextRects(doc, 0, 'jane', { wholeWord: true })).toHaveLength(1);

    const marks = [email, ...wrapped].map((m) => [0, m.rects]);
    const { bytes: out, report } = await redact(bytes, marks);
    expect(report.text).toBe('jane.doe@example.org'.length + 'phrasecontinues'.length);
    const text = await pageText(out);
    for (const kept of ['Call:', 'today', 'Wrapping', 'here']) expect(text).toContain(kept);
  });

  it('finds text in embedded CID fonts through their ToUnicode map', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(
      await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
    );
    doc.addPage([400, 400]).drawText('SSN 078-05-1120 on file', { x: 40, y: 300, size: 12, font });
    const bytes = await doc.save();
    const matches = await findTextRects(await PDFDocument.load(bytes), 0, REDACTION_PATTERNS.ssn);
    expect(matches.map((m) => m.text)).toEqual(['078-05-1120']);
    const { bytes: out } = await redact(bytes, [[0, matches[0].rects]]);
    expect((await pageText(out)).replace(/\s+/g, ' ')).toBe('SSN on file');
  });
});

it('finds hyphenated patterns in text drawn with a standard font', async () => {
  const { StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([500, 300]).drawText('SSN 123-45-6789 here', { x: 40, y: 200, size: 16, font });
  const reopened = await PDFDocument.load(await doc.save());
  const [match] = await findTextRects(reopened, 0, REDACTION_PATTERNS.ssn);
  expect(match.text).toBe('123-45-6789');
});

it('removes text that shapes a soft mask under the area', async () => {
  // Design tools draw effects such as knocked-out or faded lettering as a soft mask whose group
  // holds the text; it shows on the page and is as readable from the file as page text.
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const group = doc.context.register(
    doc.context.stream('BT /F1 24 Tf 1 g 60 300 Td (MASKSECRET) Tj ET', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 400, 400],
      Group: { S: 'Transparency', CS: 'DeviceGray' },
      Resources: { Font: { F1: font.ref } },
    }),
  );
  const state = doc.context.obj({ Type: 'ExtGState', SMask: { S: 'Luminosity', G: group } });
  page.node.set(
    n('Resources'),
    doc.context.obj({ ExtGState: { GS1: state }, Font: { F1: font.ref } }),
  );
  page.node.set(
    n('Contents'),
    doc.context.register(
      doc.context.stream('q /GS1 gs 0 0 400 400 re f Q BT /F1 12 Tf 60 100 Td (Public) Tj ET'),
    ),
  );
  const { bytes: out, report } = await redact(await doc.save(), [[0, [[50, 290, 300, 330]]]]);
  expect(report.text).toBe(10);
  const corpus = await recoverable(out);
  expectGone(corpus, 'MASKSECRET');
  expect(await pageText(out)).toContain('Public');
  // The masked fill keeps a soft mask, now without the lettering.
  const saved = await PDFDocument.load(out);
  const states = saved.getPage(0).node.Resources().lookup(n('ExtGState'));
  expect(states.keys().map(String)).toEqual(['/RedactedState1']);
  expect(states.lookup(n('RedactedState1')).lookup(n('SMask')).lookup(n('S'))).toBe(
    n('Luminosity'),
  );
});
