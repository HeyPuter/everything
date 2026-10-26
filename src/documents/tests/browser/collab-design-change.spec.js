import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const editorText = page => text(page).evaluate(el => el.value);
const typeAtEnd = async (page, words) => {
  await text(page).evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select')); });
  await text(page).pressSequentially(words);
};

test('Design changes wait until sharing ends, so the document stays shared both ways', async ({ browser }) => {
  test.setTimeout(120000);
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const owner = await ownerContext.newPage();
  await owner.goto('/mock.html?user=ada#/new');
  await expect(owner.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(owner).fill('Quarterly plan.');
  // A Design change (a theme, a style set, a watermark) rewrites the package and reopens the editor on it.
  expect(await owner.evaluate(() => window.__docs.current.view.commands.changePackage(async blob => blob))).toBe(true);
  expect(await owner.evaluate(() => window.__docs.current.view.commands.packageHistory().undo)).toBe(true);
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
  await expect(owner.locator('.cl-avatar')).toHaveCount(2, { timeout: 15000 });
  // The room holds no package: changing it now would leave the others behind, and undoing the earlier one would
  // reopen the document as it was before sharing.
  expect(await owner.evaluate(() => window.__docs.current.view.commands.packageHistory().undo)).toBe(false);
  expect(await owner.evaluate(() => window.__docs.current.view.commands.changePackage(async blob => blob))).toBe(false);
  await expect(owner.locator('.toast').filter({ hasText: 'cannot be changed while the document is shared' })).toBeVisible();
  await typeAtEnd(owner, ' Owner.');
  await expect.poll(() => editorText(guest), { timeout: 15000 }).toBe('Quarterly plan. Owner.');
  await typeAtEnd(guest, ' Guest.');
  await expect.poll(() => editorText(owner), { timeout: 15000 }).toBe('Quarterly plan. Owner. Guest.');
  await ownerContext.close(); await guestContext.close();
});
