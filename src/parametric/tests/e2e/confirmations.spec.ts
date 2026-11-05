import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

type Handle = { __parametric: import('../../src/app/app').App };

for (const timing of ['while open', 'on Delete'] as const) test(`Delete confirmation cannot affect a part replaced ${timing}`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    void a.deleteFeatures([a.store.doc.features.find((f) => f.type === 'extrude')!.id]);
  });
  const dialog = page.getByRole('dialog', { name: 'Delete', exact: true });
  await expect(dialog).toBeVisible();
  const expected = await page.evaluate((timing) => {
    const a = (window as unknown as Handle).__parametric;
    const replacement = structuredClone(a.store.doc);
    replacement.name = 'Replacement';
    if (timing === 'on Delete') [...document.querySelectorAll<HTMLButtonElement>('.dialog-foot button')].find((b) => b.textContent === 'Delete')!.click();
    a.loadDocument(replacement, null);
    return replacement.features.map((f) => f.id);
  }, timing);
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  expect(await page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    return { features: a.store.doc.features.map((f) => f.id), dirty: a.store.dirty };
  })).toEqual({ features: expected, dirty: false });
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

