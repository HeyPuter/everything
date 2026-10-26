import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

const MAC = process.platform === 'darwin';
const review = page => page.locator('#ribbon-panel-review');
const select = (input, start, end = start) => input.evaluate((el, [a, b]) => { el.setSelectionRange(a, b); el.dispatchEvent(new Event('select', { bubbles: true })); }, [start, end]);
const model = page => page.evaluate(() => { const m = window.__docs.current.view.engine.model; return { text: m.text, selected: m.text.slice(...m.range) }; });
async function open(page, text) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input.fill(text);
  return input;
}

test('after choosing a comment card, returning to the document with the keyboard keeps the comment\'s text selected', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await open(page, 'Alpha beta gamma delta.');
  await onTab(page, 'review');
  await select(input, 6, 10);
  await review(page).getByRole('button', { name: 'New Comment', exact: true }).click();
  await page.locator('.ed-comment-draft textarea').fill('About beta');
  await page.locator('.ed-comment-draft').getByRole('button', { name: 'Post' }).click();
  await input.focus(); await select(input, 0);
  await page.locator('.ed-comment-card').click();
  await expect.poll(async () => (await model(page)).selected).toBe('beta');
  // Shift+Tab goes back to the document text, whose own selection had been left where the caret was.
  await page.keyboard.press('Shift+Tab');
  await expect(input).toBeFocused();
  expect((await model(page)).selected).toBe('beta');
  await page.keyboard.type('BETA');
  expect((await model(page)).text).toBe('Alpha BETA gamma delta.');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await model(page)).text).toBe('Alpha beta gamma delta.');
  expect(errors).toEqual([]);
});

test('typing while Read Aloud highlights a word replaces that word', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    window.__spoken = [];
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak: u => window.__spoken.push(u), cancel() {}, pause() {}, resume() {} } });
  });
  const input = await open(page, 'Alpha beta gamma.');
  await select(input, 0);
  await page.keyboard.press(MAC ? 'Alt+Meta+Space' : 'Control+Alt+Space');
  await expect(page.getByRole('toolbar', { name: 'Read Aloud' })).toBeVisible();
  await expect(input).toBeFocused();
  await page.evaluate(() => window.__spoken.at(-1).onboundary({ name: 'word', charIndex: 6 }));
  expect((await model(page)).selected).toBe('beta');
  await page.keyboard.type('X');
  expect((await model(page)).text).toBe('Alpha X gamma.');
  expect(errors).toEqual([]);
});
