import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// With a shape or picture selected, a new equation goes after it, as a new drawing does, instead of
// replacing it.
const objects = page => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs.filter(r => r.math || r.image).map(r => r.math ? 'equation' : 'drawing')));

test('inserting an equation keeps a selected shape', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.focus();
  await page.keyboard.type('Shapes sit beside this paragraph of text. '.repeat(4));
  await input.press('ControlOrMeta+Home');
  const insert = page.locator('#ribbon-panel-insert');
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Shapes', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rectangle', exact: true }).click();
  const box = await page.locator('canvas.canvas-page').first().boundingBox();
  await page.mouse.move(box.x + 420, box.y + 380); await page.mouse.down(); await page.mouse.move(box.x + 540, box.y + 450, { steps: 4 }); await page.mouse.up();
  await expect(page.locator('#ribbon-tab-shapeFormat')).toBeVisible();
  expect(await page.evaluate(() => !!window.__docs.current.view.engine.model.selectedImage)).toBe(true);

  // From the gallery (a displayed equation)…
  await onTab(page, 'insert');
  await page.getByRole('button', { name: 'Equation gallery' }).click();
  await page.getByRole('menuitem', { name: /^Pythagorean/ }).click();
  await expect.poll(() => objects(page)).toEqual(['drawing', 'equation']);

  // …and from the dialog (in line), with the shape selected again.
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine, m = e.model;
    let at = 0;
    for (const p of m.paragraphs) { for (const r of p.runs) { if (r.image) { m.select(at, at + 1); e.syncInput(); e.paint(); e.onSelection(); return; } at += r.text.length; } at += 1; }
  });
  expect(await page.evaluate(() => !!window.__docs.current.view.engine.model.selectedImage)).toBe(true);
  await page.keyboard.press(process.platform === 'darwin' ? 'Control+Equal' : 'Alt+Equal');
  const equation = page.getByRole('dialog', { name: 'Equation' });
  await equation.getByRole('textbox', { name: 'Equation in linear format' }).fill('x^2');
  await equation.getByRole('button', { name: 'Insert' }).click();
  await expect.poll(() => objects(page)).toEqual(['drawing', 'equation', 'equation']);
  expect(errors).toEqual([]);
});
