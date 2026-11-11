// Geometry nodes: several Geometry Nodes modifiers on one object keep their own messages, and a
// viewer inside a node group opened in the editor is shown.
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

test('each Geometry Nodes modifier shows its own messages', async ({ page }) => {
  const { errors } = await geometryEditor(page);
  const ids = await page.evaluate(async () => {
    const { addNode, connect, ctxOf } = await import('/src/nodes/tree.ts');
    const { newNodeGroup, uid } = await import('/src/data/defaults.ts');
    const { newModifier } = await import('/src/eval/modifiers.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const ob = a.activeObject;
    // a warning in each modifier's tree, passed through to the output
    const warnIn = (tree: any, text: string) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const ctx = ctxOf(a.doc, tree);
      const go = tree.nodes.find((n: { type: string }) => n.type === 'NodeGroupOutput');
      const gi = tree.nodes.find((n: { type: string }) => n.type === 'NodeGroupInput');
      const w = addNode(tree, 'GeometryNodeWarning', [0, -300]);
      w.inputs.Message = text;
      const sw = addNode(tree, 'GeometryNodeSwitch', [200, -300], { input_type: 'GEOMETRY' });
      connect(ctx, w.id, 'Show', sw.id, 'Switch');
      connect(ctx, gi.id, tree.interface.find((i: { in_out: string }) => i.in_out === 'INPUT').identifier, sw.id, 'True');
      tree.links = tree.links.filter((l: { to_node: string }) => l.to_node !== go.id);
      connect(ctx, sw.id, 'Output', go.id, tree.interface.find((i: { in_out: string }) => i.in_out === 'OUTPUT').identifier);
      return w.id;
    };
    const m1 = ob.modifiers.find((m: { type: string }) => m.type === 'NODES');
    const first = warnIn(a.doc.node_groups[m1.node_group].tree, 'From the first');
    const g2 = newNodeGroup('Second');
    a.doc.node_groups[g2.id] = g2;
    const m2 = newModifier('NODES', uid('md'), ob.modifiers);
    m2.node_group = g2.id;
    ob.modifiers.push(m2);
    warnIn(g2.tree, 'From the second');
    a.changed('doc');
    return { first, m1: m1.id };
  });
  await page.waitForTimeout(500);
  await page.locator('.rail-tab[data-tab="MODIFIER"]').first().click();
  const panels = page.locator('.gn-mod');
  await expect(panels).toHaveCount(2);
  await expect(panels.nth(0).locator('.gn-warnings')).toHaveText(/From the first/);
  await expect(panels.nth(1).locator('.gn-warnings')).toHaveText(/From the second/);
  // the editor shows the first modifier's tree with its message on the node
  await page.evaluate(async (m1) => {
    const { setActiveModifier } = await import('/src/geonodes/editor.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    setActiveModifier(a.activeObject, a.activeObject.modifiers.find((m: { id: string }) => m.id === m1));
    a.changed('ui');
  }, ids.m1);
  await expect(page.locator(`[data-node="${ids.first}"] .nd-warn-icon`)).toHaveAttribute('data-tip', 'From the first');
  await expectNoErrors(errors);
});

test('a viewer inside a node group opened in the editor is shown', async ({ page }) => {
  const { errors } = await geometryEditor(page);
  const n = await page.evaluate(async () => {
    const { addNode, connect, ctxOf } = await import('/src/nodes/tree.ts');
    const { newNodeGroup } = await import('/src/data/defaults.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const ed = a.hoverArea.editor;
    const root = ed.tree();
    // group: input geometry passed through, with a viewer looking at a 4×4 grid
    const g = newNodeGroup('Inner');
    a.doc.node_groups[g.id] = g;
    const gctx = ctxOf(a.doc, g.tree);
    const grid = addNode(g.tree, 'GeometryNodeMeshGrid', [0, -200]);
    grid.inputs['Vertices X'] = 4;
    grid.inputs['Vertices Y'] = 4;
    const viewer = addNode(g.tree, 'GeometryNodeViewer', [300, -200]);
    connect(gctx, grid.id, 'Mesh', viewer.id, 'Geometry');
    const gnode = addNode(root, 'GeometryNodeGroup', [0, 0], { node_tree: g.id });
    const ctx = ctxOf(a.doc, root);
    const gi = root.nodes.find((x: { type: string }) => x.type === 'NodeGroupInput');
    const go = root.nodes.find((x: { type: string }) => x.type === 'NodeGroupOutput');
    root.links = [];
    const inId = g.tree.interface.find((i: { in_out: string }) => i.in_out === 'INPUT').identifier;
    const outId = g.tree.interface.find((i: { in_out: string }) => i.in_out === 'OUTPUT').identifier;
    connect(ctx, gi.id, root.interface.find((i: { in_out: string }) => i.in_out === 'INPUT').identifier, gnode.id, inId);
    connect(ctx, gnode.id, outId, go.id, root.interface.find((i: { in_out: string }) => i.in_out === 'OUTPUT').identifier);
    // open the group and activate its viewer
    ed.path = [{ group: g.id, node: gnode.id }];
    const { activateViewer } = await import('/src/geonodes/editor.ts');
    activateViewer(g.tree, viewer);
    a.changed('doc');
    return viewer.id;
  });
  await page.waitForTimeout(500);
  const shown = await page.evaluate(async () => {
    const { gnResults } = await import('/src/geonodes/results.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    return gnResults.get(a.activeObject.id)?.viewer?.mesh?.vertCount ?? null;
  });
  expect(shown).toBe(16);
  await expect(page.locator(`[data-node="${n}"] .gn-viewer-body`)).toHaveText(/Viewing/);
  await expectNoErrors(errors);
});

test('a field linked into a single-value input is flagged on the node and its link', async ({ page }) => {
  const { errors } = await geometryEditor(page);
  const ids = await page.evaluate(async () => {
    const { addNode, connect, ctxOf } = await import('/src/nodes/tree.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const tree = a.hoverArea.editor.tree();
    const ctx = ctxOf(a.doc, tree);
    const go = tree.nodes.find((n: { type: string }) => n.type === 'NodeGroupOutput');
    const grid = addNode(tree, 'GeometryNodeMeshGrid', [0, 0]);
    const index = addNode(tree, 'GeometryNodeInputIndex', [-250, 0]);
    const value = addNode(tree, 'FunctionNodeInputInt', [-250, -150], { integer: 4 });
    tree.links = tree.links.filter((l: { to_node: string }) => l.to_node !== go.id);
    connect(ctx, grid.id, 'Mesh', go.id, tree.interface.find((i: { in_out: string }) => i.in_out === 'OUTPUT').identifier);
    const bad = connect(ctx, index.id, 'Index', grid.id, 'Vertices X');
    const good = connect(ctx, value.id, 'Integer', grid.id, 'Vertices Y');
    a.changed('doc');
    return { grid: grid.id, bad: bad.id, good: good.id };
  });
  await page.waitForTimeout(400);
  await expect(page.locator(`[data-node="${ids.grid}"] .nd-warn-icon`)).toHaveAttribute('data-tip', /Input "Vertices X" does not support fields/);
  const flags = await page.evaluate(async (ids) => {
    const { providers } = await import('/src/nodes/editor/context.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const ed = a.hoverArea.editor;
    const link = (id: string) => ed.tree().links.find((l: { id: string }) => l.id === id);
    const p = providers.get('GEOMETRY')!;
    return [p.linkError!(ed, link(ids.bad)), p.linkError!(ed, link(ids.good))];
  }, ids);
  expect(flags).toEqual([true, false]);
  await expectNoErrors(errors);
});
