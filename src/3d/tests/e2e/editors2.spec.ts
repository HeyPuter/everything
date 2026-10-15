import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const win = (page: Page) => page.evaluate.bind(page);

async function setAreaType(page: Page, from: string, to: string, maximize = false) {
  await page.evaluate(
    async ([f, t, m]) => {
      const { shell } = await import('/src/ui/shell.ts');
      const a = shell.screen.areas.find((x: { type: string }) => x.type === f) ?? shell.screen.areas[shell.screen.areas.length - 1];
      a.setType(t);
      if (m) shell.screen.toggleMaximize(a);
    },
    [from, to, maximize] as const,
  );
  await page.waitForTimeout(150);
}

test('Ctrl D adds a driver and edits it in a popover; #expression drives a field', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.rail-tab[data-tab="OBJECT"]').first().click();
  const fields = page.locator('.properties .num-field');
  await fields.nth(0).hover();
  await page.keyboard.press('Control+d');
  const pop = page.locator('.drv-popover');
  await expect(pop).toBeVisible();
  await expect(pop).toContainText('X Location');
  const expr = pop.locator('.drv-expr input');
  await expr.fill('frame * 2');
  await expr.press('Enter');
  await win(page)(() => (window as any).app.setFrame(12));
  await expect.poll(() => win(page)(() => (window as any).app.activeObject.location[0])).toBe(24);
  await expect(fields.nth(0)).toHaveClass(/anim-driven/);
  // the popover can open the Drivers editor focused on the driver
  await pop.locator('button', { hasText: 'Show in Drivers Editor' }).click();
  await expect(page.locator('.area[data-editor="DRIVERS"]')).toHaveCount(1);
  await expect(page.locator('.area[data-editor="DRIVERS"] .anim-ch-row.k-driver')).toContainText('X Location');
  await page.mouse.move(5, 300);
  // "#expr" typed into a field makes a scripted driver
  await page.evaluate(async () => {
    const { shell } = await import('/src/ui/shell.ts');
    shell.screen.close(shell.screen.findArea('DRIVERS'));
  });
  await fields.nth(1).dblclick();
  await page.keyboard.press('End');
  for (let i = 0; i < 8; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('#frame/4');
  await page.keyboard.press('Enter');
  await expect.poll(() => win(page)(() => (window as any).app.activeObject.location[1])).toBe(3);
  const exprs = await win(page)(() => (window as any).app.activeObject.animation_data.drivers.map((d: any) => d.expression));
  expect(exprs).toEqual(['frame * 2', 'frame/4']);
  await expectNoErrors(errors);
});

test('Drivers editor: variables, targets, keys on the driver curve and modifiers', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() => {
    const app = (window as any).app;
    app.run('anim.driver_button_add', { object: app.activeObject.id, data_path: 'location', index: 2 }, { invoke: false });
  });
  await setAreaType(page, 'TIMELINE', 'DRIVERS', true);
  const area = page.locator('.area[data-editor="DRIVERS"]');
  await expect(area.locator('.anim-drv-prop')).toContainText('Z Location');
  // the new driver reads nothing yet
  await expect(area.locator('.anim-drv-error')).toContainText('no data-block');
  // switch the variable to a Transform Channel of the camera
  await area.locator('.drv-vtype').first().dispatchEvent('pointerdown');
  await page.locator('.menu-item', { hasText: 'Transform Channel' }).click();
  await expect(area.locator('.anim-drv-var').first()).toContainText('Space');
  await area.locator('.drv-id').first().dispatchEvent('pointerdown');
  await page.locator('.menu-item', { hasText: 'Camera' }).click();
  await expect(area.locator('.anim-drv-error')).toHaveCount(0);
  const camX = await win(page)(() => Object.values((window as any).app.doc.objects).find((o: any) => o.type === 'CAMERA').location[0]);
  await expect.poll(() => win(page)(() => (window as any).app.activeObject.location[2])).toBeCloseTo(camX as number, 4);
  // scripted expression with two variables
  await area.locator('button', { hasText: 'Add Input Variable' }).click();
  await expect(area.locator('.anim-drv-var')).toHaveCount(2);
  await area.locator('.drv-id').nth(1).dispatchEvent('pointerdown');
  await page.locator('.menu-item', { hasText: 'Cube' }).click();
  const path = area.locator('.anim-drv-var').nth(1).locator('.text-field input').nth(1);
  await path.fill('scale[0]');
  await path.press('Enter');
  const expr = area.locator('.drv-expr input');
  await expr.fill('var + var_001 * 10');
  await expr.press('Enter');
  await expect.poll(() => win(page)(() => (window as any).app.activeObject.location[2])).toBeCloseTo((camX as number) + 10, 4);
  // invalid expressions show an error and leave the value alone
  await expr.fill('var +');
  await expr.press('Enter');
  await expect(area.locator('.anim-drv-error')).toContainText('SyntaxError');
  await expr.fill('var');
  await expr.press('Enter');
  // insert a key on the driver curve at the current driver value: the default Generator goes away
  const box = (await area.locator('canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('i');
  await page.locator('.menu-item').first().click();
  const fc = await win(page)(() => (window as any).app.activeObject.animation_data.drivers[0].fcurve);
  expect(fc.keyframe_points.length).toBe(1);
  expect(fc.keyframe_points[0].co[0]).toBeCloseTo(camX as number, 4);
  expect(fc.modifiers.length).toBe(0);
  // modifiers tab works on the driver curve
  await area.locator('.sb-tab', { hasText: 'Modifiers' }).click();
  await area.locator('button', { hasText: 'Add Modifier' }).click();
  await page.locator('.menu-item', { hasText: 'Generator' }).click();
  await expect.poll(() => win(page)(() => (window as any).app.activeObject.animation_data.drivers[0].fcurve.modifiers.map((m: any) => m.type))).toEqual(['GENERATOR']);
  // copy / paste variables between drivers through the Channel menu
  await area.locator('.sb-tab', { hasText: 'Drivers' }).click();
  await area.locator('.drv-icon-btn').first().click();
  await page.evaluate(() => {
    const app = (window as any).app;
    app.run('anim.driver_button_add', { object: app.activeObject.id, data_path: 'scale', index: 1 }, { invoke: false });
    app.run('graph.driver_variables_paste', { object: app.activeObject.id, data_path: 'scale', index: 1, replace: true });
  });
  const names = await win(page)(() => (window as any).app.activeObject.animation_data.drivers[1].variables.map((v: any) => v.name));
  expect(names).toEqual(['var', 'var_001']);
  await expectNoErrors(errors);
});

test('Copy as New Driver and Paste Driver from the property menu', async ({ page }) => {
  const errors = await openApp(page);
  await page.locator('.rail-tab[data-tab="OBJECT"]').first().click();
  const fields = page.locator('.properties .num-field');
  await page.evaluate(() => ((window as any).app.activeObject.location[0] = 1.5));
  await page.evaluate(() => (window as any).app.changed('doc'));
  await fields.nth(0).click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Copy as New Driver' }).click();
  await fields.nth(6).click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Paste Driver' }).click();
  await expect.poll(() => win(page)(() => (window as any).app.activeObject.scale[0])).toBe(1.5);
  await expectNoErrors(errors);
});
