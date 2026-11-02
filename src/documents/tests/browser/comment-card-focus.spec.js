import { test, expect } from '@playwright/test';

const engine = 'window.__docs.current.view.engine';
const input = page => page.getByRole('textbox', { name: 'Document text' });

// Saving an edited comment, posting a reply, or resolving or deleting a thread from its card's menu rebuilt the
// comment column and took away the control that had the keyboard: focus fell to the page itself, so the next key
// went nowhere. It goes to the thread's card, or back to the document when the thread is gone.
test('the keyboard stays on the thread, or goes back to the document, after a comment action', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Alpha beta gamma.\nSecond line.');
  await page.evaluate(engine => { const e = eval(engine), m = e.model; e.execute(() => { m.addComment({ author: 'Bo', text: 'One', range: [0, 5] }); m.addComment({ author: 'Cy', text: 'Two', range: [18, 24] }); }); }, engine);
  await page.getByRole('tab', { name: 'Review' }).click();
  const first = page.locator('.ed-comment-card[data-thread="0"]'), second = page.locator('.ed-comment-card[data-thread="1"]');
  const onPage = () => page.evaluate(() => document.activeElement === document.body);
  // Edit and save with Ctrl+Enter.
  await first.click();
  await first.getByRole('button', { name: /More thread actions/ }).first().click();
  await page.getByRole('menuitem', { name: 'Edit comment' }).click();
  const edit = first.getByRole('textbox', { name: 'Edit comment' });
  await expect(edit).toBeFocused();
  await edit.fill('One more');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(first.locator('.wcc-text')).toHaveText('One more');
  await expect(first).toBeFocused();
  // Post a reply.
  await first.getByRole('textbox', { name: 'Reply' }).click();
  await page.keyboard.type('A reply');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(first.locator('.wcc-entry')).toHaveCount(2);
  await expect(first).toBeFocused();
  // Resolve from the card's menu, chosen with the keyboard.
  await first.getByRole('button', { name: /More thread actions/ }).first().click();
  await page.getByRole('menuitem', { name: 'Resolve thread' }).click();
  await expect.poll(() => page.evaluate(engine => eval(engine).session.body.comments.find(c => c.id === '0').done, engine)).toBe(true);
  await expect(first).toBeFocused();
  expect(await onPage()).toBe(false);
  // Delete a thread from its menu: the keyboard goes back to the document, and typing goes there.
  await second.click();
  await second.getByRole('button', { name: /More thread actions/ }).first().click();
  await page.getByRole('menuitem', { name: 'Delete thread' }).click();
  await expect(second).toHaveCount(0);
  await expect(input(page)).toBeFocused();
  await page.keyboard.type('Z');
  await expect.poll(() => page.evaluate(engine => eval(engine).session.body.text.includes('Z'), engine)).toBe(true);
  expect(errors).toEqual([]);
});
