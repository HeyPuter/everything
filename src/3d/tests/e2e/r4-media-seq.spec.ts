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
