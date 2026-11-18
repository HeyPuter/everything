// The History panel tells screen readers which state is current and which
// steps are undone, as it shows them by highlight and dimming.
import { expect, test } from '@playwright/test';
import { boot, openImage, panel, run, undo } from './helpers';

test('the current history state and undone steps are announced', async ({ page }) => {
  await boot(page);
  await openImage(page, 40, 30, '#808080', 'h.png');
  await run(page, 'adjust.invert');
  await run(page, 'image.flip-horizontal');
  const history = await panel(page, 'History');
  const current = history.locator('[aria-current="step"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAccessibleName('Flip Canvas Horizontal');
  await undo(page);
  await expect(current).toHaveAccessibleName('Invert');
  await expect(
    history.getByRole('button', { name: 'Flip Canvas Horizontal (undone)' }),
  ).toBeVisible();
  await undo(page);
  await expect(current).toHaveAccessibleName('h');
});
