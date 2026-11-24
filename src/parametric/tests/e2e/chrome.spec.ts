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

test('OK in a feature panel keeps names and suppression changed in the flyout tree meanwhile', async ({
  page,
}) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('treeitem', { name: 'Fillet1' }).dblclick();
  await page.locator('.flyout-tree > button').click();
  const flyout = page.getByRole('tree', { name: 'Design tree (flyout)' });
  await flyout.getByRole('treeitem', { name: 'Fillet1' }).focus();
  await page.keyboard.press('F2');
  await page.keyboard.type('Round');
  await page.keyboard.press('Enter');
  await flyout.getByRole('treeitem', { name: 'Round' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Suppress' }).click();
  await page.getByRole('button', { name: 'OK', exact: true }).first().click();
  await expect(page.locator('.flyout-tree')).toBeHidden();
  expect(
    await page.evaluate(() =>
      (window as unknown as Handle).__parametric.store.doc.features
        .slice(-1)
        .map((f) => ({ name: f.name, suppressed: !!f.suppressed })),
    ),
  ).toEqual([{ name: 'Round', suppressed: true }]);
  expect(errors).toEqual([]);
});

test('deleting the feature a panel edits from the flyout tree closes the panel and keeps the model shown', async ({
  page,
}) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('treeitem', { name: 'Hole1' }).dblclick();
  await page.locator('.flyout-tree > button').click();
  await page
    .getByRole('tree', { name: 'Design tree (flyout)' })
    .getByRole('treeitem', { name: 'Hole1' })
    .focus();
  await page.keyboard.press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.flyout-tree')).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const a = (window as unknown as Handle).__parametric;
        return { panel: !!a.panel, faces: a.faces.length > 0 };
      }),
    )
    .toEqual({ panel: false, faces: true });
  expect(errors).toEqual([]);
});

test('names and messages clipped by an ellipsis show in full as a tooltip', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const long = 'A very long part name that the title bar has no room to show in full';
  await page.evaluate((long) => {
    const a = (window as unknown as Handle).__parametric;
    a.store.change('Rename', (d) => {
      d.name = long;
    });
    a.setStatus(
      `${long}, and a status message that goes on well past the width of the status bar ${long}`,
    );
  }, long);
  await expect(page.locator('.doc-title')).toHaveAttribute('title', `Rename ${long}`);
  const status = page.locator('.statusbar .msg');
  await status.hover();
  await expect(status).toHaveAttribute('title', new RegExp(`^${long}, and a status`));
  const part = page.getByRole('treeitem', { name: long }).locator('.label');
  await part.hover();
  await expect(part).toHaveAttribute('title', long);
  // A label with room for its text has no tooltip.
  const origin = page.getByRole('treeitem', { name: 'Origin' }).locator('.label');
  await origin.hover();
  await expect(origin).not.toHaveAttribute('title');
  expect(errors).toEqual([]);
});

test('Undo and Redo of a part colour recolour the model and the Appearance swatches', async ({
  page,
}) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() => (window as unknown as Handle).__parametric.openTaskPane('appearance'));
  const before = await page.evaluate(
    () => (window as unknown as Handle).__parametric.store.doc.color,
  );
  await page.getByRole('button', { name: 'Colour #c45a4a' }).click();
  const shown = () =>
    page.evaluate(() => {
      const a = (window as unknown as Handle).__parametric;
      const hex = (a.renderer.modelColor ?? [])
        .map((v) =>
          Math.round(v * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('');
      const pressed = [...document.querySelectorAll('.swatch[aria-pressed="true"]')];
      return { model: `#${hex}`, pressed: pressed.map((b) => b.getAttribute('aria-label')) };
    });
  await page.evaluate(() => (window as unknown as Handle).__parametric.commands.run('undo'));
  expect(await shown()).toEqual({
    model: before ?? '#',
    pressed: before ? [`Colour ${before}`] : [],
  });
  await page.evaluate(() => (window as unknown as Handle).__parametric.commands.run('redo'));
  expect(await shown()).toEqual({ model: '#c45a4a', pressed: ['Colour #c45a4a'] });
  expect(errors).toEqual([]);
});

test("closing a design tree row's context menu returns focus to the row after the tree was redrawn", async ({
  page,
}) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('treeitem', { name: 'Fillet1' }).focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu', { name: 'Feature menu' })).toBeVisible();
  // A rebuild finishing while the menu is open redraws the rows.
  await page.evaluate(() => (window as unknown as Handle).__parametric.renderTrees());
  await page.keyboard.press('Escape');
  await expect(page.getByRole('treeitem', { name: 'Fillet1' })).toBeFocused();
  // So does a command run from it, and the dialog it opens.
  await page.keyboard.press('Shift+F10');
  await page.evaluate(() => (window as unknown as Handle).__parametric.renderTrees());
  await page.getByRole('menuitem', { name: 'Delete' }).press('Enter');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).press('Enter');
  await expect(page.getByRole('treeitem', { name: 'Fillet1' })).toBeFocused();
  expect(errors).toEqual([]);
});

test('deleting a feature from the design tree with the keyboard moves focus to the next row', async ({
  page,
}) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('treeitem', { name: 'Hole1' }).focus();
  await page.keyboard.press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('treeitem', { name: 'Hole1' })).toHaveCount(0);
  await expect(page.getByRole('treeitem', { name: 'Fillet1' })).toBeFocused();
  // The last feature: the row before it.
  await page.keyboard.press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('treeitem', { name: 'Fillet1' })).toHaveCount(0);
  await expect(page.getByRole('treeitem', { name: 'Extrude1' })).toBeFocused();
  expect(errors).toEqual([]);
});

test('a selection box keeps taking picks after the PropertyManager is shown again', async ({
  page,
}) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Handle).__parametric.edges.length))
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Chamfer', exact: true }).first().click();
  const box = page.getByRole('group', { name: 'Items to chamfer' });
  await expect(box).toHaveClass(/active/);
  await page.getByRole('tab', { name: 'Design tree' }).click();
  await page.getByRole('tab', { name: 'PropertyManager' }).click();
  await expect(box).toHaveClass(/active/);
  // A pick in the graphics area goes to the box on screen.
  await page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    const i = a.edges.findIndex((e) => e.type === 'line');
    a.panel!.onPick({ kind: 'edge', index: i, name: a.edges[i].name }, false);
  });
  await expect(box.locator('.item')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("a value under a field's minimum says what is allowed in plain words", async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.evaluate(() =>
    (window as unknown as Handle).__parametric.store.change('Units', (d) => {
      d.units = 'IPS';
    }),
  );
  await page.getByRole('treeitem', { name: 'Fillet1' }).dblclick();
  const radius = page.getByRole('textbox', { name: 'Radius', exact: true });
  await radius.fill('0');
  await radius.press('Tab');
  await expect(radius).toHaveAttribute('title', 'Must be greater than 0');
  await page.getByRole('button', { name: 'OK', exact: true }).first().click();
  await expect(page.getByRole('alert')).toHaveText('Radius: Must be greater than 0');
  expect(errors).toEqual([]);
});
