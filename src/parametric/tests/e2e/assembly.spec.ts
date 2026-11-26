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
  await page.screenshot({ path: '/private/tmp/claude-501/-Users-nj-Documents-GitHub-everything-src-parametric/10c365cb-dda2-48fe-81cf-fed8b9c07fb6/scratchpad/asm/shot1.png' });
  expect(errors).toEqual([]);
});
