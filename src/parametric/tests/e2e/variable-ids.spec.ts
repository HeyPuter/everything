import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

type Handle = { __parametric: import('../../src/app/app').App };

test('replacing a deleted variable under a repeated clock preserves the old linked value', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.evaluate(() => {
    const now = Date.now();
    Date.now = () => now;
    (window as unknown as Handle).__parametric.commands.run('equations');
  });
  const dialog = page.getByRole('dialog', { name: 'Equations and Global Variables', exact: true });
  await dialog.getByRole('button', { name: 'Add variable' }).click();
  await dialog.getByRole('textbox', { name: 'Name of variable 1' }).fill('Width');
  await dialog.getByRole('textbox', { name: 'Name of variable 1' }).press('Tab');
  await dialog.getByRole('textbox', { name: 'Value or expression of Width' }).fill('30');
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  const originalId = await page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    a.store.change('Link depth', (d) => { const f = d.features.find((f) => f.type === 'extrude')!; if (f.type === 'extrude') f.depth = '=Width'; });
    a.commands.run('equations');
    return a.store.doc.variables[0].id;
  });
  await dialog.getByRole('button', { name: 'Delete Width', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add variable' }).click();
  await dialog.getByRole('textbox', { name: 'Name of variable 1' }).fill('Replacement');
  await dialog.getByRole('textbox', { name: 'Name of variable 1' }).press('Tab');
  await dialog.getByRole('textbox', { name: 'Value or expression of Replacement' }).fill('5');
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  const state = await page.evaluate(async () => {
    const a = (window as unknown as Handle).__parametric;
    await a.whenBuilt();
    const f = a.store.doc.features.find((f) => f.type === 'extrude')!;
    return { id: a.store.doc.variables[0].id, depth: f.type === 'extrude' ? f.depth : null };
  });
  expect(state.depth).toBe('=30');
  expect(state.id).not.toBe(originalId);
  await expect(page.locator('.ti.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('variables from separate assistant calls remain independently renameable when the clock repeats', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.evaluate(async ({ hostUrl, toolsUrl }) => {
    const now = Date.now();
    Date.now = () => now;
    const a = (window as unknown as Handle).__parametric;
    const [{ appHost }, { runTool }] = await Promise.all([import(hostUrl), import(toolsUrl)]);
    for (const [name, value] of [['Width', 30], ['Depth', 5]]) {
      const result = await runTool(appHost(a), 'set_variables', { set: [{ name, value }] });
      if (!result.ok) throw new Error(result.content);
    }
    a.store.change('Link depth', (d) => { const f = d.features.find((f) => f.type === 'extrude')!; if (f.type === 'extrude') f.depth = '=Width'; });
    a.commands.run('equations');
  }, { hostUrl: '/src/app/assistant-host.ts', toolsUrl: '/src/assistant/tools.ts' });
  const dialog = page.getByRole('dialog', { name: 'Equations and Global Variables', exact: true });
  await dialog.getByRole('textbox', { name: 'Name of variable 1' }).fill('Span');
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  const state = await page.evaluate(async () => {
    const a = (window as unknown as Handle).__parametric;
    await a.whenBuilt();
    const f = a.store.doc.features.find((f) => f.type === 'extrude')!;
    return { variables: a.store.doc.variables, depth: f.type === 'extrude' ? f.depth : null };
  });
  expect(state.depth).toBe('=Span');
  expect(new Set(state.variables.map((v) => v.id)).size).toBe(2);
  expect(state.variables.map((v) => v.name)).toEqual(['Span', 'Depth']);
  await expect(page.locator('.ti.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});
