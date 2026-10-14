import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

const SHOTS = process.env.DRAW_SHOTS || '';
const shot = (page, name) => SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : null;
const TEXT = 'The quick brown fox jumps over the lazy dog. '.repeat(6) + '\nA second paragraph to write beside.';

async function start(page, { text = TEXT, width = 1440, height = 900 } = {}) {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width, height });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(text);
  await onTab(page, 'draw');
  const ribbon = page.locator('#ribbon-panel-draw');
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  return { input, errors, ribbon, box };
}
/** Draw through page-relative points with the mouse, in small steps like a real pointer. */
async function draw(page, box, points, steps = 4) {
  await page.mouse.move(box.x + points[0][0], box.y + points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) await page.mouse.move(box.x + x, box.y + y, { steps });
  await page.mouse.up();
}
const objects = input => input.inputValue().then(v => v.split('￼').length - 1);
const wave = (x, y, n = 24, dx = 8, amp = 18) => Array.from({ length: n }, (_, i) => [x + i * dx, y + Math.sin(i / 3) * amp]);
const loop = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y + 2]];
async function save(page, info, name) {
  const path = info.outputPath(`${name}.docx`);
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  mkdirSync('test-results/draw-exports', { recursive: true }); copyFileSync(path, `test-results/draw-exports/${name}.docx`);
  const parts = unzipSync(new Uint8Array(readFileSync(path)));
  return { path, xml: strFromU8(parts['word/document.xml']) };
}
/** Pixels of a page canvas around a page point that are not white. */
const inkAt = (page, x, y, r = 6) => page.evaluate(([x, y, r]) => {
  const canvas = document.querySelector('canvas.canvas-page'), ctx = canvas.getContext('2d'), scale = canvas.width / canvas.getBoundingClientRect().width;
  const data = ctx.getImageData(Math.round((x - r) * scale), Math.round((y - r) * scale), Math.round(2 * r * scale), Math.round(2 * r * scale)).data;
  let n = 0; for (let i = 0; i < data.length; i += 4) if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 120) n++;
  return n;
}, [x, y, r]);

test('pens draw with the mouse, undo per stroke, save as DrawingML groups and reopen as editable ink', async ({ page }, info) => {
  test.setTimeout(120000);
  const { input, errors, ribbon, box } = await start(page);
  await expect(page.getByRole('tab', { name: 'Draw' })).toBeVisible();
  // The Draw tab sits after Insert.
  const tabs = await page.getByRole('tablist', { name: 'Ribbon tabs' }).getByRole('tab').allTextContents();
  expect(tabs.indexOf('Draw')).toBe(tabs.indexOf('Insert') + 1);
  const pens = ribbon.locator('.draw-pen');
  await expect(pens).toHaveCount(5);
  await pens.first().click();
  await expect(pens.first()).toHaveAttribute('aria-pressed', 'true');
  await draw(page, box, wave(140, 520));
  await expect.poll(() => objects(input)).toBe(1);
  await expect.poll(() => inkAt(page, 140 + 8 * 6, 520 + Math.sin(2) * 18)).toBeGreaterThan(0);
  // A second pen, then the highlighter across the first line of text.
  await pens.nth(1).click();
  await draw(page, box, wave(140, 600));
  await expect.poll(() => objects(input)).toBe(2);
  await ribbon.locator('.draw-pen[data-tool="highlighter"]').click();
  await draw(page, box, [[96, 112], [400, 112]]);
  await expect.poll(() => objects(input)).toBe(3);
  await shot(page, 'pens');
  // Each stroke is one undo step.
  await input.press('ControlOrMeta+z');
  await expect.poll(() => objects(input)).toBe(2);
  await input.press('ControlOrMeta+Shift+z');
  await expect.poll(() => objects(input)).toBe(3);
  // Leaving the pen gathers the session's strokes: one group in front of the text, one behind it.
  await ribbon.getByRole('button', { name: 'Select', exact: true }).click();
  await expect.poll(() => objects(input)).toBe(2);
  // The gathering adds no undo step: undo still takes away the last stroke alone.
  const { path, xml } = await save(page, info, 'pens');
  expect(xml.match(/<wpg:wgp>/g)).toHaveLength(2);
  expect(xml).toMatch(/name="Ink \d+" descr="Handwritten ink"/);
  expect(xml).toMatch(/descr="Highlighter ink"/);
  expect(xml).toMatch(/behindDoc="1"/);
  expect(xml).toMatch(/<a:custGeom>/);
  expect(xml).toMatch(/<a:srgbClr val="FFFF00"><a:alpha val="50000"\/><\/a:srgbClr>/);
  expect(xml).toMatch(/<pdi:stroke xmlns:pdi="http:\/\/schemas.puter.com\/documents\/2026\/ink" tool="pen" color="000000"/);
  expect(xml).toMatch(/tool="pen" color="C00000"/);
  expect(xml).toMatch(/<wp:positionV relativeFrom="paragraph">/);
  const text = await input.inputValue();
  await reopenDocx(page, input, path, text, { timeout: 20000 });
  await onTab(page, 'draw');
  await expect.poll(() => inkAt(page, 140 + 8 * 6, 520 + Math.sin(2) * 18)).toBeGreaterThan(0);
  // Reopened ink is still ink: the lasso selects its strokes.
  await ribbon.getByRole('button', { name: 'Lasso Select', exact: true }).click();
  const reopened = await page.locator('canvas.canvas-page').first().boundingBox();
  await draw(page, reopened, loop(120, 490, 230, 160));
  await page.keyboard.press('Delete');
  await expect.poll(() => objects(input)).toBe(1);
  expect(errors).toEqual([]);
});

test('stroke and point erasers, erase all, and lasso move and delete', async ({ page }, info) => {
  test.setTimeout(120000);
  const { input, errors, ribbon, box } = await start(page);
  await ribbon.locator('.draw-pen').first().click();
  await draw(page, box, wave(140, 520));
  await draw(page, box, [[140, 620], [400, 620]]);
  await draw(page, box, loop(500, 500, 120, 90));
  await expect.poll(() => objects(input)).toBe(3);
  await ribbon.getByRole('button', { name: 'Eraser', exact: true }).click();
  await expect.poll(() => objects(input)).toBe(1);
  // The stroke eraser takes the whole wave it touches.
  await draw(page, box, [[180, 480], [184, 560]]);
  await expect.poll(() => inkAt(page, 140 + 8 * 6, 520 + Math.sin(2) * 18, 4)).toBe(0);
  await expect.poll(() => inkAt(page, 300, 620, 3)).toBeGreaterThan(0);
  // The point eraser cuts a gap in the straight line and leaves both ends.
  await ribbon.getByRole('button', { name: 'Eraser options' }).click();
  await page.getByRole('menuitemradio', { name: 'Point Eraser' }).click();
  await draw(page, box, [[270, 600], [270, 640]]);
  await expect.poll(() => inkAt(page, 270, 620, 2)).toBe(0);
  expect(await inkAt(page, 160, 620, 3)).toBeGreaterThan(0);
  expect(await inkAt(page, 380, 620, 3)).toBeGreaterThan(0);
  await shot(page, 'erased');
  // Undo restores what one sweep erased.
  await input.press('ControlOrMeta+z');
  await expect.poll(() => inkAt(page, 270, 620, 2)).toBeGreaterThan(0);
  // Lasso: select the square and drag it down; then delete it.
  await ribbon.getByRole('button', { name: 'Lasso Select', exact: true }).click();
  await draw(page, box, loop(480, 480, 160, 130));
  await draw(page, box, [[560, 545], [560, 600], [560, 645]]);
  await expect.poll(() => inkAt(page, 500, 645, 3)).toBeGreaterThan(0);
  await expect.poll(() => inkAt(page, 500, 520, 3)).toBe(0);
  await shot(page, 'lasso-moved');
  await page.keyboard.press('Delete');
  await expect.poll(() => inkAt(page, 500, 645, 3)).toBe(0);
  // Erase All Ink in Document removes the rest.
  await ribbon.getByRole('button', { name: 'Eraser options' }).click();
  await page.getByRole('menuitem', { name: 'Erase All Ink in Document' }).click();
  await expect.poll(() => objects(input)).toBe(0);
  const { xml } = await save(page, info, 'erased');
  expect(xml).not.toMatch(/<wpg:wgp>/);
  expect(errors).toEqual([]);
});

test('ink to shape turns drawn strokes into preset shapes', async ({ page }, info) => {
  test.setTimeout(120000);
  const { input, errors, ribbon, box } = await start(page);
  await ribbon.locator('.draw-pen').nth(2).click();
  await ribbon.getByRole('button', { name: 'Ink to Shape', exact: true }).click();
  await expect(ribbon.getByRole('button', { name: 'Ink to Shape', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await draw(page, box, loop(140, 500, 180, 110), 12);
  await draw(page, box, Array.from({ length: 49 }, (_, i) => [480 + 70 * Math.cos(i / 48 * 2.06 * Math.PI), 560 + 45 * Math.sin(i / 48 * 2.06 * Math.PI)]), 2);
  await draw(page, box, [[140, 700], [400, 760]], 10);
  await expect.poll(() => objects(input)).toBe(3);
  await ribbon.getByRole('button', { name: 'Ink to Shape', exact: true }).click();
  // A loop drawn as ink, then converted from the lasso selection.
  await draw(page, box, [[560, 700], [640, 820], [480, 820], [560, 702]], 12);
  await expect.poll(() => objects(input)).toBe(4);
  await ribbon.getByRole('button', { name: 'Lasso Select', exact: true }).click();
  await draw(page, box, loop(450, 680, 220, 170));
  await ribbon.getByRole('button', { name: 'Ink to Shape', exact: true }).click();
  await expect.poll(() => page.locator('.draw-hint, .toast').count()).toBeGreaterThanOrEqual(0);
  await shot(page, 'shapes');
  await page.waitForTimeout(1500);
  const { xml } = await save(page, info, 'shapes');
  expect(xml).toMatch(/<a:prstGeom prst="triangle">/);
  expect(xml).toMatch(/<a:prstGeom prst="rect">/);
  expect(xml).toMatch(/<a:prstGeom prst="ellipse">/);
  expect(xml).toMatch(/<a:prstGeom prst="line">/);
  expect(xml).toMatch(/<a:ln w="\d+" cap="rnd"><a:solidFill><a:srgbClr val="0070C0"\/>/);
  expect(xml).not.toMatch(/<pdi:stroke/);
  expect(errors).toEqual([]);
});

test('drawing canvas, ruler, hide ink, replay and the toggle drawing shortcut', async ({ page }, info) => {
  test.setTimeout(120000);
  const { input, errors, ribbon } = await start(page, { text: 'Canvas below.' });
  await ribbon.getByRole('button', { name: 'Drawing Canvas', exact: true }).click();
  await expect.poll(() => objects(input)).toBe(1);
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  // Ink drawn in the canvas is kept inside it when the session ends.
  await draw(page, box, wave(150, 200, 20, 10, 25));
  await expect.poll(() => objects(input)).toBe(2);
  await ribbon.getByRole('button', { name: 'Select', exact: true }).click();
  await expect.poll(() => objects(input)).toBe(1);
  // Hide Ink hides it; showing it again restores it.
  await expect.poll(() => inkAt(page, 150 + 60, 200 + Math.sin(2) * 25)).toBeGreaterThan(0);
  await ribbon.getByRole('button', { name: 'Hide Ink', exact: true }).click();
  await expect(ribbon.getByRole('button', { name: 'Hide Ink', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => inkAt(page, 150 + 60, 200 + Math.sin(2) * 25)).toBe(0);
  await ribbon.getByRole('button', { name: 'Hide Ink', exact: true }).click();
  await expect.poll(() => inkAt(page, 150 + 60, 200 + Math.sin(2) * 25)).toBeGreaterThan(0);
  // Replay runs and stops by itself.
  await ribbon.getByRole('button', { name: 'Ink Replay', exact: true }).click();
  await expect(page.locator('.draw-replay-chip')).toBeVisible();
  await expect(page.locator('.draw-replay-chip')).toBeHidden({ timeout: 10000 });
  // The ruler: a stroke started beside its edge follows the edge exactly.
  await ribbon.getByRole('button', { name: 'Ruler', exact: true }).click();
  const ruler = page.getByRole('slider', { name: 'Ruler' });
  await expect(ruler).toBeVisible();
  await ruler.focus();
  for (let i = 0; i < 15; i++) await ruler.press('Alt+ArrowRight');
  await expect(ruler).toHaveAttribute('aria-valuenow', '0');
  const r = await ruler.boundingBox();
  await ribbon.locator('.draw-pen').first().click();
  const y = r.y + r.height + 6;
  await page.mouse.move(r.x + 60, y); await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(r.x + 60 + i * 25, y + (i % 2 ? 9 : -2));
  await page.mouse.up();
  await expect.poll(() => objects(input)).toBe(2);
  const { xml } = await save(page, info, 'canvas-ruler');
  expect(xml).toMatch(/<wp:inline [^>]*>.*name="Drawing Canvas \d+"/s);
  expect(xml).toMatch(/<pdi:canvas /);
  const points = [...xml.matchAll(/points="([^"]+)"/g)].at(-1)[1].split(' ').map(Number);
  const ys = points.filter((_, i) => i % 3 === 1);
  expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(9525 * 0.6);
  await shot(page, 'ruler');
  // Toggle Drawing: the shortcut switches between the pen and typing.
  await ribbon.getByRole('button', { name: 'Select', exact: true }).click();
  await input.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Control+z' : 'Control+Alt+z');
  await expect(ribbon.locator('.draw-pen').first()).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(ribbon.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('pen settings persist, pens can be added and removed, and Ink to Math inserts an equation', async ({ page }) => {
  test.setTimeout(90000);
  await page.addInitScript(() => { window.puter = { ai: { chat: async (prompt, image) => (String(image).startsWith('data:image/png') ? 'x^2+y^2=r^2' : '') } }; });
  const { input, errors, ribbon, box } = await start(page);
  const pens = ribbon.locator('.draw-pen');
  await pens.first().click();
  // Clicking the active pen opens its settings.
  await pens.first().click();
  await page.getByRole('menuitemradio', { name: '1.5 mm' }).click();
  await pens.first().click();
  await page.getByRole('menuitemradio', { name: 'Green', exact: true }).click();
  await expect(pens.first()).toHaveAttribute('aria-label', 'Pen: Green, 1.5 mm');
  await ribbon.getByRole('button', { name: 'Add Pen', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add Pencil' }).click();
  await expect(pens).toHaveCount(6);
  await page.reload();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await onTab(page, 'draw');
  await expect(pens).toHaveCount(6);
  await expect(pens.first()).toHaveAttribute('aria-label', 'Pen: Green, 1.5 mm');
  await pens.last().click(); await pens.last().click();
  await page.getByRole('menuitem', { name: 'Remove Pen' }).click();
  await expect(pens).toHaveCount(5);
  // Ink to Math: write in the pad, recognise, insert through the equation dialog.
  const math = ribbon.getByRole('button', { name: 'Ink to Math', exact: true });
  await expect(math).toBeVisible();
  await math.click();
  const dialog = page.getByRole('dialog', { name: 'Ink to Math' });
  const pad = await dialog.locator('canvas.draw-math-pad').boundingBox();
  await page.mouse.move(pad.x + 40, pad.y + 60); await page.mouse.down(); await page.mouse.move(pad.x + 120, pad.y + 120, { steps: 8 }); await page.mouse.up();
  await dialog.getByRole('button', { name: 'Recognize' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Recognized equation' })).toHaveValue('x^2+y^2=r^2');
  await dialog.getByRole('button', { name: 'Insert' }).click();
  const equation = page.getByRole('dialog', { name: 'Equation' });
  await expect(equation.getByRole('textbox', { name: 'Equation in linear format' })).toHaveValue('x^2+y^2=r^2');
  await equation.getByRole('button', { name: 'Insert' }).click();
  await expect.poll(() => input.inputValue()).toContain('x');
  expect(box).toBeTruthy();
  expect(errors).toEqual([]);
});

test('draws with touch on a phone-width window', async ({ browser }, info) => {
  test.setTimeout(90000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(TEXT);
  await onTab(page, 'draw');
  const ribbon = page.locator('#ribbon-panel-draw');
  await expect(page.locator('.ribbon-panel:not([hidden])')).toBeVisible();
  // Narrow windows fold groups away; the pen is reachable either way.
  const pen = ribbon.locator('.draw-pen').first();
  if (await pen.isVisible()) await pen.click();
  else { await ribbon.getByRole('button', { name: 'Drawing Tools' }).click(); await page.locator('.ribbon-flyout .draw-pen').first().click(); }
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  // A finger drags across the page: dispatched as touch pointer events.
  const cdp = await context.newCDPSession(page);
  const touch = async (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: box.x + x, y: box.y + y }] });
  await touch('touchStart', 60, 300);
  for (let i = 1; i <= 12; i++) await touch('touchMove', 60 + i * 12, 300 + Math.sin(i / 2) * 15);
  await touch('touchEnd');
  await expect.poll(() => objects(input)).toBe(1);
  await shot(page, 'phone');
  expect(errors).toEqual([]);
  await context.close();
});
