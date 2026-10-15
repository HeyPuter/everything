// Geometry Nodes curve family: Add menu placement, the viewport handles of gizmo nodes and the
// file button of import nodes.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/** Geometry Nodes workspace with a new modifier on the default cube; returns the editor box. */
async function geometryNodes(page: Page) {
  const errors = await openApp(page);
  await page.locator('.ws-tab', { hasText: 'Geometry Nodes' }).first().click();
  await page.waitForTimeout(500);
  const box = (await page.locator('.nd-editor').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => (window as unknown as { app: { run(id: string): void } }).app.run('node.new_geometry_nodes_modifier'));
  await page.waitForTimeout(200);
  return { errors, box };
}

/** Run code with the hovered node editor's tree (tree helpers in scope as `T`). */
function inTree<T>(page: Page, body: string): Promise<T> {
  return page.evaluate(`(async () => {
    const T = await import('/src/nodes/tree.ts');
    const a = window.app;
    const tree = a.hoverArea.editor.tree();
    const r = await (async () => { ${body} })();
    a.changed('doc');
    return r;
  })()`) as Promise<T>;
}

test('curve nodes sit in the Add menu submenus', async ({ page }) => {
  const { errors, box } = await geometryNodes(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Shift+A');
  await page
    .locator('.menu .menu-item', { hasText: /^Curve$/ })
    .first()
    .hover();
  await page
    .locator('.menu .menu-item', { hasText: /^Primitives$/ })
    .first()
    .hover();
  const prim = page.locator('.menu').last();
  await expect(prim.locator('.menu-item')).toHaveText(['Arc', 'Bézier Segment', 'Curve Circle', 'Curve Line', 'Spiral', 'Quadratic Bézier', 'Quadrilateral', 'Star']);
  await prim.locator('.menu-item', { hasText: 'Star' }).click();
  await page.waitForTimeout(100);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(await inTree<number>(page, `return tree.nodes.filter((n) => n.type === 'GeometryNodeCurveStar').length;`)).toBe(1);
  await expectNoErrors(errors);
});

test('dragging a linear gizmo changes the linked value', async ({ page }) => {
  const { errors } = await geometryNodes(page);
  const valId = await inTree<string>(
    page,
    `const v = T.addNode(tree, 'ShaderNodeValue', [-500, -200]);
     v.props['outputs.Value'] = 1;
     const g = T.addNode(tree, 'GeometryNodeGizmoLinear', [-250, -250]);
     g.inputs.Position = [0, 0, 1];
     T.connect(T.ctxOf(a.doc, tree), v.id, 'Value', g.id, 'Value');
     a.pushUndo('Add Gizmo');
     return v.id;`,
  );
  await page.waitForTimeout(300);
  const handle = page.locator('[data-gngizmo$="|lin"] .gz-hit').first();
  const b = (await handle.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.6 - 60, { steps: 8 });
  await page.mouse.up();
  const value = () =>
    page.evaluate(
      (id) =>
        Object.values((window as any).app.doc.node_groups as Record<string, any>)
          .flatMap((g) => g.tree.nodes)
          .find((n) => n.id === id).props['outputs.Value'],
      valId,
    ); // eslint-disable-line @typescript-eslint/no-explicit-any
  const after = await value();
  expect(after).toBeGreaterThan(1.5);
  // one undo step restores the value
  await page.keyboard.press('Control+Z');
  await page.waitForTimeout(100);
  expect(await value()).toBeCloseTo(1);
  await expectNoErrors(errors);
});

test('import nodes store the opened file and read it', async ({ page }) => {
  const { errors } = await geometryNodes(page);
  const nodeId = await inTree<string>(page, `const n = T.addNode(tree, 'GeometryNodeImportSTL', [-300, 0]); return n.id;`);
  await page.keyboard.press('Home');
  await page.waitForTimeout(300);
  const chooser = page.waitForEvent('filechooser');
  await page.locator(`[data-node="${nodeId}"] .nd-ids-open`).click();
  const fc = await chooser;
  await fc.setFiles({
    name: 'tri.stl',
    mimeType: 'model/stl',
    buffer: Buffer.from('solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n'),
  });
  await page.waitForTimeout(200);
  const state = await page.evaluate((id) => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const n = Object.values(a.doc.node_groups as Record<string, any>)
      .flatMap((g) => g.tree.nodes)
      .find((x) => x.id === id); // eslint-disable-line @typescript-eslint/no-explicit-any
    return { path: n.inputs.Path, files: Object.values(a.doc.packed_files ?? {}).map((f: any) => f.name) }; // eslint-disable-line @typescript-eslint/no-explicit-any
  }, nodeId);
  expect(state).toEqual({ path: 'tri.stl', files: ['tri.stl'] });
  await expect(page.locator(`[data-node="${nodeId}"] .nd-ids-name`)).toHaveText('tri.stl');
  await expectNoErrors(errors);
});

test('dial and transform gizmos draw handles and edit their values', async ({ page }) => {
  const { errors } = await geometryNodes(page);
  const ids = await inTree<{ val: string; group: string }>(
    page,
    `const v = T.addNode(tree, 'ShaderNodeValue', [-500, -200]);
     v.props['outputs.Value'] = 0;
     const d = T.addNode(tree, 'GeometryNodeGizmoDial', [-250, -250]);
     d.inputs.Position = [0, 0, 1.5];
     T.connect(T.ctxOf(a.doc, tree), v.id, 'Value', d.id, 'Value');
     const tg = T.addNode(tree, 'GeometryNodeGizmoTransform', [-250, -450]);
     tg.inputs.Position = [0, 6, 0];
     a.pushUndo('Add Gizmos');
     return { val: v.id, group: '' };`,
  );
  await page.waitForTimeout(300);
  // the transform gizmo draws three rings, three arrows and three boxes
  expect(await page.locator('g.gz[data-gngizmo*="|r:"]').count()).toBe(3);
  expect(await page.locator('g.gz[data-gngizmo*="|t:"]').count()).toBe(3);
  expect(await page.locator('[data-gngizmo*="|s:"]').count()).toBe(3);
  // points along the dial ring (screen space): drag a quarter turn along it
  const pts = await page.evaluate(() => {
    const path = document.querySelector('[data-gngizmo$="|dial"] .gz-hit') as SVGPathElement;
    const m = path.getScreenCTM()!;
    const len = path.getTotalLength();
    return Array.from({ length: 9 }, (_, k) => {
      const p = path.getPointAtLength((k / 8) * len * 0.25);
      return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
    });
  });
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y, { steps: 2 });
  await page.mouse.up();
  const v = await page.evaluate(
    (id) =>
      Object.values((window as any).app.doc.node_groups as Record<string, any>)
        .flatMap((g) => g.tree.nodes)
        .find((n) => n.id === id).props['outputs.Value'],
    ids.val,
  ); // eslint-disable-line @typescript-eslint/no-explicit-any
  expect(Math.abs(v)).toBeGreaterThan(0.8);
  expect(Math.abs(v)).toBeLessThan(2.4);
  await expectNoErrors(errors);
});
