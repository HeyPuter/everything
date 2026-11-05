import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

type Win = { __parametric: import('../../src/app/app').App };

for (const tool of ['offset', 'sectionView'] as const) for (const action of ['rename', 'delete', 'value edit'] as const) for (const pending of [false, true]) {
  test(`${tool} handles its expression after variable ${action} (pending ${pending})`, async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    if (tool === 'offset') {
      await page.getByRole('treeitem', { name: 'Front Plane' }).click();
      await page.getByRole('tab', { name: 'Sketch' }).click();
      await page.locator('[data-cmd="sketch"]').first().click();
      await expect(page.locator('.view-label')).toHaveText('Front');
    }
    await page.evaluate((tool) => {
      const a = (window as unknown as Win).__parametric;
      a.store.change('Add variable', (doc) => { doc.variables = [{ id: 'gap', name: 'Gap', expr: '10' }]; });
      if (tool === 'offset') {
        a.sketchEditor!.edit('Add circle', (sk) => sk.entities.push({ id: 'c', t: 'point', x: 0, y: 0 }, { id: 'circle', t: 'circle', c: 'c', r: 100 }));
        a.selection.set([{ kind: 'sk', id: 'circle' }]);
      }
      a.commands.run(tool);
    }, tool);
    const input = page.getByRole('textbox', { name: tool === 'offset' ? 'Offset distance' : 'Offset', exact: true });
    await input.fill('=Gap/2');
    if (pending) {
      await page.evaluate((action) => {
        (window as unknown as Win).__parametric.store.change('Edit variable', (doc) => {
          if (action === 'rename') doc.variables[0].name = 'Span';
          else if (action === 'delete') doc.variables = [];
          else doc.variables[0].expr = '12';
        });
      }, action);
    } else {
      await input.press('Tab');
      await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('equations'));
      const equations = page.getByRole('dialog', { name: 'Equations and Global Variables', exact: true });
      if (action === 'rename') await equations.getByRole('textbox', { name: 'Name of variable 1', exact: true }).fill('Span');
      else if (action === 'delete') await equations.getByRole('button', { name: 'Delete Gap', exact: true }).click();
      else await equations.getByRole('textbox', { name: 'Value or expression of Gap', exact: true }).fill('12');
      await equations.getByRole('button', { name: 'OK', exact: true }).click();
    }
    // Revisit the unchanged field: obsolete expression text must not block acceptance.
    await input.focus();
    await input.press('Enter');
    expect(await input.getAttribute('aria-invalid')).not.toBe('true');
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    const value = await page.evaluate((tool) => {
      const a = (window as unknown as Win).__parametric;
      if (tool === 'sectionView') return a.renderer.section?.offset;
      const circle = a.sketchEditor!.sketch.entities.find((e) => e.t === 'circle' && e.id !== 'circle');
      return circle?.t === 'circle' ? circle.r - 100 : null;
    }, tool);
    expect(value).toBe(action === 'value edit' ? 6 : 5);
    expect(errors).toEqual([]);
  });
}

for (const close of ['cancel', 'new part', 'restore prior section'] as const) test(`closing Section View via ${close} retires its pending offset`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('sectionView'));
  if (close === 'restore prior section') {
    const input = page.getByRole('textbox', { name: 'Offset', exact: true });
    await input.fill('3');
    await input.press('Tab');
    await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('sectionView'));
  }
  await page.getByRole('textbox', { name: 'Offset', exact: true }).fill('7');
  await page.evaluate(async (close) => {
    const a = (window as unknown as Win).__parametric;
    if (close !== 'new part') await a.closePanel(false);
    else a.newDocument('Replacement');
  }, close);
  const expected = close === 'restore prior section' ? { normal: [0, 0, 1], offset: 3 } : null;
  expect(await page.evaluate(() => (window as unknown as Win).__parametric.renderer.section)).toEqual(expected);
  await page.waitForTimeout(400); // The cancelled field's debounce must remain inert.
  expect(await page.evaluate(() => (window as unknown as Win).__parametric.renderer.section)).toEqual(expected);
  expect(errors).toEqual([]);
});

for (const tool of ['polygon', 'sketchFillet'] as const) for (const change of ['units', 'rename', 'delete'] as const) for (const pending of [false, true]) {
  test(`${tool} keeps its option through ${change} (pending ${pending})`, async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.getByRole('treeitem', { name: 'Front Plane' }).click();
    await page.getByRole('tab', { name: 'Sketch' }).click();
    await page.locator('[data-cmd="sketch"]').first().click();
    await expect(page.locator('.view-label')).toHaveText('Front');
    await page.evaluate((tool) => {
      const a = (window as unknown as Win).__parametric;
      a.store.change('Add variable', (doc) => { doc.variables = [{ id: 'gap', name: 'Gap', expr: '8' }]; });
      if (tool === 'sketchFillet') a.sketchEditor!.edit('Add corner', (sk) => sk.entities.push(
        { id: 'corner', t: 'point', x: 20, y: 20 }, { id: 'a', t: 'point', x: 60, y: 20 }, { id: 'b', t: 'point', x: 20, y: 60 },
        { id: 'h', t: 'line', a: 'corner', b: 'a' }, { id: 'v', t: 'line', a: 'corner', b: 'b' },
      ));
      a.commands.run(`tool:${tool}`);
    }, tool);
    const input = page.getByRole('textbox', { name: tool === 'polygon' ? 'Number of sides' : 'Fillet radius', exact: true });
    await input.fill('=Gap');
    if (!pending) await input.press('Tab');
    await page.evaluate((change) => (window as unknown as Win).__parametric.store.change('Change context', (doc) => {
      if (change === 'units') doc.units = 'IPS';
      else if (change === 'rename') doc.variables[0].name = 'Span';
      else doc.variables = [];
    }), change);
    expect(Number(await input.inputValue())).toBeCloseTo(tool === 'sketchFillet' && change === 'units' ? 8 / 25.4 : 8, 10);
    const result = await page.evaluate((tool) => {
      const ed = (window as unknown as Win).__parametric.sketchEditor!;
      ed.tool!.click!({ p: [20, 20], raw: [20, 20], kind: 'none' }, {} as import('../../src/app/viewport').VPEvent);
      if (tool === 'polygon') ed.tool!.click!({ p: [40, 20], raw: [40, 20], kind: 'none' }, {} as import('../../src/app/viewport').VPEvent);
      if (tool === 'polygon') return ed.sketch.entities.filter((e) => e.t === 'line').length;
      const arc = ed.sketch.entities.find((e) => e.t === 'arc');
      if (!arc || arc.t !== 'arc') return null;
      const points = ed.sketch.entities.filter((e) => e.t === 'point');
      const center = points.find((e) => e.id === arc.c)!, start = points.find((e) => e.id === arc.a)!;
      return Math.hypot(start.x - center.x, start.y - center.y);
    }, tool);
    expect(result).toBeCloseTo(8, 8);
    expect(errors).toEqual([]);
  });
}

for (const boundary of [3, 64, 'invalid'] as const) test(`Polygon side count respects ${boundary} boundary`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.getByRole('treeitem', { name: 'Front Plane' }).click();
  await page.getByRole('tab', { name: 'Sketch' }).click();
  await page.locator('[data-cmd="sketch"]').first().click();
  await expect(page.locator('.view-label')).toHaveText('Front');
  await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('tool:polygon'));
  const input = page.getByRole('textbox', { name: 'Number of sides', exact: true });
  if (boundary === 'invalid') {
    await input.fill('65');
    await input.press('Tab');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveAttribute('title', 'Must be at most 64');
    await input.fill('8');
    await input.press('Tab');
    expect(await input.getAttribute('aria-invalid')).not.toBe('true');
  } else {
    await input.fill(String(boundary));
    await input.press('Tab');
    await input.press(boundary === 3 ? 'ArrowDown' : 'ArrowUp');
    await expect(input).toHaveValue(String(boundary));
    await page.getByRole('button', { name: `${boundary === 3 ? 'Decrease' : 'Increase'} Number of sides`, exact: true }).click();
    await expect(input).toHaveValue(String(boundary));
  }
  const count = await page.evaluate(() => {
    const ed = (window as unknown as Win).__parametric.sketchEditor!;
    ed.tool!.click!({ p: [20, 20], raw: [20, 20], kind: 'none' }, {} as import('../../src/app/viewport').VPEvent);
    ed.tool!.click!({ p: [40, 20], raw: [40, 20], kind: 'none' }, {} as import('../../src/app/viewport').VPEvent);
    return ed.sketch.entities.filter((e) => e.t === 'line').length;
  });
  expect(count).toBe(boundary === 'invalid' ? 8 : boundary);
  expect(errors).toEqual([]);
});
