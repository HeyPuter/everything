import { type Page, expect, test } from '@playwright/test';
import { openApp } from './helpers';
import type { App } from '../../src/app/app';
import type { SkEntity, SketchFeature } from '../../src/model/types';

type W = { __parametric: App };

/** Opens a sketch on the Front plane once the camera faces it. */
async function startSketch(page: Page) {
  await page.getByRole('button', { name: /New part/ }).click();
  await page.getByRole('treeitem', { name: 'Front Plane' }).click();
  await page.getByRole('tab', { name: 'Sketch' }).click();
  await page.locator('[data-cmd="sketch"]').first().click();
  await expect(page.locator('.view-label')).toHaveText('Front');
}

/**
 * Page position of a model point, once rebuilding is done and the camera
 * stopped moving (a rebuild can zoom to fit).
 */
async function screenOfModel(page: Page, p: [number, number, number]): Promise<[number, number]> {
  return page.evaluate(async (p) => {
    const a = (window as unknown as W).__parametric;
    await a.whenBuilt();
    const at = () => {
      const [x, y] = a.viewport.project(p);
      const box = a.viewport.canvas.getBoundingClientRect();
      return [box.x + x, box.y + y] as [number, number];
    };
    let last = at();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const now = at();
      if (Math.hypot(now[0] - last[0], now[1] - last[1]) < 0.01) return now;
      last = now;
    }
    return last;
  }, p);
}

/** Page position of a sketch point (sketch coordinates), once the view is still. */
async function screenOf(page: Page, p: [number, number]): Promise<[number, number]> {
  const w = await page.evaluate((p) => {
    const f = (window as unknown as W).__parametric.sketchEditor!.frame;
    return [0, 1, 2].map((i) => f.o[i] + p[0] * f.x[i] + p[1] * f.y[i]) as [number, number, number];
  }, p);
  return screenOfModel(page, w);
}

const sketchOf = (page: Page, id?: string) => page.evaluate((id) => {
  const a = (window as unknown as W).__parametric;
  return structuredClone(a.store.feature<SketchFeature>(id ?? a.sketchEditor!.sketchId)!);
}, id);

/** A 40 x 30 x 10 box from the Front plane, with a sketch opened on its top face. */
async function boxWithTopSketch(page: Page) {
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(async () => {
    const a = (window as unknown as W).__parametric;
    const pts = [[0, 0], [40, 0], [40, 30], [0, 30]];
    a.store.change('Box', (d) => {
      d.features.push({ id: 'boxSketch', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, constraints: [], entities: [
        ...pts.map(([x, y], i) => ({ id: `p${i}`, t: 'point' as const, x, y })),
        ...pts.map((_, i) => ({ id: `l${i}`, t: 'line' as const, a: `p${i}`, b: `p${(i + 1) % 4}` })),
      ] });
      d.features.push({ id: 'boxExtrude', name: 'Extrude1', type: 'extrude', sketch: 'boxSketch', cut: false, end: 'blind', depth: 10, flip: false, dir2: null, draft: 0, draftOutward: false, thin: null });
    });
    await a.whenBuilt();
    const top = a.faces.find((f) => f.name === 'boxExtrude:cap1')!;
    a.startSketchOn({ kind: 'face', face: { name: top.name, sig: { type: top.type, c: top.center, n: top.normal, area: top.area } } });
    await a.whenBuilt();
  });
  await expect(page.locator('.statusbar')).toContainText('Defined');
  // The back edge of the top face: y = 30, z = 10.
  return page.evaluate(() => {
    const a = (window as unknown as W).__parametric;
    return a.edges.findIndex((e) => e.type === 'line' && Math.abs(e.a[1] - 30) < 1e-6 && Math.abs(e.b[1] - 30) < 1e-6 && Math.abs(e.a[2] - 10) < 1e-6 && Math.abs(e.b[2] - 10) < 1e-6);
  });
}

test.describe('constraints', () => {
  test('the Sketch tab keeps drawing tools, modify tools and constraints in separate groups', async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    const draw = page.getByRole('group', { name: 'Draw' });
    const constrain = page.getByRole('group', { name: 'Constrain' });
    await expect(draw.getByRole('button', { name: 'Line', exact: true })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Modify' }).getByRole('button', { name: 'Convert Entities' })).toBeVisible();
    for (const name of ['Smart Dimension', 'Coincident', 'Horizontal', 'Vertical', 'Parallel', 'Perpendicular', 'Tangent', 'Equal', 'Concentric', 'Midpoint', 'Collinear', 'Symmetric', 'Fix']) {
      await expect(constrain.getByRole('button', { name, exact: true })).toBeVisible();
    }
    await expect(draw.getByRole('button', { name: 'Coincident' })).toHaveCount(0);
    // A narrower window shows the constraints as icons, all within reach.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('.cm-tools.compact')).toHaveCount(1);
    const fix = await constrain.getByRole('button', { name: 'Fix', exact: true }).boundingBox();
    expect(fix!.x + fix!.width).toBeLessThanOrEqual(1280);
    expect(await constrain.getByRole('button', { name: 'Fix', exact: true }).locator('.lbl').evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.cm-tools.compact')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a constraint tool adds the constraint once enough is picked, and stays active', async ({ page }) => {
    const errors = await openApp(page);
    await startSketch(page);
    await page.evaluate(() => {
      const a = (window as unknown as W).__parametric;
      a.sketchEditor!.edit('Lines', (sk) => {
        sk.entities.push(
          { id: 'p1', t: 'point', x: 0, y: 0 }, { id: 'p2', t: 'point', x: 40, y: 0 }, { id: 'l1', t: 'line', a: 'p1', b: 'p2' },
          { id: 'p3', t: 'point', x: 10, y: 20 }, { id: 'p4', t: 'point', x: 30, y: 35 }, { id: 'l2', t: 'line', a: 'p3', b: 'p4' },
        );
      });
    });
    const coincident = page.locator('[data-cmd="constraint:coincident"]');
    await coincident.click();
    await expect(coincident).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.statusbar')).toContainText('Pick two points');
    await page.mouse.click(...await screenOf(page, [40, 0]));
    await expect(page.locator('.statusbar')).toContainText('picked 1 of 2');
    await page.mouse.click(...await screenOf(page, [10, 20]));
    await expect.poll(async () => (await sketchOf(page)).constraints.filter((c) => c.type === 'coincident').map((c) => [...c.refs].sort())).toEqual([['p2', 'p3']]);
    const sk = await sketchOf(page);
    const pt = (id: string) => sk.entities.find((e) => e.id === id) as Extract<SkEntity, { t: 'point' }>;
    expect(Math.hypot(pt('p2').x - pt('p3').x, pt('p2').y - pt('p3').y)).toBeLessThan(1e-6);
    // Still active for the next one; Esc leaves it.
    await expect(coincident).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(coincident).toHaveAttribute('aria-pressed', 'false');

    // Geometry selected first gets the constraint at once.
    await page.evaluate(() => (window as unknown as W).__parametric.selection.set([{ kind: 'sk', id: 'l1' }, { kind: 'sk', id: 'l2' }]));
    await page.locator('[data-cmd="constraint:parallel"]').click();
    await expect.poll(async () => (await sketchOf(page)).constraints.some((c) => c.type === 'parallel')).toBe(true);
    await expect(page.locator('[data-cmd="constraint:parallel"]')).toHaveAttribute('aria-pressed', 'false');

    // Picks that do not fit are refused with what to pick instead.
    await page.evaluate(() => (window as unknown as W).__parametric.selection.clear());
    await page.locator('[data-cmd="constraint:perpendicular"]').click();
    const now = await sketchOf(page);
    const p1 = now.entities.find((e) => e.id === 'p1') as { x: number; y: number };
    const p4 = now.entities.find((e) => e.id === 'p4') as { x: number; y: number };
    await page.mouse.click(...await screenOf(page, [p1.x, p1.y]));
    await page.mouse.click(...await screenOf(page, [p4.x, p4.y]));
    await expect(page.locator('.toast').filter({ hasText: 'Perpendicular does not fit' })).toBeVisible();
    expect((await sketchOf(page)).constraints.some((c) => c.type === 'perpendicular')).toBe(false);
    expect(errors).toEqual([]);
  });

  test('a sketch point can be constrained to a model edge, which is projected and linked', async ({ page }) => {
    const errors = await openApp(page);
    const edge = await boxWithTopSketch(page);
    expect(edge).toBeGreaterThanOrEqual(0);
    const local = await page.evaluate(() => {
      const a = (window as unknown as W).__parametric;
      const ed = a.sketchEditor!;
      const q = ed.local([20, 20, 10]);
      ed.edit('Point', (sk) => { sk.entities.push({ id: 'q', t: 'point', x: q[0], y: q[1] }); });
      return q;
    });
    await page.locator('[data-cmd="constraint:coincident"]').click();
    await page.mouse.click(...await screenOf(page, local));
    // The middle of the back edge of the top face.
    await page.mouse.click(...await screenOfModel(page, [20, 30, 10]));
    await expect.poll(async () => (await sketchOf(page)).constraints.some((c) => c.type === 'coincident')).toBe(true);
    const sk = await sketchOf(page);
    const projected = sk.entities.find((e) => e.ext);
    expect(projected).toMatchObject({ t: 'line', construction: true, ext: { kind: 'edge' } });
    const world = await page.evaluate(() => {
      const a = (window as unknown as W).__parametric;
      const q = a.sketchEditor!.sketch.entities.find((e) => e.id === 'q') as { x: number; y: number };
      const f = a.sketchEditor!.frame;
      return [0, 1, 2].map((i) => f.o[i] + q.x * f.x[i] + q.y * f.y[i]);
    });
    expect(world[1]).toBeCloseTo(30, 6);
    expect(world[2]).toBeCloseTo(10, 6);
    expect(errors).toEqual([]);
  });

  test('converted model edges follow the model, refuse trimming, and can be unlinked', async ({ page }) => {
    const errors = await openApp(page);
    const edge = await boxWithTopSketch(page);
    await page.evaluate((edge) => {
      const a = (window as unknown as W).__parametric;
      a.selection.set([{ kind: 'edge', index: edge, name: a.edges[edge].name }]);
      a.commands.run('convertEntities');
      // A circle centred on the right end of the projected edge (x = 40).
      const ed = a.sketchEditor!;
      const sk = ed.sketch;
      const line = sk.entities.find((e) => e.ext)! as Extract<SkEntity, { t: 'line' }>;
      const end = [line.a, line.b].find((id) => {
        const p = sk.entities.find((e) => e.id === id) as { x: number; y: number };
        return Math.abs(ed.frame.o[0] + p.x * ed.frame.x[0] + p.y * ed.frame.y[0] - 40) < 1e-6;
      })!;
      const p = sk.entities.find((e) => e.id === end) as { x: number; y: number };
      ed.edit('Circle', (s) => {
        s.entities.push({ id: 'cc', t: 'point', x: p.x + 2, y: p.y - 3 }, { id: 'circ', t: 'circle', c: 'cc', r: 4 });
        s.constraints.push({ id: 'k', type: 'coincident', refs: ['cc', end] });
      });
    }, edge);
    let sk = await sketchOf(page);
    expect(sk.entities.filter((e) => e.ext)).toHaveLength(1);
    expect(sk.constraints.some((c) => c.type === 'fix')).toBe(false);

    // Trim leaves projected geometry alone.
    await page.locator('[data-cmd="tool:trim"]').click();
    await page.mouse.click(...await screenOfModel(page, [20, 30, 10]));
    await expect(page.locator('.toast').filter({ hasText: 'Projected geometry follows its model edge' })).toBeVisible();
    await page.keyboard.press('Escape');
    expect((await sketchOf(page)).entities.filter((e) => e.ext)).toHaveLength(1);

    // Widen the box: the projected edge and the circle on its end follow.
    const centreX = () => page.evaluate(() => {
      const a = (window as unknown as W).__parametric;
      const s2 = a.store.doc.features.find((f) => f.type === 'sketch' && f.id !== 'boxSketch') as SketchFeature;
      const c = a.builtEntities(s2).find((e) => e.id === 'cc') as { x: number; y: number };
      const f = a.frameOfSketch(s2)!;
      return f.o[0] + c.x * f.x[0] + c.y * f.y[0];
    });
    await page.evaluate(async () => {
      const a = (window as unknown as W).__parametric;
      a.exitSketch(true);
      await a.whenBuilt();
      a.store.change('Wider', (d) => {
        const s1 = d.features[0] as SketchFeature;
        for (const e of s1.entities) if (e.t === 'point' && e.x === 40) e.x = 55;
      });
      await a.whenBuilt();
    });
    await expect.poll(centreX).toBeCloseTo(55, 6);
    await expect(page.locator('.ti.error')).toHaveCount(0);
    // Opening the sketch takes the new positions into it.
    const s2 = await page.evaluate(async () => {
      const a = (window as unknown as W).__parametric;
      const id = a.store.doc.features.find((f) => f.type === 'sketch' && f.id !== 'boxSketch')!.id;
      a.editSketch(id);
      await a.whenBuilt();
      return id;
    });
    await expect.poll(async () => {
      const s = await sketchOf(page, s2);
      const c = s.entities.find((e) => e.id === 'cc') as { x: number; y: number };
      return page.evaluate((c) => { const f = (window as unknown as W).__parametric.sketchEditor!.frame; return f.o[0] + c.x * f.x[0] + c.y * f.y[0]; }, c);
    }).toBeCloseTo(55, 6);

    // Unlink: the geometry stays, fixed where it is.
    const line = (await sketchOf(page, s2)).entities.find((e) => e.ext)!.id;
    await page.evaluate((id) => (window as unknown as W).__parametric.selection.set([{ kind: 'sk', id }]), line);
    await page.getByRole('button', { name: 'Unlink' }).click();
    sk = await sketchOf(page, s2);
    expect(sk.entities.some((e) => e.ext)).toBe(false);
    expect(sk.constraints).toContainEqual(expect.objectContaining({ type: 'fix', refs: [line] }));
    expect(errors).toEqual([]);
  });

  test('Convert Entities with nothing selected picks model edges and vertices', async ({ page }) => {
    const errors = await openApp(page);
    await boxWithTopSketch(page);
    const convert = page.locator('[data-cmd="convertEntities"]');
    await convert.click();
    await expect(convert).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.click(...await screenOfModel(page, [20, 30, 10]));
    await expect.poll(async () => (await sketchOf(page)).entities.filter((e) => e.ext && e.t === 'line')).toHaveLength(1);
    // The opposite corner of the top face: a vertex becomes a linked point.
    await page.mouse.click(...await screenOfModel(page, [40, 0, 10]));
    await expect.poll(async () => (await sketchOf(page)).entities.filter((e) => e.ext?.kind === 'vertex')).toHaveLength(1);
    await page.keyboard.press('Escape');
    await expect(convert).toHaveAttribute('aria-pressed', 'false');
    expect(errors).toEqual([]);
  });
});
