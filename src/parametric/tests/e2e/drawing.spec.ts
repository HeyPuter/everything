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
