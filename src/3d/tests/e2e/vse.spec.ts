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

/** A 4 second sound strip generated in the page (frames 1–97 at 24 fps). */
async function addTone(page: Page) {
  await page.evaluate(async () => {
    const { encodeWav } = await import('/src/sequencer/wav.ts' as any);
    const { addSound } = await import('/src/sequencer/add.ts' as any);
    const n = 48000 * 4;
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = Math.sin(i * 0.05) * 0.5;
    await addSound(new File([encodeWav([d], 48000)], 'tone.wav', { type: 'audio/wav' }), 1, 3);
    const app = (window as any).app;
    app.pushUndo('Add Sound');
    app.changed('doc');
  });
}

test('sequencer: retiming — set speed (R), freeze frame from the I menu, keys shown, selected and deleted', async ({ page }) => {
  const { errors, tl } = await videoWorkspace(page);
  await addTone(page);
  const len = () => page.evaluate(() => (window as any).app.doc.scene.sequence_editor.strips.find((s: any) => s.type === 'SOUND').frame_duration);
  const base = await len();
  await tl.hover();
  await page.keyboard.press('Home');
  await page.keyboard.press('r');
  await expect(page.locator('.popup-layer .pop-title', { hasText: 'Set Speed' })).toBeVisible();
  await page.evaluate(() => (window as any).app.redoLast({ speed: 50 }));
  expect(await len()).toBe(base * 2);
  await page.keyboard.press('Escape');
  // freeze frame at frame 30
  await page.evaluate(() => (window as any).app.setFrame(30));
  await tl.hover();
  await page.keyboard.press('i');
  await menuItem(page, 'Add Freeze Frame').click();
  expect(await len()).toBe(base * 2 + 12);
  const keys = () => page.evaluate(() => (window as any).app.doc.scene.sequence_editor.strips.find((s: any) => s.type === 'SOUND').retiming_keys);
  expect((await keys()).length).toBe(4);
  // click the freeze end key (diamond at the strip bottom) and delete it
  const p = await page.evaluate(() => {
    const app = (window as any).app;
    const ed = app.hoverArea.editor;
    const s = app.doc.scene.sequence_editor.strips.find((x: any) => x.type === 'SOUND');
    const r = ed.stripRect(s);
    const c = document.querySelectorAll('.seq-main canvas');
    const b = (c[c.length - 1] as HTMLElement).getBoundingClientRect();
    return { x: b.left + ed.fx(s.frame_start + s.retiming_keys[2].frame), y: b.top + r.y1 - 6 };
  });
  await page.mouse.click(p.x, p.y);
  expect((await keys())[2].select).toBe(true);
  await page.keyboard.press('x');
  expect((await keys()).length).toBe(3);
  await page.keyboard.press('Control+z');
  expect((await keys()).length).toBe(4);
  await expectNoErrors(errors);
});

test('sequencer: text strips are edited in place in the preview', async ({ page }) => {
  const { errors } = await videoWorkspace(page);
  const text = () => page.evaluate(() => (window as any).app.doc.scene.sequence_editor.strips.find((s: any) => s.type === 'TEXT').text);
  const pv = (await page.locator('.seq-pv').first().boundingBox())!;
  // double click on the text starts editing at the clicked spot
  await page.mouse.dblclick(pv.x + pv.width / 2, pv.y + pv.height / 2);
  await page.keyboard.press('End');
  await page.keyboard.type(' one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  expect(await text()).toBe('Text one\ntwo');
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Backspace');
  expect((await text()).length).toBeLessThan('Text one\ntwo'.length);
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Title');
  expect(await text()).toBe('Title');
  await page.keyboard.press('Tab');
  // leaving edit mode: keys work as shortcuts again (G starts a move in the preview)
  expect(await page.evaluate(() => (window as any).app.poll('sequencer.text_insert'))).toBe(false);
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+z');
  expect(await text()).not.toBe('Title');
  await expectNoErrors(errors);
});

test('sequencer: timeline moves can be adjusted afterwards (redo panel)', async ({ page }) => {
  const { errors, tl } = await videoWorkspace(page);
  const p = await stripPoint(page, 'Color.002');
  await page.mouse.click(p.x, p.y);
  await page.keyboard.press('g');
  await page.mouse.move(p.x + 60, p.y, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).app.lastOp?.idname)).toBe('transform.seq_slide');
  await expect(tl.locator('.redo-panel')).toBeVisible();
  await page.evaluate(() => (window as any).app.redoLast({ value: [7, 1] }));
  const s = await page.evaluate(() => (window as any).app.doc.scene.sequence_editor.strips.find((x: any) => x.name === 'Color.002'));
  expect([s.frame_start, s.channel]).toEqual([107, 2]);
  await expectNoErrors(errors);
});

test('sequencer: preview transforms with axis constraint, pivot, mirror and the 2D cursor', async ({ page }) => {
  const { errors } = await videoWorkspace(page);
  const pv = (await page.locator('.seq-pv').first().boundingBox())!;
  const cx = pv.x + pv.width / 2,
    cy = pv.y + pv.height / 2;
  const tr = () => page.evaluate(() => (window as any).app.doc.scene.sequence_editor.strips.find((x: any) => x.name === 'Text').transform);
  // select the text in the preview and move it along X only
  await page.mouse.click(cx, cy);
  await page.keyboard.press('g');
  await page.keyboard.press('x');
  await page.mouse.move(cx + 50, cy + 40, { steps: 4 });
  await page.mouse.down();
  await page.mouse.up();
  let t = await tr();
  expect(t.offset_x).toBeGreaterThan(50);
  expect(t.offset_y).toBe(0);
  await page.evaluate(() => (window as any).app.redoLast({ value: [100, 20, 0] }));
  t = await tr();
  expect([t.offset_x, t.offset_y]).toEqual([100, 20]);
  // 2D cursor tool, pivot pie on the cursor, then rotate by a typed value around it
  await page.locator('.seq-pv-toolbar [data-tip^="Cursor"]').first().click();
  await page.mouse.click(pv.x + 20, pv.y + pv.height - 20);
  const cur = await page.evaluate(() => (window as any).app.doc.scene.tool_settings.sequencer_tool_settings.cursor_location);
  expect(cur[0]).toBeLessThan(-800);
  await page.mouse.move(cx, cy);
  await page.keyboard.press('Period');
  await page.locator('.pie-item', { hasText: '2D Cursor' }).click();
  expect(await page.evaluate(() => (window as any).app.doc.scene.tool_settings.sequencer_tool_settings.pivot_point)).toBe('CURSOR');
  await page.keyboard.press('r');
  await page.keyboard.type('90');
  await page.keyboard.press('Enter');
  t = await tr();
  expect(t.rotation).toBeCloseTo(Math.PI / 2, 4);
  // around the cursor (far bottom-left) the image centre moves a long way
  expect(Math.abs(t.offset_x - 100) + Math.abs(t.offset_y - 20)).toBeGreaterThan(500);
  // mirror on X flips the image
  await page.keyboard.press('Control+m');
  await menuItem(page, 'X Axis').click();
  expect(await page.evaluate(() => (window as any).app.doc.scene.sequence_editor.strips.find((x: any) => x.name === 'Text').use_flip_x)).toBe(true);
  await expectNoErrors(errors);
});

test('sequencer: blade tool splits on click and cuts out a box on drag', async ({ page }) => {
  const { errors } = await videoWorkspace(page);
  await page.locator('.seq-toolbar [data-tip^="Blade"]').last().click();
  const a = await stripPoint(page, 'Color', 0.5);
  await page.mouse.click(a.x, a.y);
  expect((await strips(page)).length).toBe(5);
  // drag across Color.001 on channel 1: the middle goes, the gap closes
  const l = await stripPoint(page, 'Color.001', 0.25);
  const r = await stripPoint(page, 'Color.001', 0.75);
  await page.mouse.move(l.x, l.y);
  await page.mouse.down();
  await page.mouse.move(r.x, r.y + 5, { steps: 4 });
  await page.mouse.up();
  const ch1 = await page.evaluate(() => (window as any).app.doc.scene.sequence_editor.strips.filter((s: any) => s.channel === 1).map((s: any) => [s.frame_start + s.frame_offset_start, s.frame_start + s.frame_duration - s.frame_offset_end]).sort((x: number[], y: number[]) => x[0] - y[0]));
  const total = ch1.reduce((n: number, [x, y]: number[]) => n + (y - x), 0);
  expect(total).toBeLessThan(100);
  expect(ch1.length).toBe(5);
  await expectNoErrors(errors);
});

test('sequencer: frame overlay (O sets the reference, Shift O toggles) and the View sidebar tab', async ({ page }) => {
  const { errors, tl } = await videoWorkspace(page);
  await tl.hover();
  await page.keyboard.press('o');
  const ed = () => page.evaluate(() => {
    const e = (window as any).app.doc.scene.sequence_editor;
    return [e.show_overlay_frame, e.overlay_frame, e.use_overlay_frame_lock];
  });
  expect(await ed()).toEqual([true, 1, true]);
  await page.keyboard.press('Shift+o');
  expect((await ed())[0]).toBe(false);
  await page.keyboard.press('n');
  await page.locator('.seq-sb .sb-tab', { hasText: 'View' }).last().click();
  await expect(page.locator('.seq-sb .panel', { hasText: 'Frame Overlay' }).last()).toBeVisible();
  await expectNoErrors(errors);
});

test('sequencer: Move Origin (Ctrl .) moves the pivot without moving the image', async ({ page }) => {
  const { errors } = await videoWorkspace(page);
  const pv = (await page.locator('.seq-pv').first().boundingBox())!;
  const cx = pv.x + pv.width / 2,
    cy = pv.y + pv.height / 2;
  await page.mouse.click(cx, cy);
  await page.evaluate(() => {
    const s = (window as any).app.doc.scene.sequence_editor.strips.find((x: any) => x.name === 'Text');
    s.transform.rotation = 0.5;
    s.transform.scale_x = 1.5;
    (window as any).app.pushUndo('setup');
  });
  const corners = () =>
    page.evaluate(async () => {
      const T = await import('/src/sequencer/transform.ts' as any);
      const s = (window as any).app.doc.scene.sequence_editor.strips.find((x: any) => x.name === 'Text');
      return { c: T.stripImageCorners(s, 1920, 1080).flat(), o: [...s.transform.origin] };
    });
  const before = await corners();
  await page.keyboard.press('Control+Period');
  await page.mouse.move(cx + 60, cy - 30, { steps: 3 });
  await page.mouse.down();
  await page.mouse.up();
  const after = await corners();
  after.c.forEach((v: number, i: number) => expect(v).toBeCloseTo(before.c[i], 3));
  expect(Math.abs(after.o[0] - before.o[0]) + Math.abs(after.o[1] - before.o[1])).toBeGreaterThan(0.01);
  await expectNoErrors(errors);
});

test('sequencer: keyframes on strips (I in the preview) animate the image between frames', async ({ page }) => {
  const { errors } = await videoWorkspace(page);
  const pv = (await page.locator('.seq-pv').first().boundingBox())!;
  const cx = pv.x + pv.width / 2,
    cy = pv.y + pv.height / 2;
  await page.mouse.click(cx, cy);
  await page.keyboard.press('i');
  await page.evaluate(() => {
    const app = (window as any).app;
    app.setFrame(21);
    app.flush();
    app.doc.scene.sequence_editor.strips.find((x: any) => x.name === 'Text').transform.offset_x = 200;
  });
  await page.mouse.move(cx, cy);
  await page.keyboard.press('i');
  const ox = (f: number) =>
    page.evaluate((f) => {
      const app = (window as any).app;
      app.setFrame(f);
      app.flush();
      return app.doc.scene.sequence_editor.strips.find((x: any) => x.name === 'Text').transform.offset_x;
    }, f);
  expect(await ox(11)).toBeCloseTo(100, 3);
  expect(await ox(1)).toBeCloseTo(0, 3);
  // Alt I removes the key at the frame
  await page.evaluate(() => ((window as any).app.setFrame(21), (window as any).app.flush()));
  await page.mouse.move(cx, cy);
  await page.keyboard.press('Alt+i');
  expect(await page.evaluate(() => (window as any).app.doc.scene.sequence_editor.strips.find((x: any) => x.name === 'Text').keys['transform.offset_x'].length)).toBe(1);
  await expectNoErrors(errors);
});

test('sequencer: a text strip can use an embedded font file', async ({ page }) => {
  const { errors } = await videoWorkspace(page);
  const loaded = await page.evaluate(async () => {
    const res = await fetch('/node_modules/@fontsource/inter/files/inter-latin-700-normal.woff');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const app = (window as any).app;
    const s = app.doc.scene.sequence_editor.strips.find((x: any) => x.name === 'Text');
    s.font_file = { filepath: 'heavy.woff', mime: 'font/woff', bytes };
    app.changed('doc');
    const { fontFor } = await import('/src/sequencer/text.ts' as any);
    const css = fontFor(s, 40);
    await document.fonts.ready;
    await new Promise((r) => setTimeout(r, 300));
    return { css, ok: [...document.fonts].some((f: any) => f.family.includes('seqfont') && f.status === 'loaded') };
  });
  expect(loaded.css).toMatch(/seqfont\d+/);
  expect(loaded.ok).toBe(true);
  await expectNoErrors(errors);
});

test('sequencer: Curves strip modifier brightens through its curve', async ({ page }) => {
  const { errors } = await videoWorkspace(page);
  await page.evaluate(() => {
    const app = (window as any).app;
    const ed = app.doc.scene.sequence_editor;
    for (const s of ed.strips) s.select = false;
    const c = ed.strips.find((x: any) => x.name === 'Color');
    c.color = [0.5, 0.5, 0.5];
    c.select = true;
    ed.active_strip = 'Color';
    ed.strips.find((x: any) => x.name === 'Text').mute = true;
    app.run('sequencer.strip_modifier_add', { type: 'CURVES' });
    c.modifiers[0].curve_mapping.curve_0 = [0, 0, 0, 0.5, 0.9, 0, 1, 1, 0];
    app.changed('doc');
  });
  await page.waitForTimeout(800);
  const pv = (await page.locator('.seq-pv').first().boundingBox())!;
  await page.mouse.move(pv.x + pv.width / 2, pv.y + pv.height / 2);
  const v = await page.evaluate(([x, y]) => (window as any).app.hoverArea.editor.preview.sample(x, y)?.rgba[0], [pv.x + 40, pv.y + pv.height / 2] as const);
  expect(v).toBeGreaterThan(0.85);
  await expectNoErrors(errors);
});
