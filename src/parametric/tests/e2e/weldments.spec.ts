import { expect, test } from '@playwright/test';
import { canvasCenter, openApp, waitForFeature } from './helpers';

type App = import('../../src/app/app').App;
type W = { __parametric: App };

test.describe('weldments', () => {
  test('sketches a rectangle, adds a structural member, shows the cut list, saves and reopens', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.getByRole('treeitem', { name: 'Front Plane' }).click();
    await page.getByRole('tab', { name: 'Sketch' }).click();
    await page.locator('[data-cmd="sketch"]').first().click();
    await expect(page.locator('.view-label')).toHaveText('Front');
    const { x, y } = await canvasCenter(page);
    await page.locator('[data-cmd="tool:rectangle"]').click();
    await page.mouse.click(x - 150, y + 80);
    await page.mouse.click(x + 150, y - 80);
    await page.keyboard.press('Escape');
    // Structural Member finishes the sketch, whose lines become the first group.
    await page.getByRole('tab', { name: 'Weldments' }).click();
    await page.locator('[data-cmd="structuralMember"]').first().click();
    await expect(page.getByRole('heading', { name: 'Structural Member' })).toBeVisible();
    const group = page.getByRole('group', { name: 'Group 1' });
    await expect(group.locator('.item')).toHaveCount(4);
    await expect(group).toContainText('Line 1 of Sketch1');
    // Profile from the library.
    await page.getByLabel('Type', { exact: true }).selectOption('rectTube');
    await page.getByLabel('Size', { exact: true }).selectOption('60x40x3');
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    await waitForFeature(page, 'Structural Member1');
    await expect(page.locator('.ti.error')).toHaveCount(0);
    // The first member of a part without a material makes it steel.
    await expect(page.getByRole('treeitem', { name: 'Plain Carbon Steel' })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: 'Cut list (4)' })).toBeVisible();

    // The cut list: two pairs of mitered members.
    await page.getByRole('treeitem', { name: 'Cut list (4)' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cut List' });
    await expect(dialog).toBeVisible();
    const rows = dialog.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('RECT TUBE 60 x 40 x 3');
    await expect(rows.nth(0).locator('td').nth(1)).toHaveText('2');
    await expect(rows.nth(0).locator('td').nth(4)).toHaveText('45.00');
    const csv = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export CSV' }).click();
    const file = await csv;
    expect(file.suggestedFilename()).toBe('Part1 cut list.csv');
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(dialog).toHaveCount(0);

    // Editing a sketch line moves its member (the cut list follows).
    const lengths = () => page.evaluate(() => (window as unknown as W).__parametric.weldments.map((m) => Math.round(m.length)).sort((a, b) => a - b));
    const before = await lengths();
    expect(before).toHaveLength(4);
    await page.evaluate(() => {
      const a = (window as unknown as W).__parametric;
      a.store.change('Wider', (d) => {
        const sk = d.features.find((f) => f.type === 'sketch')!;
        if (sk.type !== 'sketch') return;
        for (const e of sk.entities) if (e.t === 'point' && e.x > 0) e.x += 100;
      });
    });
    await expect.poll(lengths).not.toEqual(before);

    // Save in this browser, reload, and open it again.
    await page.evaluate(() => (window as unknown as W).__parametric.commands.run('save'));
    await expect(page).toHaveTitle('Part1 - Parametric');
    const after = await lengths();
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { __parametric?: App }).__parametric);
    void page.evaluate(() => (window as unknown as W).__parametric.commands.run('open'));
    await page.getByRole('dialog', { name: 'Open' }).getByRole('button', { name: /^Part1 This browser/ }).click();
    await waitForFeature(page, 'Structural Member1');
    await expect(page.getByRole('treeitem', { name: 'Cut list (4)' })).toBeVisible();
    await expect(page.locator('.ti.error')).toHaveCount(0);
    expect(await lengths()).toEqual(after);
    // Editing the feature opens its panel with its groups.
    await page.getByRole('treeitem', { name: 'Structural Member1' }).dblclick();
    await expect(page.getByRole('heading', { name: 'Structural Member1' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Group 1' }).locator('.item')).toHaveCount(4);
    await expect(page.getByLabel('Size', { exact: true })).toHaveValue('60x40x3');
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });

  test('picks sketch lines in the graphics area, adds groups and warns before deleting the sketch', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.evaluate(() => {
      const a = (window as unknown as W).__parametric;
      a.store.change('Layout', (d) => {
        const pts: [number, number][] = [[-60, 0], [60, 0], [0, -80]];
        d.features.push({ id: 's1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, constraints: [], entities: [
          ...pts.map(([x, y], i) => ({ id: `p${i}`, t: 'point' as const, x, y })),
          { id: 'top', t: 'line', a: 'p0', b: 'p1' }, { id: 'post', t: 'line', a: 'p2', b: 'p0' },
        ] });
      });
      a.viewport.setView('front', false);
      a.viewport.zoomToFit(false);
    });
    await page.getByRole('tab', { name: 'Weldments' }).click();
    await page.locator('[data-cmd="structuralMember"]').first().click();
    await expect(page.getByRole('heading', { name: 'Structural Member' })).toBeVisible();
    // Click the top line in the graphics area.
    const pos = (p: [number, number, number]) => page.evaluate((q) => {
      const a = (window as unknown as W).__parametric;
      const s = a.renderer.camera.project(q);
      const r = a.renderer.canvas.getBoundingClientRect();
      return { x: r.left + s[0], y: r.top + s[1] };
    }, p);
    const top = await pos([20, 0, 0]);
    await page.mouse.click(top.x, top.y);
    await expect(page.getByRole('group', { name: 'Group 1' }).locator('.item')).toHaveCount(1);
    await page.getByRole('button', { name: 'New Group' }).click();
    const post = await pos([-30, -40, 0]);
    await page.mouse.click(post.x, post.y);
    await expect(page.getByRole('group', { name: 'Group 2' }).locator('.item')).toHaveCount(1);
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    await waitForFeature(page, 'Structural Member1');
    await expect(page.locator('.ti.error')).toHaveCount(0);
    await expect(page.getByRole('treeitem', { name: 'Cut list (2)' })).toBeVisible();
    // Deleting the layout sketch names the member that needs it.
    await page.getByRole('treeitem', { name: 'Sketch1' }).click();
    await page.keyboard.press('Delete');
    await expect(page.getByRole('dialog', { name: 'Delete' })).toContainText('Structural Member1');
    await page.getByRole('button', { name: 'Cancel' }).click();
    expect(errors).toEqual([]);
  });
});
