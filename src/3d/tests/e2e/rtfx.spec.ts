import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** In-page: import an app module by path (the instance the app uses). */
const IMPORT = `(p) => import(performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.split('?')[0].endsWith(p)) ?? p)`;

/** Render a small still and return the Combined pass (RGBA floats). */
async function renderPixels(page: Page, settings: Record<string, unknown> = {}): Promise<number[]> {
  await page.evaluate((s) => {
    const a = (window as any).app;
    Object.assign(a.doc.scene.render, { engine: 'RASTER', resolution_percentage: 10, raster_samples: 2 }, s);
    a.changed('doc');
  }, settings);
  const before = await page.evaluate(() => (window as any).app.reports.length);
  await page.evaluate(() => (window as any).app.run('render.render'));
  await page.waitForFunction((n) => (window as any).app.reports.slice(n).some((r: any) => /^Render (finished|failed|cancelled)/.test(r.message)), before);
  await page.waitForFunction(async (imp) => !(await (0, eval)(imp)('/src/render/final/job.ts')).renderJob(), IMPORT);
  return page.evaluate(async (imp) => {
    const { renderResult } = await (0, eval)(imp)('/src/render/final/result.ts');
    return Array.from(renderResult.get().passes.Combined as Float32Array);
  }, IMPORT);
}

const difference = (a: number[], b: number[]) => {
  let s = 0;
  for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return s / (a.length / 4);
};

const maxDifference = (a: number[], b: number[]) => {
  let m = 0;
  for (let i = 0; i < a.length; i += 4) m = Math.max(m, Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]));
  return m;
};

/** A mirror-like floor under the default cube. */
async function mirrorFloor(page: Page, roughness = 0.05, metallic = 1) {
  await page.evaluate(([roughness, metallic]) => {
    const a = (window as any).app;
    a.run('mesh.primitive_plane_add', { size: 20, location: [0, 0, -1] });
    a.run('material.new');
    const me = a.doc.meshes[a.activeObject.data];
    const ma = a.doc.materials[me.materials[0]];
    const bsdf = ma.tree.nodes.find((n: any) => n.type === 'ShaderNodeBsdfPrincipled');
    bsdf.inputs.Metallic = metallic;
    bsdf.inputs.Roughness = roughness;
    a.changed('doc');
  }, [roughness, metallic]);
}

test('raytracing, fast GI and bloom change the realtime render', async ({ page }) => {
  const errors = await openApp(page);
  await mirrorFloor(page);
  const plain = await renderPixels(page);
  const traced = await renderPixels(page, { use_ssr: true });
  expect(difference(plain, traced)).toBeGreaterThan(0.002);
  const gi = await renderPixels(page, { use_fast_gi: true, fast_gi_method: 'AMBIENT_OCCLUSION_ONLY' });
  expect(difference(traced, gi)).toBeGreaterThan(0.002);
  const bloom = await renderPixels(page, { use_bloom: true, bloom_threshold: 0.05, bloom_intensity: 0.2 });
  expect(difference(gi, bloom)).toBeGreaterThan(0.002);
  await expectNoErrors(errors);
});

test('light influence and shadow options change the realtime render', async ({ page }) => {
  const errors = await openApp(page);
  // a glossy metal sphere instead of the cube, over a matte floor
  await page.evaluate(() => {
    const a = (window as any).app;
    a.run('object.delete');
    a.run('mesh.primitive_uv_sphere_add', { location: [0, 0, 0] });
    a.run('material.new');
    const ma = a.doc.materials[a.doc.meshes[a.activeObject.data].materials[0]];
    const bsdf = ma.tree.nodes.find((n: any) => n.type === 'ShaderNodeBsdfPrincipled');
    bsdf.inputs.Metallic = 1;
    bsdf.inputs.Roughness = 0.25;
  });
  await mirrorFloor(page, 0.5, 0);
  const base = await renderPixels(page);
  const lightId = await page.evaluate(() => Object.keys((window as any).app.doc.lights)[0]);
  const setLight = (v: Record<string, unknown>) =>
    page.evaluate(
      ([id, p]) => {
        Object.assign((window as any).app.doc.lights[id as string], p);
        (window as any).app.changed('doc');
      },
      [lightId, v] as const,
    );
  await setLight({ diffuse_factor: 0 });
  const noDiffuse = await renderPixels(page);
  expect(difference(base, noDiffuse)).toBeGreaterThan(0.002);
  await setLight({ diffuse_factor: 1, specular_factor: 0 });
  const noGlossy = await renderPixels(page);
  // the highlight disappears
  expect(maxDifference(base, noGlossy)).toBeGreaterThan(0.05);
  await setLight({ specular_factor: 1, shadow_soft_size: 1, use_shadow_jitter: true });
  const jitter = await renderPixels(page, { raster_samples: 4 });
  const still = await renderPixels(page, { raster_samples: 4, use_shadows: false });
  expect(difference(jitter, still)).toBeGreaterThan(0.002);
  await expectNoErrors(errors);
});

test('Render and Light tabs show the realtime panels', async ({ page }) => {
  const errors = await openApp(page);
  const props = page.locator('.properties').first();
  await props.locator('.rail-tab[data-tab="RENDER"]').click();
  await expect(props.locator('[data-panel="rs-raytracing"] .ph-title').first()).toHaveText('Raytracing');
  await props.locator('[data-panel="rs-raytracing"] > .panel-header .ph-title').click();
  for (const t of ['Screen Tracing', 'Denoising', 'Fast GI Approximation']) await expect(props.locator('.panel.sub .ph-title', { hasText: t }).first()).toBeVisible();
  // the raytracing toggle edits the scene setting
  await props.locator('[data-panel="rs-raytracing"] > .panel-header .checkbox').first().click();
  expect(await page.evaluate(() => (window as any).app.doc.scene.render.use_ssr)).toBe(true);
  // light: influence and shadow sub-panels
  await page.evaluate(() => {
    const a = (window as any).app;
    const light = Object.values(a.doc.objects).find((o: any) => o.type === 'LIGHT') as any;
    a.run('object.select_all', { action: 'DESELECT' });
    a.doc.objects[light.id].select = true;
    a.doc.scene.active_object = light.id;
    a.changed('select');
  });
  await props.locator('.rail-tab[data-tab="DATA"]').click();
  for (const t of ['Influence', 'Shadow', 'Custom Distance']) await expect(props.locator('.panel.sub .ph-title', { hasText: t }).first()).toBeVisible();
  await expect(props.getByText('Glossy', { exact: true })).toBeVisible();
  await expectNoErrors(errors);
});
