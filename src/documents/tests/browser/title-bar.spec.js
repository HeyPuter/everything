import { test, expect } from '@playwright/test';
import { fileCommand } from './helpers/editor-tools.js';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const title = page => page.getByRole('textbox', { name: 'Document name' });
async function openEditor(page, width = 1200) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
}

test('a rename that fails sizes the title back to the name it keeps', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Draft');
  await (await fileCommand(page, 'Save')).click();
  await expect(page.locator('.canvas-save-status')).toHaveText('Saved to Puter');
  const width = await title(page).evaluate(el => el.style.width);
  await page.evaluate(() => { window.puter.fs.rename = async () => { throw new Error('A file with that name already exists'); }; });
  await title(page).fill('A considerably longer name that the rename will refuse');
  await title(page).press('Enter');
  await expect(title(page)).toHaveValue('Untitled document');
  await expect.poll(() => title(page).evaluate(el => el.style.width)).toBe(width);
});

test('a long name truncates instead of crowding the save status, Search and account button', async ({ page }) => {
  for (const width of [920, 1000, 1440]) {
    await openEditor(page, width);
    await title(page).fill('Quarterly planning notes for the regional operations review 2026');
    await title(page).press('Enter');
    const boxes = await page.evaluate(() => Object.fromEntries(['.ed-titlebar .canvas-save-status', '.ed-search', '.canvas-title-actions .user-btn'].map(s => {
      const r = document.querySelector(s).getBoundingClientRect();
      return [s, { left: r.left, right: r.right, width: r.width, height: r.height }];
    })));
    const status = boxes['.ed-titlebar .canvas-save-status'], search = boxes['.ed-search'], avatar = boxes['.canvas-title-actions .user-btn'];
    expect(search.left, `${width}px`).toBeGreaterThanOrEqual(status.right + 4);
    expect(avatar.width, `${width}px`).toBe(avatar.height);
  }
});

test('touch screens fit the title bar to its fingertip-sized commands', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1024, height: 760 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.goto('/mock.html#/new');
    await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    const bar = await page.locator('.ed-titlebar').boundingBox();
    for (const name of ['Save', 'Undo', 'Redo', 'Print']) {
      const box = await page.locator('.ed-quick').getByRole('button', { name, exact: true }).boundingBox();
      expect(box.height, name).toBeGreaterThanOrEqual(44);
      expect(box.y + box.height, name).toBeLessThanOrEqual(bar.y + bar.height);
    }
    // The save status, Search and account button take taps a fingertip high, though drawn smaller.
    const reach = await page.evaluate(() => ['.ed-titlebar .canvas-save-status', '.ed-search', '.ed-header .user-btn'].filter(s => {
      const el = document.querySelector(s), b = el.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
      return [y - 21, y + 21].some(at => !el.contains(document.elementFromPoint(x, at)));
    }));
    expect(reach).toEqual([]);
  } finally { await context.close(); }
});

test('the quick access toolbar is one tab stop whose commands the arrow keys move between', async ({ page }) => {
  await openEditor(page);
  const quick = page.getByRole('toolbar', { name: 'Quick access' });
  const stops = () => quick.evaluate(el => [...el.querySelectorAll('button')].filter(b => b.tabIndex === 0).map(b => b.getAttribute('aria-label')));
  expect(await stops()).toEqual(['All Documents']);
  await quick.getByRole('button', { name: 'All Documents' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(quick.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
  // Undo and Redo are disabled in a new document, so Right passes over them.
  await page.keyboard.press('ArrowRight');
  await expect(quick.getByRole('button', { name: 'Print', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(quick.getByRole('button', { name: 'All Documents' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(quick.getByRole('button', { name: 'Print', exact: true })).toBeFocused();
  expect(await stops()).toEqual(['Print']);
  // A window narrow enough to hide Print moves the stop to a command still shown.
  await page.setViewportSize({ width: 600, height: 800 });
  await expect.poll(stops).toEqual(['Save']);
});

test('the status bar keeps its zoom controls whole between phone and desktop widths', async ({ page }) => {
  await openEditor(page, 1440);
  for (const width of [1440, 760, 720, 701]) {
    await page.setViewportSize({ width, height: 800 });
    const result = await page.evaluate(() => {
      const bar = document.querySelector('.ed-statusbar'), zoom = document.querySelector('.ed-statusbar .canvas-zoom select').getBoundingClientRect();
      const language = document.querySelector('.ed-status-language').getBoundingClientRect(), mode = document.querySelector('.canvas-text-mode').getBoundingClientRect();
      return { overflow: bar.scrollWidth > bar.clientWidth, zoomInside: zoom.right <= bar.getBoundingClientRect().right, apart: language.right <= mode.left };
    });
    expect(result, `${width}px`).toEqual({ overflow: false, zoomInside: true, apart: true });
  }
});
