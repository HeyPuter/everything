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

test("a page's own buttons in Organize pages cannot delete the only page", async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  doc.addPage([400, 300]);
  doc.addPage([400, 300]);
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  await expect(grid.getByRole('option')).toHaveCount(2);
  await expect(grid.getByRole('button', { name: 'Delete page 1', exact: true })).toBeEnabled();
  await grid.getByRole('option', { name: 'Page 2', exact: true }).hover();
  await grid.getByRole('button', { name: 'Delete page 2', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete page', exact: true }).click();
  await settled(page);
  await expect(grid.getByRole('option')).toHaveCount(1);
  // The toolbar's Delete is off with one page left, and so is the page's own.
  const toolbar = page.getByRole('toolbar', { name: 'Organize pages' });
  await expect(toolbar.getByRole('button', { name: 'Delete pages', exact: true })).toBeDisabled();
  await expect(grid.getByRole('button', { name: 'Delete page 1', exact: true })).toBeDisabled();
  await expect(
    grid.getByRole('button', { name: 'Rotate page 1 clockwise', exact: true }),
  ).toBeEnabled();
});

test('keys that move through Organize pages leave the page behind the grid alone', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await tallPdf());
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  await expect(grid.getByRole('option', { name: 'Page 1', exact: true })).toBeFocused();
  // End and Home choose the last and first tiles.
  await page.keyboard.press('End');
  await expect(grid.getByRole('option', { name: 'Page 3', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expect(grid.getByRole('option', { name: 'Page 2', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.locator('.organize-status')).toHaveText('1 of 3 pages selected');
  await settled(page);
  await page
    .getByRole('toolbar', { name: 'Organize pages' })
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  // The page that was on view before is on view again.
  await expect(page.locator('.page-caption')).toHaveText('Page 1 of 3');
});

test('Organize pages moves the chosen pages without dragging, by key or button', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await tallPdf());
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Organize pages', exact: true }).click();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  const toolbar = page.getByRole('toolbar', { name: 'Organize pages' });
  const earlier = toolbar.getByRole('button', { name: 'Move pages earlier', exact: true });
  const later = toolbar.getByRole('button', { name: 'Move pages later', exact: true });
  // The first page cannot go earlier.
  await expect(earlier).toBeDisabled();
  await expect(earlier).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowLeft');
  // The tools pane offers the same, beside the grid where there is room for both.
  const paneLater = pane.getByRole('button', { name: 'Move page later', exact: true });
  const beside = await pane.isVisible();
  if (beside)
    await expect(
      pane.getByRole('button', { name: 'Move page earlier', exact: true }),
    ).toBeDisabled();
  await grid.getByRole('option', { name: 'Page 2', exact: true }).click();
  await grid.getByRole('option', { name: 'Page 2', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await settled(page);
  // The moved page stays chosen and keeps the keyboard, now in first place.
  await expect(grid.getByRole('option', { name: 'Page 1', exact: true })).toBeFocused();
  await expect(grid.getByRole('option', { name: 'Page 1', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect((await exportedHeights(page)).map(([h]) => h)).toEqual([350, 300, 400]);
  await expect(earlier).toBeDisabled();
  await later.click();
  await settled(page);
  await (beside ? paneLater : later).click();
  await settled(page);
  expect((await exportedHeights(page)).map(([h]) => h)).toEqual([300, 400, 350]);
  await expect(grid.getByRole('option', { name: 'Page 3', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(later).toBeDisabled();
  // Two pages apart each move one place, past the page between them.
  await grid.getByRole('option', { name: 'Page 1', exact: true }).click();
  await grid.getByRole('option', { name: 'Page 3', exact: true }).click({ modifiers: ['Shift'] });
  await grid.getByRole('option', { name: 'Page 2', exact: true }).click({
    modifiers: ['ControlOrMeta'],
  });
  await expect(page.locator('.organize-status')).toHaveText('2 of 3 pages selected');
  await later.click();
  await settled(page);
  expect((await exportedHeights(page)).map(([h]) => h)).toEqual([400, 300, 350]);
  await expect(page.locator('.organize-status')).toHaveText('2 of 3 pages selected');
  await expect(grid.getByRole('option', { name: 'Page 2', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('after deleting by key in Organize pages, the page with the focus is the one chosen', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  [300, 350, 400, 450].forEach((height) => doc.addPage([400, height]));
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  await grid.getByRole('option', { name: 'Page 2', exact: true }).click();
  await page.keyboard.press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete page', exact: true }).click();
  await settled(page);
  // The keyboard stays on the page now in second place, and that page is the one chosen.
  const second = grid.getByRole('option', { name: 'Page 2', exact: true });
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.organize-status')).toHaveText('1 of 3 pages selected');
  // So Delete again offers that page, not the current page behind the grid.
  await page.keyboard.press('Delete');
  await expect(page.getByRole('dialog')).toContainText('Remove page 2?');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete page', exact: true }).click();
  await settled(page);
  expect((await exportedHeights(page)).map(([h]) => h)).toEqual([300, 450]);
});

test('a tile clicked in Organize pages is where the keyboard comes back to', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await tallPdf());
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  const third = grid.getByRole('option', { name: 'Page 3', exact: true });
  await third.click();
  await expect(third).toBeFocused();
  // The grid is one tab stop: leaving it and coming back returns to the chosen tile.
  await page.keyboard.press('Shift+Tab');
  await expect(third).not.toBeFocused();
  await page.keyboard.press('Tab');
  await expect(third).toBeFocused();
  await expect(grid.locator('[tabindex="0"]')).toHaveCount(1);
});

test('the Organize pages toolbar keeps the focus on the button pressed', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await tallPdf());
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const toolbar = page.getByRole('toolbar', { name: 'Organize pages' });
  for (const name of ['Rotate clockwise', 'Duplicate pages', 'Move pages later']) {
    const control = toolbar.getByRole('button', { name, exact: true });
    await control.focus();
    await page.keyboard.press('Enter');
    await settled(page);
    // Disabled while the PDF was redrawn, the button had dropped the focus on the page.
    await expect(control).toBeFocused();
  }
  const remove = toolbar.getByRole('button', { name: 'Delete pages', exact: true });
  await remove.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete page', exact: true }).click();
  await settled(page);
  await expect(page.locator('.organize-status')).toHaveText('3 pages');
  await expect(remove).toBeFocused();
});

test('rotate and delete shortcuts in Organize pages act on the chosen pages', async ({ page }) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await tallPdf());
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  await grid.getByRole('option', { name: 'Page 2', exact: true }).click();
  await grid.getByRole('option', { name: 'Page 3', exact: true }).click({ modifiers: ['Shift'] });
  // Not the current page behind the grid, page 1.
  await page.keyboard.press('ControlOrMeta+Shift+R');
  await settled(page);
  // From the toolbar too, whose buttons act on the same pages.
  await page
    .getByRole('toolbar', { name: 'Organize pages' })
    .getByRole('button', { name: 'Rotate counterclockwise', exact: true })
    .focus();
  await page.keyboard.press('ControlOrMeta+Shift+R');
  await settled(page);
  expect((await exportedHeights(page)).map(([, angle]) => angle)).toEqual([0, 180, 180]);
  await grid.getByRole('option', { name: 'Page 3', exact: true }).focus();
  await page.keyboard.press('ControlOrMeta+Shift+D');
  await expect(page.getByRole('dialog')).toContainText('Remove pages 2-3?');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('Organize pages found with the find box on a narrow screen shows its grid', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await tallPdf());
  await page.getByRole('button', { name: 'Find text or tools', exact: true }).click();
  await page.getByRole('combobox', { name: 'Find in PDF' }).fill('Organize');
  await page.getByRole('option', { name: 'Open tool: Organize pages', exact: true }).click();
  // As from the tools pane, the pane steps aside: it would cover the whole grid.
  await expect(page.getByRole('complementary', { name: 'Tools' })).toBeHidden();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  await grid.getByRole('option', { name: 'Page 2', exact: true }).click();
  await expect(page.locator('.organize-status')).toHaveText('1 of 3 pages selected');
});

test("a page moved from its thumbnail's menu keeps the keyboard focus with it", async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await tallPdf());
  await showPanel(page);
  await page.getByRole('button', { name: 'Page 2 actions', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menu').getByRole('menuitem', { name: 'Move page later' }).click();
  await settled(page);
  // The focus is on the menu of the page that moved, now third, so pressing on moves it again.
  await expect(page.getByRole('button', { name: 'Page 3 actions', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('menu').getByRole('menuitem', { name: 'Move page earlier' }).click();
  await settled(page);
  await expect(page.getByRole('button', { name: 'Page 2 actions', exact: true })).toBeFocused();
  expect((await exportedHeights(page)).map(([h]) => h)).toEqual([300, 350, 400]);
});

test('Organize pages shows phones two columns of pages', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await tallPdf());
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  const top = async (name) =>
    (await grid.getByRole('option', { name, exact: true }).boundingBox()).y;
  // The first two pages sit side by side, rather than one page to a row.
  await expect(grid.getByRole('option')).toHaveCount(3);
  expect(await top('Page 2')).toBe(await top('Page 1'));
  await expect(page.getByRole('slider', { name: 'Page tile size' })).toHaveValue('0');
  // A size picked with the slider stays.
  await page.getByRole('slider', { name: 'Page tile size' }).fill('2');
  await page
    .getByRole('toolbar', { name: 'Organize pages' })
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  await expect(page.getByRole('slider', { name: 'Page tile size' })).toHaveValue('2');
});

test('with no page chosen, Insert in Organize pages offers the same place as the tools pane', async ({
  page,
}) => {
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  [300, 350, 400, 450].forEach((height) => doc.addPage([400, height]));
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Tools' });
  await pane.getByRole('button', { name: 'Organize pages', exact: true }).click();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  await grid.getByRole('option', { name: 'Page 3', exact: true }).hover();
  await grid.getByRole('button', { name: 'Delete page 3', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete page', exact: true }).click();
  await settled(page);
  await expect(page.locator('.organize-status')).toHaveText('3 pages');
  // Nothing is chosen, so the commands act on the current page, page 1; Insert does too.
  const toolbar = page.getByRole('toolbar', { name: 'Organize pages' });
  await toolbar.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Insert' })).toContainText('After page 1');
  await page.getByRole('menu').getByRole('menuitem', { name: 'Blank page' }).click();
  await settled(page);
  expect((await exportedHeights(page)).map(([h]) => h)).toEqual([300, 300, 350, 450]);
  if (await pane.isVisible())
    await expect(pane.getByRole('heading', { name: 'Insert after page 1' })).toBeVisible();
});

for (const [width, height] of [
  [320, 700],
  [390, 844],
])
  test(`the Organize pages toolbar takes two rows on a ${width}px phone`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await mockPuter(page);
    await page.goto('/#library');
    await openPdf(page, await tallPdf());
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page
      .getByRole('complementary', { name: 'Tools' })
      .getByRole('button', { name: 'Organize pages', exact: true })
      .click();
    const toolbar = page.getByRole('toolbar', { name: 'Organize pages' });
    const grid = page.getByRole('listbox', { name: 'Pages' });
    // The middle page, so that every command is enabled.
    await grid.getByRole('option', { name: 'Page 2', exact: true }).click();
    await expect(page.locator('.organize-status')).toHaveText('1 of 3 pages selected');
    // It wrapped onto three rows at 390px and four at 320px, leaving the pages little room.
    expect((await toolbar.boundingBox()).height).toBeLessThan(100);
    await expect(toolbar.getByRole('heading', { name: 'Organize pages' })).toBeAttached();
    const names = [
      'Insert',
      'Rotate counterclockwise',
      'Rotate clockwise',
      'Move pages earlier',
      'Move pages later',
      'Duplicate pages',
      'Extract pages',
      'Delete pages',
      'Close',
    ];
    const bar = await toolbar.boundingBox();
    for (const name of names) {
      const button = toolbar.getByRole('button', { name, exact: true });
      // Each keeps its name and a finger-sized target, and the keyboard brings it into view.
      await button.focus();
      await expect(button).toBeFocused();
      const box = await button.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(40);
      expect(box.height).toBeGreaterThanOrEqual(40);
      await expect
        .poll(async () => {
          const { x, width: w } = await button.boundingBox();
          return x >= bar.x && x + w <= bar.x + bar.width;
        })
        .toBe(true);
    }
    await expect(page.getByRole('slider', { name: 'Page tile size' })).toBeVisible();
    // Delete, at the far end of the row, still works from there.
    await toolbar.getByRole('button', { name: 'Delete pages', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Remove page 2?');
  });

test('the Organize pages toolbar keeps its labels and one row of commands on a desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockPuter(page);
  await page.goto('/#library');
  await openPdf(page, await tallPdf());
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const toolbar = page.getByRole('toolbar', { name: 'Organize pages' });
  await expect(toolbar.getByRole('heading', { name: 'Organize pages' })).toBeVisible();
  await expect(toolbar.getByText('Insert', { exact: true })).toBeVisible();
  await expect(toolbar.getByText('Close', { exact: true })).toBeVisible();
  const middle = async (name) => {
    const { y, height } = await toolbar.getByRole('button', { name, exact: true }).boundingBox();
    return y + height / 2;
  };
  expect(await middle('Delete pages')).toBeCloseTo(await middle('Insert'), 0);
});

test('a long count in the Organize pages toolbar reads whole on a small phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await mockPuter(page);
  await page.goto('/#library');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 120; i++) doc.addPage([400, 300]);
  await openPdf(page, doc);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page
    .getByRole('complementary', { name: 'Tools' })
    .getByRole('button', { name: 'Organize pages', exact: true })
    .click();
  const grid = page.getByRole('listbox', { name: 'Pages' });
  await grid.getByRole('option', { name: 'Page 1', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+a');
  const status = page.locator('.organize-status');
  await expect(status).toHaveText('120 of 120 pages selected');
  // It was cut to "120 of 120 pages sel…"; it takes a second line instead, in the same row.
  expect(await status.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  const toolbar = page.getByRole('toolbar', { name: 'Organize pages' });
  expect((await toolbar.boundingBox()).height).toBeLessThan(100);
});
