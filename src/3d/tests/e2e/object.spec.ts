// Object Mode menus, shortcuts and Object Data list wiring.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

const get = (page: Page, expr: string) => page.evaluate(`(() => { const app = window.app; return ${expr}; })()`);
const run = (page: Page, op: string, props: Record<string, unknown> = {}) => page.evaluate(([o, p]) => (window as any).app.run(o, p, { invoke: false }), [op, props] as const); // eslint-disable-line @typescript-eslint/no-explicit-any
const item = (page: Page, text: string) => page.locator('.menu-item', { hasText: text });

async function headerMenu(page: Page, label: string) {
  await page.locator('.hdr-menu', { hasText: new RegExp(`^${label}$`) }).first().dispatchEvent('pointerdown');
  await expect(page.locator('.menu-item').first()).toBeVisible();
}

test('object menu structure and shortcuts open the right menus', async ({ page }) => {
  const errors = await openApp(page);
  await headerMenu(page, 'Object');
  for (const label of ['Set Origin', 'Apply', 'Collection', 'Relations', 'Parent', 'Modifiers', 'Link/Transfer Data', 'Convert', 'Clean Up', 'Delete Globally']) await expect(item(page, label).first()).toBeVisible();
  await item(page, 'Apply').first().hover();
  await expect(item(page, 'Rotation to Deltas')).toBeVisible();
  await expect(item(page, 'Animated Transforms to Deltas')).toBeVisible();
  await page.keyboard.press('Escape');

  await hoverViewport(page);
  // Ctrl L: link/transfer data
  await page.keyboard.press('Control+l');
  await expect(item(page, 'Transfer Mesh Data').first()).toBeVisible();
  await expect(item(page, 'Copy UV Maps').first()).toBeVisible();
  await page.keyboard.press('Escape');
  // Shift G: select grouped
  await page.keyboard.press('Shift+g');
  await expect(item(page, 'Immediate Children').first()).toBeVisible();
  await page.keyboard.press('Escape');
  // Ctrl P: parent types
  await page.keyboard.press('Control+p');
  await expect(item(page, 'Object (Keep Transform)').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoErrors(errors);
});

test('select more/less shortcuts follow parent links', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      a.run('object.empty_add', { location: [i, 0, 0] }, { invoke: false });
      if (ids.length) a.activeObject.parent = ids[ids.length - 1];
      ids.push(a.activeObject.id);
    }
    a.run('object.select_all', { action: 'DESELECT' });
    a.doc.objects[ids[1]].select = true;
    (window as any).chain = ids; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.changed('doc', 'select');
  });
  const selected = () => get(page, `window.chain.filter((id) => app.doc.objects[id].select).length`);
  await hoverViewport(page);
  await page.keyboard.press('Control+NumpadAdd');
  expect(await selected()).toBe(3);
  await page.evaluate(() => ((window as any).app.doc.objects[(window as any).chain[0]].select = false)); // eslint-disable-line @typescript-eslint/no-explicit-any
  await page.keyboard.press('Control+NumpadSubtract');
  expect(await selected()).toBe(1);
  await expectNoErrors(errors);
});

test('vertex group and shape key lists: specials menus, move buttons, locks', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'object.vertex_group_add');
  await run(page, 'object.vertex_group_add');
  await page.locator('.rail-tab[data-tip="Data"]').first().click();
  const vg = page.locator('.panel', { hasText: 'Vertex Groups' }).first();
  await expect(vg.locator('.ul-row')).toHaveCount(2);
  // specials ▸ Copy Vertex Group
  await vg.locator('.ul-specials').dispatchEvent('pointerdown');
  await item(page, 'Copy Vertex Group').first().click();
  await expect(vg.locator('.ul-row')).toHaveCount(3);
  expect(await get(page, `app.doc.meshes[app.activeObject.data].vertex_groups.map((g) => g.name).join(',')`)).toBe('Group,Group.001,Group.001_copy');
  // move up
  await vg.locator('[data-tip="Move Up"]').click();
  expect(await get(page, `app.activeObject.vertex_group_active_index`)).toBe(1);
  // lock toggle on a row
  await vg.locator('.ul-lock').first().click();
  expect(await get(page, `app.doc.meshes[app.activeObject.data].vertex_groups[0].lock_weight`)).toBe(true);

  await run(page, 'object.shape_key_add');
  await run(page, 'object.shape_key_add');
  const sk = page.locator('.panel', { hasText: 'Shape Keys' }).first();
  await expect(sk.locator('.ul-row')).toHaveCount(2);
  await sk.locator('.ul-specials').dispatchEvent('pointerdown');
  await item(page, 'Duplicate Shape Key').first().click();
  await expect(sk.locator('.ul-row')).toHaveCount(3);
  await expectNoErrors(errors);
});

test('add menu collection instance draws the collection', async ({ page }) => {
  const errors = await openApp(page);
  await run(page, 'collection.create', { name: 'Kit' });
  await hoverViewport(page);
  await page.keyboard.press('Shift+a');
  await item(page, 'Collection Instance').first().hover();
  await item(page, 'Kit').last().click();
  await page.waitForTimeout(300);
  const count = await page.evaluate(async () => {
    const { renderContext } = await import('/src/render/context.ts');
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const so = renderContext.sync.objects.get(a.activeObject.id);
    return so?.duplis?.children.length ?? 0;
  });
  expect(await get(page, `app.activeObject.instance_type`)).toBe('COLLECTION');
  expect(count).toBe(1);
  await expectNoErrors(errors);
});
