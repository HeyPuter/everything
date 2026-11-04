import { test, expect } from '@playwright/test';

// Header and footer options and page numbering are document changes like any other: Undo takes back the option
// itself, not the edit made before it, and Redo puts it back.
const engine = page => page.evaluate(() => {
  const e = window.__docs.current.view.engine, definition = e.pageStories;
  return { first: !!definition?.sections[0]?.firstPageDifferent, evenAndOdd: !!definition?.evenAndOdd, numbering: definition?.sections[0]?.pageNumbering || null, body: e.session.body.text, steps: e.session.history.length };
});

test('Undo takes back Different First Page, and Redo applies it again', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled({ timeout: 20000 });
  const text = page.getByRole('textbox', { name: 'Document text' });
  await text.focus();
  await page.keyboard.type('Body');
  await page.evaluate(() => window.__docs.current.view.commands.headerItems('header').find(item => item.label === 'Edit Header').onSelect());
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.session.path)).not.toBeNull();
  await page.keyboard.type('Head');
  const before = await engine(page);
  const first = page.getByRole('checkbox', { name: 'Different First Page' });
  await first.check();
  await expect.poll(async () => (await engine(page)).first).toBe(true);
  expect((await engine(page)).steps).toBe(before.steps + 1);
  expect(await page.evaluate(() => window.__docs.current.view.commands.undoLabel())).toBe('Different First Page');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await engine(page)).first).toBe(false);
  await expect(first).not.toBeChecked();
  // The header text typed before it, and the body, are still there.
  expect(await engine(page)).toMatchObject({ body: 'Body', steps: before.steps });
  expect(await page.evaluate(() => [...window.__docs.current.view.engine.session.models.values()].some(m => m.text === 'Head'))).toBe(true);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await engine(page)).first).toBe(true);
  await expect(first).toBeChecked();
  // What is saved follows: undone, the file has no title page setting.
  await page.keyboard.press('ControlOrMeta+z');
  const settings = await page.evaluate(async () => {
    const blob = await window.__docs.current.view.commands.exportPackage();
    const { unzipSync, strFromU8 } = await import('/node_modules/fflate/esm/browser.js');
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    return strFromU8(files['word/document.xml']);
  });
  expect(settings).not.toContain('titlePg');
});

test('Undo takes back Different Odd & Even Pages and a page number format', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled({ timeout: 20000 });
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  await page.keyboard.type('Body');
  await page.evaluate(() => window.__docs.current.view.commands.headerItems('header').find(item => item.label === 'Edit Header').onSelect());
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.session.path)).not.toBeNull();
  await page.keyboard.type('Head');
  const before = await engine(page);
  await page.getByRole('checkbox', { name: 'Different Odd & Even Pages' }).check();
  await expect.poll(async () => (await engine(page)).evenAndOdd).toBe(true);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await engine(page)).evenAndOdd).toBe(false);
  expect((await engine(page)).steps).toBe(before.steps);
  await page.keyboard.press('Escape');
  // Format Page Numbers: roman numerals from iii.
  await page.evaluate(() => window.__docs.current.view.commands.formatPageNumbers());
  const dialog = page.getByRole('dialog', { name: 'Page Number Format' });
  await dialog.getByRole('combobox', { name: 'Number format' }).selectOption('lowerRoman');
  await dialog.getByRole('radio', { name: 'Start at' }).check();
  await dialog.getByRole('spinbutton', { name: 'Start at' }).fill('3');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect.poll(async () => (await engine(page)).numbering).toEqual({ format: 'lowerRoman', start: 3 });
  const steps = (await engine(page)).steps;
  await page.getByRole('textbox', { name: 'Document text' }).press('ControlOrMeta+z');
  await expect.poll(async () => (await engine(page)).numbering).toBeNull();
  expect(await engine(page)).toMatchObject({ body: 'Body', steps: steps - 1 });
  await page.getByRole('textbox', { name: 'Document text' }).press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await engine(page)).numbering).toEqual({ format: 'lowerRoman', start: 3 });
});

test('Page Setup changing margins and Different First Page together is one undo step', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled({ timeout: 20000 });
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  await page.keyboard.type('Body');
  const before = await engine(page);
  const top = () => page.evaluate(() => window.__docs.current.view.engine.session.body.pageSettings.top);
  const topBefore = await top();
  await page.evaluate(() => window.__docs.current.view.commands.openPageSetup());
  const dialog = page.getByRole('dialog', { name: 'Page Setup' });
  await dialog.getByLabel('Top margin').fill('2');
  await dialog.getByRole('tab', { name: 'Layout' }).click();
  await dialog.getByLabel('Different first page').check();
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(async () => (await engine(page)).first).toBe(true);
  expect(await top()).not.toBe(topBefore);
  expect((await engine(page)).steps).toBe(before.steps + 1);
  await page.getByRole('textbox', { name: 'Document text' }).press('ControlOrMeta+z');
  await expect.poll(async () => (await engine(page)).first).toBe(false);
  expect(await top()).toBe(topBefore);
  expect((await engine(page)).steps).toBe(before.steps);
  await page.getByRole('textbox', { name: 'Document text' }).press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await engine(page)).first).toBe(true);
  expect(await top()).not.toBe(topBefore);
});
