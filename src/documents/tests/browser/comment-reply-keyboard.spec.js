import { test, expect } from '@playwright/test';

const input = page => page.getByRole('textbox', { name: 'Document text' });

// The comment cards sit after the document, where Tab types a tab, and the document's menu offered only New,
// Resolve and Delete Comment: a comment could not be answered from the keyboard. Reply to Comment opens the
// thread's card with the keyboard in its reply box.
test('Reply to Comment in the document menu answers a comment from the keyboard', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).fill('Alpha beta gamma.');
  await page.evaluate(() => { const e = window.__docs.current.view.engine, m = e.model; e.execute(() => { m.addComment({ author: 'Bo', text: 'One', range: [0, 5] }); }); });
  await input(page).evaluate(el => { el.focus(); el.setSelectionRange(2, 2); el.dispatchEvent(new Event('select')); });
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu').filter({ visible: true });
  await menu.getByRole('menuitem', { name: 'Reply to Comment' }).click();
  const card = page.locator('.ed-comment-card[data-thread="0"]');
  await expect(card.getByRole('textbox', { name: 'Reply' })).toBeFocused();
  await page.keyboard.type('Agreed');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(card.locator('.wcc-entry')).toHaveCount(2);
  expect(await page.evaluate(() => window.__docs.current.view.engine.session.body.comments.map(c => [c.text, c.parentId]))).toEqual([['One', null], ['Agreed', '0']]);
  // A resolved thread is reopened before it is answered: the menu does not offer a reply to it.
  await page.evaluate(() => { const e = window.__docs.current.view.engine; e.execute(() => e.session.body.setCommentDone('0', true)); });
  await input(page).evaluate(el => { el.focus(); el.setSelectionRange(2, 2); el.dispatchEvent(new Event('select')); });
  await page.keyboard.press('Shift+F10');
  await expect(menu.getByRole('menuitem', { name: 'Reopen Comment' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Reply to Comment' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
