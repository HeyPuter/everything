import { test, expect } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

test('dope sheet Mask mode: shape keys as keys, select all and delete', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const { shell } = await import('/src/ui/shell.ts');
    const { maskTable } = await import('/src/mask/types.ts');
    const app = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const layer = (name: string, frames: number[]) => ({
      name,
      splines: [{ use_cyclic: true, use_fill: true, points: [{ co: [0, 0], handle_left: [0, 0], handle_right: [0, 0], handle_left_type: 'AUTO', handle_right_type: 'AUTO', weight: 1 }] }],
      alpha: 1,
      blend: 'MERGE_ADD',
      invert: false,
      falloff: 'SMOOTH',
      hide: false,
      hide_render: false,
      hide_select: false,
      active_spline: 0,
      shape_keys: frames.map((frame) => ({ frame, data: [frame, 0, 0, 0, 0, 0, 1] })),
    });
    maskTable(app.doc).mk1 = { id: 'mk1', name: 'Mask', layers: [layer('MaskLayer', [1, 10]), layer('Second', [5])], active_layer_index: 0, frame_start: 1, frame_end: 250 };
    app.pushUndo('Mask');
    shell.screen.areas.find((a: { type: string }) => a.type === 'VIEW_3D').setType('DOPESHEET');
    app.changed('doc');
  });
  const ds = page.locator('.area[data-editor="DOPESHEET"]').first();
  await ds.locator('.hdr-mode').dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: /^Mask/ }).click();
  await expect(ds.locator('.anim-ch-row.k-mask')).toHaveCount(1);
  // the Mask mode has no Channel menu
  await expect(ds.locator('.hdr-menu', { hasText: 'Channel' })).toHaveCount(0);
  await ds.locator('.anim-ch-row.k-mask .anim-exp').dispatchEvent('pointerdown');
  await expect(ds.locator('.anim-ch-row.k-mask_layer')).toHaveText([/Second/, /MaskLayer/]);
  // select every key and delete them
  const box = (await ds.locator('canvas').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('a');
  await page.keyboard.press('Delete');
  await expect
    .poll(() => page.evaluate(() => Object.values((window as any).app.doc.masks).flatMap((m: any) => m.layers.flatMap((l: any) => l.shape_keys)).length)) // eslint-disable-line @typescript-eslint/no-explicit-any
    .toBe(0);
  // undo brings the shape keys back
  await page.keyboard.press('Control+z');
  await expect
    .poll(() => page.evaluate(() => Object.values((window as any).app.doc.masks).flatMap((m: any) => m.layers.flatMap((l: any) => l.shape_keys)).length)) // eslint-disable-line @typescript-eslint/no-explicit-any
    .toBe(3);
  await expectNoErrors(errors);
});
