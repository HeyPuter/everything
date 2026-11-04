import { test, expect } from '@playwright/test';
import { PDFDocument, degrees } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { inspectPaths } from '../../src/core/path-edit.js';
import { inspectImages, imageCorners } from '../../src/core/image-edit.js';
import { createCanvas } from '@napi-rs/canvas';

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
async function squarePdf(rotation = 0) {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]).setRotation(degrees(rotation));
  return doc;
}
async function draw(page, strokes) {
  const pad = page.locator('.signature-pad');
  const box = await pad.boundingBox();
  for (const stroke of strokes) {
    await page.mouse.move(box.x + stroke[0][0], box.y + stroke[0][1]);
    await page.mouse.down();
    for (const [x, y] of stroke.slice(1)) await page.mouse.move(box.x + x, box.y + y, { steps: 3 });
    await page.mouse.up();
  }
}
async function exported(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  return PDFDocument.load(await readFile(await (await pending).path()));
}
/** A 2:1 picture with a stroke, as a real PNG the browser can decode. */
function signaturePng() {
  const canvas = createCanvas(200, 100),
    ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#123';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(10, 80);
  ctx.bezierCurveTo(60, 0, 140, 100, 190, 20);
  ctx.stroke();
  return canvas.toBuffer('image/png');
}
const canvasInkBounds = (canvas, size) =>
  canvas.evaluate((node, size) => {
    const pixels = node.getContext('2d').getImageData(0, 0, node.width, node.height).data;
    let left = node.width,
      top = node.height,
      right = -1,
      bottom = -1;
    for (let y = 0; y < node.height; y++)
      for (let x = 0; x < node.width; x++) {
        const at = (y * node.width + x) * 4;
        if (pixels[at + 3] < 128 || Math.min(pixels[at], pixels[at + 1], pixels[at + 2]) > 200)
          continue;
        left = Math.min(left, x);
        right = Math.max(right, x + 1);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y + 1);
      }
    const width = size?.width || node.clientWidth,
      height = size?.height || node.clientHeight;
    return [
      (left / node.width) * width,
      (top / node.height) * height,
      (right / node.width) * width,
      (bottom / node.height) * height,
    ];
  }, size);

const stored = (page) => page.evaluate(() => localStorage.getItem('pdf-editor:signatures'));

test('malformed saved drawings are ignored while valid signatures remain usable', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const valid = [
    {
      type: 'draw',
      strokes: [
        [],
        [
          [20, 40],
          [90, 60],
        ],
      ],
    },
    { type: 'type', text: 'Ada Lovelace' },
  ];
  const invalid = [
    null,
    {},
    ...[
      null,
      {},
      [],
      [null],
      [[]],
      [[null]],
      [[[20]]],
      [[['20', 30]]],
      [[[20, null]]],
      [[[20, 30, 40]]],
    ].map((strokes) => ({ type: 'draw', strokes })),
  ];
  await page.addInitScript(
    (items) => localStorage.setItem('pdf-editor:signatures', JSON.stringify({ items })),
    [...invalid, ...valid],
  );
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await squarePdf());
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  // Saved thumbnails paint in the next animation frame.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  expect.soft(errors).toEqual([]);
  await expect(dialog.getByRole('button', { name: /^Use saved signature/ })).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Use saved signature 1', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Edit signature' })).toBeVisible();
  expect(inspectPaths(await exported(page), 0)).toHaveLength(1);
  expect(JSON.parse(await stored(page))).toEqual({ items: valid });
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await dialog.getByRole('button', { name: 'Use saved signature 2: Ada Lovelace' }).click();
  await expect(page.getByRole('group', { name: 'Edit signature' })).toBeVisible();
  expect(inspectPaths(await exported(page), 0)).toHaveLength(2);
  expect(errors).toEqual([]);
});

test('drawing ink follows the pointer and earlier strokes stay where they were drawn', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  const pad = dialog.locator('.signature-pad');
  const box = await pad.boundingBox();
  const inkBounds = () =>
    pad.evaluate((canvas) => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let left = Infinity,
        top = Infinity,
        right = -Infinity,
        bottom = -Infinity;
      for (let y = 0; y < canvas.height; y++)
        for (let x = 0; x < canvas.width; x++) {
          if (pixels[(y * canvas.width + x) * 4 + 3] < 128) continue;
          left = Math.min(left, x);
          right = Math.max(right, x + 1);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y + 1);
        }
      const sx = canvas.clientWidth / canvas.width,
        sy = canvas.clientHeight / canvas.height;
      return [left * sx, top * sy, right * sx, bottom * sy];
    });
  const near = async (expected) => {
    const actual = await inkBounds();
    // Include the 1.5 px pen radius plus pointer rounding and pixel coverage at its edge.
    actual.forEach((value, i) => expect(Math.abs(value - expected[i])).toBeLessThanOrEqual(3));
  };
  await page.mouse.move(box.x + 30, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 31, box.y + 40);
  await near([30, 40, 31, 40]);
  await page.mouse.move(box.x + 80, box.y + 40, { steps: 6 });
  await near([30, 40, 80, 40]);
  await page.mouse.up();
  await page.mouse.move(box.x + 110, box.y + 90);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 90, { steps: 6 });
  await page.mouse.up();
  await near([30, 40, 150, 90]);
  await dialog.getByLabel('Signature color').fill('#2255aa');
  await near([30, 40, 150, 90]);
  await dialog.getByRole('tab', { name: 'Type', exact: true }).click();
  await dialog.getByRole('tab', { name: 'Draw', exact: true }).click();
  await near([30, 40, 150, 90]);
  await dialog.getByRole('button', { name: 'Clear', exact: true }).click();
  expect(
    await pad.evaluate((canvas) =>
      canvas
        .getContext('2d')
        .getImageData(0, 0, canvas.width, canvas.height)
        .data.some((value) => value !== 0),
    ),
  ).toBe(false);
});

for (const pointer of ['mouse', 'touch']) {
  test(`a signature keeps the final ${pointer} release position`, async ({ page, browserName }) => {
    test.skip(
      browserName !== 'chromium',
      'Native release coordinates use Chromium’s input protocol.',
    );
    await mockPuter(page);
    await page.goto('/');
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add signature' });
    const pad = dialog.locator('.signature-pad');
    const box = await pad.boundingBox();
    await pad.evaluate((node) =>
      node.addEventListener(
        'pointerup',
        (e) => {
          window.signatureRelease = [
            e.clientX - node.getBoundingClientRect().left,
            e.clientY - node.getBoundingClientRect().top,
          ];
        },
        { once: true },
      ),
    );
    const cdp = await page.context().newCDPSession(page);
    if (pointer === 'mouse') {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: box.x + 20,
        y: box.y + 40,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: box.x + 150,
        y: box.y + 40,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
    } else {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ id: 1, x: box.x + 20, y: box.y + 40 }],
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [{ id: 1, x: box.x + 150, y: box.y + 40 }],
      });
    }
    const released = await page.evaluate(() => window.signatureRelease);
    expect(released[0]).toBeCloseTo(150, 0);
    expect(released[1]).toBeCloseTo(40, 0);
    const bounds = await canvasInkBounds(pad);
    expect(bounds[2]).toBeGreaterThanOrEqual(148);
    expect(bounds[3]).toBeLessThanOrEqual(43);
    await dialog.getByLabel('Remember drawn and typed signatures').check();
    await dialog.getByRole('button', { name: 'Place signature', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Edit signature' })).toBeVisible();
    const signature = JSON.parse(await stored(page)).items[0];
    expect(signature.strokes).toHaveLength(1);
    expect(signature.strokes[0].at(-1)[0]).toBeCloseTo(150, 0);
    const [path] = inspectPaths(await exported(page), 0);
    expect(path.bounds[2] - path.bounds[0]).toBeGreaterThan(100);
  });
}

for (const secondaryAction of ['moves', 'lifts']) {
  test(`a second finger that ${secondaryAction} cannot change the active signature stroke`, async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'Native multi-touch uses Chromium’s input protocol.');
    await mockPuter(page);
    await page.goto('/');
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add signature' });
    const pad = dialog.locator('.signature-pad');
    const box = await pad.boundingBox();
    const first = { id: 1, x: box.x + 20, y: box.y + 40 };
    const second = { id: 2, x: box.x + 100, y: box.y + 100 };
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, touchPoints) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    await touch('touchStart', [first]);
    first.x = box.x + 60;
    await touch('touchMove', [first]);
    await touch('touchStart', [first, second]);
    if (secondaryAction === 'moves') {
      second.x += 30;
      second.y += 10;
      await touch('touchMove', [first, second]);
    } else await touch('touchEnd', [second]);
    first.x = box.x + 150;
    await touch('touchMove', secondaryAction === 'moves' ? [first, second] : [first]);
    await touch('touchEnd', []);
    const bounds = await canvasInkBounds(pad);
    expect(bounds[2]).toBeGreaterThanOrEqual(148);
    expect(bounds[3]).toBeLessThanOrEqual(43);
    // The primary release ends this stroke; the next contact starts a separate one.
    first.x = box.x + 180;
    first.y = box.y + 60;
    await touch('touchStart', [first]);
    first.x += 30;
    await touch('touchMove', [first]);
    await touch('touchEnd', []);
    await dialog.getByLabel('Remember drawn and typed signatures').check();
    await dialog.getByRole('button', { name: 'Place signature', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Edit signature' })).toBeVisible();
    const signature = JSON.parse(await stored(page)).items[0];
    expect(signature.strokes).toHaveLength(2);
    for (const [, y] of signature.strokes[0]) expect(Math.abs(y - 40)).toBeLessThan(2);
    expect(Math.max(...signature.strokes[0].map(([x]) => x))).toBeGreaterThanOrEqual(149);
    const [path] = inspectPaths(await exported(page), 0);
    expect((path.svg.match(/M /g) || []).length).toBe(2);
  });
}

test('resizing the signature pad preserves ink proportions and keeps new strokes under the pointer', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockPuter(page);
  await page.setViewportSize({ width: 800, height: 800 });
  await page.goto('/#library');
  await openPdf(page, await squarePdf());
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  const pad = dialog.locator('.signature-pad');
  const original = await pad.boundingBox();
  const x = original.width - 130;
  await draw(page, [
    [
      [x, 50],
      [x + 100, 50],
      [x + 100, 130],
      [x, 130],
    ],
  ]);
  const aspect = (box) => (box[2] - box[0]) / (box[3] - box[1]);
  const before = await canvasInkBounds(pad);
  const resize = async (width) => {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  };
  await resize(320);
  const narrow = await canvasInkBounds(pad);
  expect.soft(Math.abs(aspect(narrow) / aspect(before) - 1)).toBeLessThan(0.05);
  await dialog.getByLabel('Signature color').fill('#2255aa');
  const recolored = await canvasInkBounds(pad);
  expect.soft(recolored[2] - recolored[0]).toBeGreaterThan(10);
  for (let i = 0; i < 4; i++)
    expect.soft(Math.abs(recolored[i] - narrow[i])).toBeLessThanOrEqual(1);
  await resize(800);
  const restored = await canvasInkBounds(pad);
  for (let i = 0; i < 4; i++) expect.soft(Math.abs(restored[i] - before[i])).toBeLessThanOrEqual(1);
  await resize(320);
  // Draw in the extra space below the uniformly scaled original signature.
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 170);
  await page.mouse.down();
  const alpha = await pad.evaluate(
    (node) =>
      node
        .getContext('2d')
        .getImageData(
          (30 * node.width) / node.clientWidth,
          (170 * node.height) / node.clientHeight,
          1,
          1,
        ).data[3],
  );
  // A scaled round pen centered on the pixel boundary covers only part of this pixel.
  expect(alpha).toBeGreaterThan(64);
  await page.mouse.move(box.x + 90, box.y + 170, { steps: 3 });
  await page.mouse.up();
  const combined = await canvasInkBounds(pad);
  await resize(800);
  const wide = await canvasInkBounds(pad);
  expect(Math.abs(aspect(wide) / aspect(combined) - 1)).toBeLessThan(0.05);
  expect(wide[0]).toBeGreaterThanOrEqual(0);
  expect(wide[1]).toBeGreaterThanOrEqual(0);
  expect(wide[2]).toBeLessThanOrEqual(original.width);
  expect(wide[3]).toBeLessThanOrEqual(original.height);
  await dialog.getByRole('button', { name: 'Place signature', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Edit signature' })).toBeVisible();
  const pdfInk = await canvasInkBounds(page.locator('.paper > canvas').first(), {
    width: 400,
    height: 400,
  });
  expect(Math.abs(aspect(pdfInk) / aspect(combined) - 1)).toBeLessThan(0.05);
  const [path] = inspectPaths(await exported(page), 0);
  expect((path.svg.match(/M /g) || []).length).toBe(2);
  expect(errors).toEqual([]);
});

test('clearing a resized signature pad restores a fresh drawing at the pointer', async ({
  page,
}) => {
  await mockPuter(page);
  await page.setViewportSize({ width: 800, height: 800 });
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  await draw(page, [
    [
      [40, 40],
      [90, 40],
    ],
  ]);
  await page.setViewportSize({ width: 320, height: 800 });
  await dialog.getByRole('button', { name: 'Clear', exact: true }).click();
  await draw(page, [
    [
      [30, 40],
      [80, 40],
    ],
  ]);
  const bounds = await canvasInkBounds(dialog.locator('.signature-pad'));
  for (const [i, expected] of [28.5, 38.5, 81.5, 41.5].entries())
    expect(Math.abs(bounds[i] - expected)).toBeLessThanOrEqual(1);
});

test('resizing preserves saved signature preview proportions', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'pdf-editor:signatures',
      JSON.stringify({
        items: [
          {
            type: 'draw',
            strokes: [
              [
                [0, 0],
                [100, 0],
                [100, 50],
                [0, 50],
              ],
            ],
          },
        ],
      }),
    ),
  );
  await mockPuter(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const canvas = page
    .getByRole('button', { name: 'Use saved signature 1', exact: true })
    .locator('canvas');
  await expect.poll(async () => (await canvasInkBounds(canvas))[2]).toBeGreaterThan(0);
  const before = await canvasInkBounds(canvas);
  await page.setViewportSize({ width: 480, height: 800 });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const after = await canvasInkBounds(canvas);
  const aspect = (box) => (box[2] - box[0]) / (box[3] - box[1]);
  expect(Math.abs(aspect(after) / aspect(before) - 1)).toBeLessThan(0.05);
});

for (const source of ['Type', 'Upload'])
  test(`resizing preserves the ${source.toLowerCase()} signature preview proportions`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.setViewportSize({ width: 800, height: 800 });
    await page.goto('/');
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add signature' });
    await dialog.getByRole('tab', { name: source, exact: true }).click();
    if (source === 'Type') {
      await dialog.getByLabel('Signature text').fill('Jane');
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...document.fonts].some(
              (font) => font.family.includes('Great Vibes') && font.status === 'loaded',
            ),
          ),
        )
        .toBe(true);
    } else {
      await dialog.getByLabel('Signature image file').setInputFiles({
        name: 'signature.png',
        mimeType: 'image/png',
        buffer: signaturePng(),
      });
    }
    const canvas = dialog.getByLabel(
      source === 'Type' ? 'Typed signature preview' : 'Uploaded signature preview',
    );
    await expect(canvas).toBeVisible();
    await expect.poll(async () => (await canvasInkBounds(canvas))[2]).toBeGreaterThan(0);
    const before = await canvasInkBounds(canvas);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const after = await canvasInkBounds(canvas);
    const aspect = (box) => (box[2] - box[0]) / (box[3] - box[1]);
    expect(Math.abs(aspect(after) / aspect(before) - 1)).toBeLessThan(0.05);
  });

test('smoothed signature turns fit inside the PDF placement and saved preview', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await squarePdf());
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  const pad = await dialog.locator('.signature-pad').boundingBox();
  await page.mouse.move(pad.x + 40, pad.y + 40);
  await page.mouse.down();
  for (const [x, y] of [
    [140, 40],
    [140, 140],
    [40, 140],
  ])
    await page.mouse.move(pad.x + x, pad.y + y);
  await page.mouse.up();
  await dialog.getByRole('button', { name: 'Place signature', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Edit signature' })).toBeVisible();

  const pdfInk = await canvasInkBounds(page.locator('.paper > canvas').first(), {
    width: 400,
    height: 400,
  });
  // A signature on this page is centered in a 140 by 56 pt box.
  expect(pdfInk[0]).toBeGreaterThanOrEqual(129);
  expect(pdfInk[1]).toBeGreaterThanOrEqual(171);
  expect(pdfInk[2]).toBeLessThanOrEqual(271);
  expect(pdfInk[3]).toBeLessThanOrEqual(229);
  expect(inspectPaths(await exported(page), 0)).toHaveLength(1);
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const thumbnail = dialog
    .getByRole('button', { name: 'Use saved signature 1', exact: true })
    .locator('canvas');
  await expect.poll(async () => (await canvasInkBounds(thumbnail))[2]).toBeGreaterThan(0);
  const thumbInk = await canvasInkBounds(thumbnail);
  const { width, height } = await thumbnail.boundingBox();
  expect(thumbInk[0]).toBeGreaterThanOrEqual(3);
  expect(thumbInk[1]).toBeGreaterThanOrEqual(3);
  expect(thumbInk[2]).toBeLessThanOrEqual(width - 3);
  expect(thumbInk[3]).toBeLessThanOrEqual(height - 3);
});

test('a signature dot is visible while drawing, in saved previews, and in the PDF', async ({
  page,
  isMobile,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await squarePdf());
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  const pad = dialog.locator('.signature-pad');
  const box = await pad.boundingBox();
  if (isMobile) await page.touchscreen.tap(box.x + 30, box.y + 40);
  else await page.mouse.click(box.x + 30, box.y + 40);
  const dot = await pad.evaluate((canvas) => {
    const ratio = canvas.width / canvas.clientWidth;
    return Array.from(canvas.getContext('2d').getImageData(30 * ratio, 40 * ratio, 1, 1).data);
  });
  expect.soft(dot[3]).toBeGreaterThan(128);
  await dialog.getByRole('button', { name: 'Place signature', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Edit signature' })).toBeVisible();
  const pdfDot = await page
    .locator('.paper > canvas')
    .first()
    .evaluate((canvas) =>
      Array.from(
        canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data,
      ),
    );
  expect.soft(pdfDot.slice(0, 3).every((value) => value < 100)).toBe(true);
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const thumbnail = dialog
    .getByRole('button', { name: 'Use saved signature 1', exact: true })
    .locator('canvas');
  await expect(thumbnail).toBeVisible();
  await expect
    .poll(() =>
      thumbnail.evaluate((canvas) => {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        return pixels.some((value, i) => i % 4 === 3 && value > 128);
      }),
    )
    .toBe(true);
});

test('a drawn signature lands in the middle as one smooth stroke, selected and ready to move', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await squarePdf());
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  await expect(dialog.getByRole('tab', { name: 'Draw' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByText('Draw your signature here')).toBeVisible();
  await draw(page, [
    [
      [40, 120],
      [90, 40],
      [140, 120],
      [190, 40],
    ],
    [
      [220, 90],
      [300, 90],
    ],
  ]);
  await expect(dialog.getByText('Draw your signature here')).toBeHidden();
  await dialog.getByRole('button', { name: 'Place signature' }).click();
  await expect(page.locator('#toast')).toHaveText('Signature added. Drag to move or resize it.');
  // A placed signature is named one, not a drawing.
  await expect(page.getByRole('group', { name: 'Edit signature' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move selected signature' })).toBeFocused();
  await expect(page.locator('.properties-heading h2')).toHaveText('Signature');
  await expect(page.getByRole('button', { name: 'Delete signature' })).toBeVisible();
  const [path] = inspectPaths(await exported(page), 0);
  expect(path).toMatchObject({ kind: 'signature', stroked: true, filled: false });
  expect((path.svg.match(/M /g) || []).length).toBe(2);
  expect(path.svg).toContain('C');
  // About a third of the page across, centered.
  expect(path.bounds[2] - path.bounds[0]).toBeGreaterThan(130);
  expect(path.bounds[2] - path.bounds[0]).toBeLessThanOrEqual(140);
  expect((path.bounds[0] + path.bounds[2]) / 2).toBeCloseTo(200, 0);
  expect((path.bounds[1] + path.bounds[3]) / 2).toBeCloseTo(200, 0);
  // The signature is kept for this session, but not on the device unless asked.
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Use saved signature 1' })).toBeVisible();
  await expect(dialog.getByLabel('Remember drawn and typed signatures')).not.toBeChecked();
  expect(await stored(page)).toBeNull();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

for (const name of ['John J', 'josephine johnson', 'Jacqueline Johnson J'])
  test(`typed and saved signature previews contain the whole lettering of ${name}`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const fillText = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
        if (this.canvas.matches('.signature-preview, .signature-thumb')) {
          // Measure the browser's complete ink before canvas clipping hides any overhang.
          const m = this.measureText(text),
            t = this.getTransform();
          const points = [
            [x - m.actualBoundingBoxLeft, y - m.actualBoundingBoxAscent],
            [x + m.actualBoundingBoxRight, y - m.actualBoundingBoxAscent],
            [x - m.actualBoundingBoxLeft, y + m.actualBoundingBoxDescent],
            [x + m.actualBoundingBoxRight, y + m.actualBoundingBoxDescent],
          ].map(([px, py]) => [t.a * px + t.c * py + t.e, t.b * px + t.d * py + t.f]);
          const sx = this.canvas.clientWidth / this.canvas.width,
            sy = this.canvas.clientHeight / this.canvas.height;
          this.canvas.dataset.fullInk = JSON.stringify({
            text,
            bounds: [
              Math.min(...points.map(([px]) => px)) * sx,
              Math.min(...points.map(([, py]) => py)) * sy,
              Math.max(...points.map(([px]) => px)) * sx,
              Math.max(...points.map(([, py]) => py)) * sy,
            ],
          });
        }
        return fillText.call(this, text, x, y, ...rest);
      };
    });
    await mockPuter(page);
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/');
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add signature' });
    await dialog.getByRole('tab', { name: 'Type', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.fonts].some(
            (font) => font.family.includes('Great Vibes') && font.status === 'loaded',
          ),
        ),
      )
      .toBe(true);
    await dialog.getByLabel('Signature text').fill(name);
    const check = async (canvas, padding) => {
      await expect
        .poll(() => canvas.evaluate((node) => JSON.parse(node.dataset.fullInk || '{}').text))
        .toBe(name);
      const { bounds, width, height } = await canvas.evaluate((node) => ({
        ...JSON.parse(node.dataset.fullInk),
        width: node.clientWidth,
        height: node.clientHeight,
      }));
      expect.soft(bounds[0]).toBeGreaterThanOrEqual(padding - 1);
      expect.soft(bounds[1]).toBeGreaterThanOrEqual(padding - 1);
      expect.soft(bounds[2]).toBeLessThanOrEqual(width - padding + 1);
      expect.soft(bounds[3]).toBeLessThanOrEqual(height - padding + 1);
      const visible = await canvasInkBounds(canvas);
      for (let i = 0; i < 4; i++)
        expect.soft(Math.abs(visible[i] - bounds[i])).toBeLessThanOrEqual(2);
    };
    await check(dialog.getByLabel('Typed signature preview'), 6);
    await dialog.getByRole('button', { name: 'Place signature', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Edit signature' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    await check(
      dialog.getByRole('button', { name: `Use saved signature 1: ${name}` }).locator('canvas'),
      4,
    );
  });

test('remembered typed signatures retain their script preview after reopening the app', async ({
  page,
}, testInfo) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'pdf-editor:signatures',
      JSON.stringify({
        items: [{ type: 'type', text: 'Ada Lovelace' }],
      }),
    ),
  );
  await mockPuter(page);
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  const thumbnail = dialog
    .getByRole('button', { name: 'Use saved signature 1: Ada Lovelace' })
    .locator('canvas');
  // Establish the preview with the font loaded through the Type tab.
  await dialog.getByRole('tab', { name: 'Type', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.fonts].some(
          (font) => font.family.includes('Great Vibes') && font.status === 'loaded',
        ),
      ),
    )
    .toBe(true);
  await dialog.getByRole('tab', { name: 'Draw', exact: true }).click();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const ready = await thumbnail.evaluate((canvas) => canvas.toDataURL());
  await page.reload();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(dialog.getByRole('tab', { name: 'Draw', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(thumbnail).toBeVisible();
  try {
    await expect
      .poll(async () => (await thumbnail.evaluate((canvas) => canvas.toDataURL())) === ready)
      .toBe(true);
  } finally {
    for (const [name, png] of [
      ['loaded-font-preview', ready],
      ['reopened-preview', await thumbnail.evaluate((canvas) => canvas.toDataURL())],
    ])
      await testInfo.attach(name, {
        body: Buffer.from(png.split(',')[1], 'base64'),
        contentType: 'image/png',
      });
  }
});

test('a delayed saved signature font repaints the current list after deletion and reopening', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() =>
    localStorage.setItem(
      'pdf-editor:signatures',
      JSON.stringify({
        items: [
          { type: 'type', text: 'Ada Lovelace' },
          { type: 'type', text: 'Grace Hopper' },
        ],
      }),
    ),
  );
  let release,
    requests = 0;
  const ready = new Promise((resolve) => (release = resolve));
  const isFont = (request) =>
    request.resourceType() === 'font' && request.url().endsWith('/GreatVibes-Regular.ttf');
  await page.route('**/fonts/GreatVibes-Regular.ttf', async (route) => {
    if (isFont(route.request())) {
      requests++;
      await ready;
    }
    await route.continue();
  });
  await mockPuter(page);
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  const requested = page.waitForRequest(isFont);
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await requested;
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  await dialog.getByRole('button', { name: 'Delete saved signature 1', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const thumbnail = dialog
    .getByRole('button', { name: 'Use saved signature 1: Grace Hopper' })
    .locator('canvas');
  await expect.poll(async () => (await canvasInkBounds(thumbnail))[2]).toBeGreaterThan(0);
  const before = await thumbnail.evaluate((canvas) => canvas.toDataURL());
  release();
  await expect
    .poll(async () => (await thumbnail.evaluate((canvas) => canvas.toDataURL())) !== before)
    .toBe(true);
  await expect(dialog.getByRole('button', { name: /^Use saved signature/ })).toHaveCount(1);
  expect(JSON.parse(await stored(page))).toEqual({
    items: [{ type: 'type', text: 'Grace Hopper' }],
  });
  expect(requests).toBe(1);
  expect(errors).toEqual([]);
});

test('deleting saved signatures keeps keyboard focus and removes the empty section', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'pdf-editor:signatures',
      JSON.stringify({
        items: ['Ada Lovelace', 'Grace Hopper', 'Mary Jackson'].map((text) => ({
          type: 'type',
          text,
        })),
      }),
    );
  });
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await squarePdf());
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  const remove = (index) =>
    dialog.getByRole('button', { name: `Delete saved signature ${index}`, exact: true });
  for (const [index, next, remaining] of [
    [2, 2, ['Ada Lovelace', 'Mary Jackson']],
    [2, 1, ['Ada Lovelace']],
    [1, null, []],
  ]) {
    await remove(index).press('Enter');
    await expect(dialog.getByRole('button', { name: /^Use saved signature/ })).toHaveCount(
      remaining.length,
    );
    await expect
      .soft(next ? remove(next) : dialog.getByLabel('Remember drawn and typed signatures'))
      .toBeFocused({ timeout: 1000 });
    expect(JSON.parse(await stored(page))?.items.map((item) => item.text) || []).toEqual(remaining);
  }
  await expect(dialog.getByRole('heading', { name: 'Saved signatures' })).toBeHidden();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Saved signatures' })).toBeHidden();
});

test('a typed signature uses the script font, can be remembered, and comes back after a reload', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await squarePdf());
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  await dialog.getByRole('tab', { name: 'Type' }).click();
  await dialog.getByLabel('Signature text').fill('Ada Lovelace');
  await dialog.getByLabel('Remember drawn and typed signatures').check();
  await dialog.getByRole('button', { name: 'Place signature' }).click();
  await expect(page.getByRole('group', { name: 'Edit signature' })).toBeVisible();
  const [path] = inspectPaths(await exported(page), 0);
  expect(path).toMatchObject({ kind: 'signature', filled: true, stroked: false });
  expect(path.svg).toContain('Z');
  expect(JSON.parse(await stored(page))).toEqual({
    items: [{ type: 'type', text: 'Ada Lovelace' }],
  });
  await page.goto('/#library');
  await openPdf(page, await squarePdf());
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const saved = dialog.getByRole('button', { name: 'Use saved signature 1: Ada Lovelace' });
  await expect(saved).toBeVisible();
  await expect(dialog.getByLabel('Remember drawn and typed signatures')).toBeChecked();
  await saved.click();
  await expect(page.getByRole('group', { name: 'Edit signature' })).toBeVisible();
  expect(inspectPaths(await exported(page), 0)).toHaveLength(1);
  // Deleting the last saved signature also clears the device copy.
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete saved signature 1' }).click();
  await expect(dialog.getByRole('button', { name: /Use saved signature/ })).toHaveCount(0);
  expect(await stored(page)).toBeNull();
});

for (const failure of ['unsupported character', 'font download'])
  test(`typed signatures keep their draft after ${failure} errors`, async ({ page }) => {
    let failFont = failure === 'font download';
    await page.route('**/fonts/GreatVibes-Regular.ttf', (route) =>
      failFont ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.continue(),
    );
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await squarePdf());
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add signature' });
    await dialog.getByLabel('Signature color').fill('#2255aa');
    await dialog.getByRole('tab', { name: 'Type', exact: true }).click();
    const draft = failure === 'font download' ? 'Ada Lovelace' : 'Ada 漢';
    await dialog.getByLabel('Signature text').fill(draft);
    await dialog.getByLabel('Remember drawn and typed signatures').check();
    await dialog.getByRole('button', { name: 'Place signature', exact: true }).click();
    expect.soft(await stored(page)).toBeNull();
    await expect(dialog.getByRole('alert')).toContainText(
      failure === 'font download' ? 'Could not load the signature font' : 'signature font has no',
    );
    await expect(dialog.getByLabel('Signature text')).toHaveValue(draft);
    await expect(dialog.getByLabel('Signature text')).toBeFocused();
    await expect(dialog.getByLabel('Remember drawn and typed signatures')).toBeChecked();
    expect(await stored(page)).toBeNull();
    failFont = false;
    await dialog.getByLabel('Signature text').fill('Ada Lovelace');
    await dialog.getByRole('button', { name: 'Place signature', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Edit signature' })).toBeVisible();
    await expect(page.getByLabel('Signature fill color', { exact: true })).toHaveValue('#2255aa');
    expect(inspectPaths(await exported(page), 0)).toHaveLength(1);
    expect(JSON.parse(await stored(page))).toEqual({
      items: [{ type: 'type', text: 'Ada Lovelace' }],
    });
  });

test('an older unusable saved signature opens its text for correction', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      'pdf-editor:signatures',
      JSON.stringify({
        items: [{ type: 'type', text: 'Ada 漢' }],
      }),
    ),
  );
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await squarePdf());
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  await dialog.getByRole('button', { name: 'Use saved signature 1: Ada 漢', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('signature font has no');
  await expect(dialog.getByRole('tab', { name: 'Type', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(dialog.getByLabel('Signature text')).toHaveValue('Ada 漢');
  await expect(dialog.getByLabel('Signature text')).toBeFocused();
  await dialog.getByRole('button', { name: 'Delete saved signature 1', exact: true }).click();
  await dialog.getByLabel('Signature text').fill('Ada Lovelace');
  await dialog.getByRole('button', { name: 'Place signature', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Edit signature' })).toBeVisible();
  expect(inspectPaths(await exported(page), 0)).toHaveLength(1);
  expect(JSON.parse(await stored(page))).toEqual({
    items: [{ type: 'type', text: 'Ada Lovelace' }],
  });
});

for (const initiallyRemembered of [false, true])
  test(`reusing a saved signature applies changing remember from ${initiallyRemembered}`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/');
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add signature' });
    await dialog.getByRole('tab', { name: 'Type', exact: true }).click();
    await dialog.getByLabel('Signature text').fill('Ada Lovelace');
    await dialog.getByLabel('Remember drawn and typed signatures').setChecked(initiallyRemembered);
    await dialog.getByRole('button', { name: 'Place signature', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Edit signature' })).toBeVisible();
    expect((await stored(page)) !== null).toBe(initiallyRemembered);

    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    await dialog.getByLabel('Remember drawn and typed signatures').setChecked(!initiallyRemembered);
    await dialog
      .getByRole('button', { name: 'Use saved signature 1: Ada Lovelace', exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect((await stored(page)) !== null).toBe(!initiallyRemembered);
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

    await page.reload();
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await page.getByRole('button', { name: 'Sign', exact: true }).click();
    await expect(dialog.getByLabel('Remember drawn and typed signatures')).toBeChecked({
      checked: !initiallyRemembered,
    });
    await expect(dialog.getByRole('button', { name: /Use saved signature/ })).toHaveCount(
      initiallyRemembered ? 0 : 1,
    );
  });

test('an uploaded picture is placed as an image fitted to the signature box', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await squarePdf());
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  await dialog.getByRole('tab', { name: 'Upload' }).click();
  await dialog
    .getByLabel('Signature image file')
    .setInputFiles({ name: 'sig.png', mimeType: 'image/png', buffer: signaturePng() });
  await expect(dialog.getByLabel('Uploaded signature preview')).toBeVisible();
  await dialog.getByRole('button', { name: 'Place signature' }).click();
  await expect(page.getByRole('group', { name: 'Edit image' })).toBeVisible();
  const [image] = inspectImages(await exported(page), 0);
  // A 2:1 picture fills the box height (40% of the 140 pt width) and is centered.
  expect(image.transform[0]).toBeCloseTo(112, 0);
  expect(image.transform[3]).toBeCloseTo(56, 0);
  expect(image.transform[4] + image.transform[0] / 2).toBeCloseTo(200, 0);
});

test('on a rotated page the signature reads upright on screen', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await squarePdf(90));
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  await draw(page, [
    [
      [40, 90],
      [300, 90],
    ],
  ]);
  await page
    .getByRole('dialog', { name: 'Add signature' })
    .getByRole('button', { name: 'Place signature' })
    .click();
  await expect(page.getByRole('group', { name: 'Edit signature' })).toBeVisible();
  // The move handle is wider than tall on screen even though the page is turned.
  const box = await page.getByRole('button', { name: 'Move selected signature' }).boundingBox();
  expect(box.width).toBeGreaterThan(box.height * 3);
  // In the PDF itself the stroke runs vertically, so that the turned page shows it level.
  const [path] = inspectPaths(await exported(page), 0);
  const corners = imageCorners(path.transform),
    xs = corners.map((p) => p[0]),
    ys = corners.map((p) => p[1]);
  expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(
    (Math.max(...xs) - Math.min(...xs)) * 3,
  );
});

test('empty signatures are refused inside the dialog', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await squarePdf());
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  await dialog.getByRole('button', { name: 'Place signature' }).click();
  await expect(dialog.locator('.dialog-error')).toHaveText('Draw your signature first.');
  await dialog.getByRole('tab', { name: 'Type' }).click();
  await dialog.getByRole('button', { name: 'Place signature' }).click();
  await expect(dialog.locator('.dialog-error')).toHaveText('Type your name for the signature.');
  await expect(dialog).toBeVisible();
  await expect(page.locator('.save-status')).toHaveText('Local file');
});

test('the signature sources are a tab strip that answers Home and End', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await squarePdf());
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const tabs = page.getByRole('tablist', { name: 'Signature source' });
  await expect(tabs).toBeVisible();
  for (const [name, id] of [
    ['Draw', 'draw'],
    ['Type', 'type'],
    ['Upload', 'upload'],
  ]) {
    const tab = tabs.getByRole('tab', { name, exact: true });
    await expect(tab).toHaveAttribute('aria-controls', `signature-panel-${id}`);
    await expect(page.locator(`#signature-panel-${id}`)).toHaveAttribute(
      'aria-labelledby',
      `signature-tab-${id}`,
    );
  }
  await tabs.getByRole('tab', { name: 'Draw', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(tabs.getByRole('tab', { name: 'Upload', exact: true })).toBeFocused();
  await expect(page.locator('#signature-panel-upload')).toBeVisible();
  await page.keyboard.press('Home');
  await expect(tabs.getByRole('tab', { name: 'Draw', exact: true })).toBeFocused();
  await expect(page.locator('#signature-panel-draw')).toBeVisible();
});

async function uploadDialog(page) {
  await mockPuter(page);
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  await dialog.getByRole('tab', { name: 'Upload', exact: true }).click();
  return dialog;
}

async function releaseUpload(page) {
  await page.evaluate(async () => {
    window.releaseSignatureUpload();
    // The released promise and its continuation finish before the next task.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test('an older decoded signature upload cannot replace the latest image', async ({ page }) => {
  const dialog = await uploadDialog(page);
  await page.evaluate(() => {
    const decode = window.createImageBitmap;
    let first = true;
    window.signatureBitmaps = [];
    window.createImageBitmap = async (...args) => {
      const bitmap = await decode(...args);
      window.signatureBitmaps.push(bitmap);
      if (first) {
        first = false;
        await new Promise((resolve) => {
          window.releaseSignatureUpload = resolve;
        });
      }
      return bitmap;
    };
  });
  const file = dialog.getByLabel('Signature image file');
  await file.setInputFiles({ name: 'earlier.png', mimeType: 'image/png', buffer: signaturePng() });
  await expect
    .poll(() => page.evaluate(() => typeof window.releaseSignatureUpload))
    .toBe('function');
  const portrait = createCanvas(50, 100);
  const context = portrait.getContext('2d');
  context.fillStyle = '#123';
  context.fillRect(0, 0, 50, 100);
  await file.setInputFiles({
    name: 'latest.png',
    mimeType: 'image/png',
    buffer: portrait.toBuffer('image/png'),
  });
  const preview = dialog.getByLabel('Uploaded signature preview');
  await expect(preview).toBeVisible();
  const latestPreview = await preview.evaluate((canvas) => canvas.toDataURL());
  await releaseUpload(page);
  expect(await preview.evaluate((canvas) => canvas.toDataURL())).toBe(latestPreview);
  expect(await page.evaluate(() => window.signatureBitmaps[0].width)).toBe(0);
  await dialog.getByRole('button', { name: 'Place signature', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Edit image' })).toBeVisible();
  expect(await page.evaluate(() => window.signatureBitmaps.every((bitmap) => !bitmap.width))).toBe(
    true,
  );
  const [image] = inspectImages(await exported(page), 0);
  expect(image.transform[0] / image.transform[3]).toBeCloseTo(0.5, 5);
});

for (const next of ['another upload', 'a reopened dialog'])
  test(`an obsolete signature read failure does not interrupt ${next}`, async ({ page }) => {
    let dialog = await uploadDialog(page);
    await page.evaluate(() => {
      const read = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function () {
        if (this.name !== 'earlier.png') return read.call(this);
        return new Promise((resolve, reject) => {
          window.releaseSignatureUpload = () => reject(new Error('Obsolete upload failed'));
        });
      };
    });
    await dialog.getByLabel('Signature image file').setInputFiles({
      name: 'earlier.png',
      mimeType: 'image/png',
      buffer: signaturePng(),
    });
    await expect
      .poll(() => page.evaluate(() => typeof window.releaseSignatureUpload))
      .toBe('function');
    if (next === 'a reopened dialog') {
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Sign', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Add signature' });
      await dialog.getByRole('tab', { name: 'Upload', exact: true }).click();
    }
    await dialog.getByLabel('Signature image file').setInputFiles({
      name: 'latest.png',
      mimeType: 'image/png',
      buffer: signaturePng(),
    });
    await expect(dialog.getByLabel('Uploaded signature preview')).toBeVisible();
    await releaseUpload(page);
    await expect(dialog.locator('.dialog-error')).toBeHidden();
    expect(
      await dialog.getByLabel('Signature image file').evaluate((input) => input.files[0]?.name),
    ).toBe('latest.png');
    await dialog.getByRole('button', { name: 'Place signature', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Edit image' })).toBeVisible();
  });

test('the drawing pad shows a focus ring when reached with the keyboard', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  const wrap = dialog.locator('.signature-pad-wrap');
  const pad = dialog.locator('.signature-pad');
  await expect(pad).toBeVisible();
  const before = await wrap.screenshot();
  await page.getByRole('tab', { name: 'Draw', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(pad).toBeFocused();
  expect((await wrap.screenshot()).equals(before)).toBe(false);
});

test('the delete button on a saved signature stays legible on its white card in dark mode', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() =>
    localStorage.setItem(
      'pdf-editor:signatures',
      JSON.stringify({ items: [{ type: 'type', text: 'Ada Lovelace' }] }),
    ),
  );
  await mockPuter(page);
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  const use = dialog.getByRole('button', { name: /Use saved signature 1/ });
  const remove = dialog.getByRole('button', { name: 'Delete saved signature 1', exact: true });
  await use.focus();
  await page.keyboard.press('Tab');
  await expect(remove).toBeFocused();
  const contrast = await remove.evaluate((button) => {
    const luminance = (color) => {
      const [r, g, b] = color
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const card = getComputedStyle(document.querySelector('.signature-saved-item')).backgroundColor;
    const ratio = (color) => {
      const [a, b] = [luminance(color), luminance(card)].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    };
    const style = getComputedStyle(button);
    return { icon: ratio(style.color), ring: ratio(style.outlineColor) };
  });
  expect(contrast.icon).toBeGreaterThanOrEqual(4.5);
  expect(contrast.ring).toBeGreaterThanOrEqual(3);
});

test('Enter places a typed signature', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await squarePdf());
  await page.getByRole('button', { name: 'Sign', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add signature' });
  await dialog.getByRole('tab', { name: 'Type' }).click();
  await dialog.getByLabel('Signature text').fill('Ada Lovelace');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('group', { name: 'Edit signature' })).toBeVisible();
  expect(inspectPaths(await exported(page), 0)).toHaveLength(1);
});
