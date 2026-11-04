import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import {
  smoothStroke,
  strokesBounds,
  typedOutline,
  fitSignature,
  drawSignature,
  PEN_WIDTH,
} from '../src/core/signature.js';
import { inspectPaths, editPath } from '../src/core/path-edit.js';
import { inspectImages, imageCorners } from '../src/core/image-edit.js';

let fontBytes;
beforeAll(async () => {
  fontBytes = await readFile(new URL('../public/fonts/GreatVibes-Regular.ttf', import.meta.url));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(fontBytes));
});

async function raster(bytes) {
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    const page = await (await task.promise).getPage(1);
    const canvas = createCanvas(400, 400),
      context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport: page.getViewport({ scale: 1 }) }).promise;
    return context.getImageData(0, 0, 400, 400).data;
  } finally {
    await task.destroy();
  }
}
/** Dark pixels inside and outside a PDF-space box on a 400 pt square page. */
function inkCounts(pixels, box) {
  let inside = 0,
    outside = 0;
  for (let y = 0; y < 400; y++)
    for (let x = 0; x < 400; x++) {
      const i = (y * 400 + x) * 4;
      if (pixels[i] > 200 && pixels[i + 1] > 200 && pixels[i + 2] > 200) continue;
      const pdfY = 400 - y;
      if (
        x >= box.x - 1 &&
        x <= box.x + box.width + 1 &&
        pdfY >= box.y - 1 &&
        pdfY <= box.y + box.height + 1
      )
        inside++;
      else outside++;
    }
  return { inside, outside };
}
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAADuKoOJAAAAEklEQVR42mNk+M9Qz8DAwMAAAA0BAgFQDEZ+AAAAAElFTkSuQmCC';

describe('signature geometry', () => {
  it('smooths a polyline into curves through its points and drops repeated samples', () => {
    const { start, curves } = smoothStroke([
      [0, 0],
      [0, 0],
      [10, 0],
      [20, 10],
    ]);
    expect(start).toEqual([0, 0]);
    expect(curves).toHaveLength(2);
    expect(curves[0].slice(4)).toEqual([10, 0]);
    expect(curves[1].slice(4)).toEqual([20, 10]);
    // Control points lean along the neighboring segments.
    expect(curves[0][2]).toBeLessThan(10);
    expect(curves[1][0]).toBeGreaterThan(10);
    expect(smoothStroke([[5, 5]])).toEqual({ start: [5, 5], curves: [] });
  });
  it('pads stroke bounds for the pen and fits boxes centered in a target', () => {
    const box = strokesBounds([
      [
        [10, 10],
        [110, 60],
      ],
    ]);
    expect(box).toEqual({
      x: 10 - PEN_WIDTH,
      y: 10 - PEN_WIDTH,
      width: 100 + 2 * PEN_WIDTH,
      height: 50 + 2 * PEN_WIDTH,
    });
    const placed = fitSignature(
      { width: 200, height: 100 },
      { x: 0, y: 0, width: 100, height: 100 },
    );
    expect(placed).toMatchObject({ scale: 0.5, x: 0, y: 25, width: 100, height: 50 });
  });
  it('lays out typed text as cubic outlines and rejects text the font cannot show', () => {
    const { commands, box } = typedOutline(fontkit, fontBytes, 'Ada Lovelace');
    const ops = new Set(commands.map((c) => c[0]));
    expect(ops.has('m') && ops.has('c') && ops.has('h')).toBe(true);
    expect([...ops].every((op) => ['m', 'l', 'c', 'h'].includes(op))).toBe(true);
    expect(commands.filter((c) => c[0] === 'c').every((c) => c.length === 7)).toBe(true);
    expect(box.width).toBeGreaterThan(2000);
    expect(box.height).toBeGreaterThan(1000);
    expect(() => typedOutline(fontkit, fontBytes, '  ')).toThrow('Type your name');
    expect(() => typedOutline(fontkit, fontBytes, '漢字')).toThrow('has no "漢"');
    expect(() => typedOutline(fontkit, fontBytes, 'x'.repeat(61))).toThrow('under 60');
  });
});

describe('placing signatures', () => {
  const target = { x: 100, y: 100, width: 200, height: 80 };
  it.each([
    [200, 80],
    [80, 200],
  ])('keeps smoothed turns inside a %s by %s signature box', async (width, height) => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    const box = { x: 100, y: 100, width, height };
    await drawSignature(
      doc,
      0,
      {
        type: 'draw',
        strokes: [
          [
            [0, 0],
            [100, 0],
            [100, 100],
            [0, 100],
          ],
        ],
      },
      box,
    );
    const ink = inkCounts(await raster(await doc.save()), box);
    expect(ink.inside).toBeGreaterThan(100);
    expect(ink.outside).toBe(0);
  });
  it.each(['J', 'Jane', 'j'])(
    'keeps the flourishes in %s inside a narrow signature box',
    async (text) => {
      const doc = await PDFDocument.create();
      doc.addPage([400, 400]);
      const narrow = { x: 100, y: 100, width: 60, height: 180 };
      await drawSignature(doc, 0, { type: 'type', text }, narrow, { fontkit });
      const ink = inkCounts(await raster(await doc.save()), narrow);
      expect(ink.inside).toBeGreaterThan(100);
      expect(ink.outside).toBe(0);
    },
  );
  it.each([1, 3])(
    'renders a dot from %s repeated pointer samples as editable ink',
    async (samples) => {
      const doc = await PDFDocument.create();
      doc.addPage([400, 400]);
      await drawSignature(
        doc,
        0,
        {
          type: 'draw',
          strokes: [Array.from({ length: samples }, () => [30, 40])],
        },
        target,
      );
      const bytes = await doc.save();
      const paths = inspectPaths(await PDFDocument.load(bytes), 0);
      expect(paths).toHaveLength(1);
      // Marked as a signature, so it is named one when selected rather than a drawing.
      expect(paths[0]).toMatchObject({ kind: 'signature', stroked: true, filled: false });
      const ink = inkCounts(await raster(bytes), target);
      expect(ink.inside).toBeGreaterThan(900);
      expect(ink.outside).toBe(0);
    },
  );
  it('draws a signature as one smooth stroked path inside the target box', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    await drawSignature(
      doc,
      0,
      {
        type: 'draw',
        strokes: [
          [
            [0, 40],
            [30, 0],
            [60, 40],
            [90, 0],
          ],
          [
            [100, 20],
            [140, 20],
          ],
        ],
      },
      target,
      { hex: '#1133aa' },
    );
    const bytes = await doc.save();
    const paths = inspectPaths(await PDFDocument.load(bytes), 0);
    expect(paths).toHaveLength(1);
    // Marked as a signature, so it is named one when selected rather than a drawing.
    expect(paths[0]).toMatchObject({ kind: 'signature', stroked: true, filled: false });
    expect(paths[0].svg).toContain('C');
    expect((paths[0].svg.match(/M /g) || []).length).toBe(2);
    const { inside, outside } = inkCounts(await raster(bytes), target);
    expect(inside).toBeGreaterThan(300);
    expect(outside).toBe(0);
    // The ink spans the target width, inset only by the pen, and is centered vertically.
    expect(paths[0].bounds[0]).toBeGreaterThanOrEqual(100);
    expect(paths[0].bounds[0]).toBeLessThan(106);
    expect(paths[0].bounds[2]).toBeLessThanOrEqual(300);
    expect(paths[0].bounds[2]).toBeGreaterThan(294);
    expect((paths[0].bounds[1] + paths[0].bounds[3]) / 2).toBeCloseTo(140, 0);
  });
  it('types a signature as one filled outline path that stays inside the target box', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    await drawSignature(doc, 0, { type: 'type', text: 'Ada Lovelace' }, target, { fontkit });
    const bytes = await doc.save();
    const paths = inspectPaths(await PDFDocument.load(bytes), 0);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({
      kind: 'signature',
      filled: true,
      stroked: false,
      fillRule: 'nonzero',
    });
    expect(paths[0].svg).toContain('Z');
    const { inside, outside } = inkCounts(await raster(bytes), target);
    expect(inside).toBeGreaterThan(500);
    expect(outside).toBe(0);
    await expect(drawSignature(doc, 0, { type: 'type', text: 'x' }, target)).rejects.toThrow(
      'not ready',
    );
  });
  it('keeps a signature named one after its color or stroke is changed', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    await drawSignature(doc, 0, { type: 'type', text: 'Ada' }, target, { fontkit });
    editPath(doc, 0, inspectPaths(doc, 0)[0], { style: { stroked: true, fill: '#cc0000' } });
    const loaded = await PDFDocument.load(await doc.save());
    expect(inspectPaths(loaded, 0)).toMatchObject([{ kind: 'signature', stroked: true }]);
  });
  it('places an uploaded picture fitted and centered, and rejects empty input', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    await drawSignature(doc, 0, { type: 'image', bytes: Buffer.from(PNG, 'base64') }, target);
    const [image] = inspectImages(await PDFDocument.load(await doc.save()), 0);
    // A 2:1 picture fills the 200 pt width at 100 pt tall? No: capped by the 80 pt height.
    expect(image.transform[0]).toBeCloseTo(160, 5);
    expect(image.transform[3]).toBeCloseTo(80, 5);
    expect(image.transform[4]).toBeCloseTo(120, 5);
    expect(image.transform[5]).toBeCloseTo(100, 5);
    await expect(drawSignature(doc, 0, { type: 'draw', strokes: [] }, target)).rejects.toThrow(
      'Draw your signature',
    );
    await expect(
      drawSignature(
        doc,
        0,
        { type: 'draw', strokes: [[[1, 1]]] },
        { x: 0, y: 0, width: 0, height: 0 },
      ),
    ).rejects.toThrow('where the signature');
    await expect(drawSignature(doc, 0, { type: 'wave' }, target)).rejects.toThrow('Choose a');
  });
});

describe('signatures on rotated pages', () => {
  it('turns the signature with the page so it reads upright, keeping its box centered', async () => {
    const target = { x: 100, y: 150, width: 200, height: 80 };
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    await drawSignature(
      doc,
      0,
      {
        type: 'draw',
        strokes: [
          [
            [0, 0],
            [100, 0],
          ],
        ],
      },
      target,
      { rotation: 90 },
    );
    const [path] = inspectPaths(await PDFDocument.load(await doc.save()), 0);
    // A flat stroke across the box becomes a vertical one on the page, through the same
    // center: the path's own box is wide, its placement turns it.
    const corners = imageCorners(path.transform),
      xs = corners.map((p) => p[0]),
      ys = corners.map((p) => p[1]);
    const width = Math.max(...xs) - Math.min(...xs),
      height = Math.max(...ys) - Math.min(...ys);
    expect(height).toBeGreaterThan(width * 5);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(200, 0);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(190, 0);
    // The graphics state is balanced: nothing after the signature inherits the turn.
    expect(path.ctm.map((n) => Math.round(n))).toEqual([0, 1, -1, 0, 390, -10]);
    await expect(
      drawSignature(doc, 0, { type: 'draw', strokes: [[[0, 0]]] }, target, { rotation: 45 }),
    ).rejects.toThrow('quarter turns');
  });
});
