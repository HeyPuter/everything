import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

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
  await pane.getByRole('button', { name: 'Hide All', exact: true }).click();
  await expect.poll(hidden).toEqual([true, true, true]);
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
