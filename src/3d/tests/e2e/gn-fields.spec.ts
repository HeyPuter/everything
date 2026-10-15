// Geometry nodes: function, field, text, topology and input nodes in the Geometry Node Editor
// (Add menu placement, drawing, sidebar item lists) and menu inputs in the modifier panel.
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

test('the Add menu lists the new nodes in their categories', async ({ page }) => {
  const { errors } = await geometryEditor(page);
  await page.keyboard.press('Shift+A');
  await menuItem(page, 'Utilities').hover();
  await menuItem(page, 'Math').hover();
  for (const l of ['Bit Math', 'Integer Math', 'Float to Integer', 'Hash Value']) await expect(menuItem(page, l)).toBeVisible();
  await menuItem(page, 'Integer Math').click();
  await page.mouse.click(700, 500);
  expect(await withTree(page, '(ed, t) => t.nodes.some((n) => n.type === "FunctionNodeIntegerMath")')).toBe(true);
  // nested categories: Mesh ▸ Topology, Utilities ▸ Matrix
  await page.keyboard.press('Shift+A');
  await menuItem(page, 'Mesh').hover();
  await menuItem(page, 'Topology').hover();
  await expect(menuItem(page, 'Offset Corner in Face')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('every new node type draws and evaluates without errors', async ({ page }) => {
  const { errors } = await geometryEditor(page);
  const count = await page.evaluate(async () => {
    const { addNode } = await import('/src/nodes/tree.ts');
    const { GN_FIELD_NODE_DATA } = await import('/src/geonodes/data-fields.gen.ts');
    const { getNodeType } = await import('/src/nodes/registry.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const tree = a.hoverArea.editor.tree();
    const types = Object.keys(GN_FIELD_NODE_DATA).filter((t) => getNodeType(t));
    types.forEach((t, i) => addNode(tree, t, [(i % 10) * 220 - 1200, Math.floor(i / 10) * -260]));
    a.changed('doc');
    return types.length;
  });
  expect(count).toBeGreaterThan(80);
  await page.keyboard.press('Home');
  await page.waitForTimeout(400);
  expect(await page.locator('.nd-editor [data-node]').count()).toBeGreaterThan(count);
  await expectNoErrors(errors);
});

test('Format String items are added in the sidebar', async ({ page }) => {
  const { errors } = await geometryEditor(page);
  const fid = await page.evaluate(async () => {
    const { addNode } = await import('/src/nodes/tree.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const tree = a.hoverArea.editor.tree();
    const n = addNode(tree, 'FunctionNodeFormatString', [0, 300]);
    for (const x of tree.nodes) x.select = x === n;
    tree.active_node = n.id;
    a.changed('doc');
    return n.id;
  });
  await page.keyboard.press('n');
  await page.waitForTimeout(200);
  const tab = page.locator('.nd-sidebar .rail-tab, .nd-side-tabs button', { hasText: 'Node' }).first();
  if (await tab.count()) await tab.click();
  await page.locator('.gn-items button', { hasText: 'Add Item' }).first().click();
  await page.locator('.gn-items button', { hasText: 'Add Item' }).first().click();
  const items = await withTree<{ name: string }[]>(page, `(ed, t) => JSON.parse(t.nodes.find((n) => n.id === "${fid}").props.format_items)`);
  expect(items.map((i) => i.name)).toEqual(['Value', 'Value_2']);
  await expect(page.locator(`[data-node="${fid}"]`)).toContainText('Value_2');
  await expectNoErrors(errors);
});

test('a group menu input feeding a Menu Switch is a dropdown in the modifier panel', async ({ page }) => {
  const { errors } = await geometryEditor(page);
  await page.evaluate(async () => {
    const { addNode, connect, ctxOf } = await import('/src/nodes/tree.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const tree = a.hoverArea.editor.tree();
    const ctx = ctxOf(a.doc, tree);
    const gi = tree.nodes.find((n: { type: string }) => n.type === 'NodeGroupInput');
    const go = tree.nodes.find((n: { type: string }) => n.type === 'NodeGroupOutput');
    const ms = addNode(tree, 'GeometryNodeMenuSwitch', [0, 0], {
      enum_items: JSON.stringify([
        { id: 0, name: 'Cube' },
        { id: 1, name: 'Line' },
      ]),
    });
    const cube = addNode(tree, 'GeometryNodeMeshCube', [-300, 0]);
    const line = addNode(tree, 'GeometryNodeMeshLine', [-300, -200]);
    connect(ctx, gi.id, '__extend__', ms.id, 'Menu');
    connect(ctx, cube.id, 'Mesh', ms.id, 'Item_0');
    connect(ctx, line.id, 'Mesh', ms.id, 'Item_1');
    tree.links = tree.links.filter((l: { to_node: string }) => l.to_node !== go.id);
    connect(ctx, ms.id, 'Output', go.id, tree.interface.find((i: { in_out: string; socket_type: string }) => i.in_out === 'OUTPUT' && i.socket_type === 'NodeSocketGeometry').identifier);
    a.changed('doc');
  });
  await page.waitForTimeout(300);
  const verts = () => page.evaluate(() => (window as unknown as { app: any }).app.graph.get((window as unknown as { app: any }).app.activeObject.id).mesh.positions.length / 3); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(await verts()).toBe(8);
  await page.locator('.rail-tab[data-tab="MODIFIER"]').first().click();
  await page.waitForTimeout(200);
  const dd = page.locator('.gn-mod .enum-menu', { hasText: 'Cube' }).first();
  await expect(dd).toBeVisible();
  await dd.dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: 'Line' }).first().click();
  await page.waitForTimeout(300);
  expect(await verts()).toBe(10);
  await expectNoErrors(errors);
});
