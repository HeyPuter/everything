import { expect, test } from '@playwright/test';
import { boot, canvasClick, canvasDrag, idle, openImage, run, tool } from './helpers';

// Arrow-key nudges of paths with the path selection tools.
test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 1200, 900, '#3080ff');
});

test('fast arrow presses all nudge a vector mask path', async ({ page }) => {
  await run(page, 'layer.new-quick');
  await run(page, 'layer.vmask-reveal-all');
  await tool(page, 'Rectangle Tool');
  await page.selectOption('#vec-mode', 'path');
  await canvasDrag(page, [[200, 200], [600, 500]]);
  const left = () => page.evaluate(() => window.photoStudio.layer?.vectorMask?.mask.paths[0]?.knots[0].points[2]);
  expect(await left()).toBe(200);
  await tool(page, 'Path Selection Tool');
  // On the left edge, away from its middle.
  await canvasClick(page, 200, 280);
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(left).toBe(210);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.layer?.vectorMask?.mask.paths[0]?.knots[0].points[3])).toBe(210);
  expect((await page.evaluate(() => window.photoStudio.history.labels)).filter((l) => l === 'Nudge Path')).toHaveLength(11);
});

test('shape tools in Path mode leave a locked layer\'s vector mask alone', async ({ page }) => {
  await run(page, 'layer.new-quick');
  await run(page, 'layer.vmask-reveal-all');
  await page.evaluate(() => window.photoStudio.command('Lock', (d) => void (d.layers.at(-1)!.locked = true)));
  await idle(page);
  await tool(page, 'Rectangle Tool');
  await page.selectOption('#vec-mode', 'path');
  const labels = await page.evaluate(() => window.photoStudio.history.labels.length);
  await canvasDrag(page, [[200, 200], [600, 500]]);
  expect(await page.evaluate(() => window.photoStudio.layer?.vectorMask?.mask.paths.length)).toBe(0);
  expect(await page.evaluate(() => window.photoStudio.history.labels.length)).toBe(labels);
});
