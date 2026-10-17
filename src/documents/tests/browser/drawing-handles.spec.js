import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';

// Direct manipulation of drawings: eight resize handles, rotation, guides, nudging, multi-selection,
// crop mode and the Layout Options button, on an editor holding two floating pictures and an inline one.
const png = readFileSync('icon-128.png');
const SHOTS = process.env.DRAWING_HANDLE_SHOTS || '';
test.setTimeout(120000);

async function open(page, { width = 1440, layoutOptions = true } = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/playground.html');
  if (!await page.evaluate(() => [...document.styleSheets].some(s => [...(s.cssRules || [])].some(r => r.selectorText?.includes('.canvas-image-rotate'))))) await page.addStyleTag({ content: readFileSync('src/styles/drawing-handles.css', 'utf8') });
  await page.evaluate(async ({ png, layoutOptions }) => {
    const { createDocx } = await import('/src/engine/docx.js'), { paragraph } = await import('/src/engine/model.js'), { CanvasEditor } = await import('/src/engine/canvas-editor.js');
    const pkg = createDocx([paragraph()]);
    const host = document.createElement('div'); host.id = 'handles-host'; host.style.cssText = 'position:fixed;inset:0;z-index:100;overflow:auto;background:#e8eaee';
    document.body.append(host);
    window.errors = [];
    const editor = window.e = new CanvasEditor(host, { ...pkg, onError: e => window.errors.push(e.message) });
    if (layoutOptions) editor.onLayoutOptions = button => { window.layoutOptions = button.getAttribute('aria-label'); };
    editor.execute(() => editor.model.replace('Pictures float over this paragraph. '.repeat(6)));
    const bytes = Uint8Array.from(png);
    const add = async (id, properties) => {
      editor.model.assets[id] = { bytes, mime: 'image/png' };
      editor.images.set(id, await createImageBitmap(new Blob([bytes], { type: 'image/png' })));
      editor.model.select(0); editor.execute(() => editor.model.insertImage(id, properties));
    };
    const floating = (x, order) => ({ horizontal: 'column', vertical: 'paragraph', x, y: 381000, wrap: 'none', behind: false, order });
    await add('a', { width: 1219200, height: 914400, alt: 'First', anchor: floating(0, 1) });
    await add('b', { width: 1219200, height: 914400, alt: 'Second', anchor: floating(2743200, 2) });
    await add('c', { width: 914400, height: 914400, alt: 'Inline' });
    editor.focus();
  }, { png: [...png], layoutOptions });
}
const host = page => page.locator('#handles-host');
const ids = page => page.evaluate(() => Object.fromEntries(window.e.layout.lines.flatMap(l => l.fragments).filter(f => f.image).map(f => [f.image.alt, f.image.id])));
/** Select the drawing with this docPr id. */
const select = (page, id) => page.evaluate(id => {
  const e = window.e, f = e.layout.lines.flatMap(l => l.fragments).find(f => f.image?.id === id);
  e.model.select(f.start, f.end); e.focus(); e.paint(); e.onSelection();
}, id);
const state = (page, id) => page.evaluate(id => {
  const e = window.e, image = e.layout.lines.flatMap(l => l.fragments).find(f => f.image?.id === id).image;
  const f = e.layout.floatingObjects.find(f => f.image === image);
  return { width: image.width, height: image.height, rotation: image.rotation || 0, crop: image.crop, anchor: image.anchor, frame: f ? { x: f.x, y: f.y, width: f.width, height: f.height } : null, history: e.session.history.length };
}, id);
async function drag(page, locator, dx, dy, { steps = 6, modifier } = {}) {
  const b = await locator.boundingBox(); expect(b).not.toBeNull();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.down(); await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps }); await page.mouse.up();
  if (modifier) await page.keyboard.up(modifier);
}
const shot = (page, name) => SHOTS && existsSync(SHOTS) ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null;

test('edge handles resize one side; the rotation handle snaps to 15° with Shift', async ({ page }) => {
  await open(page);
  await select(page, 2);
  for (const handle of ['n', 'e', 's', 'w', 'nw', 'ne', 'sw', 'se']) await expect(host(page).getByRole('button', { name: `Resize image ${handle}`, exact: true })).toBeVisible();
  await expect(host(page).getByRole('button', { name: 'Layout Options' })).toBeVisible();
  await shot(page, 'handles-1440');
  const before = await state(page, 2);
  await drag(page, host(page).getByRole('button', { name: 'Resize image e', exact: true }), 30, 12);
  const wider = await state(page, 2);
  expect(wider.width - before.width).toBeCloseTo(30 * 9525, -3);
  expect(wider.height).toBe(before.height);
  expect(wider.frame.x).toBeCloseTo(before.frame.x, 1);
  await drag(page, host(page).getByRole('button', { name: 'Resize image n', exact: true }), 5, -20);
  const taller = await state(page, 2);
  expect(taller.width).toBe(wider.width);
  expect(taller.height - wider.height).toBeCloseTo(20 * 9525, -3);
  expect(taller.frame.y).toBeCloseTo(wider.frame.y - 20, 0);
  // Rotation: a quarter-ish turn snapped to a multiple of 15 degrees, one undo step.
  const rotate = host(page).getByRole('button', { name: 'Rotate image', exact: true });
  await expect(rotate).toBeVisible();
  const frame = await host(page).locator('.canvas-image-frame').first().boundingBox(), handle = await rotate.boundingBox();
  const cx = frame.x + frame.width / 2, cy = frame.y + frame.height / 2;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.keyboard.down('Shift'); await page.mouse.down();
  await page.mouse.move(cx + 80, cy - 70, { steps: 6 }); await page.mouse.move(cx + 120, cy - 30, { steps: 4 });
  await page.mouse.up(); await page.keyboard.up('Shift');
  const turned = await state(page, 2);
  expect(turned.rotation).toBeGreaterThan(0);
  expect(turned.rotation % (15 * 60000)).toBe(0);
  expect(turned.history).toBe(taller.history + 1);
  expect(await page.evaluate(() => window.errors)).toEqual([]);
});

test('arrow keys on a resize handle move it as dragging would', async ({ page }) => {
  await open(page);
  await select(page, 2);
  const press = async (handle, key, times = 4) => { const button = host(page).getByRole('button', { name: `Resize image ${handle}`, exact: true }); await button.focus(); for (let i = 0; i < times; i++) await button.press(key); };
  const before = await state(page, 2);
  // Up on the top handle grows the picture upward; its bottom stays put.
  await press('n', 'ArrowUp');
  const taller = await state(page, 2);
  expect(taller.width).toBe(before.width);
  expect(taller.height - before.height).toBeCloseTo(4 * 9525, -2);
  expect(taller.frame.y + taller.frame.height).toBeCloseTo(before.frame.y + before.frame.height, 1);
  // Left on the left handle grows it leftward; its right edge stays put.
  await press('w', 'ArrowLeft');
  const wider = await state(page, 2);
  expect(wider.width - taller.width).toBeCloseTo(4 * 9525, -2);
  expect(wider.frame.x + wider.frame.width).toBeCloseTo(taller.frame.x + taller.frame.width, 1);
  // Inward shrinks; an arrow along an edge handle's side changes nothing.
  await press('e', 'ArrowLeft', 2);
  expect((await state(page, 2)).width - wider.width).toBeCloseTo(-2 * 9525, -2);
  const steady = await state(page, 2);
  await press('e', 'ArrowUp', 2);
  expect(await state(page, 2)).toEqual(steady);
  // A corner keeps the proportions, growing outward.
  await press('nw', 'ArrowUp', 1);
  const corner = await state(page, 2);
  expect(corner.width).toBeGreaterThan(steady.width);
  expect(corner.width / corner.height).toBeCloseTo(steady.width / steady.height, 3);
  expect(await page.evaluate(() => window.errors)).toEqual([]);
});

test('dragging snaps to the page center with a guide; arrows nudge from the document', async ({ page }) => {
  await open(page);
  await select(page, 1);
  const before = await state(page, 1);
  const geometry = await page.evaluate(() => ({ width: window.e.layout.pages[0].width, zoom: window.e.zoom }));
  const move = host(page).getByRole('button', { name: 'Move selected image', exact: true });
  const b = await move.boundingBox();
  // Aim the drawing's center near (not at) the page center; the guide pulls it the rest of the way.
  const target = geometry.width / 2 - (before.frame.x + before.frame.width / 2) + 3;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + target * geometry.zoom / 2, b.y + b.height / 2 + 40, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2 + target * geometry.zoom, b.y + b.height / 2 + 40, { steps: 4 });
  await expect(host(page).locator('.canvas-drawing-guide[data-kind="center"]:not([hidden])')).toHaveCount(1);
  await shot(page, 'guides');
  await page.mouse.up();
  await expect(host(page).locator('.canvas-drawing-guide:not([hidden])')).toHaveCount(0);
  const snapped = await state(page, 1);
  expect(snapped.frame.x + snapped.frame.width / 2).toBeCloseTo(geometry.width / 2, 0);
  // Alt moves freely.
  await page.keyboard.down('Alt');
  await drag(page, host(page).getByRole('button', { name: 'Move selected image', exact: true }), 12, 0, { steps: 3 });
  await page.keyboard.up('Alt');
  const free = await state(page, 1);
  expect(free.frame.x).toBeCloseTo(snapped.frame.x + 12 / geometry.zoom, 0);
  // Arrow keys in the document move a selected floating drawing.
  const input = host(page).getByRole('textbox', { name: 'Document text' });
  await input.focus();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowDown');
  const nudged = await state(page, 1);
  expect(nudged.frame.x).toBeCloseTo(free.frame.x + 1, 1);
  expect(nudged.frame.y).toBeCloseTo(free.frame.y + 10, 1);
  expect(await page.evaluate(() => window.e.model.selectedImage?.id)).toBe(1);
  expect(await page.evaluate(() => window.errors)).toEqual([]);
});

test('Shift+click selects several drawings that move together in one undo step', async ({ page }) => {
  await open(page);
  await select(page, 1);
  const first = await state(page, 1), second = await state(page, 2);
  const canvas = await host(page).locator('canvas.canvas-page').first().boundingBox(), zoom = await page.evaluate(() => window.e.zoom);
  await page.keyboard.down('Shift');
  await page.mouse.click(canvas.x + (second.frame.x + second.frame.width / 2) * zoom, canvas.y + (second.frame.y + second.frame.height / 2) * zoom);
  await page.keyboard.up('Shift');
  expect(await page.evaluate(() => window.e.drawingSelection.map(i => i.id))).toEqual([1, 2]);
  await expect(host(page).locator('.canvas-image-frame.is-secondary:not([hidden])')).toHaveCount(1);
  await shot(page, 'multi-select');
  await page.keyboard.down('Alt');
  await drag(page, host(page).getByRole('button', { name: 'Move selected image', exact: true }), 30, 20);
  await page.keyboard.up('Alt');
  const a = await state(page, 1), b = await state(page, 2);
  expect(a.frame.x - first.frame.x).toBeCloseTo(30 / zoom, 0);
  expect(b.frame.x - second.frame.x).toBeCloseTo(30 / zoom, 0);
  expect(b.frame.y - second.frame.y).toBeCloseTo(20 / zoom, 0);
  expect(a.history).toBe(first.history + 1);
  expect(await page.evaluate(() => window.e.drawingSelection.length)).toBe(2);
  // Undo moves both back; Escape leaves only the main drawing selected.
  await page.evaluate(() => window.e.undo());
  expect((await state(page, 2)).frame.x).toBeCloseTo(second.frame.x, 1);
  await page.evaluate(() => window.e.setDrawingSelection([...window.e.layout.floatingObjects].filter(f => [1, 2].includes(f.image.id)).map(f => f.image)));
  expect(await page.evaluate(() => window.e.drawingSelection.length)).toBe(2);
  await host(page).getByRole('textbox', { name: 'Document text' }).press('Escape');
  expect(await page.evaluate(() => window.e.drawingSelection.length)).toBe(1);
});

test('crop mode trims from a handle, pans, and Escape cancels', async ({ page }) => {
  await open(page);
  await select(page, 1);
  const before = await state(page, 1);
  expect(await page.evaluate(() => window.e.startCrop())).toBe(true);
  expect(await page.evaluate(() => window.e.cropActive)).toBe(true);
  await expect(host(page).locator('.canvas-crop-handle')).toHaveCount(8);
  await expect(host(page).locator('.canvas-image-frame').first()).toBeHidden();
  const zoom = await page.evaluate(() => window.e.zoom);
  await drag(page, host(page).getByRole('button', { name: 'Crop e', exact: true }), -40, 0);
  await shot(page, 'crop-mode');
  // Escape cancels: nothing changes.
  await host(page).getByRole('textbox', { name: 'Document text' }).press('Escape');
  expect(await page.evaluate(() => window.e.cropActive)).toBe(false);
  expect((await state(page, 1)).width).toBe(before.width);
  // Trim the right side and the top, then confirm with Enter.
  await page.evaluate(() => window.e.startCrop());
  await drag(page, host(page).getByRole('button', { name: 'Crop e', exact: true }), -40, 0);
  await drag(page, host(page).getByRole('button', { name: 'Crop n', exact: true }), 0, 20);
  await host(page).getByRole('textbox', { name: 'Document text' }).press('Enter');
  const cropped = await state(page, 1);
  expect(cropped.width).toBeCloseTo(before.width - 40 / zoom * 9525, -3);
  expect(cropped.height).toBeCloseTo(before.height - 20 / zoom * 9525, -3);
  expect(cropped.crop.right).toBeGreaterThan(0); expect(cropped.crop.top).toBeGreaterThan(0);
  expect(cropped.frame.y).toBeCloseTo(before.frame.y + 20 / zoom, 0);
  expect(cropped.history).toBe(before.history + 1);
  // Dragging inside the picture pans it under the crop frame.
  await page.evaluate(() => window.e.startCrop());
  const kept = await host(page).locator('.canvas-crop-frame').boundingBox();
  await page.mouse.move(kept.x + kept.width / 2, kept.y + kept.height / 2); await page.mouse.down();
  await page.mouse.move(kept.x + kept.width / 2 - 12, kept.y + kept.height / 2, { steps: 4 }); await page.mouse.up();
  await host(page).getByRole('textbox', { name: 'Document text' }).press('Enter');
  const panned = await state(page, 1);
  expect(panned.width).toBe(cropped.width);
  expect(panned.crop.left).toBeGreaterThan(0);
  expect(panned.frame.x).toBeCloseTo(cropped.frame.x, 1);
  // Aspect presets and fill.
  expect(await page.evaluate(() => window.e.cropAspect(1))).toBe(true);
  await host(page).getByRole('textbox', { name: 'Document text' }).press('Enter');
  const square = await state(page, 1);
  expect(Math.abs(square.width - square.height)).toBeLessThan(9525 * 1.5);
  expect(await page.evaluate(() => window.errors)).toEqual([]);
});

test('handles at phone width and without a layout-options hook', async ({ page }) => {
  await open(page, { width: 390, layoutOptions: false });
  await page.evaluate(() => window.e.setZoom(0.45));
  await select(page, 2);
  await expect(host(page).getByRole('button', { name: 'Resize image se', exact: true })).toBeVisible();
  await expect(host(page).getByRole('button', { name: 'Layout Options' })).toBeHidden();
  await shot(page, 'handles-390');
});
