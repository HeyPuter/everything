import { expect, test } from '@playwright/test';
import { boot, compositePixel, idle, openImage, run } from './helpers';

// A vector mask covers layer content past the canvas edge, so moving that
// content onto the canvas shows it.
test('a vector mask reaching past the canvas reveals content moved in from there', async ({
  page,
}) => {
  await boot(page);
  await openImage(page, 300, 200, '#ff0000');
  // The layer's content now starts 100 px left of the canvas.
  await page.evaluate(() => window.photoStudio.transform.nudge(-100, 0));
  await idle(page);
  await page.evaluate(() => {
    const e = window.photoStudio;
    const k = (x: number, y: number) => ({ linked: false, points: [x, y, x, y, x, y] });
    e.command('Work Path', (d) => {
      d.workPath = {
        paths: [
          {
            open: false,
            fillRule: 'non-zero',
            operation: 'combine',
            knots: [k(-100, 50), k(200, 50), k(200, 150), k(-100, 150)],
          },
        ],
      };
    });
  });
  await run(page, 'layer.vmask-current-path');
  expect(await page.evaluate(() => !!window.photoStudio.layer?.vectorMask)).toBe(true);
  await page.evaluate(() => window.photoStudio.transform.nudge(100, 0));
  await idle(page);
  expect((await compositePixel(page, 20, 100))[3]).toBe(255);
  expect((await compositePixel(page, 150, 100))[3]).toBe(255);
  expect((await compositePixel(page, 150, 20))[3]).toBe(0);
});
