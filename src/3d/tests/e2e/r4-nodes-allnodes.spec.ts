// Every node type of the Add menus can be added to its editor and drawn (node body, sockets,
// sidebar) without errors, in the Shader, Geometry Node and Compositor editors.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

async function editorArea(page: Page, type: string) {
  await page.evaluate(async (t) => {
    const { shell } = await import('/src/ui/shell.ts');
    shell.screen.areas.find((x: { type: string }) => x.type === 'VIEW_3D')!.setType(t);
  }, type);
  await page.waitForTimeout(300);
  const box = (await page.locator('.nd-editor').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

for (const [editor, setup] of [
  ['SHADER', ''],
  ['GEOMETRY', 'node.new_geometry_nodes_modifier'],
  ['COMPOSITOR', 'node.new_compositing_node_group'],
] as const) {
  test(`all ${editor.toLowerCase()} Add-menu nodes draw`, async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await openApp(page);
    if (setup) await page.evaluate((op) => (window as unknown as { app: { run(id: string): void } }).app.run(op), setup);
    await editorArea(page, editor);
    const r = await page.evaluate(async () => {
      const T = await import('/src/nodes/tree.ts');
      const a = (window as unknown as { app: any }).app; // eslint-disable-line @typescript-eslint/no-explicit-any
      const ed = a.hoverArea.editor;
      const ids = new Set<string>();
      const walk = (items: { submenu?: unknown; label?: string; separator?: boolean }[]) => {
        for (const it of items) {
          if (!it || it.separator) continue;
          const sub = typeof it.submenu === 'function' ? (it.submenu as () => unknown[])() : it.submenu;
          if (Array.isArray(sub)) walk(sub as never);
        }
      };
      walk(ed.addMenuItems());
      // the menu items call addNodeInteractive: collect the types through the search entries instead
      for (const e of ed.addSearchEntries(undefined, (idname: string) => ids.add(idname))) e.run();
      const tree = ed.tree();
      const failed: string[] = [];
      let x = 0;
      for (const id of ids) {
        try {
          const n = T.addNode(tree, id, [x, 0]);
          x += 260;
          tree.active_node = n.id;
          ed.showSidebar = true;
          ed.render();
        } catch (e) {
          failed.push(`${id}: ${e instanceof Error ? e.message : e}`);
        }
      }
      a.changed('doc');
      return { count: ids.size, failed };
    });
    expect(r.failed).toEqual([]);
    expect(r.count).toBeGreaterThan(40);
    await page.waitForTimeout(500);
    await expectNoErrors(errors);
  });
}
