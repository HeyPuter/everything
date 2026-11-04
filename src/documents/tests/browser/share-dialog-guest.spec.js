import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const editorText = page => text(page).evaluate(el => el.value);

/**
 * Only the owner invites people or makes links (the room server refuses anyone else). Someone invited who opens Share
 * is told so up front, instead of filling in invitations that fail when sent.
 */
test('the Share dialog of someone invited says only the owner can invite', async ({ browser }) => {
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
    await guest.getByRole('button', { name: 'Share', exact: true }).first().click();
    await guest.getByRole('menuitem', { name: 'Invite People…' }).click();
    const shared = guest.getByRole('dialog', { name: /^Share/ });
    await expect(shared).toBeVisible();
    await expect(shared).toContainText('Only ada, who owns this document, can invite people');
    await expect(shared.getByRole('textbox', { name: 'People to invite' })).toBeDisabled();
    await expect(shared.getByRole('button', { name: 'Invite', exact: true })).toBeDisabled();
    await expect(shared.getByRole('button', { name: 'Copy Link' })).toBeDisabled();
    await expect(shared.getByRole('button', { name: 'Turn Off Earlier Links' })).toBeHidden();
    // Who has access is still listed, and a copy can still be sent or downloaded.
    await expect(shared.getByRole('list', { name: 'People with access' })).toContainText('ada');
    await shared.getByText('Send a copy by email').click();
    await expect(shared.getByRole('button', { name: 'Download Instead' })).toBeEnabled();
    await shared.getByRole('button', { name: 'Done' }).click();
    // The Share menu's Copy Link is not offered either.
    await guest.getByRole('button', { name: 'Share', exact: true }).first().click();
    await expect(guest.getByRole('menuitem', { name: 'Copy Link' })).toBeDisabled();
  } finally { await ownerContext.close(); await guestContext.close(); }
});
