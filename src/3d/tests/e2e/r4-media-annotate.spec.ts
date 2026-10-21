import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function imageEditor(page: Page) {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const U = (p: string) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes(p)) ?? p;
    const { shell } = await import(U('/src/ui/shell.ts'));
    const app = (window as any).app;
    app.run('image.new', { name: 'Img', width: 256, height: 256, generated_type: 'BLANK' }, { invoke: false });
    const area = shell.screen.areas.find((a: any) => a.type === 'VIEW_3D');
    area.setType('IMAGE_EDITOR');
    area.editor.showImage(Object.keys(app.doc.images).pop());
  });
  await page.waitForTimeout(200);
  const box = (await page.locator('.ie-root').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return { errors, box };
}

const notes = (page: Page) => page.evaluate(() => ((window as any).app.hoverArea.editor.annotationOwner()?.annotations_2d ?? []).map((s: any) => s.points.length / 2));

test('image editor: Annotate tools draw freehand and straight notes on the image; the eraser removes them; undo works', async ({ page }) => {
  const { errors, box } = await imageEditor(page);
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  await page.locator('[data-tool="annotate"]').dispatchEvent('pointerdown');
  await page.mouse.move(cx - 60, cy);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(cx - 60 + i * 10, cy + (i % 2) * 6);
  await page.mouse.up();
  expect((await notes(page)).length).toBe(1);
  expect((await notes(page))[0]).toBeGreaterThan(3);
  // D + Alt drag: a straight line, with any tool
  await page.locator('[data-tool="sample"]').dispatchEvent('pointerdown');
  await page.mouse.move(cx - 50, cy + 40);
  await page.keyboard.down('d');
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(cx, cy + 40, { steps: 3 });
  await page.mouse.move(cx + 50, cy + 40, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.keyboard.up('d');
  expect(await notes(page)).toEqual([expect.any(Number), 2]);
  // eraser through the middle of the line
  await page.evaluate(() => {
    const e = (window as any).app.hoverArea.editor;
    e.viewTool = 'annotate_eraser';
    e.drawUI();
  });
  await page.mouse.move(cx, cy + 30);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 50, { steps: 4 });
  await page.mouse.up();
  expect((await notes(page)).length).toBe(1);
  await page.keyboard.press('Control+z');
  expect((await notes(page)).length).toBe(2);
  // notes are kept on the image: the sidebar panel clears them
  await page.evaluate(() => {
    const e = (window as any).app.hoverArea.editor;
    e.showSidebar = true;
    e.sidebarTab = 'View';
    e.drawUI();
  });
  await page.locator('.ie-sidebar button', { hasText: 'Clear Annotations' }).click();
  expect(await notes(page)).toEqual([]);
  await expectNoErrors(errors);
});

test('sequencer preview: D drag annotates the scene', async ({ page }) => {
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
  const cx = pv.x + pv.width / 2,
    cy = pv.y + pv.height / 2;
  await page.mouse.move(cx, cy);
  await page.keyboard.down('d');
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy + 10, { steps: 4 });
  await page.mouse.move(cx + 60, cy, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('d');
  const n = await page.evaluate(() => ((window as any).app.doc.scene.annotations_2d ?? []).length);
  expect(n).toBe(1);
  await expectNoErrors(errors);
});
