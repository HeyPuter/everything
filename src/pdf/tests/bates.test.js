import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { addHeaderFooter, batesLabel, fillTokens } from '../src/core/page-marks.js';

beforeEach(async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url))),
  );
});
afterEach(() => vi.restoreAllMocks());

async function pageTexts(bytes) {
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const pdf = await task.promise;
  const texts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    texts.push(content.items.map((item) => item.str).join(' '));
  }
  await task.destroy();
  return texts;
}

it('pads Bates numbers and keeps the prefix and suffix', () => {
  expect(batesLabel({ prefix: 'ABC', start: 1, digits: 6 })).toBe('ABC000001');
  expect(batesLabel({ prefix: 'X-', suffix: '-CONF', start: 98, digits: 3 }, 3)).toBe('X-101-CONF');
  expect(fillTokens('{bates} p{page}', { page: 2, pages: 3, bates: 'B07' })).toBe('B07 p2');
});

it('rejects Bates settings outside the supported range', () => {
  expect(() => batesLabel({ start: -1 })).toThrow(/Start Bates numbers/);
  expect(() => batesLabel({ digits: 0 })).toThrow(/digits/);
  expect(() => batesLabel({ digits: 16 })).toThrow(/digits/);
});

it('numbers only the chosen pages, counting from the start number in page order', async () => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i++) doc.addPage([400, 400]);
  await addHeaderFooter(doc, [3, 1], {
    slots: { bottomRight: '{bates}' },
    bates: { prefix: 'DOC', start: 41, digits: 5, suffix: '' },
  });
  const texts = await pageTexts(await doc.save());
  expect(texts[0]).toBe('');
  expect(texts[1]).toContain('DOC00041');
  expect(texts[2]).toBe('');
  expect(texts[3]).toContain('DOC00042');
});

it('writes a Bates prefix in Korean with the Korean face', async () => {
  vi.mocked(globalThis.fetch).mockImplementation(
    async (url) =>
      new Response(
        await readFile(new URL(`../public/fonts/${String(url).split('/').pop()}`, import.meta.url)),
      ),
  );
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await addHeaderFooter(doc, [0], {
    slots: { bottomRight: '{bates}' },
    bates: { prefix: '사건-', start: 7, digits: 4 },
  });
  expect((await pageTexts(await doc.save()))[0]).toContain('사건-0007');
});
