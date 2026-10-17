import { test, expect } from '@playwright/test';

const text = page => page.getByRole('textbox', { name: 'Document text' });
const engine = page => page.evaluate(() => {
  const e = window.__docs.current.view.engine;
  return { text: e.model.text, italic: e.model.runFormatting.italic, history: e.session.history.length };
});
async function select(page, start, end) {
  await text(page).evaluate((el, [a, b]) => { el.focus(); el.setSelectionRange(a, b); el.dispatchEvent(new Event('select')); }, [start, end]);
}

test('document commands stay out of the window’s own text fields', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await text(page).fill('Source target other');
  await select(page, 14, 19);
  await page.getByRole('button', { name: 'Italic', exact: true }).click();
  await select(page, 0, 6);
  const before = await engine(page);
  // In the search box, F4 and Cmd/Ctrl+Y are the field's own keys: no Repeat on the document.
  await text(page).press('ControlOrMeta+f');
  const search = page.getByRole('searchbox', { name: 'Search document' }).or(page.getByRole('textbox', { name: 'Search document' }));
  await expect(search).toBeFocused();
  await page.keyboard.type('tar');
  await page.keyboard.press('F4');
  await page.keyboard.press('ControlOrMeta+y');
  await expect(search).toBeFocused();
  expect(await engine(page)).toEqual(before);
  // Back in the document, Repeat still works.
  await select(page, 0, 6);
  await text(page).press('F4');
  expect((await engine(page)).italic).toBe(true);
});

test('the Toggle Drawing shortcut stays out of the window’s own text fields', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const tool = () => page.evaluate(() => window.__docs.current.view.commands.drawState().tool);
  const chord = process.platform === 'darwin' ? 'Meta+Control+z' : 'Control+Alt+z';
  await text(page).press('ControlOrMeta+f');
  const search = page.getByRole('searchbox', { name: 'Search document' }).or(page.getByRole('textbox', { name: 'Search document' }));
  await expect(search).toBeFocused();
  await page.keyboard.press(chord);
  await expect(search).toBeFocused();
  expect(await tool()).toBe('select');
  // In the document the shortcut still switches to the pen.
  await text(page).focus();
  await page.keyboard.press(chord);
  await expect.poll(tool).not.toBe('select');
});
