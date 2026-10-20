import { clickAway } from './editing-helpers.js';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PDFDocument, PDFName, PDFString, StandardFonts, degrees } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { inspectPaths, pathColorHex } from '../../src/core/path-edit.js';

const PUTER_MOCK = `window.puter = { env: 'web', auth: { isSignedIn: () => true, getUser: async () => ({username:'test-user'}), signIn: async () => {}, signOut: async () => {} }, fs: { readdir: async () => [], write: async (path, blob, options) => { window.lastSave = {path, size:blob.size, options}; return {path, name:path.split('/').pop()}; } }, ui: { onLaunchedWithItems: () => {}, onItemsOpened: () => {} } };`;
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
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';
async function imagePdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 500]);
  const image = await doc.embedPng(Buffer.from(PNG, 'base64'));
  page.drawImage(image, { x: 60, y: 200, width: 120, height: 100 });
  return doc;
}
async function multiPagePdf(count = 3) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < count; i++)
    doc.addPage([400, 400]).drawText(`Page ${i + 1} words`, { x: 40, y: 300, size: 18, font });
  return doc;
}

test('an emptied page number field keeps the current page', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf());
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  const input = page.getByLabel('Page number');
  await input.fill('');
  await input.press('Tab');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await expect(input).toHaveValue('2');
  await input.fill('9');
  await input.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
  await expect(input).toHaveValue('3');
  await input.fill('0');
  await input.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await expect(input).toHaveValue('1');
});

test('Alt+Arrow keys move the caret inside fields instead of changing pages', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf());
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  const draft = page.getByRole('textbox', { name: 'Text to add', exact: true });
  await draft.fill('hello there');
  await draft.press('Alt+ArrowLeft');
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue('hello there');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  const find = page.getByRole('searchbox', { name: 'Find in PDF' });
  await find.fill('words');
  await find.press('Alt+ArrowRight');
  await expect(find).toBeFocused();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await page.locator('.workspace').focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
});

test('Undo and Redo shortcuts work while a toolbar select keeps the focus', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  await page.getByRole('button', { name: 'Shape', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const redo = page.getByRole('button', { name: 'Redo', exact: true });
  await expect(undo).toBeEnabled();
  // Choosing a zoom leaves the focus on the select, which has no text undo of its own.
  const zoom = page.getByLabel('Zoom', { exact: true });
  await zoom.focus();
  await zoom.selectOption('1');
  await expect(zoom).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(undo).toBeDisabled();
  await expect(redo).toBeEnabled();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();
});

test('recoloring a highlight keeps the value typed into a form field', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const pdfPage = doc.addPage([400, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  pdfPage.drawText('Some words to mark', { x: 40, y: 300, size: 18, font });
  doc
    .getForm()
    .createTextField('name')
    .addToPage(pdfPage, { x: 40, y: 60, width: 200, height: 30 });
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  await page.getByLabel('Highlight mode').selectOption('area');
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page
    .getByRole('button', { name: /^Edit highlight/ })
    .first()
    .click();
  await expect(page.getByRole('group', { name: 'Edit highlight' })).toBeVisible();
  const field = page.locator('.form-control').first();
  await field.click();
  await field.fill('typed draft');
  const picker = page.getByLabel('Highlight color');
  await picker.fill('#1144cc');
  await picker.dispatchEvent('change');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.form-control').first()).toHaveValue('typed draft');
  // The highlight stays selected with its new color, and the field value is in the history.
  await expect(page.getByLabel('Highlight color')).toHaveValue('#1144cc');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.form-control').first()).toHaveValue('typed draft');
});

test('applying a text draft hands the focus to the page instead of the body', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await page.getByRole('textbox', { name: 'Text to add', exact: true }).fill('hello');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(page.locator('.drawing-overlay')).toBeFocused();
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await page.getByRole('textbox', { name: 'Text to add', exact: true }).fill('again');
  await clickAway(page);
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.workspace')).toBeFocused();
});

test('a drag out of a dialog field keeps the dialog open; a backdrop press closes it', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  await page.getByRole('button', { name: /^Rename / }).click();
  const dialog = page.getByRole('dialog', { name: 'Name this PDF' });
  await expect(dialog).toBeVisible();
  const input = dialog.getByLabel('File name');
  const box = await input.boundingBox();
  const frame = await dialog.boundingBox();
  // On a phone the dialog spans the width, so the backdrop is reached above it.
  const outside = { x: frame.x + frame.width / 2, y: Math.max(4, frame.y - 30) };
  expect(outside.y).toBeLessThan(frame.y);
  // Selecting the name with a drag that ends past the dialog's edge.
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(outside.x, outside.y, { steps: 4 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();
  // A press that starts and ends on the backdrop still closes the dialog.
  await page.mouse.click(outside.x, outside.y);
  await expect(dialog).toHaveCount(0);
});

test('Escape closes an open dialog before touching the highlight editor', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await page.getByRole('button', { name: 'Try a sample PDF' }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  await page.getByLabel('Highlight mode').selectOption('area');
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page
    .getByRole('button', { name: /^Edit highlight/ })
    .first()
    .click();
  const panel = page.getByRole('group', { name: 'Edit highlight' });
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('inserting an unsupported image file explains the accepted formats', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  for (const file of [
    { name: 'anim.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a;', 'binary') },
    {
      name: 'broken.png',
      mimeType: 'image/png',
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]),
    },
  ]) {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Image', exact: true }).click();
    await (await chooser).setFiles(file);
    await expect(page.locator('#toast')).toHaveText('Choose a valid PNG or JPEG image.');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(page.locator('.save-status')).toHaveText('Local file');
  }
});

test.describe('dense displays', () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } });
  test('thumbnails render at device resolution', async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await multiPagePdf(2));
    if (!(await page.locator('#page-sidebar').isVisible()))
      await page.getByRole('button', { name: 'Toggle pages panel' }).click();
    const canvas = page.locator('.thumbnail canvas').first();
    await expect.poll(() => canvas.evaluate((c) => c.width)).toBeGreaterThan(1);
    const size = await canvas.evaluate((c) => ({
      backing: [c.width, c.height],
      css: [c.clientWidth, c.clientHeight],
    }));
    expect(size.css[0]).toBeLessThanOrEqual(112);
    expect(size.backing[0]).toBe(size.css[0] * 2);
    expect(size.backing[1]).toBe(size.css[1] * 2);
  });
});

test('Escape closes the find bar and clears its highlights', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(2));
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('searchbox', { name: 'Find in PDF' });
  await expect(find).toBeFocused();
  await find.fill('words');
  await expect(page.locator('.search-count')).toHaveText('1 of 2');
  await expect(page.locator('.search-hit')).not.toHaveCount(0);
  await find.press('Escape');
  await expect(page.locator('.find-bar')).toBeHidden();
  await expect(page.locator('.search-hit')).toHaveCount(0);
  await expect(page.locator('.workspace')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+f');
  await expect(find).toBeFocused();
  await expect(find).toHaveValue('');
  await expect(page.locator('.search-count')).toHaveText('');
});

test('the browser theme color stays the brand color in every appearance', async ({ page }) => {
  // Like the neighboring Documents and Spreadsheet apps, the browser chrome takes the brand
  // color rather than the page color, so it reads the same before and after a theme change.
  await mockPuter(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/#library');
  const meta = page.locator('meta[name="theme-color"]');
  const brand = async () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
    );
  await expect(meta).toHaveAttribute('content', '#bf3f3f');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const select = page.getByLabel('Appearance');
  for (const theme of ['light', 'dark', 'system']) {
    await select.selectOption(theme);
    await expect(meta).toHaveAttribute('content', await brand());
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(meta).toHaveAttribute('content', await brand());
  await page.reload();
  await expect(meta).toHaveAttribute('content', '#bf3f3f');
});

test.describe('dark appearance', () => {
  test.use({ colorScheme: 'dark' });
  test('the text editing panel stays legible on the dark surface', async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await multiPagePdf(1));
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await page.getByRole('button', { name: 'Edit text: Page 1 words', exact: true }).click();
    await expect(page.locator('.text-draft-background')).toBeVisible();
    const panel = page.locator('.text-edit-actions');
    const ink = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(),
    );
    expect(ink).toBe('#f5f5f2');
    await expect(panel).toHaveCSS('color', 'rgb(245, 245, 242)');
    await expect(panel.getByLabel('Text X in points')).toHaveCSS('color', 'rgb(245, 245, 242)');
    await expect(panel.locator('.text-position-controls label').first()).toHaveCSS(
      'color',
      'rgb(245, 245, 242)',
    );
  });
});

test.describe('phone layout', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  test('the pages panel leaves the docked object controls accessible', async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await imagePdf());
    await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Edit image' })).toBeVisible();
    await page.getByRole('button', { name: 'Toggle pages panel' }).click();
    await expect(page.locator('#page-sidebar')).toBeVisible();
    const covered = await page.evaluate(() => {
      const side = document.querySelector('.page-sidebar').getBoundingClientRect();
      const panel = document.querySelector('.image-edit-panel').getBoundingClientRect();
      const x = Math.max(side.left, panel.left) + 8,
        y = Math.max(side.top, panel.top) + 8;
      return x < Math.min(side.right, panel.right) && y < Math.min(side.bottom, panel.bottom)
        ? !!document.elementFromPoint(x, y)?.closest('.page-sidebar')
        : 'no overlap';
    });
    expect(covered).toBe('no overlap');
  });
});

test('keyboard focus rings stay visible inside clipped page targets', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await imagePdf());
  const target = page.getByRole('button', { name: 'Select image 1', exact: true });
  // Establish keyboard modality, then focus the target independently of Safari's
  // system preference for whether Tab visits plain buttons.
  await page.keyboard.press('Tab');
  await target.focus();
  await expect(target).toBeFocused();
  const box = await target.boundingBox();
  const ring = await target.evaluate((node) => {
    const style = getComputedStyle(node);
    return { offset: parseFloat(style.outlineOffset), width: parseFloat(style.outlineWidth) };
  });
  // The polygon clip removes anything painted outside the box, so the ring must sit inside it.
  expect(ring.width).toBeGreaterThan(0);
  expect(ring.offset + ring.width).toBeLessThanOrEqual(0);
  const shot = await page.screenshot({
    clip: { x: box.x, y: box.y, width: box.width, height: 4 },
  });
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(shot);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const [r, g, b] = context.getImageData(Math.floor(image.width / 2), 1, 1, 1).data;
  // The ring is the selection blue used for everything selected on the page (#1473e6).
  expect(r).toBeLessThan(80);
  expect(g).toBeGreaterThan(80);
  expect(b).toBeGreaterThan(180);
});

test('the editor fills the viewport without a stray scrollbar', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  const overflow = await page.evaluate(() => ({
    vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(overflow).toEqual({ vertical: 0, horizontal: 0 });
});

test.describe('tablet layout', () => {
  test.use({ viewport: { width: 820, height: 1180 } });
  test('the toolbar fits without sideways scrolling', async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await multiPagePdf(1));
    const toolbar = page.locator('.toolbar');
    const size = await toolbar.evaluate((node) => ({
      scroll: node.scrollWidth,
      client: node.clientWidth,
    }));
    expect(size.scroll).toBeLessThanOrEqual(size.client);
    await expect(page.getByRole('button', { name: 'Highlight', exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Highlight', exact: true }).locator('span'),
    ).toBeHidden();
    await expect(page.getByLabel('Zoom', { exact: true })).toBeInViewport({ ratio: 1 });
    // The quick tools are a column of icons at every width; each keeps its name as a label.
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.getByRole('button', { name: 'Highlight', exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Highlight', exact: true }).locator('span'),
    ).toBeHidden();
  });
});

test.describe('small phone layout', () => {
  test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
  test('highlight options wrap instead of overflowing the context bar', async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await multiPagePdf(1));
    await page.getByRole('button', { name: 'Highlight', exact: true }).click();
    const bar = page.locator('.contextbar');
    const size = await bar.evaluate((node) => ({
      scroll: node.scrollWidth,
      client: node.clientWidth,
    }));
    expect(size.scroll).toBeLessThanOrEqual(size.client);
    const swatch = await page.getByLabel('Annotation color').boundingBox();
    expect(swatch.width).toBeGreaterThanOrEqual(27);
    await expect(page.getByLabel('Highlight mode')).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('button', { name: 'Place at page center' })).toBeInViewport({
      ratio: 1,
    });
  });
});

test.describe('narrow phone toolbar', () => {
  test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
  test('the zoom control shows its whole label', async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await multiPagePdf(1));
    const zoom = page.getByLabel('Zoom', { exact: true });
    const fits = await zoom.evaluate((select) => {
      const probe = document.createElement('span');
      probe.style.cssText = `font:${getComputedStyle(select).font};position:absolute;visibility:hidden;white-space:nowrap`;
      probe.textContent = select.options[select.selectedIndex].textContent;
      document.body.append(probe);
      const text = probe.getBoundingClientRect().width;
      probe.remove();
      const style = getComputedStyle(select);
      const inner =
        select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return { text, inner };
    });
    // Leave room for the native chevron next to the label.
    expect(fits.inner).toBeGreaterThanOrEqual(fits.text + 16);
    const toolbar = await page
      .locator('.toolbar')
      .evaluate((node) => node.scrollWidth - node.clientWidth);
    expect(toolbar).toBeLessThanOrEqual(0);
  });
});

test('the editor exposes landmark roles and a focusable skip target', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  await expect(page.getByRole('toolbar', { name: 'PDF tools' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'PDF page view' })).toBeVisible();
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await skip.focus();
  await expect(skip).toBeFocused();
  await skip.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
});

test('the home screen renders before the Puter SDK has loaded', async ({ page }) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route('https://js.puter.com/**', async (route) => {
    await held;
    await route.fulfill({ contentType: 'application/javascript', body: PUTER_MOCK });
  });
  await page.goto('/#library', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'New blank PDF' })).toBeVisible();
  await expect(page.locator('.account-label')).toHaveText('Local workspace');
  await expect(page.getByRole('button', { name: 'Open a PDF' })).toBeEnabled();
  release();
  await expect(page.locator('.account-label')).toHaveText('test-user');
  await expect(page.getByRole('heading', { name: 'Your library starts here' })).toBeVisible();
});

test('a rejected text draft keeps the zoom control on the rendered zoom', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Page 1 words', exact: true }).click();
  await expect(page.locator('.text-draft-background')).toBeVisible();
  const draft = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await draft.fill('你好');
  const zoom = page.getByLabel('Zoom', { exact: true });
  const { width } = await page.locator('.paper').boundingBox();
  await zoom.selectOption('2');
  await expect(page.locator('.text-edit-error')).toContainText('does not support');
  await expect(zoom).toHaveValue('fit');
  expect((await page.locator('.paper').boundingBox()).width).toBe(width);
  await draft.fill('Corrected words');
  await zoom.selectOption('2');
  await expect(zoom).toHaveValue('2');
  await expect(page.locator('.paper')).toHaveCSS('width', '800px');
  await expect(page.locator('.textLayer')).toContainText('Corrected words');
});

test('a fit-width page catches up with a resize that happened during a text draft', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  const paper = page.locator('.paper');
  const fitWidth = async () => {
    const [workspace, viewport] = await page
      .locator('.workspace')
      .evaluate((node) => [node.clientWidth, innerWidth]);
    // Phones keep a narrow margin; elsewhere the floating quick tools need room beside the page.
    const gutter = viewport <= 760 || workspace < 400 ? 28 : 120;
    return Math.min(1.5, Math.max(0.15, (workspace - gutter) / 400)) * 400;
  };
  const paperWidth = () => paper.evaluate((node) => parseFloat(node.style.width));
  expect(await paperWidth()).toBeCloseTo(await fitWidth(), 3);
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Page 1 words', exact: true }).click();
  await expect(page.locator('.text-draft-background')).toBeVisible();
  const before = await paper.evaluate((node) => node.style.width);
  await page.setViewportSize({ width: 520, height: 800 });
  await page.waitForTimeout(400);
  // The open draft keeps its page geometry stable.
  await expect(paper).toHaveCSS('width', before);
  await page.keyboard.press('Escape');
  await expect(paper).not.toHaveCSS('width', before);
  expect(await paperWidth()).toBeCloseTo(await fitWidth(), 3);
});

test('switching tools indexes the page in place instead of re-rendering it', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await imagePdf();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.getPage(0).drawText('Caption words here', { x: 60, y: 120, size: 18, font });
  const second = doc.addPage([400, 500]);
  second.drawText('Second page text', { x: 60, y: 120, size: 18, font });
  second.drawImage(await doc.embedPng(Buffer.from(PNG, 'base64')), {
    x: 60,
    y: 200,
    width: 120,
    height: 100,
  });
  await openPdf(page, doc);
  await expect(page.getByRole('button', { name: 'Select image 1', exact: true })).toBeVisible();
  await page.evaluate(() => {
    const paper = document.querySelector('.paper');
    const canvas = paper.querySelector('canvas');
    const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
    window.renderSignals = { busy: 0, canvasResets: 0, announcer: [] };
    Object.defineProperty(canvas, 'width', {
      set(value) {
        window.renderSignals.canvasResets++;
        width.set.call(this, value);
      },
      get() {
        return width.get.call(this);
      },
    });
    new MutationObserver(() => {
      if (paper.getAttribute('aria-busy') === 'true') window.renderSignals.busy++;
    }).observe(paper, { attributes: true, attributeFilter: ['aria-busy'] });
    new MutationObserver(() =>
      window.renderSignals.announcer.push(document.querySelector('#announcer').textContent),
    ).observe(document.querySelector('#announcer'), { childList: true, characterData: true });
  });
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const target = page.getByRole('button', { name: 'Edit text: Caption words here', exact: true });
  await expect(target).toBeEnabled();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select image 1', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(target).toBeEnabled();
  expect(await page.evaluate(() => window.renderSignals)).toEqual({
    busy: 0,
    canvasResets: 0,
    announcer: [],
  });
  // A page first rendered in the Text tool still gains its object targets on Select.
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await page.getByRole('button', { name: 'Edit text: Second page text', exact: true }).click();
  await expect(page.locator('.text-draft-background')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select image 1', exact: true })).toBeEnabled();
});

test('the live region announces page changes once, not every re-render', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await page.evaluate(() => {
    window.announcements = [];
    new MutationObserver(() =>
      window.announcements.push(document.querySelector('#announcer').textContent),
    ).observe(document.querySelector('#announcer'), { childList: true, characterData: true });
  });
  await openPdf(page, await multiPagePdf(2));
  await expect.poll(() => page.evaluate(() => window.announcements)).toEqual(['Page 1 of 2']);
  await page.getByLabel('Zoom', { exact: true }).selectOption('1');
  await expect(page.locator('.paper')).toHaveCSS('width', '400px');
  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  await page.getByLabel('Highlight mode').selectOption('area');
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.announcements)).toEqual(['Page 1 of 2']);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await expect
    .poll(() => page.evaluate(() => window.announcements))
    .toEqual(['Page 1 of 2', 'Page 2 of 2']);
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await page.getByRole('button', { name: 'Leave without saving', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New blank PDF' })).toBeVisible();
  await openPdf(page, await multiPagePdf(2));
  await expect.poll(() => page.evaluate(() => window.announcements.at(-1))).toBe('Page 1 of 2');
});

test('highlighting works when the action is pressed before the deferred measurement', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  const action = page.getByRole('button', { name: 'Highlight selection', exact: true });
  await expect(action).toBeDisabled();
  const applied = await page.evaluate(async () => {
    const span = document.querySelector('.textLayer span');
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    // Let the selectionchange event fire, then press the action before its 100 ms settle.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const button = document.querySelector('[aria-label="Highlight selection"]');
    const enabled = !button.disabled;
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    button.click();
    return enabled;
  });
  expect(applied).toBe(true);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Edit highlight: Page 1 words/ })).toBeVisible();
  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  await expect(action).toBeDisabled();
  // A selection outside the page text does not enable the action.
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('.tool-hint'));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  });
  await page.waitForTimeout(200);
  await expect(action).toBeDisabled();
});

test('text sizes learned from the page keep the size menu in ascending order', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await page.getByRole('button', { name: 'Try a sample PDF' }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  const sizes = () =>
    page.getByLabel('Text size').evaluate((select) => [...select.options].map((o) => o.value));
  for (const text of ['Make it your own.', '01', 'PDF EDITOR / GETTING STARTED']) {
    await page.getByRole('button', { name: `Edit text: ${text}`, exact: true }).click();
    await expect(page.locator('.text-draft-background')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.text-draft-background')).toHaveCount(0);
  }
  const values = (await sizes()).map(Number);
  expect(values).toContain(34);
  expect(values).toContain(11);
  expect(values).toEqual([...values].sort((a, b) => a - b));
  expect(new Set(values).size).toBe(values.length);
});

test('the redo shortcut leaves a pending text draft alone', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Page 1 words', exact: true }).click();
  const draft = page.getByRole('textbox', { name: 'Edit text', exact: true });
  await draft.fill('Changed words');
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  const move = page.getByRole('button', { name: 'Move text', exact: true });
  await move.focus();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(draft).toHaveValue('Changed words');
  await expect(page.locator('.text-draft-background')).toBeVisible();
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.locator('.textLayer')).toContainText('Page 1 words');
});

test('the pages panel toggle exposes its expanded state', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(2));
  const toggle = page.getByRole('button', { name: 'Toggle pages panel', exact: true });
  const panel = page.locator('#page-sidebar');
  await expect(toggle).toHaveAttribute('aria-controls', 'page-sidebar');
  await expect(panel).toHaveAttribute('id', 'page-sidebar');
  const open = await panel.isVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', String(open));
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', String(!open));
  await expect(panel).toBeVisible({ visible: !open });
  await (open ? toggle : page.getByRole('button', { name: 'Close pages panel' })).click();
  await expect(toggle).toHaveAttribute('aria-expanded', String(open));
  await expect(panel).toBeVisible({ visible: open });
});

test('find starts from the current page and wraps around', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(3));
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('searchbox', { name: 'Find in PDF' });
  await find.fill('words');
  await expect(page.locator('.search-count')).toHaveText('2 of 3');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await expect(page.locator('.search-hit')).not.toHaveCount(0);
  await find.press('Enter');
  await expect(page.locator('.search-count')).toHaveText('3 of 3');
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
  await find.press('Enter');
  await expect(page.locator('.search-count')).toHaveText('1 of 3');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await find.press('Shift+Enter');
  await expect(page.locator('.search-count')).toHaveText('3 of 3');
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
  // A query found only on earlier pages wraps to its first match.
  await find.fill('Page 1');
  await expect(page.locator('.search-count')).toHaveText('1 of 1');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
});

test('find marks only the matched characters inside a text span', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 400]).drawText('Alpha beta gamma beta', { x: 40, y: 300, size: 18, font });
  await openPdf(page, doc);
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('searchbox', { name: 'Find in PDF' });
  await find.fill('beta');
  await expect(page.locator('.search-count')).toHaveText('1 of 2');
  const hits = page.locator('.search-hit');
  await expect(hits).toHaveText(['beta', 'beta']);
  const span = page.locator('.textLayer span').filter({ hasText: 'Alpha beta gamma beta' });
  await expect(span).toHaveText('Alpha beta gamma beta');
  const spanBox = await span.boundingBox();
  const hitBox = await hits.first().boundingBox();
  expect(hitBox.width).toBeLessThan(spanBox.width / 2);
  expect(hitBox.x).toBeGreaterThan(spanBox.x + spanBox.width * 0.15);
  await find.fill('gamma b');
  await expect(hits).toHaveText(['gamma b']);
  await find.press('Escape');
  await expect(hits).toHaveCount(0);
  await expect(span).toHaveText('Alpha beta gamma beta');
  expect(await span.evaluate((node) => node.childNodes.length)).toBe(1);
});

test('the library sorts file names naturally', async ({ page }) => {
  const files = [
    'Chapter 10.pdf',
    'apple.pdf',
    'chapter 2.pdf',
    'Zebra.pdf',
    'Chapter 100.pdf',
  ].map((name, i) => ({
    name,
    path: `PDF Editor/${name}`,
    size: 1000 * (i + 1),
    modified: 1700000000 + i,
  }));
  await page.route('https://js.puter.com/**', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: PUTER_MOCK.replace(
        'readdir: async () => []',
        `readdir: async () => ${JSON.stringify(files)}`,
      ),
    }),
  );
  await page.goto('/#library');
  await page.getByLabel('Sort PDFs', { exact: true }).selectOption('name');
  await expect(page.locator('.file-open')).toHaveText([
    'apple.pdf',
    'chapter 2.pdf',
    'Chapter 10.pdf',
    'Chapter 100.pdf',
    'Zebra.pdf',
  ]);
});

test('choosing a thumbnail dismisses the pages panel only when it overlays the page', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(3));
  const toggle = page.getByRole('button', { name: 'Toggle pages panel', exact: true });
  const panel = page.locator('#page-sidebar');
  const overlaid = await page.evaluate(() => matchMedia('(max-width: 760px)').matches);
  if (!(await panel.isVisible())) await toggle.click();
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: 'Go to page 2', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  await expect(panel).toBeVisible({ visible: !overlaid });
  await expect(toggle).toHaveAttribute('aria-expanded', String(!overlaid));
  await expect(page.getByRole('button', { name: 'Next page', exact: true })).toBeEnabled();
});

test('Ctrl+Y redoes outside text fields', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  await page.getByLabel('Highlight mode').selectOption('area');
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const redo = page.getByRole('button', { name: 'Redo', exact: true });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(redo).toBeEnabled();
  await expect(undo).toBeDisabled();
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  const find = page.getByRole('searchbox', { name: 'Find in PDF' });
  await find.press('Control+y');
  await expect(redo).toBeEnabled();
  await find.press('Escape');
  await expect(page.locator('.workspace')).toBeFocused();
  await page.keyboard.press('Control+y');
  await expect(undo).toBeEnabled();
  await expect(redo).toBeDisabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toContainText('Ctrl Y');
});

async function paragraphPdf(rotation = 0) {
  const doc = await PDFDocument.create(),
    p = doc.addPage([400, 400]);
  p.setRotation(degrees(rotation));
  const regular = await doc.embedFont(StandardFonts.Helvetica),
    bold = await doc.embedFont(StandardFonts.HelveticaBold);
  p.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F: regular.ref, B: bold.ref } }));
  p.node.set(
    PDFName.of('Contents'),
    doc.context.register(
      doc.context.flateStream(
        '0.2 0.6 0.7 rg 0 0 400 400 re f 0 0 0 rg BT /F 18 Tf 22 TL 40 320 Td (This is a longer first line) Tj T* (and a ) Tj /B 18 Tf 0.8 0.1 0.2 rg (shorter) Tj /F 18 Tf 0 0 0 rg ( second line.) Tj T* (End.) Tj 0 -90 Td (Neighbor) Tj ET',
      ),
    ),
  );
  return doc;
}
const intersects = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const rotation of [0, 90])
  test(`the text editing panel never covers the draft on a small page at ${rotation} degrees`, async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await paragraphPdf(rotation));
    await page.getByRole('button', { name: 'Text', exact: true }).click();
    await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
    await expect(page.locator('.paper')).toHaveCSS('width', '200px');
    await page
      .getByRole('button', {
        name: 'Edit text: This is a longer first line and a shorter second line. End.',
        exact: true,
      })
      .click();
    const input = page.getByRole('textbox', { name: 'Edit text', exact: true });
    await expect(page.locator('.text-draft-background')).toBeVisible();
    const panel = page.locator('.text-edit-actions');
    const [draft, actions] = await Promise.all([input.boundingBox(), panel.boundingBox()]);
    expect(intersects(draft, actions)).toBe(false);
    await expect(page.getByRole('complementary', { name: 'Selection properties' })).toContainText(
      'Text',
    );
    await expect(page.locator('.paper')).toHaveCSS('margin-bottom', '0px');
    await page.keyboard.press('Escape');
    await expect(input).toHaveCount(0);
    await expect(page.locator('.paper')).toHaveCSS('margin-bottom', '0px');
  });

test.describe('high density display', () => {
  test.use({ deviceScaleFactor: 3, viewport: { width: 500, height: 700 } });
  test('the page canvas renders at the device ratio within the pixel budget', async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await multiPagePdf(1));
    const canvas = page.locator('.paper > canvas').first();
    const small = await canvas.evaluate((c) => ({
      backing: [c.width, c.height],
      css: [parseFloat(c.style.width), parseFloat(c.style.height)],
    }));
    expect(small.backing[0]).toBe(Math.floor(small.css[0] * 3));
    expect(small.backing[1]).toBe(Math.floor(small.css[1] * 3));
    const doc = await PDFDocument.create();
    doc.addPage([3000, 3000]);
    await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
    await openPdf(page, doc);
    await page.getByLabel('Zoom', { exact: true }).selectOption('2');
    await expect(page.locator('.paper')).toHaveCSS('width', '6000px');
    const large = await canvas.evaluate((c) => ({ pixels: c.width * c.height, side: c.width }));
    expect(large.pixels).toBeLessThanOrEqual(16000000);
    expect(large.side).toBeLessThanOrEqual(8192);
  });
});

test('text drafts use the font face PDF.js registered for a substituted standard font', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Page 1 words', exact: true }).click();
  await expect(page.locator('.text-draft-background')).toBeVisible();
  const faces = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
  );
  expect(faces.length).toBeGreaterThan(0);
  const family = await page
    .getByRole('textbox', { name: 'Edit text', exact: true })
    .evaluate((node) => getComputedStyle(node).fontFamily);
  expect(faces.some((face) => family.split(',').some((f) => f.trim() === face))).toBe(true);
});

test('an empty text draft shows its whole placeholder without scrollbars', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Text to add', exact: true });
  await expect(input).toHaveAttribute('placeholder', 'Type your text');
  await expect(input).toHaveValue('');
  const measure = () =>
    input.evaluate((node) => ({
      overflowX: node.scrollWidth - node.clientWidth,
      overflowY: node.scrollHeight - node.clientHeight,
      width: node.clientWidth,
    }));
  const empty = await measure();
  expect(empty.overflowX).toBe(0);
  expect(empty.overflowY).toBe(0);
  // Typing less than the hint never leaves the box wider than the hint needed.
  await input.fill('Hi');
  const typed = await measure();
  expect(typed.overflowX).toBe(0);
  expect(typed.width).toBeLessThanOrEqual(empty.width);
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
});

test('toggling the pages panel re-renders the page only when its width changes', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++)
    doc.addPage([1000, 600]).drawText(`Wide page ${i + 1}`, { x: 40, y: 300, size: 18, font });
  await openPdf(page, doc);
  const toggle = page.getByRole('button', { name: 'Toggle pages panel', exact: true });
  const paper = page.locator('.paper');
  const overlaid = await page.evaluate(() => matchMedia('(max-width: 760px)').matches);
  await page.evaluate(() => {
    const canvas = document.querySelector('.paper canvas');
    const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
    window.canvasResets = 0;
    Object.defineProperty(canvas, 'width', {
      set(value) {
        window.canvasResets++;
        width.set.call(this, value);
      },
      get() {
        return width.get.call(this);
      },
    });
  });
  const before = await paper.evaluate((node) => node.style.width);
  const expanded = await toggle.getAttribute('aria-expanded');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', String(expanded !== 'true'));
  if (overlaid) {
    // The panel covers the page instead of narrowing it, so the page keeps its render.
    await page.waitForTimeout(600);
    await expect(paper).toHaveCSS('width', before);
    expect(await page.evaluate(() => window.canvasResets)).toBe(0);
  } else {
    await expect(paper).not.toHaveCSS('width', before);
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => window.canvasResets)).toBe(1);
  }
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', String(expanded === 'true'));
  await expect(paper).toHaveCSS('width', before);
});

test('the pages panel keeps the current page thumbnail in view', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(14));
  const toggle = page.getByRole('button', { name: 'Toggle pages panel', exact: true });
  const panel = page.locator('#page-sidebar');
  if (!(await panel.isVisible())) await toggle.click();
  await expect(panel).toBeVisible();
  const inView = (name) =>
    page.getByRole('button', { name, exact: true }).evaluate((node) => {
      const strip = node.closest('.thumbnails');
      const [a, b] = [node.getBoundingClientRect(), strip.getBoundingClientRect()];
      return a.top >= b.top && a.bottom <= b.bottom;
    });
  expect(await inView('Go to page 1')).toBe(true);
  expect(await inView('Go to page 14')).toBe(false);
  const pageInput = page.getByLabel('Page number', { exact: true });
  await pageInput.fill('14');
  await pageInput.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText('Page 14 of 14');
  await expect(page.getByRole('button', { name: 'Go to page 14', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect(await inView('Go to page 14')).toBe(true);
  // A page change made while the panel is closed is revealed when it opens again.
  await toggle.click();
  await expect(panel).toBeHidden();
  await page.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 13 of 14');
  await pageInput.fill('1');
  await pageInput.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 14');
  await toggle.click();
  await expect(panel).toBeVisible();
  expect(await inView('Go to page 1')).toBe(true);
});

test('the pages panel is one tab stop that the arrow keys move through', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'a phone closes the panel whenever a page is chosen');
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(20));
  const panel = page.locator('#page-sidebar');
  await expect(panel).toBeVisible();
  const list = page.locator('.thumbnails');
  const stops = () =>
    list.evaluate(
      (node) =>
        [...node.querySelectorAll('button')].filter((button) => button.tabIndex >= 0).length,
    );
  await expect(page.locator('.thumbnail')).toHaveCount(20);
  expect(await stops()).toBe(1);
  const named = (name) => page.getByRole('button', { name, exact: true });
  // Tab enters at the current page and leaves after it in one step.
  await panel.getByRole('button', { name: 'Close pages panel', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(named('Go to page 1')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(named('Go to page 2')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 20');
  await page.keyboard.press('End');
  await expect(named('Go to page 20')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(named('Page 20 actions')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(named('Page 19 actions')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(named('Go to page 19')).toBeFocused();
  await page.keyboard.press('Home');
  await expect(named('Go to page 1')).toBeFocused();
  expect(await stops()).toBe(1);
  await page.keyboard.press('Tab');
  expect(await list.evaluate((node) => node.contains(document.activeElement))).toBe(false);
  await page.keyboard.press('Shift+Tab');
  await expect(named('Go to page 1')).toBeFocused();
  // Away from the list, the tab stop follows the page on view.
  const pageInput = page.getByLabel('Page number', { exact: true });
  await pageInput.fill('7');
  await pageInput.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText('Page 7 of 20');
  await expect(named('Go to page 7')).toHaveAttribute('tabindex', '0');
  expect(await stops()).toBe(1);
});

test('dropping text into a draft keeps its native insertion while file drops open PDFs', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Text to add', exact: true });
  const cancelled = await input.evaluate((node) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'dragged words');
    const event = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(cancelled).toBe(false);
  await page.keyboard.press('Escape');
  // A dropped PDF still opens instead of navigating the tab to the file.
  const dropped = await multiPagePdf(2);
  const opened = await page.evaluate(
    async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'dropped.pdf', { type: 'application/pdf' }));
      const event = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    },
    Buffer.from(await dropped.save()).toString('base64'),
  );
  expect(opened).toBe(true);
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
});

// A real file drag never dispatches `drop` on its own: the browser delivers one only after a
// `dragover` over the element under the cursor was cancelled, and it withholds the file entries
// until that drop. Dispatching `drop` directly would keep passing with the drag handlers removed.
test('a file dragged onto the page opens it, over whatever sits under the cursor', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  const dropped = await multiPagePdf(2);
  const drag = await page.evaluate(
    async (base64) => {
      const box = document.querySelector('canvas').getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const target = document.elementFromPoint(x, y);
      const send = (type, withFile) => {
        const transfer = new DataTransfer();
        // Only the type is readable before the drop, exactly as a real drag reports it.
        if (withFile)
          transfer.items.add(
            new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'dropped.pdf', {
              type: 'application/pdf',
            }),
          );
        else {
          // A file item creates the native "Files" type; a string item is a MIME type
          // that Firefox and WebKit lowercase. Hide its file list until the drop.
          const empty = new DataTransfer().files;
          transfer.items.add(new File([], 'pending.pdf', { type: 'application/pdf' }));
          Object.defineProperty(transfer, 'files', { value: empty });
        }
        const event = new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX: x,
          clientY: y,
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      send('dragenter', false);
      const over = send('dragover', false);
      const hinted = document.body.classList.contains('dropping');
      const hint = getComputedStyle(document.body, ':after').content;
      return { over, hinted, hint, opened: send('drop', true) };
    },
    Buffer.from(await dropped.save()).toString('base64'),
  );
  // Without a cancelled dragover the browser navigates the tab to the file instead.
  expect(drag.over).toBe(true);
  expect(drag.hinted).toBe(true);
  // Pictures are opened the same way, so the hint names them too.
  expect(drag.hint).toContain('pictures');
  expect(drag.opened).toBe(true);
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(page.locator('body.dropping')).toHaveCount(0);
});

test('documents, edits, and draft previews share one PDF.js worker', async ({ page }) => {
  await mockPuter(page);
  await page.addInitScript(() => {
    window.workersStarted = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        window.workersStarted++;
      }
    };
  });
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(2));
  const started = () => page.evaluate(() => window.workersStarted);
  expect(await started()).toBe(1);
  await page.getByRole('button', { name: 'Shape', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Edit text: Page 1 words', exact: true }).click();
  await expect(page.locator('.text-draft-background')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  // Every reload and preview reused the worker that opened the document.
  expect(await started()).toBe(1);
  // The worker outlives the editor: the next document reuses it too.
  await page.getByRole('button', { name: 'Back to your PDFs', exact: true }).click();
  await openPdf(page, await multiPagePdf(1));
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit text: Page 1 words', exact: true }),
  ).toBeEnabled();
  expect(await started()).toBe(1);
});

test('find reuses extracted page text and still sees edits made afterwards', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(3));
  // Count text extractions through the worker traffic they cause.
  await page.evaluate(() => {
    window.textRequests = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message?.action === 'GetTextContent') window.textRequests++;
      return post.call(this, message, ...rest);
    };
  });
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  const input = page.getByRole('searchbox', { name: 'Find in PDF' });
  const count = page.locator('.search-count');
  await input.fill('page 3');
  await expect(count).toHaveText('1 of 1');
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
  const extracted = await page.evaluate(() => window.textRequests);
  expect(extracted).toBeGreaterThan(0);
  await input.fill('words');
  // Find starts at the current page, which is now the last one.
  await expect(count).toHaveText('3 of 3');
  await input.fill('zebra');
  await expect(count).toHaveText('No matches');
  // Later queries search the text already extracted instead of asking the worker again.
  expect(await page.evaluate(() => window.textRequests)).toBe(extracted);
  await page.getByRole('button', { name: 'Close search', exact: true }).click();
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await page.getByRole('textbox', { name: 'Text to add', exact: true }).fill('A zebra appears');
  await clickAway(page);
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  await input.fill('zebra');
  // The edit changed the document, so the search reads the page text again.
  await expect(count).toHaveText('1 of 1');
  await expect(page.locator('.search-hit')).toHaveText(['zebra']);
});

test('the annotation color follows tool changes while highlights keep their own', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  const swatch = page.getByLabel('Annotation color', { exact: true });
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await expect(swatch).toHaveValue('#111111');
  await swatch.fill('#cc2200');
  await page.getByRole('button', { name: 'Shape', exact: true }).click();
  await expect(swatch).toHaveValue('#cc2200');
  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  await expect(swatch).toHaveValue('#f2c438');
  await swatch.fill('#00ccff');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(swatch).toHaveValue('#cc2200');
  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  await expect(swatch).toHaveValue('#00ccff');
  // Marks are drawn with the remembered color, not the tool's default.
  await page.getByRole('button', { name: 'Shape', exact: true }).click();
  await page.getByRole('button', { name: 'Place at page center', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const exported = await PDFDocument.load(await readFile(await (await pending).path()));
  const shapes = inspectPaths(exported, 0).filter((entry) => entry.kind === 'shape');
  expect(shapes).toHaveLength(1);
  expect(pathColorHex(shapes[0].state.stroke)).toBe('#cc2200');
});

test('the page area stays empty until the first page has its size', async ({ page }) => {
  await mockPuter(page);
  let releaseWorker;
  const gate = new Promise((resolve) => {
    releaseWorker = resolve;
  });
  await page.route('**/pdf-worker*.js*', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('/#library');
  try {
    await page.getByRole('button', { name: 'New blank PDF' }).click();
    await expect(page.locator('.save-status')).toHaveText('Opening PDF…');
    // No blank rectangle of the canvas's default size stands in for the page while it loads.
    await expect(page.locator('.paper')).toBeHidden();
    releaseWorker();
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
    await expect(page.locator('.paper')).toBeVisible();
    const width = await page
      .locator('.paper')
      .evaluate((node) => node.getBoundingClientRect().width);
    expect(width).toBeGreaterThan(300);
  } finally {
    releaseWorker();
  }
});

test('printing shows the current page alone, scaled to the paper width', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(2));
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await page.emulateMedia({ media: 'print' });
  for (const chrome of ['.topbar', '.toolbar', '.statusbar', '.page-sidebar', '.page-caption'])
    await expect(page.locator(chrome)).toBeHidden();
  await expect(page.locator('.textLayer')).toBeHidden();
  const layout = await page.evaluate(() => {
    const paper = document.querySelector('.paper'),
      canvas = paper.querySelector('canvas'),
      main = document.querySelector('.editor-main');
    return {
      paper: paper.getBoundingClientRect(),
      canvas: canvas.getBoundingClientRect(),
      main: main.getBoundingClientRect(),
      fit: getComputedStyle(canvas).objectFit,
      sheet: innerHeight,
    };
  });
  // The page fills the sheet's width and height and is letterboxed inside, not stretched.
  expect(layout.paper.width).toBeCloseTo(layout.main.width, 0);
  expect(layout.canvas.width).toBeCloseTo(layout.paper.width, 0);
  expect(layout.canvas.height).toBeCloseTo(layout.sheet, 0);
  expect(layout.fit).toBe('contain');
  // The printed page is the one on screen.
  await expect(page.locator('.sr-only[aria-label="Page text"]')).toContainText('Page 2 words');
  await page.emulateMedia({ media: 'screen' });
  await expect(page.locator('.toolbar')).toBeVisible();
});

test('the page sits on whole device pixels however the spare width divides', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([700, 700]);
  await openPdf(page, doc);
  await page.getByLabel('Zoom', { exact: true }).selectOption('0.5');
  await expect(page.locator('.paper')).toHaveCSS('width', '350px');
  const placement = () =>
    page.locator('.paper').evaluate((node) => {
      const ratio = window.devicePixelRatio || 1;
      const wrap = node.parentElement.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      const devicePixelLeft = rect.left * ratio;
      return {
        // Layout positions are kept in 1/64 px, so allow that much rounding residue.
        offGrid: Math.abs(devicePixelLeft - Math.round(devicePixelLeft)),
        offCenter: rect.left - (wrap.left + (wrap.width - rect.width) / 2),
      };
    });
  const width = page.viewportSize().width;
  // Both parities of the spare width: one of them centers the page on a half pixel.
  for (const next of [width, width - 1, width]) {
    await page.setViewportSize({ width: next, height: 800 });
    await expect.poll(async () => (await placement()).offGrid).toBeLessThan(0.1);
    expect(Math.abs((await placement()).offCenter)).toBeLessThanOrEqual(0.5);
  }
});

const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const LISTED_ZOOMS = ['0.5', '0.75', '1', '1.25', '1.5', '2', '3', '4'];
const zoomAbove = (zoom) => ZOOM_LEVELS.find((level) => level > zoom * 1.01);
const zoomBelow = (zoom) => ZOOM_LEVELS.filter((level) => level < zoom / 1.01).at(-1);

test('the zoom buttons step through fixed levels and the menu names an unlisted zoom', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  const zoom = page.getByLabel('Zoom', { exact: true }),
    paper = page.locator('.paper');
  const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true }),
    zoomOut = page.getByRole('button', { name: 'Zoom out', exact: true });
  await expect(zoom).toHaveValue('fit');
  const fit = (await paper.evaluate((node) => parseFloat(node.style.width))) / 400;
  const up = zoomAbove(fit);
  await zoomIn.click();
  await expect(zoom).toHaveValue(String(up));
  await expect
    .poll(() => paper.evaluate((node) => node.getBoundingClientRect().width))
    .toBeCloseTo(400 * up, 1);
  // Levels without a fixed menu entry get a temporary one that leaves with them.
  const custom = zoom.locator('option[data-custom]');
  if (LISTED_ZOOMS.includes(String(up))) await expect(custom).toHaveCount(0);
  else await expect(custom).toHaveText(`${Math.round(up * 100)}%`);
  await zoomOut.click();
  const down = zoomBelow(up);
  await expect(zoom).toHaveValue(String(down));
  if (LISTED_ZOOMS.includes(String(down))) await expect(custom).toHaveCount(0);
  await zoomOut.click();
  await expect(zoom).toHaveValue(String(zoomBelow(down)));
  await expect
    .poll(() => paper.evaluate((node) => node.getBoundingClientRect().width))
    .toBeCloseTo(400 * zoomBelow(down), 1);
  await zoom.selectOption('4');
  await expect(paper).toHaveCSS('width', '1600px');
  await expect(zoomIn).toBeDisabled();
  await expect(zoomOut).toBeEnabled();
  await zoom.selectOption('fit');
  await expect
    .poll(() => paper.evaluate((node) => node.getBoundingClientRect().width))
    .toBeCloseTo(400 * fit, 1);
  await expect(zoomIn).toBeEnabled();
});

test('keyboard shortcuts zoom the page and return to fit width', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  const zoom = page.getByLabel('Zoom', { exact: true }),
    paper = page.locator('.paper');
  const fit = (await paper.evaluate((node) => parseFloat(node.style.width))) / 400;
  const up = zoomAbove(fit);
  await page.locator('.workspace').focus();
  await page.keyboard.press('ControlOrMeta+=');
  await expect(zoom).toHaveValue(String(up));
  await expect
    .poll(() => paper.evaluate((node) => node.getBoundingClientRect().width))
    .toBeCloseTo(400 * up, 1);
  await page.keyboard.press('ControlOrMeta+-');
  await page.keyboard.press('ControlOrMeta+-');
  await expect(zoom).toHaveValue(String(zoomBelow(zoomBelow(up))));
  await page.keyboard.press('ControlOrMeta+2');
  await expect(zoom).toHaveValue('fit');
  await expect
    .poll(() => paper.evaluate((node) => node.getBoundingClientRect().width))
    .toBeCloseTo(400 * fit, 1);
});

test('Ctrl + wheel zooms the page around the pointer instead of the browser', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([900, 1200]);
  await openPdf(page, doc);
  const zoom = page.getByLabel('Zoom', { exact: true }),
    paper = page.locator('.paper'),
    workspace = page.locator('.workspace');
  await zoom.selectOption('2');
  await expect(paper).toHaveCSS('width', '1800px');
  // A page larger than the view in both directions can keep any point in place.
  await workspace.evaluate((node) => {
    node.scrollLeft = 300;
    node.scrollTop = 400;
  });
  const view = await workspace.boundingBox();
  const pointer = { x: view.x + view.width / 2, y: view.y + view.height / 3 };
  const before = await paper.boundingBox();
  const anchor = [(pointer.x - before.x) / before.width, (pointer.y - before.y) / before.height];
  const ratio = await page.evaluate(() => window.devicePixelRatio);
  await page.mouse.move(pointer.x, pointer.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await expect(zoom).toHaveValue('2.5');
  await expect(paper).toHaveCSS('width', '2250px');
  // The page point that was under the pointer is still there after the zoom.
  const after = await paper.boundingBox();
  expect(after.x + anchor[0] * after.width).toBeCloseTo(pointer.x, 0);
  expect(after.y + anchor[1] * after.height).toBeCloseTo(pointer.y, 0);
  // The browser's own zoom did not change.
  expect(await page.evaluate(() => window.devicePixelRatio)).toBe(ratio);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 120);
  await page.keyboard.up('Control');
  await expect(zoom).toHaveValue('2');
});

test('fit page shows the whole page inside the workspace and follows its height', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 1000]);
  await openPdf(page, doc);
  const zoom = page.getByLabel('Zoom', { exact: true }),
    paper = page.locator('.paper'),
    workspace = page.locator('.workspace');
  await zoom.selectOption('page');
  // The sheet fills the workspace height apart from its padding and the caption below it.
  const fits = async () => {
    const [sheet, view] = await Promise.all([paper.boundingBox(), workspace.boundingBox()]);
    return sheet.height <= view.height && sheet.height >= view.height - 100;
  };
  await expect.poll(fits).toBe(true);
  expect(await workspace.evaluate((node) => node.scrollHeight - node.clientHeight)).toBe(0);
  await page.setViewportSize({ width: 1280, height: 500 });
  await expect.poll(fits).toBe(true);
  await expect(zoom).toHaveValue('page');
});

test('fit page keeps one zoom while scrolling through pages of different sizes', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  for (const size of [
    [400, 500],
    [400, 500],
    [900, 450],
    [900, 450],
    [400, 500],
  ])
    doc.addPage(size);
  await openPdf(page, doc);
  const workspace = page.locator('.workspace'),
    third = page.locator('.page-slot[data-page="2"]');
  await page.getByLabel('Zoom', { exact: true }).selectOption('page');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  // Every page fits the view, the wide ones as well as the tall ones.
  const view = await workspace.boundingBox();
  for (const slot of await page.locator('.page-slot').all()) {
    const box = await slot.boundingBox();
    expect(box.width).toBeLessThanOrEqual(view.width);
    expect(box.height).toBeLessThanOrEqual(view.height);
  }
  const width = (await third.boundingBox()).width;
  // Scrolling the third page to the top makes it the current page without a new zoom
  // moving it, or the pages after it, out from under the reader.
  await workspace.evaluate((node) => {
    const slot = node.querySelector('.page-slot[data-page="2"]');
    node.scrollTop += slot.getBoundingClientRect().top - node.getBoundingClientRect().top - 12;
  });
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 5');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  expect((await third.boundingBox()).width).toBeCloseTo(width, 0);
  expect((await third.boundingBox()).y - view.y).toBeCloseTo(12, 0);
  await expect(page.getByLabel('Zoom', { exact: true })).toHaveValue('page');
});

/** Choose a menu item by name from the menu bar, or from the folded phone menu. */
async function menu(page, name) {
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  const item = page.getByRole('menu').getByRole('menuitem', { name, exact: true });
  if (await bar.isVisible()) {
    for (const title of ['File', 'Edit', 'View', 'Page', 'Insert']) {
      await bar.getByRole('menuitem', { name: title, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  } else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    if (await item.count()) return item.click();
    for (const section of ['Edit', 'View', 'Page', 'Insert']) {
      await page.getByRole('menu').getByRole('menuitem', { name: section, exact: true }).click();
      if (await item.count()) return item.click();
      await page.keyboard.press('Escape');
    }
  }
  throw new Error(`No menu item named ${name}`);
}

for (const width of [1200, 390]) {
  test.describe(`menu Tab navigation at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });
    for (const key of ['Tab', 'Shift+Tab']) {
      test(`${key} closes menus and reaches the adjacent control`, async ({ page }) => {
        await mockPuter(page);
        await page.goto('/#library');
        await openPdf(page, await multiPagePdf(2));
        const opener =
          width === 1200
            ? page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true })
            : page.getByRole('button', { name: 'Menu', exact: true });
        // Establish the browser's normal tab destination with the menu closed.
        await opener.focus();
        await page.keyboard.press(key);
        await expect(opener).not.toBeFocused();
        // Safari may move backward into browser chrome, leaving the body active.
        const adjacent = await page.evaluateHandle(() => document.activeElement);
        await expect(opener).toHaveAttribute('aria-expanded', 'false');
        await opener.press('Enter');
        await expect(page.getByRole('menu', { name: 'File', exact: true })).toBeVisible();
        await expect(opener).toHaveAttribute('aria-expanded', 'true');
        if (width === 390) {
          await page.getByRole('menuitem', { name: 'View', exact: true }).press('Enter');
          await expect(page.getByRole('menu', { name: 'View', exact: true })).toBeVisible();
        }
        await page.keyboard.press(key);
        await expect(page.getByRole('menu')).toHaveCount(0);
        await expect(opener).toHaveAttribute('aria-expanded', 'false');
        await expect
          .poll(() => adjacent.evaluate((node) => node === document.activeElement))
          .toBe(true);
        await adjacent.dispose();
      });
    }
  });
}

test.describe('menu bar', () => {
  test.use({ viewport: { width: 1200, height: 800 } });
  test('the menu bar is one tab stop whose menus open, switch, and close from the keyboard', async ({
    page,
  }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await multiPagePdf(3));
    const bar = page.getByRole('menubar', { name: 'PDF menus' });
    await expect(bar.getByRole('menuitem')).toHaveText(['File', 'Edit', 'View', 'Page', 'Insert']);
    await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeHidden();
    const file = bar.getByRole('menuitem', { name: 'File', exact: true });
    await file.focus();
    await page.keyboard.press('ArrowRight');
    await expect(bar.getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    const editMenu = page.getByRole('menu', { name: 'Edit' });
    await expect(editMenu).toBeVisible();
    // Nothing has changed yet, so focus skips Undo/Redo and starts at Select all text.
    await expect(editMenu.getByRole('menuitem', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(editMenu.getByRole('menuitem', { name: 'Select all text' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(editMenu.getByRole('menuitem', { name: 'Find in PDF' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(editMenu).toBeHidden();
    await expect(page.getByRole('menu', { name: 'View' })).toBeVisible();
    await expect(
      page.getByRole('menuitemcheckbox', { name: 'Fit width', exact: true }),
    ).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(bar.getByRole('menuitem', { name: 'View', exact: true })).toBeFocused();
    // Clicking the open menu's name closes it instead of reopening it.
    await file.click();
    await expect(page.getByRole('menu', { name: 'File' })).toBeVisible();
    await file.click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    // A chosen item acts: View > Next page.
    await menu(page, 'Next page');
    await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('page items follow the current page and rotate both ways', async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await multiPagePdf(2));
    await page.getByRole('menubar').getByRole('menuitem', { name: 'Page', exact: true }).click();
    const pageMenu = page.getByRole('menu', { name: 'Page' });
    await expect(pageMenu.locator('.menu-header')).toHaveText('Page 1 of 2');
    await expect(pageMenu.getByRole('menuitem', { name: 'Move page earlier' })).toBeDisabled();
    await expect(pageMenu.getByRole('menuitem', { name: 'Move page later' })).toBeEnabled();
    await pageMenu.getByRole('menuitem', { name: 'Rotate counterclockwise' }).click();
    await expect(page.locator('.save-status')).toHaveText('Unsaved changes');
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const doc = await PDFDocument.load(await readFile(await (await pending).path()));
    expect(doc.getPage(0).getRotation().angle).toBe(270);
    expect(doc.getPage(1).getRotation().angle).toBe(0);
  });
});

test.describe('folded phone menu', () => {
  test.use({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
  for (const key of ['ArrowRight', 'Enter', 'Space']) {
    test(`${key} enters a submenu that the pointer already opened`, async ({ page }) => {
      await mockPuter(page);
      await page.goto('/#library');
      await openPdf(page, await multiPagePdf(2));
      // Open with the keyboard so focus has an explicit return target in every browser.
      await page.getByRole('button', { name: 'Menu', exact: true }).press('Enter');
      const parent = page.getByRole('menu', { name: 'File', exact: true });
      const opener = parent.getByRole('menuitem', { name: 'View', exact: true });
      await opener.hover();
      const child = page.getByRole('menu', { name: 'View', exact: true });
      await expect(child).toBeVisible();
      await expect(opener).toHaveAttribute('aria-expanded', 'true');
      await expect(opener).toBeFocused();
      await page.keyboard.press(key);
      await expect(
        child.getByRole('menuitemcheckbox', { name: 'Fit width', exact: true }),
      ).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(
        child.getByRole('menuitemcheckbox', { name: 'Fit page', exact: true }),
      ).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await expect(child).toBeHidden();
      await expect(opener).toHaveAttribute('aria-expanded', 'false');
      await expect(opener).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(parent).toBeHidden();
      await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeFocused();
    });
  }
  test('one button holds the file actions and the other menus as submenus', async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await multiPagePdf(2));
    await expect(page.getByRole('menubar')).toBeHidden();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const fileMenu = page.getByRole('menu', { name: 'File' });
    await expect(fileMenu.getByRole('menuitem', { name: 'Download', exact: true })).toBeVisible();
    await fileMenu.getByRole('menuitem', { name: 'Page', exact: true }).click();
    const pageMenu = page.getByRole('menu', { name: 'Page' });
    await expect(pageMenu).toBeVisible();
    await expect(pageMenu).toBeInViewport({ ratio: 1 });
    await pageMenu.getByRole('menuitem', { name: 'Insert blank page after' }).click();
    await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
});

test('Go to page jumps to the entered page', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(4));
  await menu(page, 'Go to page…');
  const input = page.getByLabel('Page number (1 to 4)');
  await input.fill('3');
  await input.press('Enter');
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 4');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('extracted pages keep hidden PDF layers hidden after download and reopening', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([200, 200]);
  const hidden = doc.context.register(
    doc.context.obj({ Type: 'OCG', Name: PDFString.of('Hidden artwork') }),
  );
  doc.catalog.set(
    PDFName.of('OCProperties'),
    doc.context.obj({ OCGs: [hidden], D: { OFF: [hidden], Order: [hidden] } }),
  );
  sheet.node.set(PDFName.of('Resources'), doc.context.obj({ Properties: { Hidden: hidden } }));
  sheet.node.set(
    PDFName.of('Contents'),
    doc.context.register(doc.context.flateStream('/OC /Hidden BDC 1 0 0 rg 0 0 200 200 re f EMC')),
  );
  await openPdf(page, doc);
  const center = () =>
    page
      .locator('.paper > canvas')
      .first()
      .evaluate((canvas) =>
        Array.from(
          canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data,
        ),
      );
  await expect.poll(center).toEqual([255, 255, 255, 255]);
  await menu(page, 'Extract pages…');
  const pending = page.waitForEvent('download');
  await page
    .getByRole('dialog', { name: 'Extract pages' })
    .getByRole('button', { name: 'Download pages' })
    .click();
  const bytes = await readFile(await (await pending).path());
  // Return to the library and reopen the downloaded bytes through the normal file picker.
  await page.goto('/#library');
  const saved = await PDFDocument.load(bytes);
  await openPdf(page, saved, 'extracted.pdf');
  await expect.poll(center).toEqual([255, 255, 255, 255]);
  expect(saved.catalog.has(PDFName.of('OCProperties'))).toBe(true);
});

test('Extract pages downloads the chosen pages as a new PDF', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(4));
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 4');
  await menu(page, 'Extract pages…');
  const dialog = page.getByRole('dialog', { name: 'Extract pages' });
  await expect(dialog.getByLabel('Current page (2)')).toBeChecked();
  // Typing a range chooses the range option by itself.
  await dialog.getByLabel('Page range', { exact: true }).fill('4, 1-2');
  await expect(dialog.getByLabel('Pages', { exact: true })).toBeChecked();
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download pages' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('test pages 4, 1-2.pdf');
  const doc = await PDFDocument.load(await readFile(await download.path()));
  expect(doc.getPageCount()).toBe(3);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#toast')).toHaveText('Pages 4, 1-2 downloaded as a new PDF.');
  // The open document is untouched.
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 4');
  await expect(page.locator('.save-status')).toHaveText('Local file');
  // A bad range is explained inside the dialog.
  await menu(page, 'Extract pages…');
  await page.getByLabel('Page range', { exact: true }).fill('9');
  await page.getByRole('button', { name: 'Download pages' }).click();
  await expect(page.locator('.dialog-error')).toHaveText('Pages must be between 1 and 4.');
});

test('find counts every match and steps through several on one page before moving on', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([400, 400]);
  first.drawText('apple pie, apple tart', { x: 40, y: 320, size: 18, font });
  first.drawText('one more apple', { x: 40, y: 80, size: 18, font });
  doc.addPage([400, 400]).drawText('the last apple', { x: 40, y: 300, size: 18, font });
  await openPdf(page, doc);
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('searchbox', { name: 'Find in PDF' });
  await find.fill('apple');
  await expect(page.locator('.search-count')).toHaveText('1 of 4');
  const hits = page.locator('.search-hit');
  await expect(hits).toHaveCount(3);
  await expect(page.locator('.search-hit-current')).toHaveText('apple');
  await expect(hits.nth(0)).toHaveClass(/search-hit-current/);
  await find.press('Enter');
  await expect(page.locator('.search-count')).toHaveText('2 of 4');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(hits.nth(1)).toHaveClass(/search-hit-current/);
  await expect(hits.nth(0)).not.toHaveClass(/search-hit-current/);
  await find.press('Enter');
  await expect(page.locator('.search-count')).toHaveText('3 of 4');
  await expect(hits.nth(2)).toHaveClass(/search-hit-current/);
  await find.press('Enter');
  await expect(page.locator('.search-count')).toHaveText('4 of 4');
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await expect(page.locator('.search-hit-current')).toHaveCount(1);
  await find.press('Shift+Enter');
  await expect(page.locator('.search-count')).toHaveText('3 of 4');
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(hits.nth(2)).toHaveClass(/search-hit-current/);
  // The browser's find-next keys work from the page as well as the search box.
  await page.locator('.workspace').focus();
  await page.keyboard.press('ControlOrMeta+g');
  await expect(page.locator('.search-count')).toHaveText('4 of 4');
  await page.keyboard.press('F3');
  await expect(page.locator('.search-count')).toHaveText('1 of 4');
  await page.keyboard.press('Shift+ControlOrMeta+g');
  await expect(page.locator('.search-count')).toHaveText('4 of 4');
  await find.fill('pear');
  await expect(page.locator('.search-count')).toHaveText('No matches');
  await expect(hits).toHaveCount(0);
});

/** Flip the View menu's Dark page colors item, on the menu bar or in the folded phone menu. */
async function toggleDarkPages(page) {
  const bar = page.getByRole('menubar', { name: 'PDF menus' });
  if (await bar.isVisible()) await bar.getByRole('menuitem', { name: 'View', exact: true }).click();
  else {
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'View', exact: true }).click();
  }
  await page.getByRole('menuitemcheckbox', { name: 'Dark page colors', exact: true }).click();
}

test('dark page colors invert the page, persist across reloads, and switch back off', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  const canvas = page.locator('.paper > canvas').first();
  await expect(canvas).toHaveCSS('filter', 'none');
  await toggleDarkPages(page);
  await expect(page.locator('.editor')).toHaveClass(/dark-pages/);
  await expect(canvas).toHaveCSS('filter', /invert\(1\)/);
  await expect(page.locator('.paper > canvas').first()).toBeVisible();
  await page.reload();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 1');
  await expect(page.locator('.editor')).toHaveClass(/dark-pages/);
  await toggleDarkPages(page);
  await expect(page.locator('.editor')).not.toHaveClass(/dark-pages/);
  await expect(canvas).toHaveCSS('filter', 'none');
});

test('dark page colors also invert the page preview shown while an object moves', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await imagePdf());
  await toggleDarkPages(page);
  await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
  const move = page.getByRole('button', { name: 'Move selected image', exact: true });
  await expect(move).toBeFocused();
  await page.keyboard.down('ArrowRight');
  const preview = page.locator('.image-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveCSS('filter', /invert\(1\)/);
  await page.keyboard.up('ArrowRight');
});

test('the browser print command prints the page in its own colors with dark pages on', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(1));
  await toggleDarkPages(page);
  const canvas = page.locator('.paper > canvas').first();
  await expect(canvas).toHaveCSS('filter', /invert\(1\)/);
  await page.emulateMedia({ media: 'print' });
  await expect(canvas).toHaveCSS('filter', 'none');
  await expect(page.locator('.paper').first()).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});

test('the selected image shows keyboard focus on its move control', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await imagePdf());
  await page.getByRole('button', { name: 'Select image 1', exact: true }).click();
  const move = page.getByRole('button', { name: 'Move selected image', exact: true });
  await expect(move).toBeFocused();
  const box = await move.boundingBox();
  const middle = {
    x: box.x + box.width / 4,
    y: box.y + box.height / 4,
    width: box.width / 2,
    height: box.height / 2,
  };
  await page.keyboard.press('Tab');
  await expect(move).not.toBeFocused();
  const blurred = await page.screenshot({ clip: middle });
  await page.keyboard.press('Shift+Tab');
  await expect(move).toBeFocused();
  expect((await page.screenshot({ clip: middle })).equals(blurred)).toBe(false);
});

test('Escape on a selected image closes its controls and hands focus back to the image', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await imagePdf());
  const target = page.getByRole('button', { name: 'Select image 1', exact: true });
  await target.click();
  const move = page.getByRole('button', { name: 'Move selected image', exact: true });
  await expect(move).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(move).toBeHidden();
  await expect(target).toBeFocused();
  await expect(target).toHaveAttribute('aria-pressed', 'false');
});

test('a checkbox group ticks one box at a time on the page and saves the chosen value', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const sheet = doc.addPage([300, 300]);
  const box = doc.getForm().createCheckBox('gender');
  box.addToPage(sheet, { x: 20, y: 200, width: 20, height: 20 });
  box.addToPage(sheet, { x: 120, y: 200, width: 20, height: 20 });
  box.acroField.getWidgets().forEach((widget, i) => {
    const normal = widget.getAppearances().normal;
    const on = normal.get(PDFName.of('Yes'));
    normal.delete(PDFName.of('Yes'));
    normal.set(PDFName.of(i ? 'F' : 'M'), on);
    widget.setAppearanceState(PDFName.of('Off'));
  });
  box.acroField.dict.set(PDFName.of('V'), PDFName.of('Off'));
  await openPdf(page, doc);
  const m = page.getByRole('checkbox', { name: 'gender: M (on page)' });
  const f = page.getByRole('checkbox', { name: 'gender: F (on page)' });
  await expect(m).not.toBeChecked();
  await expect(f).not.toBeChecked();
  await f.check();
  await expect(f).toBeChecked();
  await expect(m).not.toBeChecked();
  // Ticking the other box moves the choice; unticking leaves none.
  await m.check();
  await expect(m).toBeChecked();
  await expect(f).not.toBeChecked();
  await m.uncheck();
  await expect(m).not.toBeChecked();
  await expect(f).not.toBeChecked();
  await f.check();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const saved = await PDFDocument.load(await readFile(await (await pending).path()));
  const field = saved.getForm().getCheckBox('gender');
  expect(field.acroField.getValue().decodeText()).toBe('F');
  expect(
    field.acroField.getWidgets().map((widget) => widget.getAppearanceState()?.decodeText()),
  ).toEqual(['Off', 'F']);
});

test('every control sits inside a landmark and each view has one first-level heading', async ({
  page,
}) => {
  await mockPuter(page);
  const landmarks = async () =>
    (
      await new AxeBuilder({ page })
        .withRules(['region', 'page-has-heading-one', 'landmark-one-main'])
        .analyze()
    ).violations;
  await page.goto('/#library');
  await expect(page.getByRole('heading', { level: 1, name: 'PDF Editor' })).toBeVisible();
  expect(await landmarks()).toEqual([]);
  await openPdf(page, await multiPagePdf());
  // The open document names the editor view.
  await expect(page.getByRole('heading', { level: 1, name: /test/ })).toBeVisible();
  expect(await landmarks()).toEqual([]);
  // The tool bars and the tool's own options belong to the banner, whichever tool is chosen.
  await page.getByRole('button', { name: 'Shape', exact: true }).click();
  await expect(page.getByLabel('Shape type')).toBeVisible();
  expect(await landmarks()).toEqual([]);
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Find in PDF' })).toBeVisible();
  expect(await landmarks()).toEqual([]);
});

test('a dialog taller than a short window keeps its title and buttons in place', async ({
  page,
}) => {
  await mockPuter(page);
  await page.setViewportSize({ width: 1000, height: 520 });
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf());
  await menu(page, 'Header and footer…');
  const dialog = page.getByRole('dialog', { name: 'Header and footer' });
  await expect(dialog).toBeVisible();
  const body = dialog.locator('.dialog-body');
  // The body is what scrolls; the dialog itself stays put.
  expect(await body.evaluate((n) => n.scrollHeight > n.clientHeight + 1)).toBe(true);
  const inWindow = async (locator) =>
    locator.evaluate((n) => {
      const b = n.getBoundingClientRect();
      return b.top >= 0 && b.bottom <= window.innerHeight + 1 && b.height > 0;
    });
  const apply = dialog.getByRole('button', { name: /Add header and footer/ });
  const close = dialog.getByRole('button', { name: 'Close dialog', exact: true });
  expect(await inWindow(apply)).toBe(true);
  expect(await inWindow(close)).toBe(true);
  // Scrolling to the end of the body leaves both where they were.
  await body.evaluate((n) => n.scrollTo(0, n.scrollHeight));
  expect(await inWindow(apply)).toBe(true);
  expect(await inWindow(close)).toBe(true);
  expect(await dialog.evaluate((n) => n.scrollTop)).toBe(0);
  await dialog.getByLabel('Top left', { exact: true }).fill('Report');
  await apply.click();
  await expect(page.locator('#toast')).toHaveText(/header|footer/i);
});

test('a text draft opened at a high zoom keeps its properties in view', async ({ page }) => {
  await mockPuter(page);
  await page.setViewportSize({ width: 390, height: 740 });
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('Editable line near the top', { x: 20, y: 752, size: 11, font });
  await openPdf(page, doc);
  await page.getByLabel('Zoom', { exact: true }).selectOption('4');
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await page.locator('.text-targets button').first().click();
  const properties = page.getByRole('group', { name: 'Text properties', exact: true });
  await expect(properties).toBeVisible();
  // Actions stay in the dock even when the page itself is much wider than the viewport.
  await expect(properties.getByLabel('Text X in points')).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Apply text', exact: true })).toHaveCount(0);
  const draft = page.getByRole('textbox', { name: 'Edit text', exact: true });
  expect(
    await draft.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const view = document.querySelector('.workspace').getBoundingClientRect();
      // A line wider than the viewport remains horizontally pannable. Its editing
      // surface must intersect the view and stay vertically clear of the dock.
      return (
        box.right > view.left &&
        box.left < view.right &&
        box.top >= view.top - 1 &&
        box.bottom <= view.bottom + 1
      );
    }),
  ).toBe(true);
});

test('a second press while a save or a download is under way does not repeat it', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(2));
  // Count what reaches the cloud, with a write slow enough to press again during.
  await page.evaluate(() => {
    window.writes = [];
    window.puter.fs.write = async (path) => {
      window.writes.push(path);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { path, name: path.split('/').pop() };
    };
  });
  const press = (label) =>
    page.evaluate((name) => {
      const button = [...document.querySelectorAll('button')].find(
        (node) => node.getAttribute('aria-label') === name,
      );
      button.click();
      button.click();
    }, label);
  await press('Save to Puter');
  await expect(page.locator('#toast')).toHaveText('Saved to Puter as test.pdf.');
  await expect(page.locator('.save-status')).toHaveText('Saved to Puter');
  expect(await page.evaluate(() => window.writes)).toEqual(['PDF Editor/test.pdf']);
  // The same for the download: one press, one file.
  const downloads = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  await press('Download');
  await expect(page.locator('#toast')).toHaveText('PDF downloaded.');
  await page.waitForTimeout(500);
  expect(downloads).toEqual(['test.pdf']);
});

test('a file dropped while a dialog is open is refused, not opened behind it', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(2));
  await menu(page, 'Watermark…');
  const dialog = page.getByRole('dialog', { name: 'Add watermark' });
  await expect(dialog).toBeVisible();
  await dialog.locator('#watermark-text').fill('MY DRAFT');
  const other = await multiPagePdf(5);
  const drag = await page.evaluate(
    (base64) => {
      const send = (type, withFile) => {
        const transfer = new DataTransfer();
        if (withFile)
          transfer.items.add(
            new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'other.pdf', {
              type: 'application/pdf',
            }),
          );
        else transfer.items.add('', 'Files');
        const event = new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      };
      send('dragenter', false);
      const over = send('dragover', false);
      const hinted = document.body.classList.contains('dropping');
      return { over, hinted, dropped: send('drop', true) };
    },
    Buffer.from(await other.save()).toString('base64'),
  );
  // The drop is still cancelled, or the browser would leave the app and show the file.
  expect(drag.dropped).toBe(true);
  expect(drag.hinted).toBe(false);
  // The document behind the dialog is untouched, and the dialog says why.
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(dialog.getByRole('alert')).toHaveText('Close this dialog to open a dropped file.');
  await expect(dialog.locator('#watermark-text')).toHaveValue('MY DRAFT');
  // The dialog still belongs to the document it was opened over.
  await dialog.getByRole('button', { name: 'Add watermark', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Watermark added to 2 pages.');
});

test('Select all takes the page text, not the application around it', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await multiPagePdf(2));
  const selected = () => page.evaluate(() => window.getSelection().toString());
  await page.locator('.workspace').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ControlOrMeta+a');
  expect(await selected()).toBe('Page 1 words');
  // It follows the page on view.
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  await page.keyboard.press('ControlOrMeta+a');
  expect(await selected()).toBe('Page 2 words');
  // The Edit menu offers it with the same shortcut.
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await menu(page, 'Select all text');
  expect(await selected()).toBe('Page 2 words');
  // What it selects can be marked up, as a dragged selection can.
  await page.getByRole('button', { name: 'Highlight', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+a');
  const apply = page.getByRole('button', { name: 'Highlight selection', exact: true });
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(page.locator('.highlight-target')).toHaveCount(1);
  // A field with the focus keeps its own Select All, and the page keeps its text unselected.
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  const find = page.getByRole('searchbox', { name: 'Find in PDF' });
  await find.fill('words');
  await find.press('ControlOrMeta+a');
  expect(await find.evaluate((node) => [node.selectionStart, node.selectionEnd])).toEqual([0, 5]);
});

test.describe('at the narrow layout breakpoint', () => {
  test.use({ viewport: { width: 760, height: 800 } });
  test('the side panel starts closed instead of covering the page', async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await multiPagePdf(2));
    await expect(page.locator('#page-sidebar')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Toggle pages panel' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
});

test('choosing several PDFs opens the first and says what became of the others', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles([
    {
      name: 'first.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await (await multiPagePdf(2)).save()),
    },
    {
      name: 'second.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await (await multiPagePdf(5)).save()),
    },
  ]);
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  await expect(page.locator('#toast')).toHaveText(
    'Opened first.pdf. One PDF opens at a time; to put several files into one PDF, use Combine files in Tools.',
  );
});

test('an error message stays until the reader carries on', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Open a PDF/ }).click();
  await (
    await chooser
  ).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a PDF') });
  const toast = page.locator('#toast');
  await expect(toast).toHaveText('Choose a PDF, or PNG and JPEG pictures.');
  // Longer than an ordinary message lasts: an error waits to be read.
  await page.waitForTimeout(7000);
  await expect(toast).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search PDFs' }).click();
  await expect(toast).toBeHidden();
});
