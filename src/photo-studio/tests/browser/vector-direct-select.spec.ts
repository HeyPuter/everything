import { expect, test } from '@playwright/test';
import { boot, canvasClick, canvasDrag, openImage, tool } from './helpers';

// Direct Selection grabs only the handles it shows.
test('an open path’s first handle cannot be dragged while only its last anchor is selected', async ({
  page,
}) => {
  await boot(page);
  await openImage(page, 300, 200, '#ffffff');
  await page.evaluate(() => {
    const e = window.photoStudio;
    e.command('Work Path', (d) => {
      d.workPath = {
        paths: [
          {
            open: true,
            fillRule: 'non-zero',
            operation: 'combine',
            knots: [
              { linked: false, points: [50, 50, 50, 50, 100, 150] },
              { linked: false, points: [200, 50, 200, 50, 200, 50] },
              { linked: false, points: [250, 150, 250, 150, 250, 150] },
            ],
          },
        ],
      };
    });
  });
  await tool(page, 'Direct Selection Tool');
  await page.evaluate(async () => {
    const { setActive } = await import('/src/features/vector/state.ts');
    setActive(window.photoStudio, 'work');
    window.photoStudio.update();
  });
  // Select the last anchor: its handles and its one neighbour's show, not the first anchor's.
  await canvasClick(page, 250, 150);
  await canvasDrag(page, [
    [100, 150],
    [100, 185],
  ]);
  const first = await page.evaluate(
    () => window.photoStudio.doc.workPath!.paths[0].knots[0].points,
  );
  expect(first).toEqual([50, 50, 50, 50, 100, 150]);
});
