import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const editorText = page => text(page).evaluate(el => el.value);

/** Closing a tab takes its person out of the others' title bar at once, not when their presence lapses (30 s). */
test('someone who closes the tab leaves the others\' title bar at once', async ({ context }) => {
  const ann = await context.newPage();
  await ann.setViewportSize({ width: 1440, height: 900 });
  await ann.goto('/playground.html?name=Ann');
  await expect(ann.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(ann).fill('Shared draft.');
  await ann.getByRole('button', { name: 'Share', exact: true }).first().click();
  await ann.getByRole('menuitem', { name: 'Invite People…' }).click();
  const dialog = ann.getByRole('dialog', { name: /^Share/ });
  await dialog.getByRole('button', { name: 'Copy Link' }).click();
  const field = dialog.getByRole('textbox', { name: 'Invitation link' });
  await expect(field).toHaveValue(/collab-local=/);
  const link = await field.inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  const bob = await context.newPage();
  await bob.setViewportSize({ width: 1440, height: 900 });
  await bob.goto(link.replace('playground.html', 'playground.html?name=Bob'));
  await expect.poll(() => editorText(bob)).toBe('Shared draft.');
  await expect(ann.locator('.cl-avatar')).toHaveCount(2);
  await bob.close();
  await expect(ann.locator('.cl-avatar')).toHaveCount(1, { timeout: 3000 });
});

test('a guest who closes the tab leaves the owner\'s title bar through the room server', async ({ browser }) => {
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
    await expect(owner.locator('.cl-avatar')).toHaveCount(2, { timeout: 15000 });
    await guest.close();
    await expect(owner.locator('.cl-avatar')).toHaveCount(1, { timeout: 8000 });
  } finally { await ownerContext.close(); await guestContext.close(); }
});
