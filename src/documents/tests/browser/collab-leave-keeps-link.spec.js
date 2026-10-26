import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const editorText = page => text(page).evaluate(el => el.value);

test('staying in a shared document after the leave question keeps its address', async ({ browser }) => {
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
  await dialog.getByRole('button', { name: 'Invite' }).click();
  await expect(dialog.locator('.sh-status')).toContainText('bob can open the document');
  const link = await dialog.getByRole('textbox', { name: 'Invitation link' }).inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guest = await guestContext.newPage();
  await guest.goto(link.replace('mock.html', 'mock.html?user=bob').replace(/&collab-invite=[^&]*/, ''));
  await expect.poll(() => editorText(guest), { timeout: 15000 }).toBe('Quarterly plan.');
  const address = await guest.evaluate(() => location.hash);
  expect(address).toContain('collab-room');
  // The connection drops: what the guest types now has not reached anyone.
  await guest.route('**/__collab/api', route => route.abort());
  await text(guest).evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select')); });
  await text(guest).pressSequentially(' Draft.');
  await guest.getByRole('button', { name: 'All Documents' }).first().click();
  const question = guest.getByRole('dialog', { name: 'Leave without saving?' });
  await expect(question).toBeVisible({ timeout: 15000 });
  await question.getByRole('button', { name: 'Keep editing' }).click();
  await expect(question).toBeHidden();
  // A reload, or the address copied from here, must bring the shared document back, not a new one.
  expect(await guest.evaluate(() => location.hash)).toBe(address);
  await ownerContext.close(); await guestContext.close();
});
