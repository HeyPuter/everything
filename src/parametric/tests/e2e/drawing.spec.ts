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
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Mounting Bracket.pdf');
  expect(await file.failure()).toBeNull();
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
  await expect(page.locator('.view-sel')).toBeVisible();
  await expect(page.locator('.relations-list').getByRole('button', { name: 'Front', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await front())!.x).toBeCloseTo(x0 + 10, 6);
  await page.keyboard.press('Delete');
  await expect.poll(front).toBeUndefined();
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
