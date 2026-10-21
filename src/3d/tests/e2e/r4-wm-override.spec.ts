// Library overrides: a changed property of an override goes back to the linked value from its button.
import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
async function rigProject(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const { startupDocument, newCollection, newObject } = await import('/src/data/defaults.ts');
    const { encodeDocument } = await import('/src/io/native.ts');
    const d = startupDocument();
    const col = newCollection('Rig');
    const cube = Object.values(d.objects).find((o: any) => o.name === 'Cube') as any;
    cube.name = 'Crate';
    for (const c of Object.values(d.collections) as any[]) c.objects = c.objects.filter((o: string) => o !== cube.id);
    const root = newObject('Root', 'EMPTY', null);
    d.objects[root.id] = root;
    d.object_order.push(root.id);
    cube.parent = root.id;
    col.objects.push(root.id, cube.id);
    d.collections[col.id] = col;
    d.collections[d.scene.collection].children.push(col.id);
    return Array.from(encodeDocument(d));
  });
}

test('right-click ▸ Remove Override puts an overridden property back', async ({ page }) => {
  const errors = await openApp(page);
  const bytes = await rigProject(page);
  await page.evaluate(() => (window as any).app.run('wm.link'));
  const dlg = page.locator('.lb');
  await expect(dlg).toBeVisible();
  page.once('filechooser', (fc) => fc.setFiles({ name: 'props.p3d', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) }));
  await dlg.locator('.fb-side-item', { hasText: 'Choose File' }).click();
  await dlg.locator('.lb-row', { hasText: 'Collections' }).dblclick();
  await dlg.locator('.lb-row', { hasText: 'Rig' }).click();
  await dlg.locator('.lb-go').click();
  await expect(dlg).toHaveCount(0);
  await page.evaluate(() => {
    const a = (window as any).app;
    const empty = (Object.values(a.doc.objects) as any[]).find((o) => o.name === 'Rig');
    a.doc.scene.active_object = empty.id;
    empty.select = true;
    a.run('object.make_override_library', {}, { invoke: false });
    const root = (Object.values(a.doc.objects) as any[]).find((o) => o.name === 'Root' && o.override_library);
    for (const o of Object.values(a.doc.objects) as any[]) o.select = false;
    root.select = true;
    root.location = [1, 1, 1];
    a.doc.scene.active_object = root.id;
    a.changed('doc', 'select');
  });
  await page.locator('.rail-tab[data-tab="OBJECT"]').click();
  const field = page.locator('.area[data-editor="PROPERTIES"] .num-field').first();
  await field.click({ button: 'right' });
  await page.locator('.menu .menu-item', { hasText: 'Remove Override' }).click();
  expect(await page.evaluate(() => ((Object.values((window as any).app.doc.objects) as any[]).find((o) => o.name === 'Root' && o.override_library).location))).toEqual([0, 0, 0]);
  await expectNoErrors(errors);
});
