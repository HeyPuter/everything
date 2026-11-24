import { test, expect } from '@playwright/test';

// F6 and Shift+F6 move between the editor's areas, as in Word: the title bar, the ribbon, the panes and the
// document in their order, and the status bar. The keys are the page's: the browser does not take them on.
test('F6 and Shift+F6 move the keyboard between the title bar, the ribbon, the document, a pane and the status bar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Styles Pane' }).click();
  const text = page.getByRole('textbox', { name: 'Document text' });
  await text.fill('Hello');
  await page.evaluate(() => { window.__f6 = []; addEventListener('keydown', e => { if (e.key === 'F6') window.__f6.push(e); }, true); });
  const area = () => page.evaluate(() => {
    const active = document.activeElement;
    return ['.ed-titlebar', '.ribbon-tabs', '.canvas-document-surface', '.styles-pane', '.ed-statusbar'].find(s => active.closest(s)) || active.tagName;
  });
  const forward = [];
  for (let i = 0; i < 5; i++) { await page.keyboard.press('F6'); forward.push(await area()); }
  expect(forward).toEqual(['.styles-pane', '.ed-statusbar', '.ed-titlebar', '.ribbon-tabs', '.canvas-document-surface']);
  await expect(text).toBeFocused();
  // The ribbon is entered at its chosen tab.
  await page.keyboard.press('Shift+F6');
  await expect(page.getByRole('tab', { name: 'Home', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+F6');
  expect(await area()).toBe('.ed-titlebar');
  await page.keyboard.press('Shift+F6');
  expect(await area()).toBe('.ed-statusbar');
  expect(await page.evaluate(() => window.__f6.length > 0 && window.__f6.every(e => e.defaultPrevented))).toBe(true);
  await expect(text).toHaveValue('Hello');
});

// A notice with a button in it (Undo, Cancel printing, Save a Copy) could not be reached from the keyboard: F6 now
// goes there after the status bar, and when the notice goes the keyboard is back where it was.
test('F6 reaches a notice\'s button, and the keyboard goes back when the notice goes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const text = page.getByRole('textbox', { name: 'Document text' });
  await text.fill('Hello');
  await page.evaluate(async () => {
    const { toast } = await import('/src/ui/toast.js');
    window.__undone = 0;
    toast('Restored an earlier version', { action: { label: 'Undo', onClick: () => { window.__undone++; } }, duration: 60000 });
  });
  const undo = page.locator('.toast').getByRole('button', { name: 'Undo' });
  const area = () => page.evaluate(() => ['.ed-titlebar', '.ed-statusbar', '.toast'].find(s => document.activeElement.closest(s)) || document.activeElement.tagName);
  await expect(undo).toBeVisible();
  await text.focus();
  await page.keyboard.press('F6');
  await expect.poll(area).toBe('.ed-statusbar');
  await page.keyboard.press('F6');
  await expect(undo).toBeFocused();
  // The notice waits while it has the keyboard; Shift+F6 goes back.
  await page.keyboard.press('Shift+F6');
  await expect.poll(area).toBe('.ed-statusbar');
  await page.keyboard.press('F6');
  await expect(undo).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast')).toHaveCount(0);
  expect(await page.evaluate(() => window.__undone)).toBe(1);
  // The keyboard went back to where F6 brought it from (the status bar), not to the page body.
  await expect.poll(area).toBe('.ed-statusbar');
  // With no notice, F6 from the status bar goes round to the title bar as before.
  await page.keyboard.press('F6');
  await expect.poll(area).toBe('.ed-titlebar');
});
