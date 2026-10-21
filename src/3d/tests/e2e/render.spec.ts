import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function rendering(page: Page) {
  const errors = await openApp(page);
  await page.locator('.ws-tab', { hasText: 'Rendering' }).first().click();
  await page.waitForTimeout(200);
  return errors;
}

/** In-page: import an app module by path (the instance the app uses, also after hot updates). */
const IMPORT = `(p) => import(performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.split('?')[0].endsWith(p)) ?? p)`;

/** Render a still with the given settings and return a summary of the result. */
async function renderStill(page: Page, settings: Record<string, unknown>) {
  await page.evaluate((s) => Object.assign((window as any).app.doc.scene.render, { resolution_percentage: 10, raster_samples: 2 }, s), settings);
  const before = await page.evaluate(() => (window as any).app.reports.length);
  await page.evaluate(() => (window as any).app.run('render.render'));
  // the job reports when it ends
  await page.waitForFunction((n) => (window as any).app.reports.slice(n).some((r: any) => /^Render (finished|failed|cancelled)/.test(r.message)), before);
  await page.waitForFunction(async (imp) => {
    const { renderJob } = await (0, eval)(imp)('/src/render/final/job.ts');
    return !renderJob();
  }, IMPORT);
  return page.evaluate(async (imp) => {
    const { renderResult } = await (0, eval)(imp)('/src/render/final/result.ts');
    const r = renderResult.get();
    return { width: r.width, height: r.height, passes: Object.keys(r.passes), metadata: (r.metadata ?? []).map((f: any) => f.key), overlay: !!r.overlay };
  }, IMPORT);
}

test('Render tab: full engine name and per-engine panels', async ({ page }) => {
  const errors = await rendering(page);
  const props = page.locator('.properties').first();
  const engine = props.locator('.rs-engine .enum-menu');
  await expect(engine).toHaveText(/Realtime \(Raster\)/);
  // the whole name fits (no ellipsis)
  expect(await engine.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const titles = async () => props.locator('.panel:not(.sub) > .panel-header .ph-title').allTextContents();
  expect(await titles()).toEqual(expect.arrayContaining(['Sampling', 'Light Paths', 'Simplify', 'Depth of Field', 'Motion Blur', 'Film', 'Performance', 'Color Management']));
  await page.evaluate(() => {
    (window as any).app.doc.scene.render.engine = 'PATHTRACE';
    (window as any).app.changed('doc');
  });
  await page.waitForTimeout(100);
  expect(await titles()).toEqual(expect.arrayContaining(['Sampling', 'Light Paths', 'Simplify', 'Film', 'Performance', 'Color Management']));
  await expect(props.locator('.panel.sub .ph-title', { hasText: 'Render' }).first()).toBeVisible();
  await expect(props.getByText('Time Limit')).toBeVisible();
  await expectNoErrors(errors);
});

test('Render Result: empty state, metadata burn-in, sidebar tabs and passes', async ({ page }) => {
  const errors = await rendering(page);
  // the empty result draws its own hint instead of a text line
  await expect(page.locator('.ie-meta')).toHaveCount(0);
  const res = await renderStill(page, { use_stamp: true, use_stamp_note: true, stamp_note_text: 'Take 3', use_pass_position: true, use_pass_object_index: true, use_pass_z: true });
  expect(res.width).toBe(192);
  expect(res.passes).toEqual(expect.arrayContaining(['Combined', 'Depth', 'Position', 'IndexOB']));
  expect(res.metadata).toEqual(expect.arrayContaining(['Frame', 'Camera', 'Scene', 'Note']));
  expect(res.overlay).toBe(true);
  const tabs = page.locator('.ie-sidebar .sb-tab');
  await expect(tabs).toHaveText(['Tool', 'Image', 'View', 'Scopes', 'Metadata']);
  await tabs.filter({ hasText: 'Metadata' }).click();
  await expect(page.locator('.ie-sidebar').getByText('Take 3')).toBeVisible();
  await tabs.filter({ hasText: 'View' }).click();
  await expect(page.locator('.ie-sidebar').getByText('Show Metadata')).toBeVisible();
  await expectNoErrors(errors);
});

test('Render region renders only its pixels (cropped or in the frame)', async ({ page }) => {
  const errors = await rendering(page);
  const region = { use_border: true, border_min_x: 0.25, border_max_x: 0.75, border_min_y: 0, border_max_y: 0.5 };
  const full = await renderStill(page, { ...region, use_crop_to_border: false });
  expect([full.width, full.height]).toEqual([192, 108]);
  const alpha = await page.evaluate(async (imp) => {
    const { renderResult } = await (0, eval)(imp)('/src/render/final/result.ts');
    const r = renderResult.get();
    const a = (x: number, y: number) => r.passes.Combined[(y * r.width + x) * 4 + 3];
    return { outside: a(5, 5), inside: a(96, 90) };
  }, IMPORT);
  expect(alpha.outside).toBe(0);
  expect(alpha.inside).toBe(1);
  const crop = await renderStill(page, { ...region, use_crop_to_border: true });
  expect([crop.width, crop.height]).toEqual([96, 54]);
  await expectNoErrors(errors);
});

test('Simplify limits subdivision in the viewport', async ({ page }) => {
  const errors = await openApp(page);
  const verts = () => page.evaluate(() => (window as any).app.graph.get((window as any).app.activeObject.id).mesh.positions.length / 3);
  await page.evaluate(() => {
    const a = (window as any).app;
    a.run('object.modifier_add', { type: 'SUBSURF' });
    a.activeObject.modifiers[0].levels = 3;
    a.changed('doc');
    a.flush?.();
  });
  await page.waitForTimeout(100);
  const full = await verts();
  await page.evaluate(() => {
    const a = (window as any).app;
    Object.assign(a.doc.scene.render, { use_simplify: true, simplify_subdivision: 1 });
    a.changed('doc');
    a.flush?.();
  });
  await page.waitForTimeout(100);
  expect(await verts()).toBe(26);
  expect(full).toBeGreaterThan(26);
  await expectNoErrors(errors);
});

test('Render menu: View Animation and Lock Interface; Output and View Layer panels', async ({ page }) => {
  const errors = await rendering(page);
  await page.locator('.tb-menu', { hasText: 'Render' }).dispatchEvent('pointerdown');
  const menu = page.locator('.menu').last();
  await expect(menu.getByText('View Animation')).toBeVisible();
  await menu.getByText('Lock Interface').click();
  expect(await page.evaluate(() => (window as any).app.doc.scene.render.use_lock_interface)).toBe(true);
  const props = page.locator('.properties').first();
  await props.locator('.rail-tab[data-tab="OUTPUT"]').click();
  for (const t of ['Format', 'Frame Range', 'Output', 'Metadata', 'Post Processing']) await expect(props.locator('.panel-header .ph-title', { hasText: new RegExp(`^${t}$`) }).first()).toBeVisible();
  await props.locator('.rail-tab[data-tab="VIEW_LAYER"]').click();
  await expect(props.getByText('Use for Rendering')).toBeVisible();
  await expect(props.getByText('Object Index')).toBeVisible();
  await expectNoErrors(errors);
});

test('Camera data: aperture shape, safe areas and composition guides drawn in camera view', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as any).app,
      d = a.doc;
    const cam = d.objects[d.scene.camera];
    for (const o of Object.values(d.objects) as any[]) o.select = false;
    cam.select = true;
    d.scene.active_object = cam.id;
    Object.assign(d.cameras[cam.data], { show_safe_areas: true, show_composition_thirds: true });
    a.changed('doc', 'select');
  });
  const v = (await page.locator('.view3d').first().boundingBox())!;
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
  await page.keyboard.press('Numpad0');
  await expect(page.locator('.view3d .camera-guides').first()).toBeVisible();
  // 2 safe-area rectangles + 4 third lines
  expect(await page.locator('.view3d .camera-guides rect').count()).toBe(2);
  const props = page.locator('.properties').first();
  await props.locator('.rail-tab[data-tab="DATA"]').click();
  for (const t of ['Safe Areas', 'Depth of Field', 'Viewport Display']) await expect(props.locator('.panel-header .ph-title', { hasText: new RegExp(`^${t}$`) })).toBeVisible();
  await expectNoErrors(errors);
});
