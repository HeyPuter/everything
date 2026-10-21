import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Video Editing workspace with one 100-frame movie-like strip trimmed to frames 20–70. */
async function videoWorkspace(page: Page) {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const U = (p: string) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(p)) ?? p;
    const { shell } = await import(U('/src/ui/shell.ts'));
    const { workspaceTemplates } = await import(U('/src/ui/screen.ts'));
    const S = await import(U('/src/sequencer/strips.ts'));
    shell.addWorkspace(workspaceTemplates.find((t: any) => t.create().name === 'Video Editing').create());
    const app = (window as any).app;
    app.run('sequencer.effect_strip_add', { type: 'COLOR', frame_start: 1, channel: 2, length: 10 }, { invoke: false });
    const ed = app.doc.scene.sequence_editor;
    const m = S.newStrip('MOVIE', 'Clip', 1, 0, 100);
    m.frame_offset_start = 20;
    m.frame_offset_end = 30;
    ed.strips.push(m);
    for (const s of ed.strips) s.select = s === m;
    app.pushUndo('Add Clip');
    app.changed('doc');
  });
  await page.waitForTimeout(200);
  const tl = page.locator('.seq-main').last();
  await tl.hover();
  await page.keyboard.press('Home');
  return { errors, tl };
}

const clip = (page: Page) => page.evaluate(() => {
  const s = (window as any).app.doc.scene.sequence_editor.strips.find((x: any) => x.name === 'Clip');
  return { start: s.frame_start, os: s.frame_offset_start, oe: s.frame_offset_end };
});

test('sequencer: Slip (S) clamps by default, C toggles clamping, Shift slows it down', async ({ page }) => {
  const { errors, tl } = await videoWorkspace(page);
  const box = (await tl.boundingBox())!;
  const ppf = await page.evaluate(() => (window as any).app.hoverArea.editor.ppf);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.keyboard.press('s');
  // far to the right: clamped at 20 frames (the left handle reaches the content start)
  await page.mouse.move(x + ppf * 40, y, { steps: 4 });
  expect((await clip(page)).start).toBe(20);
  // C: unclamped, the content follows the pointer past the handle
  await page.keyboard.press('c');
  await page.mouse.move(x + ppf * 40 + 1, y);
  expect((await clip(page)).start).toBe(40);
  await page.mouse.click(x + ppf * 40 + 1, y);
  expect(await clip(page)).toEqual({ start: 40, os: -20, oe: 70 });
  // Shift: a tenth of the movement
  await page.keyboard.press('Control+z');
  await page.mouse.move(x, y);
  await page.keyboard.press('s');
  await page.keyboard.down('Shift');
  await page.mouse.move(x + ppf * 10, y, { steps: 5 });
  await page.keyboard.up('Shift');
  const slow = (await clip(page)).start;
  expect(slow).toBeGreaterThanOrEqual(0);
  expect(slow).toBeLessThanOrEqual(2);
  await page.keyboard.press('Escape');
  expect((await clip(page)).start).toBe(0);
  await expectNoErrors(errors);
});

test('sequencer preview: Transform tool moves from inside the frame and scales from a corner', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const U = (p: string) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(p)) ?? p;
    const { shell } = await import(U('/src/ui/shell.ts'));
    const { workspaceTemplates } = await import(U('/src/ui/screen.ts'));
    shell.addWorkspace(workspaceTemplates.find((t: any) => t.create().name === 'Video Editing').create());
    const app = (window as any).app;
    app.run('sequencer.effect_strip_add', { type: 'COLOR', frame_start: 1, channel: 1, length: 40 }, { invoke: false });
    const s = app.doc.scene.sequence_editor.strips[0];
    s.transform.scale_x = s.transform.scale_y = 0.5;
    s.select = true;
    app.doc.scene.sequence_editor.active_strip = s.name;
    app.pushUndo('setup');
    app.changed('doc');
    const ed = shell.screen.areas.find((a: any) => a.type === 'SEQUENCE_EDITOR' && a.editor.hasPreview())?.editor;
    ed.pvTool = 'transform';
    ed.drawToolbars();
  });
  await page.waitForTimeout(300);
  const tf = () => page.evaluate(() => ({ ...(window as any).app.doc.scene.sequence_editor.strips[0].transform }));
  const pv = (await page.locator('.seq-pv').first().boundingBox())!;
  await page.mouse.move(pv.x + pv.width / 2, pv.y + pv.height / 2);
  const box = await page.evaluate(() => {
    const ed = (window as any).app.hoverArea.editor;
    const r = ed.preview.cageRect();
    const b = ed.preview.el.getBoundingClientRect();
    return { x0: b.left + r.x0, y0: b.top + r.y0, x1: b.left + r.x1, y1: b.top + r.y1 };
  });
  // inside: move
  await page.mouse.move((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2);
  await page.mouse.down();
  await page.mouse.move((box.x0 + box.x1) / 2 + 20, (box.y0 + box.y1) / 2, { steps: 3 });
  await page.mouse.move((box.x0 + box.x1) / 2 + 40, (box.y0 + box.y1) / 2, { steps: 3 });
  await page.mouse.up();
  const t1 = await tf();
  expect(t1.offset_x).toBeGreaterThan(10);
  expect(t1.scale_x).toBeCloseTo(0.5, 3);
  // corner: scale up
  const b2 = await page.evaluate(() => {
    const ed = (window as any).app.hoverArea.editor;
    const r = ed.preview.cageRect();
    const b = ed.preview.el.getBoundingClientRect();
    return { x: b.left + r.x1, y: b.top + r.y1 };
  });
  await page.mouse.move(b2.x, b2.y);
  await page.mouse.down();
  await page.mouse.move(b2.x + 20, b2.y + 15, { steps: 3 });
  await page.mouse.move(b2.x + 40, b2.y + 30, { steps: 3 });
  await page.mouse.up();
  const t2 = await tf();
  expect(t2.scale_x).toBeGreaterThan(0.55);
  await expectNoErrors(errors);
});

test('sequencer: moving a strip shows where it snaps', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const U = (p: string) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(p)) ?? p;
    const { shell } = await import(U('/src/ui/shell.ts'));
    const { workspaceTemplates } = await import(U('/src/ui/screen.ts'));
    shell.addWorkspace(workspaceTemplates.find((t: any) => t.create().name === 'Video Editing').create());
    const app = (window as any).app;
    app.run('sequencer.effect_strip_add', { type: 'COLOR', frame_start: 1, channel: 1, length: 20 }, { invoke: false });
    app.run('sequencer.effect_strip_add', { type: 'COLOR', frame_start: 40, channel: 2, length: 20 }, { invoke: false });
    app.run('sequencer.select_all', { action: 'DESELECT' });
    const s = app.doc.scene.sequence_editor.strips[1];
    s.select = true;
    app.doc.scene.tool_settings.use_snap_sequencer = true;
  });
  const tl = page.locator('.seq-main').last();
  await tl.hover();
  await page.keyboard.press('Home');
  const ppf = await page.evaluate(() => (window as any).app.hoverArea.editor.ppf);
  const b = (await tl.boundingBox())!;
  const x = b.x + b.width / 2,
    y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.keyboard.press('g');
  // 40 → 21: one frame from the end of the first strip, which it snaps to
  await page.mouse.move(x - ppf * 19, y, { steps: 5 });
  const lines = await page.evaluate(() => (window as any).app.hoverArea.editor.snapLines);
  expect(lines).toEqual([21]);
  await page.mouse.click(x - ppf * 19, y);
  expect(await page.evaluate(() => (window as any).app.doc.scene.sequence_editor.strips[1].frame_start)).toBe(21);
  expect(await page.evaluate(() => (window as any).app.hoverArea.editor.snapLines)).toEqual([]);
  await expectNoErrors(errors);
});

test('sequencer: overlay popover toggles grid, colour tags, retiming, curves and the waveform style', async ({ page }) => {
  const { errors, tl } = await videoWorkspace(page);
  await tl.hover();
  const btn = page.locator('.hdr-icondrop[data-tip="Overlays"]').last();
  await btn.dispatchEvent('pointerdown');
  for (const label of ['Grid', 'Color Tags', 'Retiming', 'Animation Curves']) await page.locator('.popup-layer label', { hasText: new RegExp(`^${label}$`) }).first().click();
  await page.locator('.popup-layer .enum-row button', { hasText: 'Half' }).first().click();
  await page.locator('.popup-layer .enum-row button', { hasText: /^Off$/ }).first().click();
  const st = await page.evaluate(() => {
    const ed = (window as any).app.hoverArea.editor;
    return ed.serialize();
  });
  expect([st.showGrid, st.showColorTags, st.showRetiming, st.showFcurves]).toEqual([false, false, false, false]);
  expect([st.waveformType, st.waveformStyle]).toEqual(['NO_WAVEFORMS', 'HALF_WAVEFORMS']);
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('sequencer preview: safe areas follow the scene margins; composition guides draw over the frame', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const U = (p: string) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(p)) ?? p;
    const { shell } = await import(U('/src/ui/shell.ts'));
    const { workspaceTemplates } = await import(U('/src/ui/screen.ts'));
    shell.addWorkspace(workspaceTemplates.find((t: any) => t.create().name === 'Video Editing').create());
    (window as any).app.run('sequencer.effect_strip_add', { type: 'COLOR', frame_start: 1, channel: 1, length: 40 }, { invoke: false });
  });
  await page.waitForTimeout(300);
  const pv = (await page.locator('.seq-pv').first().boundingBox())!;
  await page.mouse.move(pv.x + pv.width / 2, pv.y + pv.height / 2);
  await page.evaluate(() => {
    const ed = (window as any).app.hoverArea.editor;
    ed.showSidebar = true;
    ed.sidebarTab = 'view';
    ed.layout?.();
    ed.refresh?.();
  });
  await page.locator('[data-id="seq-safe-show"]').first().click();
  await page.locator('.panel-header', { hasText: 'Composition Guides' }).first().click();
  await page.locator('[data-id="seq-cg-show_composition_thirds"]').first().click();
  const st = await page.evaluate(() => {
    const ed = (window as any).app.hoverArea.editor;
    return { safe: ed.preview.opts.safeAreas, thirds: ed.preview.composition.show_composition_thirds, saved: ed.serialize().previewGuides.show_composition_thirds };
  });
  expect(st).toEqual({ safe: true, thirds: true, saved: true });
  await expectNoErrors(errors);
});

test('sequencer preview: View Settings ▸ Channel previews only the channels up to it', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const U = (p: string) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(p)) ?? p;
    const { shell } = await import(U('/src/ui/shell.ts'));
    const { workspaceTemplates } = await import(U('/src/ui/screen.ts'));
    shell.addWorkspace(workspaceTemplates.find((t: any) => t.create().name === 'Video Editing').create());
    const app = (window as any).app;
    app.run('sequencer.effect_strip_add', { type: 'COLOR', frame_start: 1, channel: 1, length: 40, color: [1, 0, 0] }, { invoke: false });
    app.run('sequencer.effect_strip_add', { type: 'COLOR', frame_start: 1, channel: 2, length: 40, color: [0, 1, 0] }, { invoke: false });
    app.setFrame(5);
  });
  await page.waitForTimeout(400);
  const pv = (await page.locator('.seq-pv').first().boundingBox())!;
  await page.mouse.move(pv.x + pv.width / 2, pv.y + pv.height / 2);
  const sample = () =>
    page.evaluate(([x, y]) => {
      const ed = (window as any).app.hoverArea.editor;
      return ed.preview.sample(x, y)?.rgba.slice(0, 3).map((v: number) => Math.round(v * 255) > 128);
    }, [pv.x + pv.width / 2, pv.y + pv.height / 2] as const);
  expect(await sample()).toEqual([false, true, false]);
  await page.evaluate(() => {
    const ed = (window as any).app.hoverArea.editor;
    ed.preview.displayChannel = 1;
    ed.preview.request();
  });
  await page.waitForTimeout(400);
  expect(await sample()).toEqual([true, false, false]);
  await expectNoErrors(errors);
});

test('sequencer preview: rendered frames stay in the Final cache until something changes', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const U = (p: string) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(p)) ?? p;
    const { shell } = await import(U('/src/ui/shell.ts'));
    const { workspaceTemplates } = await import(U('/src/ui/screen.ts'));
    shell.addWorkspace(workspaceTemplates.find((t: any) => t.create().name === 'Video Editing').create());
    const app = (window as any).app;
    app.run('sequencer.effect_strip_add', { type: 'COLOR', frame_start: 1, channel: 1, length: 40, color: [1, 0, 0] }, { invoke: false });
  });
  const pv = (await page.locator('.seq-pv').first().boundingBox())!;
  await page.mouse.move(pv.x + pv.width / 2, pv.y + pv.height / 2);
  const cached = () => page.evaluate(() => (window as any).app.hoverArea.editor.preview.cachedFrames().sort((a: number, b: number) => a - b));
  for (const f of [5, 6, 7]) {
    await page.evaluate((f) => (window as any).app.setFrame(f), f);
    await page.waitForTimeout(250);
  }
  expect(await cached()).toEqual(expect.arrayContaining([5, 6, 7]));
  // an edit drops them
  await page.evaluate(() => {
    const app = (window as any).app;
    app.doc.scene.sequence_editor.strips[0].color = [0, 0, 1];
    app.changed('doc');
  });
  await page.waitForTimeout(250);
  expect((await cached()).length).toBeLessThanOrEqual(1);
  // switched off: nothing is kept
  await page.evaluate(() => {
    const app = (window as any).app;
    app.doc.scene.sequence_editor.use_cache_final = false;
    app.changed('doc');
    app.setFrame(9);
  });
  await page.waitForTimeout(250);
  expect(await cached()).toEqual([]);
  await expectNoErrors(errors);
});
