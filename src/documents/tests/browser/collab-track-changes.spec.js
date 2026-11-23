import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const tracking = page => page.locator('.ed-status-track').getAttribute('aria-pressed');

// Track Changes is a setting of the shared document. Turned on from the Review tab it reached nobody until its owner
// next edited, and an edit by someone else before that turned it back off for the one who turned it on.
test('Track Changes turned on in a shared document is on for everyone at once and stays on', async ({ context }) => {
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
  await expect.poll(() => text(bob).inputValue()).toBe('Shared draft.');

  await ann.locator('#ribbon-tab-review').click();
  await ann.locator('#ribbon-panel-review').getByRole('button', { name: 'Track Changes', exact: true }).first().click();
  await expect.poll(() => tracking(ann)).toBe('true');
  await expect.poll(() => tracking(bob)).toBe('true');
  // Bob's typing is tracked, and leaves Track Changes on for Ann.
  await text(bob).evaluate(el => { el.focus(); el.setSelectionRange(0, 0); el.dispatchEvent(new Event('select')); });
  await bob.keyboard.type('Bob ');
  await expect.poll(() => text(ann).inputValue()).toBe('Bob Shared draft.');
  expect(await tracking(ann)).toBe('true');
  await ann.locator('#ribbon-panel-review').getByRole('button', { name: 'Reviewing Pane', exact: true }).first().click();
  await expect(ann.getByRole('complementary', { name: /Reviewing/ }).first()).toContainText('Bob');
  // Turned off again, it is off for both.
  await ann.locator('#ribbon-panel-review').getByRole('button', { name: 'Track Changes', exact: true }).first().click();
  await expect.poll(() => tracking(bob)).toBe('false');
});
