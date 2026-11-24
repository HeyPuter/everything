import { expect, test } from '@playwright/test';
import { openApp, waitForFeature } from './helpers';

type Handle = { __parametric: import('../../src/app/app').App };

test('Edit › Suppress with a face selected suppresses the feature that made it', async ({
  page,
}) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Handle).__parametric.faces.length))
    .toBeGreaterThan(0);
  const owner = await page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    const face = a.faces[0];
    a.selection.set([{ kind: 'face', index: 0, name: face.name }]);
    return a.store.feature(face.feature)!.name;
  });
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Edit' }).click();
  await page.getByRole('menuitem', { name: 'Suppress', exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as unknown as Handle).__parametric.store.doc.features
        .filter((f) => f.suppressed)
        .map((f) => f.name),
    ),
  ).toEqual([owner]);
  expect(errors).toEqual([]);
});

test('Rename from the context menu of the flyout tree renames there while a panel is open', async ({
  page,
}) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('button', { name: 'Fillet', exact: true }).click();
  await page.locator('.flyout-tree > button').click();
  const flyout = page.getByRole('tree', { name: 'Design tree (flyout)' });
  await flyout.getByRole('treeitem', { name: 'Fillet1' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await expect(flyout.getByRole('textbox', { name: 'Feature name' })).toBeFocused();
  await page.keyboard.type('Round');
  await page.keyboard.press('Enter');
  await expect(flyout.getByRole('treeitem', { name: 'Round' })).toBeVisible();
  // The design tree under the panel has no rename of its own left open.
  await page.keyboard.press('Escape');
  await expect(
    page
      .getByRole('tree', { name: 'Design tree', exact: true })
      .getByRole('treeitem', { name: 'Round' }),
  ).toBeVisible();
  await expect(page.locator('input.rename')).toHaveCount(0);
  expect(errors).toEqual([]);
});
