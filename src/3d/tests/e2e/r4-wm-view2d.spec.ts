import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

type AnyApp = { run(id: string, p?: object, o?: object): string; hoverArea: { type: string; editor: Record<string, any> } | null; activeArea: unknown; reports: { message: string }[] }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function setWorkspace(page: Page, name: string) {
  await page.locator('.ws-tab', { hasText: new RegExp(`^${name}$`) }).click();
  await page.waitForTimeout(200);
}

/** Hover the centre of the main canvas of the first area of a type. */
async function hoverCanvas(page: Page, type: string, sel = 'canvas') {
  const box = await page.locator(`.area[data-editor="${type}"] ${sel}`).first().boundingBox();
  if (!box) throw new Error(`no ${type} canvas`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return box;
}

const timelineView = (page: Page) =>
  page.evaluate(() => {
    const a = (window as unknown as { app: AnyApp }).app;
    const v = a.hoverArea!.editor.view;
    return { x0: v.x0 as number, ppf: v.ppf as number, w: v.width as number };
  });

test('View2D keys zoom the timeline and zoom border fits a dragged range', async ({ page }) => {
  const errors = await openApp(page);
  await hoverCanvas(page, 'TIMELINE');
  const v0 = await timelineView(page);
  await page.keyboard.press('NumpadAdd');
  const v1 = await timelineView(page);
  // each step moves both edges in by 3.75% of the view
  expect(v1.ppf / v0.ppf).toBeCloseTo(1 / (1 - 0.075), 3);
  await page.keyboard.press('NumpadSubtract');
  const v2 = await timelineView(page);
  expect(v2.ppf).toBeCloseTo(v0.ppf, 6);

  // Shift B, then drag a box: the dragged frame range fills the view
  const box = await hoverCanvas(page, 'TIMELINE');
  await page.keyboard.press('Shift+B');
  await expect(page.locator('.v2d-border-hint')).toBeVisible();
  const y = box.y + box.height / 2;
  const before = await timelineView(page);
  const f0 = before.x0 + 100 / before.ppf,
    f1 = before.x0 + 300 / before.ppf;
  await page.mouse.move(box.x + 100, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, y + 5);
  await page.mouse.move(box.x + 300, y + 10);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await timelineView(page);
  expect(after.x0).toBeCloseTo(f0, 3);
  expect(after.x0 + after.w / after.ppf).toBeCloseTo(f1, 3);
  await expect(page.locator('.v2d-border-hint')).toHaveCount(0);

  // operators run from scripts too
  const r = await page.evaluate(() => {
    const a = (window as unknown as { app: AnyApp }).app;
    const v = a.hoverArea!.editor.view;
    const x = v.x0;
    a.run('view2d.scroll_right', { deltax: 60 });
    const dx = (v.x0 - x) * v.ppf;
    a.run('view2d.pan', { deltax: -60, deltay: 0 });
    return { dx, back: Math.abs(v.x0 - x) < 1e-9 };
  });
  expect(r.dx).toBeCloseTo(60, 6);
  expect(r.back).toBe(true);
  await expectNoErrors(errors);
});

test('Graph Editor zooms both axes; Dope Sheet keeps rows', async ({ page }) => {
  const errors = await openApp(page);
  await setWorkspace(page, 'Animation');
  await hoverCanvas(page, 'DOPESHEET');
  const r = await page.evaluate(() => {
    const a = (window as unknown as { app: AnyApp }).app;
    const v = a.hoverArea!.editor.view;
    const ppv = v.ppv,
      ppf = v.ppf;
    a.run('view2d.zoom_in', {});
    return { fx: v.ppf / ppf, fy: v.ppv / ppv };
  });
  expect(r.fx).toBeGreaterThan(1);
  expect(r.fy).toBe(1);
  // switch the dope sheet area to the Graph Editor: both axes zoom
  await page.evaluate(() => {
    const a = (window as unknown as { app: AnyApp & { hoverArea: { setType(t: string): void } } }).app;
    a.hoverArea!.setType('GRAPH');
  });
  await hoverCanvas(page, 'GRAPH');
  const g = await page.evaluate(() => {
    const a = (window as unknown as { app: AnyApp }).app;
    const v = a.hoverArea!.editor.view;
    const ppv = v.ppv,
      ppf = v.ppf;
    a.run('view2d.zoom_out', { zoomfacx: 0.1, zoomfacy: 0.1 });
    return { fx: v.ppf / ppf, fy: v.ppv / ppv };
  });
  expect(g.fx).toBeCloseTo(0.8, 6);
  expect(g.fy).toBeCloseTo(0.8, 6);
  await expectNoErrors(errors);
});

test('View2D Buttons List: page keys scroll lists, Home resets', async ({ page }) => {
  const errors = await openApp(page);
  // fill the Info log, then show it in the timeline's area
  await page.evaluate(() => {
    const a = (window as unknown as { app: AnyApp }).app;
    for (let i = 0; i < 120; i++) a.run('object.select_all', { action: i % 2 ? 'SELECT' : 'DESELECT' });
  });
  await page.locator('.area[data-editor="TIMELINE"]').first().hover();
  await page.evaluate(() => (window as unknown as { app: { hoverArea: { setType(t: string): void } } }).app.hoverArea.setType('INFO'));
  const info = page.locator('.area[data-editor="INFO"] .area-main').first();
  const b = (await info.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  const host = await page.evaluate(async () => {
    const m = await import('/src/ui/view2d.ts');
    const a = (window as unknown as { app: { hoverArea: unknown } }).app;
    const h = m.view2dHost(a.hoverArea as never);
    if (h) h.el.scrollTop = h.el.scrollHeight;
    return h ? { kind: h.kind, km: m.view2dKeymap(a.hoverArea as never), top: h.el.scrollTop } : null;
  });
  expect(host?.kind).toBe('list');
  expect(host?.km).toBe('View2D Buttons List');
  expect(host!.top).toBeGreaterThan(0);
  const top = () =>
    page.evaluate(async () => {
      const m = await import('/src/ui/view2d.ts');
      return m.view2dHost((window as unknown as { app: { hoverArea: unknown } }).app.hoverArea as never)!.el.scrollTop;
    });
  await page.keyboard.press('PageUp');
  const t1 = await top();
  expect(t1).toBeLessThan(host!.top);
  await page.keyboard.press('Home');
  expect(await top()).toBe(0);
  await page.keyboard.press('PageDown');
  expect(await top()).toBeGreaterThan(0);
  await expectNoErrors(errors);
});

test('2D view scrollers: dragging the bar pans, dragging its end zooms', async ({ page }) => {
  const errors = await openApp(page);
  const bar = page.locator('.area[data-editor="TIMELINE"] .v2d-scroller.x');
  await expect(bar).toBeVisible();
  await hoverCanvas(page, 'TIMELINE');
  const v0 = await timelineView(page);
  const b = (await bar.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 - 40, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
  await hoverCanvas(page, 'TIMELINE');
  const v1 = await timelineView(page);
  // the bar moved left: the view shows earlier frames, same zoom
  expect(v1.x0).toBeLessThan(v0.x0);
  expect(v1.ppf).toBeCloseTo(v0.ppf, 6);
  const b1 = (await bar.boundingBox())!;
  await page.mouse.move(b1.x + b1.width - 2, b1.y + b1.height / 2);
  await page.mouse.down();
  await page.mouse.move(b1.x + b1.width - 82, b1.y + b1.height / 2, { steps: 4 });
  await page.mouse.up();
  await hoverCanvas(page, 'TIMELINE');
  const v2 = await timelineView(page);
  // shrinking the bar zooms in, keeping its left end
  expect(v2.ppf).toBeGreaterThan(v1.ppf);
  expect(v2.x0).toBeCloseTo(v1.x0, 3);
  await expectNoErrors(errors);
});
