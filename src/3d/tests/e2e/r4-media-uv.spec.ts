import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** UV Editing workspace with every face selected (UVs shown and selected). */
async function uvWorkspace(page: Page) {
  const errors = await openApp(page);
  await page.locator('.ws-tab', { hasText: 'UV Editing' }).first().click();
  await page.waitForTimeout(300);
  const v3 = (await page.locator('.view3d').first().boundingBox())!;
  await page.mouse.move(v3.x + v3.width / 2, v3.y + v3.height / 2);
  await page.keyboard.press('a');
  const box = (await page.locator('.uv-editor').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('a');
  return { errors, box };
}

const meshUVs = (page: Page) => page.evaluate(() => Array.from((window as any).app.doc.meshes[(window as any).app.activeObject.data].uvs as Float32Array) as number[]);
const bounds = (uvs: number[]) => {
  const us = uvs.filter((_, i) => i % 2 === 0),
    vs = uvs.filter((_, i) => i % 2 === 1);
  return [Math.min(...us), Math.min(...vs), Math.max(...us), Math.max(...vs)];
};
const uvEd = (page: Page) => page.evaluate(() => {
  const e = (window as any).app.hoverArea.editor;
  return { overlays: e.showOverlays, edges: e.edgeDisplay, tool: e.tool };
});

function uvPoint(page: Page, u: number, v: number) {
  return page.evaluate(
    ([u, v]) => {
      const ed = document.querySelector('.uv-editor')!;
      const p = (window as any).app.hoverArea.editor.toPx(u, v);
      const r = ed.getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    },
    [u, v],
  );
}

test('UV editor: overlays toggle and popover, edge display', async ({ page }) => {
  const { errors, box } = await uvWorkspace(page);
  await page.keyboard.press('Shift+Alt+z');
  expect((await uvEd(page)).overlays).toBe(false);
  await page.keyboard.press('Shift+Alt+z');
  expect((await uvEd(page)).overlays).toBe(true);
  await page.evaluate(() => {
    const a = (window as any).app.hoverArea;
    a.editor.showToolbar = false;
    a.editor.drawUI();
  });
  // the header can be narrow: open the popover from its button wherever it is
  await page.locator('.uv-overlays').first().scrollIntoViewIfNeeded();
  await page.locator('.uv-overlays').first().dispatchEvent('pointerdown');
  await page.locator('.popup-layer .enum-row button', { hasText: 'Dash' }).first().click();
  expect((await uvEd(page)).edges).toBe('DASH');
  await page.keyboard.press('Escape');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expectNoErrors(errors);
});

test('UV editor: Transform tool moves inside the frame, scales from a corner, scales one axis from a side', async ({ page }) => {
  const { errors, box } = await uvWorkspace(page);
  await page.evaluate(() => (window as any).app.hoverArea.editor.setTool('transform'));
  const b0 = bounds(await meshUVs(page));
  const f = await page.evaluate(() => {
    const e = (window as any).app.hoverArea.editor;
    const r = e.el.getBoundingClientRect();
    const fr = e.selectionFrame();
    return { x0: r.left + fr.x0, y0: r.top + fr.y0, x1: r.left + fr.x1, y1: r.top + fr.y1 };
  });
  // drag inside: move
  const cx = (f.x0 + f.x1) / 2,
    cy = (f.y0 + f.y1) / 2 + 20;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 20, cy, { steps: 3 });
  await page.mouse.move(cx + 40, cy, { steps: 3 });
  await page.mouse.up();
  const b1 = bounds(await meshUVs(page));
  expect(b1[0] - b0[0]).toBeGreaterThan(0.02);
  expect(b1[2] - b1[0]).toBeCloseTo(b0[2] - b0[0], 4);
  // drag the right side handle outwards: wider, same height
  const g = await page.evaluate(() => {
    const e = (window as any).app.hoverArea.editor;
    const r = e.el.getBoundingClientRect();
    const fr = e.selectionFrame();
    return { x: r.left + fr.x1, y: r.top + (fr.y0 + fr.y1) / 2 };
  });
  expect(await page.evaluate(([x, y]) => {
    const e = (window as any).app.hoverArea.editor;
    const r = e.el.getBoundingClientRect();
    return e.transformPart({ x: x - r.left, y: y - r.top });
  }, [g.x, g.y] as const)).toBe('SIDE_X');
  await page.mouse.move(g.x, g.y);
  await page.mouse.down();
  await page.mouse.move(g.x + 30, g.y, { steps: 3 });
  await page.mouse.move(g.x + 60, g.y, { steps: 3 });
  await page.mouse.up();
  const b2 = bounds(await meshUVs(page));
  expect(b2[2] - b2[0]).toBeGreaterThan((b1[2] - b1[0]) * 1.05);
  expect(b2[3] - b2[1]).toBeCloseTo(b1[3] - b1[1], 4);
  await page.mouse.move(box.x + 5, box.y + 5);
  await expectNoErrors(errors);
});

test('UV editor: Ctrl B sets a user region, Pack Islands fills it; Constrain to Image Bounds and pixel rounding', async ({ page }) => {
  const { errors, box } = await uvWorkspace(page);
  // drag a region from (0.5, 0.5) to (0.9, 0.7)
  await page.keyboard.press('Control+b');
  const a = await uvPoint(page, 0.5, 0.7),
    b = await uvPoint(page, 0.9, 0.5);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 3 });
  await page.mouse.move(b.x, b.y, { steps: 3 });
  await page.mouse.up();
  const reg = await page.evaluate(() => (window as any).app.doc.scene.tool_settings.uv_custom_region);
  expect(reg[0]).toBeCloseTo(0.5, 2);
  expect(reg[3]).toBeCloseTo(0.7, 2);
  expect(await page.evaluate(() => (window as any).app.doc.scene.tool_settings.use_uv_custom_region)).toBe(true);
  await page.evaluate(() => (window as any).app.run('uv.pack_islands', { udim_source: 'CUSTOM_REGION', margin: 0 }, { invoke: false }));
  const p = bounds(await meshUVs(page));
  expect(p[0]).toBeGreaterThanOrEqual(0.5 - 1e-3);
  expect(p[2]).toBeLessThanOrEqual(0.9 + 1e-3);
  expect(p[1]).toBeGreaterThanOrEqual(0.5 - 1e-3);
  expect(p[3]).toBeLessThanOrEqual(0.7 + 1e-3);
  // Ctrl Alt B turns the region off
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Control+Alt+b');
  expect(await page.evaluate(() => (window as any).app.doc.scene.tool_settings.use_uv_custom_region)).toBe(false);
  // with image bounds locked, a big move stops at the edge of the square
  await page.evaluate(() => {
    const e = (window as any).app.hoverArea.editor;
    e.lockBounds = true;
    (window as any).app.run('uv.translate', { value: [5, 0] }, { invoke: false });
  });
  const q = bounds(await meshUVs(page));
  expect(q[2]).toBeCloseTo(1, 4);
  expect(q[2] - q[0]).toBeCloseTo(p[2] - p[0], 4);
  // pixel rounding (256 px without an image): moved UVs land on pixel corners
  await page.evaluate(() => {
    const e = (window as any).app.hoverArea.editor;
    e.lockBounds = false;
    e.pixelRoundMode = 'CORNER';
    (window as any).app.run('uv.translate', { value: [-0.3013, -0.0021] }, { invoke: false });
  });
  for (const x of await meshUVs(page)) expect(Math.abs(x * 256 - Math.round(x * 256))).toBeLessThan(1e-3);
  await expectNoErrors(errors);
});
