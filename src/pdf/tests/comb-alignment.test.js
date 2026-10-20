import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFNumber, TextAlignment } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { fillFields } from '../src/core/document.js';

afterEach(() => vi.restoreAllMocks());
const fontDir = new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).pathname;

/** Which of a comb field's cells hold ink once PDF.js draws the saved appearance. */
async function inkedCells(bytes, { x, y, width, height }, cells) {
  const task = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: fontDir });
  try {
    const page = await (await task.promise).getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport }).promise;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const cell = width / cells;
    return Array.from({ length: cells }, (_, i) => {
      let ink = 0;
      // Inside each cell, clear of the border.
      for (let px = Math.ceil((x + i * cell + 2) * 2); px < (x + (i + 1) * cell - 2) * 2; px++)
        for (let py = Math.ceil((792 - y - height + 3) * 2); py < (792 - y - 3) * 2; py++) {
          const at = (py * canvas.width + px) * 4;
          if (data[at] + data[at + 1] + data[at + 2] < 384) ink++;
        }
      return ink > 0;
    });
  } finally {
    await task.destroy();
  }
}

for (const [alignment, expected] of [
  [TextAlignment.Left, [true, true, false, false, false]],
  [TextAlignment.Center, [false, true, true, false, false]],
  [TextAlignment.Right, [false, false, false, true, true]],
])
  it(`fills a comb field's boxes the way it is aligned (Q=${alignment})`, async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
      ),
    );
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const box = { x: 100, y: 600, width: 200, height: 30 };
    const field = doc.getForm().createTextField('Amount');
    field.setMaxLength(5);
    field.enableCombing();
    field.addToPage(page, { ...box, borderWidth: 0 });
    field.acroField.dict.set(PDFName.of('Q'), PDFNumber.of(alignment));
    const loaded = await PDFDocument.load(await doc.save());
    await fillFields(loaded, { Amount: '42' });
    expect(await inkedCells(await loaded.save(), box, 5)).toEqual(expected);
  });
