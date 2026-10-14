import { test, expect } from '@playwright/test';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

const pixel = (page, x, y) => page.locator('canvas.canvas-page').first().evaluate((c, [x, y]) => {
  const scale = c.width / c.getBoundingClientRect().width;
  return [...c.getContext('2d').getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data.slice(0, 3)];
}, [x, y]);

test('inserts a shape, formats and resizes it, and saves editable DrawingML', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Paragraph holding a shape.');
  await (await onTab(page, 'insert')).locator('.ribbon-card').getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rectangle', exact: true }).click();
  // A shape chosen with the pointer is placed by clicking (default size) or dragging on the page.
  await page.locator('canvas.canvas-page').first().click({ position: { x: 140, y: 150 } });
  await expect(page.getByRole('tab', { name: 'Shape Format' })).toHaveAttribute('aria-selected', 'true');
  const height = page.getByRole('spinbutton', { name: 'Shape height (in)' }), width = page.getByRole('spinbutton', { name: 'Shape width (in)' });
  await expect(height).toHaveValue('1'); await expect(width).toHaveValue('1.5');
  // The shape sits at the column's left edge, in front of the first line, filled with the default blue.
  const frame = await page.locator('.canvas-image-frame').boundingBox(), surface = await page.locator('canvas.canvas-page').first().boundingBox();
  const inside = { x: frame.x - surface.x + frame.width / 2, y: frame.y - surface.y + frame.height * 0.8 };
  await expect.poll(() => pixel(page, inside.x, inside.y)).not.toEqual([255, 255, 255]);
  await page.getByRole('button', { name: 'Shape Fill', exact: true }).click();
  await page.getByRole('menuitem', { name: 'No Fill' }).click();
  await expect.poll(() => pixel(page, inside.x, inside.y)).toEqual([255, 255, 255]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => pixel(page, inside.x, inside.y)).not.toEqual([255, 255, 255]);
  await page.getByRole('button', { name: 'Shape Outline', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Weight' }).click();
  await page.getByRole('menuitemradio', { name: '3 pt', exact: true }).click();
  await width.fill('2'); await width.press('Enter');
  await expect(width).toHaveValue('2');
  // Dragging a corner handle resizes the shape too.
  const handle = page.getByRole('button', { name: 'Resize image se' });
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 40, { steps: 5 }); await page.mouse.up();
  await expect.poll(async () => Number(await width.inputValue())).toBeGreaterThan(2.2);
  const resized = Number(await width.inputValue());
  const path = info.outputPath('shapes.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  await reopenDocx(page, input, path, await input.inputValue());
  await input.evaluate(el => { const at = el.value.indexOf('\ufffc'); el.setSelectionRange(at, at + 1); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await expect(page.getByRole('tab', { name: 'Shape Format' })).toBeVisible();
  await page.getByRole('tab', { name: 'Shape Format' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Shape width (in)' })).toHaveValue(String(resized));
  await page.getByRole('button', { name: 'Shape Outline', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Weight' }).click();
  await expect(page.getByRole('menuitemradio', { name: '3 pt', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(errors).toEqual([]);
});

test('inserts a text box, edits its text, recolors it and saves its paragraphs', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1440, height: 900 }); // The whole Insert tab shows at desktop width.
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Body text.');
  await (await onTab(page, 'insert')).locator('.ribbon-card').getByRole('button', { name: 'Text Box', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Simple Text Box/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit drawing text' });
  await expect(dialog).toBeVisible();
  const frameText = dialog.getByRole('textbox').first();
  await frameText.press('ControlOrMeta+a');
  await page.keyboard.type('Boxed words');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await input.evaluate(el => { const at = el.value.indexOf('￼'); el.setSelectionRange(at, at + 1); el.dispatchEvent(new Event('select', { bubbles: true })); });
  await page.getByRole('tab', { name: 'Shape Format' }).click();
  await page.getByRole('button', { name: 'Shape Fill', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Light Green', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit Text', exact: true })).toBeEnabled();
  const path = info.outputPath('text-box.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  const { unzipSync, strFromU8 } = await import('fflate');
  const xml = strFromU8(unzipSync(new Uint8Array((await import('node:fs')).readFileSync(path)))['word/document.xml']);
  expect(xml).toContain('<wps:txbx>');
  expect(xml).toContain('Boxed words');
  expect(xml).not.toContain('Type your text here');
  await reopenDocx(page, input, path, await input.inputValue());
  expect(errors).toEqual([]);
});
