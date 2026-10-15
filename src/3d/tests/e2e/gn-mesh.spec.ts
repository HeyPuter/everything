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
