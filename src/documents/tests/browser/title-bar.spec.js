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
    // Undo's history arrow, pressed against Undo, is wide enough that a tap meant for it does not undo.
    const arrow = await page.locator('.ed-quick').getByRole('button', { name: 'Undo history' }).boundingBox();
    expect(arrow.width).toBeGreaterThanOrEqual(24);
    expect(arrow.height).toBeGreaterThanOrEqual(44);
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

test('between phone and desktop widths the status bar shows its counts whole instead of clipping them', async ({ page }) => {
  await openEditor(page, 1440);
  await text(page).fill('one two three four five six seven eight nine ten eleven twelve');
  await text(page).evaluate(el => { el.focus(); el.setSelectionRange(0, 7); el.dispatchEvent(new Event('select')); });
  await expect(page.locator('.ed-word-count')).toHaveText('2 of 12 words');
  for (const width of [701, 740, 780, 860, 1000]) {
    await page.setViewportSize({ width, height: 800 });
    // The view buttons and zoom controls left the word count cut in half and the spelling button clipped out of sight.
    const cut = await page.evaluate(() => {
      const left = document.querySelector('.ed-status-left').getBoundingClientRect();
      return [...document.querySelectorAll('.ed-status-left > *')].filter(n => n.getClientRects().length && n.getBoundingClientRect().right > left.right + 0.5).map(n => n.title || n.textContent.trim());
    });
    expect(cut, `${width}px`).toEqual([]);
  }
});

test('the zoom slider keeps the keyboard for repeated arrow presses and returns it to the text after a drag', async ({ page }) => {
  await openEditor(page, 1440);
  const slider = page.getByRole('slider', { name: 'Zoom slider' });
  const zoom = () => page.evaluate(() => Math.round(window.__docs.current.view.engine.zoom * 100));
  await slider.focus();
  // Each press ends a change; handing focus to the text at the first one sent the next presses into the document.
  for (const expected of [99, 98, 97]) {
    await page.keyboard.press('ArrowLeft');
    await expect.poll(zoom).toBe(expected);
    await expect(slider).toBeFocused();
  }
  const box = await slider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(text(page)).toBeFocused();
});

test('the document details popover holds its fields and buttons inside its frame', async ({ page }) => {
  for (const width of [820, 1440]) {
    await openEditor(page, width);
    await page.getByRole('button', { name: 'Document details' }).click();
    const popover = page.getByRole('dialog', { name: 'Document' });
    await expect(popover.getByRole('button', { name: 'Rename' })).toBeVisible();
    // Version History, Properties and Rename side by side were wider than the popover and spilled past its edge.
    const spill = await popover.evaluate(panel => {
      const frame = panel.getBoundingClientRect();
      return [...panel.querySelectorAll('input, button')].filter(n => { const r = n.getBoundingClientRect(); return r.right > frame.right + 0.5 || r.left < frame.left - 0.5; }).map(n => n.getAttribute('aria-label') || n.textContent);
    });
    expect(spill, `${width}px`).toEqual([]);
    await page.keyboard.press('Escape');
  }
});
