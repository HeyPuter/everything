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
  overlayTextUnsupported,
  removeRedactionMark,
  selectionRedactionRects,
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

// A small grayscale (one-component) JPEG, written by macOS's image tools from a textured gradient.
const GRAY_JPEG =
  '/9j/wAALCAAwAGABAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9' +
  'AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVW' +
  'V1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW' +
  '19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9sAQwAEBAQEBAQGBAQGCQYGBgkMCQkJCQwPDAwMDAwPEg8PDw8PDxISEhIS' +
  'EhISFRUVFRUVGRkZGRkcHBwcHBwcHBwc/90ABAAM/9oACAEBAAA/AO28N3f2dV3E8Dg8D6nqfX/PSvVLbV4Eg6gdgPvd' +
  'OPTt+P8AjmanqscoKht4P3cEDAx6HAz/APXrxLxPIZFYjaWOSp6HkY44/CvDNe0y4nJJUkqDzgj8c46jHvXMQaJOJcFW' +
  'KAjqCOBknPuDx9a9G0GzaArIynAP0HT9M+9e8+HbmK2Malck8Ef4n27ivWbXWrVEzuCjaQNuP8nn/PrS1PV450JToeSP' +
  'UZ46/wCTXjHiOWO4VvLbd1P056nHFeDa3p00zE7SC3QL0B9j6fSv/9Bh1n+z8Mh2gAH2646dT/WoV8abAfLYADjB64yD' +
  'jg/5/GkTxY90nLB1PHzHp6fUn+dWw7XozncGHBwck8Y/z2qwPDEd2N2zgYOf9odgacPA+T5hjAYEc4A79SOxPXn8Kil0' +
  'IWDDAKgZBJHsO2SeKqnUGs0AUn5WJyPTPt/Id6rN40KN/reg+7k/XnGDn8KF8WeeXi8wswAxnPAx6c/yq+k32whkcbur' +
  'dcZPfuKlj8OJdn5fnLevBP8AXnNf/9HhPEtxMplVQxOOCePfNeTXeqXCysqkt6/3j2GBxkVp6Pqc7SpliA2FwOvuc+o6' +
  '17n4YV5MDdwWySRzjv8Aj+HWvetCsEZEDqoHDZzxz3B6ZrrrjToVQA/KVHJGOuCP8/5NedeIreOIPuUZY5Hr/P8Al618' +
  '8eKJDAXQjDEFiTg9fXFeQXepzK5Mjktk5UfXke+f1/CremanI0itu6HjHXv/AF7Zr27wqwl/1iLknGe3Ycj6/n7V9BaF' +
  'YxsIy6Lgjntx9P8AGv/S5LW7B7ksec54GMnp3/pXns/ht5WchTtznoef17fyq5YaBJE6sVweODwAMkdfTj/Oa9Z0CA2g' +
  'TcuwLyx9/T6fjn6V65pOtrCqFztAAOPTvx6dOMfnXSP4lhk3KGyTkEcDnoM9+ecnr+FcTrmsQXKttJKnp1447D6D/PNe' +
  'M67am7BQIMDAGOwPvn0rzm88OTznzUUjJzjP06ZHHTNTWPh+aKRvNAAPcjjofQc+1esaJD9hUEjywPXAJ4PevWdJ1aKB' +
  'UEjZIHYjsPr2r//T17LSjcgBV+X1H97tnp9fT610CeDUOTsOGJAJGRjIJ47/AOe9VrnwmId+A3TGSR19z6/riuVvV+yK' +
  'QAflOM8AjHX1HT6VyF14lNrIoEh7gnPPHfnn8v8AGs8+NmdtxkI+bjrkkD159hW9Y61LeFfmG7J+XJHB64APTPQ+2a66' +
  'w08XhXdFweSByecdPr7n+ldPF4OWVSFXr7HaMnpnjsfTPNQXPhQW/wA5RWPTjg++c/56Vy97btYhiASyfwjOPxA479K4' +
  'u58QtaHaG5GGHc9eo/8A1kV//9TvfDAi+XAX7vHuDx+I9/xr2CzW3ePc/Q9eOnGc+p4HH0zWZrCQGLggcde2R+H/AOvk' +
  'V4D4pVUEm5WOASSvPX6+x5r5916SWOUgA7u3XGQT7D8OK4+B7jzdxzk7QCOSOMg+9en+GlkDLli33Sc9yT6/y5/nX0b4' +
  'XUEAE7SB7j5R07cV7LYrG0YWQgo3OCfU5xxmqWqJbrHIgXjG3HQD365rwjxWFEcmGODyPbn0Hv05r5615pEdmHBBPCjO' +
  'Tz7/AOfxr//Z';

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

  it('takes what a whole-page mark’s page draws beyond its boxes too', async () => {
    // Text and drawings placed outside the media box show in no reader, but the file holds them.
    const content = [
      'BT /F 12 Tf 40 200 Td (Shown SECRET) Tj ET',
      'BT /F 12 Tf 40 -50 Td (Hidden OFFPAGE) Tj ET',
      'BT /F 12 Tf 900 200 Td (Beyond RIGHTSIDE) Tj ET',
      '500 500 20 20 re f',
    ].join('\n');
    const bytes = await makePdf([
      { content, size: [300, 300] },
      { content, size: [300, 300] },
    ]);
    const { bytes: out, report } = await redact(bytes, [
      [0, [[0, 0, 300, 300]]],
      // An ordinary mark keeps to its area.
      [1, [[30, 190, 200, 215]]],
    ]);
    expect(report.paths).toBe(1);
    expect(await pageText(out, 0)).toBe('');
    expect(await pageText(out, 1)).not.toContain('SECRET');
    const second = pageSource((await PDFDocument.load(out)).getPage(1));
    for (const word of ['OFFPAGE', 'RIGHTSIDE'])
      expect(second.includes(word) || second.includes(hexOf(word).toUpperCase())).toBe(true);
    const first = pageSource((await PDFDocument.load(out)).getPage(0));
    for (const word of ['SECRET', 'OFFPAGE', 'RIGHTSIDE']) {
      expect(first).not.toContain(word);
      expect(first.toLowerCase()).not.toContain(hexOf(word).toLowerCase());
    }
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

  it('keeps a redacted colour JPEG a JPEG when an encoder is at hand', async () => {
    // A photo-like picture: stored losslessly after redaction, a JPEG grows several times over.
    const canvas = createCanvas(320, 160);
    const ctx = canvas.getContext('2d');
    for (let y = 0; y < 160; y += 4)
      for (let x = 0; x < 320; x += 4) {
        ctx.fillStyle = `rgb(${(x * 7 + y * 3) % 256}, ${(x * y) % 256}, ${(y * 11) % 256})`;
        ctx.fillRect(x, y, 4, 4);
      }
    const jpeg = canvas.toBuffer('image/jpeg', 80);
    const picture = (doc, data, space) =>
      doc.context.register(
        doc.context.stream(data, {
          Type: 'XObject',
          Subtype: 'Image',
          Width: 320,
          Height: 160,
          ColorSpace: space,
          BitsPerComponent: 8,
          Filter: 'DCTDecode',
        }),
      );
    const bytes = await makePdf([
      {
        content: 'q 320 0 0 160 0 0 cm /Photo Do Q',
        resources: (doc) => ({ XObject: { Photo: picture(doc, jpeg, 'DeviceRGB') } }),
      },
    ]);
    const encoded = [];
    const codec = {
      async encodeJpeg({ data, width, height }, quality) {
        const out = createCanvas(width, height);
        const context = out.getContext('2d');
        const pixels = context.createImageData(width, height);
        pixels.data.set(data);
        context.putImageData(pixels, 0, 0);
        encoded.push(quality);
        return new Uint8Array(out.toBuffer('image/jpeg', Math.round(quality * 100)));
      },
    };
    const lossless = await redact(bytes, [[0, [[0, 0, 100, 160]]]]);
    const { bytes: out, report } = await redact(bytes, [[0, [[0, 0, 100, 160]]]], { codec });
    expect(report.images.redacted).toBe(1);
    expect(encoded).toEqual([0.92]);
    expect(out.length).toBeLessThan(lossless.bytes.length / 2);
    const doc = await PDFDocument.load(out);
    const [image] = Object.values(pageImages(doc));
    expect(image.dict.lookup(n('Filter'))).toBe(n('DCTDecode'));
    expect(image.dict.lookup(n('ColorSpace'))).toBe(n('DeviceRGB'));
    // The area was painted before encoding: it decodes as the fill, give or take a little.
    const decoder = new JpegImage();
    decoder.parse(image.contents);
    const pixels = decoder.getData({ width: 320, height: 160 });
    for (const [x, y] of [
      [2, 2],
      [50, 80],
      [90, 150],
    ])
      for (const value of pixels.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3))
        expect(value).toBeLessThan(8);
    // The original's scan data is not left behind (its header tables can match the new one's).
    const middle = jpeg.length >> 1;
    expect(Buffer.from(out).includes(jpeg.subarray(middle, middle + 60))).toBe(false);
  });

  it('keeps a redacted grayscale scan a JPEG, as three equal colour components', async () => {
    // A 96 × 48 one-component (DeviceGray) JPEG, as scanners write pages in shades of gray.
    const jpeg = Buffer.from(GRAY_JPEG, 'base64');
    const original = new JpegImage();
    original.parse(jpeg);
    expect(original.numComponents).toBe(1);
    const before = original.getData({ width: 96, height: 48 });
    const scan = (intent) =>
      makePdf([
        {
          content: 'q 96 0 0 48 0 0 cm /Scan Do Q',
          resources: (doc) => {
            if (intent)
              doc.catalog.set(
                n('OutputIntents'),
                doc.context.obj([
                  {
                    Type: 'OutputIntent',
                    S: 'GTS_PDFA1',
                    DestOutputProfile: doc.context.register(doc.context.stream('', { N: intent })),
                  },
                ]),
              );
            return {
              XObject: {
                Scan: doc.context.register(
                  doc.context.stream(jpeg, {
                    Type: 'XObject',
                    Subtype: 'Image',
                    Width: 96,
                    Height: 48,
                    ColorSpace: 'DeviceGray',
                    BitsPerComponent: 8,
                    Filter: 'DCTDecode',
                  }),
                ),
              },
            };
          },
        },
      ]);
    const codec = {
      async encodeJpeg({ data, width, height }, quality) {
        const out = createCanvas(width, height);
        const context = out.getContext('2d');
        const pixels = context.createImageData(width, height);
        pixels.data.set(data);
        context.putImageData(pixels, 0, 0);
        return new Uint8Array(out.toBuffer('image/jpeg', Math.round(quality * 100)));
      },
    };
    const bytes = await scan();
    const area = [[0, [[0, 0, 30, 48]]]];
    const lossless = await redact(bytes, area);
    const { bytes: out, report } = await redact(bytes, area, { codec });
    expect(report.images.redacted).toBe(1);
    expect(out.length).toBeLessThan(lossless.bytes.length);
    const doc = await PDFDocument.load(out);
    const [image] = Object.values(pageImages(doc));
    expect(image.dict.lookup(n('Filter'))).toBe(n('DCTDecode'));
    expect(image.dict.lookup(n('ColorSpace'))).toBe(n('DeviceRGB'));
    const decoder = new JpegImage();
    decoder.parse(image.contents);
    const pixels = decoder.getData({ width: 96, height: 48 });
    for (let y = 0; y < 48; y += 5)
      for (let x = 0; x < 96; x += 5) {
        const rgb = [...pixels.subarray((y * 96 + x) * 3, (y * 96 + x) * 3 + 3)];
        // The painted area decodes as the fill; the rest as the scan, in gray.
        if (x < 30) for (const value of rgb) expect(value).toBeLessThan(10);
        else if (x > 34)
          for (const value of rgb) expect(Math.abs(value - before[y * 96 + x])).toBeLessThan(40);
        expect(Math.max(...rgb) - Math.min(...rgb)).toBeLessThan(10);
      }
    const middle = jpeg.length >> 1;
    expect(Buffer.from(out).includes(jpeg.subarray(middle, middle + 60))).toBe(false);
    // A file meant for CMYK printing (PDF/A or PDF/X with a CMYK output intent) may not use
    // DeviceRGB: its scan stays gray, stored losslessly.
    const printed = await redact(await scan(4), area, { codec });
    const [kept] = Object.values(pageImages(await PDFDocument.load(printed.bytes)));
    expect(kept.dict.lookup(n('ColorSpace'))).toBe(n('DeviceGray'));
    expect(kept.dict.lookup(n('Filter'))).toBe(n('FlateDecode'));
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
    // Its alternate text describes the link, and would be read out in its place.
    const element = doc.context.register(
      doc.context.obj({
        Type: 'StructElem',
        S: 'Link',
        K: [objr],
        Pg: page.ref,
        Alt: PDFString.of('Link to the private page'),
        ActualText: PDFString.of('example.com/private'),
      }),
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
    expectGone(corpus, 'Link to the private page');
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

  it('says when overlay text has characters its font cannot show', async () => {
    expect(overlayTextUnsupported('Exempt (b)(6) – Rédigé')).toEqual([]);
    expect(overlayTextUnsupported('機密 ✓ 機密')).toEqual(['機', '密', '✓']);
    const bytes = await makePdf([{ content: 'BT /F 12 Tf 72 300 Td (SECRET) Tj ET' }]);
    // The characters were dropped from the applied mark without a word.
    const { report } = await redact(bytes, [
      [0, [[70, 290, 130, 315]], { overlayText: '機密 Confidential' }],
    ]);
    expect(report.warnings).toContain(
      'Overlay text on page 1 has characters the overlay font cannot show; they were left out.',
    );
    const plain = await redact(bytes, [[0, [[70, 290, 130, 315]], { overlayText: 'Redacted' }]]);
    expect(plain.report.warnings).toEqual([]);
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

  it('finds numbers set with non-breaking hyphens, en dashes, and minus signs', async () => {
    // Word processors keep a number on one line with non-breaking hyphens (U+2011), and en
    // dashes and minus signs stand in for hyphens; none of these numbers were found.
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(
      await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
    );
    const page = doc.addPage([500, 300]);
    page.drawText('Call 555\u2011123\u20114567 or (555) 123\u20134567', {
      x: 20,
      y: 250,
      size: 12,
      font,
    });
    page.drawText('SSN 078\u221205\u22121120 card 4111\u20111111\u20111111\u20111111', {
      x: 20,
      y: 200,
      size: 12,
      font,
    });
    page.drawText('Born 2024\u201103\u201105 and 05\u201303\u20132024', {
      x: 20,
      y: 150,
      size: 12,
      font,
    });
    const reopened = await PDFDocument.load(await doc.save());
    const found = async (pattern) =>
      (await findTextRects(reopened, 0, REDACTION_PATTERNS[pattern])).map((m) => m.text);
    expect(await found('phone')).toEqual(['555\u2011123\u20114567', '(555) 123\u20134567']);
    expect(await found('ssn')).toEqual(['078\u221205\u22121120']);
    expect(await found('creditCard')).toEqual(['4111\u20111111\u20111111\u20111111']);
    expect(await found('date')).toEqual(['2024\u201103\u201105', '05\u201303\u20132024']);
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

  it('reads a page once for several searches that share a cache', async () => {
    const bytes = await makePdf([
      { content: 'BT /F 10 Tf 30 300 Td (Call 555-123-4567 or jane.doe@example.org) Tj ET' },
    ]);
    const doc = await PDFDocument.load(bytes);
    const queries = ['call', REDACTION_PATTERNS.phone, REDACTION_PATTERNS.email];
    const plain = [];
    for (const query of queries) plain.push(await findTextRects(doc, 0, query));
    // Each search walked the page's content again; Find text and redact runs six per page.
    const cache = new Map();
    const shared = [];
    for (const query of queries) shared.push(await findTextRects(doc, 0, query, { cache }));
    expect(shared).toEqual(plain);
    expect([...cache.keys()]).toEqual([0]);
    const layout = cache.get(0);
    await findTextRects(doc, 0, 'jane', { cache });
    expect(cache.get(0)).toBe(layout);
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

it('marks a text selection on its glyphs, not on the line box that reaches the next line', async () => {
  // Word sets single-spaced 12 pt text 13.8 pt apart; Noto Sans (like Arial) reaches further
  // above and below its baseline than that leaves between two lines.
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(
    await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
  );
  const sheet = doc.addPage([400, 300]);
  ['Alpha SECRET Bravo', 'Charlie Delta Echo'].forEach((line, i) =>
    sheet.drawText(line, { x: 40, y: 200 - i * 13.8, size: 12, font }),
  );
  const bytes = await doc.save();
  // The quad a browser measures for the selected word: its CSS line box, from 0.3 em below the
  // baseline to 1.1 em above it, and a little wider than the word.
  const x0 = 40 + font.widthOfTextAtSize('Alpha ', 12) - 1,
    x1 = 40 + font.widthOfTextAtSize('Alpha SECRET', 12) + 1;
  const quad = [x0, 213.2, x1, 213.2, x0, 196.4, x1, 196.4];
  const rects = await selectionRedactionRects(await PDFDocument.load(bytes), 0, [quad]);
  expect(rects).toHaveLength(1);
  expect(rects[0][1]).toBeGreaterThan(196.4);
  const { bytes: out, report } = await redact(bytes, [[0, rects]]);
  expect(report.text).toBe('SECRET'.length);
  const text = await pageText(out);
  expect(text).not.toContain('SECRET');
  expect(text).toContain('Charlie Delta Echo');
  // A quad over no glyph (the layer and the page disagree) is marked as it stands.
  const empty = [300, 100, 340, 100, 300, 90, 340, 90];
  expect(await selectionRedactionRects(await PDFDocument.load(bytes), 0, [empty])).toEqual([
    [300, 90, 340, 100],
  ]);
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

it('removes text that a repeating pattern paints under the area', async () => {
  // A tiling pattern draws its cell again and again over the shape it fills; text in the cell
  // shows under the mark in one of the repetitions and is as readable from the file as page text.
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const pattern = doc.context.register(
    doc.context.stream('BT /F1 10 Tf 10 40 Td (TILESECRET) Tj ET', {
      Type: 'Pattern',
      PatternType: 1,
      PaintType: 1,
      TilingType: 1,
      BBox: [0, 0, 100, 100],
      XStep: 100,
      YStep: 100,
      Resources: { Font: { F1: font.ref } },
    }),
  );
  page.node.set(
    n('Resources'),
    doc.context.obj({ Pattern: { P1: pattern }, Font: { F1: font.ref } }),
  );
  page.node.set(
    n('Contents'),
    doc.context.register(
      doc.context.stream(
        'q /Pattern cs /P1 scn 0 200 400 200 re f Q BT /F1 12 Tf 60 100 Td (Public) Tj ET',
      ),
    ),
  );
  const { bytes: out, report } = await redact(await doc.save(), [[0, [[205, 235, 300, 255]]]]);
  expect(report.text).toBe(10);
  expect(report.warnings).toContain(
    'Content of a repeating pattern under a mark was removed from every repetition of it.',
  );
  expectGone(await recoverable(out), 'TILESECRET');
  expect(await pageText(out)).toContain('Public');
  // The shape is still filled with the pattern, now without the lettering.
  const saved = await PDFDocument.load(out);
  const patterns = saved.getPage(0).node.Resources().lookup(n('Pattern'));
  expect(patterns.keys().map(String)).toEqual(['/RedactedPattern1']);
  expect(pageSource(saved.getPage(0))).toContain('/RedactedPattern1 scn');
});

it('removes a field everywhere it shows when one of its widgets is under the area', async () => {
  // A field repeated on another page (or kept in a hidden widget) holds one value; removing
  // only the widget under the mark left the value in the file and on the other page.
  for (const hidden of [false, true]) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const other = doc.addPage([400, 400]);
    const form = doc.getForm();
    const secret = form.createTextField('ssn');
    secret.setText('123-45-6789');
    secret.addToPage(page, { x: 50, y: 300, width: 120, height: 20 });
    secret.addToPage(other, { x: 50, y: 300, width: 120, height: 20, hidden });
    secret.addToPage(page, { x: 50, y: 50, width: 120, height: 20 });
    const kept = form.createTextField('name');
    kept.setText('Visible Person');
    kept.addToPage(other, { x: 50, y: 100, width: 120, height: 20 });
    const { bytes: out, report } = await redact(await doc.save(), [[0, [[40, 290, 200, 330]]]]);
    expect(report).toMatchObject({ annotations: 3, fields: 1 });
    const saved = await PDFDocument.load(out);
    expect(
      saved
        .getForm()
        .getFields()
        .map((field) => field.getName()),
    ).toEqual(['name']);
    expect(saved.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
    expect(saved.getPage(1).node.Annots().size()).toBe(1);
    const corpus = await recoverable(out);
    expectGone(corpus, '123-45-6789');
    expect(contains(corpus, 'Visible Person')).toBe(true);
  }
});

it("removes the page's private application data, which holds a copy of what was redacted", async () => {
  // Illustrator keeps its own copy of the artwork in the page's PieceInfo when saving PDFs
  // that stay editable there.
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  page.node.set(n('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
  page.node.set(
    n('Contents'),
    doc.context.register(doc.context.stream('BT /F1 12 Tf 60 300 Td (PAGESECRET) Tj ET')),
  );
  const copy = doc.context.register(doc.context.flateStream('%AI12 artwork: (PAGESECRET) Tx'));
  page.node.set(
    n('PieceInfo'),
    doc.context.obj({
      Illustrator: { LastModified: PDFString.of('D:20200101'), Private: { AIPrivateData1: copy } },
    }),
  );
  const { bytes: out } = await redact(await doc.save(), [[0, [[50, 290, 300, 330]]]]);
  expectGone(await recoverable(out), 'PAGESECRET');
  expect((await PDFDocument.load(out)).getPage(0).node.has(n('PieceInfo'))).toBe(false);
});
