// Node editor item lists, bundles and closures, node editor interactions and Video Sequencer
// features: UI wiring (menus, sidebars, shortcuts, operators).
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/** Open a workspace and hover its node editor. */
async function nodeEditor(page: Page, workspace = 'Geometry Nodes') {
  const errors = await openApp(page);
  await page.locator('.ws-tab', { hasText: workspace }).first().click();
  await page.waitForTimeout(500);
  const box = (await page.locator('.nd-editor').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return { errors, box };
}

/** Run code with the hovered node editor and its tree. */
function withTree<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(`(() => { const ed = app.hoverArea.editor; const tree = ed.tree(); return (${fn})(ed, tree); })()`) as Promise<T>;
}

async function addNodes(page: Page, specs: [string, number, number][]): Promise<string[]> {
  return page.evaluate(async (specs) => {
    const { addNode } = await import('/src/nodes/tree.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const tree = a.hoverArea.editor.tree();
    const ids = specs.map(([type, x, y]) => addNode(tree, type, [x, y]).id);
    a.changed('doc');
    return ids;
  }, specs);
}

async function activate(page: Page, id: string) {
  await withTree(page, `(ed, t) => { for (const n of t.nodes) n.select = n.id === "${id}"; t.active_node = "${id}"; app.changed("ui"); }`);
  await page.waitForTimeout(50);
}

test('item lists of bundle, closure and capture nodes in the sidebar', async ({ page }) => {
  const { errors } = await nodeEditor(page);
  await page.evaluate(() => (window as unknown as { app: { run(id: string): void } }).app.run('node.new_geometry_nodes_modifier'));
  const [comb, cap] = await addNodes(page, [
    ['NodeCombineBundle', -200, 0],
    ['GeometryNodeCaptureAttribute', 100, 0],
  ]);
  await page.keyboard.press('n');
  await page.locator('.nd-side-tab', { hasText: 'Node' }).click();
  await activate(page, comb);
  const list = page.locator('.nd-sidebar .gn-zone-items').first();
  await list.locator('.ul-side button[data-tip="Add"]').click();
  await list.locator('.ul-side button[data-tip="Add"]').click();
  expect(await withTree(page, `(ed, t) => JSON.parse(t.nodes.find((n) => n.id === "${comb}").props.bundle_items).map((i) => i.name)`)).toEqual(['Float', 'Float.001']);
  // the operators act on the active node (F3 search and Adjust Last Operation)
  expect(await page.evaluate(() => (window as unknown as { app: { run(id: string, p?: object): string } }).app.run('node.combine_bundle_item_move', { direction: 'UP' }))).toBe('FINISHED');
  expect(await withTree(page, `(ed, t) => JSON.parse(t.nodes.find((n) => n.id === "${comb}").props.bundle_items).map((i) => i.name)`)).toEqual(['Float.001', 'Float']);
  await activate(page, cap);
  await page.evaluate(() => (window as unknown as { app: { run(id: string, p?: object): string } }).app.run('node.capture_attribute_item_add', { item_type: 'FLOAT_VECTOR' }));
  expect(await withTree(page, `(ed, t) => JSON.parse(t.nodes.find((n) => n.id === "${cap}").props.capture_items).map((i) => i.data_type)`)).toEqual(['FLOAT_VECTOR']);
  await expect(page.locator('.nd-sidebar .gn-zone-items .ul-row')).toHaveCount(1);
  // the Add menu: Utilities ▸ Bundle / Closure / List next to the other categories
  const menu = await page.evaluate(() => {
    const ed = (window as any).app.hoverArea.editor; // eslint-disable-line @typescript-eslint/no-explicit-any
    const items = ed.addMenuItems() as { label?: string; submenu?: () => { label?: string }[] }[];
    const util = items.find((i) => i.label === 'Utilities')!.submenu!().map((i) => i.label);
    return { top: items.map((i) => i.label), util };
  });
  expect(menu.top).toEqual(expect.arrayContaining(['Input', 'Output', 'Attribute', 'Utilities']));
  expect(menu.util).toEqual(expect.arrayContaining(['Math', 'Bundle', 'Closure', 'List']));
  // the closure zone comes from the Add menu (Utilities ▸ Closure ▸ Closure)
  expect(await page.evaluate(() => (window as unknown as { app: { run(id: string): string } }).app.run('node.add_closure_zone'))).toBe('RUNNING_MODAL');
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('dropping outliner items and interface sockets adds nodes; panel toggles; attach and viewer ops', async ({ page }) => {
  const { errors, box } = await nodeEditor(page);
  await page.evaluate(() => (window as unknown as { app: { run(id: string): void } }).app.run('node.new_geometry_nodes_modifier'));
  await page.waitForTimeout(200);
  // drag the Cube from the outliner into the node editor: an Object Info node for it
  await page
    .locator('.ol-row', { has: page.locator('.ol-name', { hasText: /^Cube$/ }) })
    .first()
    .locator('.ol-item')
    .dragTo(page.locator('.nd-editor').first(), { targetPosition: { x: box.width / 2, y: box.height / 2 } });
  await page.waitForTimeout(150);
  expect(await withTree(page, `(ed, t) => { const n = t.nodes.find((x) => x.type === "GeometryNodeObjectInfo"); return n && app.doc.objects[n.inputs.Object].name; }`)).toBe('Cube');
  // interface: a panel with a toggle input; the group's input list drags out as a Group Input node
  const run = (id: string, p: object = {}) => page.evaluate(([id, p]) => (window as unknown as { app: { run(id: string, p: object): string } }).app.run(id, p), [id, p] as const);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  expect(await run('node.interface_item_new', { item_type: 'PANEL' })).toBe('FINISHED');
  expect(await run('node.interface_item_new_panel_toggle')).toBe('FINISHED');
  expect(await withTree(page, '(ed, t) => !!t.interface_panels[0].toggle')).toBe(true);
  expect(await run('node.interface_item_unlink_panel_toggle')).toBe('FINISHED');
  expect(await run('node.interface_item_make_panel_toggle')).toBe('CANCELLED');
  await page.keyboard.press('n');
  await page.locator('.nd-side-tab', { hasText: 'Group' }).click();
  const rows = page.locator('.nd-iface-item[draggable="true"]');
  await rows.first().dragTo(page.locator('.nd-editor').first(), { targetPosition: { x: 80, y: 80 } });
  await page.waitForTimeout(150);
  expect(await withTree(page, '(ed, t) => t.nodes.filter((n) => n.type === "NodeGroupInput").some((n) => n.hidden_sockets?.length)')).toBe(true);
  // a frame: attach the selected node to it with node.attach at the frame
  await page.mouse.move(box.x + 100, box.y + 100);
  const [frame] = await addNodes(page, [['NodeFrame', 0, 0]]);
  // a fixed-size frame near the top left of the view
  await withTree(
    page,
    `(ed, t) => { const r = ed.el.getBoundingClientRect(); const [x, y] = ed.toNode(r.left + 60, r.top + 60); const f = t.nodes.find((n) => n.id === "${frame}"); f.location = [x, -y]; f.props.shrink = false; f.width = 200; f.props.height = 120; app.changed("doc"); }`,
  );
  await page.waitForTimeout(100);
  const ob = await withTree<string>(page, '(ed, t) => t.nodes.find((x) => x.type === "GeometryNodeObjectInfo").id');
  await activate(page, ob);
  const fb = (await page.locator(`[data-node="${frame}"]`).boundingBox())!;
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  expect(await run('node.attach')).toBe('FINISHED');
  expect(await withTree(page, `(ed, t) => t.nodes.find((n) => n.id === "${ob}").parent`)).toBe(frame);
  // header toggle for auto-offset
  const before = await page.evaluate(() => document.querySelectorAll('.nd-header .hdr-toggle.on').length);
  await page.locator('.nd-header [data-tip^="Auto-offset"]').first().click();
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => document.querySelectorAll('.nd-header .hdr-toggle.on').length)).not.toBe(before);
  await page.locator('.nd-header [data-tip^="Auto-offset"]').first().click();
  await expectNoErrors(errors);
});

test('node tools: a tool group made in the Tool context runs from the Node Tools menu', async ({ page }) => {
  const { errors } = await nodeEditor(page);
  await page.locator('.nd-header .gn-context').click();
  await page.locator('.menu .menu-item', { hasText: /^Tool/ }).first().click();
  await expect(page.locator('.nd-header .gn-context')).toContainText('Tool');
  await page.locator('.nd-header .id-selector').first().getByText('New').click();
  expect(await withTree(page, '(ed, t) => !!t && app.doc.node_groups[ed.toolGroup].is_tool')).toBe(true);
  // tool-only nodes are offered in this context
  expect(await page.evaluate(() => (window as any).app.hoverArea.editor.addSearchEntries().some((e: { label: string }) => /3D Cursor/.test(e.label)))).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.evaluate(async () => {
    const { addNode, connect, ctxOf } = await import('/src/nodes/tree.ts');
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const t = a.hoverArea.editor.tree();
    const gin = t.nodes.find((n: { type: string }) => n.type === 'NodeGroupInput'),
      gout = t.nodes.find((n: { type: string }) => n.type === 'NodeGroupOutput');
    t.links = [];
    const sp = addNode(t, 'GeometryNodeSetPosition', [0, 0]);
    sp.inputs.Offset = [0, 0, 0.5];
    const c = ctxOf(a.doc, t);
    connect(c, gin.id, 'Geometry', sp.id, 'Geometry');
    connect(c, sp.id, 'Geometry', gout.id, 'Geometry');
    a.changed('doc');
  });
  await page.locator('.hdr-menu', { hasText: 'Node Tools' }).first().dispatchEvent('pointerdown');
  await page.locator('.menu .menu-item', { hasText: 'Tool' }).first().click();
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(() => {
      const a = (window as any).app;
      return a.doc.meshes[a.activeObject.data].positions[2];
    }),
  ).toBeCloseTo(1.5); // eslint-disable-line @typescript-eslint/no-explicit-any
  await expectNoErrors(errors);
});
