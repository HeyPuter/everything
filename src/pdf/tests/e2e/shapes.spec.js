import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, PDFNumber, decodePDFRawStream, degrees } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { inspectPaths, editPath } from '../../src/core/path-edit.js';
import { point, rotateAroundCenter } from '../../src/core/image-edit.js';
import { drawMark } from '../../src/core/document.js';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async () => ({}) }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
async function mockPuter(page) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK }),
  );
}
async function openPdf(page, doc, name = 'test.pdf') {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(await doc.save()) });
  await expect(page.locator('.page-caption')).toHaveText(`Page 1 of ${doc.getPageCount()}`);
}

test('a dropped shape keeps its preview until the updated PDF is painted', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  drawMark(doc, 0, {
    type: 'shape',
    hex: '#dd2200',
    width: 2,
    rect: { x: 40, y: 220, width: 80, height: 60 },
  });
  await openPdf(page, doc);
  const target = page.getByRole('button', { name: 'Select shape 1', exact: true });
  const box = await target.boundingBox();
  const scale = (await page.locator('.paper').boundingBox()).width / 400;
  await page.mouse.move(box.x + scale, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 41 * scale, box.y + box.height / 2 + 50 * scale, { steps: 5 });
  await expect(page.locator('.image-preview')).toBeVisible();
  await page.evaluate(() => {
    const preview = document.querySelector('.image-preview');
    const controls = document.querySelector('.image-controls');
    const canvas = document.querySelector('.paper > canvas');
    const context = canvas.getContext('2d');
    const drawImage = context.drawImage;
    const state = (window.dropPreview = {
      painted: false,
      gaps: 0,
      frameGaps: 0,
      dimmedCorners: 0,
      cornersLocked: false,
    });
    context.drawImage = function (...args) {
      const result = drawImage.apply(this, args);
      state.painted = true;
      return result;
    };
    const observer = new MutationObserver(() => {
      if (preview.hidden && !state.painted) state.gaps++;
      if (controls.hidden) state.frameGaps++;
      for (const handle of controls.querySelectorAll('.image-resize')) {
        if (Number(getComputedStyle(handle).opacity) < 1) state.dimmedCorners++;
        if (handle.disabled) state.cornersLocked = true;
      }
    });
    observer.observe(preview, { attributes: true, childList: true, subtree: true });
    observer.observe(controls, { attributes: true, childList: true, subtree: true });
    window.stopDropObserver = () => observer.disconnect();
  });
  await page.mouse.up();
  await expect(page.getByLabel('Shape width in points', { exact: true })).toBeEnabled();
  await expect(page.locator('.image-preview')).toBeHidden();
  expect(await page.evaluate(() => window.dropPreview)).toEqual({
    painted: true,
    gaps: 0,
    frameGaps: 0,
    dimmedCorners: 0,
    cornersLocked: true,
  });
  await page.evaluate(() => window.stopDropObserver());
});

for (const tool of ['Shape', 'Draw', 'Highlight'])
  test(`${tool} keeps the released preview until the PDF paint replaces it`, async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    await openPdf(page, doc);
    await page.getByRole('button', { name: tool, exact: true }).click();
    if (tool === 'Highlight') await page.getByLabel('Highlight mode').selectOption('area');
    await page.evaluate(() => {
      const overlay = document.querySelector('.drawing-overlay');
      const painted = () =>
        overlay
          .getContext('2d')
          .getImageData(0, 0, overlay.width, overlay.height)
          .data.some((value, i) => i % 4 === 3 && value !== 0);
      const context = document.querySelector('.paper > canvas').getContext('2d');
      const drawImage = context.drawImage;
      window.drawingHandoff = { previewAtPaint: null };
      context.drawImage = function (...args) {
        window.drawingHandoff.previewAtPaint = painted();
        return drawImage.apply(this, args);
      };
      window.drawingPreviewPainted = painted;
    });
    await drag(page, { x: 80, y: 280 }, { x: 200, y: 220 });
    expect(await page.evaluate(() => window.drawingHandoff.previewAtPaint)).toBe(true);
    expect(await page.evaluate(() => window.drawingPreviewPainted())).toBe(false);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  });

/** Drag on the page from one PDF point to another; the page is 400 pt square. */
async function drag(page, from, to, { shift = false } = {}) {
  const box = await page.locator('.drawing-overlay').boundingBox();
  const scale = box.width / 400;
  const at = (p) => [box.x + p.x * scale, box.y + (400 - p.y) * scale];
  await page.mouse.move(...at(from));
  await page.mouse.down();
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(...at(to), { steps: 6 });
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
}
async function exported(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const doc = await PDFDocument.load(await readFile(await (await pending).path()));
  const content = doc
    .getPage(0)
    .node.Contents()
    .asArray()
    .map((ref) => Buffer.from(decodePDFRawStream(doc.context.lookup(ref)).decode()).toString())
    .join('\n');
  return { doc, content, paths: inspectPaths(doc, 0) };
}
const near = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance;
/** The coordinates of a path outline; a phone's scaled pointer leaves them a hair off. */
const numbers = (svg) => svg.match(/-?\d+(?:\.\d+)?/g).map(Number);
const closeTo = (actual, expected, digits = 0) =>
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, digits));

for (const rotation of [0, 90, 180, 270])
  test(`check marks stay upright on rotated crop ${rotation} after click, drag, and keyboard placement`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create(),
      pdfPage = doc.addPage([400, 400]);
    pdfPage.setRotation(degrees(rotation));
    pdfPage.setCropBox(20, 20, 360, 360);
    pdfPage.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
    await openPdf(page, doc);
    await page.getByRole('button', { name: 'Shape', exact: true }).click();
    await page.getByLabel('Shape type', { exact: true }).selectOption('check');
    await page.getByLabel('Zoom', { exact: true }).selectOption('page');
    await expect(page.locator('.paper')).toHaveAttribute('aria-busy', 'false');
    // WebKit rounds mouse coordinates to CSS pixels before dispatching events.
    const pointerTolerance = 400 / (await page.locator('.drawing-overlay').boundingBox()).width;
    // The drag helper addresses the displayed crop in a 400-by-400 coordinate grid.
    await drag(page, { x: 100, y: 300 }, { x: 100, y: 300 });
    await drag(page, { x: 200, y: 100 }, { x: 260, y: 160 });
    await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    const saved = await exported(page);
    const task = pdfjs.getDocument({ data: await saved.doc.save() });
    try {
      const view = (await (await task.promise).getPage(1)).getViewport({ scale: 1 });
      const size = (14 * 400) / view.width;
      const boxes = [
        [100 - size / 2, 300 - size / 2, size, size],
        [200, 100, 60, 60],
        [100, 140, 200, 68],
      ];
      expect(saved.paths).toHaveLength(3);
      for (const [i, entry] of saved.paths.entries()) {
        const coords = numbers(entry.svg),
          [x, y, w, h] = boxes[i];
        const expected = [
          [0.12, 0.52],
          [0.4, 0.18],
          [0.9, 0.86],
        ];
        for (let j = 0; j < coords.length; j += 2) {
          const pdf = point(entry.ctm, coords[j], coords[j + 1]);
          const screen = view.convertToViewportPoint(...pdf);
          const actual = [(screen[0] * 400) / view.width, 400 - (screen[1] * 400) / view.height];
          [x + w * expected[j / 2][0], y + h * expected[j / 2][1]].forEach((value, axis) =>
            expect(Math.abs(actual[axis] - value)).toBeLessThan(i === 2 ? 1e-5 : pointerTolerance),
          );
        }
      }
    } finally {
      await task.destroy();
    }
  });

test('the shape tool draws rectangles, ellipses, lines, and arrows as editable paths', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Shape', exact: true }).click();
  const type = page.getByLabel('Shape type', { exact: true });
  await expect(type).toHaveValue('rectangle');
  await expect(page.locator('.tool-hint')).toHaveText(
    'Drag to draw a rectangle. Hold Shift for a square.',
  );
  await drag(page, { x: 40, y: 360 }, { x: 140, y: 300 });
  await type.selectOption('ellipse');
  await expect(page.locator('.tool-hint')).toContainText('ellipse');
  await drag(page, { x: 200, y: 360 }, { x: 300, y: 300 });
  await type.selectOption('line');
  await drag(page, { x: 40, y: 200 }, { x: 140, y: 240 });
  await type.selectOption('arrow');
  await drag(page, { x: 200, y: 200 }, { x: 300, y: 240 });
  const { content, paths } = await exported(page);
  expect(paths).toHaveLength(4);
  const [rectangle, ellipse, line, arrow] = paths;
  expect(rectangle).toMatchObject({ kind: 'shape', stroked: true, filled: false });
  closeTo(numbers(rectangle.svg), [0, 0, 0, 60, 100, 60, 100, 0]);
  closeTo(rectangle.ctm.slice(4), [40, 300]);
  expect(ellipse).toMatchObject({ kind: 'shape', stroked: true, filled: false });
  expect(ellipse.svg).toContain('C');
  // The outline reaches the dragged box, plus half the stroke.
  closeTo(
    [ellipse.bounds[0], ellipse.bounds[2], ellipse.bounds[1], ellipse.bounds[3]],
    [199, 301, 299, 361],
  );
  expect(line).toMatchObject({ kind: 'drawing', stroked: true, filled: false });
  closeTo(numbers(line.svg), [40, 200, 140, 240]);
  expect(content).toMatch(/l\s+S/);
  // The arrow is one path: a stroked shaft and a filled, stroked head ending at the tip.
  expect(arrow).toMatchObject({ kind: 'shape', stroked: true, filled: true });
  const arrowPoints = numbers(arrow.svg);
  closeTo(arrowPoints.slice(0, 2), [200, 200]);
  closeTo(arrowPoints.slice(4, 6), [300, 240]);
  expect(arrow.svg).toContain('Z');
  expect(content).toMatch(/h\s+B/);
  // In Select, the arrow offers fill and stroke controls like any shape.
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: 'Select shape 3', exact: true }).click();
  await expect(page.getByLabel('Shape fill enabled', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Shape stroke enabled', { exact: true })).toBeChecked();
});

test('Shift keeps rectangles square, ellipses round, and snaps lines to 45 degrees', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Shape', exact: true }).click();
  await drag(page, { x: 40, y: 360 }, { x: 140, y: 300 }, { shift: true });
  await page.getByLabel('Shape type', { exact: true }).selectOption('arrow');
  await drag(page, { x: 200, y: 200 }, { x: 300, y: 230 }, { shift: true });
  const { paths } = await exported(page);
  const [square, arrow] = paths;
  // 100 by 60 became 60 by 60, anchored at the start corner.
  closeTo(numbers(square.svg), [0, 0, 0, 60, 60, 60, 60, 0]);
  closeTo(square.ctm.slice(4), [40, 300]);
  // A 17 degree drag snapped to level, keeping its length: the tip sits at the start height.
  const length = Math.hypot(100, 30);
  const tip = arrow.svg.match(/M [\d.]+ [\d.]+ L [\d.]+ [\d.]+ M ([\d.]+) ([\d.]+)/);
  expect(near(Number(tip[1]), 200 + length)).toBe(true);
  expect(near(Number(tip[2]), 200)).toBe(true);
});

test('placing a shape from the keyboard uses the chosen type', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Shape', exact: true }).click();
  await page.getByLabel('Shape type', { exact: true }).selectOption('ellipse');
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  const { paths } = await exported(page);
  expect(paths).toHaveLength(1);
  expect(paths[0].svg).toContain('C');
  expect(paths[0].kind).toBe('shape');
});

test('check marks and crosses are placed with a click or sized with a drag', async ({
  page,
  isMobile,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Shape', exact: true }).click();
  const type = page.getByLabel('Shape type', { exact: true });
  await type.selectOption('check');
  await expect(page.locator('.tool-hint')).toHaveText(
    `${isMobile ? 'Tap' : 'Click'} to place a check mark, or drag to size it. Hold Shift for a square box.`,
  );
  // A click, not a drag: the mark takes its fixed size around the point.
  await drag(page, { x: 100, y: 300 }, { x: 100, y: 300 });
  await type.selectOption('cross');
  await drag(page, { x: 200, y: 100 }, { x: 260, y: 160 });
  const { paths } = await exported(page);
  expect(paths).toHaveLength(2);
  const [check, cross] = paths;
  expect(check).toMatchObject({ kind: 'drawing', stroked: true, filled: false });
  const checkPoints = numbers(check.svg);
  expect(checkPoints).toHaveLength(6);
  // 14 points across, centered on the click.
  closeTo(checkPoints.slice(0, 2), [100 - 7 + 14 * 0.12, 300 - 7 + 14 * 0.52], 0);
  closeTo(checkPoints.slice(4, 6), [100 - 7 + 14 * 0.9, 300 - 7 + 14 * 0.86], 0);
  expect(cross).toMatchObject({ stroked: true, filled: false });
  const crossPoints = numbers(cross.svg);
  expect(crossPoints).toHaveLength(8);
  closeTo(crossPoints.slice(0, 4), [209, 151, 251, 109]);
  closeTo(crossPoints.slice(4, 8), [209, 109, 251, 151]);
});

for (const rotation of [0, 45])
  test(`thin drawing outlines allow a nearby pointer hit at ${rotation} degrees`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    drawMark(doc, 0, {
      type: 'shape',
      shape: 'line',
      from: { x: 100, y: 220 },
      to: { x: 250, y: 220 },
      width: 0.25,
      hex: '#000000',
    });
    if (rotation) {
      const entry = inspectPaths(doc, 0)[0];
      editPath(doc, 0, entry, { transform: rotateAroundCenter(entry.transform, rotation) });
    }
    await openPdf(page, doc);
    const target = page.getByRole('button', { name: 'Select drawing 1', exact: true });
    const box = await target.boundingBox();
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    await page.mouse.click(x + (rotation ? 2 : 0), y + (rotation ? 2 : 3));
    await expect(target).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('group', { name: 'Edit drawing', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });

for (const [zoom, userUnit] of [
  [0.5, 1],
  [2, 1],
  [0.5, 2],
])
  test(`arrow preview matches the PDF at zoom ${zoom} and UserUnit ${userUnit}`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create(),
      pdfPage = doc.addPage([400, 400]);
    pdfPage.node.set(PDFName.of('UserUnit'), PDFNumber.of(userUnit));
    await openPdf(page, doc);
    await page.getByRole('button', { name: 'Shape', exact: true }).click();
    await page.getByLabel('Shape type', { exact: true }).selectOption('arrow');
    await page.getByLabel('Stroke width', { exact: true }).selectOption('1');
    await page.getByLabel('Zoom', { exact: true }).selectOption(String(zoom));
    await expect(page.locator('.paper')).toHaveAttribute('aria-busy', 'false');
    await page.locator('.workspace').evaluate((node) => node.scrollTo(0, 0));
    const box = await page.locator('.drawing-overlay').boundingBox();
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.25);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.25, { steps: 5 });
    const paintedHeight = (canvas, overlay) => {
      const { width, height } = canvas,
        data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
      let top = height,
        bottom = -1;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          // Compare the solid mark rather than renderer-specific antialias fringes.
          if (overlay ? data[i + 3] > 127 : data[i] < 136) {
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      return ((bottom - top + 1) * canvas.getBoundingClientRect().height) / height;
    };
    const preview = await page.locator('.drawing-overlay').evaluate(paintedHeight, true);
    await page.mouse.up();
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
    const committed = await page.locator('.paper > canvas').first().evaluate(paintedHeight, false);
    expect(preview).toBeGreaterThan(0);
    expect(committed).toBeGreaterThan(0);
    expect(Math.abs(preview - committed)).toBeLessThanOrEqual(1.5);
  });

for (const [sx, sy] of [
  [1, 4],
  [4, 1],
])
  test(`stretched ${sx} by ${sy} shape strokes match their visible pointer target`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    const doc = await PDFDocument.create();
    doc
      .addPage([400, 400])
      .node.set(
        PDFName.of('Contents'),
        doc.context.register(
          doc.context.flateStream(`q ${sx} 0 0 ${sy} 0 0 cm 0 G 6 w 40 40 40 40 re S Q`),
        ),
      );
    await openPdf(page, doc);
    await page.getByLabel('Zoom', { exact: true }).selectOption('page');
    await expect(page.locator('.paper')).toHaveAttribute('aria-busy', 'false');
    const target = page.getByRole('button', { name: 'Select shape 1', exact: true });
    const box = await page.locator('.paper').boundingBox();
    const at = ([x, y]) => [box.x + (x * box.width) / 400, box.y + ((400 - y) * box.height) / 400];
    // A narrow side must not steal the empty interior; a stretched side must
    // remain selectable all the way across its visibly painted stroke.
    await page.mouse.click(...at(sx === 4 ? [240, 72] : [48, 240]));
    await expect(target).toHaveAttribute('aria-pressed', 'false');
    const painted = sx === 4 ? [152, 60] : [60, 328];
    expect(
      await page
        .locator('.paper > canvas')
        .first()
        .evaluate(
          (canvas, [x, y]) =>
            canvas
              .getContext('2d')
              .getImageData(
                Math.floor((x * canvas.width) / 400),
                Math.floor(((400 - y) * canvas.height) / 400),
                1,
                1,
              ).data[0],
          painted,
        ),
    ).toBeLessThan(64);
    await page.mouse.click(...at(painted));
    await expect(target).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('group', { name: 'Edit shape', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });
