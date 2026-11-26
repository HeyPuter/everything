import { type Page, expect, test } from '@playwright/test';
import { openApp, waitForFeature } from './helpers';

type App = import('../../src/app/app').App;
type Ws = {
  el: HTMLElement; pan: { x: number; y: number }; zoom: number;
  frames: { id: string; x0: number; y0: number; x1: number; y1: number }[];
  placements: Map<string, { tx: number; ty: number; s: number; prims: { edge: string; kind: string; a: [number, number]; b: [number, number]; c?: [number, number]; r?: number; full?: boolean }[] }>;
};
const ws = (page: Page) => page.evaluate(() => {
  const w = (window as unknown as { __parametric: App }).__parametric.drawing as unknown as Ws;
  return { frames: w.frames };
});

/** Client coordinates of a sheet point (millimetres). */
async function at(page: Page, x: number, y: number) {
  return page.evaluate(([x, y]) => {
    const w = (window as unknown as { __parametric: App }).__parametric.drawing as unknown as Ws;
    const r = w.el.getBoundingClientRect();
    return { x: r.left + w.pan.x + x * w.zoom, y: r.top + w.pan.y + y * w.zoom };
  }, [x, y]);
}

async function clickSheet(page: Page, x: number, y: number) {
  const p = await at(page, x, y);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
}

/** Sheet point of a view's prim (its middle, or a circle's rightmost point). */
async function primPoint(page: Page, view: string, kind: 'line-h' | 'line-v' | 'circle'): Promise<{ x: number; y: number; edge: string }> {
  return page.evaluate(([view, kind]) => {
    const w = (window as unknown as { __parametric: App }).__parametric.drawing as unknown as Ws;
    const p = w.placements.get(view)!;
    const T = (q: [number, number]) => ({ x: p.tx + q[0] * p.s, y: p.ty + q[1] * p.s });
    const len = (q: { a: [number, number]; b: [number, number] }) => Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]);
    if (kind === 'circle') {
      const c = p.prims.filter((q) => q.kind === 'arc' && q.full).sort((a, b) => b.r! - a.r!)[0];
      return { ...T([c.c![0] + c.r!, c.c![1]]), edge: c.edge };
    }
    const lines = p.prims.filter((q) => q.kind === 'line' && (kind === 'line-h' ? Math.abs(q.a[1] - q.b[1]) < 1e-6 : Math.abs(q.a[0] - q.b[0]) < 1e-6));
    const l = lines.sort((a, b) => len(b) - len(a))[0];
    // The place along it farthest from every corner and centre (which a click there would pick instead).
    const pts = p.prims.flatMap((q) => (q.kind === 'arc' ? [q.c!, q.a, q.b] : [q.a, q.b]));
    let best = 0.5, room = -1;
    for (let t = 0.05; t < 0.96; t += 0.01) {
      const x = l.a[0] + (l.b[0] - l.a[0]) * t, y = l.a[1] + (l.b[1] - l.a[1]) * t;
      const m = Math.min(...pts.map((q) => Math.hypot(q[0] - x, q[1] - y)));
      if (m > room) { room = m; best = t; }
    }
    return { ...T([l.a[0] + (l.b[0] - l.a[0]) * best, l.a[1] + (l.b[1] - l.a[1]) * best]), edge: l.edge };
  }, [view, kind] as const);
}

const drawing = (page: Page) => page.evaluate(() => (window as unknown as { __parametric: App }).__parametric.store.doc.drawing!);

test('Make Drawing is on the Drafting ribbon tab of the model, and opens the drawing with its own tabs', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  const tabs = page.getByRole('tablist', { name: 'Command groups' });
  await expect(tabs.getByRole('tab', { name: 'Annotation' })).toBeHidden();
  await tabs.getByRole('tab', { name: 'Drafting' }).click();
  await page.locator('.cm-tools').getByRole('button', { name: 'Make Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  // In the drawing: Drafting and Annotation, not the model's tabs.
  await expect(tabs.getByRole('tab', { name: 'Annotation' })).toBeVisible();
  await expect(tabs.getByRole('tab', { name: 'Features' })).toBeHidden();
  await expect(tabs.getByRole('tab', { name: 'Drafting' })).toHaveAttribute('aria-selected', 'true');
  // The full title block: third angle projection symbol and the sheet number.
  await expect(page.locator('.paper text', { hasText: 'THIRD ANGLE' })).toHaveCount(1);
  await expect(page.locator('.paper text', { hasText: '1 OF 1' })).toHaveCount(1);
  // Center marks on the holes seen end on.
  expect(await page.locator('.paper line').count()).toBeGreaterThan(20);
  await page.getByRole('tab', { name: 'Model' }).click();
  await expect(tabs.getByRole('tab', { name: 'Features' })).toBeVisible();
  // Also in the File menu and the command search.
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File' }).click();
  await expect(page.getByRole('menuitem', { name: 'Make Drawing' })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('adds section and detail views, dimensions that follow the model, and exports them', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  // A roomier sheet.
  await page.getByRole('combobox', { name: 'Sheet size' }).selectOption('A3');
  const tabs = page.getByRole('tablist', { name: 'Command groups' });
  const front = (await ws(page)).frames.find((f) => f.id === 'v1')!;
  // Section: select the front view, Section View, click through the middle, then below the view.
  await page.locator('.relations-list').getByRole('button', { name: 'Front', exact: true }).click();
  await page.locator('.cm-tools').getByRole('button', { name: 'Section View' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'horizontal cutting line' }).first()).toBeVisible();
  const cy = (front.y0 + front.y1) / 2 + 0.3;
  await clickSheet(page, (front.x0 + front.x1) / 2 + 0.7, cy);
  await clickSheet(page, (front.x0 + front.x1) / 2, front.y1 + 25);
  await expect(page.locator('.paper g[data-view]')).toHaveCount(5, { timeout: 30_000 });
  await expect(page.locator('.paper text', { hasText: 'SECTION A-A' })).toHaveCount(1);
  const d1 = await drawing(page);
  const sec = d1.views.find((v) => v.type === 'section')!;
  expect(sec).toMatchObject({ parent: 'v1', label: 'A' });
  // Hatched: the section's group holds a hatch path of many short lines.
  const hatchPaths = await page.locator(`.paper g[data-view="${sec.id}"] path`).evaluateAll((ps) => ps.map((p) => (p.getAttribute('d') ?? '').split('M').length));
  expect(Math.max(...hatchPaths)).toBeGreaterThan(5);
  // Aligned below the front view: same x.
  const fr = await ws(page);
  const sf = fr.frames.find((f) => f.id === sec.id)!;
  expect(sf.y0).toBeGreaterThan(front.y1);
  // Dragged sideways it stays aligned (only moves up and down).
  const before = sf;
  const from = await at(page, (sf.x0 + sf.x1) / 2, (sf.y0 + sf.y1) / 2);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 20, { steps: 4 });
  await page.mouse.up();
  const after = (await ws(page)).frames.find((f) => f.id === sec.id)!;
  expect(after.x0).toBeCloseTo(before.x0, 6);
  expect(after.y0).toBeGreaterThan(before.y0);

  // Detail: centre on the front view's corner, a radius, then a place on the sheet.
  await page.locator('.relations-list').getByRole('button', { name: 'Front', exact: true }).click();
  await page.locator('.cm-tools').getByRole('button', { name: 'Detail View' }).click();
  await clickSheet(page, front.x0 + 5, front.y1 - 5);
  await clickSheet(page, front.x0 + 15, front.y1 - 5);
  await clickSheet(page, 330, 230);
  await expect(page.locator('.paper g[data-view]')).toHaveCount(6, { timeout: 30_000 });
  await expect(page.locator('.paper text', { hasText: /^DETAIL B/ })).toHaveCount(1);
  const det = (await drawing(page)).views.find((v) => v.type === 'detail')!;
  expect(det.scale).toBeGreaterThan(d1.scale);

  // Smart Dimension on the Annotation tab: a horizontal edge of the front view.
  await tabs.getByRole('tab', { name: 'Annotation' }).click();
  await page.locator('.cm-tools').getByRole('button', { name: 'Smart Dimension' }).click();
  const edge = await primPoint(page, 'v3', 'line-h');
  await clickSheet(page, edge.x, edge.y);
  await clickSheet(page, edge.x, edge.y - 12);
  const d2 = await drawing(page);
  expect(d2.annotations!.filter((a) => a.type === 'dimension')).toHaveLength(1);
  const dim = d2.annotations!.find((a) => a.type === 'dimension')!;
  expect(dim).toMatchObject({ view: 'v3', kind: 'horizontal' });
  // The right view's horizontal edge is the extrusion's depth (30), and follows a change to 75.
  const count = (s: string) => page.locator('.paper text').filter({ hasText: new RegExp(`^${s.replace('.', '\\.')}$`) }).count();
  const n30 = await count('30.00');
  expect(n30).toBeGreaterThan(0);
  await page.evaluate(() => (window as unknown as { __parametric: App }).__parametric.store.change('Depth', (doc) => {
    const f = doc.features.find((x) => x.id === 'f1');
    if (f?.type === 'extrude') f.depth = 75;
  }));
  await expect.poll(() => count('75.00'), { timeout: 30_000 }).toBe(n30);
  await expect(page.locator('.drw-missing')).toHaveCount(0);
  // A diameter on the front view's largest hole.
  const hole = await primPoint(page, 'v2', 'circle');
  await clickSheet(page, hole.x, hole.y);
  await clickSheet(page, hole.x + 12, hole.y - 10);
  await expect(page.locator('.paper text', { hasText: /^Ø/ })).toHaveCount(1);
  await page.keyboard.press('Escape');

  // A note.
  await page.locator('.cm-tools').getByRole('button', { name: 'Note' }).click();
  await clickSheet(page, 40, 260);
  await page.getByRole('textbox', { name: 'Note text' }).fill('BREAK ALL EDGES');
  await page.getByRole('textbox', { name: 'Note text' }).press('Tab');
  await expect(page.locator('.paper text', { hasText: 'BREAK ALL EDGES' })).toHaveCount(1);

  // Exports carry all of it.
  const fs = await import('node:fs');
  const read = async (name: 'PDF' | 'SVG' | 'DXF') => {
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name, exact: true }).click();
    const file = await dl;
    expect(file.suggestedFilename()).toBe(`Mounting Bracket.${name.toLowerCase()}`);
    return new TextDecoder(name === 'SVG' ? 'utf-8' : 'latin1').decode(fs.readFileSync((await file.path())!));
  };
  const svg = await read('SVG');
  expect(svg).toContain('>SECTION A-A<');
  expect(svg).toMatch(/>DETAIL B/);
  expect(svg).toContain('>BREAK ALL EDGES<');
  expect(svg).toMatch(/>\u00d8[\d.]+</);
  const pdf = await read('PDF');
  expect(pdf).toContain('(SECTION A-A) Tj');
  expect(pdf).toContain('(BREAK ALL EDGES) Tj');
  expect(pdf).toMatch(/\(\\330[\d.]+\) Tj/);
  const dxf = await read('DXF');
  expect(dxf).toContain('SECTION A-A');
  expect(dxf).toContain('%%c');
  expect(dxf).toMatch(/\nARC\n/);
  expect(dxf.trimEnd().endsWith('EOF')).toBe(true);

  // Deleting the front view warns and takes the views made from it along.
  await page.getByRole('button', { name: 'Delete Front view' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect.poll(async () => (await drawing(page)).views.length).toBe(3);
  expect((await drawing(page)).annotations!.some((a) => a.view === 'v1')).toBe(false);
  expect(errors).toEqual([]);
});

test('Arrange standard views asks before deleting section views and dimensions, and is undone in one step', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  const arrange = page.getByRole('button', { name: 'Arrange standard views' });
  // Only standard views: arranged at once, as before.
  await page.evaluate(() => (window as unknown as { __parametric: App }).__parametric.drawing.update((d) => { d.views[0].x += 5; }, 'Move view'));
  await arrange.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { __parametric: App }).__parametric.drawing.update((d) => {
    d.views.push({ id: 'v9', kind: 'front', type: 'section', parent: 'v1', line: [-60, 0, 60, 0], label: 'A', x: 60, y: 180, hidden: false, dims: false });
    (d.annotations ??= []).push({ id: 'a1', type: 'dimension', view: 'v1', kind: 'horizontal', refs: [{ edge: 'x', at: 'edge' }], at: [0, 30] });
  }, 'Section view'));
  await expect(page.locator('.paper g[data-view]')).toHaveCount(5, { timeout: 30_000 });
  await arrange.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('1 section, detail or other added view and 1 annotation on a view');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect((await drawing(page)).views).toHaveLength(5);
  await arrange.click();
  await dialog.getByRole('button', { name: 'Arrange' }).click();
  await expect.poll(async () => (await drawing(page)).views.length).toBe(4);
  expect((await drawing(page)).annotations).toEqual([]);
  await page.keyboard.press('Meta+Z');
  await expect.poll(async () => (await drawing(page)).views.length).toBe(5);
  expect((await drawing(page)).annotations).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('a drawing opened while the part is still building has its view and annotation commands once the views are laid out', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await expect(page.getByRole('treeitem', { name: 'Fillet1' })).toBeVisible();
  // Straight away, before the first rebuild is done.
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  await expect(page.locator('.cm-tools').getByRole('button', { name: 'Projected View' })).toBeEnabled();
  await expect(page.locator('.cm-tools').getByRole('button', { name: 'Section View' })).toBeEnabled();
  expect(errors).toEqual([]);
});

test('a drawing command’s ribbon button is no longer pressed once the view is placed or the command is cancelled', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  const front = (await ws(page)).frames.find((f) => f.id === 'v1')!;
  const button = page.locator('.cm-tools').getByRole('button', { name: 'Projected View' });
  await page.locator('.relations-list').getByRole('button', { name: 'Front', exact: true }).click();
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await clickSheet(page, (front.x0 + front.x1) / 2, front.y1 + 40);
  await expect(page.locator('.paper g[data-view]')).toHaveCount(5, { timeout: 30_000 });
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('a view placed with a click beside the paper is put on the sheet, with an auxiliary view’s arrow on its parent', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  const front = (await ws(page)).frames.find((f) => f.id === 'v1')!;
  await page.locator('.relations-list').getByRole('button', { name: 'Front', exact: true }).click();
  await page.locator('.cm-tools').getByRole('button', { name: 'Auxiliary View' }).click();
  const edge = await primPoint(page, 'v1', 'line-v');
  await clickSheet(page, edge.x, edge.y);
  // Left of the paper's edge.
  await clickSheet(page, -6, (front.y0 + front.y1) / 2);
  await expect(page.locator('.paper g[data-view]')).toHaveCount(5, { timeout: 30_000 });
  const aux = (await drawing(page)).views.find((v) => v.type === 'auxiliary')!;
  const f = (await ws(page)).frames.find((q) => q.id === aux.id)!;
  expect(f.x0).toBeGreaterThanOrEqual(10 - 1e-6);
  await expect(page.locator('.paper text', { hasText: /^VIEW A$/ })).toHaveCount(1);
  // The letter on the front view, at the arrow's tail.
  await expect(page.locator('.paper text', { hasText: /^A$/ })).toHaveCount(1);
  // A detail circle clicked out to the left of the paper too.
  await page.locator('.relations-list').getByRole('button', { name: 'Front', exact: true }).click();
  await page.locator('.cm-tools').getByRole('button', { name: 'Detail View' }).click();
  await clickSheet(page, front.x0 + 5, front.y1 - 5);
  await clickSheet(page, front.x0 + 12, front.y1 - 5);
  await clickSheet(page, (front.x0 + front.x1) / 2, 215);
  await expect(page.locator('.paper g[data-view]')).toHaveCount(6, { timeout: 30_000 });
  const det = (await drawing(page)).views.find((v) => v.type === 'detail')!;
  const fd = (await ws(page)).frames.find((q) => q.id === det.id)!;
  expect(fd.y1).toBeLessThanOrEqual(210 - 10 + 1e-6);
  expect(errors).toEqual([]);
});

test('an annotation selected in the Annotations list moves with the arrow keys', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  await page.evaluate(() => (window as unknown as { __parametric: App }).__parametric.drawing.update((d) => {
    d.annotations = [{ id: 'a1', type: 'note', text: 'DEBURR', at: [40, 150] }, { id: 'a2', type: 'note', text: 'IN VIEW', view: 'v1', at: [0, 20] }];
  }, 'Note'));
  const at = async (id: string) => ((await drawing(page)).annotations!.find((a) => a.id === id) as { at: [number, number] }).at;
  await page.locator('.drw-anno-list').getByRole('button', { name: 'Note: DEBURR', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  expect(await at('a1')).toEqual([41, 160]);
  // In a view: a millimetre on the sheet, whatever the view's scale.
  const s = await page.evaluate(() => ((window as unknown as { __parametric: App }).__parametric.drawing as unknown as Ws).placements.get('v1')!.s);
  await page.locator('.drw-anno-list').getByRole('button', { name: 'Note: IN VIEW', exact: true }).click();
  await page.keyboard.press('ArrowLeft');
  const q = await at('a2');
  expect(q[0]).toBeCloseTo(-1 / s, 3);
  expect(q[1]).toBe(20);
  await page.keyboard.press('Meta+Z');
  await expect.poll(() => at('a2')).toEqual([0, 20]);
  expect(errors).toEqual([]);
});

test('switching to first angle moves the top view below the front and the right view to its left, in one undo step', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  const centre = (f: { x0: number; y0: number; x1: number; y1: number }) => [(f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2];
  const third = (await ws(page)).frames;
  const before = await drawing(page);
  await page.getByRole('combobox', { name: 'Projection angle' }).selectOption('first');
  await expect(page.locator('.paper text', { hasText: 'FIRST ANGLE' })).toHaveCount(1);
  await expect.poll(async () => (await drawing(page)).views.find((v) => v.id === 'v2')!.y).toBeGreaterThan((await drawing(page)).views[0].y);
  const first = (await ws(page)).frames;
  const [f3, t3, r3] = ['v1', 'v2', 'v3'].map((id) => centre(third.find((f) => f.id === id)!));
  const [f1, t1, r1] = ['v1', 'v2', 'v3'].map((id) => centre(first.find((f) => f.id === id)!));
  expect(t1[0]).toBeCloseTo(f1[0], 3);
  expect(t1[1] - f1[1]).toBeCloseTo(f3[1] - t3[1], 3);
  expect(f1[0] - r1[0]).toBeCloseTo(r3[0] - f3[0], 3);
  // Still the right view (its caption), now left of the front.
  await expect(page.locator('.paper text', { hasText: /^RIGHT$/ })).toHaveCount(1);
  for (const f of first) expect(f.x0).toBeGreaterThanOrEqual(10);
  await page.keyboard.press('Meta+Z');
  await expect.poll(async () => (await drawing(page)).views).toEqual(before.views);
  expect((await drawing(page)).projection ?? 'third').toBe('third');
  expect(errors).toEqual([]);
});
