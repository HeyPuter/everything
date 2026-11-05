import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

for (const action of ['Save As', 'New'] as const) test(`${action} preserves the original browser file when the wall clock repeats`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() => {
    const now = Date.now();
    Date.now = () => now;
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    a.store.change('Original work', (d) => { d.variables.push({ id: 'v1', name: 'Original', expr: '17' }); });
    a.commands.run('save');
  });
  await expect(page).toHaveTitle('Part1 - Parametric');
  const original = await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.location);
  expect(original?.type).toBe('local');
  if (action === 'New') await page.evaluate(async () => { await (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.commands.get('new')!.run(); });
  await page.evaluate((action) => {
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    a.store.change('New work', (d) => { d.variables = [{ id: 'v1', name: 'Newer', expr: '42' }]; });
    a.commands.run(action === 'Save As' ? 'saveAs' : 'save');
  }, action);
  if (action === 'Save As') {
    await page.getByRole('dialog', { name: 'Save As' }).getByRole('textbox').fill('Copy');
    await page.getByRole('button', { name: 'OK', exact: true }).click();
  }
  await expect(page).toHaveTitle(`${action === 'Save As' ? 'Copy' : 'Part2'} - Parametric`);
  const stored = await page.evaluate(async ({ original, url }) => {
    const { loadText, listParts } = await import(url);
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    return {
      old: JSON.parse(await loadText(original)), current: JSON.parse(await loadText(a.location)),
      locations: (await listParts()).map((p: { location: unknown }) => p.location),
    };
  }, { original, url: '/src/platform/files.ts' });
  expect(stored.old.name).toBe('Part1');
  expect(stored.old.variables[0].name).toBe('Original');
  expect(stored.current.variables[0].name).toBe('Newer');
  expect(stored.locations).toHaveLength(2);
  expect(errors).toEqual([]);
});
