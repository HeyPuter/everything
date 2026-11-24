import { expect, test } from '@playwright/test';
import { openApp, waitForFeature } from './helpers';

test('makes a drawing with standard views and exports a PDF', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  const paper = page.getByRole('img', { name: 'Drawing sheet' });
  await expect(paper).toBeVisible();
  // Front, top, right and isometric views are projected by the geometry engine.
  await expect(page.locator('.relations-list > *')).toHaveCount(4, { timeout: 30_000 });
  await expect(paper.locator('svg path').first()).toBeAttached({ timeout: 30_000 });
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Bracket, rev B');
  await page.getByRole('textbox', { name: 'Title', exact: true }).press('Tab');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Mounting Bracket.pdf');
  expect(await file.failure()).toBeNull();
  // The document's title is the title block's, as on the sheet (UTF-16 hex in the PDF).
  const fs = await import('node:fs');
  const pdf = new TextDecoder('latin1').decode(fs.readFileSync(await file.path()));
  const hex = `FEFF${[...'Bracket, rev B'].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()).join('')}`;
  expect(pdf).toContain(`/Title <${hex}>`);
  const svgDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'SVG', exact: true }).click();
  const svg = new TextDecoder().decode(fs.readFileSync(await (await svgDownload).path()));
  expect(svg).toContain('<title>Bracket, rev B</title>');
  await page.getByRole('tab', { name: 'Model' }).click();
  await expect(page.locator('canvas.gl')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a view added while the others are still being projected is drawn too', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  const pending = await page.evaluate(async () => {
    type Ws = { pending: boolean; addView(kind: string): void };
    const app = (window as unknown as { __parametric: { openDrawing(): void; drawing: Ws } }).__parametric;
    app.openDrawing();
    const t0 = performance.now();
    while (!app.drawing.pending && performance.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 1));
    app.drawing.addView('back');
    return app.drawing.pending;
  });
  expect(pending).toBe(true);
  await expect(page.locator('.paper g[data-view]')).toHaveCount(5);
  await expect(page.locator('.paper g[data-view="v5"] path').first()).toBeAttached();
  // Placed in free room, not on top of the views that were still being projected.
  const frames = await page.evaluate(() => (window as unknown as { __parametric: { drawing: { frames: { id: string; x0: number; y0: number; x1: number; y1: number }[] } } }).__parametric.drawing.frames);
  const added = frames.find((f) => f.id === 'v5')!;
  for (const f of frames.filter((q) => q !== added)) expect(added.x0 < f.x1 && added.x1 > f.x0 && added.y0 < f.y1 && added.y1 > f.y0, f.id).toBe(false);
});

test('two fingers zoom the sheet, ending a view drag as one undo step', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4);
  type Ws = { zoom: number; frames: { x0: number; y0: number; x1: number; y1: number }[]; pan: { x: number; y: number }; el: HTMLElement };
  type AppT = { drawing: Ws; store: { undoDepth: number; change(l: string, fn: (d: { variables: unknown[] }) => void): void } };
  const state = () => page.evaluate(() => {
    const app = (window as unknown as { __parametric: AppT }).__parametric;
    const ws = app.drawing, box = ws.el.getBoundingClientRect(), f = ws.frames[0];
    return { zoom: ws.zoom, depth: app.store.undoDepth, cx: box.left + ws.pan.x + ((f.x0 + f.x1) / 2) * ws.zoom, cy: box.top + ws.pan.y + ((f.y0 + f.y1) / 2) * ws.zoom };
  });
  // Opening the drawing fits the sheet to the view in the next frame, which on a loaded
  // machine can come after the views are projected: start from the fitted sheet.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const s0 = await state();
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: [number, number][]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
  // One finger drags a view, a second one lands and the two spread apart.
  const { cx, cy } = s0;
  await touch('touchStart', [[cx, cy]]);
  await touch('touchMove', [[cx + 20, cy + 10]]);
  await touch('touchMove', [[cx + 20, cy + 10], [cx + 120, cy + 10]]);
  await touch('touchMove', [[cx - 80, cy + 10], [cx + 220, cy + 10]]);
  await touch('touchEnd', []);
  const s1 = await state();
  expect(s1.zoom / s0.zoom).toBeCloseTo(3, 1);
  // The drag is one undo step and later changes are separate steps again (no batch left open).
  await page.evaluate(() => (window as unknown as { __parametric: AppT }).__parametric.store.change('A', (d) => { d.variables.push({ name: 'A', expr: '1' }); }));
  expect((await state()).depth - s0.depth).toBe(2);
});

test('the title block fields keep keyboard focus and follow undo', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4);
  await page.getByRole('textbox', { name: 'Title' }).fill('Bracket, left');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: 'Drawn by' })).toBeFocused();
  await page.keyboard.type('NJ');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: 'Notes' })).toBeFocused();
  await expect(page.locator('.paper svg')).toContainText('Bracket, left');
  await expect(page.locator('.paper svg')).toContainText('NJ');
  await page.evaluate(() => (window as unknown as { __parametric: { store: { undo(): void } } }).__parametric.store.undo());
  await expect(page.getByRole('textbox', { name: 'Drawn by' })).toHaveValue('');
});

test('exporting right after opening the drawing waits for the views', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.waitForFunction(() => (window as unknown as { __parametric: { bbox: unknown } }).__parametric.bbox);
  const views = await page.evaluate(async () => {
    const app = (window as unknown as { __parametric: { openDrawing(): void; drawing: { exportSvg(): Promise<void> } } }).__parametric;
    // Capture the download instead of saving it.
    let href = '';
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { href = this.href; };
    try {
      app.openDrawing();
      await app.drawing.exportSvg();
    } finally {
      HTMLAnchorElement.prototype.click = click;
    }
    return (await (await fetch(href)).text()).match(/data-view=/g)?.length ?? 0;
  });
  expect(views).toBe(4);
});

test('the whole sheet shows when a drawing opens and when its size changes', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.evaluate(() => {
    type A = { store: { doc: object }; loadDocument(d: object, h: null): void };
    const app = (window as unknown as { __parametric: A }).__parametric;
    const doc = structuredClone(app.store.doc) as Record<string, unknown>;
    doc.drawing = { sheet: 'A1', landscape: false, scale: 1, views: [{ id: 'v1', kind: 'front', x: 200, y: 300, hidden: true, dims: true }], title: '', drawnBy: '', notes: '' };
    app.loadDocument(doc, null);
  });
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper svg path').first()).toBeAttached({ timeout: 30_000 });
  const inside = () => page.evaluate(() => {
    const ws = document.querySelector('.drawing-ws')!.getBoundingClientRect();
    const p = document.querySelector('.paper')!.getBoundingClientRect();
    return p.left >= ws.left && p.top >= ws.top && p.right <= ws.right + 0.5 && p.bottom <= ws.bottom + 0.5 && p.height > ws.height / 2;
  });
  await expect.poll(inside).toBe(true);
  await page.getByLabel('Landscape').check();
  await expect.poll(inside).toBe(true);
});

test('a view can be selected, moved and deleted from the keyboard', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  type A = { store: { doc: { drawing: { views: { id: string; kind: string; x: number }[] } } } };
  const front = () => page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.doc.drawing.views.find((v) => v.kind === 'front'));
  const x0 = (await front())!.x;
  // Reached with the keyboard (Enter after a click is the Repeat Last Command shortcut).
  await page.keyboard.press('Shift');
  await page.locator('.relations-list').getByRole('button', { name: 'Front', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.drawing-ws')).toBeFocused();
  // Screen readers pass the arrow keys to it, and read its name and how to use it.
  await expect(page.getByRole('application', { name: /^Drawing\. .*arrow keys/ })).toBeFocused();
  await expect(page.locator('.view-sel')).toBeVisible();
  await expect(page.locator('.relations-list').getByRole('button', { name: 'Front', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await front())!.x).toBeCloseTo(x0 + 10, 6);
  // Holding an arrow key (its auto-repeats) is one undo step, not one per repeat.
  const depth = () => page.evaluate(() => (window as unknown as { __parametric: { store: { undoDepth: number } } }).__parametric.store.undoDepth);
  const d0 = await depth();
  await page.keyboard.down('ArrowRight');
  await page.locator('.drawing-ws').evaluate((el) => {
    for (let i = 0; i < 5; i++) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true, cancelable: true }));
  });
  await page.keyboard.up('ArrowRight');
  await expect.poll(async () => (await front())!.x).toBeCloseTo(x0 + 16, 6);
  expect(await depth()).toBe(d0 + 1);
  // Escape lets go of the view: the arrow keys move the sheet again, not the view.
  await page.keyboard.press('Escape');
  await expect(page.locator('.view-sel')).toBeHidden();
  const pan = () => page.locator('.sheet-host').evaluate((el) => (el as HTMLElement).style.transform);
  const t0 = await pan();
  await page.keyboard.press('ArrowRight');
  await expect.poll(pan).not.toBe(t0);
  expect((await front())!.x).toBeCloseTo(x0 + 16, 6);
  await page.locator('.relations-list').getByRole('button', { name: 'Front', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.drawing-ws')).toBeFocused();
  await page.keyboard.press('Delete');
  await expect.poll(front).toBeUndefined();
  // Deleting from the Views list keeps keyboard focus there: on the row that moved up, then Add view.
  await page.getByRole('button', { name: 'Delete Top view' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Delete Right view' })).toBeFocused();
  await page.getByRole('button', { name: 'Delete Isometric view' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Delete Right view' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Add view' })).toBeFocused();
});

test('a view dragged or nudged toward the edge of the sheet stays on it', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  // The isometric view's outline on the sheet, in millimetres (the sheet's SVG units).
  const frame = () => page.evaluate(() => {
    const svg = document.querySelector<SVGSVGElement>('.paper svg')!;
    const b = svg.querySelector<SVGGElement>('g[data-view="v4"]')!.getBoundingClientRect(), s = svg.getBoundingClientRect();
    const k = 297 / s.width;
    return { x0: (b.left - s.left) * k, y0: (b.top - s.top) * k, x1: (b.right - s.left) * k, y1: (b.bottom - s.top) * k };
  });
  const before = await frame();
  const box = (await page.locator('.paper g[data-view="v4"]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2 - 100, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 + 600, box.y + box.height / 2 - 400, { steps: 4 });
  await page.mouse.up();
  // Stopped with its outline against the border (10 mm in from the edge), not dragged off the sheet.
  const after = await frame();
  expect(after.x1).toBeCloseTo(297 - 10, 0);
  expect(after.y0).toBeCloseTo(10, 0);
  expect(after.x1 - after.x0).toBeCloseTo(before.x1 - before.x0, 3);
  // Against the border, an arrow key toward it moves nothing and adds no undo step.
  const depth = () => page.evaluate(() => (window as unknown as { __parametric: { store: { undoDepth: number } } }).__parametric.store.undoDepth);
  const d0 = await depth();
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Shift+ArrowUp');
  expect(await depth()).toBe(d0);
  expect(await frame()).toEqual(after);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(async () => (await frame()).x1).toBeCloseTo(after.x1 - 10, 0);
});

test('views stay on a sheet made smaller or turned, in the same undo step', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  type Frame = { id: string; x0: number; y0: number; x1: number; y1: number };
  type A = { store: { undoDepth: number }; drawing: { frames: Frame[]; update(fn: (d: { views: { id: string; x: number; y: number }[] }) => void): void } };
  const iso = () => page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.drawing.frames.find((f) => f.id === 'v4')!);
  const depth = () => page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.undoDepth);
  const sheetSize = page.getByRole('combobox', { name: 'Sheet size' });
  await sheetSize.selectOption('A3');
  // On the A3 sheet, the isometric view moved out to its far corner.
  await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.drawing.update((d) => { const v = d.views.find((q) => q.id === 'v4')!; v.x = 380; v.y = 260; }));
  await expect.poll(async () => (await iso()).x0).toBeGreaterThan(297);
  const d0 = await depth();
  await sheetSize.selectOption('A4');
  // Back inside the A4 border (10 mm in from 297 x 210), in the step that changed the sheet.
  await expect.poll(async () => { const f = await iso(); return f.x1 <= 287.001 && f.y1 <= 200.001 && f.x0 >= 10 && f.y0 >= 10; }).toBe(true);
  expect(await depth()).toBe(d0 + 1);
  // Turned to portrait (210 mm wide), it moves in again.
  await page.getByRole('checkbox', { name: 'Landscape' }).uncheck();
  await expect.poll(async () => (await iso()).x1).toBeLessThanOrEqual(200.001);
});

test('a larger drawing scale moves the views apart and keeps them on the sheet, in one undo step', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  type Frame = { id: string; x0: number; y0: number; x1: number; y1: number };
  type A = { store: { undoDepth: number; doc: { drawing: { scale: number } } }; drawing: { frames: Frame[] } };
  const frames = () => page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.drawing.frames);
  const depth = () => page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.undoDepth);
  await page.getByRole('combobox', { name: 'Sheet size' }).selectOption('A3');
  const before = await frames();
  const d0 = await depth();
  await page.getByRole('combobox', { name: 'Scale' }).selectOption('2');
  await expect.poll(async () => { const f = (await frames()).find((q) => q.id === 'v1')!; return f.x1 - f.x0; }).toBeCloseTo(2 * (before.find((q) => q.id === 'v1')!.x1 - before.find((q) => q.id === 'v1')!.x0), 3);
  expect(await depth()).toBe(d0 + 1);
  const after = await frames();
  // Twice the size, not on top of each other, and with their dimensions on the A3 sheet (420 x 297, 10 mm border).
  for (const a of after) {
    for (const b of after) if (a !== b) expect(a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0, `${a.id} ${b.id}`).toBe(false);
    const dims = a.id !== 'v4';
    expect(a.x0 - (dims ? 12 : 0)).toBeGreaterThanOrEqual(10 - 1e-6);
    expect(a.y0).toBeGreaterThanOrEqual(10 - 1e-6);
    expect(a.x1).toBeLessThanOrEqual(410 + 1e-6);
    expect(a.y1 + (dims ? 10.5 : 0)).toBeLessThanOrEqual(287 + 1e-6);
  }
});

test('opening the drawing does not mark the part edited until the drawing is changed', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  type A = { store: { dirty: boolean; undoDepth: number; doc: { drawing?: { views: { x: number }[] } } } };
  const state = () => page.evaluate(async () => {
    const app = (window as unknown as { __parametric: A }).__parametric;
    // What saving writes, from the app's own module (served by the dev server).
    const url = '/src/model/document.ts';
    const { serializeDocument } = (await import(/* @vite-ignore */ url)) as typeof import('../../src/model/document');
    return { dirty: app.store.dirty, depth: app.store.undoDepth, saved: !!JSON.parse(serializeDocument(app.store.doc as never)).drawing };
  });
  const s0 = await state();
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  await expect(page.locator('.doc-state')).not.toHaveText('Edited');
  expect(await state()).toMatchObject({ dirty: s0.dirty, depth: s0.depth });
  // Moving a view is an edit: one undo step, and the drawing is saved with the part.
  await page.locator('.relations-list').getByRole('button', { name: 'Front', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.doc-state')).toHaveText('Edited');
  expect(await state()).toEqual({ dirty: true, depth: s0.depth + 1, saved: true });
  // Undoing it leaves the drawing as it was opened, still open.
  await page.keyboard.press('Meta+Z');
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4);
  expect((await state()).depth).toBe(s0.depth);
});

test('the sheet zooms and pans from the keyboard, and Zoom In and Out zoom the sheet', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  type A = { drawing: { zoom: number; pan: { x: number; y: number } }; renderer: { camera: { distance: number } } };
  const state = () => page.evaluate(() => { const a = (window as unknown as { __parametric: A }).__parametric; return { zoom: a.drawing.zoom, pan: { ...a.drawing.pan }, distance: a.renderer.camera.distance }; });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.locator('.drawing-ws').focus();
  const s0 = await state();
  await page.keyboard.press('+');
  expect((await state()).zoom).toBeCloseTo(s0.zoom * 1.25, 6);
  await page.keyboard.press('-');
  expect((await state()).zoom).toBeCloseTo(s0.zoom, 6);
  // With no view selected, arrow keys move the sheet.
  await page.keyboard.press('ArrowLeft');
  expect((await state()).pan.x).toBeCloseTo(s0.pan.x + 40, 6);
  // Zoom Out (Z) zooms the sheet, not the hidden 3D view.
  await page.keyboard.press('z');
  const s1 = await state();
  expect(s1.zoom).toBeCloseTo(s0.zoom * 0.8, 6);
  expect(s1.distance).toBe(s0.distance);
});

test('commands for the 3D view are disabled while the drawing sheet is shown', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  type A = { inDrawing: boolean; commands: { isEnabled(id: string): boolean }; renderer: { section: unknown; displayStyle: string; camera: { ortho: boolean; rot: number[] } } };
  const ids = ['previousView', 'perspective', 'viewFront', 'viewIsometric', 'normalTo', 'viewOrientation', 'displayStyle', 'style:wireframe', 'sectionView', 'toggleVisibility', 'measure'];
  const enabled = () => page.evaluate((ids) => { const a = (window as unknown as { __parametric: A }).__parametric; return ids.filter((id) => a.commands.isEnabled(id)); }, ids);
  await expect.poll(enabled).toEqual(ids);
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  expect(await enabled()).toEqual([]);
  const view = () => page.evaluate(() => { const r = (window as unknown as { __parametric: A }).__parametric.renderer; return JSON.stringify([r.camera.rot, r.camera.ortho, r.displayStyle, r.section]); });
  const before = await view();
  // Their shortcuts do nothing to the hidden view, and their menu items show as unavailable.
  await page.locator('.drawing-ws').focus();
  await page.keyboard.press('Control+1');
  await page.keyboard.press('Space');
  await expect(page.getByRole('menu', { name: 'View orientation' })).toHaveCount(0);
  expect(await view()).toBe(before);
  await page.getByRole('menubar').getByRole('menuitem', { name: 'View' }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Perspective' }).or(page.getByRole('menuitem', { name: 'Perspective' }))).toBeDisabled();
  await page.keyboard.press('Escape');
  // Zoom to Fit fits the sheet.
  await page.keyboard.press('f');
  // Back on the model, they work again.
  await page.getByRole('tab', { name: 'Model' }).click();
  expect(await enabled()).toEqual(ids);
});

test('undoing a model edit made before the drawing was opened keeps the drawing open', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  type A = { inDrawing: boolean; store: { undoDepth: number; change(l: string, fn: (d: { features: { type: string; depth?: number }[] }) => void): void; doc: { drawing?: unknown; features: { type: string; depth?: number }[] } } };
  await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.change('Depth', (d) => { d.features.find((f) => f.type === 'extrude')!.depth = 34; }));
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  const state = () => page.evaluate(() => { const a = (window as unknown as { __parametric: A }).__parametric; return { inDrawing: a.inDrawing, drawing: !!a.store.doc.drawing, depth: a.store.doc.features.find((f) => f.type === 'extrude')!.depth, undo: a.store.undoDepth }; });
  const s0 = await state();
  await page.locator('.drawing-ws').focus();
  await page.keyboard.press('Meta+Z');
  // The edit is undone, with no extra undo step, and the drawing stays on screen.
  await expect.poll(async () => (await state()).depth).toBe(30);
  expect(await state()).toEqual({ inDrawing: true, drawing: true, depth: 30, undo: s0.undo - 1 });
  await expect(page.locator('.sheet-tabs').getByRole('tab', { name: 'Drawing' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4);
  await page.keyboard.press('Meta+Shift+Z');
  await expect.poll(async () => (await state()).depth).toBe(34);
  expect((await state()).inDrawing).toBe(true);
});

test.describe('in a time zone behind UTC', () => {
  test.use({ timezoneId: 'Pacific/Pago_Pago' });
  test('the title block shows the local date', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await page.getByRole('tab', { name: 'Drawing' }).click();
    await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
    // 05:00 UTC on 1 March is still 28 February in UTC-11.
    await page.evaluate(() => {
      type A = { store: { doc: { modified: number } }; drawing: { render(): void } };
      const app = (window as unknown as { __parametric: A }).__parametric;
      app.store.doc.modified = Date.UTC(2026, 2, 1, 5);
      app.drawing.render();
    });
    await expect(page.locator('.paper text', { hasText: /^2026-/ })).toHaveText('2026-02-28');
  });
});

for (const format of ['svg', 'pdf'] as const) test(`a ${format.toUpperCase()} exported immediately after an edit uses the rebuilt model`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4);
  const downloaded = page.waitForEvent('download');
  await page.evaluate((format) => {
    const app = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    app.store.change('Depth', (doc) => {
      const f = doc.features.find((f) => f.id === 'f1');
      if (f?.type === 'extrude') f.depth = 75;
    });
    app.commands.run(`drawing:${format}`);
  }, format);
  const file = await downloaded;
  const { readFileSync } = await import('node:fs');
  const text = new TextDecoder().decode(readFileSync((await file.path())!));
  expect(text).toContain(format === 'svg' ? '>75.00<' : '(75.00)');
  expect(text).not.toContain(format === 'svg' ? '>30.00<' : '(30.00)');
  expect(errors).toEqual([]);
});

test('leaving the drawing cancels an export still waiting for projection', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4);
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.evaluate(async () => {
    type W = { __parametric: import('../../src/app/app').App; releaseProjection: () => void; exportDone: boolean };
    const w = window as unknown as W, app = w.__parametric;
    const project = app.kernel.project.bind(app.kernel);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { w.releaseProjection = resolve; });
    app.kernel.project = async (...args) => { entered(); await gate; return project(...args); };
    app.store.change('Depth', (doc) => {
      const f = doc.features.find((f) => f.id === 'f1');
      if (f?.type === 'extrude') f.depth = 75;
    });
    await started;
    w.exportDone = false;
    void app.drawing.exportSvg().then(() => { w.exportDone = true; });
  });
  await page.getByRole('tab', { name: 'Model' }).click();
  await page.evaluate(() => (window as unknown as { releaseProjection: () => void }).releaseProjection());
  await expect.poll(() => page.evaluate(() => (window as unknown as { exportDone: boolean }).exportDone)).toBe(true);
  expect(downloads).toBe(0);
  expect(errors).toEqual([]);
});

test('a drawing opened before the part had a solid gets the standard views once it has one', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.drawing-empty')).toBeVisible();
  await page.getByRole('tab', { name: 'Model' }).click();
  // The solid is built while the drawing is not open.
  await page.evaluate(async (url) => {
    const { bracketExample } = (await import(/* @vite-ignore */ url)) as typeof import('../../src/app/examples');
    const ex = bracketExample();
    const app = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    app.store.change('Paste', (d) => { d.features = ex.features; d.nextId = ex.nextId; });
  }, '/src/app/examples.ts');
  await page.waitForFunction(() => (window as unknown as { __parametric: { bbox: unknown } }).__parametric.bbox);
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4);
});

test('removing the solid clears its old drawing projections', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4);
  await page.evaluate(async () => {
    const app = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    app.store.change('Remove solid', (doc) => { doc.features = []; });
    await app.whenBuilt();
  });
  await expect(page.locator('.drawing-empty')).toBeVisible();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(0);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'SVG', exact: true }).click();
  const file = await downloaded;
  const { readFileSync } = await import('node:fs');
  const text = new TextDecoder().decode(readFileSync((await file.path())!));
  expect(text).not.toContain('data-view=');
  expect(errors).toEqual([]);
});

test('Undo during a drawing-view drag ignores late pointer events', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4);
  const s = await page.evaluate(() => {
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    const ws = a.drawing as unknown as { frames: { id: string; x0: number; x1: number; y0: number; y1: number }[]; el: HTMLElement; pan: { x: number; y: number }; zoom: number };
    const f = ws.frames[0], box = ws.el.getBoundingClientRect();
    return { id: f.id, x: box.x + ws.pan.x + (f.x0 + f.x1) / 2 * ws.zoom, y: box.y + ws.pan.y + (f.y0 + f.y1) / 2 * ws.zoom };
  });
  const position = () => page.evaluate((id) => {
    const v = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.store.doc.drawing?.views.find((v) => v.id === id);
    return v ? [v.x, v.y] : null;
  }, s.id);
  const before = await position();
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  await page.mouse.move(s.x + 30, s.y + 20, { steps: 3 });
  const moved = await position();
  expect(moved).not.toEqual(before);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await position()).toEqual(before);
  await page.mouse.move(s.x + 60, s.y + 40);
  await page.mouse.up();
  expect(await position()).toEqual(before);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  expect(await position()).toEqual(moved);
  expect(errors).toEqual([]);
});

for (const kind of ['view', 'pan'] as const) for (const ending of ['lostpointercapture', 'pointercancel'] as const) test(`drawing ${kind} gesture ends on ${ending}`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4);
  const start = await page.evaluate(() => {
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    const ws = a.drawing as unknown as { frames: { id: string; x0: number; x1: number; y0: number; y1: number }[]; el: HTMLElement; pan: { x: number; y: number }; zoom: number };
    const f = ws.frames[0], box = ws.el.getBoundingClientRect();
    return { id: f.id, x: box.x + ws.pan.x + (f.x0 + f.x1) / 2 * ws.zoom, y: box.y + ws.pan.y + (f.y0 + f.y1) / 2 * ws.zoom };
  });
  const state = () => page.evaluate((id) => {
    const a = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric;
    const v = a.store.doc.drawing!.views.find((v) => v.id === id)!;
    return { view: [v.x, v.y], pan: (a.drawing as unknown as { pan: { x: number; y: number } }).pan, depth: a.store.undoDepth, name: a.store.doc.name };
  }, start.id);
  const before = await state();
  const button = kind === 'view' ? 'left' : 'middle';
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button });
  await page.mouse.move(start.x + 30, start.y + 20, { steps: 3 });
  const moved = await state();
  expect(moved[kind]).not.toEqual(before[kind]);
  await page.evaluate((ending) => {
    const el = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.drawing.el;
    if (ending === 'lostpointercapture') el.releasePointerCapture(1);
    else el.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true }));
  }, ending);
  await page.mouse.move(start.x + 60, start.y + 40, { steps: 2 });
  await page.mouse.up({ button });
  expect(await state()).toMatchObject({ view: moved.view, pan: moved.pan, depth: before.depth + Number(kind === 'view') });
  await page.evaluate(() => (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.store.change('Later rename', (d) => { d.name = 'After gesture'; }));
  expect((await state()).depth).toBe(before.depth + Number(kind === 'view') + 1);
  await page.keyboard.press('ControlOrMeta+z');
  expect(await state()).toMatchObject({ view: moved.view, name: before.name });
  if (kind === 'view') {
    await page.keyboard.press('ControlOrMeta+z');
    expect((await state()).view).toEqual(before.view);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    expect((await state()).view).toEqual(moved.view);
  }
  expect(errors).toEqual([]);
});

test('drawing pinch stops when a touch loses capture and a fresh pinch still works', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4);
  const center = await page.evaluate(() => {
    const el = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.drawing.el;
    el.addEventListener('gotpointercapture', (e) => { el.dataset.touchCapture = String(e.pointerId); });
    el.addEventListener('lostpointercapture', (e) => { el.dataset.touchLost = String(e.pointerId); });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const state = () => page.evaluate(() => {
    const ws = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.drawing as unknown as { pan: { x: number; y: number }; zoom: number };
    return { pan: ws.pan, zoom: ws.zoom };
  });
  const cdp = await page.context().newCDPSession(page);
  const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', radius: number | null) => {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: radius === null ? [] : [{ id: 0, x: center.x - radius, y: center.y }, { id: 1, x: center.x + radius, y: center.y }] });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  };
  const before = await state();
  await touch('touchStart', 40);
  await touch('touchMove', 60);
  const moved = await state();
  expect(moved.zoom).toBeGreaterThan(before.zoom);
  await page.evaluate(() => {
    const el = (window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.drawing.el;
    const id = Number(el.dataset.touchCapture);
    if (!el.hasPointerCapture(id)) throw new Error('Expected an established touch capture');
    el.releasePointerCapture(id);
  });
  await touch('touchMove', 100); // Delivers the queued capture loss for that pointer.
  expect(await page.evaluate(() => !!(window as unknown as { __parametric: import('../../src/app/app').App }).__parametric.drawing.el.dataset.touchLost)).toBe(true);
  const interrupted = await state();
  await touch('touchMove', 140);
  expect(await state()).toEqual(interrupted);
  await touch('touchEnd', null);
  await touch('touchStart', 40);
  await touch('touchMove', 80);
  await touch('touchEnd', null);
  expect((await state()).zoom).toBeCloseTo(interrupted.zoom * 2, 6);
  expect(errors).toEqual([]);
});

test('the drawing is not projected again after a change that leaves the body as it was', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  type A = {
    buildVersion: number; whenBuilt(): Promise<void>; kernel: { project(v: unknown): Promise<unknown> };
    store: { change(l: string, f: (d: { features: { name: string; hidden?: boolean; type: string }[] }) => void): void };
  };
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: A; __projections: number }).__parametric;
    const w = window as unknown as { __projections: number };
    w.__projections = 0;
    const project = a.kernel.project.bind(a.kernel);
    a.kernel.project = (v) => { w.__projections++; return project(v); };
  });
  const state = () => page.evaluate(async () => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    await a.whenBuilt();
    return { builds: a.buildVersion, projections: (window as unknown as { __projections: number }).__projections };
  });
  const s0 = await state();
  // A feature renamed and a sketch hidden: rebuilt, with the same body.
  await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.change('Rename', (d) => { d.features[1].name = 'Base plate'; }));
  await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.change('Hide', (d) => { d.features.find((f) => f.type === 'sketch')!.hidden = true; }));
  await expect.poll(async () => (await state()).builds).toBeGreaterThan(s0.builds);
  await page.waitForTimeout(300);
  expect((await state()).projections).toBe(0);
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4);
  // A change to the body is projected again.
  await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.change('Depth', (d) => { const e = d.features.find((f) => f.type === 'extrude') as unknown as { depth: number }; e.depth += 5; }));
  await expect.poll(async () => (await state()).projections).toBeGreaterThan(0);
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4);
});

test('a drawing whose views take a while to project shows its sheet and says it is projecting them', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  type A = { kernel: { project(v: unknown): Promise<unknown> } };
  // A slow projection (a large part takes seconds), held until the test lets it go.
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    const w = window as unknown as { __release: () => void };
    const project = a.kernel.project.bind(a.kernel);
    a.kernel.project = async (v) => { await new Promise<void>((r) => { w.__release = r; }); return project(v); };
  });
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Projecting the views…' })).toBeVisible();
  // The sheet's border and title block are there meanwhile.
  await expect(page.locator('.paper svg rect').first()).toBeAttached();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  await expect(page.locator('.drawing-busy')).toHaveText('');
});

test('hidden lines turned on for the isometric view are projected and drawn', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  type A = { store: { doc: { drawing: { views: { id: string; kind: string }[] } } } };
  const iso = await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.doc.drawing.views.find((v) => v.kind === 'isometric')!.id);
  const dashed = () => page.locator(`.paper g[data-view="${iso}"] path[stroke-dasharray]`).count();
  // Shown without hidden lines, it is projected without them.
  expect(await dashed()).toBe(0);
  await page.getByRole('checkbox', { name: 'Hidden lines in Isometric view' }).check();
  await expect.poll(dashed).toBeGreaterThan(0);
  await page.getByRole('checkbox', { name: 'Hidden lines in Isometric view' }).uncheck();
  await expect.poll(dashed).toBe(0);
});

test('the sheet follows the wheel zoom direction setting, but not for a trackpad pinch', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.getByRole('img', { name: 'Drawing sheet' })).toBeVisible();
  const zoomed = (ctrlKey: boolean) => page.evaluate((ctrlKey) => {
    type Ws = { el: HTMLElement; zoom: number };
    const app = (window as unknown as { __parametric: { drawing: Ws; viewport: { invertZoom: boolean } } }).__parametric;
    app.viewport.invertZoom = true;
    const ws = app.drawing, before = ws.zoom;
    const r = ws.el.getBoundingClientRect();
    // Spreading two fingers, or turning the wheel away (reversed: zoom out).
    ws.el.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, ctrlKey, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
    return ws.zoom / before;
  }, ctrlKey);
  expect(await zoomed(false)).toBeLessThan(1);
  expect(await zoomed(true)).toBeGreaterThan(1);
});
