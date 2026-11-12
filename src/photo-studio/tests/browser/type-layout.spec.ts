import { expect, test } from '@playwright/test';
import { boot } from './helpers';

// Layouts the type tools reuse while hovering and hit testing.
test('layouts of several text layers stay cached until fonts change', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const { layoutOf } = await import('/src/features/type/text-utils.ts');
    const { textLayer } = await import('/src/imaging/text/model.ts');
    const { invalidateMeasurements } = await import('/src/imaging/text/layout.ts');
    const a = textLayer('first layer'), b = textLayer('second layer'), c = textLayer('third layer');
    const la = layoutOf(a, 72);
    layoutOf(b, 72);
    layoutOf(c, 72);
    // Hovering over many text layers alternates between them.
    const reused = layoutOf(a, 72) === la;
    const otherPpi = layoutOf(a, 300) !== la;
    const l300 = layoutOf(a, 300);
    invalidateMeasurements();
    const fresh = layoutOf(a, 300) !== l300;
    return { reused, otherPpi, fresh };
  });
  expect(r).toEqual({ reused: true, otherPpi: true, fresh: true });
});
