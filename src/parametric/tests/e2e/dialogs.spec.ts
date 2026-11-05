import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

type Handle = { __parametric: import('../../src/app/app').App };

for (const command of ['equations', 'material', 'properties'] as const) for (const timing of ['while open', 'on Apply'] as const) test(`${command} edits cannot be applied to a document replaced ${timing}`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate((command) => {
    const a = (window as unknown as Handle).__parametric;
    a.store.change('Initial variables', (d) => { d.variables.push({ id: 'v1', name: 'Width', expr: '10' }); });
    a.commands.run(command);
  }, command);
  const dialog = page.getByRole('dialog', { name: command === 'equations' ? 'Equations and Global Variables' : command === 'material' ? 'Material' : 'Part Properties', exact: true });
  if (command === 'equations') await dialog.getByRole('textbox', { name: 'Value or expression of Width' }).fill('25');
  if (command === 'material') await dialog.getByLabel('Material', { exact: true }).selectOption({ label: 'Custom...' });
  if (command === 'properties') await dialog.getByRole('textbox', { name: 'Part name', exact: true }).fill('Old edits');
  await page.evaluate(({ timing, command }) => {
    if (timing === 'on Apply') {
      const button = [...document.querySelectorAll<HTMLButtonElement>('.dialog-foot button')].find((b) => b.textContent === (command === 'material' ? 'Apply' : 'OK'))!;
      button.click();
    }
    (window as unknown as Handle).__parametric.newDocument('Replacement');
  }, { timing, command });
  // A stale dialog must close; exercise the previous Apply path if it remains.
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: command === 'material' ? 'Apply' : 'OK', exact: true }).click();
  const state = await page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    return { name: a.store.doc.name, variables: a.store.doc.variables, material: a.store.doc.material, dirty: a.store.dirty };
  });
  expect(state).toEqual({ name: 'Replacement', variables: [], material: null, dirty: false });
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('material edits still apply after Undo within the same document', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    a.store.change('Rename', (d) => { d.name = 'Renamed'; });
    a.commands.run('material');
  });
  const dialog = page.getByRole('dialog', { name: 'Material', exact: true });
  await dialog.getByLabel('Material', { exact: true }).selectOption({ label: 'Custom...' });
  await dialog.getByLabel('Custom material name').fill('Test material');
  await dialog.getByLabel('Density in kg per cubic metre').fill('2222');
  await page.evaluate(() => (window as unknown as Handle).__parametric.store.undo());
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Apply' }).click();
  expect(await page.evaluate(() => {
    const d = (window as unknown as Handle).__parametric.store.doc;
    return { name: d.name, material: d.material };
  })).toEqual({ name: 'Part1', material: { name: 'Test material', density: 2222 } });
  expect(errors).toEqual([]);
});
