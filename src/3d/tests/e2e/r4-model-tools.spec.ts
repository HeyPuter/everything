// Edit Mode tool behaviour: a drag with a tool is one complete operation (release confirms), and
// Ctrl+right-click extrudes the selection to the mouse.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const stats = (page: Page) =>
  page.evaluate(() => {
    const a = (window as Any).app;
    const me = a.doc.meshes[a.activeObject.data];
    return { faces: me.offsets.length - 1, verts: me.positions.length / 3, sel: Array.from(me.select_vert ?? []).filter(Boolean).length, modal: !!a.modal };
  });

test('tool drags confirm on release; Ctrl+right-click extrudes to the mouse', async ({ page }) => {
  const errors = await openApp(page);
  const c = await hoverViewport(page);
  await page.evaluate(async () => {
    const a = (window as Any).app;
    a.run('object.mode_set', { mode: 'EDIT' });
    a.run('mesh.select_mode', { type: 'FACE' });
    // select only the top face
    const me = a.doc.meshes[a.activeObject.data];
    me.select_vert = Uint8Array.from({ length: 8 }, (_, i) => (me.positions[i * 3 + 2] > 0 ? 1 : 0));
    const prefs = await import('/src/app/prefs.ts');
    prefs.activeTools.EDIT = 'builtin.extrude_region';
    a.changed('doc', 'ui');
  });
  const before = await stats(page);
  await page.mouse.move(c.x + 30, c.y - 30);
  await page.mouse.down();
  await page.mouse.move(c.x + 30, c.y - 60, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await stats(page)).modal).toBe(false);
  const after = await stats(page);
  expect(after.faces).toBe(before.faces + 4);
  // inset tool: same, one drag
  await page.evaluate(async () => ((await import('/src/app/prefs.ts')).activeTools.EDIT = 'builtin.inset_faces'));
  await page.mouse.move(c.x + 30, c.y - 30);
  await page.mouse.down();
  await page.mouse.move(c.x + 60, c.y - 40, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await stats(page)).modal).toBe(false);
  expect((await stats(page)).faces).toBe(after.faces + 4);
  // Ctrl+right-click: extrude the selection to the mouse
  await page.evaluate(async () => {
    const a = (window as Any).app;
    (await import('/src/app/prefs.ts')).activeTools.EDIT = 'builtin.select_box';
    a.run('mesh.select_mode', { type: 'VERT' });
    const me = a.doc.meshes[a.activeObject.data];
    const sel = new Uint8Array(me.positions.length / 3);
    sel[0] = 1;
    me.select_vert = sel;
    a.changed('doc');
  });
  const v0 = (await stats(page)).verts;
  await page.keyboard.down('Control');
  await page.mouse.click(c.x - 150, c.y + 80, { button: 'right' });
  await page.keyboard.up('Control');
  expect((await stats(page)).verts).toBe(v0 + 1);
  await expectNoErrors(errors);
});
