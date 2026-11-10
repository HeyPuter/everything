import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

type Handle = { __parametric: import('../../src/app/app').App };

for (const action of ['rename', 'delete'] as const) for (const edited of [true, false]) test(`an open feature's expression follows a variable ${action} (edited: ${edited})`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    a.store.change('Link depth', (doc) => {
      doc.variables = [{ id: 'v1', name: 'Width', expr: '30' }];
      const f = doc.features.find((f) => f.id === 'f1');
      if (f?.type === 'extrude') f.depth = '=Width';
    });
    a.editFeature('f1');
  });
  const depth = page.getByRole('textbox', { name: 'Depth', exact: true });
  if (edited) {
    await depth.fill('="Width" + 10');
    await depth.press('Tab');
  }
  await page.evaluate(() => (window as unknown as Handle).__parametric.commands.run('equations'));
  const equations = page.getByRole('dialog', { name: 'Equations and Global Variables', exact: true });
  if (action === 'rename') await equations.getByRole('textbox', { name: 'Name of variable 1' }).fill('Span');
  else await equations.getByRole('button', { name: 'Delete Width', exact: true }).click();
  await equations.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(depth).toHaveValue(edited ? action === 'rename' ? '="Span" + 10' : '=30 + 10' : action === 'rename' ? '=Span' : '=30');
  expect(await page.evaluate(() => (window as unknown as Handle).__parametric.panel?.edited)).toBe(edited);
  await page.getByRole('button', { name: edited ? 'OK' : 'Cancel', exact: true }).first().click();
  const value = await page.evaluate(async () => {
    const a = (window as unknown as Handle).__parametric;
    await a.whenBuilt();
    const f = a.store.feature('f1');
    return f?.type === 'extrude' ? a.store.evalParam(f.depth, 'length') : null;
  });
  expect(value).toBe(edited ? 40 : 30);
  await expect(page.locator('.ti.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const quote of ['"', "'"]) test(`deleting a variable substitutes its value in ${quote}quoted references`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.evaluate(async (quote) => {
    const a = (window as unknown as Handle).__parametric;
    a.store.change('Link quoted variable', (d) => {
      d.variables = [{ id: 'width', name: 'Width', expr: '-5' }];
      const f = d.features.find((f) => f.type === 'extrude')!;
      if (f.type === 'extrude') f.depth = `=${quote}Width${quote}^2 + 1in`;
    });
    await a.whenBuilt();
    a.commands.run('equations');
  }, quote);
  await expect(page.locator('.ti.error')).toHaveCount(0);
  const dialog = page.getByRole('dialog', { name: 'Equations and Global Variables', exact: true });
  await dialog.getByRole('button', { name: 'Delete Width', exact: true }).click();
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  const depth = await page.evaluate(async () => {
    const a = (window as unknown as Handle).__parametric;
    await a.whenBuilt();
    const f = a.store.doc.features.find((f) => f.type === 'extrude')!;
    return f.type === 'extrude' ? a.store.evalParam(f.depth, 'length') : null;
  });
  expect(depth).toBe(50.4);
  await expect(page.locator('.ti.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const sign of [1, -1]) test(`deleting a variable preserves the exact linked value with sign ${sign}`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  const before = await page.evaluate(async (sign) => {
    const a = (window as unknown as Handle).__parametric;
    a.store.change('Link precise value', (d) => {
      d.variables = [{ id: 'precise', name: 'Width', expr: String(sign * 1000000000001) }];
      const f = d.features.find((f) => f.type === 'extrude')!;
      if (f.type === 'extrude') f.depth = `=${sign < 0 ? '-' : ''}Width - 1000000000000`;
    });
    await a.whenBuilt();
    const f = a.store.doc.features.find((f) => f.type === 'extrude')!;
    const depth = f.type === 'extrude' ? a.store.evalParam(f.depth, 'length') : null;
    a.commands.run('equations');
    return depth;
  }, sign);
  expect(before).toBe(1);
  const dialog = page.getByRole('dialog', { name: 'Equations and Global Variables', exact: true });
  await dialog.getByRole('button', { name: 'Delete Width', exact: true }).click();
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  const after = await page.evaluate(async () => {
    const a = (window as unknown as Handle).__parametric;
    await a.whenBuilt();
    const f = a.store.doc.features.find((f) => f.type === 'extrude')!;
    return f.type === 'extrude' ? a.store.evalParam(f.depth, 'length') : null;
  });
  expect(after).toBe(before);
  await expect(page.locator('.ti.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

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

test('loading repeated variable identifiers preserves independent equation editing', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.evaluate(async (url) => {
    const { parseDocument } = await import(url);
    const a = (window as unknown as Handle).__parametric;
    const doc = structuredClone(a.store.doc);
    doc.variables = [{ id: 'same', name: 'Width', expr: '30' }, { id: 'same', name: 'Depth', expr: '5' }];
    const f = doc.features.find((f) => f.type === 'extrude')!;
    if (f.type === 'extrude') f.depth = '=Width';
    a.loadDocument(parseDocument(JSON.stringify(doc)), null);
    a.commands.run('equations');
  }, '/src/model/document.ts');
  const dialog = page.getByRole('dialog', { name: 'Equations and Global Variables', exact: true });
  await dialog.getByRole('textbox', { name: 'Name of variable 1' }).fill('Span');
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  const depth = await page.evaluate(async () => {
    const a = (window as unknown as Handle).__parametric;
    await a.whenBuilt();
    const f = a.store.doc.features.find((f) => f.type === 'extrude')!;
    return f.type === 'extrude' ? f.depth : null;
  });
  expect(depth).toBe('=Span');
  await expect(page.locator('.ti.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});
