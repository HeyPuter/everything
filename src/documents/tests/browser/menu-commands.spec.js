import { test, expect } from '@playwright/test';
import { onTab, showAllTools, fileCommand } from './helpers/editor-tools.js';

const input = page => page.getByRole('textbox', { name: 'Document text' });
const item = (page, name) => page.getByRole('menuitem', { name, exact: true });
const ribbon = page => page.locator('.ribbon-card');
async function blank(page) { await page.goto('/mock.html#/new'); await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled(); }
async function select(page, from, to) { await input(page).evaluate((el, [a, b]) => { el.focus(); el.setSelectionRange(a, b); el.dispatchEvent(new Event('select')); }, [from, to]); }

test('Remove link is available only where there is a link', async ({ page }) => {
  await blank(page); await showAllTools(page);
  const unlink = page.getByRole('button', { name: 'Remove link', exact: true });
  await input(page).fill('Plain words and a link');
  await select(page, 0, 5); await expect(unlink).toBeDisabled();
  await select(page, 18, 22); await input(page).press('ControlOrMeta+k');
  await page.getByLabel('Link address', { exact: true }).fill('https://example.com');
  await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
  // A selection reaching into the link, and the caret inside it, both offer it.
  await select(page, 10, 20); await expect(unlink).toBeEnabled();
  await select(page, 20, 20); await unlink.click();
  expect(await page.evaluate(() => window.__docs.current.view.engine.model.paragraphs[0].runs.some(r => r.link))).toBe(false);
});

test('Insert table works with text selected and puts the table after it', async ({ page }) => {
  await blank(page);
  await input(page).fill('Keep this text');
  await select(page, 5, 9);
  const insertTable = (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true });
  await expect(insertTable).toBeEnabled(); await insertTable.click();
  await page.getByRole('button', { name: 'Insert', exact: true }).click();
  const model = await page.evaluate(() => { const m = window.__docs.current.view.engine.model; return { text: m.paragraphs.filter(p => !p.cellId).map(p => p.runs.map(r => r.text).join('')), tables: m.tables.length, inCell: !!m.tableContext }; });
  expect(model).toEqual({ text: ['Keep this', ' text'], tables: 1, inCell: true });
  await input(page).press('ControlOrMeta+z');
  await expect(input(page)).toHaveValue('Keep this text');
});

test('menu commands that open a dialog end in an ellipsis and only submenus show an arrow', async ({ page }) => {
  await blank(page);
  await page.getByRole('button', { name: 'File', exact: true }).click();
  for (const name of ['Open .docx…', 'Rename…', 'Page Setup…']) {
    await expect(item(page, name)).toBeVisible();
    await expect(item(page, name).locator('.menu-arrow')).toHaveCount(0);
  }
  await page.keyboard.press('Escape');
  await (await onTab(page, 'layout')).locator('.ribbon-card').getByRole('button', { name: 'Margins', exact: true }).click();
  await expect(item(page, 'Custom Margins…')).toBeVisible();
  await expect(item(page, 'Custom Margins…').locator('.menu-arrow')).toHaveCount(0);
});

test('the bookmarks dialog keeps its parts apart and its buttons on screen on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await blank(page);
  const bookmarks = (await onTab(page, 'insert')).getByRole('button', { name: 'Bookmarks', exact: true });
  await bookmarks.scrollIntoViewIfNeeded(); await bookmarks.click();
  const dialog = page.getByRole('dialog', { name: 'Bookmarks' });
  // The phone sheet slides up; measure once it has settled.
  await expect.poll(async () => { const a = await dialog.boundingBox(); await page.waitForTimeout(100); const b = await dialog.boundingBox(); return a && b && a.y === b.y; }).toBe(true);
  for (const name of ['Go to bookmark', 'Delete bookmark', 'Done', 'Add bookmark']) {
    const box = await dialog.getByRole('button', { name, exact: true }).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  }
  const hint = await dialog.locator('.field-hint').boundingBox(), add = await dialog.getByRole('button', { name: 'Add bookmark', exact: true }).boundingBox();
  expect(add.y - (hint.y + hint.height)).toBeGreaterThanOrEqual(8);
});

test('closing a dialog opened from the ribbon returns to the document with the selection', async ({ page }) => {
  await blank(page);
  await input(page).fill('Keep typing here');
  for (const [tab, name, close] of [['home', 'Paragraph Settings', 'Escape'], ['layout', 'Page setup', 'Cancel'], ['insert', 'Bookmarks', 'Escape']]) {
    await select(page, 5, 11);
    await (await onTab(page, tab)).locator('.ribbon-card').getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    if (close === 'Escape') await page.keyboard.press('Escape');
    else await page.getByRole('dialog').getByRole('button', { name: close, exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(input(page)).toBeFocused();
    expect(await input(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([5, 11]);
  }
  await page.keyboard.press('End'); await page.keyboard.type(' now');
  await expect(input(page)).toHaveValue('Keep typing here now');
});

test('a ribbon menu opened with the mouse closes back into the document; one opened from the keyboard returns to its button', async ({ page }) => {
  await blank(page);
  await input(page).fill('Text'); await select(page, 1, 3);
  const margins = (await onTab(page, 'layout')).locator('.ribbon-card').getByRole('button', { name: 'Margins', exact: true });
  await margins.click(); await page.keyboard.press('Escape');
  await expect(input(page)).toBeFocused();
  await margins.click(); await margins.click();
  await expect(page.getByRole('menu')).toHaveCount(0); await expect(input(page)).toBeFocused();
  expect(await input(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([1, 3]);
  await margins.focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('menu')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(margins).toBeFocused();
  const file = page.getByRole('button', { name: 'File', exact: true });
  await file.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  await expect(file).toBeFocused();
});

test('ribbon pickers opened with the mouse close back into the document', async ({ page }) => {
  await blank(page);
  await input(page).fill('Some text'); await select(page, 0, 4);
  for (const [tab, name] of [['home', 'Text color'], ['home', 'Text highlight'], ['home', 'Line and Paragraph Spacing'], ['insert', 'Insert table'], ['home', 'Latin font family']]) {
    const button = (await onTab(page, tab)).getByRole('button', { name, exact: true });
    await button.click(); await expect(page.locator('.menu')).toHaveCount(1);
    // Mouse-opened, the current choice has no keyboard focus ring.
    if (name === 'Text color') expect(await page.locator('.menu :focus').evaluate(el => getComputedStyle(el).outlineStyle)).toBe('none');
    await page.keyboard.press('Escape');
    await expect(input(page)).toBeFocused();
    expect(await input(page).evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([0, 4]);
  }
  // From the keyboard, a picker returns to its button.
  const color = (await onTab(page, 'home')).getByRole('button', { name: 'Text color', exact: true });
  await color.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
  await expect(color).toBeFocused();
});

test('File menu commands act on the document', async ({ page }) => {
  await blank(page);
  await input(page).fill('Printed words');
  await expect(await fileCommand(page, 'Print / Save as PDF')).toBeEnabled();
  await page.keyboard.press('Escape');
});
