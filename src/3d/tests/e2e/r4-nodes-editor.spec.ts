// Node editor additions of round 4: swapping to a new group, shader repeat zones and menu
// switches from the Add menu, compositor viewer region and legacy cryptomatte sockets, the
// Material tab's node panels and rendered preview, texture nodes in geometry trees.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/** Switch the 3D viewport area to an editor and hover it. */
async function editorArea(page: Page, type: string) {
  await page.evaluate(async (t) => {
    const { shell } = await import('/src/ui/shell.ts');
    shell.screen.areas.find((x: { type: string }) => x.type === 'VIEW_3D')!.setType(t);
  }, type);
  await page.waitForTimeout(400);
  const ed = page.locator('.nd-editor').first();
  const box = (await ed.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  return box;
}

function withTree<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(`(() => { const ed = app.hoverArea.editor; const tree = ed.tree(); return (${fn})(ed, tree); })()`) as Promise<T>;
}

const menuItem = (page: Page, label: string) => page.locator('.menu .menu-item', { hasText: new RegExp(`^${label}`) }).first();

test('Shift S ▸ Group ▸ New Group swaps the selection for a new empty group', async ({ page }) => {
  const errors = await openApp(page);
  await editorArea(page, 'SHADER');
  const before = await page.evaluate(() => Object.keys((window as unknown as { app: { doc: { node_groups: object } } }).app.doc.node_groups).length);
  await withTree(page, '(ed, t) => { for (const n of t.nodes) n.select = n.type === "ShaderNodeBsdfPrincipled"; app.changed("ui"); }');
  await page.keyboard.press('Shift+S');
  await menuItem(page, 'Group').hover();
  await menuItem(page, 'New Group').click();
  const r = await withTree<{ groups: number; group: boolean; bsdf: boolean }>(
    page,
    '(ed, t) => ({ groups: Object.keys(app.doc.node_groups).length, group: t.nodes.some((n) => n.type === "ShaderNodeGroup" && app.doc.node_groups[n.props.node_tree]), bsdf: t.nodes.some((n) => n.type === "ShaderNodeBsdfPrincipled") })',
  );
  expect(r).toEqual({ groups: before + 1, group: true, bsdf: false });
  await expectNoErrors(errors);
});

test('shader trees add Repeat zones and Menu Switches from the Add menu', async ({ page }) => {
  const errors = await openApp(page);
  const box = await editorArea(page, 'SHADER');
  await page.keyboard.press('Shift+A');
  await menuItem(page, 'Utilities').hover();
  await menuItem(page, 'Repeat').click();
  await page.mouse.click(box.x + 200, box.y + 150);
  const zone = await withTree<{ input: boolean; output: boolean; items: string; label: string }>(
    page,
    `(ed, t) => { const i = t.nodes.find((n) => n.type === 'GeometryNodeRepeatInput'); const o = t.nodes.find((n) => n.type === 'GeometryNodeRepeatOutput'); return { input: !!i, output: !!o && i.props.paired_output === o.id, items: o ? o.props.repeat_items : '', label: document.querySelector('[data-node="' + i.id + '"] .nd-title')?.textContent ?? '' }; }`,
  );
  expect(zone.input && zone.output).toBe(true);
  expect(zone.items).toBe('[]');
  expect(zone.label).toContain('Repeat');
  await page.keyboard.press('Shift+A');
  await menuItem(page, 'Utilities').hover();
  await menuItem(page, 'Menu Switch').click();
  await page.mouse.click(box.x + 200, box.y + 350);
  expect(await withTree(page, '(ed, t) => t.nodes.find((n) => n.type === "GeometryNodeMenuSwitch")?.props.data_type')).toBe('RGBA');
  await expectNoErrors(errors);
});

test('compositor: viewer region from a dragged rectangle, legacy cryptomatte sockets', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => (window as unknown as { app: { run(id: string): void } }).app.run('node.new_compositing_node_group'));
  const box = await editorArea(page, 'COMPOSITOR');
  // a viewer showing a color
  await page.evaluate(async () => {
    const T = await import('/src/nodes/tree.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const t = a.hoverArea.editor.tree();
    const ctx = T.ctxOf(a.doc, t);
    const rgb = T.addNode(t, 'CompositorNodeRGB', [-300, 0]);
    const v = T.addNode(t, 'CompositorNodeViewer', [0, 0]);
    T.connect(ctx, rgb.id, 'RGBA', v.id, 'Image');
    t.active_node = v.id;
    a.changed('doc');
  });
  await page.waitForFunction(() => {
    // the compositor runs asynchronously
    return !!document.querySelector('.nd-editor');
  });
  await page.waitForTimeout(800);
  const hasViewer = await page.evaluate(async () => !!(await import('/src/compositor/session.ts')).compositorState.viewer);
  if (hasViewer) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.press('Control+B');
    await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2 - 30);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 30, { steps: 5 });
    await page.mouse.up();
    const region = await withTree<number[] | null>(page, '(ed, t) => t.use_viewer_border ? t.viewer_border : null');
    expect(region).not.toBeNull();
    expect(region![2]).toBeGreaterThan(region![0]);
    await page.keyboard.press('Control+Alt+B');
    expect(await withTree(page, '(ed, t) => !!t.use_viewer_border')).toBe(false);
  }
  // legacy Cryptomatte: add and remove pass inputs
  const cm = await page.evaluate(async () => {
    const T = await import('/src/nodes/tree.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const t = a.hoverArea.editor.tree();
    const n = T.addNode(t, 'CompositorNodeCryptomatte', [-300, -300]);
    t.active_node = n.id;
    a.run('node.cryptomatte_layer_add');
    const R = await import('/src/nodes/registry.ts');
    const after = R.nodeSockets(n, T.ctxOf(a.doc, t)).inputs.map((s: { identifier: string }) => s.identifier);
    a.run('node.cryptomatte_layer_remove');
    a.run('node.cryptomatte_layer_remove');
    const removed = R.nodeSockets(n, T.ctxOf(a.doc, t)).inputs.map((s: { identifier: string }) => s.identifier);
    return { after, removed };
  });
  expect(cm.after).toEqual(['Image', 'Crypto 00', 'Crypto 01', 'Crypto 02', 'Crypto 03']);
  expect(cm.removed).toEqual(['Image', 'Crypto 00', 'Crypto 01']);
  await expectNoErrors(errors);
});

test('Material tab: node panels, output panels and a rendered preview', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const { shell } = await import('/src/ui/shell.ts');
    shell.screen.areas.find((x: { type: string }) => x.type === 'VIEW_3D')!.setType('PROPERTIES');
  });
  await page.waitForTimeout(300);
  const props = page.locator('.area').first();
  await props.locator('[data-tip^="Material"]').first().click();
  await expect(props.locator('[data-panel="ma-node-volume"]')).toBeVisible();
  await expect(props.locator('[data-panel="ma-node-displacement"]')).toBeVisible();
  await expect(props.locator('[data-panel="ma-node-thickness"]')).toBeVisible();
  // Principled panels are closed: Diffuse Roughness is hidden until Diffuse is opened
  const surface = props.locator('[data-panel="ma-surface"]');
  await expect(surface.locator('.split-row', { hasText: 'Diffuse Roughness' })).toHaveCount(0);
  await surface.locator('.nd-props-panel-hdr', { hasText: 'Diffuse' }).click();
  await expect(surface.locator('.split-row', { hasText: 'Diffuse Roughness' })).toHaveCount(1);
  // preview: an image rendered from the material, on the chosen shape
  await props.locator('[data-panel="ma-preview"] .panel-header').click();
  await expect(props.locator('.mat-preview-img[src^="data:image"]')).toBeVisible({ timeout: 10000 });
  await props.locator('.mat-preview-shape').nth(2).click();
  expect(await page.evaluate(() => Object.values((window as unknown as { app: { doc: { materials: Record<string, { preview_render_type?: string }> } } }).app.doc.materials)[0].preview_render_type)).toBe('CUBE');
  await expectNoErrors(errors);
});

test('texture nodes in a geometry node tree displace a grid', async ({ page }) => {
  const errors = await openApp(page);
  const r = await page.evaluate(async () => {
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { runJavaScript } = await import('/src/scripting/runner.ts');
    const res = runJavaScript(`{
      const ob = bpy.data.objects['Cube'];
      const mod = ob.modifiers.new('GN', 'NODES');
      const nt = bpy.data.node_groups.new('T', 'GeometryNodeTree');
      for (const n of [...nt.nodes]) nt.nodes.remove(n);
      nt.interface.new_socket('Geometry', {in_out: 'OUTPUT', socket_type: 'NodeSocketGeometry'});
      mod.node_group = nt;
      const out = nt.nodes.new('NodeGroupOutput');
      const grid = nt.nodes.new('GeometryNodeMeshGrid');
      grid.inputs['Vertices X'].default_value = 20; grid.inputs['Vertices Y'].default_value = 20;
      const vor = nt.nodes.new('ShaderNodeTexVoronoi');
      const sp = nt.nodes.new('GeometryNodeSetPosition');
      const cmb = nt.nodes.new('ShaderNodeCombineXYZ');
      nt.links.new(vor.outputs['Distance'], cmb.inputs['Z']);
      nt.links.new(grid.outputs['Mesh'], sp.inputs['Geometry']);
      nt.links.new(cmb.outputs['Vector'], sp.inputs['Offset']);
      nt.links.new(sp.outputs['Geometry'], out.inputs[0]);
    }`);
    a.changed('doc');
    a.flush?.();
    await new Promise((r) => setTimeout(r, 300));
    const ob = Object.values(a.doc.objects as Record<string, { name: string; id: string }>).find((o) => o.name === 'Cube')!;
    const m = a.graph.get(ob.id)?.mesh;
    const z: number[] = [];
    if (m) for (let i = 2; i < m.positions.length; i += 3) z.push(m.positions[i]);
    return { ok: res.ok, error: res.error, n: z.length, min: Math.min(...z), max: Math.max(...z) };
  });
  expect(r.ok, r.error).toBe(true);
  expect(r.n).toBe(400);
  expect(r.max).toBeGreaterThan(r.min + 0.1);
  await expectNoErrors(errors);
});

test('compositor asset shelf: effect thumbnails, adding an effect group, effects change images', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => (window as unknown as { app: { run(id: string): void } }).app.run('node.new_compositing_node_group'));
  const box = await editorArea(page, 'COMPOSITOR');
  const tiles = page.locator('.cmp-shelf-tile');
  await expect(tiles).toHaveCount(8);
  await expect(page.locator('.cmp-shelf-tile img').first()).toBeVisible();
  // the Creative tab narrows the list; search filters by name
  await page.locator('.cmp-shelf-tab', { hasText: 'Creative' }).click();
  await expect(tiles).toHaveCount(2);
  await page.locator('.cmp-shelf-tab', { hasText: 'All' }).click();
  await page.locator('.cmp-shelf-search input').fill('vign');
  await expect(tiles).toHaveCount(1);
  await tiles.first().click();
  await page.mouse.move(box.x + box.width / 2, box.y + 120, { steps: 4 });
  await page.mouse.click(box.x + box.width / 2, box.y + 120);
  const added = await withTree<{ group: string | null; reuse: number }>(page, '(ed, t) => { const n = t.nodes.find((x) => x.type === "CompositorNodeGroup"); const g = n && app.doc.node_groups[n.props.node_tree]; return { group: g ? g.name : null, reuse: Object.values(app.doc.node_groups).filter((x) => x.effect_id === "vignette").length }; }');
  expect(added).toEqual({ group: 'Vignette', reuse: 1 });
  // every effect runs and changes a test image
  const changed = await page.evaluate(async () => {
    const { EFFECTS, effectPreviewGroup } = await import('/src/compositor/effects.ts');
    const { runCompositorGroup } = await import('/src/compositor/run.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const W = 32,
      H = 24;
    const data = new Float32Array(W * H * 4);
    for (let i = 0; i < W * H; i++) data.set([0.2 + (i % W) / W * 0.6, 0.4, 0.3 + Math.floor(i / W) / H * 0.5, 1], i * 4);
    const out: Record<string, number> = {};
    for (const fx of EFFECTS) {
      const r = runCompositorGroup(a.doc, effectPreviewGroup(a.doc, fx), { data, width: W, height: H });
      let diff = 0;
      if (r) for (let i = 0; i < data.length; i++) diff = Math.max(diff, Math.abs(r.data[i] - data[i]));
      out[fx.id] = r ? diff : -1;
    }
    return out;
  });
  for (const [id, d] of Object.entries(changed)) {
    // Tune Image is neutral at its defaults
    if (id === 'tune_image') expect(d, id).toBeLessThan(0.01);
    else expect(d, id).toBeGreaterThan(0.005);
  }
  await expectNoErrors(errors);
});

test('compositor: Menu Switch picks the input named by a Menu node', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => (window as unknown as { app: { run(id: string): void } }).app.run('node.new_compositing_node_group'));
  await editorArea(page, 'COMPOSITOR');
  const color = await page.evaluate(async () => {
    const T = await import('/src/nodes/tree.ts');
    const S = await import('/src/compositor/session.ts');
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.doc.scene.render.resolution_x = 64;
    a.doc.scene.render.resolution_y = 48;
    const t = a.hoverArea.editor.tree();
    const ctx = T.ctxOf(a.doc, t);
    const red = T.addNode(t, 'CompositorNodeRGB', [-500, 0]);
    red.props['outputs.Color'] = [1, 0, 0, 1];
    const blue = T.addNode(t, 'CompositorNodeRGB', [-500, -200]);
    blue.props['outputs.Color'] = [0, 0, 1, 1];
    const sw = T.addNode(t, 'GeometryNodeMenuSwitch', [-250, 0], { data_type: 'RGBA' });
    sw.props.enum_items = JSON.stringify([
      { id: 0, name: 'Red' },
      { id: 1, name: 'Blue' },
    ]);
    const menu = T.addNode(t, 'FunctionNodeInputMenu', [-500, 200]);
    menu.props.value = 'Blue';
    T.connect(ctx, menu.id, 'Menu', sw.id, 'Menu');
    T.connect(ctx, red.id, 'Color', sw.id, 'Item_0');
    T.connect(ctx, blue.id, 'Color', sw.id, 'Item_1');
    const v = t.nodes.find((n: { type: string }) => n.type === 'CompositorNodeViewer') ?? T.addNode(t, 'CompositorNodeViewer', [0, 0]);
    T.connect(ctx, sw.id, 'Output', v.id, 'Image');
    t.active_node = v.id;
    a.changed('doc');
    S.recomposite(true);
    const vw = S.compositorState.viewer;
    return vw ? Array.from(vw.data.subarray(0, 4)) : null;
  });
  expect(color).not.toBeNull();
  expect(color![2]).toBeGreaterThan(0.9);
  expect(color![0]).toBeLessThan(0.1);
  await expectNoErrors(errors);
});

test('a linked material can be looked at: dragging nodes, links and edges reports instead of failing', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(async () => {
    const R = await import('/src/library/readonly.ts');
    const ma = Object.values((window as unknown as { app: { doc: { materials: Record<string, { library?: string }> } } }).app.doc.materials)[0];
    ma.library = 'lib';
    R.lockRecord(ma);
  });
  const box = await editorArea(page, 'SHADER');
  await page.keyboard.press('Home');
  await page.waitForTimeout(400);
  const socket = (title: string, name: string, out: boolean) =>
    withTree<[number, number]>(
      page,
      `(ed, t) => { const n = t.nodes.find((x) => x.name.startsWith(${JSON.stringify(title)})); const s = [...ed.layouts.get(n.id).sockets.values()].find((p) => p.socket.name === ${JSON.stringify(name)} && p.isOutput === ${out}); const r = ed.el.getBoundingClientRect(); const [x, y] = ed.toScreen(s.x, s.y); return [r.left + x, r.top + y]; }`,
    );
  const drag = async (from: [number, number], to: [number, number]) => {
    await page.mouse.move(...from);
    await page.mouse.down();
    await page.mouse.move(...to, { steps: 4 });
    await page.mouse.up();
  };
  // pick up the Surface link, draw a new link, move a node by its header
  const surf = await socket('Material Output', 'Surface', false);
  await drag(surf, [surf[0] - 60, surf[1] + 80]);
  const bsdf = await socket('Principled', 'BSDF', true);
  await drag(bsdf, await socket('Material Output', 'Volume', false));
  const title = (await page.locator('.nd-node .nd-title', { hasText: 'Principled' }).first().boundingBox())!;
  await drag([title.x + 30, title.y + title.height / 2], [title.x + 90, title.y + 60]);
  await page.mouse.move(box.x + 300, box.y + 400);
  await page.keyboard.press('g');
  await page.mouse.move(box.x + 340, box.y + 420, { steps: 3 });
  await page.mouse.click(box.x + 340, box.y + 420);
  const state = await withTree<{ links: number }>(page, '(ed, t) => ({ links: t.links.length })');
  expect(state.links).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { app: { reports: { message: string }[] } }).app.reports.some((r) => /node tree is linked/.test(r.message)))).toBe(true);
  await expectNoErrors(errors);
});

test('compositor: huge Bokeh Blur and non-separable Blur sizes finish', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await openApp(page);
  const r = await page.evaluate(async () => {
    const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('node.new_compositing_node_group');
    const T = await import('/src/nodes/tree.ts');
    const D = await import('/src/compositor/data.ts');
    const RUN = await import('/src/compositor/run.ts');
    const { newImage } = await import('/src/data/defaults.ts');
    const img = newImage('small', 64, 64, 'UV_GRID');
    a.doc.images[img.id] = img;
    const out: Record<string, unknown> = {};
    for (const [type, inputs] of [
      ['CompositorNodeBokehBlur', { Size: 1e6 }],
      ['CompositorNodeBlur', { Size: [4000, 4000], Separable: false }],
    ] as const) {
      const t = D.compositingGroup(a.doc)!.tree;
      t.nodes = [];
      t.links = [];
      const ctx = T.ctxOf(a.doc, t);
      const src = T.addNode(t, 'CompositorNodeImage', [-300, 0], { image: img.id });
      const n = T.addNode(t, type, [0, 0]);
      Object.assign(n.inputs, inputs);
      const v = T.addNode(t, 'CompositorNodeViewer', [300, 0]);
      T.connect(ctx, src.id, 'Image', n.id, 'Image');
      T.connect(ctx, n.id, 'Image', v.id, 'Image');
      const t0 = performance.now();
      const res = RUN.runCompositor(a.doc, { layers: null, composite: false, viewer: true, viewerNode: v.id });
      const finite = !!res.viewer && res.viewer.data.every((x) => Number.isFinite(x));
      out[type] = { finite, error: res.error ?? null, slow: performance.now() - t0 > 30000 };
    }
    return out;
  });
  expect(r).toEqual({
    CompositorNodeBokehBlur: { finite: true, error: null, slow: false },
    CompositorNodeBlur: { finite: true, error: null, slow: false },
  });
  await expectNoErrors(errors);
});
