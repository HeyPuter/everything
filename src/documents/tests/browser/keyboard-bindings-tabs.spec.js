import { test, expect } from '@playwright/test';

// Customize Keyboard keeps its bindings in the browser, shared by every tab of the app.
const text = page => page.getByRole('textbox', { name: 'Document text' });
async function openEditor(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
}
async function bind(page, command, chord) {
  await page.getByRole('menubar', { name: 'Menu bar' }).getByRole('menuitem', { name: 'Tools', exact: true }).click();
  await page.getByRole('menu', { name: 'Tools', exact: true }).getByRole('menuitem', { name: 'Customize Keyboard…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Customize Keyboard' });
  await dialog.getByRole('searchbox', { name: 'Search commands' }).fill(command);
  await dialog.getByRole('option', { name: new RegExp(`^${command}`) }).first().click();
  await dialog.getByRole('textbox', { name: 'New shortcut' }).click();
  await page.keyboard.press(chord);
  await dialog.getByRole('button', { name: 'Assign' }).click();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
}
const formatting = page => page.evaluate(() => { const f = window.__docs.current.view.engine.model.runFormatting; return { underline: !!f.underline, italic: !!f.italic }; });

test.setTimeout(90000);
test('a shortcut assigned in one tab is kept when another tab assigns one, and works there at once', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const first = await context.newPage(), second = await context.newPage();
    await openEditor(first); await openEditor(second);
    await bind(first, 'Underline', 'ControlOrMeta+Alt+j');
    // The other tab, open all along, knows the new shortcut without reloading.
    await text(second).fill('Some words');
    await text(second).evaluate(el => { el.focus(); el.setSelectionRange(0, 4); el.dispatchEvent(new Event('select')); });
    await text(second).press('ControlOrMeta+Alt+j');
    expect(await formatting(second)).toEqual({ underline: true, italic: false });
    // A shortcut assigned there keeps the first tab's.
    await bind(second, 'Italic', 'ControlOrMeta+Alt+k');
    const stored = JSON.parse(await first.evaluate(() => localStorage.getItem('documents:keybindings')));
    expect(stored['ribbon:home/font/Underline']).toEqual(['Mod+Alt+J']);
    expect(stored['ribbon:home/font/Italic']).toEqual(['Mod+Alt+K']);
    await first.reload(); await expect(first.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
    await text(first).fill('Other words');
    await text(first).evaluate(el => { el.focus(); el.setSelectionRange(0, 5); el.dispatchEvent(new Event('select')); });
    await text(first).press('ControlOrMeta+Alt+j'); await text(first).press('ControlOrMeta+Alt+k');
    expect(await formatting(first)).toEqual({ underline: true, italic: true });
  } finally { await context.close(); }
});
