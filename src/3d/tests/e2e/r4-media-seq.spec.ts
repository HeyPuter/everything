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
