import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFNumber, PDFString, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import {
  addCallout,
  addInkAnnotation,
  addReply,
  addShapeAnnotation,
  addTextBox,
  deleteAnnotation,
  editAnnotation,
  exportCommentSummary,
  exportXfdf,
  importXfdf,
  listAnnotations,
  listReplies,
  setMarkedState,
  setReviewState,
} from '../src/core/annotations.js';
import { addNote } from '../src/core/notes.js';
import { addHighlight, rectQuad } from '../src/core/highlight.js';
import { flattenDocument } from '../src/core/flatten.js';
import { collectComments } from '../src/core/comments.js';

const fonts = new Map();
beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const file = String(url).split('/').pop();
    if (!fonts.has(file))
      fonts.set(file, await readFile(new URL(`../public/fonts/${file}`, import.meta.url)));
    return new Response(fonts.get(file));
  });
});
afterEach(() => vi.restoreAllMocks());

async function blank(pages = 1, size = [612, 792]) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage(size);
  return doc;
}
async function withPdf(bytes, fn) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  try {
    return await fn(await task.promise);
  } finally {
    await task.destroy();
  }
}
const annotationsIn = (bytes, pageNumber = 1) =>
  withPdf(bytes, async (pdf) => (await pdf.getPage(pageNumber)).getAnnotations());

/**
 * The page as the reader shows it, with a way to count inked pixels inside (and outside) a box
 * given in PDF user space, wherever the page's rotation puts it on screen.
 */
async function render(bytes, pageNumber = 1, scale = 1) {
  return withPdf(bytes, async (pdf) => {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const width = Math.round(viewport.width),
      height = Math.round(viewport.height);
    const canvas = createCanvas(width, height),
      context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    await page.render({ canvasContext: context, viewport }).promise;
    const data = context.getImageData(0, 0, width, height).data;
    const inked = (x, y) => {
      const i = (y * width + x) * 4;
      return !(data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240);
    };
    const screenBox = ({ x, y, width: w, height: h }) => {
      const a = viewport.convertToViewportPoint(x, y),
        b = viewport.convertToViewportPoint(x + w, y + h);
      return [
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[0], b[0]),
        Math.max(a[1], b[1]),
      ];
    };
    return {
      width,
      height,
      data,
      inked,
      /** Inked pixels inside and outside a PDF-space box. */
      count(box) {
        const [x0, y0, x1, y1] = screenBox(box);
        let inside = 0,
          outside = 0;
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            if (!inked(x, y)) continue;
            if (x >= x0 - 1 && x <= x1 + 1 && y >= y0 - 1 && y <= y1 + 1) inside++;
            else outside++;
          }
        return { inside, outside };
      },
      /** The bounding box of all ink on screen. */
      inkBox() {
        let x0 = width,
          y0 = height,
          x1 = -1,
          y1 = -1;
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++)
            if (inked(x, y)) {
              x0 = Math.min(x0, x);
              x1 = Math.max(x1, x);
              y0 = Math.min(y0, y);
              y1 = Math.max(y1, y);
            }
        return x1 < 0 ? null : { x0, y0, x1, y1 };
      },
    };
  });
}
/** The ink inside its bounding box sampled onto a grid, to compare how two renders look. */
function signature(view, columns = 24, rows = 6) {
  const box = view.inkBox();
  const cells = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++) {
      let ink = 0,
        total = 0;
      const xa = box.x0 + ((box.x1 - box.x0 + 1) * c) / columns,
        xb = box.x0 + ((box.x1 - box.x0 + 1) * (c + 1)) / columns;
      const ya = box.y0 + ((box.y1 - box.y0 + 1) * r) / rows,
        yb = box.y0 + ((box.y1 - box.y0 + 1) * (r + 1)) / rows;
      for (let y = Math.floor(ya); y < Math.ceil(yb); y++)
        for (let x = Math.floor(xa); x < Math.ceil(xb); x++) {
          total++;
          if (view.inked(x, y)) ink++;
        }
      cells.push(ink / Math.max(1, total));
    }
  return cells;
}
const difference = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
async function paintedText(bytes, pageNumber = 1) {
  return withPdf(bytes, async (pdf) => {
    const ops = await (await pdf.getPage(pageNumber)).getOperatorList();
    return ops.fnArray
      .flatMap((fn, i) =>
        fn === pdfjs.OPS.showText ? [ops.argsArray[i][0].map((g) => g.unicode || '').join('')] : [],
      )
      .filter(Boolean);
  });
}
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const annots = (doc, index = 0) =>
  doc
    .getPage(index)
    .node.lookup(PDFName.of('Annots'))
    ?.asArray()
    .map((ref) => doc.context.lookup(ref)) ?? [];
const subtypesOf = (doc, index = 0) =>
  annots(doc, index).map((dict) => dict.lookup(PDFName.of('Subtype')).decodeText());
const near = (a, b, tolerance = 0.01) => a.every((value, i) => Math.abs(value - b[i]) <= tolerance);

describe('text boxes', () => {
  it('reads the same on a page whose units are larger than points', async () => {
    // Letter paper in units of ten points, as large drawings are made, beside plain Letter.
    const views = [];
    for (const unit of [1, 10]) {
      const doc = await blank(1, [612 / unit, 792 / unit]);
      doc.getPage(0).node.set(PDFName.of('UserUnit'), PDFNumber.of(unit));
      const rect = { x: 100 / unit, y: 400 / unit, width: 160 / unit, height: 16 / unit };
      await addTextBox(doc, 0, {
        rect,
        text: 'Measured',
        fontSize: 10 / unit,
        borderColor: null,
        borderWidth: 0,
      });
      views.push((await render(await doc.save())).count(rect));
    }
    expect(views[0].inside).toBeGreaterThan(100);
    expect(views[1].inside).toBeGreaterThan(views[0].inside * 0.8);
    expect(views[1].outside).toBe(0);
  });
  it('writes a FreeText with DA, DS, RC and an appearance that wraps its text in the box', async () => {
    const doc = await blank();
    const rect = { x: 100, y: 500, width: 160, height: 90 };
    const text = 'The quick brown fox jumps over the lazy dog again and again';
    const id = await addTextBox(doc, 0, {
      rect,
      text,
      fontSize: 14,
      color: '#0000ff',
      fill: '#ffff00',
      borderColor: '#ff0000',
      borderWidth: 2,
      author: 'Ada',
    });
    expect(id).toMatch(/^\d+ 0 R$/);
    const [dict] = annots(doc);
    expect(dict.lookup(PDFName.of('IT')).decodeText()).toBe('FreeText');
    expect(dict.lookup(PDFName.of('DA')).decodeText()).toBe('1 0 0 RG /Helv 14 Tf 0 0 1 rg');
    expect(dict.lookup(PDFName.of('DS')).decodeText()).toContain('color:#0000FF');
    expect(dict.lookup(PDFName.of('RC')).decodeText()).toContain('<span>The quick brown fox');
    const bytes = await doc.save();
    const [a] = await annotationsIn(bytes);
    expect(a.subtype).toBe('FreeText');
    expect(near(a.rect, [100, 500, 260, 590])).toBe(true);
    expect(a.contentsObj.str).toBe(text);
    expect(Array.from(a.color)).toEqual([255, 255, 0]);
    expect(a.titleObj.str).toBe('Ada');
    expect(a.hasAppearance).toBe(true);
    // The appearance draws the words over several lines, all inside the box.
    const lines = await paintedText(bytes);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join(' ').replace(/\s+/g, ' ')).toBe(text);
    const view = await render(bytes);
    const { inside, outside } = view.count(rect);
    expect(inside).toBeGreaterThan(5000);
    expect(outside).toBe(0);
  });

  it('embeds Noto Sans for text Helvetica cannot encode', async () => {
    const doc = await blank();
    await addTextBox(doc, 0, {
      rect: { x: 50, y: 600, width: 300, height: 60 },
      text: 'Привет, Ωμέγα',
      borderColor: null,
    });
    const bytes = await doc.save();
    const reopened = await PDFDocument.load(bytes);
    const ap = annots(reopened)[0].lookup(PDFName.of('AP')).lookup(PDFName.of('N'));
    const font = ap.dict.lookup(PDFName.of('Resources')).lookup(PDFName.of('Font'));
    const [[key, ref]] = font.entries();
    expect(key.decodeText()).toBe('NotoSans');
    expect(reopened.context.lookup(ref).lookup(PDFName.of('BaseFont')).decodeText()).toMatch(
      /NotoSans/,
    );
    expect((await paintedText(bytes)).join('')).toBe('Привет, Ωμέγα');
    expect(
      (await render(bytes)).count({ x: 50, y: 600, width: 300, height: 60 }).inside,
    ).toBeGreaterThan(200);
  });

  it('reads upright on turned pages', async () => {
    const options = {
      rect: { x: 200, y: 300, width: 200, height: 40 },
      text: 'Upright?',
      fontSize: 18,
      borderColor: null,
    };
    const signatures = {};
    for (const rotation of [0, 90, 180, 270]) {
      const doc = await blank();
      doc.getPage(0).setRotation(degrees(rotation));
      // The same box as the reader sees it: on a quarter-turned page its sides swap.
      const rect = rotation % 180 ? { x: 250, y: 250, width: 40, height: 200 } : options.rect;
      await addTextBox(doc, 0, { ...options, rect });
      const [dict] = annots(doc);
      expect(dict.lookup(PDFName.of('Rotate'))?.asNumber() ?? 0).toBe(rotation);
      const view = await render(await doc.save());
      const box = view.inkBox();
      // One line of text: wider than tall on screen whichever way the page is turned.
      expect(box.x1 - box.x0).toBeGreaterThan(2 * (box.y1 - box.y0));
      signatures[rotation] = signature(view);
    }
    for (const rotation of [90, 180, 270])
      expect(difference(signatures[0], signatures[rotation])).toBeLessThan(0.06);
    // An upside-down rendering of the same word would differ far more.
    const flipped = [...signatures[0]].reverse();
    expect(difference(signatures[0], flipped)).toBeGreaterThan(0.08);
  });

  it('adds callouts with a three-point leader line ending in an arrow at the anchor', async () => {
    const doc = await blank();
    const box = { x: 300, y: 500, width: 150, height: 50 };
    await addCallout(doc, 0, {
      rect: box,
      anchor: { x: 150, y: 400 },
      text: 'Look here',
    });
    const [dict] = annots(doc);
    expect(dict.lookup(PDFName.of('IT')).decodeText()).toBe('FreeTextCallout');
    expect(dict.lookup(PDFName.of('LE')).decodeText()).toBe('OpenArrow');
    const cl = dict
      .lookup(PDFName.of('CL'))
      .asArray()
      .map((n) => n.asNumber());
    expect(cl).toEqual([150, 400, 282, 525, 300, 525]);
    const rd = dict
      .lookup(PDFName.of('RD'))
      .asArray()
      .map((n) => n.asNumber());
    const rect = dict
      .lookup(PDFName.of('Rect'))
      .asArray()
      .map((n) => n.asNumber());
    // Rect less RD is the text box.
    expect(
      near(
        [rect[0] + rd[0], rect[1] + rd[1], rect[2] - rd[2], rect[3] - rd[3]],
        [300, 500, 450, 550],
      ),
    ).toBe(true);
    expect(rect[0]).toBeLessThan(150);
    expect(rect[1]).toBeLessThan(400);
    const [entry] = listAnnotations(doc, 0);
    expect(entry.box).toEqual({ x: 300, y: 500, width: 150, height: 50 });
    expect(entry.points[0]).toEqual({ x: 150, y: 400 });
    const bytes = await doc.save();
    const [a] = await annotationsIn(bytes);
    expect(a.subtype).toBe('FreeText');
    const view = await render(bytes);
    // Ink at the arrow tip and along the leader line, and in the box.
    expect(view.count({ x: 145, y: 395, width: 12, height: 12 }).inside).toBeGreaterThan(10);
    expect(view.count({ x: 210, y: 455, width: 10, height: 10 }).inside).toBeGreaterThan(5);
    expect(view.count(box).inside).toBeGreaterThan(300);
    // Moving only the anchor redraws the leader line.
    await editAnnotation(doc, 0, entry.id, { anchor: { x: 500, y: 700 } });
    const [moved] = listAnnotations(doc, 0);
    expect(moved.points[0]).toEqual({ x: 500, y: 700 });
    expect(moved.box).toEqual(entry.box);
    expect(moved.rect.y + moved.rect.height).toBeGreaterThan(700);
    await expect(
      addCallout(doc, 0, { rect: box, anchor: { x: 310, y: 510 }, text: 'x' }),
    ).rejects.toThrow('outside');
  });
});

describe('shapes and pencil', () => {
  it('creates every shape with its dictionary and an appearance in the right place', async () => {
    const doc = await blank();
    const ids = {
      square: addShapeAnnotation(doc, 0, {
        kind: 'square',
        rect: { x: 50, y: 650, width: 100, height: 80 },
        fill: '#00ff00',
        width: 3,
        author: 'Ada',
        text: 'Box',
      }),
      circle: addShapeAnnotation(doc, 0, {
        kind: 'circle',
        rect: { x: 250, y: 650, width: 120, height: 80 },
        dash: [4, 2],
      }),
      line: addShapeAnnotation(doc, 0, {
        kind: 'line',
        points: [
          { x: 50, y: 550 },
          { x: 200, y: 600 },
        ],
      }),
      arrow: addShapeAnnotation(doc, 0, {
        kind: 'arrow',
        points: [
          { x: 300, y: 550 },
          { x: 450, y: 600 },
        ],
        width: 2,
      }),
      polygon: addShapeAnnotation(doc, 0, {
        kind: 'polygon',
        points: [
          { x: 50, y: 400 },
          { x: 150, y: 400 },
          { x: 100, y: 480 },
        ],
        color: '#0000ff',
        opacity: 0.5,
      }),
      polyline: addShapeAnnotation(doc, 0, {
        kind: 'polyline',
        points: [
          { x: 250, y: 400 },
          { x: 300, y: 480 },
          { x: 350, y: 400 },
          { x: 400, y: 480 },
        ],
      }),
      cloud: addShapeAnnotation(doc, 0, {
        kind: 'cloud',
        rect: { x: 100, y: 150, width: 200, height: 120 },
        intensity: 1,
      }),
    };
    const dicts = annots(doc);
    const get = (dict, key) => dict.lookup(PDFName.of(key));
    expect(get(dicts[3], 'IT').decodeText()).toBe('LineArrow');
    expect(
      get(dicts[3], 'LE')
        .asArray()
        .map((n) => n.decodeText()),
    ).toEqual(['None', 'OpenArrow']);
    expect(get(dicts[6], 'IT').decodeText()).toBe('PolygonCloud');
    expect(get(get(dicts[6], 'BE'), 'S').decodeText()).toBe('C');
    expect(get(dicts[4], 'CA').asNumber()).toBe(0.5);
    expect(get(get(dicts[1], 'BS'), 'S').decodeText()).toBe('D');
    for (const dict of dicts) expect(get(get(dict, 'AP'), 'N')).toBeTruthy();

    const listed = listAnnotations(doc, 0);
    expect(listed.map((a) => a.subtype)).toEqual([
      'Square',
      'Circle',
      'Line',
      'Line',
      'Polygon',
      'PolyLine',
      'Polygon',
    ]);
    expect(listed[0]).toMatchObject({
      id: ids.square,
      color: '#e5322d',
      fill: '#00ff00',
      width: 3,
      contents: 'Box',
      author: 'Ada',
      rect: { x: 50, y: 650, width: 100, height: 80 },
    });
    expect(listed[3].lineEndings).toEqual(['None', 'OpenArrow']);
    expect(listed[6].cloud).toBe(1);

    const bytes = await doc.save();
    const pdfjsAnnots = await annotationsIn(bytes);
    expect(pdfjsAnnots.map((a) => a.subtype)).toEqual([
      'Square',
      'Circle',
      'Line',
      'Line',
      'Polygon',
      'PolyLine',
      'Polygon',
    ]);
    expect(Array.from(pdfjsAnnots[0].color)).toEqual(rgbOf('#e5322d'));
    expect(Array.from(pdfjsAnnots[4].color)).toEqual([0, 0, 255]);
    expect(pdfjsAnnots[3].lineEndings).toEqual(['None', 'OpenArrow']);
    expect(pdfjsAnnots[3].lineCoordinates).toEqual([300, 550, 450, 600]);
    expect(Array.from(pdfjsAnnots[4].vertices)).toEqual([50, 400, 150, 400, 100, 480]);

    const view = await render(bytes);
    const regions = {
      square: { x: 50, y: 650, width: 100, height: 80 },
      circle: { x: 250, y: 650, width: 120, height: 80 },
      line: { x: 50, y: 550, width: 150, height: 50 },
      arrow: { x: 300, y: 550, width: 150, height: 50 },
      polygon: { x: 50, y: 400, width: 100, height: 80 },
      polyline: { x: 250, y: 400, width: 150, height: 80 },
      cloud: { x: 100, y: 150, width: 200, height: 120 },
    };
    let total = 0;
    for (const [kind, region] of Object.entries(regions)) {
      const grown = {
        x: region.x - 10,
        y: region.y - 10,
        width: region.width + 20,
        height: region.height + 20,
      };
      const { inside } = view.count(grown);
      expect(inside, kind).toBeGreaterThan(100);
      total += inside;
    }
    // Nothing is drawn anywhere else.
    expect(view.count({ x: 0, y: 0, width: 612, height: 792 }).inside).toBeLessThanOrEqual(total);
    // The filled rectangle is green inside; the cloud's scallops reach beyond its corners.
    const green = view.count({ x: 70, y: 670, width: 60, height: 40 });
    expect(green.inside).toBeGreaterThan(2000);
    expect(view.count({ x: 95, y: 145, width: 4, height: 130 }).inside).toBeGreaterThan(20);
    expect(view.count({ x: 110, y: 160, width: 180, height: 100 }).inside).toBe(0);
  });

  it('draws pencil strokes as smoothed Ink with an InkList', async () => {
    const doc = await blank();
    const strokes = [
      [
        { x: 100, y: 100 },
        { x: 150, y: 160 },
        { x: 200, y: 100 },
        { x: 250, y: 160 },
      ],
      [{ x: 300, y: 300 }],
    ];
    addInkAnnotation(doc, 0, {
      strokes,
      color: '#ff0000',
      width: 4,
      opacity: 0.8,
    });
    const [entry] = listAnnotations(doc, 0);
    expect(entry.subtype).toBe('Ink');
    expect(entry.points).toEqual(strokes);
    expect(entry.opacity).toBe(0.8);
    const bytes = await doc.save();
    const [a] = await annotationsIn(bytes);
    expect(a.subtype).toBe('Ink');
    expect(a.inkLists.map((list) => Array.from(list))).toEqual([
      [100, 100, 150, 160, 200, 100, 250, 160],
      [300, 300],
    ]);
    const view = await render(bytes);
    expect(view.count({ x: 145, y: 150, width: 10, height: 14 }).inside).toBeGreaterThan(10);
    // The single tap is a dot.
    expect(view.count({ x: 297, y: 297, width: 6, height: 6 }).inside).toBeGreaterThan(5);
    expect(view.count({ x: 90, y: 90, width: 220, height: 220 }).outside).toBe(0);
  });
});

describe('editing', () => {
  it('moves and resizes a line, a drawing and a polygon, carrying their geometry', async () => {
    const doc = await blank();
    const line = addShapeAnnotation(doc, 0, {
      kind: 'arrow',
      points: [
        { x: 100, y: 100 },
        { x: 200, y: 150 },
      ],
    });
    const ink = addInkAnnotation(doc, 0, {
      strokes: [
        [
          { x: 300, y: 300 },
          { x: 350, y: 350 },
          { x: 400, y: 300 },
        ],
      ],
    });
    const polygon = addShapeAnnotation(doc, 0, {
      kind: 'polygon',
      points: [
        { x: 100, y: 500 },
        { x: 200, y: 500 },
        { x: 150, y: 600 },
      ],
    });
    const before = Object.fromEntries(listAnnotations(doc, 0).map((a) => [a.id, a]));
    // Move the line by (+200, +300) keeping its size.
    const r = before[line].rect;
    await editAnnotation(doc, 0, line, {
      rect: { ...r, x: r.x + 200, y: r.y + 300 },
    });
    // Double the drawing's size from its lower-left corner.
    const s = before[ink].rect;
    await editAnnotation(doc, 0, ink, {
      rect: { ...s, width: s.width * 2, height: s.height * 2 },
    });
    // Replace the polygon's points outright.
    await editAnnotation(doc, 0, polygon, {
      points: [
        { x: 400, y: 600 },
        { x: 500, y: 600 },
        { x: 500, y: 700 },
        { x: 400, y: 700 },
      ],
    });
    const after = Object.fromEntries(listAnnotations(doc, 0).map((a) => [a.id, a]));
    expect(after[line].points).toEqual([
      { x: 300, y: 400 },
      { x: 400, y: 450 },
    ]);
    const [p0, p1, p2] = after[ink].points[0];
    const sx = (x) => s.x + (x - s.x) * 2,
      sy = (y) => s.y + (y - s.y) * 2;
    expect(
      near(
        [p0.x, p0.y, p1.x, p1.y, p2.x, p2.y],
        [sx(300), sy(300), sx(350), sy(350), sx(400), sy(300)],
        0.001,
      ),
    ).toBe(true);
    expect(after[polygon].points).toHaveLength(4);
    const bytes = await doc.save();
    const pdfjsAnnots = await annotationsIn(bytes);
    expect(pdfjsAnnots[0].lineCoordinates).toEqual([300, 400, 400, 450]);
    const view = await render(bytes);
    // The line's appearance moved with it.
    expect(view.count({ x: 95, y: 95, width: 110, height: 60 }).inside).toBe(0);
    expect(view.count({ x: 345, y: 420, width: 10, height: 10 }).inside).toBeGreaterThan(5);
    // The polygon is drawn at its new corners only.
    expect(view.count({ x: 120, y: 520, width: 60, height: 40 }).inside).toBe(0);
    expect(view.count({ x: 398, y: 598, width: 104, height: 4 }).inside).toBeGreaterThan(50);
  });

  it('restyles shapes and text boxes and redraws them', async () => {
    const doc = await blank();
    const square = addShapeAnnotation(doc, 0, {
      kind: 'square',
      rect: { x: 100, y: 100, width: 100, height: 100 },
    });
    const box = await addTextBox(doc, 0, {
      rect: { x: 300, y: 300, width: 200, height: 100 },
      text: 'Small',
    });
    await editAnnotation(doc, 0, square, {
      color: '#0000ff',
      fill: '#0000ff',
      width: 4,
      contents: 'Blue',
    });
    await editAnnotation(doc, 0, box, {
      text: 'Bigger text',
      fontSize: 30,
      fill: '#00ff00',
      align: 'center',
    });
    const [sq, tb] = listAnnotations(doc, 0);
    expect(sq).toMatchObject({
      color: '#0000ff',
      fill: '#0000ff',
      width: 4,
      contents: 'Blue',
    });
    expect(tb).toMatchObject({
      contents: 'Bigger text',
      fontSize: 30,
      fill: '#00ff00',
      align: 'center',
    });
    const bytes = await doc.save();
    expect(await paintedText(bytes)).toEqual(['Bigger text']);
    const view = await render(bytes);
    const i = ((792 - 150) * view.width + 150) * 4;
    expect(Array.from(view.data.slice(i, i + 3))).toEqual([0, 0, 255]);
  });

  it('moves a comment from another editor with the drawing it came with', async () => {
    // A dimension line as Acrobat's Measure tool draws it: its caption is in its appearance.
    const doc = await blank();
    const font = doc.embedStandardFont('Helvetica');
    const drawing = doc.context.register(
      doc.context.stream(
        '0 0 1 RG 1 w 100 100 m 300 100 l S BT /F1 10 Tf 180 106 Td (2.78 in) Tj ET',
        {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: [90, 90, 310, 120],
          Resources: { Font: { F1: font.ref } },
        },
      ),
    );
    const line = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Line',
        Rect: [90, 90, 310, 120],
        L: [100, 100, 300, 100],
        C: [0, 0, 1],
        IT: 'LineDimension',
        Cap: true,
        Contents: PDFString.of('2.78 in'),
        AP: { N: drawing },
      }),
    );
    doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([line]));
    const [entry] = listAnnotations(doc, 0);
    // Its look cannot be drawn again here, so it can be moved but not restyled.
    expect(entry.editable).toBe(false);
    await expect(editAnnotation(doc, 0, entry.id, { color: '#ff0000' })).rejects.toThrow(
      'cannot be changed',
    );
    await editAnnotation(doc, 0, entry.id, {
      rect: { ...entry.rect, x: entry.rect.x + 50, y: entry.rect.y + 200 },
    });
    expect(listAnnotations(doc, 0)[0]).toMatchObject({
      rect: { x: 140, y: 290, width: 220, height: 30 },
      points: [
        { x: 150, y: 300 },
        { x: 350, y: 300 },
      ],
    });
    const bytes = await doc.save();
    expect(await paintedText(bytes)).toEqual(['2.78 in']);
    const view = await render(bytes);
    expect(view.count({ x: 140, y: 290, width: 220, height: 30 })).toMatchObject({ outside: 0 });
    expect(view.count({ x: 140, y: 290, width: 220, height: 30 }).inside).toBeGreaterThan(100);
  });

  it('edits annotations from other writers and respects their locks', async () => {
    const doc = await blank();
    const page = doc.getPage(0);
    const foreign = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [100, 100, 200, 200],
        C: [1, 0, 0],
        Contents: PDFString.of('Theirs'),
        T: PDFString.of('Grace'),
        M: PDFString.of('D:20260914120000Z'),
      }),
    );
    const locked = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Circle',
        Rect: [300, 300, 400, 400],
        F: 4 | 128,
      }),
    );
    page.node.set(PDFName.of('Annots'), doc.context.obj([foreign, locked]));
    const [theirs, lockedEntry] = listAnnotations(doc, 0);
    expect(theirs).toMatchObject({
      subtype: 'Square',
      author: 'Grace',
      contents: 'Theirs',
      color: '#ff0000',
    });
    expect(theirs.modified.toISOString()).toBe('2026-09-14T12:00:00.000Z');
    expect(lockedEntry.locked).toBe(true);
    await editAnnotation(doc, 0, theirs.id, {
      rect: { x: 150, y: 150, width: 50, height: 50 },
    });
    const dict = doc.context.lookup(foreign);
    expect(dict.lookup(PDFName.of('AP'))).toBeTruthy();
    expect(listAnnotations(doc, 0)[0].rect).toEqual({
      x: 150,
      y: 150,
      width: 50,
      height: 50,
    });
    await expect(editAnnotation(doc, 0, lockedEntry.id, { color: '#000000' })).rejects.toThrow(
      'locked',
    );
    expect(() => deleteAnnotation(doc, 0, lockedEntry.id)).toThrow('locked');
    // Contents of a locked comment can still change, as Acrobat allows.
    await editAnnotation(doc, 0, lockedEntry.id, { contents: 'Noted' });
    expect(listAnnotations(doc, 0)[1].contents).toBe('Noted');
  });
});

describe('replies and review states', () => {
  it('threads replies as hidden Text annotations with IRT and records review states', async () => {
    const doc = await blank();
    const shape = addShapeAnnotation(doc, 0, {
      kind: 'square',
      rect: { x: 100, y: 100, width: 100, height: 100 },
      author: 'Ada',
      text: 'Is this right?',
    });
    const reply = addReply(doc, 0, shape, { text: 'Yes', author: 'Grace' });
    addReply(doc, 0, reply, { text: 'Thanks', author: 'Ada' });
    setReviewState(doc, 0, shape, { state: 'Rejected', author: 'Grace' });
    const accepted = setReviewState(doc, 0, shape, {
      state: 'Accepted',
      author: 'Grace',
    });
    setMarkedState(doc, 0, shape, { state: 'Marked', author: 'Ada' });
    expect(() => setReviewState(doc, 0, shape, { state: 'Maybe' })).toThrow('Accepted');
    expect(() => addReply(doc, 0, shape, { text: '  ' })).toThrow('reply');

    // Only the shape is a comment of its own; the rest is its thread.
    const [entry, ...rest] = listAnnotations(doc, 0);
    expect(rest).toEqual([]);
    expect(entry.state).toBe('Accepted');
    expect(entry.marked).toBe(true);
    expect(entry.states).toEqual([
      expect.objectContaining({
        id: accepted,
        author: 'Grace',
        state: 'Accepted',
      }),
    ]);
    expect(entry.replies).toHaveLength(1);
    expect(entry.replies[0]).toMatchObject({
      id: reply,
      contents: 'Yes',
      author: 'Grace',
    });
    expect(entry.replies[0].replies[0]).toMatchObject({
      contents: 'Thanks',
      author: 'Ada',
    });
    expect(listReplies(doc, 0, shape)).toEqual(entry.replies);

    const bytes = await doc.save();
    const all = await annotationsIn(bytes);
    const shapeAnnotation = all.find((a) => a.subtype === 'Square');
    const replies = all.filter((a) => a.inReplyTo === shapeAnnotation.id);
    expect(replies).toHaveLength(4);
    const answer = replies.find((a) => a.contentsObj.str === 'Yes');
    expect(answer).toMatchObject({ subtype: 'Text', replyType: 'R' });
    expect(answer.annotationFlags & 2).toBe(2);
    const states = replies.filter((a) => a.state);
    expect(states.map((a) => [a.stateModel, a.state])).toEqual([
      ['Review', 'Rejected'],
      ['Review', 'Accepted'],
      ['Marked', 'Marked'],
    ]);
    expect(states[1].contentsObj.str).toBe('Accepted set by Grace');
    expect(all.find((a) => a.contentsObj.str === 'Thanks').inReplyTo).toBe(answer.id);
    // The comments list shows the shape once, not its replies or states.
    const comments = await withPdf(bytes, (pdf) => collectComments(pdf));
    expect(comments.map((c) => [c.kind, c.text])).toEqual([['Rectangle', 'Is this right?']]);
    // Hidden replies leave no mark on the page.
    const view = await render(bytes);
    expect(view.count({ x: 100, y: 100, width: 100, height: 100 }).outside).toBe(0);
  });

  it('deletes a comment with its popup, replies and states', async () => {
    const doc = await blank();
    addNote(doc, 0, { x: 100, y: 700, text: 'Note', author: 'A' });
    const [note] = listAnnotations(doc, 0);
    addReply(doc, 0, note.id, { text: 'Reply' });
    setReviewState(doc, 0, note.id, { state: 'Completed' });
    const line = addShapeAnnotation(doc, 0, {
      kind: 'line',
      points: [
        { x: 10, y: 10 },
        { x: 50, y: 50 },
      ],
    });
    addReply(doc, 0, line, { text: 'About the line' });
    const ink = addInkAnnotation(doc, 0, {
      strokes: [
        [
          { x: 1, y: 1 },
          { x: 9, y: 9 },
        ],
      ],
    });
    expect(subtypesOf(doc)).toEqual(['Text', 'Popup', 'Text', 'Text', 'Line', 'Text', 'Ink']);
    deleteAnnotation(doc, 0, note.id);
    expect(subtypesOf(doc)).toEqual(['Line', 'Text', 'Ink']);
    deleteAnnotation(doc, 0, line);
    expect(subtypesOf(doc)).toEqual(['Ink']);
    expect(listAnnotations(doc, 0).map((a) => a.id)).toEqual([ink]);
  });
});

/** One of every kind of comment, on two pages. */
async function everything() {
  const doc = await blank(2);
  addNote(doc, 0, {
    x: 50,
    y: 750,
    text: 'A note',
    author: 'Ada',
    hex: '#f2c438',
  });
  addHighlight(doc, 0, {
    quads: [rectQuad({ x: 100, y: 700, width: 120, height: 14 })],
    hex: '#ffff00',
    text: 'Highlighted',
  });
  addHighlight(doc, 0, {
    quads: [rectQuad({ x: 100, y: 680, width: 80, height: 14 })],
    hex: '#ff0000',
    kind: 'strikeout',
  });
  await addTextBox(doc, 0, {
    rect: { x: 50, y: 550, width: 200, height: 80 },
    text: 'Text box\nsecond line',
    fill: '#ffffcc',
    author: 'Ada',
  });
  await addCallout(doc, 0, {
    rect: { x: 350, y: 550, width: 150, height: 60 },
    anchor: { x: 300, y: 450 },
    text: 'Callout',
  });
  addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 50, y: 350, width: 100, height: 80 },
    fill: '#00ff00',
    dash: [4, 2],
    text: 'Square',
    author: 'Grace',
  });
  addShapeAnnotation(doc, 0, {
    kind: 'circle',
    rect: { x: 200, y: 350, width: 100, height: 80 },
    width: 2,
  });
  addShapeAnnotation(doc, 0, {
    kind: 'arrow',
    points: [
      { x: 350, y: 350 },
      { x: 500, y: 420 },
    ],
  });
  addShapeAnnotation(doc, 1, {
    kind: 'line',
    points: [
      { x: 50, y: 50 },
      { x: 100, y: 60 },
    ],
  });
  addShapeAnnotation(doc, 1, {
    kind: 'polygon',
    points: [
      { x: 50, y: 200 },
      { x: 150, y: 200 },
      { x: 100, y: 300 },
    ],
    opacity: 0.5,
  });
  addShapeAnnotation(doc, 1, {
    kind: 'polyline',
    points: [
      { x: 250, y: 200 },
      { x: 300, y: 300 },
      { x: 350, y: 200 },
    ],
    lineEndings: ['Circle', 'ClosedArrow'],
  });
  const cloud = addShapeAnnotation(doc, 1, {
    kind: 'cloud',
    points: [
      { x: 50, y: 400 },
      { x: 250, y: 400 },
      { x: 250, y: 500 },
      { x: 50, y: 500 },
    ],
    intensity: 2,
    text: 'Cloud',
  });
  addInkAnnotation(doc, 1, {
    strokes: [
      [
        { x: 400, y: 400 },
        { x: 450, y: 450 },
        { x: 500, y: 400 },
      ],
    ],
    color: '#123456',
  });
  const reply = addReply(doc, 1, cloud, { text: 'Agreed', author: 'Grace' });
  addReply(doc, 1, reply, { text: 'Good', author: 'Ada' });
  setReviewState(doc, 1, cloud, { state: 'Accepted', author: 'Grace' });
  return doc;
}
/** The parts of a comment that must survive an exchange. */
const essence = (a) => ({
  subtype: a.subtype,
  intent: a.intent,
  contents: a.contents,
  author: a.author,
  color: a.color,
  fill: a.fill,
  borderColor: a.borderColor,
  width: a.width,
  dash: a.dash,
  opacity: Math.round(a.opacity * 100) / 100,
  fontSize: a.fontSize,
  points: a.points,
  lineEndings: a.lineEndings,
  cloud: a.cloud,
  box: a.box,
  rect: a.subtype === 'Text' ? a.rect : undefined,
  state: a.state,
  replies: JSON.stringify(
    a.replies.map(function strip(r) {
      return {
        contents: r.contents,
        author: r.author,
        replies: r.replies.map(strip),
      };
    }),
  ),
});

describe('pages with large units', () => {
  // The same comments, in points, on Letter paper and on Letter paper in units of ten points.
  async function placed(unit) {
    const doc = await blank(1, [612 / unit, 792 / unit]);
    doc.getPage(0).node.set(PDFName.of('UserUnit'), PDFNumber.of(unit));
    const at = (x, y) => ({ x: x / unit, y: y / unit });
    addShapeAnnotation(doc, 0, {
      kind: 'arrow',
      points: [at(100, 100), at(300, 100)],
      width: 1 / unit,
    });
    addShapeAnnotation(doc, 0, {
      kind: 'cloud',
      rect: { ...at(100, 200), width: 200 / unit, height: 100 / unit },
      width: 1 / unit,
    });
    await addCallout(doc, 0, {
      rect: { ...at(300, 500), width: 180 / unit, height: 50 / unit },
      anchor: at(150, 400),
      text: 'Here',
      fontSize: 12 / unit,
      borderWidth: 1 / unit,
    });
    addNote(doc, 0, { ...at(100, 700), text: 'Note' });
    return doc;
  }
  it('draws arrowheads, clouds, callouts, and notes at their sizes in points', async () => {
    const [plain, large] = [await placed(1), await placed(10)];
    const rects = (doc, unit) =>
      listAnnotations(doc, 0).map(({ rect }) =>
        [rect.x, rect.y, rect.width, rect.height].map((v) => Math.round(v * unit)),
      );
    expect(rects(large, 10)).toEqual(rects(plain, 1));
    const points = (doc, unit) =>
      listAnnotations(doc, 0)[2].points.map(({ x, y }) => [
        Math.round(x * unit),
        Math.round(y * unit),
      ]);
    expect(points(large, 10)).toEqual(points(plain, 1));
    const [a, b] = [await render(await plain.save()), await render(await large.save())];
    expect(difference(signature(b, 48, 48), signature(a, 48, 48))).toBeLessThan(0.02);
  });
  it('redraws a recolored squiggly underline at its size in points', async () => {
    const views = [],
      rects = [];
    for (const unit of [1, 10]) {
      const doc = await blank(1, [612 / unit, 792 / unit]);
      doc.getPage(0).node.set(PDFName.of('UserUnit'), PDFNumber.of(unit));
      // Another editor's squiggly under a line of 12 point text.
      const quad = [100, 412, 300, 412, 100, 400, 300, 400].map((v) => v / unit);
      const squiggly = doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Squiggly',
          Rect: [100 / unit, 400 / unit, 300 / unit, 412 / unit],
          QuadPoints: quad,
          C: [1, 0, 0],
          F: 4,
        }),
      );
      doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([squiggly]));
      await editAnnotation(doc, 0, listAnnotations(doc, 0)[0].id, { color: '#0000ff' });
      const { rect } = listAnnotations(doc, 0)[0];
      rects.push([rect.x, rect.y, rect.width, rect.height].map((v) => Math.round(v * unit)));
      views.push(await render(await doc.save()));
    }
    expect(rects[1]).toEqual(rects[0]);
    // The same zigzag, to the pixel.
    const [a, b] = views.map((view) => view.inkBox());
    for (const key of ['x0', 'y0', 'x1', 'y1'])
      expect(Math.abs(a[key] - b[key])).toBeLessThanOrEqual(1);
    expect(difference(signature(views[1], 48, 8), signature(views[0], 48, 8))).toBeLessThan(0.1);
  });
});

describe('comment exchange', () => {
  it('round-trips every kind of comment through XFDF', async () => {
    const source = await everything();
    const xfdf = exportXfdf(source);
    expect(xfdf).toMatch(
      /^<\?xml version="1.0" encoding="UTF-8"\?>\n<xfdf xmlns="http:\/\/ns.adobe.com\/xfdf\/"/,
    );
    for (const tag of [
      'text',
      'highlight',
      'strikeout',
      'freetext',
      'square',
      'circle',
      'line',
      'polygon',
      'polyline',
      'ink',
    ])
      expect(xfdf).toContain(`<${tag} `);
    expect(xfdf).toContain('inreplyto=');
    expect(xfdf).toContain('state="Accepted" statemodel="Review"');
    expect(xfdf).toContain('<contents-richtext><body');

    const target = await blank(2);
    const result = await importXfdf(target, xfdf);
    expect(result).toEqual({ imported: 16, skipped: 0, duplicates: 0 });
    for (const index of [0, 1])
      expect(listAnnotations(target, index).map(essence)).toEqual(
        listAnnotations(source, index).map(essence),
      );
    // Importing the same comments again adds nothing.
    expect(await importXfdf(target, xfdf)).toEqual({
      imported: 0,
      skipped: 0,
      duplicates: 16,
    });

    // Both documents look the same and PDF.js reads the same comments from them.
    const [a, b] = [await source.save(), await target.save()];
    for (const page of [1, 2]) {
      const [left, right] = [await annotationsIn(a, page), await annotationsIn(b, page)];
      const summary = (list) =>
        list.map((x) => [
          x.subtype,
          x.contentsObj?.str,
          Array.from(x.color || []).join(),
          !!x.inReplyTo,
        ]);
      expect(summary(right)).toEqual(summary(left));
      const [va, vb] = [await render(a, page), await render(b, page)];
      let differing = 0;
      for (let i = 0; i < va.data.length; i += 4)
        if (Math.abs(va.data[i] - vb.data[i]) + Math.abs(va.data[i + 1] - vb.data[i + 1]) > 60)
          differing++;
      expect(differing).toBeLessThan(va.data.length / 4 / 1000);
    }
  });

  it('imports Acrobat-style XFDF', async () => {
    const doc = await blank();
    const xfdf = `<?xml version="1.0" encoding="UTF-8"?>
<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">
<annots>
<square color="#FF0000" creationdate="D:20260101120000+01'00'" date="D:20260102120000+01'00'" flags="print" name="sq-1" page="0" rect="100,100,200,180" subject="Rectangle" title="Ada" width="2"><contents>Check&#xD;this</contents><popup flags="print,nozoom,norotate" open="no" page="0" rect="200,100,380,220"/></square>
<text color="#FFFF00" date="D:20260103120000Z" flags="print,nozoom,norotate" icon="Comment" inreplyto="sq-1" name="r-1" page="0" rect="100,160,120,180" title="Grace"><contents>Fixed</contents></text>
<text date="D:20260104120000Z" flags="print,nozoom,norotate,hidden" inreplyto="sq-1" name="s-1" page="0" rect="100,160,120,180" state="Completed" statemodel="Review" title="Grace"><contents>Completed set by Grace</contents></text>
<freetext color="#FFFFFF" flags="print" name="ft-1" page="0" rect="300,600,500,650" width="1" justification="1"><contents>Hello</contents><defaultappearance>1 0 0 RG /Helv 16 Tf 0 0 1 rg</defaultappearance><defaultstyle>font: Helvetica,sans-serif 16.0pt; text-align:center; color:#0000FF</defaultstyle></freetext>
<polygon color="#0000FF" flags="print" name="pg-1" page="0" rect="0,0,1,1" style="cloudy" intensity="1" width="1"><vertices>300,100;400,100;350,200</vertices></polygon>
<ink color="#00FF00" flags="print" name="ink-1" page="0" rect="0,0,1,1" width="3"><inklist><gesture>50,400;80,450;110,400</gesture><gesture>120,400;150,450</gesture></inklist></ink>
<stamp color="#D92626" flags="print" icon="SBApproved" name="st-1" page="0" rect="400,300,550,350" title="Ada"/>
<sound page="0" rect="0,0,10,10" name="x"/>
<line page="9" start="1,1" end="2,2" name="far"/>
<text page="0" rect="1,1,2,2" inreplyto="missing" name="orphan"><contents>?</contents></text>
</annots>
</xfdf>`;
    expect(await importXfdf(doc, xfdf)).toEqual({
      imported: 7,
      skipped: 3,
      duplicates: 0,
    });
    const listed = listAnnotations(doc, 0);
    expect(listed.map((a) => a.subtype)).toEqual(['Square', 'FreeText', 'Polygon', 'Ink', 'Stamp']);
    const [square, freetext, polygon, ink] = listed;
    expect(square).toMatchObject({
      contents: 'Check\nthis',
      author: 'Ada',
      color: '#ff0000',
      width: 2,
      state: 'Completed',
    });
    expect(square.replies.map((r) => [r.author, r.contents])).toEqual([['Grace', 'Fixed']]);
    expect(square.modified.toISOString()).toBe('2026-01-02T11:00:00.000Z');
    expect(freetext).toMatchObject({
      color: '#0000ff',
      borderColor: '#ff0000',
      fill: '#ffffff',
      fontSize: 16,
      align: 'center',
    });
    expect(polygon.cloud).toBe(1);
    expect(polygon.rect.width).toBeGreaterThan(100);
    expect(ink.points).toHaveLength(2);
    const bytes = await doc.save();
    expect(await paintedText(bytes)).toEqual(['Hello', 'APPROVED']);
    const view = await render(bytes);
    for (const region of [
      { x: 100, y: 100, width: 100, height: 80 },
      { x: 300, y: 600, width: 200, height: 50 },
      { x: 300, y: 100, width: 100, height: 100 },
      { x: 50, y: 400, width: 100, height: 50 },
      { x: 400, y: 300, width: 150, height: 50 },
    ])
      expect(view.count(region).inside).toBeGreaterThan(100);
    await expect(importXfdf(doc, '<nope')).rejects.toThrow('could not be read');
    await expect(importXfdf(doc, '<!DOCTYPE x><xfdf/>')).rejects.toThrow('could not be read');
  });

  it('writes and reads text alignment by the names XFDF gives it', async () => {
    const source = await blank();
    for (const [align, y] of [
      ['left', 100],
      ['center', 200],
      ['right', 300],
    ])
      await addTextBox(source, 0, {
        rect: { x: 100, y, width: 200, height: 40 },
        text: align,
        align,
      });
    const xfdf = exportXfdf(source);
    for (const name of ['left', 'centered', 'right'])
      expect(xfdf).toContain(`justification="${name}"`);
    const target = await blank();
    await importXfdf(target, xfdf);
    expect(listAnnotations(target, 0).map((a) => a.align)).toEqual(['left', 'center', 'right']);
    // Files written with numbers are read as before.
    const older = await blank();
    await importXfdf(
      older,
      `<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots><freetext page="0" rect="0,0,90,40" name="n" justification="2"><contents>x</contents></freetext></annots></xfdf>`,
    );
    expect(listAnnotations(older, 0)[0].align).toBe('right');
  });

  it('takes the text of comments that carry only rich text', async () => {
    const doc = await blank();
    const body = (paragraphs) =>
      `<contents-richtext><body xmlns="http://www.w3.org/1999/xhtml" xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xfa:APIVersion="Acrobat:23.8.0" xfa:spec="2.0.2">${paragraphs}</body></contents-richtext>`;
    const xfdf = `<?xml version="1.0" encoding="UTF-8"?>
<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">
<annots>
<square color="#FF0000" flags="print" name="sq-1" page="0" rect="100,100,200,180" title="Ada" width="1">${body('<p dir="ltr"><span style="font-size:10.0pt">Check </span><span style="font-weight:bold">this</span></p><p dir="ltr">and that</p>')}</square>
<text flags="print,nozoom,norotate" inreplyto="sq-1" name="r-1" page="0" rect="100,160,120,180" title="Grace">${body('<p>Fixed<br/>now</p>')}</text>
<freetext flags="print" name="ft-1" page="0" rect="300,600,500,650" width="0">${body('\n<p dir="ltr">Hello</p>\n')}<defaultappearance>/Helv 12 Tf 0 g</defaultappearance></freetext>
</annots>
</xfdf>`;
    expect(await importXfdf(doc, xfdf)).toMatchObject({ imported: 3 });
    const [square, freetext] = listAnnotations(doc, 0);
    expect(square.contents).toBe('Check this\nand that');
    expect(square.replies.map((r) => r.contents)).toEqual(['Fixed\nnow']);
    expect(freetext.contents).toBe('Hello');
    expect(await paintedText(await doc.save())).toEqual(['Hello']);
  });

  it('summarizes comments per page with authors, dates, types, status and replies', async () => {
    const doc = await everything();
    const summary = exportCommentSummary(doc);
    expect(summary).toMatch(
      /^Comment summary: 13 comments\n\nPage 1\n1\. Note \| Ada \| \d{4}-\d\d-\d\d \d\d:\d\d UTC\n {3}A note\n/,
    );
    expect(summary).toContain('Text box | Ada |');
    expect(summary).toContain('   Text box\n   second line');
    expect(summary).toContain('\n\nPage 2\n');
    expect(summary).toMatch(
      /Polygon \| Unknown author \| [^\n]+ \| Status: Accepted\n {3}Cloud\n {3}Reply \| Grace \| [^\n]+\n {5}Agreed\n {5}Reply \| Ada \| [^\n]+\n {7}Good/,
    );
    expect(exportCommentSummary(await blank())).toBe('Comment summary: no comments\n');
  });
});

describe('flattening', () => {
  it('draws every new kind of comment into the page', async () => {
    const doc = await everything();
    const before = await doc.save();
    const counts = flattenDocument(doc);
    expect(counts.unflattened).toBeUndefined();
    expect(subtypesOf(doc, 0)).toEqual([]);
    expect(subtypesOf(doc, 1)).toEqual([]);
    const after = await doc.save();
    expect(await annotationsIn(after, 2)).toEqual([]);
    expect(await paintedText(after)).toEqual(
      expect.arrayContaining(['Text box', 'second line', 'Callout']),
    );
    for (const page of [1, 2]) {
      const [a, b] = [await render(before, page), await render(after, page)];
      let differing = 0,
        inked = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        if (a.data[i] < 240 || a.data[i + 1] < 240 || a.data[i + 2] < 240) inked++;
        if (
          Math.abs(a.data[i] - b.data[i]) +
            Math.abs(a.data[i + 1] - b.data[i + 1]) +
            Math.abs(a.data[i + 2] - b.data[i + 2]) >
          60
        )
          differing++;
      }
      expect(inked).toBeGreaterThan(3000);
      // Note icons render the same way flattened, so the pages match nearly pixel for pixel.
      expect(differing).toBeLessThan(inked / 50);
    }
  });
});
