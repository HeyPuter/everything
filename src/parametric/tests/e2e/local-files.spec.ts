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

test('saving a part that another tab saved since asks before replacing that version', async ({ context }) => {
  type A = import('../../src/app/app').App;
  const app = (p: import('@playwright/test').Page) => p.waitForFunction(() => (window as unknown as { __parametric?: A }).__parametric);
  const edit = (p: import('@playwright/test').Page, name: string) => p.evaluate((n) => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    a.store.change(n, (d) => { d.variables.push({ id: n, name: n, expr: '1' }); });
    a.commands.run('save');
  }, name);
  const stored = (p: import('@playwright/test').Page) => p.evaluate(async (url) => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    return (JSON.parse(await (await import(url)).loadText(a.location)).variables as { name: string }[]).map((v) => v.name);
  }, '/src/platform/files.ts');
  const first = await context.newPage();
  const errors = await openApp(first);
  await first.getByRole('button', { name: /New part/ }).click();
  await app(first);
  await edit(first, 'First');
  await expect(first).toHaveTitle('Part1 - Parametric');
  // The same part opened in a second tab.
  const second = await context.newPage();
  await openApp(second);
  await app(second);
  await second.evaluate(() => { (window as unknown as { __parametric: A }).__parametric.commands.run('open'); });
  await second.getByRole('dialog', { name: 'Open' }).getByRole('button', { name: /^Part1 This browser/ }).click();
  await second.waitForFunction(() => (window as unknown as { __parametric: A }).__parametric.location);
  // The first tab saves more work; the second tab, still on the older version, is told.
  await edit(first, 'Second');
  await expect(first).toHaveTitle('Part1 - Parametric');
  await expect(second.getByRole('region', { name: 'Notifications' })).toContainText('saved in another tab');
  await edit(second, 'Other');
  const ask = second.getByRole('dialog', { name: 'Replace the saved part?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(second).toHaveTitle('* Part1 - Parametric');
  expect(await stored(second)).toEqual(['First', 'Second']);
  // Replacing on purpose saves, and the next save does not ask again.
  await second.evaluate(() => (window as unknown as { __parametric: A }).__parametric.commands.run('save'));
  await ask.getByRole('button', { name: 'Replace' }).click();
  await expect(second).toHaveTitle('Part1 - Parametric');
  expect(await stored(second)).toEqual(['First', 'Other']);
  await edit(second, 'Again');
  await expect(second).toHaveTitle('Part1 - Parametric');
  await expect(ask).toHaveCount(0);
  expect(errors).toEqual([]);
});
