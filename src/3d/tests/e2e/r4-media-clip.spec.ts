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

test('clip: graph header filters curves to the selected tracks and can include hidden ones', async ({ page }) => {
  const { errors, box } = await trackingWorkspace(page);
  const knots = () => page.evaluate(async () => {
    const U = (p: string) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(p)) ?? p;
    const G = await import(U('/src/tracking/graphs.ts'));
    const ed = (window as any).app.hoverArea.editor;
    return new Set(G.graphKnots(ed).map((k: any) => k.track.name)).size;
  });
  await page.evaluate(async () => {
    const app = (window as any).app;
    const ed = app.hoverArea.editor;
    const T = ed.clip.tracking.tracks;
    const U = (p: string) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(p)) ?? p;
    const TT = await import(U('/src/tracking/types.ts'));
    const t2 = TT.newTrack(ed.clip.tracking, 'B');
    for (let f = 1; f <= 30; f++) t2.markers.push(TT.newMarker(f, [0.6, 0.4 + f * 0.003], ed.clip.size, 21, 71));
    T.push(t2);
    for (const t of T) t.select = t.name === 'A';
    ed.setView('GRAPH');
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 1);
  expect(await knots()).toBe(1);
  const toggle = (tip: string) =>
    page.evaluate((tip) => {
      const area = (window as any).app.hoverArea;
      const b = [...area.el.querySelectorAll('.hdr-toggle')].find((x: any) => (x.getAttribute('data-tip') ?? '').startsWith(tip)) as HTMLElement;
      b.click();
    }, tip);
  await toggle('Only Show Selected');
  expect(await knots()).toBe(2);
  await page.evaluate(() => {
    const ed = (window as any).app.hoverArea.editor;
    ed.clip.tracking.tracks.find((t: any) => t.name === 'B').hide = true;
  });
  expect(await knots()).toBe(1);
  await toggle('Show Hidden');
  expect(await knots()).toBe(2);
  await expectNoErrors(errors);
});

test('clip: graph view shows solve errors per track and per frame; header buttons track from the graph', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const U = (p: string) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(p)) ?? p;
    const { shell } = await import(U('/src/ui/shell.ts'));
    const { workspaceTemplates } = await import(U('/src/ui/screen.ts'));
    const T = await import(U('/src/tracking/types.ts'));
    const app = (window as any).app;
    const W = 1280,
      H = 720,
      frames = 30;
    const c = T.newMovieClip('MC_s', 'shot', { size: [W, H], frame_duration: frames });
    const f = (c.tracking.camera.focal_length * W) / c.tracking.camera.sensor_width;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296);
    const rot = (yaw: number) => [Math.cos(yaw), 0, -Math.sin(yaw), 0, 1, 0, Math.sin(yaw), 0, Math.cos(yaw)];
    for (let i = 0; i < 60; i++) {
      const X = [(rnd() - 0.5) * 10, (rnd() - 0.5) * 5, 5 + rnd() * 8];
      const t = T.newTrack(c.tracking, 'Track');
      for (let k = 1; k <= frames; k++) {
        const s = (k - 1) / (frames - 1);
        const C = [-1.5 + 3 * s, 0.2 * Math.sin(3 * s), 0.6 * s];
        const R = rot(-0.3 + 0.6 * s);
        const d = [X[0] - C[0], X[1] - C[1], X[2] - C[2]];
        const p = [R[0] * d[0] + R[1] * d[1] + R[2] * d[2], R[3] * d[0] + R[4] * d[1] + R[5] * d[2], R[6] * d[0] + R[7] * d[1] + R[8] * d[2]];
        if (p[2] < 0.5) continue;
        const px = W / 2 + (f * p[0]) / p[2],
          py = H / 2 - (f * p[1]) / p[2];
        if (px < 0 || py < 0 || px > W || py > H) continue;
        t.markers.push(T.newMarker(k, [px / W, py / H], c.size, 21, 71));
      }
      t.select = i === 0;
      if (t.markers.length > 1) c.tracking.tracks.push(t);
    }
    T.clipTable(app.doc)['MC_s'] = c;
    app.doc.scene.active_clip = 'MC_s';
    shell.addWorkspace(workspaceTemplates.find((t: any) => t.create().name === 'Motion Tracking').create());
    app.setFrame(1);
    app.pushUndo('Test Clip');
    app.run('clip.solve_camera');
  });
  await page.waitForFunction(() => !!(window as any).app.doc.movieclips.MC_s.tracking.reconstruction?.is_valid, null, { timeout: 30000 });
  const el = page.locator('.clip-root').nth(1);
  const box = (await el.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const r = await page.evaluate(async () => {
    const U = (p: string) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(p)) ?? p;
    const G = await import(U('/src/tracking/graphs.ts'));
    const ed = (window as any).app.hoverArea.editor;
    ed.setView('GRAPH');
    const c = ed.clip;
    const t = c.tracking.tracks[0];
    const runs = G.trackErrors(c, t);
    const fr = G.frameErrors(c);
    const buttons = [...ed.area.el.querySelectorAll('.clip-track-buttons .hdr-toggle')].length;
    return { runs: runs.length, maxErr: Math.max(...runs.flat().map((p: any) => p.e)), frames: fr.length, buttons };
  });
  expect(r.runs).toBeGreaterThan(0);
  expect(r.maxErr).toBeLessThan(2);
  expect(r.frames).toBe(30);
  expect(r.buttons).toBe(8);
  await expectNoErrors(errors);
});
