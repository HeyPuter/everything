import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** In-page: import an app module by path (the instance the app uses). */
const IMPORT = `(p) => import(performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.split('?')[0].endsWith(p)) ?? p)`;

async function start(page: Page) {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(10000));
  const errors = await openApp(page);
  await page.locator('.ws-tab', { hasText: 'Rendering' }).first().click();
  await page.waitForTimeout(200);
  return errors;
}

async function render(page: Page, settings: Record<string, unknown>) {
  await page.evaluate((s) => Object.assign((window as any).app.doc.scene.render, { resolution_percentage: 10, raster_samples: 2, samples: 4 }, s), settings);
  const before = await page.evaluate(() => (window as any).app.reports.length);
  await page.evaluate(() => (window as any).app.run('render.render'));
  await page.waitForFunction((n) => (window as any).app.reports.slice(n).some((r: any) => /^Render (finished|failed|cancelled)/.test(r.message)), before, { timeout: 60_000 });
  await page.waitForFunction(async (imp) => !(await (0, eval)(imp)('/src/render/final/job.ts')).renderJob(), IMPORT);
  return page.evaluate(async (imp) => {
    const { renderResult } = await (0, eval)(imp)('/src/render/final/result.ts');
    const r = renderResult.get();
    let sum = 0;
    const c = r.passes.Combined;
    for (let i = 0; i < c.length; i += 4) sum += c[i] + c[i + 1] + c[i + 2];
    return { width: r.width, height: r.height, views: (r.views ?? []).map((v: any) => v.name), stereo: !!r.stereo, mean: sum / (c.length / 4), reports: (window as any).app.reports.slice(-3).map((x: any) => x.message) };
  }, IMPORT);
}

test('Path tracer panels: adaptive sampling, denoise options, light path kinds and presets', async ({ page }) => {
  const errors = await start(page);
  await page.evaluate(() => {
    (window as any).app.doc.scene.render.engine = 'PATHTRACE';
    (window as any).app.changed('doc');
  });
  const props = page.locator('.properties').first();
  await expect(props.getByText('Noise Threshold').first()).toBeVisible();
  // the checkbox in front of the threshold switches adaptive sampling
  const row = props.locator('[data-panel="rs-pt-samp-render"] .split-row', { hasText: 'Noise Threshold' });
  await row.locator('.checkbox').click();
  expect(await page.evaluate(() => (window as any).app.doc.scene.render.cycles.use_adaptive_sampling)).toBe(false);
  // presets of the Sampling panel set the sample count and threshold together
  await props.locator('[data-panel="rs-pt-sampling"] > .panel-header .preset-btn').dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: /^Production$/ }).click();
  const r = await page.evaluate(() => {
    const s = (window as any).app.doc.scene.render;
    return { samples: s.samples, threshold: s.cycles.adaptive_threshold, adaptive: s.cycles.use_adaptive_sampling };
  });
  expect(r).toEqual({ samples: 1024, threshold: 0.01, adaptive: true });
  // light paths: volume / transparent bounces and the fast GI approximation
  await props.locator('[data-panel="rs-pt-lightpaths"] > .panel-header .ph-title').click();
  await props.locator('[data-panel="rs-lp-caustics"] > .panel-header .ph-title').click();
  for (const t of ['Volume', 'Transparent', 'Reflective', 'Refractive']) await expect(props.locator('[data-panel="rs-pt-lightpaths"]').getByText(t, { exact: true }).first()).toBeAttached();
  await expect(props.locator('[data-panel="rs-lp-fastgi"] .ph-title')).toHaveText('Fast GI Approximation');
  // a render with fast GI and no caustics completes
  const res = await render(page, { cycles: { ...(await page.evaluate(() => (window as any).app.doc.scene.render.cycles)), use_fast_gi: true, caustics_reflective: false, seed: 3 } });
  expect(res.mean).toBeGreaterThan(0);
  expect(res.reports.join(' ')).toMatch(/Render finished/);
  await expectNoErrors(errors);
});

test('Path tracer: a fixed seed repeats the noise, another seed changes it', async ({ page }) => {
  const errors = await start(page);
  const run = (seed: number) => render(page, { engine: 'PATHTRACE', use_denoising: false, cycles: { use_adaptive_sampling: false, seed } }).then((r) => r.mean);
  const a = await run(1);
  const b = await run(1);
  const c = await run(2);
  expect(b).toBeCloseTo(a, 6);
  expect(c).not.toBeCloseTo(a, 6);
  await expectNoErrors(errors);
});

test('Output: swap dimensions, shutter curve presets and stereo renders', async ({ page }) => {
  const errors = await start(page);
  const props = page.locator('.properties').first();
  await props.locator('.rail-tab[data-tab="OUTPUT"]').click();
  await props.locator('.btn.out-swap').click();
  expect(await page.evaluate(() => [(window as any).app.doc.scene.render.resolution_x, (window as any).app.doc.scene.render.resolution_y])).toEqual([1080, 1920]);
  await page.evaluate(() => (window as any).app.run('ed.undo'));
  // shutter curve preset (Render ▸ Motion Blur ▸ Shutter Curve)
  await page.evaluate(() => (window as any).app.run('render.shutter_curve_preset', { shape: 'SHARP' }));
  const curve = await page.evaluate(() => (window as any).app.doc.scene.render.motion_blur_shutter_curve);
  expect(curve[0]).toEqual([0, 0]);
  expect(Math.max(...curve.map((p: number[]) => p[1]))).toBe(1);
  // stereoscopy panel: enabling it renders two eyes
  const stereo = props.locator('[data-panel="out-stereo"]');
  await stereo.locator('> .panel-header .checkbox').click();
  await stereo.locator('> .panel-header .ph-title').click();
  await expect(stereo.locator('.uilist .ul-row')).toHaveCount(2);
  const res = await render(page, { image_views_format: 'STEREO_3D' });
  expect(res.views).toEqual(['left', 'right']);
  expect(res.stereo).toBe(true);
  // the Image Editor offers the eyes and the combined stereo image
  const viewMenu = page.locator('.ie-header .enum-menu[data-id="ie-view"], [data-id="ie-view"]').first();
  await expect(viewMenu).toBeVisible();
  await viewMenu.dispatchEvent('pointerdown');
  await expect(page.locator('.menu .menu-item', { hasText: 'Stereo 3D' })).toBeVisible();
  await page.locator('.menu .menu-item', { hasText: 'Stereo 3D' }).click();
  await expect(viewMenu).toHaveText(/Stereo 3D/);
  // Window ▸ Set Stereo 3D changes how the eyes are combined
  await page.evaluate(() => (window as any).app.run('wm.set_stereo_3d', { display_mode: 'SIDEBYSIDE' }, { invoke: false }));
  const width = await page.evaluate(async (imp) => {
    const { stereoResult } = await (0, eval)(imp)('/src/render/final/stereo.ts');
    const { stereoDisplay } = await (0, eval)(imp)('/src/render/final/stereoops.ts');
    const { renderResult } = await (0, eval)(imp)('/src/render/final/result.ts');
    return stereoResult(renderResult.get(), stereoDisplay).width;
  }, IMPORT);
  expect(width).toBe(res.width * 2);
  await expectNoErrors(errors);
});

test('Panoramic camera renders with the path tracer; camera and light panels', async ({ page }) => {
  const errors = await start(page);
  await page.evaluate(() => {
    const a = (window as any).app,
      d = a.doc;
    const cam = d.objects[d.scene.camera];
    d.cameras[cam.data].type = 'PANO';
    for (const o of Object.values(d.objects) as any[]) o.select = false;
    cam.select = true;
    d.scene.active_object = cam.id;
    a.changed('doc', 'select');
  });
  const props = page.locator('.properties').first();
  await props.locator('.rail-tab[data-tab="DATA"]').click();
  await expect(props.locator('.split-row', { hasText: 'Panorama Type' })).toBeVisible();
  await page.evaluate(() => {
    (window as any).bpy.data.cameras[0].panorama_type = 'EQUIRECTANGULAR';
  });
  const res = await render(page, { engine: 'PATHTRACE', resolution_x: 400, resolution_y: 200 });
  expect(res.mean).toBeGreaterThan(0);
  // light: temperature and exposure tint the light
  await page.evaluate(() => {
    const a = (window as any).app,
      d = a.doc;
    const L = Object.values(d.objects).find((o: any) => o.type === 'LIGHT') as any;
    for (const o of Object.values(d.objects) as any[]) o.select = false;
    L.select = true;
    d.scene.active_object = L.id;
    a.changed('doc', 'select');
  });
  await expect(props.locator('.split-row', { hasText: 'Temperature' })).toBeVisible();
  await expect(props.locator('.split-row', { hasText: 'Exposure' })).toBeVisible();
  await props.locator('.split-row', { hasText: 'Temperature' }).locator('.checkbox').click();
  expect(await page.evaluate(() => (window as any).bpy.data.lights[0].use_temperature)).toBe(true);
  await expectNoErrors(errors);
});

test('World: new world and converting the world volume to a mesh', async ({ page }) => {
  const errors = await start(page);
  const n0 = await page.evaluate(() => Object.keys((window as any).app.doc.worlds).length);
  await page.evaluate(() => (window as any).app.run('world.new'));
  expect(await page.evaluate(() => Object.keys((window as any).app.doc.worlds).length)).toBe(n0 + 1);
  await page.evaluate(() => {
    const a = (window as any).app,
      d = a.doc;
    const w = d.worlds[d.scene.world];
    const out = w.tree.nodes.find((n: any) => n.type === 'ShaderNodeOutputWorld');
    const id = 'node_fog';
    w.tree.nodes.push({ id, type: 'ShaderNodeVolumeScatter', name: 'Volume Scatter', location: [0, 0], inputs: { Density: 0.05 }, props: {} });
    w.tree.links.push({ id: 'link_fog', from_node: id, from_socket: 'Volume', to_node: out.id, to_socket: 'Volume' });
    a.changed('doc');
  });
  expect(await page.evaluate(() => (window as any).app.run('world.convert_volume_to_mesh'))).toBe('FINISHED');
  const r = await page.evaluate(() => {
    const d = (window as any).app.doc;
    const ob = Object.values(d.objects).find((o: any) => o.name === 'World Volume') as any;
    const ma = d.materials[d.meshes[ob.data].materials[0]];
    const w = d.worlds[d.scene.world];
    return {
      volumeOnMaterial: ma.tree.links.some((l: any) => l.to_socket === 'Volume'),
      worldHasVolume: w.tree.links.some((l: any) => l.to_socket === 'Volume'),
      scale: ob.scale[0],
    };
  });
  expect(r).toEqual({ volumeOnMaterial: true, worldHasVolume: false, scale: expect.any(Number) });
  expect(r.scale).toBeGreaterThanOrEqual(5);
  await expectNoErrors(errors);
});
