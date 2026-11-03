import { test, expect } from '@playwright/test';

/** Whether the focused tab is wholly inside the row it scrolls in, and in the window. */
const wholeInRow = page => page.evaluate(() => {
  const tab = document.activeElement, box = tab.getBoundingClientRect();
  let clip = tab.parentElement;
  while (clip && !/(auto|scroll|hidden)/.test(getComputedStyle(clip).overflowX)) clip = clip.parentElement;
  const row = (clip || document.documentElement).getBoundingClientRect();
  return box.left >= Math.max(0, row.left) - 1 && box.right <= Math.min(innerWidth, row.right) + 1;
});

async function openEditor(page) {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.goto('/mock.html#/new');
  const text = page.getByRole('textbox', { name: 'Document text' });
  await text.fill('Harbour report');
  await expect(text).toBeFocused();
}

test('on a phone the arrow keys bring each Preferences section tab wholly into view', async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press('ControlOrMeta+Comma');
  const dialog = page.getByRole('dialog', { name: 'Preferences' });
  const tabs = dialog.getByRole('tab');
  await expect(tabs.first()).toBeFocused();
  const count = await tabs.count();
  for (let i = 1; i < count; i++) {
    await page.keyboard.press('ArrowRight');
    await expect(tabs.nth(i)).toBeFocused();
    await expect.poll(() => wholeInRow(page), { message: `tab ${i + 1} in view` }).toBe(true);
  }
});

test('on a phone the arrow keys bring each File page tab wholly into view', async ({ page }) => {
  await openEditor(page);
  await page.locator('.ribbon-file').click();
  const view = page.getByRole('dialog', { name: 'File' });
  await expect(view.getByRole('tab', { name: 'Info' })).toBeFocused();
  for (const name of ['Save', 'Print', 'Share', 'Export']) {
    await page.keyboard.press('ArrowRight');
    await expect(view.getByRole('tab', { name })).toBeFocused();
    await expect.poll(() => wholeInRow(page), { message: `${name} in view` }).toBe(true);
  }
});
