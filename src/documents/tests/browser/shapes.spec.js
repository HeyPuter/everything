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

test('the drawing text editor lays its lines out as wide as the text box', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Body text.');
  // A 2-inch sidebar: its text frame is 2 inches less 0.1-inch insets on each side.
  await (await onTab(page, 'insert')).locator('.ribbon-card').getByRole('button', { name: 'Text Box', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Sidebar/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit drawing text' });
  await expect(dialog).toBeVisible();
  const draft = dialog.locator('canvas.canvas-page').first();
  const margins = 2 * 360 / 15; // The draft page's own margins, in CSS pixels.
  await expect.poll(async () => Math.round((await draft.boundingBox()).width - margins)).toBe(Math.round(1.8 * 96));
  // The sample text wraps inside the frame, so the whole draft page shows in the dialog without scrolling sideways.
  const scroller = dialog.locator('.canvas-host');
  expect(await scroller.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('a new text box or WordArt opens with its sample text selected, so typing replaces it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Body text.');
  const dialog = page.getByRole('dialog', { name: 'Edit drawing text' });
  const draftText = () => dialog.getByRole('textbox', { name: 'Drawing text' }).inputValue();
  const drawingText = () => page.evaluate(() => {
    const e = window.__docs.current.view.engine, image = e.model.selectedImage, scene = e.model.assets[image.assetId].scene;
    const find = node => node.text ? node : node.children?.map(find).find(Boolean);
    return find(scene).text.paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\n');
  });
  const insertBox = async name => {
    await input.press('ControlOrMeta+End');
    await (await onTab(page, 'insert')).locator('.ribbon-card').getByRole('button', { name: 'Text Box', exact: true }).click();
    await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click();
    await expect(dialog).toBeVisible();
  };
  // A plain box: its sample text goes as the first key is typed.
  await insertBox('Simple Text Box');
  await page.keyboard.type('Boxed words');
  expect(await draftText()).toBe('Boxed words');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await drawingText()).toBe('Boxed words');
  // A sidebar keeps its title: only the sample body text is selected.
  await insertBox('Sidebar');
  await page.keyboard.type('Key points');
  expect(await draftText()).toBe('Sidebar Title\nKey points');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toBeHidden();
  // WordArt's sample text is replaced the same way.
  await input.press('ControlOrMeta+End');
  await (await onTab(page, 'insert')).locator('.ribbon-card').getByRole('button', { name: 'WordArt', exact: true }).click();
  await page.locator('.menu').getByRole('menuitem').first().click();
  await expect(dialog).toBeVisible();
  await page.keyboard.type('Headline');
  expect(await draftText()).toBe('Headline');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await drawingText()).toBe('Headline');
});

test('double-clicking a text box, chart or diagram opens it for editing; a picture is only selected', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Body text.');
  // The middle of the selected drawing on screen.
  const middle = () => page.evaluate(() => {
    const e = window.__docs.current.view.engine, image = e.model.selectedImage;
    const floating = e.layout.floatingObjects.find(f => f.image === image);
    if (floating) { const c = e.canvases[floating.page].getBoundingClientRect(); return { x: c.left + (floating.x + floating.width / 2) * e.zoom, y: c.top + (floating.y + floating.height / 2) * e.zoom }; }
    const line = e.layout.lines.find(l => l.fragments.some(f => f.image === image)), f = line.fragments.find(f => f.image === image), c = e.canvases[line.page].getBoundingClientRect();
    return { x: c.left + (f.x + 20) * e.zoom, y: c.top + (line.baseline - 20) * e.zoom };
  });
  const reopen = async name => {
    const at = await middle();
    await input.press('ControlOrMeta+End');
    await page.mouse.dblclick(at.x, at.y);
    const dialog = page.getByRole('dialog', { name, exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
  };
  await (await onTab(page, 'insert')).locator('.ribbon-card').getByRole('button', { name: 'Text Box', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Simple Text Box/ }).click();
  await page.getByRole('dialog', { name: 'Edit drawing text' }).getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await reopen('Edit drawing text');
  await input.press('ControlOrMeta+End'); await input.press('Enter');
  await (await onTab(page, 'insert')).locator('.ribbon-card').getByRole('button', { name: 'Chart', exact: true }).click();
  await page.getByRole('dialog', { name: 'Insert Chart' }).getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await reopen('Edit Chart');
  await input.press('ControlOrMeta+End'); await input.press('Enter');
  await (await onTab(page, 'insert')).locator('.ribbon-card').getByRole('button', { name: 'Diagram', exact: true }).click();
  await page.locator('.menu [role=menuitem]').first().click();
  await page.getByRole('dialog', { name: 'Diagram' }).getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await reopen('Edit Diagram');
  // A picture has nothing to open: a double-click selects it.
  await input.press('ControlOrMeta+End'); await input.press('Enter');
  await page.evaluate(async bytes => {
    const e = window.__docs.current.view.engine;
    await e.insertImageFile(new File([new Uint8Array(bytes)], 'icon.png', { type: 'image/png' }));
  }, [...(await import('node:fs')).readFileSync('public/icons/icon-64.png')]);
  const at = await middle();
  await input.press('ControlOrMeta+End');
  await page.mouse.dblclick(at.x, at.y);
  await expect.poll(() => page.evaluate(() => !!window.__docs.current.view.engine.model.selectedImage)).toBe(true);
  await page.waitForTimeout(300);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
