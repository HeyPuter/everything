// Fluid domains in the Physics tab: modular baking from the panel buttons (with progress in the
// status bar), freeing, noise, and the viewport display options.
import { test, expect } from '@playwright/test';
import { openApp, expectNoErrors, type AppLike } from './helpers';

/** Quick Smoke on the default cube, the domain made active with a short cache range. */
async function smokeDomain(page: import('@playwright/test').Page, cacheType: 'REPLAY' | 'MODULAR' | 'ALL', end = 8) {
  return page.evaluate(
    ({ cacheType, end }) => {
      const a = (window as unknown as { app: AppLike }).app;
      a.run('object.quick_smoke', {}, { invoke: false });
      const dom = Object.values(a.doc.objects).find((o: { modifiers: { type: string; fluid_type?: string }[] }) => o.modifiers.some((m) => m.type === 'FLUID' && m.fluid_type === 'DOMAIN')) as { id: string; modifiers: Record<string, any>[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
      const m = dom.modifiers.find((x) => x.type === 'FLUID')!;
      m.domain_settings.cache_type = cacheType;
      m.domain_settings.resolution_max = 12;
      m.point_cache.frame_end = end;
      for (const o of Object.values(a.doc.objects) as { select: boolean; id: string }[]) o.select = o.id === dom.id;
      (a as unknown as { activeObject: unknown }).activeObject = dom;
      a.changed('doc');
      (window as unknown as { __propertiesTab?: string }).__propertiesTab = 'PHYSICS';
      a.changed('ui');
      return dom.id;
    },
    { cacheType, end },
  );
}

const domainState = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate(async (id) => {
    const a = (window as unknown as { app: AppLike }).app;
    const m = a.doc.objects[id].modifiers.find((x: { type: string }) => x.type === 'FLUID');
    const { caches } = await import('/src/physics/common.ts' as string);
    const { peekFluidLayers } = await import('/src/physics/fluidcache.ts' as string);
    const key = `FLUID:${id}:${m.id}`;
    return { data: !!m.domain_settings.has_cache_baked_data, noise: !!m.domain_settings.has_cache_baked_noise, frames: caches.get(key)?.frames.size ?? 0, noiseFrames: peekFluidLayers(key)?.noise.size ?? 0 };
  }, id);

test('modular gas cache: Bake Data and Bake Noise from the panel, then Free', async ({ page }) => {
  const errors = await openApp(page);
  const id = await smokeDomain(page, 'MODULAR');
  // nothing is simulated by playing a modular cache
  await page.evaluate(() => {
    const a = (window as unknown as { app: AppLike }).app;
    a.doc.scene.frame_current = 4;
    a.changed('frame');
    a.flush();
  });
  expect((await domainState(page, id)).frames).toBe(0);
  const bake = page.locator('[data-op="fluid.bake_data"]').first();
  await expect(bake).toBeVisible();
  await bake.click();
  await expect.poll(async () => (await domainState(page, id)).data, { timeout: 30000 }).toBe(true);
  expect((await domainState(page, id)).frames).toBe(8);
  // settings are locked while baked
  await expect(page.locator('[data-panel="ph-fl-settings"] .num-field').first()).toHaveClass(/disabled/);
  // noise: enable it in its header, then bake it from the baked data
  await page.locator('[data-panel="ph-fl-noise"] > .panel-header input[type="checkbox"], [data-panel="ph-fl-noise"] > .panel-header .checkbox').first().click();
  await page.locator('[data-panel="ph-fl-noise"] > .panel-header').first().click();
  const bakeNoise = page.locator('[data-op="fluid.bake_noise"]').first();
  await expect(bakeNoise).toBeVisible();
  await bakeNoise.click();
  await expect.poll(async () => (await domainState(page, id)).noise, { timeout: 30000 }).toBe(true);
  expect((await domainState(page, id)).noiseFrames).toBe(8);
  // Free Data frees everything derived from it
  await page.locator('[data-op="fluid.free_data"]').first().click();
  const s = await domainState(page, id);
  expect(s).toEqual({ data: false, noise: false, frames: 0, noiseFrames: 0 });
  await expectNoErrors(errors);
});

test('a running bake shows progress in the status bar and can be paused and resumed', async ({ page }) => {
  const errors = await openApp(page);
  const id = await smokeDomain(page, 'ALL', 60);
  await page.evaluate(() => {
    const a = (window as unknown as { app: AppLike }).app;
    const ob = a.activeObject!;
    const m = ob.modifiers.find((x: { type: string }) => x.type === 'FLUID');
    m.domain_settings.cache_resumable = true;
    m.domain_settings.resolution_max = 32;
    a.changed('doc');
  });
  await page.locator('[data-panel="ph-fl-cache"] > .panel-header').first().click();
  await page.locator('[data-op="fluid.bake_all"]').first().click();
  await expect(page.locator('.sb-job', { hasText: 'Fluid' })).toBeVisible();
  // the status bar redraws while baking: press its pause button directly
  await page.evaluate(() => (document.querySelector('.sb-job .sb-job-cancel') as HTMLElement).click());
  await expect(page.locator('.sb-job', { hasText: 'Fluid' })).toHaveCount(0);
  const paused = await page.evaluate((id) => {
    const a = (window as unknown as { app: AppLike }).app;
    const m = a.doc.objects[id].modifiers.find((x: { type: string }) => x.type === 'FLUID');
    return m.domain_settings.cache_frame_pause_data as number;
  }, id);
  expect(paused).toBeGreaterThan(0);
  expect(paused).toBeLessThan(60);
  // resume finishes the bake
  await page.locator('[data-op="fluid.bake_all"]').first().click();
  await expect.poll(async () => (await domainState(page, id)).data, { timeout: 60000 }).toBe(true);
  expect((await domainState(page, id)).frames).toBe(60);
  await expectNoErrors(errors);
});

test('viewport display: slice, grid display and vectors draw without errors', async ({ page }) => {
  const errors = await openApp(page);
  const id = await smokeDomain(page, 'REPLAY', 20);
  const r = await page.evaluate(async (id) => {
    const a = (window as unknown as { app: AppLike }).app;
    const m = a.doc.objects[id].modifiers.find((x: { type: string }) => x.type === 'FLUID');
    Object.assign(m.domain_settings, { use_slice: true, show_gridlines: true, use_color_ramp: true, color_ramp_field: 'HEAT', show_velocity: true, vector_display_type: 'STREAMLINE', display_interpolation: 'CUBIC' });
    a.doc.scene.frame_current = 12;
    a.changed('doc', 'frame');
    a.flush();
    await new Promise((res) => setTimeout(res, 300));
    const { fluidOverlays } = await import('/src/physics/fluidoverlay.ts' as string);
    const o = [...fluidOverlays.values()][0];
    return { overlay: !!o, vel: !!o?.vel };
  }, id);
  expect(r).toEqual({ overlay: true, vel: true });
  await page.locator('[data-panel="ph-fl-display"] > .panel-header').first().click();
  await page.locator('[data-panel="ph-fl-grid"] > .panel-header .ph-title').first().click();
  await expect(page.locator('[data-panel="ph-fl-grid"] .fs-ramp')).toBeVisible();
  await expectNoErrors(errors);
});

test('adaptive domain from its subpanel header; force field Z direction and radial falloff', async ({ page }) => {
  const errors = await openApp(page);
  const id = await smokeDomain(page, 'REPLAY');
  const adaptive = page.locator('[data-panel="ph-fl-adaptive"]');
  await expect(adaptive).toBeVisible();
  await adaptive.locator('> .panel-header input[type="checkbox"], > .panel-header .checkbox').first().click();
  expect(await page.evaluate((id) => (window as unknown as { app: AppLike }).app.doc.objects[id].modifiers.find((x: { type: string }) => x.type === 'FLUID').domain_settings.use_adaptive_domain, id)).toBe(true);
  // a tube force field on the default cube shows its Radial subpanel
  await page.evaluate(() => {
    const a = (window as unknown as { app: AppLike }).app;
    const cube = Object.values(a.doc.objects).find((o: { name: string }) => o.name === 'Cube') as { select: boolean };
    for (const o of Object.values(a.doc.objects) as { select: boolean }[]) o.select = false;
    cube.select = true;
    (a as unknown as { activeObject: unknown }).activeObject = cube;
    a.run('object.forcefield_toggle');
    (a.activeObject as unknown as { field: { falloff_type: string } }).field.falloff_type = 'TUBE';
    a.changed('doc');
  });
  const falloff = page.locator('[data-panel="ph-field-falloff"]');
  if (!(await page.locator('[data-panel="ph-field-radial"]').isVisible())) await falloff.locator('> .panel-header').first().click();
  await expect(page.locator('[data-panel="ph-field-radial"]')).toBeVisible();
  await expect(falloff.getByText('Z Direction')).toBeVisible();
  await expect(page.locator('[data-panel="ph-field"]').getByText('Wind Factor')).toBeVisible();
  await expectNoErrors(errors);
});
