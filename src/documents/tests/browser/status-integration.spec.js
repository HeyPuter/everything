import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const mac = process.platform === 'darwin';

async function openEditor(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
}

test('the status bar reports accessibility and opens the Accessibility pane', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('A short note.');
  const item = page.locator('.ed-statusbar .ed-status-accessibility');
  await expect(item).toBeVisible();
  await expect(item).toContainText('Accessibility');
  await item.click();
  await expect(page.getByRole('complementary', { name: 'Accessibility pane' })).toBeVisible();
  await expect(item).toContainText(/Accessibility: (good to go|worth a look|\d+ errors? to fix)/);
});

test('Find Next steps through matches, and Go To keeps its own chord', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('cat dog cat dog cat');
  await text(page).evaluate(el => { el.focus(); el.setSelectionRange(0, 3); el.dispatchEvent(new Event('select')); });
  const selection = () => text(page).evaluate(el => [el.selectionStart, el.selectionEnd]);
  // Cmd+G on a Mac, Shift+F4 everywhere.
  await text(page).press(mac ? 'Meta+g' : 'Shift+F4');
  await expect.poll(selection).toEqual([8, 11]);
  await text(page).press(mac ? 'Meta+Shift+g' : 'ControlOrMeta+Shift+F4');
  await expect.poll(selection).toEqual([0, 3]);
  await expect(page.getByRole('dialog', { name: 'Go To' })).toHaveCount(0);
  await text(page).press(mac ? 'Meta+Alt+g' : 'Control+g');
  await expect(page.getByRole('dialog', { name: 'Go To' })).toBeVisible();
});

test('the page count follows the pages scrolled into view, then the caret again', async ({ page }) => {
  await openEditor(page);
  await text(page).fill(('Paragraph of text that fills the pages. '.repeat(40) + '\n').repeat(20));
  await text(page).evaluate(el => { el.focus(); el.setSelectionRange(0, 0); el.dispatchEvent(new Event('select')); });
  const count = page.locator('.ed-statusbar .ed-page-count');
  await expect(count).toHaveText(/^Page 1 of (\d+)$/);
  const total = Number((await count.textContent()).match(/of (\d+)/)[1]);
  expect(total).toBeGreaterThan(3);
  const host = page.locator('.canvas-host').first();
  // Scrolled to the end: the last page is the one in view.
  await host.evaluate(h => { h.scrollTop = h.scrollHeight; });
  await expect(count).toHaveText(`Page ${total} of ${total}`);
  // Half way: a page in the middle.
  await host.evaluate(h => { h.scrollTop = (h.scrollHeight - h.clientHeight) / 2; });
  await expect.poll(async () => Number((await count.textContent()).match(/Page (\d+)/)[1])).toBeGreaterThan(1);
  // Typing goes back to the caret's page.
  await text(page).press('ArrowRight');
  await expect(count).toHaveText(`Page 1 of ${total}`);
});

test('Zoom In and Zoom Out are unavailable at the largest and smallest zoom, and keep the keyboard', async ({ page }) => {
  await openEditor(page);
  await text(page).fill('Zoom limits.');
  const zoomIn = page.getByRole('button', { name: 'Zoom In' }), zoomOut = page.getByRole('button', { name: 'Zoom Out' });
  const slider = page.getByRole('slider', { name: 'Zoom slider' });
  await expect(zoomIn).not.toHaveAttribute('aria-disabled', 'true');
  await zoomIn.focus();
  for (let i = 0; i < 12; i++) await page.keyboard.press('Enter');
  await expect(slider).toHaveValue('200');
  await expect(zoomIn).toHaveAttribute('aria-disabled', 'true');
  // Still on the button, which says it does nothing now, and pressing it changes nothing.
  await expect(zoomIn).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(slider).toHaveValue('200');
  await expect(zoomOut).not.toHaveAttribute('aria-disabled', 'true');
  await slider.fill('10');
  await expect(zoomOut).toHaveAttribute('aria-disabled', 'true');
  await expect(zoomIn).not.toHaveAttribute('aria-disabled', 'true');
});
