import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Video Editing workspace with three colour strips (two touching on channel 1) and a text strip. */
async function videoWorkspace(page: Page) {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const { shell } = await import('/src/ui/shell.ts' as any);
    const { workspaceTemplates } = await import('/src/ui/screen.ts' as any);
    shell.addWorkspace(workspaceTemplates.find((t: any) => t.create().name === 'Video Editing').create());
    const app = (window as any).app;
    const add = (type: string, frame_start: number, channel: number, length: number) => app.run('sequencer.effect_strip_add', { type, frame_start, channel, length }, { invoke: false });
    add('COLOR', 1, 1, 40);
    add('COLOR', 41, 1, 40);
    add('TEXT', 1, 2, 40);
    add('COLOR', 100, 1, 20);
    app.run('sequencer.select_all', { action: 'DESELECT' });
  });
  await page.waitForTimeout(200);
  const tl = page.locator('.seq-main').last();
  await tl.hover();
  await page.keyboard.press('Home');
  return { errors, tl };
}

const strips = (page: Page) => page.evaluate(() => (window as any).app.doc.scene.sequence_editor.strips.map((s: any) => ({ name: s.name, select: s.select, l: s.select_left_handle, r: s.select_right_handle, tag: s.color_tag, keys: s.keys, connections: s.connections })));
const menuItem = (page: Page, label: string) => page.locator('.popup-layer .menu-item', { has: page.locator('.mi-label', { hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) }) }).last();
const selected = async (page: Page) => (await strips(page)).filter((s: any) => s.select).map((s: any) => s.name).sort();

/** Client point in the middle of a strip (timeline). */
function stripPoint(page: Page, name: string, at = 0.5) {
  return page.evaluate(
    ([name, at]) => {
      const ed = (window as any).app.hoverArea.editor;
      const s = ed.constructor && (window as any).app.doc.scene.sequence_editor.strips.find((x: any) => x.name === name);
      const r = ed.stripRect(s);
      const c = document.querySelectorAll('.seq-main canvas');
      const b = (c[c.length - 1] as HTMLElement).getBoundingClientRect();
      return { x: b.left + r.x0 + (r.x1 - r.x0) * (at as number), y: b.top + (r.y0 + r.y1) / 2 };
    },
    [name, at] as const,
  );
}

test('sequencer: select menu entries, more/less, linked and handles', async ({ page }) => {
  const { errors } = await videoWorkspace(page);
  const p = await stripPoint(page, 'Color');
  await page.mouse.click(p.x, p.y);
  expect(await selected(page)).toEqual(['Color']);
  await page.keyboard.press('Control+NumpadAdd');
  expect(await selected(page)).toEqual(['Color', 'Color.001']);
  // less: a selected strip touching an unselected one is dropped
  const b = await stripPoint(page, 'Color.001');
  await page.mouse.click(b.x, b.y);
  await page.keyboard.press('Control+NumpadSubtract');
  expect(await selected(page)).toEqual([]);
  // L picks the chain of touching strips under the pointer
  await page.keyboard.press('Alt+a');
  await page.mouse.move(p.x, p.y);
  await page.keyboard.press('l');
  expect(await selected(page)).toEqual(['Color', 'Color.001']);
  // Select ▸ Handle ▸ Right Neighbor selects the shared edit point
  await page.mouse.click(p.x, p.y);
  await page.locator('.seq-hdr').last().locator('.hdr-menu', { hasText: /^Select$/ }).dispatchEvent('pointerdown');
  await menuItem(page, 'Handle').hover();
  await menuItem(page, 'Right Neighbor').click();
  const s = await strips(page);
  expect(s.find((x: any) => x.name === 'Color')!.r).toBe(true);
  expect(s.find((x: any) => x.name === 'Color.001')!.l).toBe(true);
  await expectNoErrors(errors);
});

test('sequencer: ctrl click selects strips sharing the time range, ctrl click on empty space selects a side', async ({ page }) => {
  const { errors } = await videoWorkspace(page);
  const p = await stripPoint(page, 'Color');
  await page.keyboard.down('Control');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up('Control');
  expect(await selected(page)).toEqual(['Color', 'Text']);
  // empty space right of the playhead
  await page.evaluate(() => (window as any).app.setFrame(30));
  const q = await stripPoint(page, 'Color.002');
  await page.keyboard.down('Control');
  await page.mouse.click(q.x, q.y - 120);
  await page.keyboard.up('Control');
  expect(await selected(page)).toEqual(['Color.001', 'Color.002']);
  await expectNoErrors(errors);
});

test('sequencer: connected strips select together, fades and colour tags from menus', async ({ page }) => {
  const { errors } = await videoWorkspace(page);
  const a = await stripPoint(page, 'Color');
  const t = await stripPoint(page, 'Text');
  await page.mouse.click(a.x, a.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(t.x, t.y);
  await page.keyboard.up('Shift');
  await page.keyboard.press('Control+Alt+c');
  expect((await strips(page)).find((x: any) => x.name === 'Color')!.connections).toEqual(['Text']);
  // clicking one now selects both; Alt click ignores the connection
  await page.mouse.click(a.x + 200, a.y - 120);
  await page.mouse.click(a.x, a.y);
  expect(await selected(page)).toEqual(['Color', 'Text']);
  await page.keyboard.down('Alt');
  await page.mouse.click(a.x, a.y);
  await page.keyboard.up('Alt');
  expect(await selected(page)).toEqual(['Color']);
  // context menu: fade in and out, colour tag
  await page.mouse.click(a.x, a.y, { button: 'right' });
  await menuItem(page, 'Fade').hover();
  await menuItem(page, 'Fade In and Out').click();
  const keys = (await strips(page)).find((x: any) => x.name === 'Color')!.keys.blend_alpha;
  expect([keys[0], keys[keys.length - 1]]).toEqual([
    [1, 0],
    [41, 0],
  ]);
  await page.mouse.click(a.x, a.y, { button: 'right' });
  await menuItem(page, 'Set Color Tag').hover();
  await menuItem(page, 'Color 04').click();
  expect((await strips(page)).find((x: any) => x.name === 'Color')!.tag).toBe('COLOR_04');
  await page.keyboard.press('Control+z');
  expect((await strips(page)).find((x: any) => x.name === 'Color')!.tag).toBe('NONE');
  await expectNoErrors(errors);
});

test('sequencer: circle select (C) and box select with handles (Ctrl B)', async ({ page }) => {
  const { errors } = await videoWorkspace(page);
  const a = await stripPoint(page, 'Color.001');
  await page.mouse.move(a.x, a.y);
  await page.keyboard.press('c');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press('Escape');
  expect(await selected(page)).toEqual(['Color.001']);
  await page.keyboard.press('Alt+a');
  // a box around the left edge of Color.001 selects its left handle only
  const l = await stripPoint(page, 'Color.001', 0);
  await page.mouse.move(l.x, l.y);
  await page.keyboard.press('Control+b');
  await page.mouse.move(l.x - 3, l.y - 10);
  await page.mouse.down();
  await page.mouse.move(l.x + 3, l.y + 10, { steps: 3 });
  await page.mouse.up();
  const s = (await strips(page)).filter((x: any) => x.select);
  expect(s.map((x: any) => [x.name, x.l, x.r])).toEqual([
    ['Color', false, true],
    ['Color.001', true, false],
  ]);
  await expectNoErrors(errors);
});
