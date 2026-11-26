// Drawings of assemblies (bill of materials, balloons, sections), of sheet metal parts
// (flat pattern views) and of weldments (cut list tables), saved and opened again.
import { type Page, expect, test } from '@playwright/test';
import { newBaseFlange } from '../../src/model/sheetmetal';
import { newStructuralMember } from '../../src/model/weldments';
import { openApp } from './helpers';

type A = import('../../src/app/app').App;
type Ws = {
  el: HTMLElement; pan: { x: number; y: number }; zoom: number;
  placements: Map<string, { tx: number; ty: number; s: number; prims: { edge: string; kind: string; a: [number, number]; b: [number, number] }[] }>;
  projectionOf(id: string): { cut?: number[][]; bounds: number[] | null } | undefined;
};

const pts = (prefix: string, p: [number, number][]) => [
  ...p.map(([x, y], i) => ({ id: `${prefix}p${i}`, t: 'point', x, y })),
  ...p.map((_, i) => ({ id: `${prefix}l${i}`, t: 'line', a: `${prefix}p${i}`, b: `${prefix}p${(i + 1) % p.length}` })),
];
const extrude = (id: string, sketch: string, depth: number) => ({ id, name: id, type: 'extrude', sketch, cut: false, end: 'blind', depth, flip: false, dir2: null, draft: 0, draftOutward: false, thin: null });
const BLOCK = [
  { id: 'S1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities: [...pts('r', [[0, 0], [40, 0], [40, 20], [0, 20]]), { id: 'hc', t: 'point', x: 10, y: 10 }, { id: 'h', t: 'circle', c: 'hc', r: 4 }], constraints: [] },
  extrude('E1', 'S1', 10),
];
const PIN = [
  { id: 'S1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities: [{ id: 'c', t: 'point', x: 0, y: 0 }, { id: 'k', t: 'circle', c: 'c', r: 4 }], constraints: [] },
  extrude('E1', 'S1', 30),
];

async function makePart(page: Page, name: string, features: unknown[], material = false) {
  await page.evaluate(async ({ name, features, material }) => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    await a.commands.get('new')!.run();
    a.store.change('Make part', (d) => {
      d.name = name; d.features = features as never; d.nextId = 100;
      if (material) d.material = { name: 'Steel', density: 7850 };
    });
    a.commands.run('save');
  }, { name, features, material });
  await expect(page).toHaveTitle(`${name} - Parametric`);
}

async function insert(page: Page, name: string) {
  void page.evaluate(() => { (window as unknown as { __parametric: A }).__parametric.commands.run('insertComponent'); });
  const dlg = page.getByRole('dialog', { name: 'Insert Components' });
  await dlg.getByRole('button', { name: new RegExp(`^${name} This browser`) }).click();
  await expect(dlg).toHaveCount(0);
}

/** Client coordinates of a sheet point (millimetres). */
async function at(page: Page, x: number, y: number) {
  return page.evaluate(([x, y]) => {
    const w = (window as unknown as { __parametric: A }).__parametric.drawing as unknown as Ws;
    const r = w.el.getBoundingClientRect();
    return { x: r.left + w.pan.x + x * w.zoom, y: r.top + w.pan.y + y * w.zoom };
  }, [x, y]);
}

async function clickSheet(page: Page, x: number, y: number) {
  const p = await at(page, x, y);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
}

const drawing = (page: Page) => page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.doc.drawing!);

async function save(page: Page) {
  await page.keyboard.press('Meta+s');
  await expect(page).not.toHaveTitle(/^\*/);
  return (await page.title()).replace(' - Parametric', '');
}

async function reopen(page: Page, name: string) {
  await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('new'); });
  await expect(page).toHaveTitle(/^Part\d+ - Parametric$/);
  void page.evaluate(() => { (window as unknown as { __parametric: A }).__parametric.commands.run('open'); });
  await page.getByRole('dialog', { name: 'Open' }).getByRole('button', { name: new RegExp(`^${name} This browser`) }).click();
  await expect(page).toHaveTitle(`${name} - Parametric`);
}

async function download(page: Page, name: 'PDF' | 'SVG' | 'DXF') {
  const fs = await import('node:fs');
  const dl = page.waitForEvent('download');
  await page.locator('.pm').getByRole('button', { name, exact: true }).click();
  const file = await dl;
  return new TextDecoder(name === 'SVG' ? 'utf-8' : 'latin1').decode(fs.readFileSync((await file.path())!));
}

test('an assembly drawing: bill of materials, auto and manual balloons, a section, exports, save and reopen', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.waitForFunction(() => (window as unknown as { __parametric?: A }).__parametric?.kernelReady);
  await makePart(page, 'Block', BLOCK, true);
  await makePart(page, 'Pin', PIN);
  await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('newAssembly'); });
  await insert(page, 'Block');
  await insert(page, 'Pin');
  const tree = page.getByRole('tree', { name: 'Assembly design tree' });
  await expect(tree.getByRole('treeitem', { name: '(-) Pin<1>' })).toBeVisible();
  // The pin in the hole, its end flush with the block's front face, then exploded 60 along z.
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    const m = a.assembly!;
    const [block, pin] = m.doc.components;
    const face = (c: string, name: string) => { const g = m.geometryOf(m.component(c)!.part)!; const f = g.faces.find((x) => x.name === name)!; return { name: f.name, sig: { type: f.type, c: f.center, n: f.normal, area: f.area } }; };
    const cyl = (c: string) => { const g = m.geometryOf(m.component(c)!.part)!; const f = g.faces.find((x) => x.type === 'cylinder')!; return { name: f.name, sig: { type: f.type, c: f.center, area: f.area } }; };
    m.commit('Add mates', (d) => {
      d.mates.push({ id: 'm90', name: 'Concentric1', type: 'concentric', a: { comp: block.id, face: cyl(block.id) }, b: { comp: pin.id, face: cyl(pin.id) }, aligned: true });
      d.mates.push({ id: 'm91', name: 'Coincident1', type: 'coincident', a: { comp: block.id, face: face(block.id, 'E1:cap1') }, b: { comp: pin.id, face: face(pin.id, 'E1:cap1') }, aligned: true });
      d.explode.push({ id: 'x92', name: 'Explode Step1', comps: [pin.id], dir: [0, 0, 1], distance: 60 });
    });
  });
  await expect(page.locator('.statusbar')).toContainText('Under Defined (1 DOF)');

  // The status bar's Drawing tab is there in an assembly, and makes the drawing.
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  await expect(page.getByRole('tab', { name: 'Annotation' })).toBeVisible();
  let d = await drawing(page);
  expect(d.sheet).toBe('A3');
  expect(d.views.every((v) => v.source === 'assembly')).toBe(true);
  expect(d.annotations?.map((a) => a.type)).toEqual(['bom']);
  // The bill of materials on the title block.
  for (const s of ['ITEM NO.', 'PART NUMBER', 'QTY.', 'Block', 'Pin', 'Steel']) await expect(page.locator('.paper text', { hasText: new RegExp(`^${s.replace('.', '\\.')}$`) })).toHaveCount(1);
  // The front view shows the collapsed assembly: the pin's 30 mm run inside the block's depth (10) makes the side view 30 wide.
  const sideWidth = () => page.evaluate(() => {
    const w = (window as unknown as { __parametric: A }).__parametric.drawing as unknown as Ws;
    const b = w.projectionOf('v3')?.bounds;
    return b ? b[2] - b[0] : -1;
  });
  await expect.poll(sideWidth).toBeCloseTo(30, 3);

  // Auto Balloon on the front view: one balloon per part, numbered from the bill of materials.
  await page.getByRole('button', { name: 'Front', exact: true }).click();
  await page.getByRole('tab', { name: 'Annotation' }).click();
  await page.locator('.cm [data-cmd="drawing:autoBalloon"]').click();
  await expect.poll(async () => (await drawing(page)).annotations!.filter((a) => a.type === 'balloon').length).toBe(2);
  const items = () => page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    return a.store.doc.drawing!.annotations!.filter((x) => x.type === 'balloon').map((x) => x.type === 'balloon' ? a.drawing.itemOf('assembly', x.ref.edge) : null).sort();
  });
  expect(await items()).toEqual([1, 2]);
  // Balloons sit outside the view they number.
  const outside = await page.evaluate(() => {
    const w = (window as unknown as { __parametric: A }).__parametric.drawing as unknown as Ws & { frames: { id: string; x0: number; y0: number; x1: number; y1: number }[] };
    const f = w.frames.find((x) => x.id === 'v1')!;
    const p = w.placements.get('v1')!;
    return (window as unknown as { __parametric: A }).__parametric.store.doc.drawing!.annotations!.filter((x) => x.type === 'balloon').every((x) => {
      const ax = p.tx + (x as { at: number[] }).at[0] * p.s, ay = p.ty + (x as { at: number[] }).at[1] * p.s;
      return ax < f.x0 || ax > f.x1 || ay < f.y0 || ay > f.y1;
    });
  });
  expect(outside).toBe(true);
  // Running it again adds none (every component has its balloon).
  await page.locator('.cm [data-cmd="drawing:autoBalloon"]').click();
  await expect(page.getByText('Every component this view shows has a balloon already.')).toBeVisible();

  // A balloon by hand: click an edge of the pin in the right view, then where the balloon goes.
  const pinEdge = await page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    const w = a.drawing as unknown as Ws;
    const p = w.placements.get('v3')!;
    const pin = a.assembly!.doc.components[1].id;
    const l = p.prims.filter((q) => q.kind === 'line' && q.edge.startsWith(`${pin}#`)).sort((x, y) => Math.hypot(y.b[0] - y.a[0], y.b[1] - y.a[1]) - Math.hypot(x.b[0] - x.a[0], x.b[1] - x.a[1]))[0];
    const t = 0.8;
    return { x: p.tx + (l.a[0] + (l.b[0] - l.a[0]) * t) * p.s, y: p.ty + (l.a[1] + (l.b[1] - l.a[1]) * t) * p.s };
  });
  await page.locator('.cm [data-cmd="drawing:balloon"]').click();
  await clickSheet(page, pinEdge.x, pinEdge.y);
  await clickSheet(page, pinEdge.x + 15, pinEdge.y - 25);
  await expect.poll(async () => (await drawing(page)).annotations!.filter((a) => a.type === 'balloon' && a.view === 'v3').length).toBe(1);
  expect(await items()).toEqual([1, 2, 2]);
  await page.keyboard.press('Escape');
  // Its leader ends where the edge was clicked (or the vertex the click snapped to), not at the edge's middle.
  const dots = await page.locator('.paper circle[r="0.3"]').evaluateAll((els) => els.map((e) => [Number(e.getAttribute('cx')), Number(e.getAttribute('cy'))]));
  const snap = await page.evaluate(() => 7 / ((window as unknown as { __parametric: A }).__parametric.drawing as unknown as Ws).zoom);
  expect(dots.some(([x, y]) => Math.hypot(x - pinEdge.x, y - pinEdge.y) <= snap + 0.01)).toBe(true);

  // A section view of the assembly: both components cut and hatched.
  await page.getByRole('tab', { name: 'Drafting' }).click();
  await page.getByRole('button', { name: 'Front', exact: true }).click();
  await page.locator('.cm [data-cmd="drawing:section"]').click();
  const front = await page.evaluate(() => {
    const w = (window as unknown as { __parametric: A }).__parametric.drawing as unknown as Ws & { frames: { id: string; x0: number; y0: number; x1: number; y1: number }[] };
    return w.frames.find((f) => f.id === 'v1')!;
  });
  // Horizontal through the hole's centre (10 mm up the block): it snaps to the hole's centre.
  const cy = front.y0 + (front.y1 - front.y0) / 2;
  await clickSheet(page, front.x0 + 5, cy);
  await clickSheet(page, front.x0 + 5, front.y1 + 75);
  await expect.poll(async () => (await drawing(page)).views.length).toBe(5);
  const sec = (await drawing(page)).views[4];
  expect(sec.type).toBe('section');
  await expect.poll(() => page.evaluate((id) => ((window as unknown as { __parametric: A }).__parametric.drawing as unknown as Ws).projectionOf(id)?.cut?.length ?? 0, sec.id)).toBeGreaterThanOrEqual(2);

  // An exploded view: the pin 60 mm out of the block.
  await page.getByRole('button', { name: 'Right', exact: true }).click();
  await page.getByRole('checkbox', { name: /^Exploded/ }).check();
  await expect.poll(sideWidth).toBeCloseTo(70, 3);
  await page.keyboard.press('Meta+z');
  await expect.poll(sideWidth).toBeCloseTo(30, 3);

  // The bill of materials follows the assembly: another pin makes its quantity 2.
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    const m = a.assembly!;
    const pin = m.doc.components[1];
    m.commit('Insert', (x) => { x.components.push({ ...structuredClone(pin), id: 'c99', name: 'Pin<2>', placement: { p: [60, 0, 0], q: [0, 0, 0, 1] }, fixed: true }); });
  });
  await expect.poll(() => page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    const t = a.drawing.tableOf(a.store.doc.drawing!.annotations!.find((x) => x.type === 'bom') as never)!;
    return t.rows.map((r) => r.join('|'));
  })).toEqual(['1|Block|Steel|1', '2|Pin||2']);

  // PDF, SVG and DXF carry the table and the balloons.
  const pdf = await download(page, 'PDF');
  expect(pdf.startsWith('%PDF')).toBe(true);
  expect(pdf).toContain('(ITEM NO.) Tj');
  expect(pdf).toContain('(Block) Tj');
  expect(pdf).toContain('(SECTION A-A) Tj');
  const svg = await download(page, 'SVG');
  expect(svg).toContain('>PART NUMBER<');
  expect(svg).toContain('>Pin<');
  const dxf = await download(page, 'DXF');
  expect(dxf).toContain('\nPART NUMBER\n');
  expect(dxf.trimEnd().endsWith('EOF')).toBe(true);

  // Saved with the assembly and opened again.
  const before = await drawing(page);
  const name = await save(page);
  await reopen(page, name);
  await expect(tree.getByRole('treeitem', { name: '(f) Block<1>' })).toBeVisible();
  expect(await drawing(page)).toEqual(before);
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(5, { timeout: 30_000 });
  await expect(page.locator('.paper text', { hasText: /^PART NUMBER$/ })).toHaveCount(1);
  expect(await items()).toEqual([1, 2, 2]);
  // Back to the assembly: its own ribbon tab again.
  await page.getByRole('tab', { name: 'Model' }).click();
  await expect(page.getByRole('tab', { name: 'Assembly' })).toHaveAttribute('aria-selected', 'true');
  expect(errors).toEqual([]);
});

test('an assembly drawing after a part’s only component is suppressed and brought back shows every view; its bill of materials stays on the title block of another sheet size', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.waitForFunction(() => (window as unknown as { __parametric?: A }).__parametric?.kernelReady);
  await makePart(page, 'Block', BLOCK);
  await makePart(page, 'Pin', PIN);
  await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('newAssembly'); });
  await insert(page, 'Block');
  await insert(page, 'Pin');
  const tree = page.getByRole('tree', { name: 'Assembly design tree' });
  await expect(tree.getByRole('treeitem', { name: '(-) Pin<1>' })).toBeVisible();
  const suppress = (on: boolean) => page.evaluate((on) => {
    const m = (window as unknown as { __parametric: A }).__parametric.assembly!;
    m.commit(on ? 'Suppress' : 'Unsuppress', (d) => { d.components[0].suppressed = on || undefined; });
  }, on);
  await suppress(true);
  await expect(tree.getByRole('treeitem', { name: /Block<1>/ })).toHaveClass(/suppressed/);
  await expect(page.locator('.statusbar')).not.toContainText('Building');
  await suppress(false);
  await expect(tree.getByRole('treeitem', { name: /Block<1>/ })).not.toHaveClass(/suppressed/);
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  await expect(page.locator('.paper text', { hasText: /^Block$/ })).toHaveCount(1);
  await expect(page.getByText('Could not project the views')).toHaveCount(0);

  // The bill of materials stays on the title block when the sheet changes size or turns.
  const bomAt = async () => (await drawing(page)).annotations!.find((a) => a.type === 'bom')!.at;
  expect(await bomAt()).toEqual([410, 255]);
  await page.getByRole('combobox', { name: 'Sheet size' }).selectOption('A4');
  await expect.poll(bomAt).toEqual([287, 168]);
  await page.getByRole('checkbox', { name: 'Landscape' }).uncheck();
  await expect.poll(bomAt).toEqual([200, 255]);
  const box = await page.locator('.paper text', { hasText: /^PART NUMBER$/ }).boundingBox();
  const sheet = await page.locator('.paper').boundingBox();
  expect(box!.x + box!.width).toBeLessThan(sheet!.x + sheet!.width);
  expect(box!.y + box!.height).toBeLessThan(sheet!.y + sheet!.height);
  expect(errors).toEqual([]);
});

test('a sheet metal part’s drawing: a flat pattern view with bend lines, notes and its size, saved and reopened', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.waitForFunction(() => (window as unknown as { __parametric?: A }).__parametric?.kernelReady);
  const flange = newBaseFlange('B1', 'Base-Flange1', 'S1', 2, 40);
  // An L: 50 and 30 long with one 90° bend.
  const sketch = { id: 'S1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, constraints: [], entities: [
    { id: 'p0', t: 'point', x: 0, y: 0 }, { id: 'p1', t: 'point', x: 50, y: 0 }, { id: 'p2', t: 'point', x: 50, y: 30 },
    { id: 'l0', t: 'line', a: 'p0', b: 'p1' }, { id: 'l1', t: 'line', a: 'p1', b: 'p2' },
  ] };
  await page.evaluate(({ sketch, flange }) => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    a.store.change('Make part', (d) => { d.name = 'Bracket'; d.features = [sketch, flange] as never; d.nextId = 100; });
  }, { sketch, flange });
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __parametric: A }).__parametric.bbox)).toBe(true);
  const flat = await page.evaluate(async () => (await (window as unknown as { __parametric: A }).__parametric.kernel.flatPattern(0)).pattern!);
  const fw = flat.max[0] - flat.min[0], fh = flat.max[1] - flat.min[1];
  expect(flat.bends).toHaveLength(1);

  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  await page.getByRole('tab', { name: 'Drafting' }).click();
  await page.locator('.cm [data-cmd="drawing:flat"]').click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(5, { timeout: 30_000 });
  const v = (await drawing(page)).views[4];
  expect(v.type).toBe('flat');
  // In free room on the sheet, not on top of another view; a second one too, smaller where there is no room at the sheet's scale.
  const overlaps = (id: string) => page.evaluate((id) => {
    const fr = ((window as unknown as { __parametric: A }).__parametric.drawing as unknown as { frames: { id: string; x0: number; y0: number; x1: number; y1: number }[] }).frames;
    const f = fr.find((q) => q.id === id)!;
    return fr.filter((q) => q.id !== id && q.x0 < f.x1 && q.x1 > f.x0 && q.y0 < f.y1 && q.y1 > f.y0).map((q) => q.id);
  }, id);
  expect(await overlaps(v.id)).toEqual([]);
  // It has no hidden lines or tangent edges to show.
  await expect(page.getByRole('checkbox', { name: 'Center marks and hole centerlines' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Show hidden lines' })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Show tangent edges' })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Hidden lines in Flat pattern view' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Hidden lines in Front view' })).toBeEnabled();
  await expect(page.locator('.paper text', { hasText: /^FLAT PATTERN/ })).toHaveCount(1);
  // The bend line, dashed, with its note; the overall size as dimensions.
  await expect(page.locator('.paper text', { hasText: /^UP 90° R / })).toHaveCount(1);
  expect(await page.locator('.paper line[stroke-dasharray="4 1.5"]').count()).toBe(1);
  const fmt = (x: number) => x.toFixed(2);
  await expect(page.locator('.paper text', { hasText: new RegExp(`^${fmt(fw).replace('.', '\\.')}$`) })).not.toHaveCount(0);
  await expect(page.locator('.paper text', { hasText: new RegExp(`^${fmt(fh).replace('.', '\\.')}$`) })).not.toHaveCount(0);
  const bounds = await page.evaluate((id) => ((window as unknown as { __parametric: A }).__parametric.drawing as unknown as Ws).projectionOf(id)!.bounds!, v.id);
  expect(bounds[2] - bounds[0]).toBeCloseTo(fw, 4);
  expect(bounds[3] - bounds[1]).toBeCloseTo(fh, 4);
  // Smart Dimension works on the flat pattern's edges.
  const prims = await page.evaluate((id) => ((window as unknown as { __parametric: A }).__parametric.drawing as unknown as Ws).placements.get(id)!.prims.length, v.id);
  expect(prims).toBeGreaterThanOrEqual(4);
  // Only a detail view can be made from it.
  await page.getByRole('button', { name: 'Flat pattern', exact: true }).click();
  await page.locator('.cm [data-cmd="drawing:projected"]').click();
  await expect(page.locator('.pm-msg.info', { hasText: 'Click the view to make it from.' })).toBeVisible();
  await page.keyboard.press('Escape');

  const svg = await download(page, 'SVG');
  expect(svg).toContain('>FLAT PATTERN<');
  expect(svg).toMatch(/>UP 90° R [\d.]+</);
  const dxf = await download(page, 'DXF');
  expect(dxf).toContain('UP 90%%d R');

  const name = await save(page);
  await reopen(page, name);
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(5, { timeout: 30_000 });
  await expect(page.locator('.paper text', { hasText: /^UP 90° R / })).toHaveCount(1);
  // A deeper flange's flat pattern added again goes where there is room, at a smaller scale.
  await page.evaluate(() => { (window as unknown as { __parametric: A }).__parametric.store.change('Deeper', (d) => { (d.features[1] as unknown as { depth: number }).depth = 90; }); });
  await expect.poll(() => page.evaluate(() => ((window as unknown as { __parametric: A }).__parametric.drawing as unknown as Ws).projectionOf('v5')?.bounds ?? null).then((b) => (b ? Math.max(b[2] - b[0], b[3] - b[1]) : 0))).toBeCloseTo(90, 3);
  await page.getByRole('tab', { name: 'Drafting' }).click();
  await page.locator('.cm [data-cmd="drawing:flat"]').click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(6, { timeout: 30_000 });
  const v2 = (await drawing(page)).views[5];
  expect(v2.scale).toBeLessThan(1);
  await expect.poll(() => overlaps(v2.id)).toEqual([]);
  expect(errors).toEqual([]);
});

test('a weldment’s drawing: a cut list table that follows the part and balloons on members, saved and reopened', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.waitForFunction(() => (window as unknown as { __parametric?: A }).__parametric?.kernelReady);
  const frame = { id: 'S1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, constraints: [], entities: pts('r', [[0, 0], [400, 0], [400, 200], [0, 200]]) };
  const member = newStructuralMember('M1', 'Structural Member1', [['rl0', 'rl1', 'rl2', 'rl3'].map((entity) => ({ sketch: 'S1', entity }))]);
  await page.evaluate(({ frame, member }) => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    a.store.change('Make part', (d) => { d.name = 'Frame'; d.features = [frame, member] as never; d.nextId = 100; });
  }, { frame, member });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.weldments.length)).toBe(4);
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  await page.getByRole('tab', { name: 'Annotation' }).click();
  await page.locator('.cm [data-cmd="drawing:cutList"]').click();
  for (const s of ['ITEM NO.', 'QTY.', 'DESCRIPTION', 'LENGTH (mm)', 'ANGLE1', 'ANGLE2']) await expect(page.locator('.paper text', { hasText: new RegExp(`^${s.replace(/[.()]/g, '\\$&')}$`) })).toHaveCount(1);
  const rows = () => page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    return a.drawing.tableOf(a.store.doc.drawing!.annotations!.find((x) => x.type === 'cutList') as never)!.rows;
  });
  expect((await rows()).map((r) => [r[0], r[1], r[3], r[4], r[5]])).toEqual([['1', '2', '440.00', '45.00°', '45.00°'], ['2', '2', '240.00', '45.00°', '45.00°']]);
  // It follows the model: a longer frame.
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    a.store.change('Longer', (d) => {
      const s = d.features[0] as unknown as { entities: { id: string; x?: number }[] };
      for (const e of s.entities) if (e.id === 'rp1' || e.id === 'rp2') e.x = 500;
    });
  });
  await expect.poll(async () => (await rows())[0][3]).toBe('540.00');
  // A balloon on a member takes its cut list item.
  const edge = await page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    const w = a.drawing as unknown as Ws;
    const p = w.placements.get('v1')!;
    const l = p.prims.filter((q) => q.kind === 'line' && Math.abs(q.a[1] - q.b[1]) < 1e-6).sort((x, y) => Math.abs(y.b[0] - y.a[0]) - Math.abs(x.b[0] - x.a[0]))[0];
    return { x: p.tx + (l.a[0] * 0.7 + l.b[0] * 0.3) * p.s, y: p.ty + l.a[1] * p.s, item: a.drawing.itemOf('part', l.edge) };
  });
  expect(edge.item).not.toBeNull();
  await page.locator('.cm [data-cmd="drawing:balloon"]').click();
  await clickSheet(page, edge.x, edge.y);
  await clickSheet(page, edge.x, edge.y - 20);
  await expect.poll(async () => (await drawing(page)).annotations!.filter((a) => a.type === 'balloon').length).toBe(1);
  await page.keyboard.press('Escape');
  const pdf = await download(page, 'PDF');
  expect(pdf).toContain('(DESCRIPTION) Tj');

  const name = await save(page);
  await reopen(page, name);
  await page.getByRole('tab', { name: 'Drawing' }).click();
  await expect(page.locator('.paper g[data-view]')).toHaveCount(4, { timeout: 30_000 });
  await expect(page.locator('.paper text', { hasText: /^ANGLE1$/ })).toHaveCount(1);
  await expect(page.locator('.paper text', { hasText: /^540\.00$/ })).not.toHaveCount(0);
  expect(errors).toEqual([]);
});
