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
