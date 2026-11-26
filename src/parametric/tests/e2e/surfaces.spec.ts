import { type Page, expect, test } from '@playwright/test';
import { canvasCenter, openApp, waitForFeature } from './helpers';

type A = import('../../src/app/app').App;
const app = (page: Page) => page.waitForFunction(() => (window as unknown as { __parametric?: A }).__parametric);

/** A new part with two profile sketches 20 mm apart: a straight line below and an arch above. */
async function loftProfiles(page: Page) {
  await page.getByRole('button', { name: /New part/ }).click();
  await app(page);
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    a.store.change('Profiles', (d) => {
      d.features.push(
        { id: 'pl', name: 'Plane1', type: 'plane', ref: { kind: 'base', plane: 'top' }, offset: 20, flip: false },
        {
          id: 's1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'top' }, constraints: [],
          entities: [{ id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 40, y: 0 }, { id: 'l', t: 'line', a: 'a', b: 'b' }],
        },
        {
          id: 's2', name: 'Sketch2', type: 'sketch', plane: { kind: 'feature', id: 'pl' }, constraints: [],
          entities: [{ id: 'c', t: 'point', x: 0, y: 0 }, { id: 'd', t: 'point', x: 20, y: -8 }, { id: 'e', t: 'point', x: 40, y: 0 }, { id: 'sp', t: 'spline', pts: ['c', 'd', 'e'] }],
        },
      );
    });
  });
  await waitForFeature(page, 'Sketch2');
}

/** Surface bodies shown, by the feature that made them, with their total area. */
const surfaceBodies = async (page: Page) => {
  const faces = await surfaceFaces(page);
  const out: Record<string, number> = {};
  for (const f of faces) out[f.body!] = (out[f.body!] ?? 0) + f.area;
  return out;
};
const bodyCount = async (page: Page) => Object.keys(await surfaceBodies(page)).length;
const surfaceFaces = (page: Page) => page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.faces.filter((f) => f.body).map((f) => ({ name: f.name, area: f.area, body: f.body })));

test.describe('surfaces', () => {
  test('lofts a surface, thickens it, and saves and reopens the part', async ({ page }) => {
    const errors = await openApp(page);
    await loftProfiles(page);
    await page.getByRole('tab', { name: 'Surfaces' }).click();
    // Both profiles selected in the tree fill the loft's profiles.
    await page.getByRole('treeitem', { name: 'Sketch1' }).click();
    await page.getByRole('treeitem', { name: 'Sketch2' }).click({ modifiers: ['ControlOrMeta'] });
    await page.locator('[data-cmd="surfaceLoft"]').first().click();
    await expect(page.getByRole('heading', { name: 'Lofted Surface' })).toBeVisible();
    await expect(page.locator('.pm .selbox').first()).toContainText('Sketch2');
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    await waitForFeature(page, 'Surface-Loft1');
    await expect(page.locator('.ti.error')).toHaveCount(0);
    await expect.poll(() => bodyCount(page)).toBe(1);
    const [[body, area]] = Object.entries(await surfaceBodies(page));
    const face = { area };
    expect(body).toBe((await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.doc.features.at(-1)!.id)));
    // A surface only: no solid volume, and its area stated apart.
    const before = await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.kernel.massProperties());
    expect(before!.solid).toBe(false);
    expect(before!.surfaceArea).toBeCloseTo(face.area, 3);

    // Thicken it by 2 mm: picked in the graphics area, the surface fills the panel.
    await page.locator('[data-cmd="thicken"]').first().click();
    await expect(page.getByRole('heading', { name: 'Thicken' })).toBeVisible();
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: A }).__parametric;
      const i = a.faces.findIndex((f) => f.body);
      a.panel!.onPick({ kind: 'face', index: i, name: a.faces[i].name }, false);
    });
    await expect(page.locator('.pm .selbox').first()).toContainText('Surface-Loft1');
    const thickness = page.getByRole('textbox', { name: /Thickness/ });
    await thickness.fill('2');
    await thickness.press('Enter');
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    await waitForFeature(page, 'Thicken1');
    await expect(page.locator('.ti.error')).toHaveCount(0);
    await expect.poll(() => bodyCount(page)).toBe(0);
    const mp = await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.kernel.massProperties());
    expect(mp!.solid).toBe(true);
    expect(mp!.volume / (face.area * 2)).toBeGreaterThan(0.9);
    expect(mp!.volume / (face.area * 2)).toBeLessThan(1.1);

    // Save to this browser and open it again.
    await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.commands.run('save'));
    await expect(page).toHaveTitle('Part1 - Parametric');
    await page.evaluate(async () => { await (window as unknown as { __parametric: A }).__parametric.commands.get('new')!.run(); });
    await expect(page.getByRole('treeitem', { name: 'Thicken1' })).toHaveCount(0);
    await page.evaluate(() => { (window as unknown as { __parametric: A }).__parametric.commands.run('open'); });
    await page.getByRole('dialog', { name: 'Open' }).getByRole('button', { name: /^Part1 This browser/ }).click();
    await waitForFeature(page, 'Thicken1');
    await expect(page.getByRole('treeitem', { name: 'Surface-Loft1' })).toBeVisible();
    await expect(page.locator('.ti.error')).toHaveCount(0);
    const types = await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.doc.features.map((f) => f.type));
    expect(types).toEqual(['plane', 'sketch', 'sketch', 'surfaceLoft', 'thicken']);
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.kernel.massProperties()))!.volume).toBeCloseTo(mp!.volume, 3);
    expect(errors).toEqual([]);
  });

  test('hides and shows a surface from the design tree, and rolls back past it', async ({ page }) => {
    const errors = await openApp(page);
    await loftProfiles(page);
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: A }).__parametric;
      a.store.change('Loft', (d) => { d.features.push({ id: 'f9', name: 'Surface-Loft1', type: 'surfaceLoft', profiles: ['s1', 's2'], ruled: false }); });
    });
    await waitForFeature(page, 'Surface-Loft1');
    await expect.poll(() => bodyCount(page)).toBe(1);
    await page.getByRole('treeitem', { name: 'Surface-Loft1' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Hide' }).click();
    expect(await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.feature('f9')!.hidden)).toBe(true);
    // A hidden surface cannot be picked in the graphics area.
    await page.getByRole('button', { name: /Zoom to Fit/ }).first().click().catch(() => {});
    const { x, y } = await canvasCenter(page);
    await page.mouse.click(x, y);
    expect(await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.selection.items.filter((i) => i.kind === 'face').length)).toBe(0);
    await page.getByRole('treeitem', { name: 'Surface-Loft1' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show' }).click();
    expect(await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.feature('f9')!.hidden)).toBe(false);
    // Suppressed, the surface is gone; unsuppressed it is back.
    await page.getByRole('treeitem', { name: 'Surface-Loft1' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Suppress' }).click();
    await expect.poll(() => bodyCount(page)).toBe(0);
    await page.getByRole('treeitem', { name: 'Surface-Loft1' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Unsuppress' }).click();
    await expect.poll(() => bodyCount(page)).toBe(1);
    expect(errors).toEqual([]);
  });

  test('says STL leaves surfaces out: refused for surfaces only, a warning beside a solid', async ({ page }) => {
    const errors = await openApp(page);
    await loftProfiles(page);
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: A }).__parametric;
      a.store.change('Loft', (d) => { d.features.push({ id: 'f9', name: 'Surface-Loft1', type: 'surfaceLoft', profiles: ['s1', 's2'], ruled: false }); });
    });
    await waitForFeature(page, 'Surface-Loft1');
    await expect.poll(() => bodyCount(page)).toBe(1);
    await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('exportStl'); });
    await expect(page.locator('.toast').filter({ hasText: 'STL files hold solids only' })).toBeVisible();
    // A block beside the surface: the STL has the block, and the toast says the surface is not in it.
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: A }).__parametric;
      a.store.change('Block', (d) => {
        d.features.push(
          { id: 's3', name: 'Sketch3', type: 'sketch', plane: { kind: 'base', plane: 'front' }, constraints: [],
            entities: [{ id: 'p0', t: 'point', x: 60, y: 0 }, { id: 'p1', t: 'point', x: 70, y: 0 }, { id: 'p2', t: 'point', x: 70, y: 10 }, { id: 'p3', t: 'point', x: 60, y: 10 },
              { id: 'k0', t: 'line', a: 'p0', b: 'p1' }, { id: 'k1', t: 'line', a: 'p1', b: 'p2' }, { id: 'k2', t: 'line', a: 'p2', b: 'p3' }, { id: 'k3', t: 'line', a: 'p3', b: 'p0' }] },
          { id: 'e1', name: 'Boss-Extrude1', type: 'extrude', sketch: 's3', cut: false, end: 'blind', depth: 5, flip: false, dir2: null, draft: 0, draftOutward: false, thin: null },
        );
      });
    });
    await waitForFeature(page, 'Boss-Extrude1');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.faces.filter((f) => !f.body).length)).toBe(6);
    const download = page.waitForEvent('download');
    await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('exportStl'); });
    expect((await download).suggestedFilename()).toMatch(/\.stl$/);
    await expect(page.locator('.toast').filter({ hasText: 'surface bodies are not in the STL file' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a new extrude does not default to the sketch a surface already uses', async ({ page }) => {
    const errors = await openApp(page);
    await loftProfiles(page);
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: A }).__parametric;
      a.store.change('Loft', (d) => { d.features.push({ id: 'f9', name: 'Surface-Loft1', type: 'surfaceLoft', profiles: ['s1', 's2'], ruled: false }); });
    });
    await waitForFeature(page, 'Surface-Loft1');
    await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.selection.set([]));
    await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('extrude'); });
    await expect(page.getByRole('heading', { name: 'Extrude' })).toBeVisible();
    await expect(page.locator('.pm .selbox').first()).not.toContainText('Sketch2');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('surfaceExtrude'); });
    await expect(page.getByRole('heading', { name: 'Extruded Surface' })).toBeVisible();
    await expect(page.locator('.pm .selbox').first()).not.toContainText('Sketch2');
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });

  test('shows a clear error when knit surfaces do not close a volume', async ({ page }) => {
    const errors = await openApp(page);
    await loftProfiles(page);
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: A }).__parametric;
      a.store.change('Loft', (d) => { d.features.push({ id: 'f9', name: 'Surface-Loft1', type: 'surfaceLoft', profiles: ['s1', 's2'], ruled: false }); });
    });
    await waitForFeature(page, 'Surface-Loft1');
    await expect.poll(() => bodyCount(page)).toBe(1);
    await page.getByRole('tab', { name: 'Surfaces' }).click();
    await page.evaluate(() => {
      const a = (window as unknown as { __parametric: A }).__parametric;
      const i = a.faces.findIndex((f) => f.body);
      a.selection.set([{ kind: 'face', index: i, name: a.faces[i].name }]);
    });
    await page.locator('[data-cmd="surfaceKnit"]').first().click();
    await expect(page.getByRole('heading', { name: 'Knit Surface' })).toBeVisible();
    await page.getByText('Create solid').click();
    await expect(page.locator('.pm-msg.error')).toContainText('do not form a closed volume');
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });
});
