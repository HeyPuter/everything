import { clickAway } from './editing-helpers.js';
import { test, expect } from '@playwright/test';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFile } from 'node:fs/promises';

async function openPage(page, embedded = false) {
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}) }, fs: { readdir: async () => [] }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`,
    }),
  );
  await page.goto('/#library');
  const doc = await PDFDocument.create(),
    sheet = doc.addPage([400, 600]);
  let font;
  if (embedded) {
    doc.registerFontkit(fontkit);
    font = await doc.embedFont(
      await readFile(new URL('../../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
      { subset: true },
    );
  }
  sheet.drawRectangle({ x: 0, y: 0, width: 400, height: 600, color: rgb(0.2, 0.4, 0.6) });
  sheet.drawText('Original words', { x: 40, y: 360, size: 20, font });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'continuity.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(await doc.save()),
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
}

test('an embedded-font draft keeps the same glyph metrics until the committed page replaces it', async ({
  page,
}) => {
  await openPage(page, true);
  await page.getByRole('button', { name: 'Edit text: Original words', exact: true }).click();
  await expect(page.locator('.text-draft-background')).toBeVisible();
  await page.getByRole('textbox', { name: 'Edit text', exact: true }).fill('Revised words');
  await page.evaluate(() => {
    const input = document.querySelector('.page-text-input'),
      context = document.createElement('canvas').getContext('2d');
    const families = getComputedStyle(input)
      .fontFamily.split(',')
      .map((name) => name.trim().replace(/^["']|["']$/g, ''));
    window.sourceFaces = [...document.fonts].filter((face) => families.includes(face.family));
    const width = () => {
      context.font = getComputedStyle(input).font;
      return context.measureText(input.value).width;
    };
    window.draftMetrics = { expected: width(), widths: [] };
    const sample = () => {
      if (!input.isConnected) return;
      window.draftMetrics.widths.push(width());
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await clickAway(page);
  await expect(
    page.getByRole('button', { name: 'Edit text: Revised words', exact: true }),
  ).toBeEnabled();
  const { expected, widths } = await page.evaluate(() => window.draftMetrics);
  expect(widths.length).toBeGreaterThan(1);
  expect([...new Set(widths)]).toEqual([expected]);
  expect(await page.evaluate(() => window.sourceFaces.length)).toBeGreaterThan(0);
  expect(
    await page.evaluate(() => window.sourceFaces.some((face) => document.fonts.has(face))),
  ).toBe(false);
});

test('applying text and history keep the surrounding controls visually stable while busy', async ({
  page,
}) => {
  await openPage(page);
  await page.getByRole('button', { name: 'Edit text: Original words', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit text', exact: true }).fill('Revised words');
  await page.evaluate(() => {
    // Contextual text actions change with the selection; the document chrome stays stable.
    const selectors = [
      '.document-name',
      '.download-btn',
      '.toolbar button[aria-label="Toggle pages panel"]',
      '.toolbar button[title="Text"]',
      '.toolbar button[title="Image"]',
      '.menubar',
      '.menubar button',
      '.zoom-controls',
      '.zoom-controls button',
    ];
    const nodes = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
    const appearance = (node) => {
      const style = getComputedStyle(node),
        rect = node.getBoundingClientRect();
      return [style.opacity, style.color, rect.x, rect.y, rect.width, rect.height];
    };
    const expected = nodes.map(appearance);
    window.chromeFrames = { running: true, samples: 0, busy: 0, changes: [], unblocked: [] };
    const sample = () => {
      const frames = window.chromeFrames;
      if (!frames.running) return;
      frames.samples++;
      if (document.querySelector('.editor').getAttribute('aria-busy') === 'true') {
        frames.busy++;
        nodes.forEach((node, i) => {
          if (node.tagName === 'BUTTON' && !node.closest('.menubar') && !node.disabled)
            frames.unblocked.push(node.getAttribute('aria-label'));
          const actual = appearance(node);
          if (JSON.stringify(actual) !== JSON.stringify(expected[i]))
            frames.changes.push({
              control: node.getAttribute('aria-label') || node.className,
              actual,
              expected: expected[i],
            });
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await clickAway(page);
  await expect(
    page.getByRole('button', { name: 'Edit text: Revised words', exact: true }),
  ).toBeEnabled();
  for (const [action, text] of [
    ['Undo', 'Original words'],
    ['Redo', 'Revised words'],
  ]) {
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(
      page.getByRole('button', { name: `Edit text: ${text}`, exact: true }),
    ).toBeEnabled();
  }
  const frames = await page.evaluate(() => {
    window.chromeFrames.running = false;
    return window.chromeFrames;
  });
  expect(frames.busy).toBeGreaterThan(0);
  expect(frames.changes).toEqual([]);
  expect(frames.unblocked).toEqual([]);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toHaveCSS('opacity', '0.4');
  await expect(page.locator('.busy-enabled')).toHaveCount(0);
});

async function watchFrames(page, thumbnails = false) {
  await page.evaluate((thumbnails) => {
    const paper = document.querySelector('.paper');
    const canvas = paper.querySelector('canvas');
    const pixel = (c) => [
      ...c
        .getContext('2d')
        .getImageData(Math.floor(c.width * 0.9), Math.floor(c.height * 0.9), 1, 1).data,
    ];
    const expected = pixel(canvas);
    window.paintFrames = {
      samples: 0,
      blank: [],
      blankThumbnails: [],
      lostDraft: 0,
      running: true,
    };
    const sample = () => {
      if (!window.paintFrames.running) return;
      const frame = window.paintFrames;
      frame.samples++;
      const actual = pixel(paper.querySelector('canvas'));
      if (actual.some((value, i) => value !== expected[i])) frame.blank.push(actual);
      if (thumbnails) {
        const thumb = document.querySelector('.thumbnail canvas');
        const actualThumb = thumb && pixel(thumb);
        if (!actualThumb || actualThumb.some((value, i) => value !== expected[i]))
          frame.blankThumbnails.push(actualThumb);
      }
      if (
        frame.requireDraft &&
        document.querySelector('.editor').getAttribute('aria-busy') === 'true' &&
        !paper.querySelector('.page-text-input')
      )
        frame.lostDraft++;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, thumbnails);
}

test('visible thumbnails retain their painted preview through undo and redo', async ({ page }) => {
  await openPage(page);
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await page.getByRole('textbox', { name: 'Text to add', exact: true }).fill('Added words');
  await clickAway(page);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  if (!(await page.locator('.thumbnails').isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel', exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator('.thumbnail canvas')
        .first()
        .evaluate((c) => [
          ...c
            .getContext('2d')
            .getImageData(Math.floor(c.width * 0.9), Math.floor(c.height * 0.9), 1, 1).data,
        ]),
    )
    .toEqual([51, 102, 153, 255]);
  await watchFrames(page, true);
  for (const action of ['Undo', 'Redo']) {
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  }
  const frames = await page.evaluate(() => {
    window.paintFrames.running = false;
    return window.paintFrames;
  });
  expect(frames.blankThumbnails).toEqual([]);
});

test('a rejected edit retains its preview and restores native typing for correction', async ({
  page,
}) => {
  await openPage(page);
  await page.getByRole('button', { name: 'Edit text: Original words', exact: true }).click();
  await expect(page.locator('.text-draft-background')).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await input.fill('🦄');
  await watchFrames(page);
  await clickAway(page);
  await expect(page.locator('.text-edit-error')).toContainText('does not support');
  await expect(input).toBeFocused();
  await expect(page.locator('.text-draft-background')).toBeVisible();
  await input.press('ControlOrMeta+a');
  await page.keyboard.insertText('Corrected words');
  await expect(input).toHaveValue('Corrected words');
  await input.press('ControlOrMeta+Enter');
  await expect(
    page.getByRole('button', { name: 'Edit text: Corrected words', exact: true }),
  ).toBeEnabled();
  const frames = await page.evaluate(() => {
    window.paintFrames.running = false;
    return window.paintFrames;
  });
  expect(frames.blank).toEqual([]);
});

test('rapidly superseded zoom renders keep the old page visible and publish only the last size', async ({
  page,
}) => {
  await openPage(page);
  await watchFrames(page);
  await page.getByLabel('Zoom', { exact: true }).evaluate((select) => {
    for (const value of ['0.5', '1', '2', '0.75', '1.5', '2']) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await expect(page.locator('.paper')).toHaveCSS('width', '800px');
  await expect(page.locator('.paper')).toHaveAttribute('aria-busy', 'false');
  await expect(
    page.getByRole('button', { name: 'Edit text: Original words', exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel('Zoom', { exact: true })).toHaveValue('2');
  const frames = await page.evaluate(() => {
    window.paintFrames.running = false;
    return window.paintFrames;
  });
  expect(frames.blank).toEqual([]);
  expect(
    await page
      .locator('.paper > canvas')
      .first()
      .evaluate((c) => c.width),
  ).toBeGreaterThanOrEqual(800);
});

test('applying text and undo/redo keep the painted page visible on every frame', async ({
  page,
}) => {
  await openPage(page);
  await page.getByRole('button', { name: 'Edit text: Original words', exact: true }).click();
  await expect(page.locator('.text-draft-background')).toBeVisible();
  await page.getByRole('textbox', { name: 'Edit text', exact: true }).fill('Revised words');
  await watchFrames(page);
  await clickAway(page);
  await expect(
    page.getByRole('button', { name: 'Edit text: Revised words', exact: true }),
  ).toBeEnabled();
  for (const [action, text] of [
    ['Undo', 'Original words'],
    ['Redo', 'Revised words'],
    ['Undo', 'Original words'],
    ['Redo', 'Revised words'],
  ]) {
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(
      page.getByRole('button', { name: `Edit text: ${text}`, exact: true }),
    ).toBeEnabled();
  }
  const frames = await page.evaluate(() => {
    window.paintFrames.running = false;
    return window.paintFrames;
  });
  expect(frames.samples).toBeGreaterThan(5);
  expect(frames.blank).toEqual([]);
});

test('the text draft stays visible until its replacement page is ready', async ({ page }) => {
  await openPage(page);
  await page.getByRole('button', { name: 'Edit text: Original words', exact: true }).click();
  await expect(page.locator('.text-draft-background')).toBeVisible();
  await page.getByRole('textbox', { name: 'Edit text', exact: true }).fill('Revised words');
  await watchFrames(page);
  await page.evaluate(() => {
    window.paintFrames.requireDraft = true;
  });
  await clickAway(page);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('textbox', { name: 'Edit text', exact: true })).toHaveCount(0);
  const frames = await page.evaluate(() => {
    window.paintFrames.running = false;
    return window.paintFrames;
  });
  expect(frames.lostDraft).toBe(0);
  await expect(
    page.getByRole('button', { name: 'Edit text: Revised words', exact: true }),
  ).toBeEnabled();
});
