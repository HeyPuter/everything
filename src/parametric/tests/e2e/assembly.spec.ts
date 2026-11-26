import { type Page, expect, test } from '@playwright/test';
import { openApp } from './helpers';

type A = import('../../src/app/app').App;

const pts = (prefix: string, p: [number, number][]) => [
  ...p.map(([x, y], i) => ({ id: `${prefix}p${i}`, t: 'point', x, y })),
  ...p.map((_, i) => ({ id: `${prefix}l${i}`, t: 'line', a: `${prefix}p${i}`, b: `${prefix}p${(i + 1) % p.length}` })),
];
const extrude = (id: string, sketch: string, depth: number) => ({ id, name: id, type: 'extrude', sketch, cut: false, end: 'blind', depth, flip: false, dir2: null, draft: 0, draftOutward: false, thin: null });
/** A 40 × 20 × 10 block with a Ø8 through hole near one end. */
const BLOCK = [
  { id: 'S1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities: [...pts('r', [[0, 0], [40, 0], [40, 20], [0, 20]]), { id: 'hc', t: 'point', x: 10, y: 10 }, { id: 'h', t: 'circle', c: 'hc', r: 4 }], constraints: [] },
  extrude('E1', 'S1', 10),
];
/** A Ø8 pin, 30 long. */
const PIN = [
  { id: 'S1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities: [{ id: 'c', t: 'point', x: 0, y: 0 }, { id: 'k', t: 'circle', c: 'c', r: 4 }], constraints: [] },
  extrude('E1', 'S1', 30),
];

async function makePart(page: Page, name: string, features: unknown[]) {
  await page.evaluate(async ({ name, features }) => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    await a.commands.get('new')!.run();
    a.store.change('Make part', (d) => { d.name = name; d.features = features as never; d.nextId = 100; });
    a.commands.run('save');
  }, { name, features });
  await expect(page).toHaveTitle(`${name} - Parametric`);
}

/** Where the centre of a component's face (by its name in the part) is on the screen. */
async function facePoint(page: Page, comp: string, face: string) {
  const at = await page.evaluate(({ comp, face }) => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    const id = a.assembly!.doc.components.find((c) => c.name === comp)!.id;
    const f = a.faces.find((x) => x.name === `${id}#${face}`)!;
    return a.viewport.project(f.center);
  }, { comp, face });
  const box = (await page.locator('canvas.gl').boundingBox())!;
  return { x: box.x + at[0], y: box.y + at[1] };
}

async function clickFace(page: Page, comp: string, face: string) {
  const p = await facePoint(page, comp, face);
  await page.mouse.click(p.x, p.y);
}

async function insert(page: Page, name: string) {
  void page.evaluate(() => { (window as unknown as { __parametric: A }).__parametric.commands.run('insertComponent'); });
  const dlg = page.getByRole('dialog', { name: 'Insert Components' });
  await dlg.getByRole('button', { name: new RegExp(`^${name} This browser`) }).click();
  await expect(dlg).toHaveCount(0);
}

test('builds an assembly of two parts, mates them, drags, explodes, saves and reopens it', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.waitForFunction(() => (window as unknown as { __parametric?: A }).__parametric?.kernelReady);
  await makePart(page, 'Block', BLOCK);
  await makePart(page, 'Pin', PIN);
  await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('newAssembly'); });
  await expect(page).toHaveTitle(/Assembly\d+ - Parametric/);
  await expect(page.getByRole('tab', { name: 'Assembly' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Features' })).toBeHidden();
  await insert(page, 'Block');
  await insert(page, 'Pin');
  const tree = page.getByRole('tree', { name: 'Assembly design tree' });
  await expect(tree.getByRole('treeitem', { name: '(f) Block<1>' })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: '(-) Pin<1>' })).toBeVisible();
  // The tree lists a component before its geometry arrives (slow under load).
  await page.waitForFunction(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    return ['Block<1>', 'Pin<1>'].every((n) => {
      const id = a.assembly?.doc.components.find((c) => c.name === n)?.id;
      return !!id && a.faces.some((f) => f.feature === id && f.type === 'cylinder');
    });
  });
  // Concentric: the pin's round face and the block's hole, selected first.
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    const comp = (n: string) => a.assembly!.doc.components.find((c) => c.name === n)!.id;
    const cyl = (n: string) => a.faces.findIndex((f) => f.feature === comp(n) && f.type === 'cylinder');
    a.selection.set([cyl('Pin<1>'), cyl('Block<1>')].map((index) => ({ kind: 'face' as const, index, name: a.faces[index].name })));
  });
  await page.getByRole('toolbar').getByRole('button', { name: 'Mate', exact: true }).or(page.locator('.cm [data-cmd="mate"]')).first().click();
  const pm = page.locator('.pm');
  await expect(pm.getByRole('combobox', { name: 'Mate type' })).toHaveValue('concentric');
  await expect(pm.getByRole('status').filter({ hasText: 'degrees of freedom' })).toBeVisible();
  await pm.getByRole('button', { name: 'OK' }).click();
  await expect(tree.getByRole('treeitem', { name: /Concentric1/ })).toBeVisible();
  const axisGap = () => page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    const m = a.assembly!;
    const pin = m.doc.components.find((c) => c.name === 'Pin<1>')!;
    const pl = m.solved.get(pin.id)!;
    return { x: pl.p[0], y: pl.p[1], z: pl.p[2] };
  });
  const before = await axisGap();
  expect(before.x).toBeCloseTo(10, 4);
  expect(before.y).toBeCloseTo(10, 4);
  await expect(page.locator('.statusbar')).toContainText('Under Defined (2 DOF)');

  // Dragging the pin slides it along the hole: the mate holds.
  const end = await facePoint(page, 'Pin<1>', 'E1:cap1');
  await page.mouse.move(end.x, end.y);
  await page.mouse.down();
  await page.mouse.move(end.x + 40, end.y - 30, { steps: 5 });
  await page.mouse.move(end.x + 90, end.y - 60, { steps: 5 });
  await page.mouse.up();
  const after = await axisGap();
  expect(after.x).toBeCloseTo(10, 4);
  expect(after.y).toBeCloseTo(10, 4);
  expect(Math.abs(after.z - before.z)).toBeGreaterThan(1);
  expect(await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.undoLabel)).toBe('Move component');

  // Coincident by clicking the pin's end and the block's front face.
  await page.locator('.cm [data-cmd="mate"]').click();
  await clickFace(page, 'Pin<1>', 'E1:cap1');
  await clickFace(page, 'Block<1>', 'E1:cap1');
  await expect(pm.getByRole('combobox', { name: 'Mate type' })).toHaveValue('coincident');
  await pm.getByRole('button', { name: 'OK' }).click();
  await expect(tree.getByRole('treeitem', { name: /Coincident1/ })).toBeVisible();
  await expect(page.locator('.statusbar')).toContainText('Under Defined (1 DOF)');
  expect((await axisGap()).z).toBeCloseTo(-20, 4);

  // Exploded view: the pin moves out along Z, and back.
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    a.selection.set([{ kind: 'feature', id: a.assembly!.doc.components.find((c) => c.name === 'Pin<1>')!.id }]);
  });
  await page.locator('.cm [data-cmd="explodedView"]').click();
  await pm.getByRole('combobox', { name: 'Explode direction' }).selectOption('z');
  await pm.getByRole('textbox', { name: 'Distance' }).fill('60');
  await pm.getByRole('textbox', { name: 'Distance' }).press('Enter');
  await pm.getByRole('button', { name: 'OK' }).click();
  await expect(tree.getByRole('treeitem', { name: /Explode Step1/ })).toBeVisible();
  const shownZ = () => page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    const pin = a.assembly!.doc.components.find((c) => c.name === 'Pin<1>')!;
    return a.assembly!.shownPlacement(pin.id)!.p[2];
  });
  expect(await shownZ()).toBeCloseTo(40, 4);
  await page.locator('.cm [data-cmd="toggleExplode"]').click();
  expect(await shownZ()).toBeCloseTo(-20, 4);

  // Bill of materials.
  await page.locator('.cm [data-cmd="billOfMaterials"]').click();
  const bom = page.getByRole('dialog', { name: 'Bill of Materials' });
  await expect(bom.getByRole('row')).toHaveCount(3);
  await expect(bom.getByRole('row').nth(1)).toContainText('Block');
  await bom.locator('[data-value="close"]').click();

  // Save, open another document, and open the assembly again.
  await page.keyboard.press('Meta+s');
  await expect(page).toHaveTitle(/^Assembly\d+ - Parametric$/);
  const title = await page.title();
  const name = title.replace(' - Parametric', '');
  await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('new'); });
  await expect(page).toHaveTitle(/^Part\d+ - Parametric$/);
  await expect(page.getByRole('tab', { name: 'Features' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Assembly' })).toBeHidden();
  void page.evaluate(() => { (window as unknown as { __parametric: A }).__parametric.commands.run('open'); });
  await page.getByRole('dialog', { name: 'Open' }).getByRole('button', { name: new RegExp(`^${name} This browser`) }).click();
  await expect(page).toHaveTitle(`${name} - Parametric`);
  await expect(tree.getByRole('treeitem', { name: '(f) Block<1>' })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: /Concentric1/ })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: /Coincident1/ })).toBeVisible();
  await expect(page.locator('.statusbar')).toContainText('Under Defined (1 DOF)');
  expect((await axisGap()).z).toBeCloseTo(-20, 4);
  // Undo and redo work in the reopened assembly.
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    a.assembly!.commit('Fix', (d) => { for (const c of d.components) c.fixed = true; });
  });
  await expect(tree.getByRole('treeitem', { name: '(f) Pin<1>' })).toBeVisible();
  await page.keyboard.press('Meta+z');
  await expect(tree.getByRole('treeitem', { name: '(-) Pin<1>' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('editing a part from its assembly, interference, measuring and STEP export', async ({ page }) => {
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
  // Pin in the hole, its far end flush with the block's front face.
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    const m = a.assembly!;
    const [block, pin] = m.doc.components;
    const face = (c: string, name: string) => { const g = m.geometryOf(m.component(c)!.part)!; const f = g.faces.find((x) => x.name === name)!; return { name: f.name, sig: { type: f.type, c: f.center, n: f.normal, area: f.area } }; };
    const cyl = (c: string) => { const g = m.geometryOf(m.component(c)!.part)!; const f = g.faces.find((x) => x.type === 'cylinder')!; return { name: f.name, sig: { type: f.type, c: f.center, area: f.area } }; };
    m.commit('Add mates', (d) => {
      d.mates.push({ id: 'm90', name: 'Concentric1', type: 'concentric', a: { comp: block.id, face: cyl(block.id) }, b: { comp: pin.id, face: cyl(pin.id) }, aligned: true });
      d.mates.push({ id: 'm91', name: 'Coincident1', type: 'coincident', a: { comp: block.id, face: face(block.id, 'E1:cap1') }, b: { comp: pin.id, face: face(pin.id, 'E1:cap1') }, aligned: true });
    });
  });
  await expect(page.locator('.statusbar')).toContainText('Under Defined (1 DOF)');
  const pinZ = () => page.evaluate(() => {
    const m = (window as unknown as { __parametric: A }).__parametric.assembly!;
    return m.solved.get(m.doc.components[1].id)!.p[2];
  });
  expect(await pinZ()).toBeCloseTo(-20, 4);
  await page.keyboard.press('Meta+s');
  await expect(page).toHaveTitle(/^Assembly\d+ - Parametric$/);
  const asmTitle = await page.title();

  // No interference: the pin fits the hole exactly.
  await page.locator('.cm [data-cmd="interference"]').click();
  await expect(page.locator('.pm')).toContainText('No interference');
  await page.locator('.pm').getByRole('button', { name: 'Close' }).click();

  // Measure between faces of two components (the kernel places them too).
  const gap = await page.evaluate(async () => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    const m = a.assembly!;
    const [block, pin] = m.doc.components;
    const back = a.faces.findIndex((f) => f.name === `${block.id}#E1:cap0`);
    const pinEnd = a.faces.findIndex((f) => f.name === `${pin.id}#E1:cap0`);
    return (await a.kernel.measure({ kind: 'face', index: back }, { kind: 'face', index: pinEnd })).distance;
  });
  expect(gap).toBeCloseTo(20, 4);

  // STEP export of the whole assembly, components as named solids.
  const download = page.waitForEvent('download');
  await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('exportStep'); });
  const file = await (await download).path();
  const { readFileSync } = await import('node:fs');
  const step = new TextDecoder().decode(readFileSync(file));
  expect(step).toContain('Block<1>');
  expect(step).toContain('Pin<1>');

  // Open the pin, make it longer, save, and go back: the assembly takes the change.
  await tree.getByRole('treeitem', { name: '(-) Pin<1>' }).click();
  await page.locator('.cm [data-cmd="openPart"]').click();
  await expect(page).toHaveTitle('Pin - Parametric');
  await expect(page.getByRole('tab', { name: 'Features' })).toBeVisible();
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    a.store.change('Longer', (d) => { (d.features[1] as { depth: number }).depth = 50; });
  });
  await page.keyboard.press('Meta+s');
  await expect(page).toHaveTitle('Pin - Parametric');
  await page.getByRole('button', { name: `Back to ${asmTitle.replace(' - Parametric', '')}` }).click();
  await expect(page).toHaveTitle(/Assembly\d+ - Parametric$/);
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('Pin changed since the assembly was saved');
  // The coincident mate holds the new end flush: the pin now starts 40 mm behind the face.
  await expect.poll(pinZ).toBeCloseTo(-40, 4);

  // An overlapping second block is found by interference detection.
  await page.evaluate(() => {
    const m = (window as unknown as { __parametric: A }).__parametric.assembly!;
    m.commit('Overlap', (d) => {
      d.components.push({ ...d.components[0], id: 'c99', name: 'Block<2>', fixed: false, placement: { p: [20, 0, 0], q: [0, 0, 0, 1] } });
    }, false);
  });
  await page.locator('.cm [data-cmd="interference"]').click();
  await expect(page.locator('.pm')).toContainText('1 interference found');
  await expect(page.locator('.pm')).toContainText('Block<1> and Block<2>');
  expect(await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.renderer.hasPreviewBody)).toBe(false);
  expect(errors).toEqual([]);
});

test('the assembly workspace, its tree and the Mate panel have no serious accessibility violations', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.waitForFunction(() => (window as unknown as { __parametric?: A }).__parametric?.kernelReady);
  await makePart(page, 'Block', BLOCK);
  await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('newAssembly'); });
  await insert(page, 'Block');
  await insert(page, 'Block');
  const tree = page.getByRole('tree', { name: 'Assembly design tree' });
  await expect(tree.getByRole('treeitem', { name: '(-) Block<2>' })).toBeVisible();
  // Keyboard: rename from the tree with F2.
  await tree.getByRole('treeitem', { name: '(-) Block<2>' }).focus();
  await page.keyboard.press('F2');
  await page.keyboard.type('Cover');
  await page.keyboard.press('Enter');
  await expect(tree.getByRole('treeitem', { name: '(-) Cover' })).toBeVisible();
  await page.locator('.cm [data-cmd="mate"]').click();
  await expect(page.locator('.pm')).toContainText('Select two entities to mate');
  await page.addScriptTag({ path: 'node_modules/axe-core/axe.min.js' });
  const violations = await page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const r = await window.axe.run(document, { resultTypes: ['violations'] });
    return r.violations
      .filter((v: { impact: string }) => v.impact === 'serious' || v.impact === 'critical')
      .map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  });
  expect(violations).toEqual([]);
  expect(errors).toEqual([]);
});

test('a new explode step never takes the name of one already in the list', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.waitForFunction(() => (window as unknown as { __parametric?: A }).__parametric?.kernelReady);
  await makePart(page, 'Block', BLOCK);
  await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('newAssembly'); });
  await insert(page, 'Block');
  await insert(page, 'Block');
  const tree = page.getByRole('tree', { name: 'Assembly design tree' });
  await expect(tree.getByRole('treeitem', { name: '(-) Block<2>' })).toBeVisible();
  const addStep = async () => {
    await tree.getByRole('treeitem', { name: '(-) Block<2>' }).click();
    await page.locator('.cm [data-cmd="explodedView"]').click();
    await page.locator('.pm').getByRole('button', { name: 'OK' }).click();
    await expect(page.locator('.pm')).toHaveCount(0);
  };
  await addStep();
  await addStep();
  await tree.getByRole('treeitem', { name: /^Explode Step1/ }).click();
  await page.keyboard.press('Delete');
  await page.getByRole('dialog', { name: 'Delete' }).getByRole('button', { name: 'Delete' }).click();
  await expect(tree.getByRole('treeitem', { name: /^Explode Step1/ })).toHaveCount(0);
  await addStep();
  const names = () => page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.assembly!.doc.explode.map((s) => s.name));
  expect(await names()).toEqual(['Explode Step2', 'Explode Step3']);
  expect(errors).toEqual([]);
});

test('a hidden component still counts in the mass properties of the assembly', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.waitForFunction(() => (window as unknown as { __parametric?: A }).__parametric?.kernelReady);
  await makePart(page, 'Block', BLOCK);
  await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('newAssembly'); });
  await insert(page, 'Block');
  await insert(page, 'Block');
  const tree = page.getByRole('tree', { name: 'Assembly design tree' });
  await expect(tree.getByRole('treeitem', { name: '(-) Block<2>' })).toBeVisible();
  const volume = async () => {
    void page.evaluate(() => { (window as unknown as { __parametric: A }).__parametric.commands.run('massProperties'); });
    const dlg = page.getByRole('dialog', { name: 'Mass Properties' });
    const text = await dlg.getByRole('row').filter({ hasText: 'Volume' }).innerText();
    await dlg.locator('[data-value="ok"]').click();
    await expect(dlg).toHaveCount(0);
    return Number(text.replace(/[^\d.]/g, '').replace(/3$/, ''));
  };
  // Two 40 × 20 × 10 blocks with a Ø8 hole.
  const one = 8000 - Math.PI * 16 * 10;
  expect(await volume()).toBeCloseTo(2 * one, 0);
  await tree.getByRole('treeitem', { name: '(-) Block<2>' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Hide' }).click();
  await expect(tree.getByRole('treeitem', { name: /Block<2> \(hidden\)/ })).toBeVisible();
  expect(await volume()).toBeCloseTo(2 * one, 0);
  await tree.getByRole('treeitem', { name: /Block<2> \(hidden\)/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Suppress' }).click();
  expect(await volume()).toBeCloseTo(one, 0);
  expect(errors).toEqual([]);
});

test('the mates of a suppressed component show as suppressed in the tree', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.waitForFunction(() => (window as unknown as { __parametric?: A }).__parametric?.kernelReady);
  await makePart(page, 'Block', BLOCK);
  await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('newAssembly'); });
  await insert(page, 'Block');
  await insert(page, 'Block');
  const tree = page.getByRole('tree', { name: 'Assembly design tree' });
  await expect(tree.getByRole('treeitem', { name: '(-) Block<2>' })).toBeVisible();
  await page.evaluate(() => {
    const m = (window as unknown as { __parametric: A }).__parametric.assembly!;
    const [a, b] = m.doc.components;
    m.commit('Lock', (d) => { d.mates.push({ id: 'm90', name: 'Lock1', type: 'lock', a: { comp: a.id }, b: { comp: b.id }, aligned: false, rel: { p: [60, 0, 0], q: [0, 0, 0, 1] } }); });
  });
  const mate = tree.getByRole('treeitem', { name: /^Lock1/ });
  await expect(mate).not.toHaveAttribute('aria-description', /Suppressed/);
  await tree.getByRole('treeitem', { name: 'Block<2>', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Suppress' }).click();
  await expect(mate).toHaveAttribute('aria-description', /Suppressed/);
  await expect(mate).toHaveClass(/suppressed/);
  expect(errors).toEqual([]);
});

test('Open Part on a component whose part file was deleted opens the copy kept in the assembly', async ({ page }) => {
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
  await page.keyboard.press('Meta+s');
  await expect(page).toHaveTitle(/^Assembly\d+ - Parametric$/);
  const name = (await page.title()).replace(' - Parametric', '');
  // The pin's file is deleted from this browser.
  await page.evaluate(async () => {
    const key = 'parametric:local-parts';
    const index = JSON.parse(localStorage.getItem(key)!) as { id: string; name: string }[];
    const pin = index.find((p) => p.name === 'Pin')!;
    localStorage.setItem(key, JSON.stringify(index.filter((p) => p !== pin)));
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('parametric-parts');
    await dir.removeEntry(`${pin.id}.parametric`);
  });
  await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('new'); });
  await expect(page).toHaveTitle(/^Part\d+ - Parametric$/);
  void page.evaluate(() => { (window as unknown as { __parametric: A }).__parametric.commands.run('open'); });
  await page.getByRole('dialog', { name: 'Open' }).getByRole('button', { name: new RegExp(`^${name} This browser`) }).click();
  await expect(page).toHaveTitle(`${name} - Parametric`);
  const pin = tree.getByRole('treeitem', { name: '(-) Pin<1>' });
  await expect(pin).toHaveAttribute('aria-description', /part file of Pin was not found/);
  await pin.click();
  await page.locator('.cm [data-cmd="openPart"]').click();
  await expect(page).toHaveTitle(/Pin - Parametric$/);
  await expect(page.getByRole('region', { name: 'Notifications' })).toContainText('the copy kept in the assembly opened');
  expect(await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.doc.features.length)).toBe(2);
  expect(errors).toEqual([]);
});
