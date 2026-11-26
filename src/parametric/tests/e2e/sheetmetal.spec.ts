import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { openApp, waitForFeature } from './helpers';

type App = import('../../src/app/app').App;
type W = { __parametric: App };

test.describe('sheet metal', () => {
  test('builds a bracket from an L profile with an edge flange, flattens it and exports DXF', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    // An open L profile on the Front plane: 60 along X, then 40 up.
    await page.evaluate(async () => {
      const a = (window as unknown as W).__parametric;
      const pts = [[0, 0], [60, 0], [60, 40]];
      a.store.change('Profile', (d) => {
        d.features.push({ id: 's1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, constraints: [], entities: [
          ...pts.map(([x, y], i) => ({ id: `p${i}`, t: 'point' as const, x, y })),
          { id: 'l0', t: 'line' as const, a: 'p0', b: 'p1' }, { id: 'l1', t: 'line' as const, a: 'p1', b: 'p2' },
        ] });
      });
      await a.whenBuilt();
    });
    await waitForFeature(page, 'Sketch1');
    await page.getByRole('treeitem', { name: 'Sketch1' }).click();
    await page.getByRole('tab', { name: 'Sheet Metal' }).click();
    await page.locator('[data-cmd="baseFlange"]').first().click();
    await expect(page.getByRole('heading', { name: 'Base Flange' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Thickness' }).fill('2');
    await page.getByRole('textbox', { name: 'Thickness' }).press('Tab');
    await page.getByRole('textbox', { name: 'Bend radius' }).fill('1');
    await page.getByRole('textbox', { name: 'Bend radius' }).press('Tab');
    await page.getByRole('textbox', { name: 'Depth' }).fill('30');
    await page.getByRole('textbox', { name: 'Depth' }).press('Tab');
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    await waitForFeature(page, 'Base-Flange1');
    await expect(page.getByRole('treeitem', { name: 'Sheet-Metal' })).toBeVisible();

    // An edge flange on the free end of the vertical leg (its top edge, along the depth).
    const edge = await page.evaluate(async () => {
      const a = (window as unknown as W).__parametric;
      await a.whenBuilt();
      const i = a.edges.findIndex((e) => e.type === 'line' && Math.abs(e.mid[1] - 40) < 1e-6 && Math.abs(e.mid[0] - 60) < 1e-6);
      a.selection.set([{ kind: 'edge', index: i, name: a.edges[i].name }]);
      return i;
    });
    expect(edge).toBeGreaterThanOrEqual(0);
    await page.locator('[data-cmd="edgeFlange"]').first().click();
    await expect(page.getByRole('heading', { name: 'Edge Flange' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Length' }).fill('15');
    await page.getByRole('textbox', { name: 'Length' }).press('Tab');
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    await waitForFeature(page, 'Edge-Flange1');
    await expect(page.locator('.ti.error')).toHaveCount(0);

    // The flat pattern: two bends, the size from the bend allowance formula.
    await page.locator('[data-cmd="flatten"]').first().click();
    await expect(page.getByRole('heading', { name: 'Flat Pattern' })).toBeVisible();
    const notes = page.locator('.flat-bends tbody tr');
    await expect(notes).toHaveCount(2);
    await expect(notes.first()).toContainText('UP 90° R 1');
    const ba = (Math.PI / 2) * (1 + 0.5 * 2);
    // Base: 60 + 40 - 2 * 3 (outer virtual sharps); the flange, measured from its outer sharp, is 15 - 3 long and its bend cuts the leg back by 3.
    const length = 60 + 40 - 2 * 3 + ba - 3 + ba + (15 - 3);
    await expect(page.locator('.flat-size')).toContainText(`${length.toFixed(2)} mm × 30.00 mm`);
    const flatShown = await page.evaluate(() => { const a = (window as unknown as W).__parametric; return a.bbox!.max[2] - a.bbox!.min[2]; });
    expect(flatShown).toBeCloseTo(30, 3);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export DXF...' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.dxf$/);
    const dxf = new TextDecoder().decode(readFileSync((await file.path())!));
    expect(dxf).toContain('ENTITIES');
    expect(dxf.match(/\nBEND_UP\n/g)?.length).toBeGreaterThanOrEqual(2);
    expect(dxf).toContain('OUTLINE');

    // Leaving the flat pattern shows the folded part again; the tree's Flat-Pattern row opens it.
    await page.getByRole('button', { name: 'Exit Flat Pattern' }).click();
    await expect(page.getByRole('heading', { name: 'Flat Pattern' })).toHaveCount(0);
    const folded = await page.evaluate(() => { const a = (window as unknown as W).__parametric; return a.bbox!.max[1] - a.bbox!.min[1]; });
    expect(folded).toBeCloseTo(40, 3);
    await page.getByRole('treeitem', { name: 'Flat-Pattern' }).click();
    await expect(page.getByRole('heading', { name: 'Flat Pattern' })).toBeVisible();
    await page.getByRole('button', { name: 'Exit Flat Pattern' }).click();

    // Thicker sheet from the Sheet-Metal row rebuilds everything.
    const volume = () => page.evaluate(async () => { const a = (window as unknown as W).__parametric; await a.whenBuilt(); return (await a.kernel.massProperties())!.volume; });
    const thin = await volume();
    await page.getByRole('treeitem', { name: 'Sheet-Metal' }).click();
    await page.getByRole('textbox', { name: 'Thickness' }).fill('3');
    await page.getByRole('textbox', { name: 'Thickness' }).press('Tab');
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    await expect.poll(volume).toBeGreaterThan(thin * 1.4);
    await expect(page.locator('.ti.error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test('an inch part gets sheet metal defaults that read as plain inch values', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  // A small open L profile (0.5 x 0.75 in) in an IPS part.
  await page.evaluate(async () => {
    const a = (window as unknown as W).__parametric;
    const pts = [[0, 0], [12.7, 0], [12.7, 19.05]];
    a.store.change('Profile', (d) => {
      d.units = 'IPS';
      d.features.push({ id: 's1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, constraints: [], entities: [
        ...pts.map(([x, y], i) => ({ id: `p${i}`, t: 'point' as const, x, y })),
        { id: 'l0', t: 'line' as const, a: 'p0', b: 'p1' }, { id: 'l1', t: 'line' as const, a: 'p1', b: 'p2' },
      ] });
    });
    await a.whenBuilt();
  });
  await waitForFeature(page, 'Sketch1');
  await page.getByRole('treeitem', { name: 'Sketch1' }).click();
  await page.getByRole('tab', { name: 'Sheet Metal' }).click();
  await page.locator('[data-cmd="baseFlange"]').first().click();
  await expect(page.getByRole('heading', { name: 'Base Flange' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Thickness' })).toHaveValue('0.06');
  await expect(page.getByRole('textbox', { name: 'Bend radius' })).toHaveValue('0.06');
  await expect(page.getByRole('textbox', { name: 'Depth' })).toHaveValue('0.5');
  await page.getByRole('button', { name: 'OK', exact: true }).first().click();
  await waitForFeature(page, 'Base-Flange1');
  await page.evaluate(async () => {
    const a = (window as unknown as W).__parametric;
    await a.whenBuilt();
    const i = a.edges.findIndex((e) => e.type === 'line' && Math.abs(e.mid[1] - 19.05) < 1e-6);
    a.selection.set([{ kind: 'edge', index: i, name: a.edges[i].name }]);
  });
  await page.locator('[data-cmd="edgeFlange"]').first().click();
  await expect(page.getByRole('heading', { name: 'Edge Flange' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Length' })).toHaveValue('0.6');
  await page.getByRole('button', { name: 'Cancel' }).first().click();
  await page.locator('[data-cmd="hem"]').first().click();
  await expect(page.getByRole('heading', { name: 'Hem' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Length' })).toHaveValue('0.3');
  expect(errors).toEqual([]);
});

test('the Sheet-Metal and Flat-Pattern rows open from the keyboard and have a menu', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(async () => {
    const a = (window as unknown as W).__parametric;
    const pts = [[0, 0], [40, 0], [40, 30], [0, 30]];
    a.store.change('Plate', (d) => {
      d.features.push({ id: 's1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, constraints: [], entities: [
        ...pts.map(([x, y], i) => ({ id: `p${i}`, t: 'point' as const, x, y })),
        ...pts.map((_, i) => ({ id: `l${i}`, t: 'line' as const, a: `p${i}`, b: `p${(i + 1) % 4}` })),
      ] });
      d.features.push({ id: 'b1', name: 'Base-Flange1', type: 'baseFlange', sketch: 's1', flip: false, mid: false, depth: 10, depthEnd: 'blind', depthFlip: false,
        sm: { thickness: 1, radius: 1, allowance: 'kFactor', kFactor: 0.5, allowanceValue: 1.5, relief: 'rectangular', reliefRatio: 0.5 } });
    });
    await a.whenBuilt();
  });
  await waitForFeature(page, 'Base-Flange1');
  await page.getByRole('treeitem', { name: 'Sheet-Metal' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Base-Flange1' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Base-Flange1' })).toHaveCount(0);
  await page.evaluate(() => (window as unknown as W).__parametric.whenBuilt());
  await page.getByRole('treeitem', { name: 'Flat-Pattern' }).focus();
  await expect(page.getByRole('treeitem', { name: 'Flat-Pattern' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Flat Pattern' })).toBeVisible();
  await page.getByRole('button', { name: 'Exit Flat Pattern' }).click();
  await page.getByRole('treeitem', { name: 'Flat-Pattern' }).focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: /Flatten/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Export DXF/ })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
