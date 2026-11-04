import { expect, test } from '@playwright/test';
import { canvasCenter, openApp } from './helpers';

test.describe('viewport', () => {
  test('sketch dimension labels follow the camera when zooming', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.getByRole('treeitem', { name: 'Front Plane' }).click();
    await page.getByRole('tab', { name: 'Sketch' }).click();
    await page.locator('[data-cmd="sketch"]').first().click();
    await expect(page.locator('.statusbar')).toContainText('Defined');
    await page.waitForTimeout(400); // normal-to animation
    const { x, y } = await canvasCenter(page);
    await page.locator('[data-cmd="tool:rectangle"]').click();
    await page.mouse.click(x, y);
    await page.mouse.click(x + 160, y - 90);
    await page.keyboard.press('Escape');
    await expect(page.locator('.rel-badge').first()).toBeVisible();
    await page.keyboard.press('d');
    await page.mouse.click(x + 80, y);
    await page.mouse.click(x + 80, y + 40);
    const modify = page.getByRole('dialog', { name: /Modify/ });
    await modify.getByRole('textbox').fill('50');
    await modify.getByRole('textbox').press('Enter');
    const label = page.locator('.dim-label', { hasText: '50.00' });
    await expect(label).toBeVisible();
    const centre = async () => { const b = (await label.boundingBox())!; return [b.x + b.width / 2, b.y + b.height / 2]; };
    const [lx, ly] = await centre();
    // Zoom in about a fixed cursor without moving the mouse afterwards: the
    // label keeps its place on the sketch, so its offset from the cursor grows.
    const cx = x - 120, cy = y - 120;
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -200);
    const k = Math.exp(200 * 0.0018);
    await expect.poll(async () => { const [ax, ay] = await centre(); return Math.hypot(ax - (cx + (lx - cx) * k), ay - (cy + (ly - cy) * k)); }).toBeLessThan(3);
    expect(errors).toEqual([]);
  });
});
