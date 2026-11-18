import { test, expect } from '@playwright/test';
import { boot, idle, openImage } from './helpers';

// Lasso gestures keep every pointer sample; a long one has more samples than
// a function call can take as arguments.
test('a very long Object Selection lasso is measured without overflowing', async ({ page }) => {
  await boot(page);
  await openImage(page, 200, 120, '#808080', 'gray.png');
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.settings.objectMode = 'lasso';
    e.setTool('object-selection');
  });
  // The tool loads on first use.
  await expect(page.locator('#object-mode')).toBeVisible();
  const message = await page.evaluate(async () => {
    const e = window.photoStudio;
    const { canvasPoint } = await import('/src/app/pointer.ts');
    const at = (x: number, y: number) => {
      const [cx, cy] = e.clientPoint(x, y);
      return canvasPoint(e, new PointerEvent('pointermove', { clientX: cx, clientY: cy }));
    };
    const t = e.activeTool!;
    await t.pointerDown!(e, at(100, 60));
    // 200 000 samples that circle within two pixels: too small to be a loop.
    const p = at(101, 61);
    p.coalesced = Array.from({ length: 200_000 }, (_, i) => ({ ...p, x: 100 + (i % 2), y: 60 + ((i >> 1) % 2) }));
    t.pointerMove!(e, p);
    try {
      await t.pointerUp!(e, at(100, 60));
    } catch (error) {
      return String(error);
    }
    return document.querySelector('#status')?.textContent;
  });
  await idle(page);
  expect(message).toBe('Draw a loop around an object.');
});
