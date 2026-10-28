import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// Edit Equation shows the selected equation as linear text; updating it unchanged leaves the same equation.
const equations = page => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs.filter(r => r.math).map(r => r.math.xml)));
const selectEquation = (page, index) => page.evaluate(index => {
  const engine = window.__docs.current.view.engine, model = engine.model;
  let at = 0, found = -1, seen = 0;
  for (const p of model.paragraphs) { for (const run of p.runs) { if (run.math && seen++ === index) found = at; at += run.text.length; } at++; if (found >= 0) break; }
  model.select(found, found + 1); engine.syncInput(); engine.paint(); engine.onSelection(); engine.focus();
}, index);

test('updating an equation unchanged keeps binomials, matrices and root degrees', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.focus();
  for (const linear of ['(a+b)^n=∑_(k=0)^n (n¦k) a^k b^(n-k)', '|■(a&b@c&d)|=ad-bc', 'r=∛V+\\hat(xy)']) {
    await page.keyboard.press(process.platform === 'darwin' ? 'Control+Equal' : 'Alt+Equal');
    const dialog = page.getByRole('dialog', { name: 'Equation' });
    await dialog.getByRole('textbox', { name: 'Equation in linear format' }).fill(linear);
    await dialog.getByRole('button', { name: 'Insert' }).click();
    await expect(dialog).toBeHidden();
    await input.press('Enter');
  }
  const before = await equations(page);
  expect(before).toHaveLength(3);
  for (const [index, xml] of before.entries()) {
    await selectEquation(page, index);
    await onTab(page, 'insert');
    await page.getByRole('button', { name: 'Equation gallery' }).click();
    await page.getByRole('menuitem', { name: 'Edit Equation…' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit Equation' });
    await expect(edit.getByRole('textbox', { name: 'Equation in linear format' })).not.toHaveValue('');
    await edit.getByRole('button', { name: 'Update' }).click();
    await expect(edit).toBeHidden();
    expect((await equations(page))[index], `equation ${index + 1}`).toBe(xml);
  }
  expect(errors).toEqual([]);
});

test('a displayed equation of two lines keeps its lines through Edit Equation', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Control+Equal' : 'Alt+Equal');
  const dialog = page.getByRole('dialog', { name: 'Equation' }), box = dialog.getByRole('textbox', { name: 'Equation in linear format' });
  await box.fill('x+y=3');
  await box.press('Shift+Enter');
  await box.pressSequentially('x-y=1');
  await dialog.getByRole('checkbox', { name: 'Display on its own line' }).check();
  await expect(dialog.locator('.insert-equation-preview math mspace[linebreak="newline"]')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Insert' }).click();
  await expect(dialog).toBeHidden();
  const [xml] = await equations(page);
  expect(xml.match(/<m:oMath>/g)).toHaveLength(2);
  await selectEquation(page, 0);
  await onTab(page, 'insert');
  await page.getByRole('button', { name: 'Equation gallery' }).click();
  await page.getByRole('menuitem', { name: 'Edit Equation…' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Equation' });
  await expect(edit.getByRole('textbox', { name: 'Equation in linear format' })).toHaveValue('x+y=3\nx−y=1');
  await edit.getByRole('button', { name: 'Update' }).click();
  await expect(edit).toBeHidden();
  expect((await equations(page))[0]).toBe(xml);
  expect(errors).toEqual([]);
});
