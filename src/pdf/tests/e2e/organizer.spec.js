import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { readFile } from 'node:fs/promises';

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
/** Three pages of one width and different heights, so the visible page is recognizable. */
const HEIGHTS = [300, 350, 400];
async function tallPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  HEIGHTS.forEach((height, i) =>
    doc.addPage([400, height]).drawText(`Page ${i + 1}`, { x: 40, y: 100, size: 20, font }),
  );
  return doc;
}
async function exportedHeights(page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const doc = await PDFDocument.load(await readFile(await (await pending).path()));
  return doc.getPages().map((p) => [p.getHeight(), p.getRotation().angle]);
}
async function showPanel(page) {
  if (!(await page.locator('#page-sidebar').isVisible()))
    await page.getByRole('button', { name: 'Toggle pages panel' }).click();
}
const settled = (page) => expect(page.locator('.editor')).toHaveAttribute('aria-busy', 'false');

test('dragging a thumbnail reorders the pages and the view follows the moved page', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await tallPdf());
  await showPanel(page);
  const items = page.locator('.thumb-item');
  await expect(items).toHaveCount(3);
  const first = await items.nth(0).boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2 + 12, { steps: 3 });
  await expect(page.locator('.thumb-drop')).toBeAttached();
  // Keep the release inside the browser viewport; Firefox cannot deliver a mouse-up below it.
  await page.locator('.thumbnails').evaluate((node) => (node.scrollTop = node.scrollHeight));
  const last = await items.nth(2).boundingBox();
  await page.mouse.move(last.x + last.width / 2, last.y + last.height - 4, { steps: 6 });
  await page.mouse.up();
  await settled(page);
  // The page that was dragged is still the one on view, now last.
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
  await expect(page.locator('.thumbnail').nth(2)).toHaveAttribute('aria-current', 'page');
  expect((await exportedHeights(page)).map(([h]) => h)).toEqual([350, 400, 300]);
  // Escape gives a drag up without changing anything, and the release is not a click.
  const second = await items.nth(1).boundingBox();
  await page.mouse.move(second.x + second.width / 2, second.y + second.height / 2);
  await page.mouse.down();
  await page.mouse.move(second.x + second.width / 2, second.y - 20, { steps: 4 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.thumb-drop')).toHaveCount(0);
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
  expect((await exportedHeights(page)).map(([h]) => h)).toEqual([350, 400, 300]);
});

test('releasing a thumbnail press outside the panel cannot start a later hover drag', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await tallPdf());
  await showPanel(page);
  const panel = page.locator('.thumbnails');
  const first = await page.locator('.thumb-item').first().boundingBox();
  const bounds = await panel.boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  // A fast move can leave the panel before another pointermove reaches its children.
  await page.mouse.move(bounds.x + bounds.width + 40, first.y + first.height / 2);
  await page.mouse.up();
  const last = await page.locator('.thumb-item').last().boundingBox();
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
  await expect(panel).not.toHaveClass(/reordering/);
  await expect(page.locator('.thumb-drop')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Go to page 2', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
  expect((await exportedHeights(page)).map(([height]) => height)).toEqual(HEIGHTS);
});

for (const stage of ['press', 'drag'])
  test(`Escape cancels a thumbnail ${stage} until the mouse is released`, async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await tallPdf());
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
    await showPanel(page);
    const first = page.getByRole('button', { name: 'Go to page 1', exact: true });
    await first.scrollIntoViewIfNeeded();
    const box = await first.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    if (stage === 'drag') {
      await page.mouse.move(x, y + 12, { steps: 3 });
      await expect(page.locator('.thumb-drop')).toBeAttached();
    }
    await page.keyboard.press('Escape');
    // Cancellation must survive a held mouse button, including later motion and release.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.mouse.move(x, y + 16);
    await expect(page.locator('.thumbnails')).not.toHaveClass(/reordering/);
    await page.mouse.up();
    await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await expect(page.locator('#page-sidebar')).toBeVisible();
    await first.click();
    await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
    expect((await exportedHeights(page)).map(([height]) => height)).toEqual(HEIGHTS);
  });

test('each thumbnail has a menu for its own page, on a button and on right click', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await tallPdf());
  await showPanel(page);
  await page.locator('.thumb-item').nth(1).hover();
  await page.getByRole('button', { name: 'Page 2 actions', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Page 2' });
  await expect(menu.locator('.menu-header')).toHaveText('Page 2 of 3');
  await menu.getByRole('menuitem', { name: 'Rotate clockwise' }).click();
  await settled(page);
  // The page on view did not change, and the rebuilt list gives the focus back to the menu
  // button it came from.
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
  await expect(page.getByRole('button', { name: 'Page 2 actions', exact: true })).toBeFocused();
  await page.locator('.thumb-item').nth(2).click({ button: 'right' });
  const third = page.getByRole('menu', { name: 'Page 3' });
  await expect(third).toBeVisible();
  const pending = page.waitForEvent('download');
  await third.getByRole('menuitem', { name: 'Extract this page' }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('test page 3.pdf');
  const extracted = await PDFDocument.load(await readFile(await download.path()));
  expect(extracted.getPageCount()).toBe(1);
  expect(extracted.getPage(0).getHeight()).toBe(400);
  expect(await exportedHeights(page)).toEqual([
    [300, 0],
    [350, 90],
    [400, 0],
  ]);
});

test("another page's menu inserts pages after that page and keeps the current page in view", async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await tallPdf());
  await showPanel(page);
  // A blank page after page 3 while reading page 1: the view stays on page 1.
  await page.locator('.thumb-item').nth(2).hover();
  await page.getByRole('button', { name: 'Page 3 actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Insert blank page after' }).click();
  await settled(page);
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 4');
  // A duplicate of page 1 while reading page 3 (the 400 pt page): the view keeps that page.
  await page.getByRole('button', { name: 'Go to page 3', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 4');
  await showPanel(page);
  await page.locator('.thumb-item').nth(0).hover();
  await page.getByRole('button', { name: 'Page 1 actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Duplicate page' }).click();
  await settled(page);
  await expect(page.locator('.page-caption')).toHaveText('Page 4 of 5');
  // Pictures go after the page whose menu was used, not after the page being read.
  await page.locator('.thumb-item').nth(1).hover();
  await page.getByRole('button', { name: 'Page 2 actions', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Insert pictures as pages…' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await settled(page);
  await expect(page.locator('.page-caption')).toHaveText('Page 5 of 6');
  const heights = (await exportedHeights(page)).map(([h]) => h);
  expect(heights.slice(0, 2)).toEqual([300, 300]);
  expect(heights[2]).toBeGreaterThan(700);
  expect(heights.slice(3)).toEqual([350, 400, 400]);
});

test('a drag parked at the panel edge keeps the list scrolling', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Fingers scroll the panel; only mice and pens drag pages');
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 30; i++) doc.addPage([400, 400]);
  await openPdf(page, doc);
  await showPanel(page);
  const panel = page.locator('.thumbnails');
  const first = await page.locator('.thumb-item').first().boundingBox();
  const bounds = await panel.boundingBox();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2 + 20, { steps: 3 });
  await page.mouse.move(first.x + first.width / 2, bounds.y + bounds.height - 10, { steps: 3 });
  await expect(panel).toHaveClass(/reordering/);
  const start = await panel.evaluate((node) => node.scrollTop);
  // The pointer holds still; the panel goes on scrolling by itself.
  await expect.poll(() => panel.evaluate((node) => node.scrollTop)).toBeGreaterThan(start + 200);
  await page.keyboard.press('Escape');
  await expect(panel).not.toHaveClass(/reordering/);
  await page.mouse.up();
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 30');
});

test('deleting or moving another page keeps the current page in view', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await tallPdf());
  await showPanel(page);
  await page.getByRole('button', { name: 'Go to page 3', exact: true }).click();
  await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
  // On a phone choosing a page closes the panel; bring it back for the menus.
  await showPanel(page);
  const paper = page.locator('.paper');
  const height = (await paper.boundingBox()).height;
  await page.locator('.thumb-item').nth(0).hover();
  await page.getByRole('button', { name: 'Page 1 actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete page' }).click();
  await page.getByRole('button', { name: 'Delete page', exact: true }).last().click();
  await settled(page);
  await expect(page.locator('.page-caption')).toHaveText('Page 2 of 2');
  expect((await paper.boundingBox()).height).toBeCloseTo(height, 0);
  // Moving the other page below this one shifts the view's index, not its page.
  await page.locator('.thumb-item').nth(0).hover();
  await page.getByRole('button', { name: 'Page 1 actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Move page later' }).click();
  await settled(page);
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 2');
  expect((await paper.boundingBox()).height).toBeCloseTo(height, 0);
  expect((await exportedHeights(page)).map(([h]) => h)).toEqual([400, 350]);
});

test.describe('touch', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 780 } });
  test('a tap still opens a page and the page menu works by touch', async ({ page }) => {
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await tallPdf());
    await showPanel(page);
    await page.locator('.thumbnail').nth(1).tap();
    await expect(page.locator('.page-caption')).toHaveText('Page 2 of 3');
    await showPanel(page);
    await page.getByRole('button', { name: 'Page 3 actions', exact: true }).tap();
    await page.getByRole('menuitem', { name: 'Move page earlier' }).tap();
    await settled(page);
    await expect(page.locator('.page-caption')).toHaveText('Page 3 of 3');
    expect((await exportedHeights(page)).map(([h]) => h)).toEqual([300, 400, 350]);
  });
});

test('pages keep a visible edge in forced colors, in the view and in the page grid', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await tallPdf());
  await settled(page);
  // Forced colors drop box shadows, so the page's edge has to come from an outline.
  const edge = (locator) =>
    locator.evaluate((node) => {
      const style = getComputedStyle(node);
      return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 1;
    });
  expect(await edge(page.locator('.page-slot').first())).toBe(true);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const tile = page.getByRole('listbox', { name: 'Pages' }).getByRole('option').nth(1);
  await expect(tile.locator('canvas')).toBeVisible();
  expect(await edge(tile.locator('canvas'))).toBe(true);
});
