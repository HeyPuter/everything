import { test, expect } from '@playwright/test';

// A command that changes the header and the footer together is one undo step.
const stories = page => page.evaluate(() => {
  const e = window.__docs.current.view.engine, out = {};
  for (const [path, model] of e.session.models) if (path !== null) out[e.pageStories.stories[path].kind] = model.text;
  return { ...out, steps: e.session.history.length };
});
async function headerAndFooter(page, header, footer) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled({ timeout: 20000 });
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  await page.keyboard.type('Body');
  for (const [kind, text] of [['header', header], ['footer', footer]]) {
    await page.evaluate(kind => window.__docs.current.view.commands.headerItems(kind).find(item => /^Edit /.test(item.label)).onSelect(), kind);
    await expect.poll(() => page.evaluate(kind => { const e = window.__docs.current.view.engine; return e.session.path && e.pageStories.stories[e.session.path].kind; }, kind)).toBe(kind);
    await page.keyboard.type(text);
  }
  await page.keyboard.press('Escape');
}

test('Replace All in headers and footers is one undo step, named Replace All', async ({ page }) => {
  await headerAndFooter(page, 'Draft header', 'Draft footer');
  const before = await stories(page);
  expect(before).toMatchObject({ header: 'Draft header', footer: 'Draft footer' });
  await page.getByRole('button', { name: 'Find options' }).click();
  await page.getByRole('menuitem', { name: 'Advanced Find…' }).click();
  const panel = page.getByRole('search', { name: 'Find and replace' });
  await panel.getByRole('textbox', { name: 'Find text', exact: true }).fill('Draft');
  await panel.getByLabel('Search in').selectOption('headers');
  await panel.getByRole('textbox', { name: 'Replace with', exact: true }).fill('Final');
  await panel.getByRole('button', { name: 'Replace all', exact: true }).click();
  await expect(panel.locator('.canvas-find-notice')).toHaveText('Replaced 2 matches.');
  expect(await stories(page)).toEqual({ header: 'Final header', footer: 'Final footer', steps: before.steps + 1 });
  expect(await page.evaluate(() => window.__docs.current.view.commands.undoLabel())).toBe('Replace All');
  await page.evaluate(() => window.__docs.current.view.engine.undo());
  expect(await stories(page)).toEqual(before);
  await page.evaluate(() => window.__docs.current.view.engine.redo());
  expect(await stories(page)).toEqual({ header: 'Final header', footer: 'Final footer', steps: before.steps + 1 });
  expect(await page.evaluate(() => window.__docs.current.view.commands.undoLabel())).toBe('Replace All');
});

test('Remove Page Numbers from the header and the footer is one undo step', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled({ timeout: 20000 });
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  await page.keyboard.type('Body');
  // Plain Number 1 from the gallery.
  const insert = where => page.evaluate(where => {
    const items = window.__docs.current.view.commands.pageNumberItems().find(item => item.label === where).items;
    items.find(item => item.custom).custom.querySelector('button').click();
  }, where);
  await insert('Top of Page');
  await expect.poll(async () => (await stories(page)).header).toBe('￼');
  await page.keyboard.press('Escape');
  await insert('Bottom of Page');
  await expect.poll(async () => (await stories(page)).footer).toBe('￼');
  await page.keyboard.press('Escape');
  const before = await stories(page);
  await page.evaluate(() => window.__docs.current.view.commands.pageNumberItems().find(item => item.label === 'Remove Page Numbers').onSelect());
  await expect.poll(async () => (await stories(page)).header).toBe('');
  expect(await stories(page)).toEqual({ header: '', footer: '', steps: before.steps + 1 });
  await page.evaluate(() => window.__docs.current.view.engine.undo());
  expect(await stories(page)).toEqual(before);
});
