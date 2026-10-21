// UI list operators (add / move / remove, focus), Properties editor background menu and pinning,
// path field browse operators.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const run = (page: Page, op: string, props: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) =>
  page.evaluate(([o, p, x]) => {
    const a = (window as any).app;
    return a.run(o, p, { area: a.hoverArea, ...x });
  }, [op, props, opts] as const);

test('uilist entry operators act on the list under the pointer or a named list', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.rail-tab[data-tab="DATA"]').click();
  const list = page.locator('.uilist[data-list="vg"]');
  await expect(list).toBeVisible();
  const box = (await list.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 10);
  await run(page, 'uilist.entry_add');
  await run(page, 'uilist.entry_add');
  const groups = () => page.evaluate(() => (window as any).app.activeObject && Object.values((window as any).app.doc.meshes as Record<string, any>).find((m: any) => m.id === (window as any).app.activeObject.data).vertex_groups.map((g: any) => g.name));
  expect(await groups()).toEqual(['Group', 'Group.001']);
  // the second (active) group moves up; named list works without hovering
  await page.mouse.move(5, 5);
  await run(page, 'uilist.entry_move', { list_path: 'vg', direction: 'UP' });
  expect(await groups()).toEqual(['Group.001', 'Group']);
  await page.mouse.move(box.x + 30, box.y + 10);
  await run(page, 'uilist.entry_remove');
  expect((await groups()).length).toBe(1);
  // focus / scroll / filter on the hovered list
  expect(await run(page, 'ui.view_item_focus')).toBe('FINISHED');
  await run(page, 'ui.view_start_filter');
  await expect(list.locator('.ul-filter-text input')).toBeFocused();
  await expectNoErrors(errors);
});

test('Properties background menu pins the object; path fields browse', async ({ page }) => {
  const errors = await openApp(page);
  const props = page.locator('.area[data-editor="PROPERTIES"]');
  await page.locator('.rail-tab[data-tab="OBJECT"]').click();
  // right-click on empty space under the panels
  const pb = (await props.locator('.prop-body').boundingBox())!;
  await page.mouse.click(pb.x + pb.width / 2, pb.y + pb.height - 6, { button: 'right' });
  await expect(page.locator('.menu .menu-item', { hasText: 'Pin ID' })).toBeVisible();
  await page.locator('.menu .menu-item', { hasText: 'Pin ID' }).click();
  await expect(props.locator('.prop-pin.on')).toHaveCount(1);
  await page.mouse.move(pb.x + 20, pb.y + 20);
  await run(page, 'buttons.toggle_pin');
  await expect(props.locator('.prop-pin.on')).toHaveCount(0);
  // a path field in the Output tab takes a browsed path
  await page.locator('.rail-tab[data-tab="OUTPUT"]').click();
  const value0 = await page.evaluate(() => (window as any).app.doc.scene.render.filepath);
  const inputs = props.locator('.text-field');
  const n = await inputs.count();
  let done = false;
  for (let i = 0; i < n && !done; i++) {
    const v = await inputs.nth(i).locator('input').inputValue();
    if (v !== value0) continue;
    const b = (await inputs.nth(i).boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    expect(await run(page, 'buttons.directory_browse', { directory: '//frames/' }, { invoke: true })).toBe('FINISHED');
    done = true;
  }
  expect(done).toBe(true);
  expect(await page.evaluate(() => (window as any).app.doc.scene.render.filepath)).toBe('//frames/');
  await expectNoErrors(errors);
});

test('K over a property adds it to the keying set, Alt K removes it', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.rail-tab[data-tab="OBJECT"]').click();
  const field = page.locator('.area[data-editor="PROPERTIES"] .num-field').first();
  const b = (await field.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.keyboard.press('k');
  const paths = () => page.evaluate(() => {
    const sc = (window as any).app.doc.scene;
    const ks = (sc.keying_sets ?? [])[sc.active_keying_set_index ?? 0] ?? (sc.keying_sets ?? [])[0];
    return (ks?.paths ?? []).map((p: any) => p.data_path);
  });
  await expect.poll(paths).toContain('location');
  await page.keyboard.press('Alt+k');
  await expect.poll(paths).not.toContain('location');
  await expectNoErrors(errors);
});
