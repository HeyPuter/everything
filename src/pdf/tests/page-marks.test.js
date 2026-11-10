import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, decodePDFRawStream, degrees, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import {
  addHeaderFooter,
  addPageNumbers,
  addWatermark,
  fillTokens,
  uprightFrame,
  HEADER_SLOTS,
  NUMBER_FORMATS,
  NUMBER_POSITIONS,
} from '../src/core/page-marks.js';

afterEach(() => vi.restoreAllMocks());
async function stubFont() {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url))),
  );
}
/** Render page `number` the way a viewer shows it (rotation applied) and read its text. */
async function view(bytes, number = 1, scale = 0.5) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  try {
    const page = await (await task.promise).getPage(number);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport }).promise;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: data,
      text: (await page.getTextContent()).items.map((item) => item.str).join(''),
    };
  } finally {
    await task.destroy();
  }
}
/** Bounding box of the pixels that differ between two renders of the same size. */
function changedBox(before, after) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -1,
    maxY = -1,
    count = 0;
  for (let y = 0; y < after.height; y++)
    for (let x = 0; x < after.width; x++) {
      const i = (y * after.width + x) * 4;
      if (
        before.pixels[i] !== after.pixels[i] ||
        before.pixels[i + 1] !== after.pixels[i + 1] ||
        before.pixels[i + 2] !== after.pixels[i + 2]
      ) {
        count++;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  return { minX, minY, maxX, maxY, count, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}
/**
 * A saved document, then reloaded the way the editor loads one before each edit: pdf-lib does
 * not pick up drawing on a page whose content stream was already serialized.
 */
async function document(rotations = [0], size = [400, 600]) {
  const doc = await PDFDocument.create();
  for (const rotation of rotations) {
    const page = doc.addPage(size);
    page.setRotation(degrees(rotation));
    // A colored corner mark shows that the page content underneath is untouched.
    page.drawRectangle({ x: 10, y: 10, width: 40, height: 40, color: rgb(0, 0.5, 1) });
  }
  const plain = await doc.save();
  return { plain, doc: await PDFDocument.load(plain) };
}
const reload = async (doc) => PDFDocument.load(await doc.save());
function pageContent(doc, index) {
  const page = doc.getPage(index);
  const contents = page.node.Contents();
  const streams = contents.constructor.name === 'PDFArray' ? contents.asArray() : [contents];
  return streams
    .map((ref) =>
      new TextDecoder('latin1').decode(decodePDFRawStream(doc.context.lookup(ref)).decode()),
    )
    .join('\n');
}

describe('upright frame', () => {
  it('maps reader coordinates onto the crop box for every quarter turn', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([500, 800]);
    page.setCropBox(50, 100, 300, 400);
    const cases = [
      [0, { x: 50, y: 100 }, { x: 350, y: 500 }, 300, 400],
      [90, { x: 350, y: 100 }, { x: 50, y: 500 }, 400, 300],
      [180, { x: 350, y: 500 }, { x: 50, y: 100 }, 300, 400],
      [270, { x: 50, y: 500 }, { x: 350, y: 100 }, 400, 300],
    ];
    for (const [rotation, origin, farCorner, width, height] of cases) {
      page.setRotation(degrees(rotation));
      const frame = uprightFrame(page);
      expect([frame.width, frame.height, frame.rotation]).toEqual([width, height, rotation]);
      expect(frame.toPdf(0, 0)).toEqual(origin);
      expect(frame.toPdf(width, height)).toEqual(farCorner);
    }
    page.setRotation(degrees(-90));
    expect(uprightFrame(page).rotation).toBe(270);
  });
  it('reads a crop box with swapped corners, or one past the sheet, the way viewers do', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    // Upper-right corner first: the same box, which PDF.js normalizes.
    page.node.set(PDFName.of('CropBox'), doc.context.obj([612, 792, 0, 0]));
    let frame = uprightFrame(page);
    expect([frame.width, frame.height]).toEqual([612, 792]);
    expect(frame.toPdf(0, 0)).toEqual({ x: 0, y: 0 });
    expect(frame.toPdf(612, 792)).toEqual({ x: 612, y: 792 });
    // A crop box beyond the sheet shows no more than the sheet.
    page.node.set(PDFName.of('CropBox'), doc.context.obj([-100, -100, 712, 892]));
    frame = uprightFrame(page);
    expect([frame.width, frame.height]).toEqual([612, 792]);
    expect(frame.toPdf(306, 28)).toEqual({ x: 306, y: 28 });
    // A crop box that misses the sheet entirely falls back to the sheet.
    page.node.set(PDFName.of('CropBox'), doc.context.obj([1000, 1000, 1100, 1100]));
    frame = uprightFrame(page);
    expect([frame.width, frame.height]).toEqual([612, 792]);
    // A partial overlap keeps only the shared part.
    page.node.set(PDFName.of('CropBox'), doc.context.obj([500, 700, 900, 900]));
    frame = uprightFrame(page);
    expect([frame.width, frame.height]).toEqual([112, 92]);
    expect(frame.toPdf(0, 0)).toEqual({ x: 500, y: 700 });
  });
});

describe('page numbers', () => {
  it('numbers every page at the bottom center, upright on rotated pages, as a footer artifact', async () => {
    await stubFont();
    const { plain, doc } = await document([0, 90, 180, 270]);
    const before = await Promise.all([1, 2, 3, 4].map((n) => view(plain, n)));
    await addPageNumbers(doc, [0, 1, 2, 3]);
    const bytes = await doc.save();
    for (let n = 1; n <= 4; n++) {
      const after = await view(bytes, n);
      expect(after.text.replace(/\s+/g, ' ').trim()).toBe(`Page ${n} of 4`);
      const box = changedBox(before[n - 1], after);
      expect(box.count).toBeGreaterThan(20);
      // Centered horizontally, sitting in the bottom margin of the displayed page.
      expect(Math.abs(box.cx - after.width / 2)).toBeLessThan(3);
      expect(box.maxY).toBeGreaterThan(after.height - 20);
      expect(box.minY).toBeGreaterThan(after.height - 20);
      expect(box.maxX - box.minX).toBeLessThan(after.width / 3);
    }
    const reopened = await reload(doc);
    expect(pageContent(reopened, 0)).toMatch(
      /\/Artifact\s*<<[^>]*\/Subtype\s*\/Footer[^>]*>>\s*BDC[\s\S]*EMC/,
    );
  });
  it('places numbers in each corner and at the top', async () => {
    await stubFont();
    for (const position of NUMBER_POSITIONS) {
      const { plain, doc } = await document([90]);
      const before = await view(plain);
      await addPageNumbers(doc, [0], { position, size: 14 });
      const after = await view(await doc.save());
      const box = changedBox(before, after);
      const [vertical, horizontal] = position.split('-');
      if (vertical === 'top') expect(box.maxY).toBeLessThan(25);
      else expect(box.minY).toBeGreaterThan(after.height - 25);
      if (horizontal === 'left') expect(box.minX).toBeLessThan(20);
      else if (horizontal === 'right') expect(box.maxX).toBeGreaterThan(after.width - 20);
      else expect(Math.abs(box.cx - after.width / 2)).toBeLessThan(3);
      if (vertical === 'top') expect(pageContent(await reload(doc), 0)).toContain('/Header');
    }
  });
  it('supports every format, a start number, and a page subset whose total is the last number', async () => {
    await stubFont();
    const { doc } = await document([0, 0, 0, 0]);
    await addPageNumbers(doc, [3, 1, 2], { format: 'slash', start: 5 });
    const bytes = await doc.save();
    expect((await view(bytes, 1)).text.trim()).toBe('');
    expect((await view(bytes, 2)).text.trim()).toBe('5 / 7');
    expect((await view(bytes, 4)).text.trim()).toBe('7 / 7');
    for (const [format, template] of Object.entries(NUMBER_FORMATS)) {
      const { doc: single } = await document([0]);
      await addPageNumbers(single, [0], { format, start: 3 });
      expect((await view(await single.save())).text.trim()).toBe(
        template.replace('{n}', '3').replace('{N}', '3'),
      );
    }
  });
  it('rejects bad options before touching the document', async () => {
    await stubFont();
    const { doc } = await document([0]);
    const untouched = await doc.save();
    await expect(addPageNumbers(doc, [], {})).rejects.toThrow('at least one page');
    await expect(addPageNumbers(doc, [0], { format: 'roman' })).rejects.toThrow('format');
    await expect(addPageNumbers(doc, [0], { position: 'middle' })).rejects.toThrow('where');
    await expect(addPageNumbers(doc, [0], { start: -1 })).rejects.toThrow('between 0 and 99,999');
    await expect(addPageNumbers(doc, [0], { start: 1.5 })).rejects.toThrow('between 0 and 99,999');
    await expect(addPageNumbers(doc, [0], { size: 100 })).rejects.toThrow('between 6 and 72');
    expect(await doc.save()).toEqual(untouched);
  });
});

describe('watermarks', () => {
  it('centers a translucent diagonal mark on each page and leaves the page content untouched', async () => {
    await stubFont();
    const { plain, doc } = await document([0, 90], [400, 600]);
    await addWatermark(doc, [0, 1], { text: 'CONFIDENTIAL' });
    const bytes = await doc.save();
    for (const n of [1, 2]) {
      const before = await view(plain, n),
        after = await view(bytes, n);
      expect(after.text.trim()).toBe('CONFIDENTIAL');
      const box = changedBox(before, after);
      expect(Math.abs(box.cx - after.width / 2)).toBeLessThan(4);
      expect(Math.abs(box.cy - after.height / 2)).toBeLessThan(4);
      // A diagonal mark's footprint is about as tall as it is wide and stays inside the page.
      const w = box.maxX - box.minX,
        h = box.maxY - box.minY;
      expect(Math.abs(w - h)).toBeLessThan(Math.max(w, h) * 0.2);
      expect(box.minX).toBeGreaterThan(0);
      expect(box.maxX).toBeLessThan(after.width - 1);
      // 25% black over white renders as light gray, never darker.
      let darkest = 255;
      for (let i = 0; i < after.pixels.length; i += 4)
        if (after.pixels[i + 2] === after.pixels[i]) darkest = Math.min(darkest, after.pixels[i]);
      expect(darkest).toBeGreaterThan(170);
      expect(darkest).toBeLessThan(205);
      // The blue corner mark is still there.
      const corner = (n === 1 ? after.height - 10 : 10) * after.width * 4 + 15 * 4;
      expect(after.pixels[corner + 2]).toBe(255);
    }
    expect(pageContent(await reload(doc), 0)).toMatch(/\/Subtype\s*\/Watermark[^>]*>>\s*BDC/);
  });
  it('lays a horizontal mark flat, scales with the chosen size, and fits long text inside the page', async () => {
    await stubFont();
    const { plain, doc } = await document([0, 0, 0], [300, 500]);
    await addWatermark(doc, [0], {
      text: 'DRAFT',
      layout: 'horizontal',
      size: 'small',
      hex: '#ff0000',
      opacity: 1,
    });
    await addWatermark(doc, [1], {
      text: 'DRAFT',
      layout: 'horizontal',
      size: 'large',
      opacity: 1,
    });
    await addWatermark(doc, [2], { text: 'A very long watermark that would overflow', opacity: 1 });
    const bytes = await doc.save();
    const before = await view(plain, 1);
    const small = changedBox(before, await view(bytes, 1));
    const large = changedBox(before, await view(bytes, 2));
    expect(small.maxY - small.minY).toBeLessThan((small.maxX - small.minX) / 3);
    expect(large.maxX - large.minX).toBeGreaterThan((small.maxX - small.minX) * 1.5);
    expect(Math.abs(small.cx - before.width / 2)).toBeLessThan(3);
    expect(Math.abs(small.cy - before.height / 2)).toBeLessThan(3);
    const first = await view(bytes, 1);
    let red = 0;
    for (let i = 0; i < first.pixels.length; i += 4)
      if (first.pixels[i] > 200 && first.pixels[i + 1] < 60) red++;
    expect(red).toBeGreaterThan(100);
    const long = changedBox(before, await view(bytes, 3));
    expect(long.minX).toBeGreaterThanOrEqual(0);
    expect(long.maxX).toBeLessThan(before.width);
    expect(long.minY).toBeGreaterThanOrEqual(0);
    expect(long.maxY).toBeLessThan(before.height);
    expect((await view(bytes, 3)).text.trim()).toBe('A very long watermark that would overflow');
  });
  it('rejects empty, unsupported, or oversized settings', async () => {
    await stubFont();
    const { doc } = await document([0]);
    await expect(addWatermark(doc, [0], { text: '   ' })).rejects.toThrow(
      'Enter the watermark text',
    );
    await expect(addWatermark(doc, [0], { text: 'สวัสดี' })).rejects.toThrow('does not support');
    await expect(addWatermark(doc, [0], { text: 'x', size: 'huge' })).rejects.toThrow('size');
    await expect(addWatermark(doc, [0], { text: 'x', layout: 'tiled' })).rejects.toThrow('layout');
    await expect(addWatermark(doc, [0], { text: 'x', opacity: 0 })).rejects.toThrow('opacity');
    await expect(addWatermark(doc, [], { text: 'x' })).rejects.toThrow('at least one page');
  });
});

describe('headers and footers', () => {
  it('fills tokens per page and places each slot at its edge, upright on rotated pages', async () => {
    await stubFont();
    const { plain, doc } = await document([0, 90]);
    const date = new Date(2026, 8, 14);
    await addHeaderFooter(doc, [0, 1], {
      slots: {
        topLeft: '{title}',
        topRight: '{date}',
        bottomCenter: 'Page {page} of {pages} · {file}',
      },
      size: 12,
      title: 'Quarterly report',
      file: 'q3',
      date,
    });
    const bytes = await doc.save();
    for (const n of [1, 2]) {
      const before = await view(plain, n),
        after = await view(bytes, n);
      const text = after.text.replace(/\s+/g, ' ').trim();
      expect(text).toContain('Quarterly report');
      expect(text).toContain(date.toLocaleDateString(undefined, { dateStyle: 'medium' }));
      expect(text).toContain(`Page ${n} of 2 · q3`);
      const box = changedBox(before, after);
      // Marks along the very top and very bottom edges of the displayed page.
      expect(box.minY).toBeLessThan(20);
      expect(box.maxY).toBeGreaterThan(after.height - 20);
    }
    expect(pageContent(await reload(doc), 0)).toMatch(/\/Subtype\s*\/Header/);
    expect(pageContent(await reload(doc), 0)).toMatch(/\/Subtype\s*\/Footer/);
  });
  it('writes the date in digits when the font cannot write the locale month names', async () => {
    await stubFont();
    const doc = await PDFDocument.create();
    doc.addPage([400, 300]);
    const date = new Date(2026, 8, 14, 12);
    const locale = vi
      .spyOn(Date.prototype, 'toLocaleDateString')
      .mockImplementation(() => '2026年9月14日');
    try {
      await addHeaderFooter(doc, [0], { slots: { topRight: 'Printed {date}' }, date });
      // Text of the person's own that the font lacks is still refused.
      await expect(
        addHeaderFooter(doc, [0], { slots: { topLeft: 'วันที่ {date}' }, date }),
      ).rejects.toThrow('does not support');
    } finally {
      locale.mockRestore();
    }
    const seen = await view(await doc.save());
    expect(seen.text).toContain('Printed 2026-09-14');
    expect(seen.text).not.toContain('年');
  });
  it('replaces tokens in any case and leaves unknown braces alone', () => {
    const out = fillTokens('{Page}/{PAGES} {unknown} {title}{file}', {
      page: 3,
      pages: 9,
      date: new Date('invalid'),
      title: 'T',
      file: 'F',
    });
    expect(out).toBe('3/9 {unknown} TF');
    expect(fillTokens('{date}', { page: 1, pages: 1, date: null })).toBe('');
    expect(HEADER_SLOTS).toHaveLength(6);
  });
  it('rejects empty, oversized, and unsupported settings', async () => {
    await stubFont();
    const { doc } = await document([0]);
    await expect(addHeaderFooter(doc, [0], { slots: {} })).rejects.toThrow('at least one');
    await expect(addHeaderFooter(doc, [0], { slots: { topLeft: '   ' } })).rejects.toThrow(
      'at least one',
    );
    await expect(
      addHeaderFooter(doc, [0], { slots: { topLeft: 'x'.repeat(201) } }),
    ).rejects.toThrow('200');
    await expect(addHeaderFooter(doc, [0], { slots: { topLeft: 'x' }, size: 40 })).rejects.toThrow(
      'between 6 and 36',
    );
    await expect(addHeaderFooter(doc, [0], { slots: { topLeft: 'สวัสดี' } })).rejects.toThrow(
      'does not support',
    );
  });
});

for (const kind of ['numbers', 'headers'])
  it.each([0.5, 2])(
    `keeps ${kind} font sizes and margins in physical points at UserUnit %s`,
    async (unit) => {
      await stubFont();
      for (const rotation of [0, 90, 180, 270]) {
        const bounds = [];
        for (const scale of [1, unit]) {
          let doc = await PDFDocument.create();
          const page = doc.addPage([400 / scale, 600 / scale]);
          page.setRotation(degrees(rotation));
          page.node.set(PDFName.of('UserUnit'), doc.context.obj(scale));
          const plain = await doc.save();
          doc = await PDFDocument.load(plain);
          if (kind === 'numbers')
            await addPageNumbers(doc, [0], {
              format: 'plain',
              position: 'top-right',
              size: 14,
              margin: 28,
            });
          else
            await addHeaderFooter(doc, [0], {
              slots: { topRight: 'Header' },
              size: 14,
              margin: 28,
            });
          doc = await reload(doc);
          const sizes = [...pageContent(doc, 0).matchAll(/([\d.]+) Tf\b/g)].map((match) =>
            Number(match[1]),
          );
          expect.soft(sizes.map((size) => size * scale)).toEqual([14]);
          bounds.push(changedBox(await view(plain), await view(await doc.save())));
        }
        for (const key of ['minX', 'minY', 'maxX', 'maxY'])
          expect(Math.abs(bounds[0][key] - bounds[1][key])).toBeLessThanOrEqual(1);
      }
    },
  );
