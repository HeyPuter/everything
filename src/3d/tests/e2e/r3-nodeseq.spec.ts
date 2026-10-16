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
  // the closure zone comes from the Add menu (Utilities ▸ Closure ▸ Closure)
  expect(await page.evaluate(() => (window as unknown as { app: { run(id: string): string } }).app.run('node.add_closure_zone'))).toBe('RUNNING_MODAL');
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});
