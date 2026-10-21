import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors, openHeaderMenu } from './helpers';

async function keyCube(page: Page, editor: string) {
  await page.evaluate(async (editor) => {
    const { shell } = await import('/src/ui/shell.ts');
    const { keyProperty } = await import('/src/anim/keyframes.ts');
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const cube = Object.values(app.doc.objects).find((o: any) => o.name === 'Cube') as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const [f, x] of [
      [1, 0],
      [21, 2],
    ]) {
      cube.location[0] = x;
      keyProperty(app.doc, cube, 'location', 0, f);
    }
    app.pushUndo('Keys');
    shell.screen.areas.find((a: { type: string }) => a.type === 'VIEW_3D').setType(editor);
    app.changed('doc');
  }, editor);
  await page.waitForTimeout(200);
}

const editorOf = (page: Page, type: string, fn: string) =>
  page.evaluate(
    async ([type, fn]) => {
      const { shell } = await import('/src/ui/shell.ts');
      const ed = shell.screen.areas.find((a: { type: string }) => a.type === type).editor;
      return new Function('ed', `return (${fn})(ed)`)(ed);
    },
    [type, fn] as const,
  );

test('graph editor: Auto-Lock Key Axis keeps a mostly horizontal move on its frame axis', async ({ page }) => {
  const errors = await openApp(page);
  await keyCube(page, 'GRAPH');
  const g = page.locator('.area[data-editor="GRAPH"]').first();
  await openHeaderMenu(page, g, 'View');
  await page.locator('.menu .menu-item', { hasText: 'Auto-Lock Key Axis' }).click();
  expect(await editorOf(page, 'GRAPH', '(ed) => ed.autoLockAxis')).toBe(true);
  // select the second key and move it with G: right by a lot, down by a little
  const pos = await editorOf(
    page,
    'GRAPH',
    `(ed) => { const fc = ed.list.curves[0].fc; fc.keyframe_points.forEach((k, i) => { k.select_control_point = i === 1; }); ed.draw(); const r = ed.canvas.getBoundingClientRect(); return { x: r.left + ed.view.width / 2, y: r.top + 200 }; }`,
  );
  await page.mouse.move(pos.x, pos.y);
  await page.keyboard.press('g');
  await page.mouse.move(pos.x + 120, pos.y + 15, { steps: 4 });
  await page.mouse.click(pos.x + 120, pos.y + 15);
  const co = await editorOf(page, 'GRAPH', '(ed) => ed.list.curves[0].fc.keyframe_points[1].co');
  expect(co[0]).toBeGreaterThan(21);
  expect(co[1]).toBeCloseTo(2, 6);
  await expectNoErrors(errors);
});

test('dope sheet: Playback Controls toggles the footer; Sync Visible Range follows the timeline', async ({ page }) => {
  const errors = await openApp(page);
  await keyCube(page, 'DOPESHEET');
  const ds = page.locator('.area[data-editor="DOPESHEET"]').first();
  await expect(ds.locator('.anim-footer')).toBeVisible();
  await openHeaderMenu(page, ds, 'View');
  await page.locator('.menu .menu-item', { hasText: 'Playback Controls' }).click();
  await expect(ds.locator('.anim-footer')).toBeHidden();
  // sync the visible range of the dope sheet and the timeline
  await openHeaderMenu(page, ds, 'View');
  await page.locator('.menu .menu-item', { hasText: 'Sync Visible Range' }).click();
  const tl = page.locator('.area[data-editor="TIMELINE"]').first();
  await openHeaderMenu(page, tl, 'View');
  await page.locator('.menu .menu-item', { hasText: 'Sync Visible Range' }).click();
  await editorOf(page, 'DOPESHEET', '(ed) => { ed.view.fitX(10, 30, 0); ed.draw(); }');
  await expect
    .poll(async () => {
      const r = await editorOf(page, 'TIMELINE', '(ed) => [ed.view.xf(0), ed.view.xf(ed.view.width)]');
      return r.map((x: number) => Math.round(x * 100) / 100);
    })
    .toEqual([10, 30]);
  await expectNoErrors(errors);
});

test('NLA: View menu toggles and the influence key button', async ({ page }) => {
  const errors = await openApp(page);
  await keyCube(page, 'NLA');
  await page.evaluate(async () => {
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    app.run('action.push_down');
    const { shell } = await import('/src/ui/shell.ts');
    const ed = shell.screen.areas.find((a: { type: string }) => a.type === 'NLA').editor;
    const strip = app.activeObject.animation_data.nla_tracks[0].strips[0];
    strip.select = true;
    ed.activeStrip = strip;
    ed.showSidebar = true;
    ed.sidebarTab = 'strip';
    ed.refresh();
    app.changed('ui');
  });
  const nla = page.locator('.area[data-editor="NLA"]').first();
  await openHeaderMenu(page, nla, 'View');
  await expect(page.locator('.menu .menu-item', { hasText: 'Show Control F-Curves' })).toBeVisible();
  await page.locator('.menu .menu-item', { hasText: 'Show Local Markers' }).click();
  expect(await editorOf(page, 'NLA', '(ed) => ed.showLocalMarkers')).toBe(false);
  // Animated Influence: on keys the strip start; the key button keys the current frame
  await nla.locator('[data-id="nla-use-infl"], .panel-header .checkbox').first().click();
  await page.evaluate(() => ((window as any).app.doc.scene.frame_current = 10)); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.evaluate(() => (window as any).app.changed('frame')); // eslint-disable-line @typescript-eslint/no-explicit-any
  await nla.locator('[data-tip^="Insert Keyframe"]').click();
  const keys = await page.evaluate(() => (window as any).app.activeObject.animation_data.nla_tracks[0].strips[0].fcurves[0].keyframe_points.map((k: any) => k.co[0])); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(keys).toEqual([1, 10]);
  await expectNoErrors(errors);
});
