import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

// Group keeps the objects stacked as they were: one in front stays in front inside the group, whichever
// is anchored first in the text; Ungroup puts the objects back in the group's place among the others.
const input = page => page.getByRole('textbox', { name: 'Document text' });
const drawings = page => page.evaluate(() => {
  const m = window.__docs.current.view.engine.model;
  let at = 0; const out = [];
  for (const p of m.paragraphs) { for (const r of p.runs) { if (r.image?.anchor) out.push({ at, order: r.image.anchor.order, kind: (/prst="(\w+)"/.exec(r.image.shell || '') || [])[1], shapes: [...(r.image.shell || '').matchAll(/<a:prstGeom prst="(\w+)"/g)].map(x => x[1]) }); at += r.text.length; } at++; }
  return out;
});
async function drawShape(page, name, from, to) {
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  await page.mouse.move(box.x + from[0], box.y + from[1]); await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 4 }); await page.mouse.up();
  await expect(page.locator('#ribbon-tab-shapeFormat')).toBeVisible();
}

test('grouping and ungrouping keep the objects stacked as they were', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  for (let i = 0; i < 16; i++) { await page.keyboard.type(`Paragraph ${i + 1} of the text the shapes sit on.`); await page.keyboard.press('Enter'); }
  await drawShape(page, 'Rectangle', [300, 420], [460, 520]);
  await drawShape(page, 'Oval', [340, 300], [500, 470]);
  await drawShape(page, 'Isosceles Triangle', [600, 300], [700, 400]);
  // Bring the one of rectangle and oval anchored first in the text forward, over the other (still under the triangle).
  let now = await drawings(page);
  const [first, second] = ['rect', 'ellipse'].map(kind => now.find(d => d.kind === kind)).sort((a, b) => a.at - b.at);
  await page.evaluate(at => { const e = window.__docs.current.view.engine; e.model.select(at, at + 1); e.syncInput(); e.paint(); e.onSelection(); }, first.at);
  await onTab(page, 'shapeFormat');
  await page.locator('#ribbon-panel-shapeFormat').getByRole('button', { name: 'Bring Forward', exact: true }).click();
  now = await drawings(page);
  const order = kind => now.find(d => d.kind === kind).order;
  expect(order(first.kind)).toBeGreaterThan(order(second.kind));
  expect(order('triangle')).toBeGreaterThan(order(first.kind));

  await onTab(page, 'shapeFormat');
  await page.locator('#ribbon-panel-shapeFormat').getByRole('button', { name: 'Selection Pane', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Selection pane' });
  await expect(pane.getByRole('listitem')).toHaveCount(3);
  await pane.getByRole('listitem').filter({ hasText: /^Oval/ }).locator('.pic-selection-name').click();
  await pane.getByRole('listitem').filter({ hasText: /^Rectangle/ }).locator('.pic-selection-name').click({ modifiers: ['Shift'] });
  await page.locator('#ribbon-panel-shapeFormat').getByRole('button', { name: 'Group', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Group', exact: true }).click();
  await expect(pane.getByRole('listitem')).toHaveCount(2);
  now = await drawings(page);
  const group = now.find(d => d.shapes.length === 2);
  // Children paint in document order: the one behind first.
  expect(group.shapes).toEqual([second.kind, first.kind]);
  expect(group.order).toBeLessThan(now.find(d => d.kind === 'triangle').order);

  await page.locator('#ribbon-panel-shapeFormat').getByRole('button', { name: 'Group', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Ungroup' }).click();
  await expect(pane.getByRole('listitem')).toHaveCount(3);
  now = await drawings(page);
  const orders = Object.fromEntries(now.map(d => [d.kind, d.order]));
  // Back as they were, both behind the triangle; no two share a level.
  expect(orders[second.kind]).toBeLessThan(orders[first.kind]);
  expect(orders[first.kind]).toBeLessThan(orders.triangle);
  expect(errors).toEqual([]);
});

test('Hide All and Show All in the Selection pane are one Undo each', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  for (let i = 0; i < 8; i++) { await page.keyboard.type(`Paragraph ${i + 1} of the text the shapes sit on.`); await page.keyboard.press('Enter'); }
  await drawShape(page, 'Rectangle', [300, 200], [400, 260]);
  await drawShape(page, 'Oval', [450, 200], [550, 260]);
  await drawShape(page, 'Isosceles Triangle', [600, 200], [700, 260]);
  const hidden = () => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs).filter(r => r.image).map(r => !!r.image.hidden));
  await onTab(page, 'shapeFormat');
  await page.locator('#ribbon-panel-shapeFormat').getByRole('button', { name: 'Selection Pane', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Selection pane' });
  // Each object's visibility is a toggle with one name, pressed while the object shows.
  const eye = pane.getByRole('button', { name: 'Show Oval 2', exact: true });
  await expect(eye).toHaveAttribute('aria-pressed', 'true');
  await pane.getByRole('button', { name: 'Hide All', exact: true }).click();
  await expect.poll(hidden).toEqual([true, true, true]);
  await expect(eye).toHaveAttribute('aria-pressed', 'false');
  await expect(pane.getByRole('button', { name: /^Hide (Oval|Rectangle|Isosceles)/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await expect.poll(hidden).toEqual([false, false, false]);
  await page.getByRole('button', { name: 'Redo', exact: true }).first().click();
  await expect.poll(hidden).toEqual([true, true, true]);
  await pane.getByRole('button', { name: 'Show All', exact: true }).click();
  await expect.poll(hidden).toEqual([false, false, false]);
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
  await expect.poll(hidden).toEqual([true, true, true]);
  expect(errors).toEqual([]);
});

test('the Selection pane keeps keyboard focus while objects are selected and restacked from it', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  for (let i = 0; i < 8; i++) { await page.keyboard.type(`Paragraph ${i + 1} of the text the shapes sit on.`); await page.keyboard.press('Enter'); }
  await drawShape(page, 'Rectangle', [300, 200], [400, 260]);
  await drawShape(page, 'Oval', [450, 200], [550, 260]);
  await drawShape(page, 'Isosceles Triangle', [600, 200], [700, 260]);
  await onTab(page, 'shapeFormat');
  await page.locator('#ribbon-panel-shapeFormat').getByRole('button', { name: 'Selection Pane', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Selection pane' });
  const rows = pane.locator('.pic-selection-name');
  await expect(rows).toHaveCount(3);
  const names = () => rows.allTextContents();
  const focused = () => page.evaluate(() => document.activeElement.closest('.pic-selection-name')?.textContent ?? document.activeElement.className);
  const selected = () => page.evaluate(() => window.__docs.current.view.engine.model.selectedImage?.name ?? null);
  expect(await names()).toEqual(['Isosceles Triangle 3', 'Oval 2', 'Rectangle 1']);
  // Space (and Enter) select the object on the page and leave focus on its row, as clicking a list item would.
  await rows.first().focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect.poll(selected).toBe('Oval 2');
  expect(await focused()).toBe('Oval 2');
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe('Rectangle 1');
  await page.keyboard.press('Enter');
  await expect.poll(selected).toBe('Rectangle 1');
  expect(await focused()).toBe('Rectangle 1');
  // Alt+Up twice brings the rectangle to the front, one level at a time.
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(names).toEqual(['Isosceles Triangle 3', 'Rectangle 1', 'Oval 2']);
  expect(await focused()).toBe('Rectangle 1');
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(names).toEqual(['Rectangle 1', 'Isosceles Triangle 3', 'Oval 2']);
  expect(await focused()).toBe('Rectangle 1');
  expect(errors).toEqual([]);
});

test('with Track Changes on, Group and Ungroup rearrange the objects without recording them as deleted and inserted', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  for (let i = 0; i < 10; i++) { await page.keyboard.type(`Paragraph ${i + 1} of the text the shapes sit on.`); await page.keyboard.press('Enter'); }
  await drawShape(page, 'Rectangle', [300, 220], [460, 320]);
  await drawShape(page, 'Oval', [340, 300], [500, 400]);
  await onTab(page, 'review');
  await page.locator('#ribbon-panel-review').getByRole('button', { name: 'Track Changes', exact: true }).click();
  await expect(page.locator('#ribbon-panel-review').getByRole('button', { name: 'Track Changes', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const runs = () => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs).filter(r => r.image).map(r => ({ shapes: [...(r.image.shell || '').matchAll(/<a:prstGeom prst="(\w+)"/g)].length, revision: r.revision?.type || null })));
  await onTab(page, 'shapeFormat');
  await page.locator('#ribbon-panel-shapeFormat').getByRole('button', { name: 'Selection Pane', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Selection pane' });
  await pane.getByRole('listitem').filter({ hasText: /^Oval/ }).locator('.pic-selection-name').click();
  await pane.getByRole('listitem').filter({ hasText: /^Rectangle/ }).locator('.pic-selection-name').click({ modifiers: ['Shift'] });
  await page.locator('#ribbon-panel-shapeFormat').getByRole('button', { name: 'Group', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Group', exact: true }).click();
  await expect.poll(runs).toEqual([{ shapes: 2, revision: null }]);
  await page.locator('#ribbon-panel-shapeFormat').getByRole('button', { name: 'Group', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Ungroup' }).click();
  await expect.poll(runs).toEqual([{ shapes: 1, revision: null }, { shapes: 1, revision: null }]);
  // Undo takes the ungrouping back in one step, still untracked.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(runs).toEqual([{ shapes: 2, revision: null }]);
  const path = info.outputPath('tracked-group.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  const xml = strFromU8(unzipSync(new Uint8Array(readFileSync(path)))['word/document.xml']);
  expect(xml).not.toMatch(/<w:(ins|del) /);
  expect(xml.match(/<wp:anchor /g)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('Bring to Front, Send to Back and Bring Forward move every selected object, keeping their order among themselves', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  for (let i = 0; i < 16; i++) { await page.keyboard.type(`Paragraph ${i + 1} of the text the shapes sit on.`); await page.keyboard.press('Enter'); }
  await drawShape(page, 'Rectangle', [300, 420], [460, 520]);
  await drawShape(page, 'Oval', [340, 300], [500, 470]);
  await drawShape(page, 'Isosceles Triangle', [600, 300], [700, 400]);
  await drawShape(page, 'Diamond', [200, 300], [300, 400]);
  // Back to front: rectangle, oval, triangle, diamond.
  const stack = async () => (await drawings(page)).sort((a, b) => a.order - b.order).map(d => d.kind);
  await expect.poll(stack).toEqual(['rect', 'ellipse', 'triangle', 'diamond']);
  await onTab(page, 'shapeFormat');
  await page.locator('#ribbon-panel-shapeFormat').getByRole('button', { name: 'Selection Pane', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Selection pane' });
  await pane.getByRole('listitem').filter({ hasText: /^Rectangle/ }).locator('.pic-selection-name').click();
  await pane.getByRole('listitem').filter({ hasText: /^Oval/ }).locator('.pic-selection-name').click({ modifiers: ['Shift'] });
  const ribbon = page.locator('#ribbon-panel-shapeFormat');
  await ribbon.getByRole('button', { name: 'Bring Forward', exact: true }).click();
  await expect.poll(stack).toEqual(['triangle', 'rect', 'ellipse', 'diamond']);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(stack).toEqual(['rect', 'ellipse', 'triangle', 'diamond']);
  await ribbon.getByRole('button', { name: 'Bring Forward options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Bring to Front' }).click();
  await expect.poll(stack).toEqual(['triangle', 'diamond', 'rect', 'ellipse']);
  await ribbon.getByRole('button', { name: 'Send Backward options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Send to Back' }).click();
  await expect.poll(stack).toEqual(['rect', 'ellipse', 'triangle', 'diamond']);
  expect(errors).toEqual([]);
});

test('Delete with several objects selected removes them all in one undo step', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  for (let i = 0; i < 16; i++) { await page.keyboard.type(`Paragraph ${i + 1} of the text the shapes sit on.`); await page.keyboard.press('Enter'); }
  await drawShape(page, 'Rectangle', [300, 420], [420, 500]);
  await drawShape(page, 'Oval', [500, 300], [620, 380]);
  await drawShape(page, 'Isosceles Triangle', [600, 450], [700, 550]);
  const before = await input(page).inputValue();
  await onTab(page, 'shapeFormat');
  await page.locator('#ribbon-panel-shapeFormat').getByRole('button', { name: 'Selection Pane', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Selection pane' });
  await pane.getByRole('listitem').filter({ hasText: /^Oval/ }).locator('.pic-selection-name').click();
  await pane.getByRole('listitem').filter({ hasText: /^Isosceles/ }).locator('.pic-selection-name').click({ modifiers: ['Shift'] });
  await expect.poll(() => page.evaluate(() => window.__docs.current.view.engine.drawingSelection.length)).toBe(2);
  // In the document, Delete removes both.
  await input(page).focus();
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await drawings(page)).map(d => d.kind)).toEqual(['rect']);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await drawings(page)).length).toBe(3);
  expect(await input(page).inputValue()).toBe(before);
  expect(errors).toEqual([]);
});
