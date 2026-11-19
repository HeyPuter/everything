import { test, expect } from '@playwright/test';
import { boot, openImage } from './helpers';

// At 1280×720 the options bar of everyday tools fits without hiding controls
// past its end; the Assisted/Pro switch lives in the top bar, not here.

test.use({ viewport: { width: 1280, height: 720 } });

const overflow = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('#tool-options')!;
    return bar.scrollWidth - bar.clientWidth;
  });

test('everyday tool options fit at 1280 px and the mode switch sits in the top bar', async ({
  page,
}) => {
  await boot(page);
  await openImage(page, 300, 200, '#808080');
  await expect(
    page.locator('.topbar').getByRole('radiogroup', { name: 'Editor mode' }),
  ).toBeVisible();
  await expect(
    page.locator('.optionsbar').getByRole('radiogroup', { name: 'Editor mode' }),
  ).toHaveCount(0);
  const ids = [
    'move',
    'rect-marquee',
    'brush',
    'eraser',
    'history-brush',
    'sharpen-tool',
    'smudge-tool',
    'background-eraser',
    'color-replacement',
    'gradient',
    'type',
    'pen',
    'rect-shape',
    'line-shape',
    'crop',
  ];
  for (const id of ids) {
    await page.evaluate((id) => window.photoStudio.setTool(id), id);
    expect(await overflow(page), id).toBeLessThanOrEqual(0);
  }
  // Crop with a target size and resolution is the widest crop bar.
  await page.locator('#crop-preset').selectOption('whr');
  expect(await overflow(page), 'crop W x H x Resolution').toBeLessThanOrEqual(0);
  await expect(page.getByRole('button', { name: 'Commit crop', exact: true })).toBeInViewport();
});
