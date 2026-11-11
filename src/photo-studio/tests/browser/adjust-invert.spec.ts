// Image → Adjustments → Invert used to return before its worker had finished,
// so the editor was not busy while it ran: a second Invert (Mod+I pressed
// twice, or an action playing Invert twice) read the same original pixels and
// the image ended up inverted instead of restored, and the next step of an
// action ran before the inversion landed.
import { expect, test } from '@playwright/test';
import { boot, compositePixel, idle, openImage } from './helpers';

test('Invert finishes before the command returns, so two in a row restore the image', async ({ page }) => {
  await boot(page);
  await openImage(page, 32, 24, '#2060a0', 'invert.png');
  const result = await page.evaluate(async () => {
    const e = window.photoStudio;
    await e.runCommand('adjust.invert');
    const afterFirst = e.history.labels.slice(-1)[0];
    await e.runCommand('adjust.invert');
    return { afterFirst, labels: e.history.labels.slice(-2) };
  });
  await idle(page);
  expect(result.afterFirst).toBe('Invert');
  expect(result.labels).toEqual(['Invert', 'Invert']);
  expect(await compositePixel(page, 5, 5)).toEqual([0x20, 0x60, 0xa0, 255]);
});
