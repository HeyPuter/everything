import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const SHOTS = process.env.COLLAB_SHOTS || '';
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const editorText = page => text(page).evaluate(el => el.value);

async function openPlayground(page, name) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/playground.html?name=${name}`);
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
}

/** Share from this page and return a link with the given role (local sharing: tabs of this browser). */
async function shareLink(page, roleLabel = 'Can edit') {
  await page.getByRole('button', { name: 'Share', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Invite People…' }).click();
  const dialog = page.getByRole('dialog', { name: /^Share/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'What people with the link can do' }).selectOption({ label: roleLabel });
  await dialog.getByRole('button', { name: 'Copy Link' }).click();
  const field = dialog.getByRole('textbox', { name: 'Invitation link' });
  await expect(field).toHaveValue(/collab-local=/);
  const link = await field.inputValue();
  await shot(page, 'share-dialog');
  await dialog.getByRole('button', { name: 'Done' }).click();
  return link;
}
const joinAs = (link, name) => link.replace('playground.html', `playground.html?name=${name}`);

test('two people typing at once in a shared document converge', async ({ context }) => {
  const ann = await context.newPage();
  await openPlayground(ann, 'Ann');
  await text(ann).fill('Shared draft.');
  const link = await shareLink(ann);
  const bob = await context.newPage();
  await bob.setViewportSize({ width: 1440, height: 900 });
  await bob.goto(joinAs(link, 'Bob'));
  await expect.poll(() => editorText(bob)).toBe('Shared draft.');
  // Both see each other.
  await expect(ann.locator('.cl-avatar')).toHaveCount(2);
  await expect(bob.locator('.cl-avatar')).toHaveCount(2);
  await expect(ann.locator('.cl-avatar[title^="Bob"]')).toHaveCount(1);
  // Ann types at the start while Bob types at the end.
  await text(ann).evaluate(el => { el.focus(); el.setSelectionRange(0, 0); el.dispatchEvent(new Event('select')); });
  await text(bob).evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select')); });
  await Promise.all([text(ann).pressSequentially('Ann: ', { delay: 15 }), text(bob).pressSequentially(' Bob was here.', { delay: 15 })]);
  await expect.poll(() => editorText(ann)).toBe('Ann: Shared draft. Bob was here.');
  await expect.poll(() => editorText(bob)).toBe('Ann: Shared draft. Bob was here.');
  // Undo takes back only Bob's own typing.
  await text(bob).press('ControlOrMeta+z');
  await expect.poll(() => editorText(ann)).not.toContain('Bob was here.');
  await expect.poll(() => editorText(ann)).toContain('Ann: Shared draft.');
  await shot(ann, 'coediting-ann');
  await shot(bob, 'coediting-bob');
});

test('a view-only link keeps the document read-only', async ({ context }) => {
  const ann = await context.newPage();
  await openPlayground(ann, 'Ann');
  await text(ann).fill('Look but do not touch.');
  const link = await shareLink(ann, 'Can view');
  const viewer = await context.newPage();
  await viewer.setViewportSize({ width: 1440, height: 900 });
  await viewer.goto(joinAs(link, 'Vic'));
  await expect.poll(() => editorText(viewer)).toBe('Look but do not touch.');
  await expect(viewer.locator('.cl-banner')).toContainText('You can view this document');
  await text(viewer).focus();
  await viewer.keyboard.type('xyz');
  await expect.poll(() => editorText(viewer)).toBe('Look but do not touch.');
  // The owner's edits still reach the viewer.
  await text(ann).evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select')); });
  await text(ann).pressSequentially(' Updated.');
  await expect.poll(() => editorText(viewer)).toBe('Look but do not touch. Updated.');
  await shot(viewer, 'view-only');
});

test('two Puter accounts edit one document through the room server', async ({ browser }) => {
  test.setTimeout(120000);
  // Separate contexts: separate in-memory drives, as for two people.
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const owner = await ownerContext.newPage();
  await owner.goto('/mock.html?user=ada#/new');
  await expect(owner.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(owner).fill('Quarterly plan.');
  await owner.getByRole('button', { name: 'Share', exact: true }).first().click();
  await owner.getByRole('menuitem', { name: 'Invite People…' }).click();
  const dialog = owner.getByRole('dialog', { name: /^Share/ });
  await dialog.getByRole('textbox', { name: 'People to invite' }).fill('bob');
  await dialog.getByRole('combobox', { name: 'Role for the people you invite' }).selectOption({ label: 'Can comment' });
  await dialog.getByRole('button', { name: 'Invite' }).click();
  await expect(dialog.locator('.sh-status')).toContainText('bob can open the document');
  await expect(dialog.getByRole('list', { name: 'People with access' })).toContainText('bob');
  const link = await dialog.getByRole('textbox', { name: 'Invitation link' }).inputValue();
  await shot(owner, 'share-dialog-cloud');
  await dialog.getByRole('button', { name: 'Done' }).click();
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guest = await guestContext.newPage();
  // The invitation by username admits bob (the link's own token is for anyone).
  await guest.goto(link.replace('mock.html', 'mock.html?user=bob').replace(/&collab-invite=[^&]*/, ''));
  await expect.poll(() => editorText(guest), { timeout: 15000 }).toBe('Quarterly plan.');
  await expect(guest.locator('.cl-banner')).toContainText('comment');
  await text(guest).focus();
  await guest.keyboard.type('nope');
  await expect.poll(() => editorText(guest)).toBe('Quarterly plan.');
  // The owner's typing reaches bob.
  await text(owner).evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.dispatchEvent(new Event('select')); });
  await text(owner).pressSequentially(' Revised.');
  await expect.poll(() => editorText(guest), { timeout: 15000 }).toBe('Quarterly plan. Revised.');
  await expect(owner.locator('.cl-avatar')).toHaveCount(2, { timeout: 15000 });
  await ownerContext.close(); await guestContext.close();
});

test('restores a named version from Version History', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('First version.');
  await text(page).press('ControlOrMeta+s');
  await expect(page.locator('.canvas-save-status')).toHaveAttribute('aria-label', 'Saved to Puter');
  await page.getByRole('tab', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Version History' }).click();
  const pane = page.getByRole('complementary', { name: 'Version History pane' });
  await expect(pane).toBeVisible();
  await pane.getByRole('button', { name: 'Save a Version Now' }).click();
  await page.getByRole('dialog', { name: 'Save a version' }).getByRole('textbox').fill('Clean draft');
  await page.getByRole('dialog', { name: 'Save a version' }).getByRole('button', { name: 'Save Version' }).click();
  await expect(pane.getByRole('listitem').first()).toContainText('Clean draft');
  await text(page).fill('Second version, much changed.');
  await text(page).press('ControlOrMeta+s');
  await expect(page.locator('.canvas-save-status')).toHaveAttribute('aria-label', 'Saved to Puter');
  // Open it beside the document, read-only.
  await pane.getByRole('button', { name: /Clean draft/ }).click();
  await expect(page.getByRole('complementary', { name: 'Earlier version (read only)' })).toBeVisible();
  await shot(page, 'version-history');
  await page.getByRole('complementary', { name: 'Earlier version (read only)' }).getByRole('button', { name: 'Restore' }).click();
  await page.getByRole('dialog', { name: 'Restore this version?' }).getByRole('button', { name: 'Restore' }).click();
  await expect.poll(() => editorText(page), { timeout: 15000 }).toBe('First version.');
});

test('the Assistant rewrites the selection as one undoable change', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('This sentence is a little long winded.');
  await text(page).evaluate(el => { el.focus(); el.setSelectionRange(0, el.value.length); el.dispatchEvent(new Event('select')); });
  await page.getByRole('button', { name: 'Assistant', exact: true }).first().click();
  const pane = page.getByRole('complementary', { name: 'Assistant pane' });
  await expect(pane).toBeVisible();
  await expect(pane.getByText(/Sends the 7 words you selected/)).toBeVisible();
  await pane.getByRole('button', { name: 'Make it shorter' }).click();
  await expect(pane.getByText('Suggested replacement')).toBeVisible();
  await shot(page, 'assistant');
  await pane.getByRole('button', { name: 'Replace Selection' }).click();
  await expect.poll(() => editorText(page)).toBe('This sentence is a little long winded. (revised)');
  await pane.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => editorText(page)).toBe('This sentence is a little long winded.');
  // A question about the whole document is answered, not inserted.
  await pane.getByRole('radio', { name: 'Whole document' }).click();
  await pane.getByRole('textbox', { name: 'Message the assistant' }).fill('What is this about?');
  await pane.getByRole('textbox', { name: 'Message the assistant' }).press('Enter');
  await expect(pane.getByText(/offline assistant read/)).toBeVisible();
});
