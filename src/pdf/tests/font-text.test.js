import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { addText, embedFont, assertSupportedText, fillFields } from '../src/core/document.js';
import { prepareText } from '../src/core/text-edit.js';
import { addWatermark } from '../src/core/page-marks.js';

afterEach(() => vi.restoreAllMocks());

async function pixels(text, variant, kind = 'text') {
  const doc = await PDFDocument.create();
  doc.addPage([300, 180]);
  if (kind === 'form') {
    const field = doc.getForm().createTextField('Text');
    field.addToPage(doc.getPage(0), { x: 20, y: 20, width: 260, height: 140, borderWidth: 0 });
    field.setFontSize(80);
    await fillFields(doc, { Text: text });
    expect(field.getText()).toBe(text);
  } else if (kind === 'watermark') {
    await addWatermark(doc, [0], { text, layout: 'horizontal', opacity: 1 });
  } else {
    await addText(doc, 0, { text, variant, x: 30, y: 40, size: 100 });
  }
  const task = pdfjs.getDocument({ data: await doc.save() });
  try {
    const page = await (await task.promise).getPage(1);
    const canvas = createCanvas(300, 180);
    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: page.getViewport({ scale: 1 }),
    }).promise;
    return canvas.getContext('2d').getImageData(0, 0, 300, 180).data;
  } finally {
    await task.destroy();
  }
}

it.each(['form', 'watermark'])(
  'uses matching canonical glyphs and metrics in a %s',
  async (kind) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
      ),
    );
    const composed = await pixels('Äü', 'regular', kind);
    const decomposed = await pixels('Äü'.normalize('NFD'), 'regular', kind);
    let difference = 0;
    for (let i = 0; i < composed.length; i++) difference += Math.abs(composed[i] - decomposed[i]);
    expect(difference).toBe(0);
  },
);

for (const variant of ['regular', 'bold', 'italic', 'boldItalic']) {
  it(`renders equivalent Unicode accents identically in ${variant} text`, async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url) =>
        new Response(
          await readFile(
            new URL(`../public/fonts/${String(url).split('/').pop()}`, import.meta.url),
          ),
        ),
    );
    for (const text of ['Ä', 'í', 'ü', 'ἄ']) {
      const composed = await pixels(text, variant);
      const decomposed = await pixels(text.normalize('NFD'), variant);
      let difference = 0;
      for (let i = 0; i < composed.length; i++) difference += Math.abs(composed[i] - decomposed[i]);
      expect(difference, text).toBe(0);
    }
  });
}

it('accepts supported decompositions without accepting missing glyphs', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url))),
  );
  const font = await embedFont(await PDFDocument.create());
  expect(() => assertSupportedText(font, '≠')).not.toThrow();
  expect(font.encodeText('≠').toString()).toBe(font.encodeText('=\u0338').toString());
  expect(() => assertSupportedText(font, '你好')).toThrow('does not support');
});

it('checks canonical accents before replacing a standard font', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url))),
  );
  const result = await prepareText(
    await PDFDocument.create(),
    { map: new Map(), fontName: 'Helvetica' },
    'A\u0308',
  );
  expect(result.font.name).toBe('Helvetica');
  expect(result.encoded).toEqual(['<C4>']);
});

it('names the characters a font cannot draw, so the message says what to change', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  expect(() => assertSupportedText(font, 'Thanks 🎉 and 🎉 again ✓')).toThrow(
    'This font does not support “🎉” or “✓” in this text.',
  );
  // Characters that show nothing are named by their code.
  expect(() => assertSupportedText(font, `a${String.fromCharCode(7)}b`)).toThrow(
    'This font does not support U+0007 in this text.',
  );
});
