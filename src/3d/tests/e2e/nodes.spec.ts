// Node editor interactions shared by the Shader, Geometry Node and Compositor editors: menus,
// selection tools, link gestures, frames, groups, swapping and viewing node results.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/** Open a workspace and hover its node editor. */
async function nodeEditor(page: Page, workspace = 'Shading') {
  const errors = await openApp(page);
  await page.locator('.ws-tab', { hasText: workspace }).first().click();
  await page.waitForTimeout(600);
  const ed = page.locator('.nd-editor').first();
  const box = (await ed.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return { errors, box };
}

/** Run code with the hovered node editor and its tree. */
function withTree<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(`(() => { const ed = app.hoverArea.editor; const tree = ed.tree(); return (${fn})(ed, tree); })()`) as Promise<T>;
}

/** Add nodes by type at locations (node space) through the tree helpers, then redraw. */
async function addNodes(page: Page, specs: [string, number, number][]): Promise<string[]> {
  return page.evaluate(async (specs) => {
    const { addNode } = await import('/src/nodes/tree.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const tree = a.hoverArea.editor.tree();
    const ids = specs.map(([type, x, y]) => addNode(tree, type, [x, y]).id);
    a.changed('doc');
    a.flush?.();
    return ids;
  }, specs);
}

/** Screen centre of a node's header. */
async function nodeHeader(page: Page, id: string) {
  const b = (await page.locator(`[data-node="${id}"]`).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + 8, box: b };
}

async function link(page: Page, from: string, fromSocket: string, to: string, toSocket: string) {
  await page.evaluate(
    async ([from, fromSocket, to, toSocket]) => {
      const { connect, ctxOf } = await import('/src/nodes/tree.ts');
      const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
      const tree = a.hoverArea.editor.tree();
      connect(ctxOf(a.doc, tree), from, fromSocket, to, toSocket);
      a.changed('doc');
    },
    [from, fromSocket, to, toSocket],
  );
  await page.waitForTimeout(50);
}

async function drag(page: Page, button: 'left' | 'right', pts: { x: number; y: number }[], mods: string[] = []) {
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down({ button });
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y, { steps: 6 });
  await page.mouse.up({ button });
  for (const m of mods) await page.keyboard.up(m);
  await page.waitForTimeout(80);
}

const menuItem = (page: Page, label: string) => page.locator('.menu .menu-item', { hasText: new RegExp(`^${label}`) }).first();

test('select menu tools: grouped, same-type stepping, circle and lasso', async ({ page }) => {
  const { errors, box } = await nodeEditor(page);
  const [m1, m2, v] = await addNodes(page, [
    ['ShaderNodeMath', -600, 300],
    ['ShaderNodeMath', -350, 300],
    ['ShaderNodeValue', -600, -250],
  ]);
  await page.keyboard.press('Home');
  await page.waitForTimeout(300);
  // click a math node, then Shift G ▸ Type selects both math nodes
  const h1 = await nodeHeader(page, m1);
  await page.mouse.click(h1.x, h1.y);
  await page.keyboard.press('Shift+G');
  await menuItem(page, 'Type').click();
  const sel = () => withTree<string[]>(page, '(ed, t) => t.nodes.filter((n) => n.select).map((n) => n.id)');
  expect((await sel()).sort()).toEqual([m1, m2].sort());
  // Shift ] activates the next math node
  await page.keyboard.press('Shift+BracketRight');
  expect(await withTree(page, '(ed, t) => t.active_node')).toBe(m2);
  // circle select: C, paint over the value node, confirm with Esc
  await page.mouse.click(box.x + 5, box.y + box.height - 5);
  const hv = await nodeHeader(page, v);
  await page.mouse.move(hv.x, hv.y);
  await page.keyboard.press('c');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.press('Escape');
  expect(await sel()).toEqual([v]);
  // lasso: Ctrl Alt drag around the first math node adds it
  const b = h1.box;
  await drag(
    page,
    'left',
    [
      { x: b.x - 10, y: b.y - 10 },
      { x: b.x + b.width + 10, y: b.y - 10 },
      { x: b.x + b.width + 10, y: b.y + b.height + 10 },
      { x: b.x - 10, y: b.y + b.height + 10 },
      { x: b.x - 10, y: b.y - 5 },
    ],
    ['Control', 'Alt'],
  );
  expect((await sel()).sort()).toEqual([m1, v].sort());
  await expectNoErrors(errors);
});

test('link gestures add reroutes, mute and cut links; J links and Shift S swaps', async ({ page }) => {
  const { errors } = await nodeEditor(page);
  const linkInfo = () => withTree<{ n: number; muted: number; reroutes: number }>(page, '(ed, t) => ({ n: t.links.length, muted: t.links.filter((l) => l.is_muted).length, reroutes: t.nodes.filter((n) => n.type === "NodeReroute").length })');
  const before = await linkInfo();
  expect(before.n).toBe(1);
  // the BSDF → output link runs between the two nodes
  const [bsdf, out] = await withTree<string[]>(page, '(ed, t) => [t.nodes.find((n) => n.type === "ShaderNodeBsdfPrincipled").id, t.nodes.find((n) => n.type === "ShaderNodeOutputMaterial").id]');
  const a = (await nodeHeader(page, bsdf)).box,
    o = (await nodeHeader(page, out)).box;
  const x = (a.x + a.width + o.x) / 2;
  const line = [
    { x, y: Math.min(a.y, o.y) - 20 },
    { x, y: Math.max(a.y + 80, o.y + 120) },
  ];
  await drag(page, 'right', line, ['Control', 'Alt']);
  expect((await linkInfo()).muted).toBe(1);
  await drag(page, 'right', line, ['Shift']);
  const withReroute = await linkInfo();
  expect(withReroute.reroutes).toBe(1);
  expect(withReroute.n).toBe(2);
  // cutting both sides of the reroute
  await drag(
    page,
    'right',
    [
      { x: a.x + a.width + 4, y: line[0].y },
      { x: a.x + a.width + 4, y: line[1].y },
    ],
    ['Control'],
  );
  expect((await linkInfo()).n).toBe(1);
  // J links the selected nodes again
  await withTree(page, '(ed, t) => { for (const n of t.nodes) n.select = n.type !== "NodeReroute"; app.changed("ui"); }');
  await page.keyboard.press('Shift+J');
  expect(await withTree(page, `(ed, t) => t.links.some((l) => l.from_node === "${bsdf}" && l.to_node === "${out}")`)).toBe(true);
  // Shift S ▸ Shader ▸ Emission swaps the BSDF and keeps its output link
  await withTree(page, `(ed, t) => { for (const n of t.nodes) n.select = n.id === "${bsdf}"; t.active_node = "${bsdf}"; app.changed("ui"); }`);
  await page.keyboard.press('Shift+S');
  await menuItem(page, 'Shader').hover();
  await menuItem(page, 'Emission').click();
  const swapped = await withTree<{ type: string; linked: boolean }>(page, `(ed, t) => { const n = t.nodes.find((x) => x.type === "ShaderNodeEmission"); return { type: n && n.type, linked: t.links.some((l) => l.from_node === n.id && l.to_node === "${out}") }; }`);
  expect(swapped).toEqual({ type: 'ShaderNodeEmission', linked: true });
  await expectNoErrors(errors);
});

test('frames, duplicates keeping inputs and connecting to the output', async ({ page }) => {
  const { errors } = await nodeEditor(page);
  const [tex, inv] = await addNodes(page, [
    ['ShaderNodeTexNoise', -700, 200],
    ['ShaderNodeInvert', -450, 200],
  ]);
  await link(page, tex, 'Color', inv, 'Color');
  await page.keyboard.press('Home');
  await page.waitForTimeout(300);
  // F: join in a named frame
  await withTree(page, `(ed, t) => { for (const n of t.nodes) n.select = n.id === "${tex}" || n.id === "${inv}"; t.active_node = "${inv}"; app.changed("ui"); }`);
  await page.keyboard.press('f');
  await page.keyboard.type('Pattern');
  await page.keyboard.press('Enter');
  const frame = await withTree<{ label: string; kids: number } | null>(page, '(ed, t) => { const f = t.nodes.find((n) => n.type === "NodeFrame"); return f ? { label: f.label, kids: t.nodes.filter((n) => n.parent === f.id).length } : null; }');
  expect(frame).toEqual({ label: 'Pattern', kids: 2 });
  // Alt P removes the invert node from the frame, Ctrl P puts it back
  await withTree(page, `(ed, t) => { for (const n of t.nodes) n.select = n.id === "${inv}"; t.active_node = "${inv}"; app.changed("ui"); }`);
  await page.keyboard.press('Alt+P');
  expect(await withTree(page, `(ed, t) => t.nodes.find((n) => n.id === "${inv}").parent ?? null`)).toBeNull();
  await withTree(page, `(ed, t) => { const f = t.nodes.find((n) => n.type === "NodeFrame"); f.select = true; t.active_node = f.id; app.changed("ui"); }`);
  await page.keyboard.press('Control+P');
  expect(await withTree(page, `(ed, t) => t.nodes.find((n) => n.id === "${inv}").parent === t.nodes.find((n) => n.type === "NodeFrame").id`)).toBe(true);
  // Ctrl Shift D duplicates the invert node with its input link, Esc keeps it in place
  await withTree(page, `(ed, t) => { for (const n of t.nodes) n.select = n.id === "${inv}"; t.active_node = "${inv}"; app.changed("ui"); }`);
  await page.keyboard.press('Control+Shift+D');
  await page.keyboard.press('Escape');
  expect(await withTree(page, `(ed, t) => t.links.filter((l) => l.from_node === "${tex}").length`)).toBe(2);
  // Ctrl Shift click on the noise node connects it to the material output
  const h = await nodeHeader(page, tex);
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.mouse.click(h.x, h.y);
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  expect(await withTree(page, `(ed, t) => t.links.some((l) => l.from_node === "${tex}" && l.to_socket === "Surface")`)).toBe(true);
  await expectNoErrors(errors);
});

test('groups: make, enter by double click, separate and insert', async ({ page }) => {
  const { errors } = await nodeEditor(page);
  const [m1, m2] = await addNodes(page, [
    ['ShaderNodeMath', -700, 200],
    ['ShaderNodeMath', -450, 200],
  ]);
  await link(page, m1, 'Value', m2, 'Value');
  await withTree(page, `(ed, t) => { for (const n of t.nodes) n.select = n.id === "${m1}"; t.active_node = "${m1}"; app.changed("ui"); }`);
  await page.keyboard.press('Control+G');
  const gid = await withTree<string>(page, '(ed, t) => t.nodes.find((n) => n.type === "ShaderNodeGroup").id');
  await page.keyboard.press('Home');
  await page.waitForTimeout(300);
  const g = await nodeHeader(page, gid);
  await page.mouse.dblclick(g.x, g.y);
  expect(await withTree(page, '(ed) => ed.path.length')).toBe(1);
  // P ▸ Move takes the math node back out and returns to the material
  await withTree(page, '(ed, t) => { for (const n of t.nodes) n.select = n.type === "ShaderNodeMath"; app.changed("ui"); }');
  await page.keyboard.press('p');
  await menuItem(page, 'Move').click();
  expect(await withTree(page, '(ed) => ed.path.length')).toBe(0);
  expect(await withTree(page, '(ed, t) => t.nodes.filter((n) => n.type === "ShaderNodeMath").length')).toBe(2);
  // Insert Into Group (Node menu) moves the second math node into the group
  await withTree(page, `(ed, t) => { for (const n of t.nodes) n.select = n.id === "${m2}" || n.id === "${gid}"; t.active_node = "${gid}"; app.changed("ui"); }`);
  await page.locator('.nd-header .hdr-menu', { hasText: 'Node' }).first().dispatchEvent('pointerdown');
  await menuItem(page, 'Insert Into Group').click();
  expect(await withTree(page, `(ed, t) => !t.nodes.some((n) => n.id === "${m2}")`)).toBe(true);
  // double click on empty space inside the group goes back up
  await page.keyboard.press('Tab');
  expect(await withTree(page, '(ed) => ed.path.length')).toBe(1);
  await withTree(page, '(ed) => ed.viewAll(false, false)');
  const box = (await page.locator('.nd-editor').first().boundingBox())!;
  await page.mouse.dblclick(box.x + 12, box.y + box.height - 12);
  expect(await withTree(page, '(ed) => ed.path.length')).toBe(0);
  await expectNoErrors(errors);
});

test('viewer linking in the geometry and compositor editors', async ({ page }) => {
  const { errors } = await nodeEditor(page, 'Geometry Nodes');
  // a geometry node group with a primitive
  await page.evaluate(() => (window as unknown as { app: { run(id: string): void } }).app.run('node.new_geometry_nodes_modifier'));
  await page.waitForTimeout(300);
  const box = (await page.locator('.nd-editor').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const [cube] = await addNodes(page, [['GeometryNodeMeshCube', -300, -250]]);
  await page.keyboard.press('Home');
  await page.waitForTimeout(300);
  const h = await nodeHeader(page, cube);
  await page.mouse.click(h.x, h.y);
  // Ctrl 1 remembers the node and views it; viewing adds an active viewer
  await page.keyboard.press('Control+Digit1');
  const viewer = () => withTree<boolean>(page, `(ed, t) => t.nodes.some((n) => n.type === "GeometryNodeViewer" && n.props.viewer_active) && t.links.some((l) => l.from_node === "${cube}")`);
  expect(await viewer()).toBe(true);
  expect(await withTree(page, `(ed, t) => t.nodes.find((n) => n.id === "${cube}").viewer_shortcut`)).toBe(1);
  // compositor: Ctrl Shift click links a node to the viewer
  await page.locator('.ws-tab', { hasText: 'Compositing' }).first().click();
  await page.waitForTimeout(600);
  const cbox = (await page.locator('.nd-editor').first().boundingBox())!;
  await page.mouse.move(cbox.x + cbox.width / 2, cbox.y + cbox.height / 2);
  const hasTree = await withTree<boolean>(page, '(ed, t) => !!t');
  if (!hasTree) await page.evaluate(() => (window as unknown as { app: { run(id: string): void } }).app.run('node.new_compositing_node_group'));
  await page.waitForTimeout(300);
  const [blur] = await addNodes(page, [['CompositorNodeBlur', -300, -300]]);
  await page.keyboard.press('Home');
  await page.waitForTimeout(300);
  const hb = await nodeHeader(page, blur);
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.mouse.click(hb.x, hb.y);
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  expect(await withTree(page, `(ed, t) => t.links.some((l) => l.from_node === "${blur}" && t.nodes.find((n) => n.id === l.to_node).type === "CompositorNodeViewer")`)).toBe(true);
  await expectNoErrors(errors);
});
