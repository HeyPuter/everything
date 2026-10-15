// Metaball objects: Add menu, evaluated surface, Edit Mode element selection / delete, properties.
import { test, expect, type Page } from '@playwright/test';
import { openApp, hoverViewport, expectNoErrors } from './helpers';

const get = <T>(page: Page, expr: string): Promise<T> => page.evaluate(`(() => { const app = window.app; app.flush(); return ${expr}; })()`) as Promise<T>;
const faces = (page: Page) => get<number>(page, `(() => { const m = app.graph.get(app.activeObject.id).mesh; return m ? m.offsets.length - 1 : -1; })()`);
const elements = (page: Page) => get<{ type: string; select: boolean }[]>(page, `app.doc.metaballs[app.activeObject.data].elements.map((e) => ({ type: e.type, select: !!e.select }))`);

test('metaball: add from the menu, edit elements, change resolution', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.select_all', { action: 'SELECT' });
    a.run('object.delete', { confirm: false });
  });
  const c = await hoverViewport(page);
  await page.keyboard.press('Shift+A');
  await page.locator('.menu-item').filter({ hasText: /^Metaball/ }).first().hover();
  await page.locator('.menu-item').filter({ hasText: /^Ball$/ }).first().click();
  expect(await get(page, 'app.activeObject.type')).toBe('META');
  const ballFaces = await faces(page);
  expect(ballFaces).toBeGreaterThan(100);

  // Edit Mode: add a capsule next to the ball, both visible as rings
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('Tab');
  expect(await get(page, 'app.doc.mode')).toBe('EDIT');
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.doc.scene.cursor.location = [3, 0, 0];
  });
  await page.keyboard.press('Shift+A');
  await page.locator('.menu-item').filter({ hasText: /^Capsule$/ }).first().click();
  expect(await elements(page)).toEqual([
    { type: 'BALL', select: false },
    { type: 'CAPSULE', select: true },
  ]);
  await expect(page.locator('.mball-edit g[data-element]')).toHaveCount(2);
  expect(await faces(page)).toBeGreaterThan(ballFaces);

  // click the ball's centre to select it, then delete it
  const dot = page.locator('.mball-edit g[data-element="0"] circle').last();
  const box = (await dot.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(await elements(page)).toEqual([
    { type: 'BALL', select: true },
    { type: 'CAPSULE', select: false },
  ]);
  await page.keyboard.press('x');
  expect(await elements(page)).toEqual([{ type: 'CAPSULE', select: false }]);

  // the Object Data tab drives the polygonization resolution
  await page.evaluate(() => {
    (window as any).__propertiesTab = 'DATA'; // eslint-disable-line @typescript-eslint/no-explicit-any
    (window as any).app.changed('ui'); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
  const panel = page.locator('.panel').filter({ hasText: 'Influence Threshold' });
  await expect(panel).toBeVisible();
  const coarse = await faces(page);
  await page.evaluate(() => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.doc.metaballs[a.activeObject.data].resolution = 0.2;
    a.changed('doc');
  });
  expect(await faces(page)).toBeGreaterThan(coarse * 2);

  // undo brings the ball back
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  expect((await elements(page)).length).toBe(2);
  await expectNoErrors(errors);
});
