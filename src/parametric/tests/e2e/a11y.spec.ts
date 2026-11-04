import { expect, test, type Page } from '@playwright/test';
import { openApp, waitForFeature } from './helpers';

async function seriousViolations(page: Page) {
  // Playwright resolves the path from the project directory.
  await page.addScriptTag({ path: 'node_modules/axe-core/axe.min.js' });
  const result = await page.evaluate(async () => {
    // @ts-expect-error axe is injected above
    const r = await window.axe.run(document, { resultTypes: ['violations'] });
    return r.violations
      .filter((v: { impact: string }) => v.impact === 'serious' || v.impact === 'critical')
      .map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  });
  return result as string[];
}

test.describe('accessibility', () => {
  test('start screen has no serious violations', async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole('dialog', { name: 'Parametric' })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('modeling workspace has no serious violations', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('menus are reachable from the keyboard', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.getByRole('menuitem', { name: 'File' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menu', { name: 'File' })).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menu', { name: 'Edit' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('the design tree keeps keyboard focus and a rename survives hovering the model', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    const hole = page.getByRole('treeitem', { name: 'Hole1' });
    await hole.focus();
    // Space selects without opening the view orientation menu and keeps focus in the tree.
    await page.keyboard.press('Space');
    await expect(hole).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(hole).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('treeitem', { name: 'Fillet1' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    // Enter opens the feature for editing and leaves it open.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Hole1' })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByRole('heading', { name: 'Hole1' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
    await page.getByRole('tab', { name: 'Design tree' }).click();
    await hole.focus();
    await page.keyboard.press('F2');
    const input = page.getByRole('textbox', { name: 'Feature name' });
    await expect(input).toBeFocused();
    await page.keyboard.type('Bolt holes');
    const box = (await page.locator('canvas.gl').boundingBox())!;
    for (let i = 0; i < 8; i++) await page.mouse.move(box.x + box.width * (0.3 + i * 0.05), box.y + box.height * (0.4 + i * 0.03));
    await page.waitForTimeout(300);
    await expect(input).toHaveValue('Bolt holes');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('treeitem', { name: 'Bolt holes' })).toBeFocused();
  });

  test('Enter and Space activate the focused button instead of global shortcuts', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    // Something to repeat with Enter (Repeat Last Command).
    await page.getByRole('button', { name: 'Zoom to Fit' }).click();
    const perspective = page.getByRole('button', { name: 'Perspective' });
    await perspective.focus();
    await page.keyboard.press('Enter');
    await expect(perspective).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Section View' }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('heading', { name: 'Section View' })).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(0);
  });
});

