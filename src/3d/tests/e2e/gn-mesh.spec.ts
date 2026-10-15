// Geometry nodes: zones (Repeat, Simulation, For Each Element) and the Bake node in the Geometry
// Node Editor, mesh/sampling nodes in the Add menu, and simulation baking from the modifier panel.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

async function geometryEditor(page: Page) {
  const errors = await openApp(page);
  await page.locator('.ws-tab', { hasText: 'Geometry Nodes' }).first().click();
  await page.waitForTimeout(500);
  await page.evaluate(() => (window as unknown as { app: { run(id: string): void } }).app.run('node.new_geometry_nodes_modifier'));
  await page.waitForTimeout(300);
  const box = (await page.locator('.nd-editor').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return { errors, box };
}

function withTree<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(`(() => { const ed = app.hoverArea.editor; const tree = ed.tree(); return (${fn})(ed, tree); })()`) as Promise<T>;
}

const menuItem = (page: Page, label: string) => page.locator('.menu .menu-item', { hasText: new RegExp(`^${label}$`) }).first();

test('adding a repeat zone adds both nodes, linked, inside a zone frame', async ({ page }) => {
  const { errors, box } = await geometryEditor(page);
  await page.keyboard.press('Shift+A');
  await menuItem(page, 'Utilities').hover();
  await menuItem(page, 'Repeat').click();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20, { steps: 4 });
  await page.mouse.click(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20);
  const r = await withTree<{ ins: number; outs: number; paired: boolean; linked: boolean }>(
    page,
    `(ed, t) => {
      const i = t.nodes.find((n) => n.type === 'GeometryNodeRepeatInput');
      const o = t.nodes.find((n) => n.type === 'GeometryNodeRepeatOutput');
      return { ins: t.nodes.filter((n) => n.type === 'GeometryNodeRepeatInput').length, outs: t.nodes.filter((n) => n.type === 'GeometryNodeRepeatOutput').length,
        paired: !!i && !!o && i.props.paired_output === o.id, linked: !!i && !!o && t.links.some((l) => l.from_node === i.id && l.to_node === o.id) };
    }`,
  );
  expect(r).toEqual({ ins: 1, outs: 1, paired: true, linked: true });
  await page.screenshot({ path: 'test-results/gn-zone.png' });
  await expectNoErrors(errors);
});

test('simulation zone: frames step, the modifier panel bakes and deletes the bake', async ({ page }) => {
  const { errors } = await geometryEditor(page);
  // simulation zone moving the geometry up by one unit per frame
  await page.evaluate(async () => {
    const { addNode, connect, ctxOf } = await import('/src/nodes/tree.ts');
    const { getNodeType } = await import('/src/nodes/registry.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const tree = a.hoverArea.editor.tree();
    const ctx = ctxOf(a.doc, tree);
    const gin = tree.nodes.find((n: { type: string }) => n.type === 'NodeGroupInput');
    const gout = tree.nodes.find((n: { type: string }) => n.type === 'NodeGroupOutput');
    tree.links = [];
    const si = addNode(tree, 'GeometryNodeSimulationInput', [-200, 0]);
    const so = getNodeType('GeometryNodeSimulationInput').onAdd(tree, si)[0];
    tree.links = tree.links.filter((l: { from_node: string }) => l.from_node !== si.id);
    const sp = addNode(tree, 'GeometryNodeSetPosition', [0, 0]);
    sp.inputs.Offset = [0, 0, 1];
    connect(ctx, gin.id, gin && tree.interface.find((i: { in_out: string }) => i.in_out === 'INPUT').identifier, si.id, 'Item_0');
    connect(ctx, si.id, 'Item_0', sp.id, 'Geometry');
    connect(ctx, sp.id, 'Geometry', so.id, 'Item_0');
    connect(ctx, so.id, 'Item_0', gout.id, tree.interface.find((i: { in_out: string }) => i.in_out === 'OUTPUT').identifier);
    a.changed('doc');
  });
  const zAt = (f: number) =>
    page.evaluate((f) => {
      const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
      a.setFrame(f);
      a.graph.evaluate(a.doc);
      const m = a.graph.get(a.activeObject.id).mesh;
      return Math.max(...Array.from(m.positions as Float32Array).filter((_, i) => i % 3 === 2));
    }, f);
  expect(await zAt(1)).toBeCloseTo(2);
  expect(await zAt(2)).toBeCloseTo(3);
  expect(await zAt(3)).toBeCloseTo(4);
  // bake from the modifier panel
  await page.locator('.rail-tab[data-tab="MODIFIER"]').first().click();
  await page.waitForTimeout(200);
  await page
    .locator('.panel', { hasText: 'Bake' })
    .locator('button', { hasText: /^Bake$/ })
    .first()
    .click();
  await expect(page.locator('.gn-bake-status').first()).toContainText('Baked frames 1');
  expect(await zAt(10)).toBeCloseTo(11);
  await page
    .locator('button', { hasText: /^Delete Bake$/ })
    .first()
    .click();
  await expect(page.locator('.gn-bake-status').first()).not.toContainText('Baked');
  await expectNoErrors(errors);
});

test('zone items: links to the extend socket become items; the sidebar list adds and removes them', async ({ page }) => {
  const { errors, box } = await geometryEditor(page);
  const ids = await page.evaluate(async () => {
    const { addNode, connect, ctxOf } = await import('/src/nodes/tree.ts');
    const { getNodeType } = await import('/src/nodes/registry.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const tree = a.hoverArea.editor.tree();
    const i = addNode(tree, 'GeometryNodeRepeatInput', [-200, 200]);
    const o = getNodeType('GeometryNodeRepeatInput').onAdd(tree, i)[0];
    const v = addNode(tree, 'ShaderNodeValue', [-450, 100]);
    connect(ctxOf(a.doc, tree), v.id, 'Value', i.id, '__extend__');
    for (const n of tree.nodes) n.select = false;
    o.select = true;
    tree.active_node = o.id;
    a.changed('doc');
    return { i: i.id, o: o.id, v: v.id };
  });
  await page.waitForTimeout(100);
  const items = () => withTree<string[]>(page, `(ed, t) => JSON.parse(t.nodes.find((n) => n.id === '${ids.o}').props.repeat_items).map((x) => x.name + ':' + x.socket_type)`);
  expect(await items()).toEqual(['Geometry:GEOMETRY', 'Value:FLOAT']);
  expect(await withTree(page, `(ed, t) => t.links.some((l) => l.from_node === '${ids.v}' && l.to_node === '${ids.i}' && l.to_socket.startsWith('Item_'))`)).toBe(true);
  // sidebar ▸ Node tab: the item list of the zone
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('n');
  await page.locator('.nd-side-tab', { hasText: 'Node' }).first().click();
  const list = page.locator('.gn-zone-items').first();
  await expect(list).toContainText('Repeat Items');
  await list.locator('button[data-tip="Add"]').click();
  expect(await items()).toEqual(['Geometry:GEOMETRY', 'Value:FLOAT', 'Float:FLOAT']);
  await list.locator('button[data-tip="Remove"]').click();
  expect(await items()).toEqual(['Geometry:GEOMETRY', 'Value:FLOAT']);
  // the item operators work on the active zone node too
  await page.evaluate(() => (window as unknown as { app: { run(id: string, p: object): void } }).app.run('node.repeat_zone_item_add', { socket_type: 'VECTOR' }));
  expect(await items()).toEqual(['Geometry:GEOMETRY', 'Value:FLOAT', 'Vector:VECTOR']);
  await expectNoErrors(errors);
});

test('mesh operation, sampling and instance nodes are in the Add menu', async ({ page }) => {
  const { errors } = await geometryEditor(page);
  const open = async (...path: string[]) => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+A');
    for (const p of path) await menuItem(page, p).hover();
  };
  await open('Mesh', 'Operations');
  for (const l of ['Dual Mesh', 'Edge Paths to Curves', 'Mesh Bevel', 'Mesh Boolean', 'Scale Elements', 'Split Edges']) await expect(menuItem(page, l)).toBeVisible();
  await open('Mesh', 'UV');
  for (const l of ['Pack UV Islands', 'UV Unwrap']) await expect(menuItem(page, l)).toBeVisible();
  await open('Geometry', 'Sample');
  for (const l of ['Geometry Proximity', 'Index of Nearest', 'Raycast', 'Sample Nearest']) await expect(menuItem(page, l)).toBeVisible();
  await open('Geometry', 'Operations');
  for (const l of ['Bake', 'Duplicate Elements', 'Merge Points', 'Sort Elements', 'Split to Instances']) await expect(menuItem(page, l)).toBeVisible();
  await open('Simulation');
  await page
    .locator('.menu')
    .last()
    .locator('.menu-item', { hasText: /^Simulation$/ })
    .click();
  await page.mouse.move(420, 610, { steps: 3 });
  await page.mouse.click(420, 610);
  expect(await withTree(page, `(ed, t) => t.nodes.filter((n) => n.type.startsWith('GeometryNodeSimulation')).length`)).toBe(2);
  await expectNoErrors(errors);
});

test('duplicating a zone pairs the copies with each other', async ({ page }) => {
  const { errors } = await geometryEditor(page);
  await page.evaluate(async () => {
    const { addNode, connect, ctxOf } = await import('/src/nodes/tree.ts');
    const { getNodeType } = await import('/src/nodes/registry.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const tree = a.hoverArea.editor.tree();
    for (const n of tree.nodes) n.select = false;
    const i = addNode(tree, 'GeometryNodeRepeatInput', [-200, 300]);
    const o = getNodeType('GeometryNodeRepeatInput').onAdd(tree, i)[0];
    tree.links = tree.links.filter((l: { from_node: string }) => l.from_node !== i.id);
    const sp = addNode(tree, 'GeometryNodeSetPosition', [0, 300]);
    connect(ctxOf(a.doc, tree), i.id, 'Item_0', sp.id, 'Geometry');
    connect(ctxOf(a.doc, tree), sp.id, 'Geometry', o.id, 'Item_0');
    i.select = o.select = sp.select = true;
    a.changed('doc');
  });
  await page.keyboard.press('Shift+D');
  await page.mouse.move(700, 700, { steps: 4 });
  await page.mouse.click(700, 700);
  await page.waitForTimeout(100);
  const pairs = await withTree<string[][]>(
    page,
    `(ed, t) => t.nodes.filter((n) => n.type === 'GeometryNodeRepeatInput').map((i) => [i.id, i.props.paired_output, t.links.some((l) => l.from_node === i.id) ? 'linked' : ''])`,
  );
  expect(pairs.length).toBe(2);
  expect(new Set(pairs.map((p) => p[1])).size).toBe(2);
  // each input reaches its own output through its copy of the body
  const ok = await withTree<boolean>(
    page,
    `(ed, t) => t.nodes.filter((n) => n.type === 'GeometryNodeRepeatInput').every((i) => {
      const body = t.links.filter((l) => l.from_node === i.id).map((l) => l.to_node);
      return body.some((b) => t.links.some((l) => l.from_node === b && l.to_node === i.props.paired_output));
    })`,
  );
  expect(ok).toBe(true);
  await expectNoErrors(errors);
});

test('swap (Shift S) wraps the selection in a zone, then turns it into another kind of zone', async ({ page }) => {
  const { errors, box } = await geometryEditor(page);
  const sp = await page.evaluate(async () => {
    const { addNode, connect, ctxOf } = await import('/src/nodes/tree.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const tree = a.hoverArea.editor.tree();
    const gin = tree.nodes.find((n: { type: string }) => n.type === 'NodeGroupInput');
    const gout = tree.nodes.find((n: { type: string }) => n.type === 'NodeGroupOutput');
    tree.links = [];
    const sp = addNode(tree, 'GeometryNodeSetPosition', [0, 0]);
    const ctx = ctxOf(a.doc, tree);
    connect(ctx, gin.id, tree.interface.find((i: { in_out: string }) => i.in_out === 'INPUT').identifier, sp.id, 'Geometry');
    connect(ctx, sp.id, 'Geometry', gout.id, tree.interface.find((i: { in_out: string }) => i.in_out === 'OUTPUT').identifier);
    for (const n of tree.nodes) n.select = n === sp;
    tree.active_node = sp.id;
    a.changed('doc');
    return sp.id;
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Shift+S');
  await menuItem(page, 'Utilities').hover();
  await menuItem(page, 'Repeat').click();
  const chain = () =>
    withTree<string[]>(
      page,
      `(ed, t) => { const out = []; let id = t.nodes.find((n) => n.type === 'NodeGroupInput').id;
        for (let k = 0; k < 6; k++) { const l = t.links.find((x) => x.from_node === id); if (!l) break; id = l.to_node; out.push(t.nodes.find((n) => n.id === id).type); }
        return out; }`,
    );
  expect(await chain()).toEqual(['GeometryNodeRepeatInput', 'GeometryNodeSetPosition', 'GeometryNodeRepeatOutput', 'NodeGroupOutput']);
  // swapping the selected zone to a simulation keeps the links
  await page.evaluate((id) => {
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const t = a.hoverArea.editor.tree();
    for (const n of t.nodes) n.select = n.type === 'GeometryNodeRepeatInput';
    void id;
    a.run('node.swap_node', { type: 'GeometryNodeSimulationInput', settings: '{}' }, { area: a.hoverArea });
  }, sp);
  expect(await chain()).toEqual(['GeometryNodeSimulationInput', 'GeometryNodeSetPosition', 'GeometryNodeSimulationOutput', 'NodeGroupOutput']);
  expect(
    await withTree(page, `(ed, t) => t.nodes.find((n) => n.type === 'GeometryNodeSimulationInput').props.paired_output === t.nodes.find((n) => n.type === 'GeometryNodeSimulationOutput').id`),
  ).toBe(true);
  await expectNoErrors(errors);
});
