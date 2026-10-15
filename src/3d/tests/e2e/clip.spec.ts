import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Motion Tracking workspace with a 640×360 clip holding two tracks with markers on frames 1–10. */
async function trackingWorkspace(page: Page) {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const { shell } = await import('/src/ui/shell.ts' as any);
    const { workspaceTemplates } = await import('/src/ui/screen.ts' as any);
    const T = await import('/src/tracking/types.ts' as any);
    const app = (window as any).app;
    const c = T.newMovieClip('MC_t', 'clip', { size: [640, 360], frame_duration: 20 });
    for (const [name, x0] of [
      ['A', 0.3],
      ['B', 0.7],
    ] as const) {
      const t = T.newTrack(c.tracking, name);
      for (let f = 1; f <= 10; f++) t.markers.push(T.newMarker(f, [x0 + f * 0.01, 0.5 + (f % 3) * 0.01], c.size, 21, 71));
      t.select = false;
      c.tracking.tracks.push(t);
    }
    T.clipTable(app.doc)['MC_t'] = c;
    app.doc.scene.active_clip = 'MC_t';
    shell.addWorkspace(workspaceTemplates.find((t: any) => t.create().name === 'Motion Tracking').create());
    app.setFrame(5);
  });
  await page.waitForTimeout(300);
  return errors;
}

const tracks = (page: Page) => page.evaluate(() => (window as any).app.doc.movieclips.MC_t.tracking.tracks.map((t: any) => ({ name: t.name, select: t.select, n: t.markers.length, muted: t.markers.filter((m: any) => m.mute).length })));

test('clip: circle select markers (C) in the clip view', async ({ page }) => {
  const errors = await trackingWorkspace(page);
  const el = page.locator('.clip-root').nth(1);
  const box = (await el.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Home');
  const p = await page.evaluate(() => {
    const ed = (window as any).app.hoverArea.editor;
    const t = ed.clip.tracking.tracks[0];
    const m = t.markers.find((x: any) => x.frame === 5);
    const g = ed.markerGeom(m);
    const s = ed.toScreen(g.x, g.y);
    const r = ed.el.getBoundingClientRect();
    return { x: r.left + s[0], y: r.top + s[1] };
  });
  await page.mouse.move(p.x, p.y);
  await page.keyboard.press('c');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press('Escape');
  expect((await tracks(page)).map((t: any) => t.select)).toEqual([true, false]);
  await expectNoErrors(errors);
});

test('clip: graph view selects knots, deletes them (Shift X) and disables them (Shift D)', async ({ page }) => {
  const errors = await trackingWorkspace(page);
  await page.evaluate(() => {
    const c = (window as any).app.doc.movieclips.MC_t;
    c.tracking.tracks[0].select = true;
    c.tracking.active_track = c.tracking.tracks[0].name;
    (window as any).app.pushUndo('Select');
    (window as any).app.changed('doc');
  });
  // the graph editor of the workspace
  const graph = page.locator('.clip-root').nth(2);
  const box = (await graph.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Home');
  const dbg = await page.evaluate(async () => {
    const G = await import('/src/tracking/graphs.ts' as any);
    const ed = (window as any).app.hoverArea.editor;
    return { view: ed.view, knots: G.graphKnots(ed).length };
  });
  expect(dbg).toEqual({ view: 'GRAPH', knots: 18 });
  await page.keyboard.press('a');
  const n = await page.evaluate(async () => {
    const G = await import('/src/tracking/graphs.ts' as any);
    return G.graphSelection((window as any).app.hoverArea.editor).size;
  });
  expect(n).toBe(18); // 9 speed samples × X and Y
  await page.keyboard.press('Shift+d');
  expect((await tracks(page))[0].muted).toBe(9);
  await page.keyboard.press('Control+z');
  // click one knot, delete it
  const k = await page.evaluate(async () => {
    const G = await import('/src/tracking/graphs.ts' as any);
    const ed = (window as any).app.hoverArea.editor;
    const kn = G.graphKnots(ed).find((x: any) => x.frame === 6 && x.axis === 'x');
    const r = ed.el.getBoundingClientRect();
    return { x: r.left + kn.x, y: r.top + kn.y };
  });
  await page.mouse.click(k.x, k.y);
  await page.keyboard.press('Shift+x');
  expect((await tracks(page))[0].n).toBe(9);
  await expectNoErrors(errors);
});
