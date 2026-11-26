import { readFileSync } from 'node:fs';
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

  test('exports the cut list as CSV after the latest edit is rebuilt, and says why it is empty', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.evaluate(() => {
      const a = (window as unknown as W).__parametric;
      a.store.change('Layout', (d) => {
        d.features.push({ id: 's1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, constraints: [], entities: [
          { id: 'a', t: 'point', x: 0, y: 0 }, { id: 'b', t: 'point', x: 0, y: 100 }, { id: 'l', t: 'line', a: 'a', b: 'b' },
        ] });
        d.features.push({
          id: 'm1', name: 'Structural Member1', type: 'structuralMember', standard: 'iso', profile: 'squareTube', size: '40x40x3',
          groups: [{ segments: [{ sketch: 's1', entity: 'l' }] }], rotation: 0, mirror: false, pierce: 'centroid', corner: 'miter', gap: 0, trimGroups: true, gap2: 0,
        });
      });
    });
    await expect(page.getByRole('treeitem', { name: 'Cut list (1)' })).toBeVisible();
    const download = page.waitForEvent('download');
    // Lengthen the post and export at once: the file has the new length.
    await page.evaluate(() => {
      const a = (window as unknown as W).__parametric;
      a.store.change('Longer', (d) => {
        const sk = d.features.find((f) => f.id === 's1');
        if (sk?.type === 'sketch') for (const e of sk.entities) if (e.id === 'b' && e.t === 'point') e.y = 300;
      });
      void a.commands.run('cutListCsv');
    });
    const csv = new TextDecoder().decode(readFileSync((await (await download).path())!)).split('\r\n');
    expect(csv[1]).toMatch(/^1,1,SQ TUBE 40 x 40 x 3,300\.00,/);
    // With its line deleted the member fails: the Cut list row says why it lists nothing.
    await page.evaluate(() => {
      const a = (window as unknown as W).__parametric;
      a.store.change('Delete line', (d) => {
        const sk = d.features.find((f) => f.id === 's1');
        if (sk?.type === 'sketch') sk.entities = sk.entities.filter((e) => e.id !== 'l');
      });
    });
    await page.getByRole('treeitem', { name: 'Cut list (0)' }).click();
    await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('No structural members are built');
    expect(errors).toEqual([]);
  });

  test('trims a post to a plate face, caps it and adds a fillet bead from the Weldments tab', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.evaluate(() => {
      const a = (window as unknown as W).__parametric;
      a.store.change('Layout', (d) => {
        const sq = [[-100, -100], [100, -100], [100, 100], [-100, 100]];
        d.features.push({ id: 's1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'top' }, constraints: [], entities: [
          ...sq.map(([x, y], i) => ({ id: `p${i}`, t: 'point' as const, x, y })),
          ...sq.map((_, i) => ({ id: `l${i}`, t: 'line' as const, a: `p${i}`, b: `p${(i + 1) % 4}` })),
        ] });
        d.features.push({ id: 'f2', name: 'Extrude1', type: 'extrude', sketch: 's1', cut: false, end: 'blind', depth: 10, flip: false, dir2: null, draft: 0, draftOutward: false, thin: null });
        d.features.push({ id: 's3', name: 'Sketch2', type: 'sketch', plane: { kind: 'base', plane: 'front' }, constraints: [], entities: [
          { id: 'a', t: 'point', x: 0, y: -30 }, { id: 'b', t: 'point', x: 0, y: 120 }, { id: 'post', t: 'line', a: 'a', b: 'b' },
        ] });
      });
      a.selection.set([{ kind: 'feature', id: 's3' }]);
      void a.commands.run('structuralMember');
    });
    await expect(page.getByRole('group', { name: 'Group 1' }).locator('.item')).toHaveCount(1);
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    await waitForFeature(page, 'Structural Member1');
    // A face of the rebuilt part (waiting for the rebuild that makes it).
    const face = async (test: string) => {
      const find = () => page.evaluate((src) => {
        const a = (window as unknown as W).__parametric;
        const i = a.faces.findIndex(new Function('f', `return ${src}`) as (f: unknown) => boolean);
        return { kind: 'face' as const, index: i, name: a.faces[i]?.name ?? '' };
      }, test);
      await expect.poll(async () => (await find()).index).toBeGreaterThanOrEqual(0);
      return find();
    };
    // Trim/Extend: the post (picked before the command) to the plate's top face.
    const side = await face("/^[^:]+:s3\\/post:/.test(f.name) && f.type === 'plane' && Math.abs(f.normal[0] - 1) < 1e-6");
    await page.evaluate((it) => { const a = (window as unknown as W).__parametric; a.selection.set([it]); }, side);
    await page.getByRole('tab', { name: 'Weldments' }).click();
    await page.locator('[data-cmd="trimExtend"]').first().click();
    await expect(page.getByRole('heading', { name: 'Trim/Extend' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Bodies to be trimmed' }).locator('.item')).toHaveCount(1);
    await page.getByRole('group', { name: 'Face/Plane' }).click();
    const top = await face("f.name === 'f2:cap1'");
    await page.evaluate((it) => (window as unknown as W).__parametric.panel!.onPick(it, false), top);
    await expect(page.getByRole('group', { name: 'Face/Plane' }).locator('.item')).toHaveCount(1);
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    await waitForFeature(page, 'Trim/Extend1');
    await expect(page.locator('.ti.error')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => Math.round((window as unknown as W).__parametric.weldments[0].length))).toBe(110);
    // End cap on the post's top end.
    const end = await face("/^[^:]+:s3\\/post:/.test(f.name) && f.type === 'plane' && f.center[1] > 119.9");
    await page.evaluate((it) => { const a = (window as unknown as W).__parametric; a.selection.set([it]); }, end);
    await page.locator('[data-cmd="endCap"]').first().click();
    await expect(page.getByRole('group', { name: 'Faces' }).locator('.item')).toHaveCount(1);
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    await waitForFeature(page, 'End Cap1');
    await expect(page.locator('.ti.error')).toHaveCount(0);
    // A fillet bead where the post stands on the plate.
    const findEdge = () => page.evaluate(() => {
      const a = (window as unknown as W).__parametric;
      const i = a.edges.findIndex((e) => e.type === 'line' && Math.abs(e.mid[0] - 20) < 1e-6 && Math.abs(e.mid[1] - 10) < 1e-6);
      return { kind: 'edge' as const, index: i, name: a.edges[i]?.name ?? '' };
    });
    await expect.poll(async () => (await findEdge()).index).toBeGreaterThanOrEqual(0);
    const edge = await findEdge();
    await page.evaluate((it) => { const a = (window as unknown as W).__parametric; a.selection.set([it]); }, edge);
    await page.locator('[data-cmd="weldBead"]').first().click();
    await expect(page.getByRole('group', { name: 'Edges' }).locator('.item')).toHaveCount(1);
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    await waitForFeature(page, 'Fillet Bead1');
    await expect(page.locator('.ti.error')).toHaveCount(0);
    // Suppressing the member suppresses what was built on it.
    await page.getByRole('treeitem', { name: 'Structural Member1' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Suppress' }).click();
    await expect(page.getByRole('treeitem', { name: 'Trim/Extend1' })).toHaveClass(/suppressed/);
    await expect(page.getByRole('treeitem', { name: 'End Cap1' })).toHaveClass(/suppressed/);
    await expect(page.locator('.ti.error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
