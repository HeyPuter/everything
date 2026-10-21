import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Motion Tracking workspace with a 640×360 clip holding one track. */
async function trackingWorkspace(page: Page) {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const U = (p: string) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(p)) ?? p;
    const { shell } = await import(U('/src/ui/shell.ts'));
    const { workspaceTemplates } = await import(U('/src/ui/screen.ts'));
    const T = await import(U('/src/tracking/types.ts'));
    const app = (window as any).app;
    const c = T.newMovieClip('MC_t', 'clip', { size: [640, 360], frame_duration: 40 });
    const t = T.newTrack(c.tracking, 'A');
    for (let f = 1; f <= 30; f++) t.markers.push(T.newMarker(f, [0.3 + f * 0.005, 0.5], c.size, 21, 71));
    c.tracking.tracks.push(t);
    T.clipTable(app.doc)['MC_t'] = c;
    app.doc.scene.active_clip = 'MC_t';
    shell.addWorkspace(workspaceTemplates.find((x: any) => x.create().name === 'Motion Tracking').create());
    app.setFrame(5);
  });
  await page.waitForTimeout(300);
  const el = page.locator('.clip-root').nth(1);
  const box = (await el.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return { errors, box };
}

const ov = (page: Page) => page.evaluate(() => ({ ...(window as any).app.hoverArea.editor.overlays }));

test('clip: Shift Alt Z hides the overlays; the Overlays menu switches channels, B/W and thin markers', async ({ page }) => {
  const { errors } = await trackingWorkspace(page);
  await page.keyboard.press('Shift+Alt+z');
  expect((await ov(page)).show_overlays).toBe(false);
  await page.keyboard.press('Shift+Alt+z');
  expect((await ov(page)).show_overlays).toBe(true);
  await page.locator('.clip-overlays').first().dispatchEvent('pointerdown');
  await page.locator('.popup-layer .menu-item', { hasText: 'Red Channel' }).first().click();
  await page.locator('.popup-layer .menu-item', { hasText: 'Black and White' }).first().click();
  await page.locator('.popup-layer .menu-item', { hasText: 'Display Thin' }).first().click();
  const o = await ov(page);
  expect(o.show_red_channel).toBe(false);
  expect(o.use_grayscale_preview).toBe(true);
  expect(o.show_tiny_markers).toBe(true);
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('clip: graph view Lock Time Cursor (L) keeps the current frame centred', async ({ page }) => {
  const { errors, box } = await trackingWorkspace(page);
  await page.evaluate(() => {
    const ed = (window as any).app.hoverArea.editor;
    ed.setView ? ed.setView('GRAPH') : (ed.view = 'GRAPH');
    ed.draw();
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 1);
  await page.keyboard.press('l');
  expect(await page.evaluate(() => (window as any).app.hoverArea.editor.lockTimeCursor)).toBe(true);
  await page.evaluate(() => (window as any).app.setFrame(25));
  await page.waitForTimeout(50);
  const centre = await page.evaluate(() => {
    const ed = (window as any).app.hoverArea.editor;
    return ed.v2.x0 + ed.v2.width / 2 / ed.v2.ppf;
  });
  expect(centre).toBeCloseTo(25, 3);
  await expectNoErrors(errors);
});

test('clip: the Annotation toolbar tab draws notes on the clip; Esc stops the tool', async ({ page }) => {
  const { errors, box } = await trackingWorkspace(page);
  await page.evaluate(() => {
    const ed = (window as any).app.hoverArea.editor;
    ed.showToolbar = true;
    ed.toolbarTab = 'Annotation';
    ed.drawUI();
  });
  await page.locator('[data-tool="clip-annotate_line"]').click();
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy + 20, { steps: 4 });
  await page.mouse.up();
  const notes = await page.evaluate(() => ((window as any).app.doc.movieclips.MC_t.annotations_2d ?? []).map((s: any) => s.points.length));
  expect(notes).toEqual([4]);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (window as any).app.hoverArea.editor.annotateTool)).toBe(null);
  await expectNoErrors(errors);
});

test('clip: dragging along the frame strip at the bottom scrubs frames', async ({ page }) => {
  const { errors, box } = await trackingWorkspace(page);
  const r = await page.evaluate(() => {
    const ed = (window as any).app.hoverArea.editor;
    ed.showToolbar = false;
    ed.showSidebar = false;
    ed.drawUI();
    ed.draw();
    const b = ed.el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
  await page.mouse.move(r.x + r.w * 0.5, r.y + r.h - 5);
  await page.mouse.down();
  await page.mouse.move(r.x + r.w * 0.75, r.y + r.h - 5, { steps: 3 });
  await page.mouse.up();
  // 40 frames over the strip: three quarters along is frame 31
  expect(await page.evaluate(() => (window as any).app.doc.scene.frame_current)).toBe(31);
  void box;
  await expectNoErrors(errors);
});
