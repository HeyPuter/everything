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
  // The rebuild after the rename redraws the tree rows: hover the rows it leaves.
  await page.evaluate(() => (window as unknown as Handle).__parametric.whenBuilt());
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

test('keyboard focus moves on when the focused toolbar button becomes unavailable', async ({
  page,
}) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() =>
    (window as unknown as Handle).__parametric.store.change('Rename', (d) => {
      d.name = 'Renamed';
    }),
  );
  const toolbar = page.getByRole('toolbar', { name: 'Quick access' });
  // Focus arrives from the keyboard (after a click, Enter is Repeat Last Command).
  await page.keyboard.press('Shift');
  await toolbar.getByRole('button', { name: 'Undo' }).focus();
  await page.keyboard.press('Enter');
  await expect(toolbar.getByRole('button', { name: 'Undo' })).toBeDisabled();
  await expect(toolbar.getByRole('button', { name: 'Redo' })).toBeFocused();
  expect(errors).toEqual([]);
});

test('Part Properties says what is wrong with an empty name or decimal places out of range', async ({
  page,
}) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() => (window as unknown as Handle).__parametric.commands.run('properties'));
  const dialog = page.getByRole('dialog', { name: 'Part Properties' });
  const name = dialog.getByRole('textbox', { name: 'Part name' });
  const places = dialog.getByRole('spinbutton', { name: 'Decimal places' });
  await name.fill(' ');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Enter a name.');
  await expect(name).toBeFocused();
  await name.fill('Bracket');
  for (const value of ['9', '1.5', '']) {
    await places.fill(value);
    await dialog.getByRole('button', { name: 'OK' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'Enter a whole number of decimal places from 0 to 6.',
    );
    await expect(places).toHaveAttribute('aria-invalid', 'true');
  }
  await places.fill('3');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const d = (window as unknown as Handle).__parametric.store.doc;
      return { name: d.name, decimals: d.decimals };
    }),
  ).toEqual({ name: 'Bracket', decimals: 3 });
  expect(errors).toEqual([]);
});

test('Enter on the part or Material row of the design tree opens its dialog', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.getByRole('treeitem', { name: /^Material/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Material' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('treeitem', { name: /^Material/ })).toBeFocused();
  await page.getByRole('treeitem', { name: 'Part1' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Part Properties' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('mass properties of a small part in metres show significant digits, not zeros', async ({
  page,
}) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.evaluate(() =>
    (window as unknown as Handle).__parametric.store.change('Units', (d) => {
      d.units = 'MKS';
    }),
  );
  await expect
    .poll(() => page.evaluate(() => !!(window as unknown as Handle).__parametric.bbox))
    .toBe(true);
  await page.evaluate(() =>
    (window as unknown as Handle).__parametric.commands.run('massProperties'),
  );
  const dialog = page.getByRole('dialog', { name: 'Mass Properties' });
  const volume = dialog.getByRole('row', { name: /^Volume/ });
  await expect(volume).toContainText(/0\.0000\d{3} m³/);
  await expect(dialog.getByRole('cell', { name: /^Ixx = 0\.0000\d+$/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the status bar gives a selected face's area in square units", async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Handle).__parametric.faces.length))
    .toBeGreaterThan(0);
  const area = await page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    const i = a.faces.findIndex((f) => f.type === 'plane');
    a.selection.set([{ kind: 'face', index: i, name: a.faces[i].name }]);
    return a.faces[i].area.toFixed(2);
  });
  await expect(page.locator('.statusbar .msg')).toContainText(`Area ${area} mm²`);
  expect(errors).toEqual([]);
});

test('the units in the status bar open a menu that changes the unit system', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.locator('.statusbar').getByRole('button', { name: 'MMGS' }).click();
  const menu = page.getByRole('menu', { name: 'Unit system' });
  await expect(menu.getByRole('menuitemradio', { name: /^MMGS/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await menu.getByRole('menuitemradio', { name: /^IPS/ }).click();
  await expect(page.locator('.statusbar').getByRole('button', { name: 'IPS' })).toBeFocused();
  expect(
    await page.evaluate(() => (window as unknown as Handle).__parametric.store.doc.units),
  ).toBe('IPS');
  // One undo step.
  await page.evaluate(() => (window as unknown as Handle).__parametric.commands.run('undo'));
  await expect(page.locator('.statusbar').getByRole('button', { name: 'MMGS' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the status bar has no button without an action', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    a.editSketch(a.store.doc.features.find((f) => f.type === 'sketch')!.id);
  });
  await expect(page.locator('.statusbar')).toContainText('Defined');
  await expect(page.locator('.statusbar').getByRole('button', { name: /Defined/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the panel splitter reports the panel width and resizes with the keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const splitter = page.getByRole('separator', { name: 'Resize panel' });
  const width = () =>
    page
      .locator('.leftpane')
      .evaluate((el) => String(Math.round(el.getBoundingClientRect().width)));
  await expect(splitter).toHaveAttribute('aria-valuenow', await width());
  await splitter.focus();
  await page.keyboard.press('End');
  await expect(splitter).toHaveAttribute('aria-valuenow', '520');
  await page.keyboard.press('ArrowLeft');
  await expect(splitter).toHaveAttribute('aria-valuenow', '500');
  await page.keyboard.press('Home');
  await expect(splitter).toHaveAttribute('aria-valuenow', '200');
  expect(errors).toEqual([]);
});

test('Esc dismisses a tooltip while the pointer stays on its button', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.getByRole('button', { name: 'Zoom to Fit' }).hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the flyout tree over a panel follows a rename of the part', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('button', { name: 'Fillet', exact: true }).click();
  await expect(page.locator('.flyout-tree > button')).toHaveText('Mounting Bracket');
  await page.evaluate(() =>
    (window as unknown as Handle).__parametric.store.change('Rename', (d) => {
      d.name = 'Wall Bracket';
    }),
  );
  await expect(page.locator('.flyout-tree > button')).toHaveText('Wall Bracket');
  expect(errors).toEqual([]);
});

test('a value field labelled by an icon shows its unit', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('treeitem', { name: 'Extrude1' }).dblclick();
  const depth = page.getByRole('textbox', { name: 'Depth', exact: true }).first();
  await expect(depth).toHaveAccessibleDescription('mm');
  await expect(depth.locator('xpath=..').locator('.unit')).toHaveText('mm');
  expect(errors).toEqual([]);
});

test('the arrow keys move between a design tree row and its children', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('treeitem', { name: 'Extrude1' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('treeitem', { name: 'Extrude1' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('treeitem', { name: 'Sketch1' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('treeitem', { name: 'Extrude1' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('treeitem', { name: 'Extrude1' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  // From a top-level feature, Left goes to the part.
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('treeitem', { name: 'Mounting Bracket' })).toBeFocused();
  expect(errors).toEqual([]);
});

test('Measure keeps significant digits for small values in metres', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.evaluate(() =>
    (window as unknown as Handle).__parametric.store.change('Units', (d) => {
      d.units = 'MKS';
    }),
  );
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Handle).__parametric.edges.length))
    .toBeGreaterThan(0);
  const length = await page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    const i = a.edges.findIndex((e) => e.type === 'line');
    a.selection.set([{ kind: 'edge', index: i, name: a.edges[i].name }]);
    a.commands.run('measure');
    return a.edges[i].length / 1000;
  });
  const digits = 2 - Math.floor(Math.log10(length));
  await expect(page.locator('.pm-section table')).toContainText(
    `Edge length${length.toFixed(digits)} m`,
  );
  expect(errors).toEqual([]);
});

test('the status bar keeps significant digits for a small edge in metres', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.evaluate(() =>
    (window as unknown as Handle).__parametric.store.change('Units', (d) => {
      d.units = 'MKS';
    }),
  );
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Handle).__parametric.edges.length))
    .toBeGreaterThan(0);
  const length = await page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    const i = a.edges.findIndex((e) => e.type === 'line');
    a.selection.set([{ kind: 'edge', index: i, name: a.edges[i].name }]);
    return a.edges[i].length / 1000;
  });
  const digits = 2 - Math.floor(Math.log10(length));
  await expect(page.locator('.statusbar .msg')).toContainText(`Length ${length.toFixed(digits)} m`);
  expect(errors).toEqual([]);
});

test('a rollback bar drag released outside the window stops following the pointer', async ({
  page,
}) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  const bar = (await page.locator('.rollback-bar').boundingBox())!;
  const hole = (await page.getByRole('treeitem', { name: 'Hole1' }).boundingBox())!;
  const extrude = (await page.getByRole('treeitem', { name: 'Extrude1' }).boundingBox())!;
  await page.mouse.move(bar.x + 20, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(hole.x + 20, hole.y + 2, { steps: 4 });
  const rollback = () =>
    page.evaluate(() => (window as unknown as Handle).__parametric.store.doc.rollback);
  const rolled = await rollback();
  expect(rolled).not.toBeNull();
  // The button comes up outside the window: the next move has no button down.
  await page.evaluate(
    ({ x, y }) =>
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 1,
          pointerType: 'mouse',
          buttons: 0,
          clientX: x,
          clientY: y,
        }),
      ),
    { x: extrude.x + 20, y: extrude.y + 2 },
  );
  expect(await rollback()).toBe(rolled);
  await expect(page.locator('.rollback-bar.dragging')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a menu item clipped by an ellipsis shows its whole label as a tooltip', async ({ page }) => {
  const long = 'A recent part with a name far too long for any menu to show in full';
  await page.addInitScript((long) => {
    localStorage.setItem(
      'parametric:recent',
      JSON.stringify([{ location: { type: 'local', id: 'p1' }, name: long, opened: 1 }]),
    );
  }, long);
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: 'Recent' }).click();
  const label = page.getByRole('menuitem', { name: new RegExp(`^${long}`) }).locator('.lbl');
  await label.hover();
  await expect(label).toHaveAttribute('title', new RegExp(`^${long}`));
  expect(errors).toEqual([]);
});

test('running Mass Properties again while it calculates opens one dialog', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await expect
    .poll(() => page.evaluate(() => !!(window as unknown as Handle).__parametric.bbox))
    .toBe(true);
  await page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    a.commands.run('massProperties');
    a.commands.run('massProperties');
  });
  await expect(page.getByRole('dialog', { name: 'Mass Properties' })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByRole('dialog', { name: 'Mass Properties' })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.statusbar .msg')).not.toHaveText('Calculating mass properties...');
  expect(errors).toEqual([]);
});

test('Space on the custom colour field is left to the field, not a shortcut', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() => (window as unknown as Handle).__parametric.openTaskPane('appearance'));
  // Focus arrives from the keyboard.
  await page.keyboard.press('Shift');
  await page.getByLabel('Custom colour').focus();
  const prevented = await page.evaluate(() => {
    const input = document.activeElement!;
    const e = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(page.getByRole('menu')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('OK in Equations marks and focuses the field at fault', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    a.store.change('Variables', (d) => {
      d.variables.push(
        { id: 'v1', name: 'Width', expr: '10' },
        { id: 'v2', name: 'Height', expr: '5' },
      );
    });
    a.commands.run('equations');
  });
  const dialog = page.getByRole('dialog', { name: 'Equations and Global Variables' });
  const second = dialog.getByRole('textbox', { name: 'Name of variable 2' });
  await second.fill('Width');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Variable names must be unique.');
  await expect(second).toBeFocused();
  await expect(second).toHaveAttribute('aria-invalid', 'true');
  await second.fill('Depth');
  await second.press('Tab');
  const expr = dialog.getByRole('textbox', { name: 'Value or expression of Depth' });
  await expr.fill('Width / 0');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Depth: Division by zero');
  await expect(expr).toBeFocused();
  await expect(second).not.toHaveAttribute('aria-invalid');
  expect(errors).toEqual([]);
});

test('design tree rows tell screen readers that a feature is suppressed or rolled back', async ({
  page,
}) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    const hole = a.store.doc.features.find((f) => f.name === 'Hole1')!;
    a.toggleSuppress([hole.id], true);
    a.setRollback(a.store.indexOf(a.store.doc.features.find((f) => f.name === 'Fillet1')!.id));
  });
  await expect(page.getByRole('treeitem', { name: 'Hole1' })).toHaveAccessibleDescription(
    'Suppressed',
  );
  await expect(page.getByRole('treeitem', { name: 'Fillet1' })).toHaveAccessibleDescription(
    'Rolled back',
  );
  await expect(page.getByRole('treeitem', { name: 'Extrude1' })).toHaveAccessibleDescription('');
  expect(errors).toEqual([]);
});

test('View › Design Tree shows and focuses the design tree beside an open panel', async ({
  page,
}) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('treeitem', { name: 'Fillet1' }).click();
  await page.getByRole('button', { name: 'Chamfer', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Chamfer' })).toBeVisible();
  await page.getByRole('menubar').getByRole('menuitem', { name: 'View' }).click();
  await page.getByRole('menuitem', { name: 'Design Tree' }).click();
  await expect(page.getByRole('tree', { name: 'Design tree', exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('tree', { name: 'Design tree', exact: true })
      .getByRole('treeitem', { name: 'Fillet1' }),
  ).toBeFocused();
  expect(errors).toEqual([]);
});

test('a model command run from the drawing goes back to the model to show its panel', async ({
  page,
}) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await expect
    .poll(() => page.evaluate(() => !!(window as unknown as Handle).__parametric.bbox))
    .toBe(true);
  await page.evaluate(() => (window as unknown as Handle).__parametric.openDrawing());
  await expect(page.getByRole('tab', { name: 'Drawing', exact: true }).first()).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.locator('.drawing-ws').focus();
  await page.keyboard.press('l');
  await expect(page.getByRole('heading', { name: 'Sketch' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as Handle).__parametric.inDrawing)).toBe(
    false,
  );
  await expect(page.getByRole('tab', { name: 'Model', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(errors).toEqual([]);
});

test('choosing a section plane with the keyboard keeps focus on the plane buttons', async ({
  page,
}) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.evaluate(() => (window as unknown as Handle).__parametric.commands.run('sectionView'));
  const plane = page.getByRole('group', { name: 'Section plane' });
  // Focus arrives from the keyboard.
  await page.keyboard.press('Shift');
  await plane.getByRole('button', { name: 'Top', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(plane.getByRole('button', { name: 'Top', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(plane.getByRole('button', { name: 'Top', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});

test('the rollback bar and colour swatches stay visible in high contrast mode', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const bar = await page
    .locator('.rollback-bar')
    .evaluate((el) => getComputedStyle(el, '::before').backgroundColor);
  const canvas = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bar).not.toBe(canvas);
  expect(bar).not.toBe('rgba(0, 0, 0, 0)');
  await page.evaluate(() => (window as unknown as Handle).__parametric.openTaskPane('appearance'));
  const swatches = await page
    .locator('.swatch')
    .evaluateAll((els) => new Set(els.map((el) => getComputedStyle(el).backgroundColor)).size);
  expect(swatches).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});

test('a panel opened from a scrolled design tree starts at its top, and the tree keeps its place', async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  const pane = page.locator('.lp-body');
  await pane.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const scrolled = await pane.evaluate((el) => el.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
  await page.getByRole('treeitem', { name: 'Extrude1' }).dblclick();
  await expect(page.getByRole('heading', { name: 'Extrude1' })).toBeVisible();
  expect(await pane.evaluate((el) => el.scrollTop)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('treeitem', { name: 'Extrude1' })).toBeVisible();
  expect(await pane.evaluate((el) => el.scrollTop)).toBe(scrolled);
  expect(errors).toEqual([]);
});

test("the view toolbar's menu buttons have tooltips like its other buttons", async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  const caret = page
    .getByRole('toolbar', { name: 'View' })
    .getByRole('button', { name: 'Standard views' });
  await expect(caret).toHaveAttribute('aria-expanded', 'false');
  await caret.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Standard views');
  expect(errors).toEqual([]);
});

test('a count typed with a fraction is pointed out, not rounded quietly', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('treeitem', { name: 'Hole1' }).click();
  await page.getByRole('button', { name: 'Linear Pattern', exact: true }).click();
  const count = page.getByRole('textbox', { name: 'Number of instances' }).first();
  await count.fill('2.5');
  await count.press('Tab');
  await expect(count).toHaveAttribute('aria-invalid', 'true');
  await expect(count).toHaveAttribute('title', 'Enter a whole number');
  await count.fill('3');
  await count.press('Tab');
  await expect(count).not.toHaveAttribute('aria-invalid', 'true');
  expect(errors).toEqual([]);
});

test('Down from the design tree filter goes to the first matching row', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  const filter = page.getByRole('searchbox', { name: 'Filter the design tree' });
  await filter.fill('hole');
  await filter.press('ArrowDown');
  await expect(page.getByRole('treeitem', { name: 'Hole1' })).toBeFocused();
  expect(errors).toEqual([]);
});

test('a design tree filter that matches nothing says so', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  const filter = page.getByRole('searchbox', { name: 'Filter the design tree' });
  await filter.fill('zzz');
  await expect(
    page.getByRole('status').filter({ hasText: 'Nothing in the design tree matches' }),
  ).toBeVisible();
  await filter.fill('fil');
  await expect(page.getByText('Nothing in the design tree matches')).toBeHidden();
  expect(errors).toEqual([]);
});

test('the spin arrows leave a value driven by an equation alone', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.evaluate(() =>
    (window as unknown as Handle).__parametric.store.change('Variables', (d) => {
      d.variables.push({ id: 'v1', name: 'R', expr: '0.5' });
    }),
  );
  await page.getByRole('treeitem', { name: 'Fillet1' }).dblclick();
  const radius = page.getByRole('textbox', { name: 'Radius', exact: true });
  await radius.fill('=R*2');
  await radius.press('Tab');
  const up = page.getByRole('button', { name: 'Increase Radius' });
  await expect(up).toHaveAttribute('aria-disabled', 'true');
  await expect(up.locator('xpath=..')).toHaveAttribute('title', /Driven by an equation/);
  await up.click({ force: true });
  await radius.focus();
  await page.keyboard.press('ArrowUp');
  await expect(radius).toHaveValue('=R*2');
  await page.getByRole('button', { name: 'OK', exact: true }).first().click();
  expect(
    await page.evaluate(() => {
      const f = (window as unknown as Handle).__parametric.store.doc.features.find(
        (x) => x.name === 'Fillet1',
      );
      return (f as { radius: unknown }).radius;
    }),
  ).toBe('=R*2');
  // A plain number steps as before.
  await page.getByRole('treeitem', { name: 'Fillet1' }).dblclick();
  await radius.fill('3');
  await radius.press('Tab');
  await expect(up).not.toHaveAttribute('aria-disabled');
  await up.click();
  await expect(radius).toHaveValue('4');
  expect(errors).toEqual([]);
});
