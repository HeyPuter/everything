import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const editorText = page => text(page).evaluate(el => el.value);

test('a shared document reads only until its room has been joined, so nothing typed is replaced', async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html?user=ada#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Quarterly plan.');
  await page.getByRole('button', { name: 'Share', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Copy Link' }).click();
  await expect(page.locator('.cl-avatar')).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator('.canvas-save-status')).toHaveAttribute('aria-label', 'Saved to Puter', { timeout: 15000 });
  const path = await page.evaluate(() => window.__docs.current.view.doc.path);
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.getByRole('heading', { name: 'Your documents' })).toBeVisible();
  // A slow connection to the room: joining it takes a while after the document has opened.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/__collab/api', async route => { await gate; await route.continue(); });
  await page.evaluate(p => { location.hash = `#/edit/${encodeURIComponent(p)}`; }, path);
  // Until the room's state is in, the document reads only: typing now would be replaced by that state.
  await expect(page.locator('.cl-banner')).toContainText('Connecting to the shared document', { timeout: 15000 });
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeDisabled();
  await text(page).evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select')); });
  await text(page).pressSequentially(' Lost?');
  expect(await editorText(page)).toBe('Quarterly plan.');
  release();
  await expect(page.locator('.cl-avatar')).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator('.cl-banner')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select')); });
  await text(page).pressSequentially(' Typed.');
  await page.waitForTimeout(1500);
  expect(await editorText(page)).toBe('Quarterly plan. Typed.');
});

test('a document that was never shared opens for editing at once', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Notes.');
  await expect(page.locator('.canvas-save-status')).toHaveAttribute('aria-label', 'Saved to Puter', { timeout: 15000 });
  const path = await page.evaluate(() => window.__docs.current.view.doc.path);
  await page.evaluate(() => { location.hash = '#/home'; });
  await expect(page.getByRole('heading', { name: 'Your documents' })).toBeVisible();
  await page.evaluate(p => { location.hash = `#/edit/${encodeURIComponent(p)}`; }, path);
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select')); });
  await text(page).pressSequentially(' More.');
  await expect.poll(() => editorText(page)).toBe('Notes. More.');
  await expect(page.locator('.cl-banner')).toBeHidden();
});
