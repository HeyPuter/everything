import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const editorText = page => text(page).evaluate(el => el.value);

test('deleting a shared document from the list ends the sharing, and the people in it are told', async ({ browser }) => {
  test.setTimeout(120000);
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const owner = await ownerContext.newPage();
  await owner.goto('/mock.html?user=ada#/new');
  await expect(owner.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(owner).fill('Quarterly plan.');
  await owner.getByRole('button', { name: 'Share', exact: true }).first().click();
  await owner.getByRole('menuitem', { name: 'Invite People…' }).click();
  const dialog = owner.getByRole('dialog', { name: /^Share/ });
  await dialog.getByRole('textbox', { name: 'People to invite' }).fill('bob');
  await dialog.getByRole('combobox', { name: 'Role for the people you invite' }).selectOption({ label: 'Can edit' });
  await dialog.getByRole('button', { name: 'Invite' }).click();
  await expect(dialog.locator('.sh-status')).toContainText('bob can open the document');
  const link = await dialog.getByRole('textbox', { name: 'Invitation link' }).inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guest = await guestContext.newPage();
  await guest.goto(link.replace('mock.html', 'mock.html?user=bob').replace(/&collab-invite=[^&]*/, ''));
  await expect.poll(() => editorText(guest), { timeout: 15000 }).toBe('Quarterly plan.');
  await expect(guest.locator('.canvas-save-status')).toHaveAttribute('aria-label', 'Shared · saved by the owner');
  // The owner deletes the document from the list.
  await expect(owner.locator('.canvas-save-status')).toHaveAttribute('aria-label', 'Saved to Puter', { timeout: 15000 });
  await owner.evaluate(() => { location.hash = '#/home'; });
  await owner.getByRole('button', { name: 'Options for Untitled document.docx' }).click();
  await owner.getByRole('menuitem', { name: 'Delete' }).click();
  await owner.getByRole('dialog', { name: 'Delete document?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(owner.locator('.file-row')).toHaveCount(0);
  // Nobody saves the shared document any more: its guest hears of it, and can keep a copy of their own.
  await expect(guest.locator('.cl-banner')).toContainText('stopped sharing', { timeout: 15000 });
  await expect(guest.locator('.cl-banner').getByRole('button', { name: 'Save a Copy' })).toBeVisible();
  await expect(guest.locator('.canvas-save-status')).toHaveAttribute('aria-label', 'Not saved yet');
  await ownerContext.close(); await guestContext.close();
});
