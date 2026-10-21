// Outliner: Scroll to Active follows the active object.
import { test, expect } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
test('Scroll to Active brings a newly active object into view', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as any).app;
    for (let i = 0; i < 40; i++) a.run('mesh.primitive_cube_add', { location: [i, 0, 0] }, { invoke: false });
  });
  const ol = page.locator('.area[data-editor="OUTLINER"]');
  // the option is off by default
  await ol.locator('.area-header button').filter({ has: page.locator('[data-icon="filter"]') }).first().click();
  const opt = page.locator('.olf-check', { hasText: 'Scroll to Active' });
  await expect(opt).toBeVisible();
  await opt.locator('.checkbox').click();
  await page.keyboard.press('Escape');
  const scroller = () =>
    page.evaluate(() => {
      const el = document.querySelector('.area[data-editor="OUTLINER"] .ol-scroll, .area[data-editor="OUTLINER"] .area-main > *') as HTMLElement;
      const all = [...document.querySelectorAll<HTMLElement>('.area[data-editor="OUTLINER"] *')].find((e) => e.scrollHeight > e.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
      return (all ?? el)?.scrollTop ?? 0;
    });
  // make the first cube active: the list scrolls up to it
  await page.evaluate(() => {
    const a = (window as any).app;
    const first = Object.values(a.doc.objects as Record<string, any>).find((o: any) => o.name === 'Cube.001') as any;
    for (const o of Object.values(a.doc.objects as Record<string, any>)) (o as any).select = false;
    first.select = true;
    a.doc.scene.active_object = first.id;
    a.changed('select');
  });
  await page.waitForTimeout(300);
  const top1 = await scroller();
  await page.evaluate(() => {
    const a = (window as any).app;
    const last = Object.values(a.doc.objects as Record<string, any>).find((o: any) => o.name === 'Cube.040') as any;
    a.doc.scene.active_object = last.id;
    a.changed('select');
  });
  await page.waitForTimeout(300);
  expect(await scroller()).toBeGreaterThan(top1);
  await expectNoErrors(errors);
});
