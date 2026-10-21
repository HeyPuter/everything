import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors, openHeaderMenu } from './helpers';

/** Open the UV Editing workspace with every face selected (UVs shown and selected). */
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

const meshUVs = (page: Page) => page.evaluate(() => Array.from((window as any).app.doc.meshes[(window as any).app.activeObject.data].uvs as Float32Array)); // eslint-disable-line @typescript-eslint/no-explicit-any
const selCount = (page: Page) => page.evaluate(() => Array.from(((window as any).app.doc.meshes[(window as any).app.activeObject.data].uv_select ?? []) as Uint8Array).filter(Boolean).length); // eslint-disable-line @typescript-eslint/no-explicit-any

/** Screen position of a UV coordinate in the UV editor. */
function uvPoint(page: Page, u: number, v: number) {
  return page.evaluate(
    ([u, v]) => {
      const ed = document.querySelector('.uv-editor')!;
      const area = (window as any).app.hoverArea; // eslint-disable-line @typescript-eslint/no-explicit-any
      const p = area.editor.toPx(u, v);
      const r = ed.getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    },
    [u, v],
  );
}

test('UV editor: G moves the selection, the redo panel adjusts it, undo restores', async ({ page }) => {
  const { errors, box } = await uvWorkspace(page);
  const before = await meshUVs(page);
  await page.keyboard.press('g');
  await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2, { steps: 4 });
  await page.mouse.down();
  await page.mouse.up();
  const after = await meshUVs(page);
  expect(after[0] - before[0]).toBeGreaterThan(0.05);
  expect(after[1]).toBeCloseTo(before[1], 5);
  expect(await page.evaluate(() => (window as any).app.lastOp?.idname)).toBe('uv.translate'); // eslint-disable-line @typescript-eslint/no-explicit-any
  await expect(page.locator('.uv-editor .redo-panel')).toBeVisible();
  // re-run with an exact value
  await page.evaluate(() => (window as any).app.redoLast({ value: [0.25, 0] })); // eslint-disable-line @typescript-eslint/no-explicit-any
  const redone = await meshUVs(page);
  expect(redone[0] - before[0]).toBeCloseTo(0.25, 5);
  await page.keyboard.press('Control+z');
  expect((await meshUVs(page))[0]).toBeCloseTo(before[0], 5);
  await expectNoErrors(errors);
});

test('UV editor: click, shift-click and box selection', async ({ page }) => {
  const { errors, box } = await uvWorkspace(page);
  await page.keyboard.press('Alt+a');
  expect(await selCount(page)).toBe(0);
  const uvs = await meshUVs(page);
  const p = await uvPoint(page, uvs[0], uvs[1]);
  await page.mouse.click(p.x, p.y);
  const one = await selCount(page);
  expect(one).toBeGreaterThan(0);
  await page.keyboard.down('Shift');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Shift');
  expect(await selCount(page)).toBe(0);
  // drag a box over the whole editor (clear of the toolbar)
  await page.mouse.move(box.x + 60, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 10, box.y + box.height - 10, { steps: 5 });
  await page.mouse.up();
  expect(await selCount(page)).toBe(24);
  // B starts a box select from the keyboard; Alt+A clears
  await page.keyboard.press('Alt+a');
  await page.mouse.move(box.x + 60, box.y + 50);
  await page.keyboard.press('b');
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 10, box.y + box.height - 10, { steps: 5 });
  await page.mouse.up();
  expect(await selCount(page)).toBe(24);
  await expectNoErrors(errors);
});

test('UV editor: menus run operators (pin, merge, select mode)', async ({ page }) => {
  const { errors, box } = await uvWorkspace(page);
  await openHeaderMenu(page, page.locator('.uv-header').first(), 'UV');
  await page.locator('.popup-layer .menu-item', { hasText: /^Pin/ }).first().click();
  const pins = await page.evaluate(() => Array.from(((window as any).app.doc.meshes[(window as any).app.activeObject.data].uv_pin ?? []) as Uint8Array).filter(Boolean).length); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(pins).toBe(24);
  // Select ▸ Select All by Trait ▸ Pinned after deselecting
  await page.keyboard.press('Alt+a');
  await openHeaderMenu(page, page.locator('.uv-header').first(), 'Select');
  await page.locator('.popup-layer .menu-item', { hasText: 'Select All by Trait' }).hover();
  await page.locator('.popup-layer .menu-item', { has: page.locator('.mi-label', { hasText: /^Pinned$/ }) }).click();
  expect(await selCount(page)).toBe(24);
  // M ▸ At Center welds everything into one point
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('m');
  await page.locator('.popup-layer .menu-item', { hasText: 'At Center' }).click();
  const uvs = await meshUVs(page);
  expect(new Set(uvs.map((x, i) => (i % 2 ? '' : `${x.toFixed(4)},${uvs[i + 1].toFixed(4)}`)).filter(Boolean)).size).toBe(1);
  // number keys switch the UV select mode
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('3');
  expect(await page.evaluate(() => (window as any).app.doc.scene.tool_settings.uv_select_mode)).toBe('FACE'); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.keyboard.press('1');
  expect(await page.evaluate(() => (window as any).app.doc.scene.tool_settings.uv_select_mode)).toBe('VERTEX'); // eslint-disable-line @typescript-eslint/no-explicit-any
  await expectNoErrors(errors);
});

test('UV editor: context menu, toolbar tools and sidebar', async ({ page }) => {
  const { errors, box } = await uvWorkspace(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await expect(page.locator('.popup-layer .menu-item', { hasText: 'Copy UVs' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up({ button: 'right' });
  // pinch brush: a stroke over the layout pulls UVs together
  await page.locator('.uv-toolbar .tb-tool[data-tool="pinch"]').click();
  const before = await meshUVs(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10, { steps: 6 });
  await page.mouse.up();
  expect(await meshUVs(page)).not.toEqual(before);
  // N shows the sidebar with the UV Vertex panel
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('n');
  await expect(page.locator('.uv-sidebar')).toContainText('UV Vertex');
  await expectNoErrors(errors);
});

test('UV editor: export layout dialog downloads an SVG', async ({ page }) => {
  const { errors } = await uvWorkspace(page);
  await openHeaderMenu(page, page.locator('.uv-header').first(), 'UV');
  await page.locator('.popup-layer .menu-item', { hasText: 'Export UV Layout' }).click();
  const dlg = page.locator('.op-dialog[data-op="uv.export_layout"]');
  await expect(dlg).toBeVisible();
  await dlg.locator('.op-dialog-enum button', { hasText: 'Scalable Vector Graphic' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), dlg.locator('.op-dialog-ok').click()]);
  expect(download.suggestedFilename()).toMatch(/\.svg$/);
  await expectNoErrors(errors);
});

test('Image editor: new image, invert colors, flip, zoom ratio keys', async ({ page }) => {
  const errors = await openApp(page);
  // turn the 3D viewport into an Image Editor
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('image.new', { name: 'Test', width: 64, height: 32, color: [1, 0, 0, 1] }, { invoke: false });
  });
  const v3 = (await page.locator('.view3d').first().boundingBox())!;
  await page.mouse.move(v3.x + v3.width / 2, v3.y + v3.height / 2);
  await page.evaluate(() => (window as any).app.hoverArea.setType('IMAGE_EDITOR')); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.waitForTimeout(200);
  await page.mouse.move(v3.x + v3.width / 2 + 1, v3.y + v3.height / 2);
  await expect(page.locator('.ie-root')).toBeVisible();
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const img = Object.values(a.doc.images as Record<string, { id: string; name: string }>).find((i) => i.name === 'Test')!;
    a.hoverArea.editor.setImage(img.id);
  });
  const px = () =>
    page.evaluate(async () => {
      const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
      const img = a.hoverArea.editor.image;
      const { imageCanvas } = await import('/src/render/images.ts');
      const c = imageCanvas(img);
      return { w: c.width, h: c.height, p: Array.from(c.getContext('2d').getImageData(0, 0, 1, 1).data) };
    });
  await page.waitForTimeout(100);
  expect((await px()).p.slice(0, 3)).toEqual([255, 0, 0]);
  await openHeaderMenu(page, page.locator('.ie-header').first(), 'Image');
  await page.locator('.popup-layer .menu-item', { hasText: 'Invert' }).first().hover();
  await page.locator('.popup-layer .menu-item', { hasText: 'Invert Image Colors' }).click();
  expect((await px()).p.slice(0, 3)).toEqual([0, 255, 255]);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  expect((await px()).p.slice(0, 3)).toEqual([255, 0, 0]);
  // rotate 90° swaps the size
  await page.evaluate(() => (window as any).app.run('image.rotate_orthogonal', { degrees: '90' }, { invoke: false })); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(await px()).toMatchObject({ w: 32, h: 64 });
  // zoom ratio keys
  await page.mouse.move(v3.x + v3.width / 2, v3.y + v3.height / 2);
  await page.keyboard.press('Control+Numpad2');
  expect(await page.evaluate(() => (window as any).app.hoverArea.editor.zoom)).toBe(2); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.keyboard.press('Numpad4');
  expect(await page.evaluate(() => (window as any).app.hoverArea.editor.zoom)).toBe(0.25); // eslint-disable-line @typescript-eslint/no-explicit-any
  await expectNoErrors(errors);
});

test('Image empty converts to a textured mesh plane in place', async ({ page }) => {
  const errors = await openApp(page);
  const res = await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('image.new', { name: 'Ref', width: 200, height: 100 }, { invoke: false });
    const img = Object.values(a.doc.images as Record<string, { id: string; name: string }>).find((i) => i.name === 'Ref')!;
    a.run('object.empty_image_add', { image: img.id, location: [1, 2, 3], rotation: [0, 0, 0] }, { invoke: false });
    const r = a.run('image.convert_to_mesh_plane', {}, { invoke: false });
    const ob = a.activeObject;
    const me = a.doc.meshes[ob.data];
    const xs = Array.from(me.positions as Float32Array).filter((_, i) => i % 3 === 0);
    return { r, type: ob.type, loc: ob.location, width: Math.max(...xs) - Math.min(...xs), empties: Object.values(a.doc.objects as Record<string, { type: string }>).filter((o) => o.type === 'EMPTY').length };
  });
  expect(res.r).toBe('FINISHED');
  expect(res.type).toBe('MESH');
  expect(res.loc).toEqual([1, 2, 3]);
  expect(res.width).toBeCloseTo(5, 4); // the empty is 5 units wide
  expect(res.empties).toBe(0);
  await expectNoErrors(errors);
});

test('UV editor: increment snapping moves in grid steps', async ({ page }) => {
  const { errors, box } = await uvWorkspace(page);
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => (window as any).app.doc.scene.tool_settings.use_snap_uv)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  const before = await meshUVs(page);
  await page.keyboard.press('g');
  await page.mouse.move(box.x + box.width / 2 + 37, box.y + box.height / 2 + 3, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  const step = await page.evaluate(() => (window as any).app.hoverArea.editor.gridStep()); // eslint-disable-line @typescript-eslint/no-explicit-any
  const d = (await meshUVs(page))[0] - before[0];
  expect(Math.abs(d / step - Math.round(d / step))).toBeLessThan(1e-4);
  await expectNoErrors(errors);
});

test('Image editor: render slots cycle with J / Alt J and number keys', async ({ page }) => {
  const errors = await openApp(page);
  const v3 = (await page.locator('.view3d').first().boundingBox())!;
  await page.mouse.move(v3.x + v3.width / 2, v3.y + v3.height / 2);
  await page.evaluate(() => (window as any).app.hoverArea.setType('IMAGE_EDITOR')); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.mouse.move(v3.x + v3.width / 2 + 1, v3.y + v3.height / 2);
  await page.evaluate(async () => {
    const { renderResult } = await import('/src/render/final/result.ts');
    const fake = () => ({ width: 2, height: 2, passes: { Combined: new Float32Array(16).fill(0.5) }, filmTransparent: false, info: { frame: 1, time: 0, engine: 'Test', camera: '', scene: 'Scene' }, version: 0, rendering: false });
    renderResult.setSlot(0);
    renderResult.set(fake());
    renderResult.setSlot(2);
    renderResult.set(fake());
    renderResult.setSlot(0);
    (window as any).app.hoverArea.editor.setImage('__render_result__'); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
  const slot = () => page.evaluate(async () => (await import('/src/render/final/result.ts')).renderResult.slot);
  await page.keyboard.press('j');
  expect(await slot()).toBe(2);
  await page.keyboard.press('j');
  expect(await slot()).toBe(0);
  await page.keyboard.press('Alt+j');
  expect(await slot()).toBe(2);
  await page.keyboard.press('2');
  expect(await slot()).toBe(1);
  await expect(page.locator('.ie-header .enum-menu', { hasText: 'Slot 2' })).toBeVisible();
  await expectNoErrors(errors);
});

test('Image editor: Paint mode in Texture Paint shows the brushes and paints on the image', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.ws-tab', { hasText: 'Texture Paint' }).first().click();
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('paint.add_texture_paint_slot', {}, { invoke: false });
    a.doc.scene.tool_settings.unified_paint.color = [1, 0, 0];
  });
  // Paint, Soften, Smear, Fill, Clone and Mask
  await expect(page.locator('.ie-toolbar .tb-tool')).toHaveCount(6);
  await expect(page.locator('.ie-toolhdr')).toBeVisible();
  const ie = (await page.locator('.ie-root').first().boundingBox())!;
  const cx = ie.x + ie.width / 2,
    cy = ie.y + ie.height / 2;
  await page.mouse.move(cx - 40, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const px = await page.evaluate(async ([x, y]) => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const ed = a.hoverArea.editor;
    const r = ed.el.getBoundingClientRect();
    const [ix, iy] = ed.toImage(x - r.left, y - r.top);
    const { imageCanvas } = await import('/src/render/images.ts');
    const c = imageCanvas(ed.image);
    return Array.from(c.getContext('2d').getImageData(Math.floor(ix), Math.floor(iy), 1, 1).data);
  }, [cx, cy]);
  expect(px[0]).toBeGreaterThan(200);
  expect(px[1]).toBeLessThan(120);
  await expectNoErrors(errors);
});
