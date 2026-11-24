import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const tracking = page => page.locator('.ed-status-track').getAttribute('aria-pressed');

// Someone who can only comment had Track Changes, Accept and Reject on the Review tab as if they could edit: Track
// Changes changed their copy, the room refused it and took it back with "Your latest changes could not be shared".
// They are now unavailable up front, as under comments-only protection.
test('someone who can only comment cannot turn Track Changes off or accept changes', async ({ context }) => {
  const ann = await context.newPage();
  await ann.setViewportSize({ width: 1440, height: 900 });
  await ann.goto('/playground.html?name=Ann');
  await expect(ann.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(ann).fill('Shared draft.');
  await text(ann).evaluate(el => { el.focus(); el.setSelectionRange(0, 0); el.dispatchEvent(new Event('select')); });
  await ann.keyboard.press('ControlOrMeta+Shift+E');
  await expect.poll(() => tracking(ann)).toBe('true');
  await ann.keyboard.type('New ');
  await ann.getByRole('button', { name: 'Share', exact: true }).first().click();
  await ann.getByRole('menuitem', { name: 'Invite People…' }).click();
  const dialog = ann.getByRole('dialog', { name: /^Share/ });
  await dialog.getByRole('combobox', { name: 'What people with the link can do' }).selectOption('commenter');
  await dialog.getByRole('button', { name: 'Copy Link' }).click();
  const field = dialog.getByRole('textbox', { name: 'Invitation link' });
  await expect(field).toHaveValue(/collab-local=/);
  const link = await field.inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();

  const bob = await context.newPage();
  await bob.setViewportSize({ width: 1440, height: 900 });
  await bob.goto(link.replace('playground.html', 'playground.html?name=Bob'));
  await expect.poll(() => text(bob).inputValue()).toBe('New Shared draft.');
  await expect.poll(() => tracking(bob)).toBe('true');
  await bob.locator('#ribbon-tab-review').click();
  await text(bob).evaluate(el => { el.focus(); el.setSelectionRange(1, 1); el.dispatchEvent(new Event('select')); });
  const panel = bob.locator('#ribbon-panel-review');
  await expect(panel.getByRole('button', { name: 'Accept', exact: true }).first()).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Reject', exact: true }).first()).toBeDisabled();
  await bob.keyboard.press('ControlOrMeta+Shift+E');
  await expect(bob.getByText('Track Changes cannot be turned on or off')).toBeVisible();
  await expect(bob.getByText('could not be shared')).toHaveCount(0);
  expect(await tracking(bob)).toBe('true');
  expect(await tracking(ann)).toBe('true');
  // Commenting still works.
  await panel.getByRole('button', { name: 'New Comment', exact: true }).click();
  await bob.keyboard.type('Looks good');
  await bob.keyboard.press('ControlOrMeta+Enter');
  await expect(ann.locator('.ed-comment-card')).toContainText('Looks good');
});
