import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const editorText = page => text(page).evaluate(el => el.value);

/** A narrow window shows fewer avatars in the title bar; the "+N" button counts everyone it leaves out. */
test('a narrow window counts the people whose avatars it leaves out', async ({ context }) => {
  test.setTimeout(60000);
  const ann = await context.newPage();
  await ann.setViewportSize({ width: 1280, height: 800 });
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
  for (const name of ['Bob', 'Cleo']) {
    const page = await context.newPage();
    await page.goto(link.replace('playground.html', `playground.html?name=${name}`));
    await expect.poll(() => editorText(page)).toBe('Shared draft.');
  }
  const avatars = ann.locator('.cl-presence .cl-avatar:visible');
  await expect(avatars).toHaveCount(3);
  await expect(ann.locator('.cl-more')).toHaveCount(0);
  await ann.setViewportSize({ width: 420, height: 800 });
  // Two avatars and "+1" for the third person.
  await expect(avatars).toHaveCount(3);
  await expect(ann.getByRole('button', { name: '1 more' })).toBeVisible();
  await ann.getByRole('button', { name: '1 more' }).click();
  await expect(ann.getByRole('menu', { name: 'People in this document' })).toContainText('Cleo');
  await ann.keyboard.press('Escape');
  // Wide again: everyone's avatar, and no "+N".
  await ann.setViewportSize({ width: 1280, height: 800 });
  await expect(avatars).toHaveCount(3);
  await expect(ann.locator('.cl-more')).toHaveCount(0);
});
