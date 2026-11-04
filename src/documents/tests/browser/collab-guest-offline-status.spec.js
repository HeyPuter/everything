import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const editorText = page => text(page).evaluate(el => el.value);

/**
 * A guest's edits reach the file only through the room. While the room cannot be reached, the document's status says
 * so rather than "Shared · saved by the owner" (a narrow window shows the status but not the "Offline · N waiting" chip).
 */
test('a guest who loses the connection sees Offline in the document status, not saved', async ({ browser }) => {
  test.setTimeout(120000);
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const owner = await ownerContext.newPage();
    await owner.goto('/mock.html?user=ada#/new');
    await expect(owner.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await text(owner).fill('Quarterly plan.');
    await owner.getByRole('button', { name: 'Share', exact: true }).first().click();
    await owner.getByRole('menuitem', { name: 'Invite People…' }).click();
    const dialog = owner.getByRole('dialog', { name: /^Share/ });
    await dialog.getByRole('textbox', { name: 'People to invite' }).fill('bob');
    await dialog.getByRole('button', { name: 'Invite' }).click();
    await expect(dialog.locator('.sh-status')).toContainText('bob can open the document');
    const link = await dialog.getByRole('textbox', { name: 'Invitation link' }).inputValue();
    await dialog.getByRole('button', { name: 'Done' }).click();
    const guest = await guestContext.newPage();
    await guest.goto(link.replace('mock.html', 'mock.html?user=bob').replace(/&collab-invite=[^&]*/, ''));
    await expect.poll(() => editorText(guest), { timeout: 15000 }).toBe('Quarterly plan.');
    const status = guest.locator('.canvas-save-status');
    await expect(status).toHaveAttribute('aria-label', 'Shared · saved by the owner');
    await guest.route('**/__collab/api', route => route.abort());
    await text(guest).evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select')); });
    await text(guest).pressSequentially(' Draft.');
    await expect(status).toHaveAttribute('aria-label', 'Offline', { timeout: 15000 });
    await expect(status).toHaveAttribute('title', /waiting to reach the others/);
    // Back online, the changes go out and the status says so again.
    await guest.unroute('**/__collab/api');
    await expect(status).toHaveAttribute('aria-label', 'Shared · saved by the owner', { timeout: 20000 });
    await expect.poll(() => editorText(owner), { timeout: 20000 }).toBe('Quarterly plan. Draft.');
  } finally { await ownerContext.close(); await guestContext.close(); }
});
