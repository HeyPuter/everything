import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const editorText = page => text(page).evaluate(el => el.value);

/**
 * The owner opening an invitation to their own shared document (the link from their mail, say) gets the document as
 * the file it is, saved as they edit, rather than a copy of the room that nothing saves.
 */
test('the owner opening their own invitation link edits the file it belongs to', async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html?user=ada#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Quarterly plan.');
  await page.getByRole('button', { name: 'Share', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Invite People…' }).click();
  const dialog = page.getByRole('dialog', { name: /^Share/ });
  await dialog.getByRole('button', { name: 'Copy Link' }).click();
  const field = dialog.getByRole('textbox', { name: 'Invitation link' });
  await expect(field).toHaveValue(/collab-room=/);
  const link = await field.inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  const file = decodeURIComponent((await page.evaluate(() => location.hash)).replace(/^#\/edit\//, ''));
  expect(file).toMatch(/\.docx$/);
  await page.getByRole('button', { name: 'All Documents' }).first().click();
  await expect(page).toHaveURL(/#\/?$|#\/home/);
  // The link, as the owner's mail would bring it.
  await page.goto(link.replace('mock.html', 'mock.html?user=ada'));
  await expect.poll(() => page.evaluate(() => decodeURIComponent(location.hash))).toBe(`#/edit/${file}`);
  await expect.poll(() => editorText(page), { timeout: 15000 }).toBe('Quarterly plan.');
  // Still the shared document: the room was rejoined.
  await expect(page.locator('.cl-avatar')).toHaveCount(1, { timeout: 15000 });
  const status = page.locator('.canvas-save-status');
  await text(page).evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select')); });
  await text(page).pressSequentially(' Revised.');
  await expect(status).toHaveAttribute('aria-label', 'Saved to Puter', { timeout: 15000 });
  const saved = await page.evaluate(async path => { const blob = await puter.fs.read(path); return blob.size; }, file);
  expect(saved).toBeGreaterThan(0);
});

/** A room shared before rooms remembered their files: the owner's tab cannot save it, and its status says so. */
test('the owner joining their own room whose file is not known is told the file saves when opened', async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html?user=ada#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Quarterly plan.');
  await page.getByRole('button', { name: 'Share', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Invite People…' }).click();
  const dialog = page.getByRole('dialog', { name: /^Share/ });
  await dialog.getByRole('button', { name: 'Copy Link' }).click();
  const field = dialog.getByRole('textbox', { name: 'Invitation link' });
  await expect(field).toHaveValue(/collab-room=/);
  const link = await field.inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'All Documents' }).first().click();
  const room = new URLSearchParams(new URL(link).hash.slice(1)).get('collab-room');
  await page.evaluate(room => puter.kv.del(`documents-collab-file:${room}`), room);
  await page.goto(link.replace('mock.html', 'mock.html?user=ada'));
  await expect.poll(() => editorText(page), { timeout: 15000 }).toBe('Quarterly plan.');
  const status = page.locator('.canvas-save-status');
  await expect(status).toHaveAttribute('aria-label', 'Shared · open its file to save');
  await expect(status).toHaveAttribute('title', /saved to its file when you open it from your documents/);
});
