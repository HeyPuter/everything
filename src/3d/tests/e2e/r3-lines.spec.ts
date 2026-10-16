// Line rendering, Line Art and grease pencil interchange: panels, menus and operators wired in the UI.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const run = (page: Page, op: string, props: Record<string, unknown> = {}) => page.evaluate(([o, p]) => (window as any).app.run(o, p, { invoke: false }), [op, props] as const);
const IMPORT = `(p) => import(performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.split('?')[0].endsWith(p)) ?? p)`;

async function headerMenu(page: Page, label: string) {
  await page.locator('.hdr-menu', { hasText: new RegExp(`^${label}$`) }).first().dispatchEvent('pointerdown');
  await page.waitForSelector('.menu');
}

/** Render a still and return the alpha / darkness statistics of the Combined pass and the passes. */
async function renderStats(page: Page) {
  const before = await page.evaluate(() => (window as any).app.reports.length);
  await page.evaluate(() => (window as any).app.run('render.render'));
  await page.waitForFunction((n) => (window as any).app.reports.slice(n).some((r: any) => /^Render (finished|failed|cancelled)/.test(r.message)), before, { timeout: 30000 });
  return page.evaluate(async (imp) => {
    const { renderResult } = await (0, eval)(imp)('/src/render/final/result.ts');
    const r = renderResult.get();
    const c = r.passes.Combined as Float32Array;
    let dark = 0;
    for (let i = 0; i < c.length; i += 4) if (c[i] + c[i + 1] + c[i + 2] < 0.03) dark++;
    const fs = r.passes.Freestyle as Float32Array | undefined;
    let lines = 0;
    if (fs) for (let i = 3; i < fs.length; i += 4) if (fs[i] > 0.5) lines++;
    return { dark, passes: Object.keys(r.passes), lines, msg: (window as any).app.reports.slice(-1)[0]?.message };
  }, IMPORT);
}

test('Freestyle: Render panel, lines over the render and as a pass', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => Object.assign((window as any).app.doc.scene.render, { resolution_percentage: 20, raster_samples: 1 }));
  const plain = await renderStats(page);
  expect(plain.msg).toMatch(/^Render finished/);
  await page.evaluate(async (imp) => (await (0, eval)(imp)('/src/render/final/renderwindow.ts')).closeRenderWindow(), IMPORT);
  // Render tab ▸ Freestyle header checkbox
  await page.locator('.rail-tab[data-tab="RENDER"]').first().click();
  const panel = page.locator('[data-panel="rs-freestyle"]');
  await expect(panel).toBeVisible();
  await panel.locator('.panel-header input[type="checkbox"], .panel-header .checkbox').first().click();
  expect(await page.evaluate(() => (window as any).app.doc.scene.render.use_freestyle)).toBe(true);
  await panel.locator('.panel-header .ph-title').click();
  await expect(panel.getByText('Line Thickness Mode')).toBeVisible();
  const lined = await renderStats(page);
  expect(lined.dark).toBeGreaterThan(plain.dark + 100);
  // As Render Pass keeps the image clean and adds the Freestyle pass
  await page.evaluate(() => {
    (window as any).app.doc.scene.render.freestyle_settings.as_render_pass = true;
  });
  const pass = await renderStats(page);
  expect(pass.passes).toContain('Freestyle');
  expect(pass.lines).toBeGreaterThan(100);
  expect(Math.abs(pass.dark - plain.dark)).toBeLessThan(50);
  await expectNoErrors(errors);
});

test('Freestyle: View Layer line set and line style panels', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    (window as any).app.doc.scene.render.use_freestyle = true;
    (window as any).app.changed('doc');
  });
  await page.locator('.rail-tab[data-tab="VIEW_LAYER"]').first().click();
  const props = page.locator('.properties').first();
  await expect(props.locator('[data-panel="vl-fs-lineset"]')).toBeVisible();
  // + adds a line set with its own line style
  await props.locator('[data-panel="vl-fs-lineset"] .uilist .ul-side .icon-btn').first().click();
  const sets = await page.evaluate(() => (window as any).app.doc.scene.render.freestyle_settings.linesets.map((s: any) => s.name));
  expect(sets).toEqual(['LineSet', 'LineSet 2']);
  // Edge types: exclude toggle only works on selected types
  await expect(props.locator('.fs-edge-type', { hasText: 'Silhouette' }).locator('.fs-x')).toBeEnabled();
  await expect(props.locator('.fs-edge-type', { hasText: 'Contour' }).first().locator('.fs-x')).toBeDisabled();
  // Freestyle Color ▸ Add Modifier
  await props.locator('[data-panel="vl-fs-color"] > .panel-header').click();
  await props.locator('[data-panel="vl-fs-color"] .fs-add-mod').dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: 'Along Stroke' }).first().click();
  await expect(props.locator('[data-panel="vl-fs-color"] .fs-modifier')).toHaveCount(1);
  await expect(props.locator('[data-panel="vl-fs-color"] .nd-ramp')).toBeVisible();
  await props.locator('[data-panel="vl-fs-color"] .fs-modifier .mod-x').click();
  await expect(props.locator('[data-panel="vl-fs-color"] .fs-modifier')).toHaveCount(0);
  await expectNoErrors(errors);
});

test('Freestyle: Edit Mode edge / face marks from the menus', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => ((window as any).app.doc.scene.render.use_freestyle = true));
  await run(page, 'object.mode_set', { mode: 'EDIT' });
  await run(page, 'mesh.select_all', { action: 'SELECT' });
  await hoverViewport(page);
  await headerMenu(page, 'Edge');
  await page.locator('.menu .menu-item', { hasText: 'Mark Freestyle Edge' }).click();
  expect(await page.evaluate(() => (window as any).app.doc.meshes[(window as any).app.activeObject.data].freestyle_edge?.length)).toBe(24);
  await headerMenu(page, 'Face');
  await page.locator('.menu .menu-item', { hasText: 'Face Data' }).hover();
  await page.locator('.menu .menu-item', { hasText: 'Mark Freestyle Face' }).click();
  expect(await page.evaluate(() => Array.from((window as any).app.doc.meshes[(window as any).app.activeObject.data].freestyle_face ?? []).filter(Boolean).length)).toBe(6);
  await expectNoErrors(errors);
});

test('Line Art: Add menu, modifier panel and live strokes', async ({ page }) => {
  const errors = await openApp(page);
  await hoverViewport(page);
  await headerMenu(page, 'Add');
  await page.locator('.menu .menu-item', { hasText: /^Grease Pencil/ }).first().hover();
  await page.locator('.menu .menu-item', { hasText: 'Scene Line Art' }).click();
  const info = await page.evaluate(async (imp) => {
    const a = (window as any).app;
    a.flush();
    const { objectEntries } = await (0, eval)(imp)('/src/greasepencil/render.ts');
    const ob = a.activeObject;
    const gp = a.doc.grease_pencils[ob.data];
    return { name: ob.name, type: ob.modifiers[0]?.type, entries: objectEntries(a.doc, gp, a.doc.scene.frame_current, false, ob).length };
  }, IMPORT);
  expect(info).toEqual({ name: 'LineArt', type: 'LINEART', entries: 1 });
  await page.locator('.rail-tab[data-tab="MODIFIER"]').first().click();
  const props = page.locator('.properties').first();
  await expect(props.getByText('Edge Types')).toBeVisible();
  await expect(props.locator('.la-bake .btn', { hasText: 'Bake Line Art' })).toBeVisible();
  await expectNoErrors(errors);
});

test('Grease pencil interchange in the File menu', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.tb-menu', { hasText: /^File$/ }).dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: /^Export/ }).first().hover();
  await expect(page.locator('.menu .menu-item', { hasText: 'Grease Pencil as SVG' })).toBeVisible();
  await expect(page.locator('.menu .menu-item', { hasText: 'Grease Pencil as PDF' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  // SVG import (text handed to the operator) and export round trip
  const r = await page.evaluate(async (imp) => {
    const a = (window as any).app;
    a.run('wm.grease_pencil_import_svg', { text: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="10" y="10" width="50" height="40" fill="#00f" stroke="#000"/></svg>', filepath: 'box.svg' }, { invoke: false });
    const ob = a.activeObject;
    const { exportGreasePencil } = await (0, eval)(imp)('/src/lines/gpexportops.ts');
    const out = exportGreasePencil(a.doc, 'SVG', { selected_object_type: 'ACTIVE', frame_mode: 'ACTIVE', use_fill: true, use_uniform_width: true });
    return { name: ob.name, type: ob.type, svg: typeof out === 'string' ? out : out.bytes };
  }, IMPORT);
  expect(r.type).toBe('GREASEPENCIL');
  expect(r.name).toBe('box.svg');
  expect(r.svg).toContain('fill="#0000ff"');
  expect(r.svg).toContain('stroke="#000000"');
  await expectNoErrors(errors);
});
