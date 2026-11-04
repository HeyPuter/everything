import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// A dialog taller than the window scrolls, and its OK and Cancel stay in view at its foot (a 768-pixel laptop screen
// leaves the page about 620 pixels; a phone held sideways, 360). A dialog that fits looks as it did.
async function openParagraph(page) {
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('textbox', { name: 'Document text' })).toBeEditable({ timeout: 20000 });
  await onTab(page, 'home');
  // A phone held sideways keeps the ribbon folded away; a tap on a tab shows it over the page.
  if (!await page.locator('#ribbon-panel-home').isVisible()) await page.locator('#ribbon-tab-home').click();
  const settings = page.getByRole('button', { name: 'Paragraph Settings', exact: true }).filter({ visible: true }).first();
  // There the Paragraph group is folded into a button of its own.
  if (!await settings.isVisible()) await page.locator('#ribbon-panel-home').getByRole('button', { name: 'Paragraph', exact: true }).click();
  await settings.click();
  const dialog = page.getByRole('dialog', { name: 'Paragraph' });
  await expect(dialog).toBeVisible();
  return dialog;
}
const inView = (dialog, name) => dialog.evaluate((panel, name) => {
  const ok = [...panel.querySelectorAll('button')].find(b => b.textContent.trim() === name);
  const r = ok.getBoundingClientRect(), p = panel.getBoundingClientRect();
  return r.top >= p.top && r.bottom <= p.bottom && r.bottom <= innerHeight && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === ok;
}, name);

test('in a short window the Paragraph dialog keeps OK and Cancel in view while it scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 620 });
  const dialog = await openParagraph(page);
  expect(await dialog.evaluate(p => p.scrollHeight > p.clientHeight)).toBe(true);
  expect(await inView(dialog, 'OK')).toBe(true);
  expect(await inView(dialog, 'Cancel')).toBe(true);
  await dialog.evaluate(p => { p.scrollTop = p.scrollHeight / 2; });
  expect(await inView(dialog, 'OK')).toBe(true);
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test.describe('on a phone held sideways', () => {
  test.use({ viewport: { width: 740, height: 360 }, isMobile: true, hasTouch: true });
  test('the Paragraph dialog keeps OK in reach of a tap', async ({ page }) => {
    const dialog = await openParagraph(page);
    expect(await inView(dialog, 'OK')).toBe(true);
    await dialog.getByRole('button', { name: 'OK', exact: true }).tap();
    await expect(dialog).toBeHidden();
  });
});

test('a dialog that fits keeps its buttons where they were, clear of the content above them', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  const dialog = await openParagraph(page);
  expect(await dialog.evaluate(p => p.scrollHeight <= p.clientHeight)).toBe(true);
  const gap = await dialog.evaluate(panel => {
    const ok = [...panel.querySelectorAll('button')].find(b => b.textContent.trim() === 'OK');
    return Math.round(panel.getBoundingClientRect().bottom - ok.getBoundingClientRect().bottom);
  });
  expect(gap).toBe(25); // the panel's 24-pixel padding and its border
  await page.keyboard.press('Escape');
  // Word Count's checkbox sits right above its Close button.
  await page.evaluate(() => window.__docs.current.view.commands.wordCount());
  const count = page.getByRole('dialog', { name: 'Word Count' });
  await expect(count).toBeVisible();
  const [box, close] = [await count.getByRole('checkbox').locator('..').boundingBox(), await count.getByRole('button', { name: 'Close', exact: true }).last().boundingBox()];
  expect(close.y).toBeGreaterThanOrEqual(box.y + box.height);
});

test('in a short window a field the keyboard moves to is scrolled clear of the buttons', async ({ page }) => {
  await page.setViewportSize({ width: 740, height: 360 });
  const dialog = await openParagraph(page);
  const hidden = [];
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press('Tab');
    const r = await dialog.evaluate(panel => {
      const a = document.activeElement, foot = panel.querySelector('.fmt-footer');
      if (!panel.contains(a) || foot.contains(a)) return null;
      const ar = a.getBoundingClientRect(), fr = foot.getBoundingClientRect();
      return ar.bottom > fr.top + 1 ? a.getAttribute('aria-label') || a.tagName : null;
    });
    if (r) hidden.push(r);
  }
  expect(hidden).toEqual([]);
});
