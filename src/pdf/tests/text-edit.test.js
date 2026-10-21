import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFString, StandardFonts, degrees, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PdfSession, addText } from '../src/core/document.js';
import { inspectText, parseContent, replaceText, textColor } from '../src/core/text-edit.js';

afterEach(() => vi.restoreAllMocks());
const tasks = [];
afterEach(async () => {
  await Promise.all(tasks.splice(0).map((task) => task.destroy()));
});
async function read(bytes, index = 0, configureLayers) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    useSystemFonts: false,
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  tasks.push(task);
  const pdf = await task.promise;
  const page = await pdf.getPage(index + 1);
  const doc = await PDFDocument.load(bytes);
  const layers = await pdf.getOptionalContentConfig();
  configureLayers?.(layers);
  return {
    doc,
    runs: await inspectText(doc, index, page, pdfjs.OPS, layers),
    content: (await page.getTextContent()).items,
  };
}
async function fixture(source) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F: font.ref } }));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(source)));
  return doc.save();
}

it('offers text editing only for visible content, including nested layers and Form XObjects', async () => {
  const doc = await PDFDocument.create(),
    ctx = doc.context,
    n = PDFName.of;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const off = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Off') }));
  const on = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('On') }));
  const membership = ctx.register(ctx.obj({ Type: 'OCMD', OCGs: [on], VE: ['Not', on] }));
  doc.catalog.set(n('OCProperties'), ctx.obj({ OCGs: [off, on], D: { OFF: [off] } }));
  const text = (label, y) => `BT /F 20 Tf 1 0 0 1 20 ${y} Tm (${label}) Tj ET`;
  const form = ctx.register(
    ctx.flateStream(text('Form', 120), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 400, 400],
      OC: off,
      Resources: { Font: { F: font.ref } },
    }),
  );
  const page = doc.addPage([400, 400]);
  page.node.set(
    n('Resources'),
    ctx.obj({
      Font: { F: font.ref },
      Properties: { Off: off, On: on, Membership: membership },
      XObject: { Fm: form },
    }),
  );
  page.node.set(
    n('Contents'),
    ctx.register(
      ctx.flateStream(`
    /OC /Off BDC /Span BMC ${text('Hidden', 340)} EMC EMC
    /OC /On BDC ${text('Shown', 280)} EMC
    /OC /Off BDC /OC /On BDC ${text('Nested', 220)} EMC EMC
    /OC /Membership BDC ${text('Membership', 160)} EMC
    /Fm Do ${text('Plain', 60)}
  `),
    ),
  );
  const bytes = await doc.save();
  const initial = await read(bytes);
  expect(initial.runs.map((run) => [run.text, run.editable])).toEqual([
    ['Hidden', false],
    ['Shown', true],
    ['Nested', false],
    ['Membership', false],
    ['Form', false],
    ['Plain', true],
  ]);
  const changedLayers = await read(bytes, 0, (layers) => {
    layers.setVisibility(`${off.objectNumber}R`, true);
    layers.setVisibility(`${on.objectNumber}R`, false);
  });
  expect(changedLayers.runs.filter((run) => run.editable).map((run) => run.text)).toEqual([
    'Hidden',
    'Membership',
    'Form',
    'Plain',
  ]);
  await replaceText(
    initial.doc,
    0,
    initial.runs.find((run) => run.text === 'Shown'),
    'Changed',
  );
  const edited = await read(await initial.doc.save());
  expect(edited.runs.filter((run) => run.editable && run.text).map((run) => run.text)).toEqual([
    'Changed',
    'Plain',
  ]);
  expect(edited.runs.filter((run) => !run.editable).map((run) => run.text)).toEqual([
    'Hidden',
    'Nested',
    'Membership',
    'Form',
  ]);
  const editedOff = await read(await initial.doc.save(), 0, (layers) => {
    layers.setVisibility(`${on.objectNumber}R`, false);
  });
  expect(editedOff.runs.filter((run) => run.editable && run.text).map((run) => run.text)).toEqual([
    'Membership',
    'Plain',
  ]);
});

it('parses strings, escaped parentheses, octal, hex, arrays, dictionaries and comments as objects', () => {
  const operations = parseContent(
    '% (fake) Tj\nBT /F#31 12 Tf [(a\\(b\\) Tj) -30 <6364> (\\101\\\nZ)] TJ /Span << /ActualText (other) >> BDC ET',
  );
  expect(operations.map((c) => c.op)).toEqual(['BT', 'Tf', 'TJ', 'BDC', 'ET']);
  expect(operations[1].args[0].value).toBe('F1');
  expect(operations[2].args[0].value.map((t) => t.value)).toEqual(['a(b) Tj', -30, 'cd', 'AZ']);
  expect(() => parseContent('BI /W 1 ID (fake) Tj EI')).toThrow();
  expect(() => parseContent('[(unterminated)')).toThrow();
});

it('reads each font reference from the resources instead of scanning the document', async () => {
  const bytes = await fixture(
    'BT /F 18 Tf 40 300 Td (One) Tj 0 -30 Td [(Two) -20 (three)] TJ 0 -30 Td (Four) Tj ET',
  );
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false });
  tasks.push(task);
  const page = await (await task.promise).getPage(1);
  const doc = await PDFDocument.load(bytes);
  const scans = vi.spyOn(doc.context, 'getObjectRef');
  const runs = await inspectText(doc, 0, page, pdfjs.OPS);
  expect(runs.map((run) => run.text)).toEqual(['One', 'Twothree', 'Four']);
  expect(scans).not.toHaveBeenCalled();
});

it('keeps one fallback font on the page however many times a line is edited', async () => {
  let bytes = await fixture('BT /F 18 Tf 40 300 Td (Hello) Tj ET');
  // Characters outside the original glyphs force the standard-font fallback, and each
  // transaction embeds it again; the page must only point at the one it uses.
  for (const word of ['Bright', 'Quick', 'Zebra', 'Again']) {
    const r = await read(bytes);
    await replaceText(r.doc, 0, r.runs[0], word);
    bytes = await r.doc.save();
  }
  const doc = await PDFDocument.load(bytes);
  const fonts = doc.getPage(0).node.Resources().lookup(PDFName.of('Font'));
  const keys = fonts.entries().map(([key]) => key.toString());
  expect(keys.filter((key) => key.startsWith('/EditedFont'))).toHaveLength(1);
  expect(keys).toContain('/F');
  const last = await read(bytes);
  expect(last.content.map((item) => item.str).join('')).toBe('Again');
  expect(last.runs[0].text).toBe('Again');
});

it.each([
  ['ArialMT', StandardFonts.Helvetica],
  ['Arial-BoldMT', StandardFonts.HelveticaBold],
  ['Arial-ItalicMT', StandardFonts.HelveticaOblique],
  ['Arial-BoldItalicMT', StandardFonts.HelveticaBoldOblique],
  ['TimesNewRomanPSMT', StandardFonts.TimesRoman],
  ['TimesNewRomanPS-BoldMT', StandardFonts.TimesRomanBold],
  ['TimesNewRomanPS-ItalicMT', StandardFonts.TimesRomanItalic],
  ['TimesNewRomanPS-BoldItalicMT', StandardFonts.TimesRomanBoldItalic],
  ['CourierNewPSMT', StandardFonts.Courier],
  ['CourierNewPS-BoldMT', StandardFonts.CourierBold],
  ['CourierNewPS-ItalicMT', StandardFonts.CourierOblique],
  ['CourierNewPS-BoldItalicMT', StandardFonts.CourierBoldOblique],
])(
  'keeps the standard substitute for unembedded %s when adding characters',
  async (alias, expected) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(expected);
    doc.addPage([400, 400]).drawText('Original', { x: 40, y: 300, font, size: 18 });
    await doc.flush();
    doc.context.lookup(font.ref).set(PDFName.of('BaseFont'), PDFName.of(alias));
    const parsed = await read(await doc.save());
    const requests = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
        ),
      );
    await replaceText(parsed.doc, 0, parsed.runs[0], 'Quick zebra');
    const result = await read(await parsed.doc.save());
    expect(result.runs.find((run) => run.text === 'Quick zebra').fontName).toBe(expected);
    expect(requests).not.toHaveBeenCalled();
  },
);

describe('native text replacement', () => {
  for (const [label, show] of [
    ['Tj', '(Original) Tj'],
    ['TJ', '[(Orig) -20 (inal)] TJ'],
    ['quote', "(Original) '"],
    ['double quote', '2 0.5 (Original) "'],
  ]) {
    it(`replaces ${label} while preserving following text positions and line breaks`, async () => {
      const bytes = await fixture(
        `q 0.2 0.4 0.6 rg BT /F 18 Tf 23 TL 0.25 Tc 1 Tw 85 Tz 3 Ts 1 0.1 0.2 1 40 300 Tm (Before ) Tj ${show} ( After) Tj T* (Next line) Tj ET Q`,
      );
      const original = await read(bytes);
      const run = original.runs.find((r) => r.text === 'Original');
      expect(run?.editable).toBe(true);
      await replaceText(original.doc, 0, run, 'Replacement');
      const result = await read(await original.doc.save());
      expect(result.runs.map((r) => r.text).filter(Boolean)).toEqual([
        'Before ',
        'Replacement',
        ' After',
        'Next line',
      ]);
      for (const text of ['Before ', ' After', 'Next line']) {
        const old = original.runs.find((r) => r.text === text);
        const next = result.runs.find((r) => r.text === text);
        next.transform.forEach((n, i) => expect(n).toBeCloseTo(old.transform[i], 5));
      }
      expect(result.content.map((i) => i.str).join(' ')).not.toContain('Original');
      expect(result.content.map((i) => i.str).join(' ')).toContain('Replacement');
    });
  }
  it('supports repeated edits, deletion, no-op, undo and redo without keeping original searchable text', async () => {
    const session = new PdfSession(
      await fixture('BT /F 18 Tf 40 300 Td (Original) Tj ( After) Tj ET'),
    );
    let parsed = await read(session.bytes);
    await session.change((doc) => replaceText(doc, 0, parsed.runs[0], 'Original'));
    expect(session.past).toHaveLength(0);
    await session.change((doc) => replaceText(doc, 0, parsed.runs[0], 'Changed'));
    parsed = await read(session.bytes);
    await session.change((doc) =>
      replaceText(
        doc,
        0,
        parsed.runs.find((r) => r.text === 'Changed'),
        '',
      ),
    );
    expect((await read(session.bytes)).content.map((i) => i.str).join('')).toBe('After');
    session.undo();
    expect((await read(session.bytes)).content.map((i) => i.str).join('')).toContain('Changed');
    session.undo();
    expect((await read(session.bytes)).content.map((i) => i.str).join('')).toContain('Original');
    session.redo();
    expect((await read(session.bytes)).content.map((i) => i.str).join('')).not.toContain(
      'Original',
    );
  });
  it('preserves surrounding text when a replacement spans multiple lines', async () => {
    const parsed = await read(
      await fixture(
        'BT /F 18 Tf 22 TL 40 300 Td (Before ) Tj (Original) Tj ( After) Tj T* (Below) Tj ET',
      ),
    );
    await replaceText(parsed.doc, 0, parsed.runs[1], 'First\nSecond');
    const result = await read(await parsed.doc.save());
    expect(result.runs.map((r) => r.text).filter(Boolean)).toEqual([
      'Before ',
      'First',
      'Second',
      ' After',
      'Below',
    ]);
    for (const text of [' After', 'Below'])
      result.runs
        .find((r) => r.text === text)
        .transform.forEach((n, i) =>
          expect(n).toBeCloseTo(parsed.runs.find((r) => r.text === text).transform[i], 5),
        );
  });
  it('edits just one occurrence of a shared Form XObject and leaves other pages intact', async () => {
    const source = await PDFDocument.create();
    source.addPage([200, 100]).drawText('Shared text', { x: 10, y: 30, size: 16 });
    const doc = await PDFDocument.create();
    const [embedded] = await doc.embedPdf(await source.save());
    const page = doc.addPage([500, 400]);
    page.drawPage(embedded, { x: 20, y: 250 });
    page.drawPage(embedded, { x: 230, y: 100 });
    doc.addPage([500, 400]).drawPage(embedded, { x: 20, y: 250 });
    const parsed = await read(await doc.save());
    expect(parsed.runs.filter((r) => r.text === 'Shared text')).toHaveLength(2);
    await replaceText(parsed.doc, 0, parsed.runs[0], 'Edited here');
    const result = await read(await parsed.doc.save());
    expect(result.runs.map((r) => r.text).filter(Boolean)).toEqual(['Edited here', 'Shared text']);
    expect(result.runs.find((r) => r.text === 'Shared text').transform).toEqual(
      parsed.runs[1].transform,
    );
    expect((await read(await parsed.doc.save(), 1)).runs.map((r) => r.text)).toContain(
      'Shared text',
    );
  });
  it('edits embedded subset text with new supported characters and rejects missing glyphs atomically', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
      ),
    );
    const doc = await PDFDocument.create();
    doc.addPage();
    await addText(doc, 0, { text: 'Added text', x: 40, y: 300 });
    const session = new PdfSession(await doc.save());
    const parsed = await read(session.bytes);
    expect(parsed.runs[0].text).toBe('Added text');
    await session.change((doc) => replaceText(doc, 0, parsed.runs[0], 'Καλημέρα Мир'));
    const result = await read(session.bytes);
    expect(result.content.map((i) => i.str).join('')).toBe('Καλημέρα Мир');
    const bytes = session.bytes.slice(),
      revision = session.revision;
    await expect(
      session.change((doc) =>
        replaceText(
          doc,
          0,
          result.runs.find((r) => r.text),
          '你好',
        ),
      ),
    ).rejects.toThrow('does not support');
    expect(session.bytes).toEqual(bytes);
    expect(session.revision).toBe(revision);
  });
  it('keeps a bold or italic run in its own weight when the fallback font takes over', async () => {
    // Serve whichever Noto face the embedder asks for, so the fallback's weight can be checked.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const file = String(url).split('/').pop();
      return new Response(await readFile(new URL(`../public/fonts/${file}`, import.meta.url)));
    });
    for (const [file, start, added, expected] of [
      ['NotoSans-Bold.ttf', 'Bold text', 'Bold quiz', 'NotoSans-Bold'],
      ['NotoSans-Italic.ttf', 'Slanted words', 'Slanted quiz', 'NotoSans-Italic'],
      ['NotoSans-BoldItalic.ttf', 'Strong slant', 'Strong quiz', 'NotoSans-BoldItalic'],
      ['NotoSans-Regular.ttf', 'Plain text', 'Plain quiz', 'NotoSans-Regular'],
    ]) {
      const doc = await PDFDocument.create();
      const { default: fontkit } = await import('@pdf-lib/fontkit');
      doc.registerFontkit(fontkit);
      const face = await doc.embedFont(
        await readFile(new URL(`../public/fonts/${file}`, import.meta.url)),
        { subset: true },
      );
      doc.addPage([400, 200]).drawText(start, { x: 40, y: 120, size: 20, font: face });
      const parsed = await read(await doc.save());
      // The added characters are outside the subset, so the fallback font is used.
      await replaceText(parsed.doc, 0, parsed.runs[0], added);
      const reopened = await PDFDocument.load(await parsed.doc.save());
      const fonts = reopened.getPage(0).node.Resources().lookup(PDFName.of('Font'));
      // The fallback face is the one an edit added (EditedFontN), not the original still there.
      let fallback;
      for (const [key, ref] of fonts.entries())
        if (key.decodeText().startsWith('EditedFont'))
          fallback = reopened.context
            .lookup(ref)
            .lookup(PDFName.of('BaseFont'))
            .decodeText()
            .replace(/^[A-Z]{6}\+/, '')
            .replace(/-\d+$/, '');
      expect(fallback).toBe(expected);
    }
  });
  it('does not edit text used for clipping or with alternate ActualText', async () => {
    const parsed = await read(
      await fixture(
        'BT /F 18 Tf 40 300 Td 7 Tr (Clip) Tj 0 Tr /Span << /ActualText (Alternate) >> BDC (Actual) Tj EMC ET',
      ),
    );
    expect(parsed.runs.map((r) => r.editable)).toEqual([false, false]);
    await expect(replaceText(parsed.doc, 0, parsed.runs[0], 'changed')).rejects.toThrow();
  });
  it('retains bold fonts, color, skew and rotated page geometry', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 500]);
    page.setRotation(degrees(90));
    const font = await doc.embedFont(StandardFonts.TimesRomanBoldItalic);
    page.drawText('Original', {
      x: 50,
      y: 200,
      size: 20,
      font,
      color: rgb(0.2, 0.5, 0.7),
      rotate: degrees(25),
      xSkew: degrees(10),
    });
    const parsed = await read(await doc.save());
    await replaceText(parsed.doc, 0, parsed.runs[0], 'Different text');
    const result = await read(await parsed.doc.save());
    result.runs
      .find((r) => r.text === 'Different text')
      .transform.forEach((n, i) => expect(n).toBeCloseTo(parsed.runs[0].transform[i], 5));
    expect(result.runs.find((r) => r.text).fontName).toContain('Times');
    expect(result.doc.getPage(0).getRotation().angle).toBe(90);
  });
});

it('changes only the selected text size and color, retaining the next text state', async () => {
  const parsed = await read(
    await fixture('0.2 0.4 0.6 rg BT /F 18 Tf 40 300 Td (Original) Tj ( After) Tj ET'),
  );
  const before = parsed.runs[1];
  await replaceText(parsed.doc, 0, parsed.runs[0], 'Original', { size: 32, hex: '#cc2200' });
  const result = await read(await parsed.doc.save());
  const edited = result.runs.find((r) => r.text === 'Original');
  expect(edited.state.size).toBe(32);
  expect(edited.fillColor).toBe('#cc2200');
  const after = result.runs.find((r) => r.text === ' After');
  expect(after.state.size).toBe(18);
  expect(after.fillColor).toBe(before.fillColor);
  after.transform.forEach((n, i) => expect(n).toBeCloseTo(before.transform[i], 5));
});

it('keeps a line in its own typeface when only its color or size changes', async () => {
  // A subset font with no space glyph spaces its words by kerning, as many producers write it.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const file = String(url).split('/').pop();
    return new Response(await readFile(new URL(`../public/fonts/${file}`, import.meta.url)));
  });
  const doc = await PDFDocument.create();
  const { default: fontkit } = await import('@pdf-lib/fontkit');
  doc.registerFontkit(fontkit);
  const face = await doc.embedFont(
    await readFile(new URL('../public/fonts/GreatVibes-Regular.ttf', import.meta.url)),
    { subset: true },
  );
  const page = doc.addPage([400, 400]);
  const [hello, world] = ['Hello', 'world'].map((word) => face.encodeText(word).toString());
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F: face.ref } }));
  page.node.set(
    PDFName.of('Contents'),
    doc.context.register(
      doc.context.flateStream(`BT /F 20 Tf 40 300 Td [${hello} -300 ${world}] TJ ET`),
    ),
  );
  const bytes = await doc.save();
  const parsed = await read(bytes);
  expect(parsed.runs[0].text).toBe('Hello world');
  const width = parsed.content[0].width;
  for (const [options, scale] of [
    [{ hex: '#cc2200' }, 1],
    [{ size: 30 }, 1.5],
  ]) {
    const { doc: edited, runs } = await read(bytes);
    await replaceText(edited, 0, runs[0], 'Hello world', options);
    const result = await read(await edited.save());
    const run = result.runs.find((r) => r.text === 'Hello world');
    expect(run.fontName).toMatch(/GreatVibes/);
    expect(result.content[0].str).toBe('Hello world');
    expect(result.content[0].width).toBeCloseTo(width * scale, 3);
  }
});

it('reads and restores text stroke colors and widths without recoloring a no-op edit', async () => {
  const parsed = await read(
    await fixture(
      'q 0.2 0.4 0.6 RG 2.5 w BT /F 20 Tf 1 Tr 40 300 Td (A) Tj ET ' +
        'q 1 0 0 RG 4 w 0.1 0.2 0.3 rg BT /F 20 Tf 2 Tr 40 260 Td (B) Tj ET Q ' +
        'BT /F 20 Tf 40 220 Td (C) Tj ET Q BT /F 20 Tf 40 180 Td (D) Tj ET',
    ),
  );
  expect(parsed.runs.map((run) => run.strokeColor)).toEqual([
    '#336699',
    '#ff0000',
    '#336699',
    '#000000',
  ]);
  expect(parsed.runs.map((run) => run.strokeWidth)).toEqual([2.5, 4, 2.5, 1]);
  expect(parsed.runs.map(textColor)).toEqual(['#336699', '#1a334c', '#336699', '#000000']);
  const run = parsed.runs[0];
  expect(await replaceText(parsed.doc, 0, run, run.text, { hex: textColor(run) })).toBe(false);
});

it('reads hairlines and line widths from text graphics states', async () => {
  const bytes = await fixture(
    '/Wide gs BT /F 20 Tf 1 Tr 40 300 Td (A) Tj ET ' +
      'q /Thin gs BT /F 20 Tf 40 260 Td (B) Tj ET Q ' +
      'BT /F 20 Tf 40 220 Td (C) Tj ET',
  );
  const doc = await PDFDocument.load(bytes);
  doc
    .getPage(0)
    .node.Resources()
    .set(
      PDFName.of('ExtGState'),
      doc.context.obj({
        Wide: { LW: 4 },
        Thin: { LW: 0 },
      }),
    );
  const parsed = await read(await doc.save());
  expect(parsed.runs.map((run) => run.strokeWidth)).toEqual([4, 0, 4]);
});

it('recolors text drawn in a stroke render mode so the change is visible', async () => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const ink = async (bytes) => {
    const task = pdfjs.getDocument({
      data: bytes.slice(),
      standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
        .pathname,
    });
    try {
      const page = await (await task.promise).getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let i = 0; i < data.length; i += 4)
        if (data[i + 3] > 10 && !(data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240)) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      return n ? [r / n, g / n, b / n] : [255, 255, 255];
    } finally {
      await task.destroy();
    }
  };
  // Blue-stroked text (render mode 1 paints the stroke colour, not the fill).
  const parsed = await read(await fixture('0 0 1 RG 2 w BT /F 40 Tf 1 Tr 20 60 Td (STROKE) Tj ET'));
  const [, , blue] = await ink(await parsed.doc.save());
  expect(blue).toBeGreaterThan(200);
  await replaceText(parsed.doc, 0, parsed.runs[0], 'STROKE', { hex: '#ff0000' });
  const [r, g, b] = await ink(await parsed.doc.save());
  expect(r).toBeGreaterThan(150);
  expect(g).toBeLessThan(140);
  expect(b).toBeLessThan(140);
});

it('keeps rendered background graphics and all pixels outside the edited line intact', async () => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const bytes = await fixture(
    '0.2 0.6 0.7 rg 0 0 400 400 re f 1 0.7 0.2 rg 20 20 80 80 re f 0 0 0 rg BT /F 18 Tf 40 300 Td (Original) Tj 0 -70 Td (Unchanged) Tj ET',
  );
  const render = async (bytes) => {
    const task = pdfjs.getDocument({
      data: bytes.slice(),
      standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
        .pathname,
    });
    tasks.push(task);
    const page = await (await task.promise).getPage(1);
    const canvas = createCanvas(400, 400),
      context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport: page.getViewport({ scale: 1 }) }).promise;
    return context.getImageData(0, 0, 400, 400).data;
  };
  const before = await render(bytes);
  const parsed = await read(bytes);
  await replaceText(parsed.doc, 0, parsed.runs[0], 'Replacement');
  const after = await render(await parsed.doc.save());
  let changedInside = 0,
    changedOutside = 0;
  for (let y = 0; y < 400; y++)
    for (let x = 0; x < 400; x++) {
      const i = (y * 400 + x) * 4;
      if (before.slice(i, i + 4).some((value, j) => value !== after[i + j])) {
        if (x >= 38 && x < 190 && y >= 78 && y < 110) changedInside++;
        else changedOutside++;
      }
    }
  expect(changedInside).toBeGreaterThan(100);
  expect(changedOutside).toBe(0);
  expect([...after.slice((105 * 400 + 40) * 4, (105 * 400 + 40) * 4 + 3)]).toEqual([51, 153, 178]);
});

for (const show of ['(Move me) Tj', '[(Move) -300 (me)] TJ', "(Move me) '", '2 .5 (Move me) "'])
  it(`moves ${show} without changing original glyph commands, fonts, kerning or following text`, async () => {
    const bytes = await fixture(
      `q 1 .1 .2 1 10 20 cm BT /F 18 Tf 23 TL .25 Tc 1 Tw 85 Tz 3 Ts 1 .1 .2 1 40 300 Tm (Before) Tj ${show} (After) Tj T* (Next) Tj ET Q`,
    );
    const parsed = await read(bytes),
      run = parsed.runs[1];
    await replaceText(parsed.doc, 0, run, run.text, { offset: [30, -60] });
    const result = await read(await parsed.doc.save()),
      moved = result.runs.find((r) => r.text === run.text);
    const value = (arg) => (Array.isArray(arg.value) ? arg.value.map((t) => t.value) : arg.value);
    expect(value(moved.args.at(-1))).toEqual(value(run.args.at(-1)));
    expect(moved.fontName).toBe(run.fontName);
    expect(moved.advance).toBeCloseTo(run.advance, 8);
    moved.transform.forEach((n, i) =>
      expect(n).toBeCloseTo(run.transform[i] + (i === 4 ? 30 : i === 5 ? -60 : 0), 5),
    );
    for (const text of ['Before', 'After', 'Next']) {
      const oldRun = parsed.runs.find((r) => r.text === text),
        newRun = result.runs.find((r) => r.text === text);
      newRun.transform.forEach((n, i) => expect(n).toBeCloseTo(oldRun.transform[i], 5));
      const extracted = result.content.find((item) => item.str === text);
      if (extracted)
        extracted.transform.forEach((n, i) => expect(n).toBeCloseTo(oldRun.transform[i], 5));
    }
  });

it('moves kerned text with identical glyph pixels and unchanged pixels everywhere else', async () => {
  const { createCanvas } = await import('@napi-rs/canvas');
  const bytes = await fixture(
    '0.2 0.6 0.7 rg 0 0 400 400 re f 0 0 0 rg BT /F 18 Tf .25 Tc 1 Tw 40 300 Td [(A) 100 (V) -280 (word)] TJ ( neighbor) Tj ET',
  );
  const render = async (bytes) => {
    const task = pdfjs.getDocument({
      data: bytes.slice(),
      standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
        .pathname,
    });
    tasks.push(task);
    const page = await (await task.promise).getPage(1),
      c = createCanvas(400, 400),
      ctx = c.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: 1 }) }).promise;
    return ctx.getImageData(0, 0, 400, 400).data;
  };
  const before = await render(bytes),
    parsed = await read(bytes),
    run = parsed.runs[0];
  await replaceText(parsed.doc, 0, run, run.text, { offset: [20, -60] });
  const after = await render(await parsed.doc.save());
  let changed = 0,
    outside = 0;
  for (let y = 0; y < 400; y++)
    for (let x = 0; x < 400; x++) {
      const i = (y * 400 + x) * 4;
      if (before.slice(i, i + 4).some((v, j) => v !== after[i + j])) {
        changed++;
        if (!(
          (x >= 40 && x < 108 && y >= 80 && y < 103) ||
          (x >= 60 && x < 128 && y >= 140 && y < 163)
        ))
          outside++;
      }
    }
  expect(changed).toBeGreaterThan(300);
  expect(outside).toBe(0);
  for (let y = 80; y < 103; y++)
    for (let x = 40; x < 108; x++) {
      const a = (y * 400 + x) * 4,
        b = ((y + 60) * 400 + x + 20) * 4;
      expect(after.slice(b, b + 4)).toEqual(before.slice(a, a + 4));
    }
});

it('moves and rewrites a shared text occurrence without changing the reused form on other pages', async () => {
  const source = await PDFDocument.load(await fixture('BT /F 18 Tf 30 80 Td (Shared text) Tj ET'));
  const doc = await PDFDocument.create(),
    form = await doc.embedPage(source.getPage(0));
  doc.addPage([400, 400]).drawPage(form, { x: 0, y: 0, width: 200, height: 200 });
  doc.addPage([400, 400]).drawPage(form, { x: 100, y: 100, width: 200, height: 200 });
  const bytes = await doc.save(),
    session = new PdfSession(bytes),
    original = await read(bytes),
    other = await read(bytes, 1);
  await session.change((d) =>
    replaceText(d, 0, original.runs[0], 'Moved text', {
      offset: [25, 40],
      size: 22,
      hex: '#cc2200',
    }),
  );
  const result = await read(session.bytes),
    untouched = await read(session.bytes, 1),
    moved = result.runs.find((r) => r.text === 'Moved text');
  expect(moved.transform[4]).toBeCloseTo(original.runs[0].transform[4] + 25, 6);
  expect(moved.transform[5]).toBeCloseTo(original.runs[0].transform[5] + 40, 6);
  const stable = (items) => items.map(({ fontName, ...item }) => item);
  expect(stable(untouched.content)).toEqual(stable(other.content));
  session.undo();
  expect(session.bytes).toEqual(bytes);
});

it('moves text with very small local coordinates without writing invalid exponential PDF numbers', async () => {
  const parsed = await read(
    await fixture(
      'q 1000000 0 0 1000000 0 0 cm BT /F .000018 Tf .00004 .0003 Td (Small coordinates) Tj ET Q',
    ),
  );
  const run = parsed.runs[0];
  expect(run.transform[4]).toBe(40);
  await replaceText(parsed.doc, 0, run, run.text, { offset: [0.1, -0.2] });
  const result = await read(await parsed.doc.save()),
    moved = result.runs.find((r) => r.text === run.text);
  expect(moved).toBeDefined();
  expect(moved.transform[4]).toBeCloseTo(40.1, 8);
  expect(moved.transform[5]).toBeCloseTo(299.8, 8);
  const extracted = result.content.find((i) => i.str === run.text);
  expect(extracted.transform[4]).toBeCloseTo(40.1, 8);
  expect(extracted.transform[5]).toBeCloseTo(299.8, 8);
});
