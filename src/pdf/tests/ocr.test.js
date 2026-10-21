import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import {
  OCR_TAG,
  addOcrTextLayer,
  hasOcrTextLayer,
  pageNeedsOcr,
  removeOcrTextLayer,
} from '../src/core/ocr.js';
import { pageSource, setPageSource } from '../src/core/text-edit.js';
import { createOcrEngine } from '../src/ocr-engine.js';
import { autotagDocument } from '../src/core/autotag.js';

const fontFile = new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url);
const langPath = fileURLToPath(
  new URL('../node_modules/@tesseract.js-data/eng/4.0.0_best_int', import.meta.url),
);
let fontBytes;
beforeEach(async () => {
  fontBytes ??= await readFile(fontFile);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(fontBytes.slice()));
});
afterEach(() => vi.restoreAllMocks());

const engine = createOcrEngine({ langPath });
afterAll(() => engine.terminate());

async function open(bytes) {
  return pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
}
async function textItems(bytes, pageNumber = 1, options) {
  const pdf = await open(bytes);
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent(options);
  return { page, content, items: content.items.filter((item) => item.str?.trim()) };
}

/** A page of real text in Noto Sans, and the boxes PDF.js reports for its words. */
const LINES = [
  { text: 'Searchable scans keep their pictures', size: 22, y: 640 },
  { text: 'while invisible words follow every line.', size: 16, y: 580 },
  { text: 'Quarterly totals rose 12 percent in 2026', size: 12, y: 530 },
];
async function sourcePdf() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  const page = doc.addPage([612, 792]);
  for (const line of LINES) page.drawText(line.text, { x: 72, y: line.y, size: line.size, font });
  return doc.save();
}
async function render(bytes, scale) {
  const pdf = await open(bytes);
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}
/** A "scanned" PDF: one page holding only the picture of the source page. */
async function scannedPdf(png, [width, height]) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  page.drawImage(await doc.embedPng(png), { x: 0, y: 0, width, height });
  return doc;
}

/**
 * Where an item's text starts and ends on a render at `scale`, in image pixels, measured along
 * its baseline: the check that a highlight drawn by PDF.js covers the word on the image.
 */
function itemOnImage(page, item, scale) {
  const viewport = page.getViewport({ scale });
  const [a, b, , , e, f] = item.transform;
  const length = Math.hypot(a, b);
  const end = [e + (a / length) * item.width, f + (b / length) * item.width];
  const [m0, m1, m2, m3, m4, m5] = viewport.transform;
  const apply = ([x, y]) => [m0 * x + m2 * y + m4, m1 * x + m3 * y + m5];
  const [x0, y0] = apply([e, f]);
  const [x1, y1] = apply(end);
  return { x0, y0, x1, y1 };
}

describe('OCR end to end', () => {
  it('recognizes a rendered page and lines the text layer up with the image', async () => {
    const scale = 3;
    const source = await sourcePdf();
    const canvas = await render(source, scale);
    const imageData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const progress = [];
    const result = await engine.recognize(imageData, { onProgress: (p) => progress.push(p) });
    expect(result.width).toBe(canvas.width);
    expect(result.height).toBe(canvas.height);
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(result.lines.map((line) => line.text)).toEqual(LINES.map((line) => line.text));

    const doc = await scannedPdf(canvas.toBuffer('image/png'), [612, 792]);
    const before = await textItems(await doc.save());
    expect(pageNeedsOcr(before.content, 612 * 792)).toBe(true);
    expect(await addOcrTextLayer(doc, 0, result)).toEqual({
      words: result.words.length,
      lines: LINES.length,
    });
    const saved = await doc.save();
    const { page, content, items } = await textItems(saved);
    // Each word is its own item, in reading order, with spaces and line ends between them.
    expect(items.map((item) => item.str)).toEqual(result.words.map((word) => word.text));
    const text = content.items.map((item) => item.str + (item.hasEOL ? '\n' : '')).join('');
    expect(text.replace(/ +/g, ' ').trim()).toBe(LINES.map((line) => line.text).join('\n'));
    for (const [i, item] of items.entries()) {
      const box = result.words[i].bbox;
      const placed = itemOnImage(page, item, scale);
      // Within a pixel of the recognized box at 216 dpi.
      expect(Math.abs(placed.x0 - box.x0)).toBeLessThan(1);
      expect(Math.abs(placed.x1 - box.x1)).toBeLessThan(1);
      expect(placed.y0).toBeGreaterThan(box.y0);
      expect(placed.y0).toBeLessThanOrEqual(box.y1 + 1);
    }
    // And close to where the original PDF had the same words.
    const original = (await textItems(source)).items;
    for (const [n, line] of LINES.entries()) {
      const first = items.find((item) => item.str === line.text.split(' ')[0]);
      expect(Math.abs(first.transform[4] - original[n].transform[4])).toBeLessThan(2);
      expect(Math.abs(first.transform[5] - original[n].transform[5])).toBeLessThan(line.size * 0.1);
      expect(first.transform[3] / line.size).toBeGreaterThan(0.85);
      expect(first.transform[3] / line.size).toBeLessThan(1.15);
    }
    // Searchable, but drawn invisibly: the page renders exactly as the scan did.
    const reopened = await PDFDocument.load(saved);
    expect(hasOcrTextLayer(reopened, 0)).toBe(true);
    expect(pageSource(reopened.getPage(0))).toMatch(/\b3 Tr\b/);
    const marked = await textItems(saved, 1, { includeMarkedContent: true });
    expect(marked.content.items.some((item) => item.tag === OCR_TAG)).toBe(true);
    expect(pageNeedsOcr(marked.content, 612 * 792)).toBe(true);
    expect(pageNeedsOcr(content, 612 * 792)).toBe(false);
  }, 120000);

  it('can be canceled, and recognizes again afterwards', async () => {
    const canvas = createCanvas(600, 120);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 600, 120);
    context.fillStyle = '#000';
    context.font = '40px sans-serif';
    context.fillText('Cancel and retry', 20, 75);
    const controller = new AbortController();
    const job = engine.recognize(canvas, { signal: controller.signal });
    controller.abort();
    await expect(job).rejects.toMatchObject({ name: 'AbortError' });
    const again = await engine.recognize(canvas.toBuffer('image/png'));
    expect(again.text.trim()).toBe('Cancel and retry');
    expect([again.width, again.height]).toEqual([600, 120]);
  }, 120000);
});

/** A synthetic result: words in image pixels on a `width` x `height` render. */
const synthetic = (width, height, lines) => ({
  width,
  height,
  words: lines.flat(),
  lines: lines.map((words) => ({ words })),
});
const word = (text, x0, y0, x1, y1) => ({ text, bbox: { x0, y0, x1, y1 } });

describe('coordinate mapping', () => {
  for (const rotation of [0, 90, 180, 270])
    for (const [label, setup] of [
      ['plain', () => {}],
      [
        'cropped',
        (page) => {
          page.setMediaBox(-40, -20, 400, 500);
          page.setCropBox(30, 60, 250, 300);
        },
      ],
      ['UserUnit 2', (page) => page.node.set(PDFName.of('UserUnit'), page.doc.context.obj(2))],
    ])
      it(`places words on a ${label} page rotated ${rotation}°`, async () => {
        const doc = await PDFDocument.create();
        const page = doc.addPage([300, 400]);
        setup(page);
        page.setRotation(degrees(rotation));
        const scale = 2;
        const pdfPage = await (await open(await doc.save())).getPage(1);
        const viewport = pdfPage.getViewport({ scale });
        const width = Math.round(viewport.width),
          height = Math.round(viewport.height);
        const result = synthetic(width, height, [
          [word('Rotated', 40, 30, 160, 58), word('pages', 175, 30, 260, 64)],
          [word('read', 40, 90, 110, 118), word('upright.', 120, 90, 230, 118)],
        ]);
        expect(await addOcrTextLayer(doc, 0, result)).toEqual({ words: 4, lines: 2 });
        const { page: reopened, items } = await textItems(await doc.save());
        expect(items.map((item) => item.str)).toEqual(['Rotated', 'pages', 'read', 'upright.']);
        for (const [i, item] of items.entries()) {
          const box = result.words[i].bbox;
          const placed = itemOnImage(reopened, item, scale);
          expect(Math.abs(placed.x0 - box.x0)).toBeLessThan(0.5);
          expect(Math.abs(placed.x1 - box.x1)).toBeLessThan(0.5);
          // Reads left to right on the image, on a level baseline inside the word's box.
          expect(Math.abs(placed.y1 - placed.y0)).toBeLessThan(0.01);
          expect(placed.y0).toBeGreaterThan(box.y0);
          expect(placed.y0).toBeLessThanOrEqual(box.y1 + 0.5);
        }
      });

  it('accepts the render scale instead of the image size', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 100]);
    page.node.set(PDFName.of('UserUnit'), doc.context.obj(1.5));
    const result = { words: [word('Scaled', 30, 60, 120, 90)] };
    await addOcrTextLayer(doc, 0, result, { renderScale: 2 });
    const { page: reopened, items } = await textItems(await doc.save());
    const placed = itemOnImage(reopened, items[0], 2);
    expect(Math.abs(placed.x0 - 30)).toBeLessThan(0.5);
    expect(Math.abs(placed.x1 - 120)).toBeLessThan(0.5);
    await expect(addOcrTextLayer(doc, 0, result)).rejects.toThrow(/image size/);
  });

  it('groups words into lines when the result has none', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 200]);
    const words = [
      word('First', 20, 20, 80, 40),
      word('line', 90, 22, 130, 40),
      word('Second', 20, 60, 100, 80),
    ];
    expect(await addOcrTextLayer(doc, 0, { words, width: 300, height: 200 })).toEqual({
      words: 3,
      lines: 2,
    });
    const { content } = await textItems(await doc.save());
    const text = content.items.map((item) => item.str + (item.hasEOL ? '\n' : '')).join('');
    expect(text.trim()).toBe('First line\nSecond');
  });
});

describe('replacing and removing the layer', () => {
  const result = synthetic(612, 792, [
    [word('Only', 100, 100, 160, 124), word('once', 170, 100, 230, 124)],
  ]);
  async function pageWithText() {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(fontBytes, { subset: true });
    doc.addPage([612, 792]).drawText('Visible', { x: 300, y: 300, size: 12, font });
    return doc;
  }
  const strings = async (doc) => (await textItems(await doc.save())).items.map((i) => i.str);

  it('replaces an earlier layer instead of stacking another', async () => {
    const doc = await pageWithText();
    await addOcrTextLayer(doc, 0, result);
    await addOcrTextLayer(doc, 0, result);
    expect(await strings(doc)).toEqual(['Visible', 'Only', 'once']);
    await addOcrTextLayer(doc, 0, result, { replaceExisting: false });
    expect(await strings(doc)).toEqual(['Visible', 'Only', 'once', 'Only', 'once']);
    // Reopened from bytes, the layer is still recognized and replaced.
    const reopened = await PDFDocument.load(await doc.save());
    await addOcrTextLayer(reopened, 0, result);
    expect(await strings(reopened)).toEqual(['Visible', 'Only', 'once']);
  });

  it('tags text recognized again with marked-content IDs the old tags do not hold', async () => {
    const doc = await pageWithText();
    await addOcrTextLayer(doc, 0, result);
    const tagged = await PDFDocument.load(await doc.save());
    autotagDocument(tagged);
    // Recognizing again replaces the tagged layer; its tags still name the old IDs.
    await addOcrTextLayer(tagged, 0, synthetic(612, 792, [[word('Again', 100, 100, 160, 124)]]));
    const retagged = await PDFDocument.load(await tagged.save());
    autotagDocument(retagged);
    const pdf = await open(await retagged.save());
    const tree = JSON.stringify(await (await pdf.getPage(1)).getStructTree());
    const claims = [...tree.matchAll(/"id":"(p\d+R_mc\d+)"/g)].map((m) => m[1]);
    expect(claims.length).toBeGreaterThan(0);
    expect(new Set(claims).size).toBe(claims.length);
  });

  it('removes the layer and leaves the page as it was', async () => {
    const doc = await PDFDocument.load(await (await pageWithText()).save());
    const contents = doc.getPage(0).node.Contents();
    const original = pageSource(doc.getPage(0));
    expect(removeOcrTextLayer(doc, 0)).toBe(false);
    await addOcrTextLayer(doc, 0, result);
    const reopened = await PDFDocument.load(await doc.save());
    expect(removeOcrTextLayer(reopened, 0)).toBe(true);
    expect(hasOcrTextLayer(reopened, 0)).toBe(false);
    expect(await strings(reopened)).toEqual(['Visible']);
    const page = reopened.getPage(0);
    expect(pageSource(page).trim()).toBe(original.trim());
    expect(page.node.Contents().size()).toBe(1);
    expect(contents).toBeDefined();
    const fonts = page.node.Resources().lookup(PDFName.of('Font'));
    expect(fonts.keys().some((key) => key.asString().startsWith(`/${OCR_TAG}`))).toBe(false);
  });

  it('removes a layer that a text edit merged into the page content', async () => {
    const doc = await pageWithText();
    await addOcrTextLayer(doc, 0, result);
    const page = doc.getPage(0);
    // Text editing rewrites the whole page into one stream, losing our stream markers.
    setPageSource(doc, page, pageSource(page));
    expect(page.node.Contents().size()).toBe(1);
    expect(hasOcrTextLayer(doc, 0)).toBe(true);
    expect(removeOcrTextLayer(doc, 0)).toBe(true);
    expect(await strings(doc)).toEqual(['Visible']);
    expect(pageSource(page)).not.toContain(OCR_TAG);
  });
});

describe('pageNeedsOcr', () => {
  const area = 612 * 792;
  const item = (str, width = 100, height = 12) => ({ str, width, height, transform: [] });
  it('skips pages with real text and keeps scans, stamps and our own layer', () => {
    expect(pageNeedsOcr({ items: [] }, area)).toBe(true);
    expect(pageNeedsOcr({ items: [item('A full sentence of real page text.')] }, area)).toBe(false);
    expect(pageNeedsOcr({ items: [item('Page 3')] }, area)).toBe(true);
    // A short but large title still counts as real text.
    expect(pageNeedsOcr({ items: [item('ANNUAL', 400, 60)] }, area)).toBe(false);
    const wrapped = (tag, str) => ({
      items: [
        { type: 'beginMarkedContentProps', tag },
        item(str, 500, 80),
        { type: 'endMarkedContent' },
      ],
    });
    expect(pageNeedsOcr(wrapped('Artifact', 'CONFIDENTIAL DRAFT WATERMARK'), area)).toBe(true);
    expect(pageNeedsOcr(wrapped(OCR_TAG, 'Earlier OCR text of this scanned page'), area)).toBe(
      true,
    );
    expect(pageNeedsOcr(wrapped('P', 'Tagged paragraph of ordinary page text'), area)).toBe(false);
    expect(
      pageNeedsOcr({ items: [item('A full sentence of real page text.')] }, area, { force: true }),
    ).toBe(true);
  });
});
