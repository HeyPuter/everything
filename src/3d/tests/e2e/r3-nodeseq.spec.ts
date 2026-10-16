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

// ---------------------------------------------------------------------------
// Video Sequencer

/* eslint-disable @typescript-eslint/no-explicit-any */
async function videoWorkspace(page: Page) {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const { shell } = await import('/src/ui/shell.ts' as any);
    const { workspaceTemplates } = await import('/src/ui/screen.ts' as any);
    shell.addWorkspace(workspaceTemplates.find((t: any) => t.create().name === 'Video Editing').create());
    const app = (window as any).app;
    app.run('sequencer.effect_strip_add', { type: 'COLOR', frame_start: 1, channel: 1, length: 40, color: [0.8, 0.3, 0.1] }, { invoke: false });
    app.run('sequencer.effect_strip_add', { type: 'TEXT', frame_start: 50, channel: 2, length: 40 }, { invoke: false });
    const ed = app.doc.scene.sequence_editor;
    for (const s of ed.strips) s.select = s.type === 'COLOR';
    ed.active_strip = ed.strips.find((s: any) => s.type === 'COLOR').name;
    app.changed('doc');
  });
  await page.waitForTimeout(300);
  return errors;
}
const seq = (page: Page) => page.evaluate(() => (window as any).app.doc.scene.sequence_editor);
const runOp = (page: Page, id: string, p: object = {}) => page.evaluate(([id, p]) => (window as any).app.run(id, p), [id, p] as const);

test('sequencer: modifier menu, stack operators, compositor node group modifier', async ({ page }) => {
  const errors = await videoWorkspace(page);
  await page.locator('.rail-tab[data-tab="STRIP_MODIFIER"]').first().click();
  for (const label of ['Hue Correct', 'Tone Map']) {
    await page.locator('.seq-add-mod').first().dispatchEvent('pointerdown');
    await page.locator('.popup-layer .menu-item', { hasText: label }).first().click();
  }
  const color = async () => (await seq(page)).strips.find((s: any) => s.type === 'COLOR');
  expect((await color()).modifiers.map((m: any) => m.type)).toEqual(['HUE_CORRECT', 'TONEMAP']);
  expect(await runOp(page, 'sequencer.strip_modifier_duplicate', { name: 'Hue Correct' })).toBe('FINISHED');
  expect(await runOp(page, 'sequencer.strip_modifier_move_to_index', { modifier: 'Tone Map', index: 0 })).toBe('FINISHED');
  expect((await color()).modifiers.map((m: any) => m.name)).toEqual(['Tone Map', 'Hue Correct', 'Hue Correct.001']);
  for (const n of ['Tone Map', 'Hue Correct', 'Hue Correct.001']) await runOp(page, 'sequencer.strip_modifier_remove', { name: n });
  // the preview colour before and after a compositor group that inverts the image
  const pv = page.locator('.seq-pv').first();
  const b = (await pv.boundingBox())!;
  // the hovered sequencer's preview reads back its last frame
  const pixel = async () => {
    await page.waitForTimeout(500);
    return page.evaluate(([x, y]) => (window as any).app.hoverArea?.editor?.preview?.sample(x, y)?.rgba ?? null, [b.x + b.width * 0.25, b.y + b.height * 0.25]);
  };
  await page.mouse.move(b.x + b.width * 0.25, b.y + b.height * 0.25);
  const before = (await pixel())!;
  expect(before[0]).toBeGreaterThan(before[2]);
  expect(await runOp(page, 'sequencer.strip_modifier_add_node_group')).toBe('FINISHED');
  await page.evaluate(async () => {
    const { addNode, ctxOf, connect } = await import('/src/nodes/tree.ts' as any);
    const a = (window as any).app;
    const m = a.doc.scene.sequence_editor.strips.find((s: any) => s.type === 'COLOR').modifiers[0];
    const t = a.doc.node_groups[m.node_group].tree;
    const gin = t.nodes.find((n: any) => n.type === 'NodeGroupInput'),
      gout = t.nodes.find((n: any) => n.type === 'NodeGroupOutput');
    const inv = addNode(t, 'CompositorNodeInvert', [0, 0]);
    t.links = [];
    const c = ctxOf(a.doc, t);
    connect(c, gin.id, t.interface[0].identifier, inv.id, 'Color');
    connect(c, inv.id, 'Color', gout.id, t.interface.find((i: any) => i.in_out === 'OUTPUT').identifier);
    a.changed('doc');
  });
  const after = (await pixel())!;
  expect(after[2]).toBeGreaterThan(after[0]);
  await expectNoErrors(errors);
});

test('sequencer: frame overlay region, duplicate linked, text style presets, proxy menu', async ({ page }) => {
  const errors = await videoWorkspace(page);
  // O in the preview: drag the overlay rectangle
  const pv = page.locator('.seq-pv').first();
  const b = (await pv.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.keyboard.press('o');
  await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.7, { steps: 4 });
  await page.mouse.up();
  const ed = await seq(page);
  expect(ed.show_overlay_frame).toBe(true);
  expect(ed.overlay_frame_rect[2] - ed.overlay_frame_rect[0]).toBeGreaterThan(0.1);
  // Alt D in the timeline: a linked duplicate that follows the pointer
  const tl = page.locator('.seq-main').last();
  await tl.hover();
  const n0 = ed.strips.length;
  await page.keyboard.press('Alt+d');
  await page.keyboard.press('Escape');
  expect((await seq(page)).strips.length).toBe(n0 + 1);
  // text style presets from the Strip tab
  await page.evaluate(() => {
    const a = (window as any).app;
    const e = a.doc.scene.sequence_editor;
    for (const s of e.strips) s.select = s.type === 'TEXT';
    e.active_strip = e.strips.find((s: any) => s.type === 'TEXT').name;
    a.changed('doc');
  });
  await page.locator('.rail-tab[data-tab="STRIP"]').first().click();
  await page.locator('.seq-style-presets').first().dispatchEvent('pointerdown');
  await page
    .locator('.popup-layer .menu-item', { hasText: /^Title/ })
    .first()
    .click();
  expect((await seq(page)).strips.find((s: any) => s.type === 'TEXT').font_size).toBe(120);
  // View ▸ Proxy (preview) offers Setup and Rebuild (disabled without movie strips)
  await page
    .locator('.seq-hdr')
    .first()
    .locator('.hdr-menu', { hasText: /^View$/ })
    .dispatchEvent('pointerdown');
  await page
    .locator('.popup-layer .menu-item', { hasText: /^Proxy/ })
    .first()
    .hover();
  await expect(page.locator('.popup-layer .menu-item', { hasText: 'Setup' }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});
