import { test, expect } from '@playwright/test';

// The Assistant button floats over the bottom corner of the pages. On a phone it covered the words being typed just
// above the keyboard, and the caret itself when that came under it. It steps aside while the keyboard is up and
// while the caret is near it, and comes back after.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test.beforeEach(async ({ page }) => {
  // A phone's screen keeps its height when the keyboard shortens the window; the emulator's follows the window.
  await page.addInitScript(() => Object.defineProperty(Screen.prototype, 'height', { get: () => 844 }));
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeEditable({ timeout: 20000 });
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.model.replace('Words that wrap across the whole width of the page. '.repeat(80)); e.relayout(); e.model.select(0, 0); e.syncInput(); });
});

const fab = page => page.getByRole('button', { name: 'Assistant', exact: true });

test('the Assistant button steps aside while a phone\'s keyboard is up', async ({ page }) => {
  await expect(fab(page)).toBeVisible();
  await page.touchscreen.tap(120, 520);
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeFocused();
  await expect(fab(page)).toBeVisible();
  // The keyboard rises: the window is shorter than the screen.
  await page.setViewportSize({ width: 390, height: 480 });
  await expect(fab(page)).toBeHidden();
  await page.keyboard.type('more ');
  await expect(fab(page)).toBeHidden();
  // It goes down again.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(fab(page)).toBeVisible();
  // The keyboard up but the document no longer being typed in (it was put away): the button is back.
  await page.setViewportSize({ width: 390, height: 480 });
  await expect(fab(page)).toBeHidden();
  await page.evaluate(() => document.activeElement.blur());
  await expect(fab(page)).toBeVisible();
});

test('the Assistant button steps aside while the caret is under it', async ({ page }) => {
  // At 100% the page is wider than the phone, and its text runs under the button.
  await page.getByRole('combobox', { name: 'Zoom' }).selectOption('1');
  const button = await fab(page).boundingBox();
  // Put the caret where the button is, through the text input as the keyboard would.
  const under = await page.evaluate(({ x, y, width, height }) => {
    const e = window.__docs.current.view.engine, input = e.input;
    input.focus();
    for (let at = 0; at < input.value.length; at += 3) {
      input.setSelectionRange(at, at); input.dispatchEvent(new Event('select'));
      const caret = e.caretClientRect();
      if (caret && caret.left >= x && caret.left <= x + width && caret.top + caret.height >= y && caret.top <= y + height) return at;
    }
    return -1;
  }, button);
  test.skip(under < 0, 'no text under the button at this size');
  await expect(fab(page)).toBeHidden();
  // The caret moves away from it: back it comes.
  await page.evaluate(() => { const input = window.__docs.current.view.engine.input; input.setSelectionRange(0, 0); input.dispatchEvent(new Event('select')); });
  await expect(fab(page)).toBeVisible();
});
