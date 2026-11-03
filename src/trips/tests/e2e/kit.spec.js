import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test, expect } from '@playwright/test';
const require = createRequire(import.meta.url);
const axe = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
async function audit(page) {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((animation) => animation.effect.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
  });
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ content: axe });
  const violations = await page.evaluate(async () => (await window.axe.run()).violations);
  expect(violations).toEqual([]);
}
async function capture(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}
test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => { throw error; });
  await page.goto('/dev/kit.html');
  await expect(page.locator('html')).toHaveAttribute('data-kit', 'ready');
});
test('kit renders each component without overflow and passes axe', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const background = testInfo.project.use.colorScheme === 'dark' ? 'rgb(11, 11, 13)' : 'rgb(241, 241, 238)';
  await expect(page.locator('html')).toHaveCSS('background-color', background);
  await expect(page.getByRole('heading', { name: 'Trips UI kit' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await audit(page); await capture(page, testInfo, 'kit'); expect(errors).toEqual([]);
  await expect(page.locator('.markdown img,.markdown script')).toHaveCount(0);
  await expect(page.locator('.markdown a')).toHaveCount(1);
  const virtual = page.getByRole('list', { name: 'Virtual list' });
  await virtual.focus(); await page.keyboard.press('End'); await expect(virtual).toContainText('Saved place 1,000');
  expect(await virtual.getByRole('listitem').count()).toBeLessThan(20);
});
test('modal, nested dialog, sheet and drawer trap and return focus', async ({ page }, testInfo) => {
  const opener = page.getByRole('button', { name: 'Open dialog', exact: true }); await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Plan a stop', exact: true });
  await expect(dialog).toBeVisible(); await expect(page.locator('main')).toHaveJSProperty('inert', true);
  await dialog.getByRole('button', { name: 'Save', exact: true }).focus(); await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
  await audit(page); await capture(page, testInfo, 'dialog');
  await dialog.getByRole('button', { name: 'Show toast' }).click();
  const undo = dialog.getByRole('button', { name: 'Undo', exact: true });
  await undo.focus(); await expect(undo).toBeFocused();
  await expect(dialog.getByRole('status')).toContainText('Changes saved.');
  await audit(page);
  const nestedOpener = dialog.getByRole('button', { name: 'Open nested dialog' }); await nestedOpener.click();
  const nested = page.getByRole('dialog', { name: 'Stop details' }); await expect(nested).toBeVisible();
  await expect(dialog.locator('..')).toHaveJSProperty('inert', true);
  await expect(nested.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(nested).toHaveCount(0); await expect(nestedOpener).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.locator('.toast-dismiss').click();
  for (const name of ['Open sheet', 'Open drawer']) {
    const trigger = page.getByRole('button', { name, exact: true }); await trigger.click();
    const overlay = page.getByRole('dialog', { name: 'Plan a stop', exact: true }); await expect(overlay).toBeVisible();
    await audit(page); await overlay.getByRole('button', { name: 'Close', exact: true }).click(); await expect(trigger).toBeFocused();
  }
  await expect(page.locator('main')).toHaveJSProperty('inert', false);
});
test('menu keys, checkbox actions, tabs, toasts and theme control work', async ({ page }) => {
  const menuButton = page.getByRole('button', { name: 'Actions', exact: true }); await menuButton.click();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('End'); await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeFocused();
  await page.keyboard.press('Home'); await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await page.keyboard.press('f'); await expect(page.getByRole('menuitemcheckbox', { name: 'Favorite' })).toBeFocused();
  await audit(page); await page.keyboard.press('Enter'); await expect(menuButton).toBeFocused();
  await menuButton.click(); await expect(page.getByRole('menuitemcheckbox', { name: 'Favorite' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Tab'); await expect(page.getByRole('menu')).toHaveCount(0);
  const plan = page.getByRole('tab', { name: 'Plan', exact: true }); await plan.focus(); await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Costs' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Costs' })).toBeVisible();
  await page.getByRole('button', { name: 'Show toast' }).click(); await expect(page.locator('.toast')).toContainText('Changes saved.');
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(page.locator('.toast')).toContainText('Change undone.');
  await page.getByRole('button', { name: 'Dark', exact: true }).click(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload(); await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Light', exact: true }).click(); await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  await page.getByRole('button', { name: 'System', exact: true }).click(); await expect(page.locator('html')).not.toHaveAttribute('data-theme');
});
test('calendar keyboard selection and Alt+Arrow sorting work', async ({ page }) => {
  const start = page.getByLabel('Start date', { exact: true }); await start.fill('2026-12-31'); await start.dispatchEvent('change');
  const end = page.getByLabel('End date', { exact: true }); await end.fill('2027-01-02'); await end.dispatchEvent('change');
  await end.fill('2026-12-30'); await end.dispatchEvent('change'); await expect(end).toHaveAttribute('aria-invalid', 'true');
  await end.fill(''); await end.dispatchEvent('change');
  const day = page.locator('[data-date="2026-12-31"]'); await day.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-date="2027-01-01"]')).toBeFocused(); await page.keyboard.press('Enter'); await expect(end).toHaveValue('2027-01-01');
  const handle = page.getByRole('button', { name: 'Reorder Harbor walk', exact: true }); await handle.focus(); await page.keyboard.press('Alt+ArrowDown');
  await expect(handle).toBeFocused(); await expect(page.locator('#sortable-demo [data-sortable-item]').first()).toHaveAttribute('data-label', 'Market lunch');
  await expect(page.locator('#sortable-demo [role=status]')).toContainText('position 2 of 3');
});
test('pointer sorting commits and Escape cancels', async ({ page }) => {
  const handle = page.getByRole('button', { name: 'Reorder Harbor walk', exact: true }); await handle.scrollIntoViewIfNeeded(); await handle.focus();
  const from = await handle.boundingBox(); const target = await page.locator('[data-sortable-item="museum"]').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 8);
  await page.mouse.move(target.x + target.width / 2, target.y + target.height - 4); await page.mouse.up();
  await expect(page.locator('#sortable-demo [data-sortable-item]').last()).toHaveAttribute('data-label', 'Harbor walk');
  await expect(page.locator('.drag-ghost,.card-placeholder')).toHaveCount(0);
  const next = await handle.boundingBox(); await page.mouse.move(next.x + 15, next.y + 15); await page.mouse.down(); await page.mouse.move(next.x + 25, next.y - 15);
  await page.keyboard.press('Escape'); await page.mouse.up(); await expect(page.locator('.drag-ghost,.card-placeholder')).toHaveCount(0);
  await expect(page.locator('#sortable-demo [data-sortable-item]').last()).toHaveAttribute('data-label', 'Harbor walk');
});
test('touch grips reorder stops on phones', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.isMobile, 'Touch input is exercised in phone projects.');
  const handle = page.getByRole('button', { name: 'Reorder Harbor walk', exact: true }); await handle.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox(); const target = await page.locator('[data-sortable-item="museum"]').boundingBox();
  const session = await page.context().newCDPSession(page);
  const point = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x + 8, y: point.y + 8 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: target.x + target.width / 2, y: target.y + target.height - 4 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('#sortable-demo [data-sortable-item]').last()).toHaveAttribute('data-label', 'Harbor walk');
  await expect(page.locator('.drag-ghost,.card-placeholder')).toHaveCount(0); await session.detach();
});
test('reduced motion and blocked storage keep controls usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }));
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-kit', 'ready');
  await page.getByRole('button', { name: 'Dark', exact: true }).click(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const cards = page.getByRole('radiogroup', { name: 'Transport' });
  await cards.getByRole('radio', { name: 'Train', exact: true }).focus(); await page.keyboard.press('ArrowDown');
  await expect(cards.getByRole('radio', { name: 'Walk', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Open dialog', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCSS('animation-duration', '1e-05s');
  await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Open dialog', exact: true })).toBeFocused();
});
