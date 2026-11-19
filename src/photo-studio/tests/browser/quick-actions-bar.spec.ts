import { test, expect, type Page } from '@playwright/test';
import { boot, canvasDrag, idle, openImage, run, tool } from './helpers';

// Quick Actions Bar: contents per situation, menus, keyboard, dragging and pinning.

const bar = (page: Page) => page.getByRole('toolbar', { name: 'Quick actions bar' });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem('photo-studio-taskbar');
    localStorage.removeItem('photo-studio-taskbar-place');
  });
  await boot(page);
  await openImage(page, 400, 300, '#808080');
});

test('shows layer actions, then selection actions with a Modify menu', async ({ page }) => {
  await expect(bar(page)).toHaveAttribute('data-state', 'pixel');
  await expect(bar(page).getByRole('button', { name: 'Remove Background' })).toBeVisible();
  await run(page, 'select.all');
  await expect(bar(page)).toHaveAttribute('data-state', 'selection');
  await bar(page).getByRole('button', { name: 'Modify' }).click();
  const menu = page.getByRole('menu', { name: 'Modify' });
  await expect(menu.getByRole('menuitem', { name: 'Feather…' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Transform Selection' }).click();
  await expect(menu).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => !!window.photoStudio.modal)).toBe(true);
  // The bar steps aside during the transform.
  await expect(bar(page)).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(bar(page)).toBeVisible();
  await bar(page).getByRole('button', { name: 'Deselect' }).click();
  await idle(page);
  await expect(bar(page)).toHaveAttribute('data-state', 'pixel');
});

test('follows the layer kind: mask target, group and several layers', async ({ page }) => {
  await run(page, 'layer.mask-reveal-all');
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.maskTarget = e.selected;
    e.update();
  });
  await expect(bar(page)).toHaveAttribute('data-state', 'mask');
  await bar(page).getByRole('button', { name: 'Disable' }).click();
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.layer?.maskDisabled)).toBe(true);
  await expect(bar(page).getByRole('button', { name: 'Enable' })).toBeVisible();
  await page.evaluate(() => window.photoStudio.selectLayer(window.photoStudio.selected));
  await run(page, 'layer.new-quick');
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.selectLayers(e.doc.layers.map((l) => l.id));
    e.update();
  });
  await expect(bar(page)).toHaveAttribute('data-state', 'multiple');
  await bar(page).getByRole('button', { name: 'Group' }).click();
  await idle(page);
  await expect(bar(page)).toHaveAttribute('data-state', 'group');
  await expect(bar(page).getByRole('button', { name: 'Ungroup' })).toBeEnabled();
});

test('hides while the crop tool shows its own controls', async ({ page }) => {
  await expect(bar(page)).toBeVisible();
  await tool(page, 'Crop Tool');
  await expect(bar(page)).toBeHidden();
  await tool(page, 'Move Tool');
  await expect(bar(page)).toBeVisible();
});

test('is one tab stop with arrow-key navigation', async ({ page }) => {
  await run(page, 'select.all');
  const first = bar(page).getByRole('button', { name: 'AI Fill' });
  await expect(first).toHaveAttribute('tabindex', '0');
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect(bar(page).getByRole('button', { name: 'Context Fill' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(
    bar(page).getByRole('button', { name: 'More quick actions and bar options' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  const more = page.getByRole('menu', { name: 'More quick actions' });
  await expect(more.getByRole('menuitem', { name: 'Fill…', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(more).toHaveCount(0);
  await expect(
    bar(page).getByRole('button', { name: 'More quick actions and bar options' }),
  ).toBeFocused();
  // Arrows on the bar never nudge the layer.
  expect(await page.evaluate(() => window.photoStudio.layer?.transform.x)).toBe(0);
});

test('drags by its grip, stays pinned, and resets', async ({ page }) => {
  const grip = bar(page).getByRole('button', { name: 'Move the quick actions bar' });
  const before = (await bar(page).boundingBox())!;
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x - 100, g.y - 200, { steps: 5 });
  await page.mouse.up();
  const after = (await bar(page).boundingBox())!;
  expect(Math.round(after.y)).toBeLessThan(before.y - 150);
  expect(await page.evaluate(() => localStorage.getItem('photo-studio-taskbar-place'))).toContain(
    'fx',
  );
  // A selection no longer moves it.
  await run(page, 'select.all');
  expect(Math.abs((await bar(page).boundingBox())!.y - after.y)).toBeLessThan(2);
  // Arrow keys on the grip move it too.
  await grip.focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => Math.round((await bar(page).boundingBox())!.y - after.y)).toBe(10);
  await bar(page).getByRole('button', { name: 'More quick actions and bar options' }).click();
  const more = page.getByRole('menu', { name: 'More quick actions' });
  await expect(more.getByRole('menuitemcheckbox', { name: 'Pin Bar Position' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await more.getByRole('menuitem', { name: 'Reset Bar Position' }).click();
  expect(await page.evaluate(() => localStorage.getItem('photo-studio-taskbar-place'))).toBeNull();
});

test('hides from its menu and comes back from the Window menu', async ({ page }) => {
  await bar(page).getByRole('button', { name: 'More quick actions and bar options' }).click();
  await page
    .getByRole('menu', { name: 'More quick actions' })
    .getByRole('menuitem', { name: 'Hide Bar' })
    .click();
  await expect(bar(page)).toBeHidden();
  await run(page, 'select.all');
  await expect(bar(page)).toBeHidden();
  await run(page, 'window.contextual-taskbar');
  await expect(bar(page)).toBeVisible();
  await expect(bar(page)).toHaveAttribute('data-state', 'selection');
});

test('drives a selection edit end to end from the bar', async ({ page }) => {
  await tool(page, 'Rectangular Marquee Tool');
  await canvasDrag(page, [
    [50, 50],
    [150, 120],
  ]);
  await idle(page);
  await bar(page).getByRole('button', { name: 'Copy to Layer' }).click();
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.layers.length)).toBe(2);
  // The selection stays for the next step.
  await expect(bar(page)).toHaveAttribute('data-state', 'selection');
});
