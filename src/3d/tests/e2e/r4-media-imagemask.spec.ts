import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The 3D viewport turned into an Image Editor showing a generated 512×512 image. */
async function imageEditor(page: Page) {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const { shell } = await import('/src/ui/shell.ts' as any);
    const app = (window as any).app;
    app.run('image.new', { name: 'Img', width: 512, height: 512, generated_type: 'BLANK' }, { invoke: false });
    const area = shell.screen.areas.find((a: any) => a.type === 'VIEW_3D');
    area.setType('IMAGE_EDITOR');
    const id = Object.keys(app.doc.images).pop();
    area.editor.showImage(id);
  });
  await page.waitForTimeout(200);
  const el = page.locator('.ie-root').first();
  const box = (await el.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return { errors, el, box };
}

const ed = (page: Page) => page.evaluate(() => {
  const e = (window as any).app.hoverArea.editor;
  return { mode: e.uiMode, mask: e.maskId, tool: e.maskTool, cursor: e.cursor };
});

/** Screen position of a frame-space point (0..1, y up) of the hovered image editor. */
const screenOf = (page: Page, u: number, v: number) =>
  page.evaluate(([u, v]) => {
    const e = (window as any).app.hoverArea.editor;
    const [W, H] = e.frameSize();
    const [x, y] = e.toScreen(u * W, (1 - v) * H);
    const r = e.el.getBoundingClientRect();
    return { x: r.left + x, y: r.top + y };
  }, [u, v] as const);

const points = (page: Page) =>
  page.evaluate(() => {
    const app = (window as any).app;
    const e = app.hoverArea.editor;
    const m = app.doc.masks[e.maskId];
    return m ? m.layers.flatMap((l: any) => l.splines.flatMap((s: any) => s.points.map((p: any) => ({ co: p.co.map((x: number) => Math.round(x * 1000) / 1000), select: p.select })))) : [];
  });

test('image editor: Mask mode creates a mask, adds shapes with tools and edits points', async ({ page }) => {
  const { errors, box } = await imageEditor(page);
  // switch the editor to Mask mode from the header
  await page.locator('.ie-mode').click();
  await page.locator('.popup-layer .menu-item', { hasText: /^Mask$/ }).click();
  expect((await ed(page)).mode).toBe('MASK');
  // the mask keymap is active: Alt N creates a mask
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Alt+n');
  const s = await ed(page);
  expect(s.mask).toBeTruthy();
  // Circle tool: clicking adds a circle centred where clicked
  await page.locator('[data-tool="mask-add_circle"]').click();
  const c = await screenOf(page, 0.3, 0.6);
  await page.mouse.click(c.x, c.y);
  let pts = await points(page);
  expect(pts.length).toBe(4);
  const cx = pts.reduce((a: number, p: any) => a + p.co[0], 0) / 4;
  const cy = pts.reduce((a: number, p: any) => a + p.co[1], 0) / 4;
  expect(cx).toBeCloseTo(0.3, 2);
  expect(cy).toBeCloseTo(0.6, 2);
  // Select Box tool: click on empty space deselects, clicking a point selects it
  await page.locator('[data-tool="mask-select_box"]').click();
  const empty = await screenOf(page, 0.9, 0.1);
  await page.mouse.click(empty.x, empty.y);
  expect((await points(page)).every((p: any) => !p.select)).toBe(true);
  const p0 = await screenOf(page, pts[0].co[0], pts[0].co[1]);
  await page.mouse.click(p0.x, p0.y);
  pts = await points(page);
  expect(pts.filter((p: any) => p.select).length).toBe(1);
  // G moves the selected point with the mouse
  const before = pts.find((p: any) => p.select).co;
  await page.mouse.move(p0.x, p0.y);
  await page.keyboard.press('g');
  await page.mouse.move(p0.x + 40, p0.y, { steps: 4 });
  await page.mouse.click(p0.x + 40, p0.y);
  const after = (await points(page)).find((p: any) => p.select).co;
  expect(after[0]).toBeGreaterThan(before[0] + 0.02);
  expect(after[1]).toBeCloseTo(before[1], 2);
  // Move tool: dragging moves the selection back
  await page.locator('[data-tool="mask-move"]').click();
  await page.mouse.move(p0.x + 100, p0.y + 60);
  await page.mouse.down();
  await page.mouse.move(p0.x + 80, p0.y + 60, { steps: 3 });
  await page.mouse.move(p0.x + 60, p0.y + 60, { steps: 3 });
  await page.mouse.up();
  const moved = (await points(page)).find((p: any) => p.select).co;
  expect(moved[0]).toBeLessThan(after[0] - 0.02);
  // Cursor tool places the 2D cursor
  await page.locator('[data-tool="mask-cursor"]').click();
  const q = await screenOf(page, 0.75, 0.25);
  await page.mouse.click(q.x, q.y);
  const cur = (await ed(page)).cursor;
  expect(cur[0]).toBeCloseTo(0.75, 2);
  expect(cur[1]).toBeCloseTo(0.25, 2);
  // Square from the Add menu goes to the cursor
  await page.evaluate(() => (window as any).app.run('mask.primitive_square_add'));
  expect((await points(page)).length).toBe(8);
  await expectNoErrors(errors);
});

test('image editor: Mask mode lasso tool, sidebar Mask tab and mode persistence', async ({ page }) => {
  const { errors, box } = await imageEditor(page);
  await page.evaluate(() => {
    const app = (window as any).app;
    const e = app.hoverArea.editor;
    e.setMode('MASK');
    app.run('mask.new');
    app.run('mask.primitive_square_add', { size: 0.4, location: [0.5, 0.5] }, { invoke: false });
    app.run('mask.select_all', { action: 'DESELECT' });
    e.maskTool = 'select_lasso';
    e.showSidebar = true;
    e.sidebarTab = 'Mask';
    e.drawUI();
  });
  // lasso around the left half of the square selects its two left corners
  const pts = [await screenOf(page, 0.2, 0.2), await screenOf(page, 0.45, 0.2), await screenOf(page, 0.45, 0.8), await screenOf(page, 0.2, 0.8)];
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (const p of [...pts.slice(1), pts[0]]) await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.up();
  const sel = (await points(page)).filter((p: any) => p.select);
  expect(sel.length).toBe(2);
  expect(sel.every((p: any) => p.co[0] < 0.5)).toBe(true);
  await expect(page.locator('.ie-sidebar .panel-header', { hasText: 'Mask Layers' }).first()).toBeVisible();
  // the mode and mask survive serialization
  const st = await page.evaluate(() => (window as any).app.hoverArea.editor.serialize());
  expect(st.mode).toBe('MASK');
  expect(st.mask).toBeTruthy();
  await page.mouse.move(box.x + 10, box.y + 10);
  await expectNoErrors(errors);
});

test('mask: proportional editing (O) moves nearby points by a falloff; the redo panel keeps it', async ({ page }) => {
  const { errors, box } = await imageEditor(page);
  await page.evaluate(() => {
    const app = (window as any).app;
    const e = app.hoverArea.editor;
    e.setMode('MASK');
    app.run('mask.new');
    app.run('mask.primitive_square_add', { size: 0.4, location: [0.5, 0.5] }, { invoke: false });
    app.run('mask.select_all', { action: 'DESELECT' });
    const m = app.doc.masks[e.maskId];
    m.layers[0].splines[0].points[0].select = true;
    app.doc.scene.tool_settings.proportional_size = 0.5;
    app.doc.scene.tool_settings.proportional_edit_falloff = 'LINEAR';
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('o');
  expect(await page.evaluate(() => (window as any).app.doc.scene.tool_settings.use_proportional_edit_mask)).toBe(true);
  const before = await points(page);
  await page.evaluate(() => (window as any).app.run('mask.transform', { mode: 'TRANSLATE', value: [0.1, 0, 0], use_proportional_edit: true, proportional_size: 0.5, proportional_edit_falloff: 'LINEAR' }, { invoke: false }));
  const after = await points(page);
  const dx = after.map((p: any, i: number) => Math.round((p.co[0] - before[i].co[0]) * 1000) / 1000);
  // the selected corner moves fully, its two neighbours (0.4 away) by (1 - 0.4 / 0.5) = 0.2, the far one (0.566 away) not at all
  expect(dx[0]).toBeCloseTo(0.1, 3);
  expect(dx.filter((d: number) => Math.abs(d - 0.02) < 2e-3).length).toBe(2);
  expect(dx.filter((d: number) => d === 0).length).toBe(1);
  await expectNoErrors(errors);
});

test('mask: the frame strip of the Mask mode scrubs frames', async ({ page }) => {
  const { errors } = await imageEditor(page);
  const r = await page.evaluate(() => {
    const app = (window as any).app;
    const e = app.hoverArea.editor;
    e.setMode('MASK');
    app.run('mask.new');
    const m = app.doc.masks[e.maskId];
    m.frame_start = 1;
    m.frame_end = 100;
    e.showToolbar = false;
    e.drawUI();
    e.draw();
    const b = e.el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
  await page.mouse.move(r.x + r.w * 0.25, r.y + r.h - 4);
  await page.mouse.down();
  await page.mouse.move(r.x + r.w * 0.5 + 1, r.y + r.h - 4, { steps: 3 });
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).app.doc.scene.frame_current)).toBe(51);
  await expectNoErrors(errors);
});

test('image editor: text stored in a PNG shows as metadata', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const U = (p: string) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(p)) ?? p;
    const { shell } = await import(U('/src/ui/shell.ts'));
    const { pngWithText } = await import(U('/src/render/final/stamp.ts'));
    const app = (window as any).app;
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    c.getContext('2d')!.fillRect(0, 0, 8, 8);
    const png = new Uint8Array(await (await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'))).arrayBuffer());
    const bytes = pngWithText(png, [['Camera', 'Shot Cam'], ['Frame', '42']]);
    app.doc.images.IMmeta = { id: 'IMmeta', name: 'meta.png', mime: 'image/png', bytes, width: 16, height: 16, source: 'FILE', colorspace: 'sRGB' };
    const area = shell.screen.areas.find((a: any) => a.type === 'VIEW_3D');
    area.setType('IMAGE_EDITOR');
    area.editor.showImage('IMmeta');
    area.editor.showSidebar = true;
    area.editor.sidebarTab = 'Image';
    area.editor.drawUI();
  });
  await expect(page.locator('.ie-meta').first()).toContainText('Camera: Shot Cam | Frame: 42');
  await expect(page.locator('.ie-sidebar .panel-header', { hasText: 'Metadata' }).first()).toBeVisible();
  await expectNoErrors(errors);
});

test('image editor: navigation buttons zoom and pan; Ctrl ` hides them', async ({ page }) => {
  const { errors, box } = await imageEditor(page);
  const z0 = await page.evaluate(() => (window as any).app.hoverArea.editor.zoom);
  const zb = (await page.locator('.ie-root .nav2d-zoom').boundingBox())!;
  await page.mouse.move(zb.x + zb.width / 2, zb.y + zb.height / 2);
  await page.mouse.down();
  await page.mouse.move(zb.x + zb.width / 2 + 30, zb.y + zb.height / 2 - 30, { steps: 4 });
  await page.mouse.up();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const z1 = await page.evaluate(() => (window as any).app.hoverArea.editor.zoom);
  expect(z1).toBeGreaterThan(z0 * 1.2);
  const pb = (await page.locator('.ie-root .nav2d-pan').boundingBox())!;
  const off0 = await page.evaluate(() => (window as any).app.hoverArea.editor.offX);
  await page.mouse.move(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await page.mouse.down();
  await page.mouse.move(pb.x + pb.width / 2 - 40, pb.y + pb.height / 2, { steps: 4 });
  await page.mouse.up();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  expect(await page.evaluate(() => (window as any).app.hoverArea.editor.offX)).not.toBe(off0);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Control+Backquote');
  await expect(page.locator('.ie-root .nav2d')).toHaveCount(0);
  await expectNoErrors(errors);
});

test('image editor: an image sequence shows the frame of the scene frame; start, offset, cyclic and Match Movie Length', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const U = (p: string) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(p)) ?? p;
    const { shell } = await import(U('/src/ui/shell.ts'));
    const M = await import(U('/src/render/final/imagemedia.ts'));
    const colors = ['#ff0000', '#00ff00', '#0000ff'];
    const files: File[] = [];
    for (let i = 0; i < colors.length; i++) {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const g = c.getContext('2d')!;
      g.fillStyle = colors[i];
      g.fillRect(0, 0, 8, 8);
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
      files.push(new File([blob], `frame_${String(i + 1).padStart(4, '0')}.png`, { type: 'image/png' }));
    }
    const id = await M.openMediaFiles(files);
    const area = shell.screen.areas.find((a: any) => a.type === 'VIEW_3D');
    area.setType('IMAGE_EDITOR');
    area.editor.showImage(id);
    (window as any).__ie = area.editor;
  });
  const colorAt = async (frame: number) => {
    await page.evaluate((f) => (window as any).app.setFrame(f), frame);
    // decoding is asynchronous
    await page.waitForTimeout(150);
    return page.evaluate(() => {
      const ed = (window as any).__ie;
      ed.draw();
      const c = ed.displayCanvas();
      const p = c.getContext('2d').getImageData(4, 4, 1, 1).data;
      return [p[0], p[1], p[2], p[3]];
    });
  };
  expect(await colorAt(1)).toEqual([255, 0, 0, 255]);
  expect(await colorAt(2)).toEqual([0, 255, 0, 255]);
  expect(await colorAt(3)).toEqual([0, 0, 255, 255]);
  // past the end: nothing shown; cyclic wraps around
  expect((await colorAt(4))[3]).toBe(0);
  await page.evaluate(() => ((window as any).__ie.image.media.use_cyclic = true));
  expect(await colorAt(4)).toEqual([255, 0, 0, 255]);
  // start at frame 10 with an offset of 1
  await page.evaluate(() => {
    const m = (window as any).__ie.image.media;
    m.use_cyclic = false;
    m.frame_start = 10;
    m.frame_offset = 1;
    m.frame_duration = 1;
  });
  expect(await colorAt(10)).toEqual([0, 255, 0, 255]);
  await page.evaluate(() => (window as any).app.run('image.match_movie_length', {}, { area: (window as any).__ie.host.area }));
  expect(await page.evaluate(() => (window as any).__ie.image.media.frame_duration)).toBe(2);
  await expectNoErrors(errors);
});
