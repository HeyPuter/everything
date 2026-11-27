import { type Page, expect, test } from '@playwright/test';
import { openApp } from './helpers';

type A = import('../../src/app/app').App;

const pts = (prefix: string, p: [number, number][]) => [
  ...p.map(([x, y], i) => ({ id: `${prefix}p${i}`, t: 'point', x, y })),
  ...p.map((_, i) => ({ id: `${prefix}l${i}`, t: 'line', a: `${prefix}p${i}`, b: `${prefix}p${(i + 1) % p.length}` })),
];
const extrude = (id: string, sketch: string, depth: number) => ({ id, name: id, type: 'extrude', sketch, cut: false, end: 'blind', depth, flip: false, dir2: null, draft: 0, draftOutward: false, thin: null });
const circle = (id: string, x: number, y: number, r: number) => [{ id: `${id}c`, t: 'point', x, y }, { id, t: 'circle', c: `${id}c`, r }];
/** A 100 × 40 × 10 plate with Ø20 holes 30 mm apart (for gears of Ø20 and Ø40 pitch). */
const PLATE = [
  { id: 'S1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities: [...pts('r', [[0, 0], [100, 0], [100, 40], [0, 40]]), ...circle('h1', 20, 20, 10), ...circle('h2', 50, 20, 10)], constraints: [] },
  extrude('E1', 'S1', 10),
];
const disc = (r: number) => [
  { id: 'S1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities: circle('k', 0, 0, r), constraints: [] },
  extrude('E1', 'S1', 5),
];
/** An eccentric cam: a Ø40 disc whose Ø8 bore is 5 off its centre, 10 thick. */
const CAM = [
  { id: 'S1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities: [...circle('k', 5, 0, 20), ...circle('hb', 0, 0, 4)], constraints: [] },
  extrude('E1', 'S1', 10),
];
/** A Ø8 shaft, 30 long. */
const SHAFT = [
  { id: 'S1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities: circle('k', 0, 0, 4), constraints: [] },
  extrude('E1', 'S1', 30),
];
/** A 100 × 10 × 10 bar (a rack, or a tab). */
const BAR = [
  { id: 'S1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, entities: pts('r', [[0, 0], [100, 0], [100, 10], [0, 10]]), constraints: [] },
  extrude('E1', 'S1', 10),
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

async function insert(page: Page, name: string) {
  void page.evaluate(() => { (window as unknown as { __parametric: A }).__parametric.commands.run('insertComponent'); });
  const dlg = page.getByRole('dialog', { name: 'Insert Components' });
  await dlg.getByRole('button', { name: new RegExp(`^${name} This browser`) }).click();
  await expect(dlg).toHaveCount(0);
}

/** Waits until every listed component's faces are shown. */
async function built(page: Page, names: string[]) {
  await page.waitForFunction((names) => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    return names.every((n) => {
      const id = a.assembly?.doc.components.find((c) => c.name === n)?.id;
      return !!id && a.faces.some((f) => f.feature === id);
    });
  }, names);
}

/** A face (by its name in the part) or edge of a component, as the graphics area picks it. */
type Pick = { comp: string; face?: string; edge?: 'x' };
async function picked(page: Page, p: Pick) {
  return page.evaluate(({ comp, face, edge }) => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    const id = a.assembly!.doc.components.find((c) => c.name === comp)!.id;
    if (edge) {
      // A straight edge along x.
      const index = a.edges.findIndex((e) => e.name.startsWith(`${id}#`) && e.type === 'line' && Math.abs(e.dir?.[0] ?? 0) > 0.99);
      return { kind: 'edge' as const, index, name: a.edges[index].name };
    }
    const index = a.faces.findIndex((f) => f.name === `${id}#${face}`);
    return { kind: 'face' as const, index, name: a.faces[index].name };
  }, p);
}

/** Selects in the graphics area before a command opens (as clicking faces does). */
async function select(page: Page, picks: Pick[]) {
  const items = await Promise.all(picks.map((p) => picked(page, p)));
  await page.evaluate((items) => { (window as unknown as { __parametric: A }).__parametric.selection.set(items); }, items);
}

/** A pick in the graphics area while a panel is open (what a click on the face does). */
async function pick(page: Page, p: Pick) {
  const item = await picked(page, p);
  await page.evaluate((item) => { const a = (window as unknown as { __parametric: A }).__parametric; a.panel!.onPick(item, false); }, item);
}

async function openMate(page: Page, type: string) {
  await page.locator('.cm [data-cmd="mate"]').click();
  const pm = page.locator('.pm');
  await pm.getByRole('combobox', { name: 'Mate type' }).selectOption(type);
  return pm;
}

/** Serious and critical accessibility violations on the page (axe). */
async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: 'node_modules/axe-core/axe.min.js' });
  return page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const r = await window.axe.run(document, { resultTypes: ['violations'] });
    return r.violations
      .filter((v: { impact: string }) => v.impact === 'serious' || v.impact === 'critical')
      .map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  });
}

async function newAssemblyWith(page: Page, parts: [string, unknown[]][], comps: string[]) {
  await page.getByRole('button', { name: /New part/ }).click();
  await page.waitForFunction(() => (window as unknown as { __parametric?: A }).__parametric?.kernelReady);
  for (const [name, f] of parts) await makePart(page, name, f);
  await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('newAssembly'); });
  await expect(page.getByRole('tab', { name: 'Assembly' })).toBeVisible();
  for (const c of comps) await insert(page, c);
}

test('hinges and a gear through the Mate panel, a motion study that plays and plots, saved and opened again', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await openApp(page);
  await newAssemblyWith(page, [['Plate', PLATE], ['Small', disc(10)], ['Large', disc(20)]], ['Plate', 'Small', 'Large']);
  await built(page, ['Plate<1>', 'Small<1>', 'Large<1>']);
  const tree = page.getByRole('tree', { name: 'Assembly design tree' });

  // Hinges: the gear's round face in the plate's hole, its back face on the plate's front.
  for (const [gear, hole] of [['Small<1>', 'E1:side:h1'], ['Large<1>', 'E1:side:h2']]) {
    await select(page, [{ comp: gear, face: 'E1:side:k' }, { comp: 'Plate<1>', face: hole }]);
    const pm = await openMate(page, 'hinge');
    await expect(pm.getByRole('group', { name: 'Concentric selections' })).toContainText(gear);
    await pm.getByRole('group', { name: 'Coincident selections' }).click();
    await pick(page, { comp: 'Plate<1>', face: 'E1:cap1' });
    await pick(page, { comp: gear, face: 'E1:cap0' });
    await expect(pm.getByRole('status').filter({ hasText: 'The mate holds' })).toBeVisible();
    if (gear === 'Small<1>') expect(await axeViolations(page)).toEqual([]);
    await pm.getByRole('button', { name: 'OK' }).click();
  }
  await expect(tree.getByRole('treeitem', { name: /^Hinge2/ })).toBeVisible();
  await expect(page.locator('.statusbar')).toContainText('Under Defined (2 DOF)');

  // Gear: pitch diameters from the round faces (20 and 40).
  await select(page, [{ comp: 'Small<1>', face: 'E1:side:k' }, { comp: 'Large<1>', face: 'E1:side:k' }]);
  const pm = await openMate(page, 'gear');
  await expect(pm.getByRole('textbox', { name: 'Pitch diameter of the first gear' })).toHaveValue('20');
  await expect(pm.getByRole('textbox', { name: 'Pitch diameter of the second gear' })).toHaveValue('40');
  await expect(pm.getByRole('status').filter({ hasText: '1 degrees of freedom' })).toBeVisible();
  await pm.getByRole('button', { name: 'OK' }).click();
  await expect(tree.getByRole('treeitem', { name: /^Gear1/ })).toBeVisible();
  await expect(page.locator('.statusbar')).toContainText('Under Defined (1 DOF)');

  // Rotate the small gear by dragging: the large one turns half as far, the other way.
  const turns = () => page.evaluate(() => {
    const m = (window as unknown as { __parametric: A }).__parametric.assembly!;
    const z = (n: string) => { const q = m.solved.get(m.doc.components.find((c) => c.name === n)!.id)!.q; return (2 * Math.atan2(q[2], q[3]) * 180) / Math.PI; };
    return { small: z('Small<1>'), large: z('Large<1>') };
  });
  const before = await turns();
  await page.evaluate(() => {
    const m = (window as unknown as { __parametric: A }).__parametric.assembly!;
    const id = m.doc.components.find((c) => c.name === 'Small<1>')!.id;
    let pl = new Map(m.solved);
    for (let k = 1; k <= 4; k++) pl = m.dragSolve({ kind: 'rotate', body: id, q: [0, 0, Math.sin((k * 10 * Math.PI) / 360), Math.cos((k * 10 * Math.PI) / 360)] }, pl);
    m.commitPlacements('Rotate component', pl);
  });
  const after = await turns();
  expect(after.small - before.small).toBeGreaterThan(20);
  expect(after.large - before.large).toBeCloseTo(-(after.small - before.small) / 2, 3);

  // A motion study: a rotary motor on the small gear at 90°/s for 4 s.
  await page.locator('.cm [data-cmd="motionStudy"]').click();
  await expect(pm.getByRole('button', { name: 'Calculate' })).toBeDisabled();
  await pm.getByRole('button', { name: 'Add Motor' }).click();
  await pm.getByRole('group', { name: 'Motor axis' }).click();
  await pick(page, { comp: 'Small<1>', face: 'E1:side:k' });
  await expect(pm.getByRole('group', { name: 'Motor axis' })).toContainText('Small<1>');
  await pm.getByRole('textbox', { name: 'Speed' }).fill('90');
  await pm.getByRole('textbox', { name: 'Speed' }).press('Enter');
  await pm.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(pm.getByRole('listitem').filter({ hasText: 'RotaryMotor1' })).toContainText('Small<1>: 90°/s');
  await pm.getByRole('spinbutton', { name: 'Duration (s)' }).fill('4');
  await pm.getByRole('spinbutton', { name: 'Duration (s)' }).press('Enter');
  await pm.getByRole('button', { name: 'Calculate' }).click();
  await expect(pm.getByRole('status').filter({ hasText: 'Calculated 121 frames' })).toBeVisible();
  // It plays: the time moves on and the large gear turns.
  const clock = pm.locator('.kin-clock');
  await expect(clock).toContainText('/ 4.00 s');
  await expect.poll(async () => Number((await clock.innerText()).split(' ')[0]), { timeout: 10_000 }).toBeGreaterThan(0.3);
  await pm.getByRole('button', { name: 'Pause' }).click();
  await expect(pm.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  // Scrubbed to the end: the small gear turned 360°, the large one 180° back.
  await pm.getByRole('button', { name: 'To the end' }).click();
  await expect(clock).toContainText('4.00 s / 4.00 s');
  const shown = await page.evaluate(() => {
    const m = (window as unknown as { __parametric: A }).__parametric.assembly!;
    const z = (n: string) => { const q = m.shownPlacement(m.doc.components.find((c) => c.name === n)!.id)!.q; return (2 * Math.atan2(q[2], q[3]) * 180) / Math.PI; };
    // Both read in (-180°, 180°]: compared a full turn apart.
    const d = z('Large<1>') - z('Small<1>') / -2;
    return d - 360 * Math.round(d / 360);
  });
  expect(Math.abs(shown)).toBeLessThan(1e-3);
  // Plot the large gear's turn about Z.
  await pm.getByRole('combobox', { name: 'Result of' }).selectOption({ label: 'Component: Large<1>' });
  await pm.getByRole('combobox', { name: 'Quantity' }).selectOption({ label: 'Angular displacement' });
  await pm.getByRole('combobox', { name: 'Vector component' }).selectOption({ label: 'Z' });
  const plot = pm.getByRole('img', { name: /Plot of Large<1> angular displacement Z/ });
  await expect(plot).toHaveAttribute('aria-label', /from -180 to 0/);
  await pm.getByRole('combobox', { name: 'Quantity' }).selectOption({ label: 'Angular velocity' });
  await expect(pm.getByRole('img', { name: /angular velocity Z \(°\/s\)/ })).toHaveAttribute('aria-label', /from -45 to -45/);
  expect(await axeViolations(page)).toEqual([]);
  const download = page.waitForEvent('download');
  await pm.getByRole('button', { name: 'Download CSV' }).click();
  const { readFileSync } = await import('node:fs');
  const csv = new TextDecoder().decode(readFileSync(await (await download).path())).split('\n');
  expect(csv[0]).toContain('Time (s),Displacement X (mm)');
  expect(csv[0]).toContain('Angle Z (deg)');
  expect(csv).toHaveLength(122);
  const col = csv[0].split(',').indexOf('Angle Z (deg)');
  expect(Number(csv[121].split(',')[col])).toBeCloseTo(-180, 3);
  await pm.getByRole('button', { name: 'OK' }).click();
  const study = tree.getByRole('treeitem', { name: /^Motion Study1/ });
  await expect(study).toContainText('(1 motor, calculated)');

  // Editing the assembly puts the results out of date; undo brings them back.
  await tree.getByRole('treeitem', { name: /^Gear1/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reverse Direction' }).click();
  await expect(study).toContainText('out of date');
  await page.keyboard.press('Meta+z');
  await expect(study).toContainText('calculated');

  // Saved and opened again: mates and study are kept.
  await page.keyboard.press('Meta+s');
  await expect(page).toHaveTitle(/^Assembly\d+ - Parametric$/);
  const name = (await page.title()).replace(' - Parametric', '');
  await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('new'); });
  await expect(page).toHaveTitle(/^Part\d+ - Parametric$/);
  void page.evaluate(() => { (window as unknown as { __parametric: A }).__parametric.commands.run('open'); });
  await page.getByRole('dialog', { name: 'Open' }).getByRole('button', { name: new RegExp(`^${name} This browser`) }).click();
  await expect(page).toHaveTitle(`${name} - Parametric`);
  await expect(tree.getByRole('treeitem', { name: /^Gear1/ })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: /^Hinge1/ })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: /^Motion Study1 \(1 motor\)/ })).toBeVisible();
  await expect(page.locator('.statusbar')).toContainText('Under Defined (1 DOF)');
  // Opened from the tree, it calculates again.
  await tree.getByRole('treeitem', { name: /^Motion Study1/ }).dblclick();
  await expect(pm.getByRole('listitem').filter({ hasText: 'RotaryMotor1' })).toBeVisible();
  await pm.getByRole('button', { name: 'Calculate' }).click();
  await expect(pm.getByRole('status').filter({ hasText: 'Calculated 121 frames' })).toBeVisible();
  await pm.getByRole('button', { name: 'Cancel' }).click();

  // The small gear's hinge limited to ±45° from where it is: the study stops there.
  await tree.getByRole('treeitem', { name: /^Hinge1/ }).dblclick();
  await expect(pm.getByRole('combobox', { name: 'Mate type' })).toHaveValue('hinge');
  await pm.getByRole('checkbox', { name: /Limit the angle/ }).check();
  await expect(pm.getByRole('textbox', { name: 'Maximum' })).toHaveValue('45');
  await expect(pm.getByRole('status').filter({ hasText: 'The mate holds' })).toBeVisible();
  await pm.getByRole('button', { name: 'OK' }).click();
  expect(await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.assembly!.doc.mates.find((m) => m.name === 'Hinge1'))).toMatchObject({ limit: { min: -45, max: 45 }, rel: { q: expect.any(Array) } });
  await expect(tree.getByRole('treeitem', { name: /^Motion Study1/ })).toBeVisible();
  await tree.getByRole('treeitem', { name: /^Motion Study1/ }).dblclick();
  await pm.getByRole('button', { name: 'Calculate' }).click();
  await expect(pm.getByRole('alert').filter({ hasText: /Hinge1 reached its limit at 0\.5\d* s/ })).toBeVisible();
  await pm.getByRole('button', { name: 'Cancel' }).click();
  expect(errors).toEqual([]);
});

test('limit, width, slot, screw and rack and pinion mates through the Mate panel; a study stops at a limit', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await openApp(page);
  await newAssemblyWith(page, [['Plate', PLATE], ['Bar', BAR], ['Small', disc(10)]], ['Plate', 'Bar', 'Small']);
  await built(page, ['Plate<1>', 'Bar<1>', 'Small<1>']);
  const tree = page.getByRole('tree', { name: 'Assembly design tree' });
  const pm = page.locator('.pm');
  const suppress = async (name: RegExp) => {
    await tree.getByRole('treeitem', { name }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Suppress' }).click();
    await expect(tree.getByRole('treeitem', { name })).toHaveAttribute('aria-description', /Suppressed/);
  };
  const noError = async (name: RegExp) => {
    await expect(tree.getByRole('treeitem', { name })).toBeVisible();
    await expect(tree.getByRole('treeitem', { name })).not.toHaveAttribute('aria-description', /Error/);
  };

  // Width: the bar centred between the plate's two ends.
  await page.locator('.cm [data-cmd="mate"]').click();
  await pm.getByRole('combobox', { name: 'Mate type' }).selectOption('width');
  await pick(page, { comp: 'Plate<1>', face: 'E1:side:rl1' });
  await pick(page, { comp: 'Plate<1>', face: 'E1:side:rl3' });
  await expect(pm.getByRole('group', { name: 'Tab selections' })).toHaveClass(/active/);
  await pick(page, { comp: 'Bar<1>', face: 'E1:side:rl1' });
  await pick(page, { comp: 'Bar<1>', face: 'E1:side:rl3' });
  await expect(pm.getByRole('status').filter({ hasText: 'The mate holds' })).toBeVisible();
  await pm.getByRole('button', { name: 'OK' }).click();
  await noError(/^Width1/);
  const barX = () => page.evaluate(() => {
    const m = (window as unknown as { __parametric: A }).__parametric.assembly!;
    return m.solved.get(m.doc.components.find((c) => c.name === 'Bar<1>')!.id)!.p[0];
  });
  // The bar is as long as the plate: centred, it lines up with it.
  expect(await barX()).toBeCloseTo(0, 4);
  await suppress(/^Width1/);

  // A limit distance: the bar kept 5 to 15 mm in front of the plate.
  await select(page, [{ comp: 'Plate<1>', face: 'E1:cap1' }, { comp: 'Bar<1>', face: 'E1:cap0' }]);
  await openMate(page, 'distance');
  await pm.getByRole('checkbox', { name: /Limit the distance/ }).check();
  await pm.getByRole('textbox', { name: 'Maximum' }).fill('15');
  await pm.getByRole('textbox', { name: 'Maximum' }).press('Enter');
  await pm.getByRole('textbox', { name: 'Minimum' }).fill('5');
  await pm.getByRole('textbox', { name: 'Minimum' }).press('Enter');
  await expect(pm.getByRole('status').filter({ hasText: 'The mate holds. 10 degrees of freedom' })).toBeVisible();
  await pm.getByRole('button', { name: 'OK' }).click();
  await noError(/^LimitDistance1/);
  const gapZ = () => page.evaluate(() => {
    const m = (window as unknown as { __parametric: A }).__parametric.assembly!;
    // The bar starts behind the plate's front face: the distance is on that side.
    return Math.abs(m.solved.get(m.doc.components.find((c) => c.name === 'Bar<1>')!.id)!.p[2] - 10);
  });
  const gap = await gapZ();
  expect(gap).toBeGreaterThan(5 - 1e-4);
  expect(gap).toBeLessThan(15 + 1e-4);
  // A linear motor pushing the bar away: the study stops at the limit.
  await page.locator('.cm [data-cmd="motionStudy"]').click();
  await pm.getByRole('button', { name: 'Add Motor' }).click();
  await pm.getByRole('group', { name: 'Motor type' }).getByRole('button', { name: 'Linear' }).click();
  await pm.getByRole('group', { name: 'Motor direction' }).click();
  await pick(page, { comp: 'Bar<1>', face: 'E1:cap1' });
  await pm.getByRole('textbox', { name: 'Speed' }).fill('10');
  await pm.getByRole('textbox', { name: 'Speed' }).press('Enter');
  await pm.getByRole('button', { name: 'Add', exact: true }).click();
  await pm.getByRole('button', { name: 'Calculate' }).click();
  await expect(pm.getByRole('alert').filter({ hasText: 'LimitDistance1 reached its limit' })).toBeVisible();
  // The bar moves through the plate (where the width mate left it): interference over the motion lists the frames.
  await pm.getByRole('button', { name: 'Check Interference' }).click();
  await expect(pm.getByRole('status').filter({ hasText: /Components overlap in \d+ of the frames checked/ })).toBeVisible({ timeout: 60_000 });
  const clashes = pm.getByRole('list', { name: 'Interference over the motion' }).getByRole('listitem');
  await expect(clashes.first()).toContainText(/Plate<1> and Bar<1>|Bar<1> and Plate<1>/);
  await clashes.last().getByRole('button').click();
  await expect(pm.locator('.kin-clock')).toContainText(/^0\.\d\d s \//);
  await pm.getByRole('button', { name: 'Cancel' }).click();
  await suppress(/^LimitDistance1/);

  // Slot: the small disc's round face between the plate's two holes (the slot's ends).
  await page.locator('.cm [data-cmd="mate"]').click();
  await pm.getByRole('combobox', { name: 'Mate type' }).selectOption('slot');
  await pick(page, { comp: 'Plate<1>', face: 'E1:side:h1' });
  await pick(page, { comp: 'Plate<1>', face: 'E1:side:h2' });
  await pick(page, { comp: 'Small<1>', face: 'E1:side:k' });
  await expect(pm.getByRole('status').filter({ hasText: 'The mate holds. 9 degrees of freedom' })).toBeVisible();
  await pm.getByRole('button', { name: 'OK' }).click();
  await noError(/^Slot1/);
  await suppress(/^Slot1/);

  // Screw: the disc in the first hole, 2 mm a turn, left-hand.
  await select(page, [{ comp: 'Plate<1>', face: 'E1:side:h1' }, { comp: 'Small<1>', face: 'E1:side:k' }]);
  await openMate(page, 'screw');
  await pm.getByRole('textbox', { name: 'Pitch (travel per turn)' }).fill('2');
  await pm.getByRole('textbox', { name: 'Pitch (travel per turn)' }).press('Enter');
  await pm.getByRole('group', { name: 'Thread' }).getByRole('button', { name: 'Left-hand' }).click();
  await expect(pm.getByRole('status').filter({ hasText: 'The mate holds' })).toBeVisible();
  await pm.getByRole('button', { name: 'OK' }).click();
  await noError(/^Screw1/);
  expect(await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.assembly!.doc.mates.find((m) => m.name === 'Screw1'))).toMatchObject({ type: 'screw', value: 2, reverse: true });
  await suppress(/^Screw1/);

  // Rack and pinion: the bar's straight edge and the disc's round face (picked the other way round).
  await select(page, [{ comp: 'Bar<1>', edge: 'x' }, { comp: 'Small<1>', face: 'E1:side:k' }]);
  await openMate(page, 'rackPinion');
  await expect(pm.getByRole('textbox', { name: 'Pinion pitch diameter' })).toHaveValue('20');
  await pm.getByRole('group', { name: 'Rack travel from' }).getByRole('button', { name: 'Travel per turn' }).click();
  await expect(pm.getByRole('textbox', { name: 'Rack travel per turn of the pinion' })).toHaveValue('62.832');
  await pm.getByRole('button', { name: 'OK' }).click();
  await noError(/^Rack Pinion1/);
  const rp = () => page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.assembly!.doc.mates.find((m) => m.name === 'Rack Pinion1')!);
  // The pinion first, whichever was picked first.
  expect((await rp()).a).toMatchObject({ face: { name: 'E1:side:k' } });
  expect(await rp()).toMatchObject({ by: 'revolution', value: 62.832 });
  await tree.getByRole('treeitem', { name: /^Rack Pinion1/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reverse Direction' }).click();
  expect((await rp()).reverse).toBe(true);

  // Edited from the tree: the panel shows what it has.
  await tree.getByRole('treeitem', { name: /^Rack Pinion1/ }).dblclick();
  await expect(pm.getByRole('combobox', { name: 'Mate type' })).toHaveValue('rackPinion');
  await expect(pm.getByRole('checkbox', { name: 'Reverse the direction' })).toBeChecked();
  await pm.getByRole('button', { name: 'Cancel' }).click();
  expect(errors).toEqual([]);
});

test('slider, cam follower and universal joint through the Mate panel; motors on a slider and a hinge', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await openApp(page);
  await newAssemblyWith(page, [['Plate', PLATE], ['Bar', BAR], ['Cam', CAM], ['Shaft', SHAFT]], ['Plate', 'Bar', 'Cam', 'Shaft', 'Shaft']);
  await built(page, ['Plate<1>', 'Bar<1>', 'Cam<1>', 'Shaft<1>', 'Shaft<2>']);
  const tree = page.getByRole('tree', { name: 'Assembly design tree' });
  const pm = page.locator('.pm');
  await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.selection.clear());

  // Slider: the bar flush on the plate's front and right faces, sliding along y, at most 25 mm either way.
  await page.locator('.cm [data-cmd="mate"]').click();
  await pm.getByRole('combobox', { name: 'Mate type' }).selectOption('slider');
  await pick(page, { comp: 'Plate<1>', face: 'E1:cap1' });
  await pick(page, { comp: 'Plate<1>', face: 'E1:side:rl1' });
  await expect(pm.getByRole('group', { name: 'Second component' })).toHaveClass(/active/);
  await pick(page, { comp: 'Bar<1>', face: 'E1:cap0' });
  await pick(page, { comp: 'Bar<1>', face: 'E1:side:rl1' });
  await pm.getByRole('checkbox', { name: /Limit the travel/ }).check();
  await expect(pm.getByRole('textbox', { name: 'Maximum' })).toHaveValue('25');
  await expect(pm.getByRole('status').filter({ hasText: 'The mate holds' })).toBeVisible();
  await pm.getByRole('button', { name: 'OK' }).click();
  await expect(tree.getByRole('treeitem', { name: /^Slider1/ })).toBeVisible();
  const bar = () => page.evaluate(() => {
    const m = (window as unknown as { __parametric: A }).__parametric.assembly!;
    return m.solved.get(m.doc.components.find((c) => c.name === 'Bar<1>')!.id)!.p;
  });
  expect((await bar())[0]).toBeCloseTo(0, 4);
  expect((await bar())[2]).toBeCloseTo(10, 4);
  // A linear motor on the slider at 10 mm/s: it stops at the limit after 2.5 s.
  await page.locator('.cm [data-cmd="motionStudy"]').click();
  await pm.getByRole('button', { name: 'Add Motor' }).click();
  await pm.getByRole('group', { name: 'Motor type' }).getByRole('button', { name: 'Linear' }).click();
  await pm.getByRole('combobox', { name: 'Motor on' }).selectOption({ label: 'Slider1 (Slider)' });
  await pm.getByRole('textbox', { name: 'Speed' }).fill('10');
  await pm.getByRole('textbox', { name: 'Speed' }).press('Enter');
  await pm.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(pm.getByRole('listitem').filter({ hasText: 'LinearMotor1' })).toContainText('Slider1: 10 mm/s');
  await pm.getByRole('button', { name: 'Calculate' }).click();
  await expect(pm.getByRole('alert').filter({ hasText: /Slider1 reached its limit at 2\.5\d* s/ })).toBeVisible();
  await pm.getByRole('button', { name: 'Cancel' }).click();
  // Without the limit, for the cam to push it.
  await tree.getByRole('treeitem', { name: /^Slider1/ }).dblclick();
  await pm.getByRole('checkbox', { name: /Limit the travel/ }).uncheck();
  await pm.getByRole('button', { name: 'OK' }).click();
  expect(await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.assembly!.doc.mates.find((m) => m.name === 'Slider1')!.limit)).toBeUndefined();

  // The cam on a hinge in the plate's first hole.
  await select(page, [{ comp: 'Cam<1>', face: 'E1:side:hb' }, { comp: 'Plate<1>', face: 'E1:side:h1' }]);
  await openMate(page, 'hinge');
  await pm.getByRole('group', { name: 'Coincident selections' }).click();
  await pick(page, { comp: 'Plate<1>', face: 'E1:cap1' });
  await pick(page, { comp: 'Cam<1>', face: 'E1:cap0' });
  await pm.getByRole('button', { name: 'OK' }).click();
  await expect(tree.getByRole('treeitem', { name: /^Hinge1/ })).toBeVisible();

  // Cam: the eccentric's round face, the bar's bottom face as a flat follower.
  await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.selection.clear());
  await openMate(page, 'cam');
  await pick(page, { comp: 'Cam<1>', face: 'E1:side:k' });
  await pm.getByRole('group', { name: 'Follower' }).click();
  await pick(page, { comp: 'Bar<1>', face: 'E1:side:rl0' });
  await expect(pm.getByRole('status').filter({ hasText: 'The mate holds' })).toBeVisible();
  await pm.getByRole('button', { name: 'OK' }).click();
  await expect(tree.getByRole('treeitem', { name: /^Cam1/ })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: /^Cam1/ })).not.toHaveAttribute('aria-description', /Error/);

  // A rotary motor on the hinge turns the cam a full turn: the bar's bottom stays on the eccentric's top.
  await page.locator('.cm [data-cmd="motionStudy"]').click();
  await pm.getByRole('button', { name: 'Add Motor' }).click();
  await pm.getByRole('combobox', { name: 'Motor on' }).selectOption({ label: 'Hinge1 (Hinge)' });
  await pm.getByRole('textbox', { name: 'Speed' }).fill('90');
  await pm.getByRole('textbox', { name: 'Speed' }).press('Enter');
  await pm.getByRole('button', { name: 'Add', exact: true }).click();
  await pm.getByRole('spinbutton', { name: 'Duration (s)' }).fill('4');
  await pm.getByRole('spinbutton', { name: 'Duration (s)' }).press('Enter');
  await pm.getByRole('button', { name: 'Calculate' }).click();
  await expect(pm.getByRole('status').filter({ hasText: 'Calculated 121 frames' })).toBeVisible();
  const follow = await page.evaluate(() => {
    const a = (window as unknown as { __parametric: A }).__parametric;
    const m = a.assembly!;
    const res = (a.panel as unknown as { result(): { frames: Map<string, { p: number[]; q: number[] }>[] } }).result();
    const id = (n: string) => m.doc.components.find((c) => c.name === n)!.id;
    const rot = (q: number[], v: number[]) => {
      const [x, y, z, w] = q;
      const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
      return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]];
    };
    let worst = 0, lo = Infinity, hi = -Infinity;
    for (const f of res.frames) {
      const cam = f.get(id('Cam<1>'))!, b = f.get(id('Bar<1>'))!;
      // The eccentric's top: its centre (5 off the bore, in the cam) plus its radius.
      const top = rot(cam.q, [5, 0, 0])[1] + cam.p[1] + 20;
      worst = Math.max(worst, Math.abs(b.p[1] - top));
      lo = Math.min(lo, b.p[1]); hi = Math.max(hi, b.p[1]);
    }
    return { worst, lift: hi - lo };
  });
  expect(follow.worst).toBeLessThan(1e-6);
  // The follower rises and falls by twice the eccentricity.
  expect(follow.lift).toBeCloseTo(10, 3);
  await pm.getByRole('button', { name: 'Cancel' }).click();

  // Universal joint between the two shafts, with a joint point.
  await select(page, [{ comp: 'Shaft<1>', face: 'E1:side:k' }, { comp: 'Shaft<2>', face: 'E1:side:k' }]);
  await openMate(page, 'universal');
  await expect(pm.getByRole('group', { name: 'Shafts' })).toContainText('Shaft<2>');
  await pm.getByRole('checkbox', { name: /Joint point/ }).check();
  await pm.getByRole('textbox', { name: 'Joint point offset (along the first shaft)' }).fill('15');
  await pm.getByRole('textbox', { name: 'Joint point offset (along the first shaft)' }).press('Enter');
  await expect(pm.getByRole('status').filter({ hasText: 'The mate holds' })).toBeVisible();
  await pm.getByRole('button', { name: 'OK' }).click();
  await expect(tree.getByRole('treeitem', { name: /^Universal Joint1/ })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.assembly!.doc.mates.find((m) => m.name === 'Universal Joint1'))).toMatchObject({ type: 'universal', by: 'point', value: 15, rel: { q: expect.any(Array) } });

  // Flip and suppress from the Mates folder; undo; the edits survive saving and opening again.
  await tree.getByRole('treeitem', { name: /^Cam1/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Flip Follower Face' }).click();
  expect(await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.assembly!.doc.mates.find((m) => m.name === 'Cam1')!.flip)).toBe(true);
  await page.keyboard.press('Meta+z');
  expect(await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.assembly!.doc.mates.find((m) => m.name === 'Cam1')!.flip)).toBeUndefined();
  await tree.getByRole('treeitem', { name: /^Universal Joint1/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Suppress' }).click();
  await expect(tree.getByRole('treeitem', { name: /^Universal Joint1/ })).toHaveAttribute('aria-description', /Suppressed/);
  await page.keyboard.press('Meta+s');
  await expect(page).toHaveTitle(/^Assembly\d+ - Parametric$/);
  const name = (await page.title()).replace(' - Parametric', '');
  await page.evaluate(() => { void (window as unknown as { __parametric: A }).__parametric.commands.run('new'); });
  await expect(page).toHaveTitle(/^Part\d+ - Parametric$/);
  void page.evaluate(() => { (window as unknown as { __parametric: A }).__parametric.commands.run('open'); });
  await page.getByRole('dialog', { name: 'Open' }).getByRole('button', { name: new RegExp(`^${name} This browser`) }).click();
  await expect(page).toHaveTitle(`${name} - Parametric`);
  for (const n of [/^Slider1/, /^Hinge1/, /^Cam1/]) await expect(tree.getByRole('treeitem', { name: n })).not.toHaveAttribute('aria-description', /Error|Suppressed/);
  await expect(tree.getByRole('treeitem', { name: /^Universal Joint1/ })).toHaveAttribute('aria-description', /Suppressed/);
  // Edited from the tree, the cam shows its faces and follower.
  await tree.getByRole('treeitem', { name: /^Cam1/ }).dblclick();
  await expect(pm.getByRole('group', { name: 'Cam faces' })).toContainText('Face (cylinder) of Cam<1>');
  await expect(pm.getByRole('group', { name: 'Follower' })).toContainText('Face (plane) of Bar<1>');
  expect(await axeViolations(page)).toEqual([]);
  await pm.getByRole('button', { name: 'Cancel' }).click();
  expect(errors).toEqual([]);
});
