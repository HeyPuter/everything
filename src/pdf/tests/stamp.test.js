import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { MAX_STAMP_TEXT, STAMP_PRESETS, drawStamp, stampOutline } from '../src/core/stamp.js';
import { inspectPaths } from '../src/core/path-edit.js';

let fontBytes;
beforeAll(async () => {
  fontBytes = await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(fontBytes));
});
async function raster(bytes) {
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    const page = await (await task.promise).getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport }).promise;
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
    };
  } finally {
    await task.destroy();
  }
}
/** Bounding box of pixels that are not white. */
function inkBox({ width, height, pixels }) {
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (pixels[i] < 250 || pixels[i + 1] < 250 || pixels[i + 2] < 250) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  return { minX, minY, maxX, maxY };
}

describe('stamps', () => {
  it('builds one outline with a ring around the lettering', () => {
    const { commands, box, stroke } = stampOutline(fontkit, fontBytes, 'APPROVED');
    expect(stroke).toBeGreaterThan(0);
    // Two frame contours (outer and inner) plus at least one contour per letter.
    expect(commands.filter(([op]) => op === 'm').length).toBeGreaterThanOrEqual(10);
    expect(box.width).toBeGreaterThan(box.height * 3);
    const tight = stampOutline(fontkit, fontBytes, 'OK');
    expect(tight.box.width).toBeLessThan(box.width);
    expect(() => stampOutline(fontkit, fontBytes, '  ')).toThrow('Enter the stamp text');
    expect(() => stampOutline(fontkit, fontBytes, 'x'.repeat(MAX_STAMP_TEXT + 1))).toThrow(
      `${MAX_STAMP_TEXT} characters`,
    );
    expect(() => stampOutline(fontkit, fontBytes, '漢')).toThrow('stamp font has no');
    expect(STAMP_PRESETS.map((p) => p.text)).toContain('APPROVED');
    for (const preset of STAMP_PRESETS) expect(preset.hex).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('places a stamp as one filled and stroked path inside its box, in the chosen color', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 300]);
    const target = { x: 100, y: 100, width: 200, height: 80 };
    await drawStamp(doc, 0, { text: 'DRAFT', hex: '#d92626' }, target, { fontkit });
    const bytes = await doc.save();
    const paths = inspectPaths(await PDFDocument.load(bytes), 0);
    expect(paths).toHaveLength(1);
    // Marked as a stamp, so it is named one when selected rather than a shape.
    expect(paths[0]).toMatchObject({ kind: 'stamp', filled: true, stroked: true });
    const seen = await raster(bytes);
    const ink = inkBox(seen);
    // Inside the target box (PDF y up, canvas y down), centered, wide.
    expect(ink.minX).toBeGreaterThanOrEqual(99);
    expect(ink.maxX).toBeLessThanOrEqual(301);
    expect(ink.minY).toBeGreaterThanOrEqual(300 - 180 - 1);
    expect(ink.maxY).toBeLessThanOrEqual(300 - 100 + 1);
    // Fitted by the box's height and centered across it.
    expect(ink.maxY - ink.minY).toBeGreaterThan(74);
    expect(Math.abs((ink.minX + ink.maxX) / 2 - 200)).toBeLessThan(3);
    // The frame's left edge is red, and the middle of the frame ring is red too.
    const midY = Math.round((ink.minY + ink.maxY) / 2);
    const left = (midY * seen.width + ink.minX + 2) * 4;
    expect(seen.pixels[left]).toBeGreaterThan(180);
    expect(seen.pixels[left + 1]).toBeLessThan(90);
    // The frame is a ring: just inside it, before the lettering, the page is white.
    const inside = (midY * seen.width + ink.minX + 14) * 4;
    expect(seen.pixels[inside]).toBeGreaterThan(245);
    expect(seen.pixels[inside + 1]).toBeGreaterThan(245);
  });
  it('turns with a rotated page so the stamp reads upright', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 300]).setRotation(degrees(90));
    // The target's width and height are the reader's, as the editor computes them: 200 across.
    const target = { x: 100, y: 100, width: 200, height: 100 };
    await drawStamp(doc, 0, { text: 'FINAL', hex: '#0b63c4' }, target, { fontkit, rotation: 90 });
    const seen = await raster(await doc.save());
    expect([seen.width, seen.height]).toEqual([300, 400]);
    const ink = inkBox(seen);
    // Wider than tall on screen: the lettering runs along the displayed horizontal.
    expect(ink.maxX - ink.minX).toBeGreaterThan((ink.maxY - ink.minY) * 2);
    await expect(
      drawStamp(doc, 0, { text: 'FINAL', hex: '#0b63c4' }, target, { fontkit, rotation: 45 }),
    ).rejects.toThrow('quarter turns');
    await expect(drawStamp(doc, 0, { text: 'X', hex: '#000000' }, target, {})).rejects.toThrow(
      'not ready',
    );
  });
});
