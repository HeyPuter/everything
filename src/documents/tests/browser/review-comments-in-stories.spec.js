import { test, expect } from '@playwright/test';

const input = page => page.locator('.canvas-input');
const engine = 'window.__docs.current.view.engine';

// Comments belong to the body. Editing a header, footer or note read them from the story being edited, which has
// none: every comment card disappeared, the Reviewing Pane and Comments pane said there were no comments, and Next
// Comment, Resolve and Reply were unavailable until the story was left.
test('comments stay shown and can be answered while the header is edited', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Alpha beta gamma.\nSecond paragraph.');
  await page.evaluate(engine => {
    const e = eval(engine), m = e.model;
    e.execute(() => { m.addComment({ author: 'Bo', text: 'First note', range: [0, 5] }); m.addComment({ author: 'Bo', text: 'Second note', range: [18, 24] }); });
  }, engine);
  await page.getByRole('tab', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Reviewing Pane', exact: true }).filter({ visible: true }).first().click();
  const pane = page.getByRole('complementary', { name: 'Reviewing Pane' }), cards = page.locator('.ed-comments-layer .ed-comment-card[data-thread]');
  await expect(cards).toHaveCount(2);
  await expect(pane.locator('.review-pane-summary')).toContainText('2 comments');
  await page.getByRole('tab', { name: 'Insert' }).click();
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Header', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Header' }).click();
  await expect(input(page)).toHaveAttribute('aria-label', 'Header text');
  await page.keyboard.type('Head');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toBeVisible();
  await expect(pane.locator('.review-pane-summary')).toContainText('2 comments');
  await page.getByRole('tab', { name: 'Review' }).click();
  // A comment cannot be added to the header, but the body's comments can be gone through.
  await expect(page.getByRole('button', { name: 'New Comment', exact: true }).filter({ visible: true }).first()).toBeDisabled();
  const next = page.getByRole('button', { name: 'Next Comment', exact: true }).filter({ visible: true }).first();
  await expect(next).toBeEnabled();
  // Resolving a comment from its card is the body's change, undone as one.
  await cards.nth(1).getByRole('button', { name: 'More thread actions for Bo' }).click();
  await page.getByRole('menuitem', { name: 'Resolve thread' }).click();
  await expect(input(page)).toHaveAttribute('aria-label', 'Document text');
  await expect.poll(() => page.evaluate(engine => eval(engine).session.body.comments.map(c => !!c.done), engine)).toEqual([false, true]);
  await input(page).press('ControlOrMeta+z');
  await expect.poll(() => page.evaluate(engine => eval(engine).session.body.comments.map(c => !!c.done), engine)).toEqual([false, false]);
  // The header keeps its typing.
  expect(await page.evaluate(engine => Object.values(eval(engine).session.storyEdits).some(s => s.paragraphs.some(p => p.runs.some(r => r.text.includes('Head')))), engine)).toBe(true);
  // From the header again, Next Comment goes to a comment in the body.
  await page.evaluate(engine => { const e = eval(engine); e.editStory([...e.session.models.keys()].find(path => path !== null)); }, engine);
  await expect(input(page)).toHaveAttribute('aria-label', 'Header text');
  await page.getByRole('tab', { name: 'Review' }).click();
  await next.click();
  await expect(input(page)).toHaveAttribute('aria-label', 'Document text');
  await expect.poll(() => input(page).evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd))).toMatch(/^(Alpha|Second)$/);
  expect(errors).toEqual([]);
});

test('the Comments pane lists the comments while the header is edited', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Alpha beta gamma.');
  await page.evaluate(engine => { const e = eval(engine), m = e.model; e.execute(() => { m.addComment({ author: 'Bo', text: 'First note', range: [0, 5] }); }); }, engine);
  await page.getByRole('tab', { name: 'Insert' }).click();
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Header', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Header' }).click();
  await expect(input(page)).toHaveAttribute('aria-label', 'Header text');
  await page.getByRole('tab', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Show Comments options' }).filter({ visible: true }).first().click();
  await page.getByRole('menuitemradio', { name: 'List' }).click();
  const list = page.getByRole('list', { name: 'Comments' });
  await expect(list.getByRole('button')).toHaveCount(1);
  await expect(list).toContainText('First note');
  expect(errors).toEqual([]);
});
