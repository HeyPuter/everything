import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { runBatch } from '../src/core/batch.js';

beforeEach(async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url))),
  );
});
afterEach(() => vi.restoreAllMocks());

async function pdfOf(pages, title = '') {
  const doc = await PDFDocument.create();
  if (title) doc.setTitle(title);
  for (let i = 0; i < pages; i++) doc.addPage([400, 400]);
  return { name: `${pages} pages.pdf`, bytes: await doc.save() };
}
async function texts(bytes) {
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const pdf = await task.promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++)
    out.push((await (await pdf.getPage(i)).getTextContent()).items.map((t) => t.str).join(' '));
  await task.destroy();
  return out;
}

it('continues Bates numbers from one file to the next and rotates every page', async () => {
  const results = await runBatch(
    [await pdfOf(2), await pdfOf(3)],
    [
      { type: 'rotate', degrees: 90 },
      { type: 'bates', prefix: 'ABC', start: 5, digits: 4, position: 'bottom-right' },
    ],
  );
  expect(results.every((r) => r.bytes)).toBe(true);
  expect((await texts(results[0].bytes)).map((t) => t.trim())).toEqual(['ABC0005', 'ABC0006']);
  expect((await texts(results[1].bytes)).map((t) => t.trim())).toEqual([
    'ABC0007',
    'ABC0008',
    'ABC0009',
  ]);
  const doc = await PDFDocument.load(results[1].bytes);
  expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([90, 90, 90]);
});

it('removes metadata, adds a watermark, and protects the output', async () => {
  const [result] = await runBatch(
    [await pdfOf(1, 'Secret title')],
    [
      { type: 'sanitize' },
      { type: 'watermark', text: 'DRAFT' },
      { type: 'protect', open: 'pw-1234' },
    ],
  );
  await expect(PDFDocument.load(result.bytes)).rejects.toThrow(/encrypted/i);
  const task = pdfjs.getDocument({ data: result.bytes.slice(), password: 'pw-1234' });
  const pdf = await task.promise;
  const text = (await (await pdf.getPage(1)).getTextContent()).items.map((t) => t.str).join('');
  expect(text).toContain('DRAFT');
  expect((await pdf.getMetadata()).info.Title).toBeUndefined();
  await task.destroy();
});

it('reports a file that cannot be processed and carries on with the rest', async () => {
  const results = await runBatch(
    [{ name: 'broken.pdf', bytes: new TextEncoder().encode('not a pdf') }, await pdfOf(1)],
    [{ type: 'pageNumbers', format: 'of', position: 'bottom-center' }],
  );
  expect(results[0].error).toBeTruthy();
  expect((await texts(results[1].bytes))[0]).toContain('1 of 1');
});

it('gives the Bates numbers of a file that fails to the next file', async () => {
  // A file that fails after it was numbered is not produced, so its numbers stay free.
  let calls = 0;
  const results = await runBatch(
    [await pdfOf(2), await pdfOf(3)],
    [
      { type: 'bates', prefix: 'ABC', start: 5, digits: 4, position: 'bottom-right' },
      { type: 'ocr' },
    ],
    {
      recognize: async () => {
        if (++calls === 1) throw new Error('Text recognition failed.');
        return null;
      },
    },
  );
  expect(results[0].error).toBe('Text recognition failed.');
  expect((await texts(results[1].bytes)).map((t) => t.trim())).toEqual([
    'ABC0005',
    'ABC0006',
    'ABC0007',
  ]);
});
