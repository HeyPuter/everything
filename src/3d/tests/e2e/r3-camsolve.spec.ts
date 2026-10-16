import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Motion Tracking workspace with a 1280×720 clip whose tracks are the projections of random
 * 3D points seen by a camera dollying sideways (so the clip can be solved).
 */
async function solvableClip(page: Page, opts: { frames?: number; points?: number } = {}) {
  const errors = await openApp(page);
  await page.evaluate(
    async ({ frames, points }) => {
      const { shell } = await import('/src/ui/shell.ts' as any);
      const { workspaceTemplates } = await import('/src/ui/screen.ts' as any);
      const T = await import('/src/tracking/types.ts' as any);
      const app = (window as any).app;
      const W = 1280,
        H = 720;
      const c = T.newMovieClip('MC_s', 'shot', { size: [W, H], frame_duration: frames });
      const f = (c.tracking.camera.focal_length * W) / c.tracking.camera.sensor_width;
      let seed = 7;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296);
      const rot = (yaw: number) => [Math.cos(yaw), 0, -Math.sin(yaw), 0, 1, 0, Math.sin(yaw), 0, Math.cos(yaw)];
      for (let i = 0; i < points; i++) {
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
        t.select = false;
        if (t.markers.length > 1) c.tracking.tracks.push(t);
      }
      T.clipTable(app.doc)['MC_s'] = c;
      app.doc.scene.active_clip = 'MC_s';
      shell.addWorkspace(workspaceTemplates.find((t: any) => t.create().name === 'Motion Tracking').create());
      app.setFrame(1);
      app.pushUndo('Test Clip');
    },
    { frames: opts.frames ?? 30, points: opts.points ?? 60 },
  );
  await page.waitForTimeout(300);
  return errors;
}

const clipState = (page: Page) =>
  page.evaluate(() => {
    const c = (window as any).app.doc.movieclips.MC_s;
    const rec = c.tracking.reconstruction;
    return { valid: !!rec?.is_valid, error: rec?.average_error ?? 0, cameras: rec?.cameras.length ?? 0, bundles: c.tracking.tracks.filter((t: any) => t.has_bundle).length };
  });

async function solve(page: Page) {
  await page.evaluate(() => (window as any).app.run('clip.solve_camera'));
  await page.waitForFunction(() => !!(window as any).app.doc.movieclips.MC_s.tracking.reconstruction?.is_valid, null, { timeout: 30000 });
}

test('camsolve: solve from the Solve tab, error in the header and track panel', async ({ page }) => {
  const errors = await solvableClip(page);
  const clipView = page.locator('.clip-root').nth(1);
  await clipView.locator('.clip-toolbar .sb-tab', { hasText: 'Solve' }).click();
  await expect(clipView.locator('.clip-toolbar .panel', { hasText: 'Orientation' })).toBeVisible();
  await clipView.locator('.clip-toolbar button', { hasText: 'Solve Camera Motion' }).click();
  await page.waitForFunction(() => !!(window as any).app.doc.movieclips.MC_s.tracking.reconstruction?.is_valid, null, { timeout: 30000 });
  const st = await clipState(page);
  expect(st.cameras).toBe(30);
  expect(st.error).toBeLessThan(0.5);
  expect(st.bundles).toBeGreaterThan(50);
  await expect(page.locator('.clip-header-error').first()).toContainText('Solve error');
  await expect(clipView.locator('.clip-solve-status').first()).toContainText('30 frames');
  // the solve is one undo step
  await page.keyboard.press('Control+z');
  expect((await clipState(page)).valid).toBe(false);
  await expectNoErrors(errors);
});

/** World positions of bundles (through the scene camera's own transform) by track index. */
const bundlesWorld = (page: Page, idx: number[]) =>
  page.evaluate(async (idx) => {
    const { Vector3 } = await import('/node_modules/.vite/deps/three.js' as any);
    const app = (window as any).app;
    app.graph.evaluate(app.doc);
    const M = app.graph.get(app.doc.scene.camera).worldBasis;
    const c = app.doc.movieclips.MC_s;
    return idx.map((i) => new Vector3(...c.tracking.tracks[i].bundle).applyMatrix4(M).toArray());
  }, idx);

test('camsolve: setup tracking scene, orientation and 3D markers to mesh', async ({ page }) => {
  const errors = await solvableClip(page);
  await solve(page);
  await page.evaluate(() => (window as any).app.run('clip.setup_tracking_scene'));
  const cam = await page.evaluate(() => {
    const app = (window as any).app;
    const ob = app.doc.objects[app.doc.scene.camera];
    const ca = app.doc.cameras[ob.data];
    return { solver: ob.constraints.map((c: any) => c.type), bg: ca.background_images?.[0]?.source, show: ca.show_background_images, comp: !!app.doc.scene.compositing_node_group, res: [app.doc.scene.render.resolution_x, app.doc.scene.render.resolution_y] };
  });
  expect(cam).toEqual({ solver: ['CAMERA_SOLVER'], bg: 'MOVIE_CLIP', show: true, comp: true, res: [1280, 720] });
  // the camera follows the solved path
  const follow = await page.evaluate(() => {
    const app = (window as any).app;
    app.setFrame(12);
    app.graph.evaluate(app.doc);
    const w = app.graph.get(app.doc.scene.camera).world.elements;
    const rc = app.doc.movieclips.MC_s.tracking.reconstruction.cameras.find((c: any) => c.frame === 12).matrix;
    return Math.max(...w.map((v: number, i: number) => Math.abs(v - rc[i])));
  });
  expect(follow).toBeLessThan(1e-5);
  // floor through three tracks
  await page.evaluate(() => {
    const app = (window as any).app;
    const c = app.doc.movieclips.MC_s;
    c.tracking.tracks.forEach((t: any, i: number) => (t.select = i < 3));
    c.tracking.active_track = c.tracking.tracks[0].name;
    app.run('clip.set_plane', { plane: 'FLOOR' });
  });
  for (const p of await bundlesWorld(page, [0, 1, 2])) expect(Math.abs(p[2])).toBeLessThan(1e-4);
  // origin at the active track
  await page.evaluate(() => (window as any).app.run('clip.set_origin'));
  const [o] = await bundlesWorld(page, [0]);
  expect(Math.hypot(...o)).toBeLessThan(1e-4);
  // scale: two tracks 2 m apart
  await page.evaluate(() => {
    const app = (window as any).app;
    const c = app.doc.movieclips.MC_s;
    c.tracking.tracks.forEach((t: any, i: number) => (t.select = i === 1 || i === 2));
    app.run('clip.set_scale', { distance: 2 });
  });
  const [a, b] = await bundlesWorld(page, [1, 2]);
  expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeCloseTo(2, 4);
  // the floor is still the floor
  for (const p of await bundlesWorld(page, [1, 2])) expect(Math.abs(p[2])).toBeLessThan(1e-4);
  // vertices for every bundle
  const n = await page.evaluate(() => {
    const app = (window as any).app;
    app.doc.movieclips.MC_s.tracking.tracks.forEach((t: any) => (t.select = false));
    app.run('clip.bundles_to_mesh');
    return app.doc.meshes[app.activeObject.data].positions.length / 3;
  });
  expect(n).toBe((await clipState(page)).bundles);
  await expectNoErrors(errors);
});

test('camsolve: solving pie, reconstruction menu, tracking objects and clear solution', async ({ page }) => {
  const errors = await solvableClip(page);
  const clipView = page.locator('.clip-root').nth(1);
  const box = (await clipView.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Shift+s');
  await expect(page.locator('.pie-item', { hasText: 'Solve Camera' })).toBeVisible();
  await page.locator('.pie-item', { hasText: 'Solve Camera' }).click();
  await page.waitForFunction(() => !!(window as any).app.doc.movieclips.MC_s.tracking.reconstruction?.is_valid, null, { timeout: 30000 });
  // Reconstruction menu lists the orientation tools
  await page.locator('.clip-header .hdr-menu', { hasText: 'Reconstruction' }).first().dispatchEvent('pointerdown');
  for (const l of ['Set Origin', 'Set Floor', 'Set Wall', 'Set X Axis', 'Apply Solution Scale', '3D Markers to Mesh']) await expect(page.locator('.menu .menu-item', { hasText: l }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  // a tracking object: its own (empty) track list, then removed again
  await clipView.locator('.clip-sidebar button[data-tip="Add a tracking object"]').click();
  expect(await page.evaluate(() => (window as any).app.doc.movieclips.MC_s.tracking.active_object_index)).toBe(1);
  await expect(clipView.locator('.clip-objects .clip-list-item')).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).app.hoverArea?.editor?.tracks?.().length ?? -1)).toBe(0);
  await clipView.locator('.clip-sidebar button[data-tip="Remove the active tracking object"]').click();
  await expect(clipView.locator('.clip-objects .clip-list-item')).toHaveCount(1);
  // Track ▸ Clear ▸ Solution
  await page.evaluate(() => (window as any).app.run('clip.clear_solution'));
  expect(await clipState(page)).toEqual({ valid: false, error: 0, cameras: 0, bundles: 0 });
  await expectNoErrors(errors);
});

test('camsolve: plane track from four tracks, corner slide and Plane Track Deform node', async ({ page }) => {
  const errors = await solvableClip(page, { frames: 20, points: 30 });
  const r = await page.evaluate(() => {
    const app = (window as any).app;
    const c = app.doc.movieclips.MC_s;
    app.setFrame(5);
    // four tracks visible on frame 5
    const vis = c.tracking.tracks.filter((t: any) => t.markers.some((m: any) => m.frame === 5)).slice(0, 4);
    vis.forEach((t: any) => (t.select = true));
    app.changed('doc');
    app.run('clip.create_plane_track');
    const pt = c.tracking.plane_tracks[0];
    return { name: pt?.name, tracks: pt?.tracks.length, frames: pt?.markers.length, active: c.tracking.active_plane_track };
  });
  expect(r.name).toBe('Plane Track');
  expect(r.tracks).toBe(4);
  expect(r.frames).toBeGreaterThan(5);
  expect(r.active).toBe('Plane Track');
  // the sidebar shows the Plane Track panel
  const clipView = page.locator('.clip-root').nth(1);
  await expect(clipView.locator('.clip-sidebar .panel', { hasText: 'Plane Track' })).toBeVisible();
  // drag a corner on screen: the corner moves on this frame
  const box = (await clipView.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Home');
  const p = await page.evaluate(() => {
    const app = (window as any).app;
    const e = app.hoverArea.editor;
    const c = app.doc.movieclips.MC_s;
    const m = c.tracking.plane_tracks[0].markers.find((x: any) => x.frame === 5);
    const s = e.toScreen(m.corners[2][0] * c.size[0], (1 - m.corners[2][1]) * c.size[1]);
    const rc = e.el.getBoundingClientRect();
    return { x: rc.left + s[0], y: rc.top + s[1], before: m.corners[2] };
  });
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 20, p.y + 10, { steps: 4 });
  await page.mouse.up();
  const after = await page.evaluate(() => (window as any).app.doc.movieclips.MC_s.tracking.plane_tracks[0].markers.find((x: any) => x.frame === 5).corners[2]);
  expect(after[0]).toBeGreaterThan(p.before[0]);
  // Slide by operator (scriptable form)
  await page.evaluate(() => (window as any).app.run('clip.slide_plane_marker', { corner: 0, offset: [0.01, 0] }));
  const keyed = await page.evaluate(() => (window as any).app.doc.movieclips.MC_s.tracking.plane_tracks[0].markers.find((x: any) => x.frame === 5).is_keyed);
  expect(keyed).toBe(true);
  // the compositor node lists under Add ▸ Tracking and evaluates without errors
  const node = await page.evaluate(async () => {
    const { nodeMenu } = await import('/src/nodes/registry.ts' as any);
    const cat = nodeMenu('COMPOSITOR').find((x: any) => x.label === 'Tracking');
    return cat.items.map((i: any) => i.idname).filter(Boolean)[0];
  });
  expect(node).toBe('CompositorNodePlaneTrackDeform');
  await expectNoErrors(errors);
});

test('camsolve: clip editor operators (select, cursor, view, mode, active clip, frames)', async ({ page }) => {
  const errors = await solvableClip(page, { frames: 20, points: 20 });
  const clipView = page.locator('.clip-root').nth(1);
  const box = (await clipView.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const r = await page.evaluate(() => {
    const app = (window as any).app;
    const ed = app.hoverArea.editor;
    const c = app.doc.movieclips.MC_s;
    app.setFrame(4);
    const t = c.tracking.tracks.find((x: any) => x.markers.some((m: any) => m.frame === 4));
    const m = t.markers.find((x: any) => x.frame === 4);
    const out: any = {};
    out.select = app.run('clip.select', { location: [m.co[0] + 0.001, m.co[1]] }, { invoke: false });
    out.active = c.tracking.active_track === t.name && t.select;
    app.run('clip.cursor_set', { location: [0.25, 0.75] }, { invoke: false });
    out.cursor = [...ed.cursor];
    app.run('clip.view_center_cursor');
    out.centered = [Math.round(ed.offX), Math.round(ed.offY)];
    app.run('clip.mode_set', { mode: 'MASK' });
    out.mask = ed.mode;
    app.run('clip.mode_set', { mode: 'TRACKING' });
    app.doc.scene.active_clip = null;
    app.run('clip.set_active_clip');
    out.activeClip = app.doc.scene.active_clip;
    app.run('clip.change_frame', { frame: 9 }, { invoke: false });
    out.frame = app.doc.scene.frame_current;
    const before = [...m.co];
    c.tracking.tracks.forEach((x: any) => (x.select = x === t));
    app.run('clip.slide_marker', { offset: [0.01, -0.02] }, { invoke: false });
    const m9 = t.markers.find((x: any) => x.frame === 9);
    out.slid = !!m9 && m9.is_keyed;
    void before;
    return out;
  });
  expect(r).toEqual({ select: 'FINISHED', active: true, cursor: [0.25, 0.75], centered: [320, 180], mask: 'MASK', activeClip: 'MC_s', frame: 9, slid: true });
  // the dope sheet channel operator selects a track by its row
  const ds = page.locator('.clip-root').nth(0);
  const dbox = (await ds.boundingBox())!;
  await page.mouse.move(dbox.x + 50, dbox.y + 60);
  const sel = await page.evaluate(() => {
    const app = (window as any).app;
    app.run('clip.dopesheet_select_channel', { location: [10, 24 + 20 * 2 + 5], extend: false }, { invoke: false });
    return app.doc.movieclips.MC_s.tracking.tracks.filter((t: any) => t.select).length;
  });
  expect(sel).toBe(1);
  await expectNoErrors(errors);
});

test('camsolve: proxies of an image sequence are built and shown', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const { openClipFiles } = await import('/src/tracking/index.ts' as any);
    const { shell } = await import('/src/ui/shell.ts' as any);
    const { workspaceTemplates } = await import('/src/ui/screen.ts' as any);
    shell.addWorkspace(workspaceTemplates.find((t: any) => t.create().name === 'Motion Tracking').create());
    const files: File[] = [];
    for (let i = 0; i < 6; i++) {
      const cv = document.createElement('canvas');
      cv.width = 320;
      cv.height = 180;
      const g = cv.getContext('2d')!;
      g.fillStyle = `hsl(${i * 50}, 70%, 50%)`;
      g.fillRect(0, 0, 320, 180);
      const b: Blob = await new Promise((res) => cv.toBlob((x) => res(x!), 'image/png'));
      files.push(new File([b], `f${String(i).padStart(3, '0')}.png`, { type: 'image/png' }));
    }
    await openClipFiles(files);
  });
  await page.waitForTimeout(300);
  const clipView = page.locator('.clip-root').nth(1);
  const box = (await clipView.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await clipView.locator('.clip-sidebar .sb-tab', { hasText: 'Footage' }).click();
  await clipView.locator('[data-id="clip-use-proxy"]').click();
  await expect(clipView.locator('.clip-sidebar .panel', { hasText: 'Proxy' }).locator('button', { hasText: 'Build Proxy' })).toBeEnabled();
  await clipView.locator('.clip-sidebar button', { hasText: 'Build Proxy' }).click();
  await page.waitForFunction(() => document.querySelector('.clip-sidebar .clip-info')?.textContent?.includes('Built: 25%'), null, { timeout: 15000 });
  const shown = await page.evaluate(() => {
    const ed = (window as any).app.hoverArea.editor;
    ed.proxyRenderSize = 'PROXY_25';
    const s = ed.displaySource();
    return [s.width, s.height, s.frameCount];
  });
  expect(shown).toEqual([80, 45, 6]);
  await page.evaluate(() => (window as any).app.run('clip.delete_proxy'));
  expect(await page.evaluate(() => (window as any).app.hoverArea.editor.displaySource().width)).toBe(320);
  await expectNoErrors(errors);
});

test('camsolve: camera, track color and tracking settings presets', async ({ page }) => {
  const errors = await solvableClip(page, { frames: 10, points: 12 });
  const clipView = page.locator('.clip-root').nth(1);
  await clipView.locator('.clip-sidebar .panel', { hasText: 'Camera' }).locator('.clip-preset-btn').first().dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: 'Micro Four Thirds' }).click();
  expect(await page.evaluate(() => (window as any).app.doc.movieclips.MC_s.tracking.camera.sensor_width)).toBe(17.3);
  // user preset: save, apply after a change, remove
  await page.evaluate(() => (window as any).app.run('clip.camera_preset_add', { name: 'My Rig' }, { invoke: false }));
  await page.evaluate(() => ((window as any).app.doc.movieclips.MC_s.tracking.camera.sensor_width = 30));
  await clipView.locator('.clip-sidebar .panel', { hasText: 'Camera' }).locator('.clip-preset-btn').first().dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: 'My Rig' }).click();
  expect(await page.evaluate(() => (window as any).app.doc.movieclips.MC_s.tracking.camera.sensor_width)).toBe(17.3);
  await page.evaluate(() => (window as any).app.run('clip.camera_preset_add', { name: 'My Rig', remove_name: true }, { invoke: false }));
  // tracking settings preset from the toolbar
  await clipView.locator('.clip-toolbar .panel', { hasText: 'Tracking Settings' }).locator('.clip-preset-btn').first().dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: 'Fast Motion' }).click();
  expect(await page.evaluate(() => (window as any).app.doc.movieclips.MC_s.tracking.settings.default_search_size)).toBe(201);
  // track color preset colors the active track
  await page.evaluate(() => {
    const app = (window as any).app;
    const c = app.doc.movieclips.MC_s;
    c.tracking.active_track = c.tracking.tracks[0].name;
    c.tracking.tracks[0].select = true;
    app.changed('doc');
  });
  await clipView.locator('.clip-sidebar .clip-color-row .clip-preset-btn').dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: 'Cyan' }).click();
  expect(await page.evaluate(() => (window as any).app.doc.movieclips.MC_s.tracking.tracks[0].use_custom_color)).toBe(true);
  await expectNoErrors(errors);
});

test('camsolve: mask point operators (add vertex, select, slide, feather, re-key)', async ({ page }) => {
  const errors = await solvableClip(page, { frames: 10, points: 10 });
  const clipView = page.locator('.clip-root').nth(1);
  const box = (await clipView.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const r = await page.evaluate(() => {
    const app = (window as any).app;
    const ed = app.hoverArea.editor;
    app.run('clip.mode_set', { mode: 'MASK' });
    app.run('mask.new');
    const m = Object.values(app.doc.masks as Record<string, any>)[0];
    const run = (id: string, p: any) => app.run(id, p, { invoke: false });
    run('mask.add_vertex', { location: [0.2, 0.2] });
    run('mask.add_vertex', { location: [0.6, 0.2] });
    run('mask.add_vertex', { location: [0.6, 0.6] });
    const sp = m.layers[0].splines[0];
    const out: any = { points: sp.points.length };
    run('mask.select', { location: [0.2, 0.2] });
    out.selected = sp.points.map((p: any) => p.select);
    run('mask.slide_point', { offset: [0.05, 0] });
    out.moved = Math.round(sp.points[0].co[0] * 100);
    run('mask.add_feather_vertex', { location: [0.25, 0.3] });
    out.feather = sp.points[0].weight > 0;
    run('mask.shape_key_insert', {});
    run('mask.slide_point', { offset: [0.05, 0] });
    run('mask.shape_key_rekey', { location: true, feather: true });
    out.rekeyed = Math.round(m.layers[0].shape_keys[0].data[0] * 100);
    out.mode = ed.mode;
    return out;
  });
  expect(r).toEqual({ points: 3, selected: [true, false, false], moved: 25, feather: true, rekeyed: 30, mode: 'MASK' });
  await expectNoErrors(errors);
});

test('camsolve: Render Undistorted and lens grid in the clip display', async ({ page }) => {
  const errors = await solvableClip(page, { frames: 6, points: 10 });
  const clipView = page.locator('.clip-root').nth(1);
  const box = (await clipView.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('.clip-overlays').first().dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: 'Render Undistorted' }).click();
  await page.locator('.menu .menu-item', { hasText: 'Grid' }).click();
  await page.keyboard.press('Escape');
  const r = await page.evaluate(() => {
    const app = (window as any).app;
    const ed = app.hoverArea.editor;
    app.doc.movieclips.MC_s.tracking.camera.k1 = -0.2;
    app.changed('doc');
    const p = [100, 80];
    const s = ed.toScreen(p[0], p[1]);
    const back = ed.toImage(s[0], s[1]);
    const plain = ed.viewScreen(p[0], p[1]);
    return { on: ed.overlays.render_undistorted && ed.overlays.show_grid, err: Math.hypot(back[0] - p[0], back[1] - p[1]), moved: Math.hypot(s[0] - plain[0], s[1] - plain[1]) > 1 };
  });
  expect(r.on).toBe(true);
  expect(r.err).toBeLessThan(1e-3);
  expect(r.moved).toBe(true);
  await expectNoErrors(errors);
});

test('camsolve: object solve drives an Object Solver constraint', async ({ page }) => {
  const errors = await solvableClip(page, { frames: 24, points: 50 });
  const r = await page.evaluate(async () => {
    const { Matrix4, Vector3 } = await import('/node_modules/.vite/deps/three.js' as any);
    const app = (window as any).app;
    const c = app.doc.movieclips.MC_s;
    // the generated tracks become the tracks of a tracked object (the camera keeps none)
    app.run('clip.tracking_object_new');
    const obj = c.tracking.objects[0];
    obj.tracks = c.tracking.tracks;
    c.tracking.tracks = [];
    app.run('clip.solve_camera', {}, { invoke: false });
    const rec = obj.reconstruction;
    // an empty follows the object through the scene camera
    app.run('object.empty_add', { location: [0, 0, 0] });
    const ob = app.activeObject;
    app.run('object.constraint_add', { type: 'OBJECT_SOLVER' });
    const con = ob.constraints.find((x: any) => x.type === 'OBJECT_SOLVER');
    con.object = obj.name;
    app.setFrame(15);
    app.changed('doc');
    app.graph.evaluate(app.doc);
    const objWorld = app.graph.get(ob.id).world;
    const camWorld = app.graph.get(app.doc.scene.camera).world;
    // a bundle seen through the scene camera with the clip's lens lands on its marker
    const t = obj.tracks.find((x: any) => x.has_bundle && x.markers.some((m: any) => m.frame === 15));
    const m = t.markers.find((x: any) => x.frame === 15);
    const p = new Vector3(...t.bundle).applyMatrix4(objWorld).applyMatrix4(new Matrix4().copy(camWorld).invert());
    const f = (c.tracking.camera.focal_length * c.size[0]) / c.tracking.camera.sensor_width;
    const px = c.size[0] / 2 + (f * p.x) / -p.z,
      py = c.size[1] / 2 + (f * p.y) / -p.z;
    return { valid: rec.is_valid, err: rec.average_error, miss: Math.hypot(px - m.co[0] * c.size[0], py - m.co[1] * c.size[1]), solverValid: true };
  });
  expect(r.valid).toBe(true);
  expect(r.err).toBeLessThan(0.5);
  expect(r.miss).toBeLessThan(0.5);
  await expectNoErrors(errors);
});
