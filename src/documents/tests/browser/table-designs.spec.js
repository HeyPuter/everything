import { test, expect } from '@playwright/test';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

const pixel = (page, x, y) => page.locator('canvas.canvas-page').first().evaluate((c, [x, y]) => {
  const scale = c.width / c.getBoundingClientRect().width;
  return [...c.getContext('2d').getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)];
}, [x, y]);

test('applies a table style from the gallery, follows the style options and saves the style', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.focus();
  await (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '3 columns, 3 rows' }).click();
  for (const [i, text] of ['Item', 'Qty', 'Cost', 'Pens', '2', '4', 'Ink', '1', '9'].entries()) { if (i) await input.press('Tab'); await page.keyboard.type(text); }
  await onTab(page, 'tableDesign');
  const gallery = page.getByRole('listbox', { name: 'Table Styles' });
  await expect(gallery.getByRole('option')).not.toHaveCount(0);
  // Every style is in the More panel, grouped by family.
  await page.getByRole('button', { name: 'More Table Styles' }).click();
  await expect(page.getByRole('group', { name: 'Grid Tables' })).toBeVisible();
  await page.getByRole('menuitemradio', { name: 'Grid Banded · Green' }).click();
  await expect(input).toBeFocused();
  await expect(gallery.getByRole('option', { name: 'Grid Banded · Green' })).toHaveAttribute('aria-selected', 'true');
  const cell = async text => {
    await input.evaluate((el, text) => { const at = el.value.indexOf(text); el.setSelectionRange(at, at); el.dispatchEvent(new Event('select', { bubbles: true })); }, text);
    return input.evaluate(el => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
  };
  // The header row has the dark accent fill and the first body row the light band.
  const header = await cell('Qty'), body = await cell('2'), last = await cell('1');
  await expect.poll(() => pixel(page, header.x + 30, header.y + 3)).toEqual([0x4A, 0x7A, 0x35]);
  expect(await pixel(page, body.x + 30, body.y + 3)).toEqual([0xE3, 0xEF, 0xDB]);
  expect(await pixel(page, last.x + 30, last.y + 3)).toEqual([255, 255, 255]);
  // Banded Rows off clears the band at once; undo brings it back in one step.
  await page.getByRole('checkbox', { name: 'Banded Rows' }).uncheck();
  await expect.poll(() => pixel(page, body.x + 30, body.y + 3)).toEqual([255, 255, 255]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => pixel(page, body.x + 30, body.y + 3)).toEqual([0xE3, 0xEF, 0xDB]);
  await expect(page.getByRole('checkbox', { name: 'Banded Rows' })).toBeChecked();
  // Header Row off: the first row loses its fill and joins the bands.
  await page.getByRole('checkbox', { name: 'Header Row' }).uncheck();
  await expect.poll(() => pixel(page, header.x + 30, header.y + 3)).toEqual([0xE3, 0xEF, 0xDB]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'More Table Styles' }).click();
  await page.getByRole('menuitemradio', { name: 'Plain Grid' }).click();
  await expect.poll(() => pixel(page, header.x + 30, header.y + 3)).toEqual([255, 255, 255]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => pixel(page, header.x + 30, header.y + 3)).toEqual([0x4A, 0x7A, 0x35]);
  const path = info.outputPath('table-style.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  const text = await input.inputValue();
  await reopenDocx(page, input, path, text);
  const reopened = await cell('Qty');
  await expect.poll(() => pixel(page, reopened.x + 30, reopened.y + 3)).toEqual([0x4A, 0x7A, 0x35]);
  await onTab(page, 'tableDesign');
  await expect(page.getByRole('listbox', { name: 'Table Styles' }).getByRole('option', { name: 'Grid Banded · Green' })).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

test('makes and modifies a table style of the document', async ({ page }) => {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.focus();
  await (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '3 columns, 2 rows' }).click();
  await page.keyboard.type('Head');
  await onTab(page, 'tableDesign');
  await page.getByRole('button', { name: 'More Table Styles' }).click();
  await page.getByRole('menuitem', { name: 'New Table Style…' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Table Style' });
  await dialog.getByLabel('Style name').fill('Report');
  await dialog.getByLabel('Apply formatting to').selectOption('firstRow');
  await dialog.getByLabel('No fill').uncheck();
  await dialog.getByLabel('Fill color').fill('#aa2244');
  await dialog.getByLabel('Bold').check();
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  const gallery = page.getByRole('listbox', { name: 'Table Styles' });
  await expect(gallery.getByRole('option', { name: 'Report' })).toHaveAttribute('aria-selected', 'true');
  const at = await input.evaluate(el => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
  await expect.poll(() => pixel(page, at.x + 60, at.y + 3)).toEqual([0xAA, 0x22, 0x44]);
  await page.getByRole('button', { name: 'More Table Styles' }).click();
  await page.getByRole('menuitem', { name: 'Modify Table Style…' }).click();
  const modify = page.getByRole('dialog', { name: 'Modify Table Style' });
  await modify.getByLabel('Apply formatting to').selectOption('firstRow');
  await modify.getByLabel('Fill color').fill('#2244aa');
  await modify.getByRole('button', { name: 'OK' }).click();
  await expect.poll(() => pixel(page, at.x + 60, at.y + 3)).toEqual([0x22, 0x44, 0xAA]);
});
