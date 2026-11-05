import { expect, test } from '@playwright/test';
import { canvasCenter, openApp, waitForFeature } from './helpers';

test.describe('part modeling', () => {
  test('opens an example and rebuilds it without errors', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    for (const name of ['Extrude1', 'Hole1', 'Fillet1']) await waitForFeature(page, name);
    await expect(page.locator('.ti.error')).toHaveCount(0);
    await expect(page.locator('.statusbar')).toContainText('MMGS');
    expect(errors).toEqual([]);
  });

  test('sketches a rectangle, dimensions it and extrudes it', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    await page.getByRole('treeitem', { name: 'Front Plane' }).click();
    await page.getByRole('tab', { name: 'Sketch' }).click();
    await page.locator('[data-cmd="sketch"]').first().click();
    await expect(page.locator('.statusbar')).toContainText('Defined');
    // Clicks must wait for the camera to finish turning normal to the plane;
    // the view label only reads "Front" once it has.
    await expect(page.locator('.view-label')).toHaveText('Front');
    const { x, y } = await canvasCenter(page);
    await page.locator('[data-cmd="tool:rectangle"]').click();
    await page.mouse.click(x, y);
    await page.mouse.click(x + 160, y - 90);
    await page.keyboard.press('Escape');
    await expect(page.locator('.rel-badge').first()).toBeVisible();
    // Dimension the bottom edge to 50 mm.
    await page.keyboard.press('d');
    await page.mouse.click(x + 80, y);
    await page.mouse.click(x + 80, y + 40);
    const modify = page.getByRole('dialog', { name: /Modify/ });
    await expect(modify).toBeVisible();
    await modify.getByRole('textbox').fill('50');
    await modify.getByRole('textbox').press('Enter');
    await expect(page.locator('.dim-label', { hasText: '50.00' })).toBeVisible();
    await page.keyboard.press('Escape');
    // Extrude: finishing the sketch makes it the profile.
    await page.getByRole('tab', { name: 'Features' }).click();
    await page.locator('[data-cmd="extrude"]').first().click();
    await expect(page.getByRole('heading', { name: 'Extrude' })).toBeVisible();
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    await waitForFeature(page, 'Extrude1');
    await expect(page.locator('.ti.error')).toHaveCount(0);
    // Undo removes the feature again.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.getByRole('treeitem', { name: 'Extrude1' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('suppressing a feature suppresses the features built on it', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    await page.getByRole('treeitem', { name: 'Extrude1' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Suppress' }).click();
    // The hole sits on a face of the extrude and the fillet rounds one of its edges.
    for (const name of ['Extrude1', 'Hole1', 'Fillet1']) await expect(page.getByRole('treeitem', { name })).toHaveClass(/suppressed/);
    await expect(page.locator('.ti.error')).toHaveCount(0);
    await page.getByRole('treeitem', { name: 'Extrude1' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Unsuppress' }).click();
    await expect(page.locator('.ti.suppressed')).toHaveCount(0);
    await expect(page.locator('.ti.error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a new shell defaults to a thickness its part\'s fillets allow', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /New part/ }).click();
    type Doc = { features: { id: string; type: string; thickness?: unknown }[] };
    type Handle = { store: { doc: Doc; change(l: string, fn: (d: Doc) => void): void }; whenBuilt(): Promise<void> };
    // A 20 x 20 x 10 block with its top edges rounded 1 mm: the default
    // shell of a part this small used to be 1 mm too, which cannot be offset.
    await page.evaluate(async () => {
      const a = (window as unknown as { __parametric: Handle }).__parametric;
      const pts = [[0, 0], [20, 0], [20, 20], [0, 20]];
      a.store.change('Block', (d) => {
        d.features.push(...([
          { id: 's1', name: 'Sketch1', type: 'sketch', plane: { kind: 'base', plane: 'front' }, constraints: [], entities: [
            ...pts.map(([x, y], i) => ({ id: `p${i}`, t: 'point', x, y })),
            ...pts.map((_, i) => ({ id: `l${i}`, t: 'line', a: `p${i}`, b: `p${(i + 1) % 4}` })),
          ] },
          { id: 'f1', name: 'Extrude1', type: 'extrude', sketch: 's1', cut: false, end: 'blind', depth: 10, flip: false, dir2: null, draft: 0, draftOutward: false, thin: null },
          { id: 'f2', name: 'Fillet1', type: 'fillet', edges: [], radius: 1, faces: [{ name: 'f1:cap1', sig: { type: 'plane', c: [10, 10, 10], n: [0, 0, 1], area: 400 } }] },
        ] as unknown as Doc['features']));
      });
      await a.whenBuilt();
    });
    await waitForFeature(page, 'Fillet1');
    await expect(page.locator('.ti.error')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Features' }).click();
    await page.locator('[data-cmd="shell"]').first().click();
    await expect(page.getByRole('heading', { name: 'Shell' })).toBeVisible();
    await page.getByRole('button', { name: 'OK', exact: true }).first().click();
    await waitForFeature(page, 'Shell1');
    const thickness = await page.evaluate(async () => {
      const a = (window as unknown as { __parametric: Handle }).__parametric;
      await a.whenBuilt();
      return a.store.doc.features.find((f) => f.type === 'shell')!.thickness;
    });
    expect(thickness).toBeLessThan(1);
    await expect(page.locator('.ti.error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the status bar reports the expression error of a feature, not its fallout', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    type Handle = { store: { doc: { features: { id: string; depth?: unknown }[] }; change(l: string, fn: (d: { features: { id: string; depth?: unknown }[] }) => void): void } };
    await page.evaluate(() => (window as unknown as { __parametric: Handle }).__parametric.store.change('Depth', (d) => {
      d.features.find((f) => f.id === 'f1')!.depth = '=Nope*2';
    }));
    await expect(page.locator('.statusbar [role="status"]')).toContainText('Rebuild error in Extrude1: Depth: Unknown name "Nope"');
    await expect(page.getByRole('treeitem', { name: 'Extrude1' })).toHaveClass(/error/);
    // Suppressed, the feature and its value are not used: no error.
    await page.getByRole('treeitem', { name: 'Extrude1' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Suppress' }).click();
    await expect(page.getByRole('treeitem', { name: 'Extrude1' })).toHaveClass(/suppressed/);
    await expect(page.locator('.ti.error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('an extrude draft linked to an equation shows as a draft', async ({ page }) => {
    const errors = await openApp(page);
    await page.getByRole('button', { name: /Mounting Bracket/ }).click();
    await waitForFeature(page, 'Fillet1');
    type Handle = { store: { change(l: string, fn: (d: { variables: unknown[]; features: { id: string; draft?: unknown }[] }) => void): void } };
    await page.evaluate(() => (window as unknown as { __parametric: Handle }).__parametric.store.change('Draft', (d) => {
      d.variables = [{ id: 'v1', name: 'Taper', expr: '2' }];
      d.features.find((f) => f.id === 'f1')!.draft = '=Taper';
    }));
    await page.getByRole('treeitem', { name: 'Extrude1', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('checkbox', { name: 'Draft', exact: true })).toBeChecked();
    await expect(page.getByRole('textbox', { name: 'Draft angle' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Draft angle' })).toHaveValue(/Taper/);
    expect(errors).toEqual([]);
  });

  test('evaluates mass properties of the flange', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Pipe Flange/ }).click();
    await waitForFeature(page, 'Circular Pattern1');
    await page.getByRole('tab', { name: 'Evaluate' }).click();
    await page.locator('[data-cmd="massProperties"]').first().click();
    const dlg = page.getByRole('dialog', { name: 'Mass Properties' });
    await expect(dlg).toContainText('Volume');
    await expect(dlg).toContainText('Stainless Steel');
  });

  test('switches themes and keeps the choice', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: /Account/ }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme-resolved', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme-resolved', 'dark');
  });

  test('opens a SolidWorks part as an imported solid', async ({ page }) => {
    const errors = await openApp(page);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /Open from device/ }).click();
    await (await chooser).setFiles(decodeURIComponent(new URL('../fixtures/sldprt/cube-hole-sw2022.sldprt', import.meta.url).pathname));
    await waitForFeature(page, 'Imported1');
    await expect(page.locator('.doc-title')).toHaveText('cube-hole-sw2022');
    await expect(page.locator('.ti.error')).toHaveCount(0);
    await expect(page.locator('.toast.success')).toContainText('Opened cube-hole-sw2022.sldprt');
    expect(errors).toEqual([]);
  });
});

test('renaming a global variable keeps the dimensions, features and equations that use it', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  type Doc = { variables: { id: string; name: string; expr: string }[]; features: { id: string; depth?: unknown; constraints?: { id: string; value?: unknown }[] }[] };
  type Handle = { store: { doc: Doc; change(l: string, fn: (d: Doc) => void): void }; commands: { run(id: string): boolean } };
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: Handle }).__parametric;
    a.store.change('Link', (d) => {
      d.variables = [{ id: 'v1', name: 'W', expr: '30' }, { id: 'v2', name: 'Half', expr: 'W/2' }];
      d.features.find((f) => f.id === 'f1')!.depth = '=W';
      d.features.find((f) => f.id === 's1')!.constraints!.find((c) => c.id === 'd2')!.value = '=Half*2';
    });
    a.commands.run('equations');
  });
  const dlg = page.getByRole('dialog', { name: 'Equations and Global Variables' });
  // The extrude depth and the equation of Half use W.
  await expect(dlg.getByRole('row').nth(1)).toContainText('1');
  await dlg.getByRole('textbox', { name: 'Name of variable 1' }).fill('Width');
  await dlg.getByRole('textbox', { name: 'Name of variable 1' }).press('Tab');
  await expect(dlg.getByRole('textbox', { name: 'Value or expression of Half' })).toHaveValue('Width/2');
  await dlg.getByRole('button', { name: 'OK' }).click();
  await expect(dlg).toBeHidden();
  const linked = await page.evaluate(() => {
    const d = (window as unknown as { __parametric: Handle }).__parametric.store.doc;
    return [d.features.find((f) => f.id === 'f1')!.depth, d.features.find((f) => f.id === 's1')!.constraints!.find((c) => c.id === 'd2')!.value];
  });
  expect(linked).toEqual(['=Width', '=Half*2']);
  await page.evaluate(() => (window as unknown as { __parametric: { whenBuilt(): Promise<void> } }).__parametric.whenBuilt());
  await expect(page.locator('.ti.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a global variable cannot take a name the expressions already use', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() => (window as unknown as { __parametric: { commands: { run(id: string): boolean } } }).__parametric.commands.run('equations'));
  const dlg = page.getByRole('dialog', { name: 'Equations and Global Variables' });
  await dlg.getByRole('button', { name: 'Add variable' }).click();
  const name = dlg.getByRole('textbox', { name: 'Name of variable 1' });
  // =pi*2 would use the constant, not the variable.
  await name.fill('pi');
  await name.press('Tab');
  await dlg.getByRole('button', { name: 'OK' }).click();
  await expect(dlg.getByRole('alert')).toContainText('"pi" is a constant, unit or function name');
  await name.fill('Gap');
  await name.press('Tab');
  await dlg.getByRole('button', { name: 'OK' }).click();
  await expect(dlg).toBeHidden();
});

test('renaming a variable onto another one\'s name leaves the equations that use either alone', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: { store: { change(l: string, f: (d: { variables: unknown[] }) => void): void }; commands: { run(id: string): boolean } } }).__parametric;
    a.store.change('Vars', (d) => { d.variables = [{ id: 'v1', name: 'A', expr: '10' }, { id: 'v2', name: 'B', expr: '20' }, { id: 'v3', name: 'C', expr: 'A + B' }]; });
    a.commands.run('equations');
  });
  const dlg = page.getByRole('dialog', { name: 'Equations and Global Variables' });
  const name = dlg.getByRole('textbox', { name: 'Name of variable 1' });
  // A slip: A typed as B, then put back. C must still add the two.
  await name.fill('B');
  await name.press('Tab');
  await name.fill('A');
  await name.press('Tab');
  await expect(dlg.getByRole('textbox', { name: 'Value or expression of C' })).toHaveValue('A + B');
});

test('the equations table keeps keyboard focus as values are edited and rows deleted', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: { store: { change(l: string, f: (d: { variables: unknown[] }) => void): void }; commands: { run(id: string): boolean } } }).__parametric;
    a.store.change('Vars', (d) => { d.variables = [{ id: 'v1', name: 'A', expr: '10' }, { id: 'v2', name: 'B', expr: 'A*2' }]; });
    a.commands.run('equations');
  });
  const dlg = page.getByRole('dialog', { name: 'Equations and Global Variables' });
  // The dialog focuses its first field a frame after it opens.
  await expect(dlg.getByRole('textbox', { name: 'Name of variable 1' })).toBeFocused();
  await dlg.getByRole('textbox', { name: 'Value or expression of A' }).fill('12');
  await page.keyboard.press('Tab');
  // Tab goes on to the next control, which focus used to leave the dialog for.
  await expect(dlg.getByRole('button', { name: 'Delete A' })).toBeFocused();
  await expect(dlg.getByRole('row').nth(2)).toContainText('24.0000');
  // An equation's error is on its field for assistive tech too.
  const b = dlg.getByRole('textbox', { name: 'Value or expression of B' });
  await expect(b).not.toHaveAttribute('aria-invalid', 'true');
  await b.fill('A/0');
  await b.press('Shift+Tab');
  await expect(b).toHaveAttribute('aria-invalid', 'true');
  await expect(b).toHaveAccessibleDescription('Division by zero');
  await b.fill('A*2');
  await b.press('Tab');
  await expect(b).not.toHaveAttribute('aria-invalid', 'true');
  await dlg.getByRole('button', { name: 'Delete A' }).focus();
  await page.keyboard.press('Enter');
  await expect(dlg.getByRole('button', { name: 'Delete B' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dlg.getByRole('button', { name: 'Add variable' })).toBeFocused();
});

test('deleting a global variable keeps the values that used it', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  type Doc = { variables: { id: string; name: string; expr: string }[]; features: { id: string; depth?: unknown }[] };
  type Handle = { store: { doc: Doc; change(l: string, fn: (d: Doc) => void): void }; commands: { run(id: string): boolean }; whenBuilt(): Promise<void> };
  await page.evaluate(() => {
    const a = (window as unknown as { __parametric: Handle }).__parametric;
    a.store.change('Link', (d) => {
      d.variables = [{ id: 'v1', name: 'W', expr: '-15' }, { id: 'v2', name: 'Keep', expr: '1' }];
      d.features.find((f) => f.id === 'f1')!.depth = '=2-W';
    });
    a.commands.run('equations');
  });
  const dlg = page.getByRole('dialog', { name: 'Equations and Global Variables' });
  await dlg.getByRole('button', { name: 'Delete W' }).click();
  await dlg.getByRole('button', { name: 'OK' }).click();
  await expect(dlg).toBeHidden();
  const depth = await page.evaluate(() => (window as unknown as { __parametric: Handle }).__parametric.store.doc.features.find((f) => f.id === 'f1')!.depth);
  expect(depth).toBe('=2-(-15)');
  await page.evaluate(() => (window as unknown as { __parametric: Handle }).__parametric.whenBuilt());
  await expect(page.locator('.ti.error')).toHaveCount(0);
});

test('switching the part to inches keeps the size of values linked to equations', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  type Doc = { variables: { id: string; name: string; expr: string }[]; features: { id: string; depth?: unknown; constraints?: { id: string; value?: unknown }[] }[] };
  type Handle = { store: { doc: Doc; change(l: string, fn: (d: Doc) => void): void }; whenBuilt(): Promise<void>; bbox: { min: number[]; max: number[] } | null };
  const size = () => page.evaluate(async () => {
    const a = (window as unknown as { __parametric: Handle }).__parametric;
    await a.whenBuilt();
    return a.bbox!.max.map((v, i) => Math.round((v - a.bbox!.min[i]) * 1000) / 1000);
  });
  await page.evaluate(() => (window as unknown as { __parametric: Handle }).__parametric.store.change('Link', (d) => {
    d.variables = [{ id: 'v1', name: 'Width', expr: '60' }];
    d.features.find((f) => f.id === 'f1')!.depth = '=Width/2';
    d.features.find((f) => f.id === 's1')!.constraints!.find((c) => c.id === 'd1')!.value = '=Width';
  }));
  expect(await size()).toEqual([60, 40, 30]);
  await page.evaluate(() => (window as unknown as { __parametric: { commands: { run(id: string): boolean } } }).__parametric.commands.run('properties'));
  const dlg = page.getByRole('dialog', { name: 'Part Properties' });
  await dlg.getByRole('combobox', { name: 'Unit system' }).selectOption('IPS');
  await dlg.getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('.statusbar')).toContainText('IPS');
  expect(await size()).toEqual([60, 40, 30]);
  expect(await page.evaluate(() => (window as unknown as { __parametric: Handle }).__parametric.store.doc.features.find((f) => f.id === 'f1')!.depth)).toBe('=Width/2');
  await expect(page.locator('.ti.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('keyboard focus moves into a feature panel opened from the tree and back when it closes', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('treeitem', { name: 'Extrude1', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Extrude1' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Extrude1' })).toHaveCount(0);
  await expect(page.getByRole('treeitem', { name: 'Extrude1', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});

test('OK keeps a feature panel open while a value cannot be read', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('treeitem', { name: 'Extrude1' }).dblclick();
  const depth = page.getByRole('textbox', { name: 'Depth' }).first();
  await depth.fill('abc');
  await page.locator('.confirm-corner').getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('.pm-msg')).toContainText('Depth');
  await expect(depth).toBeFocused();
  await depth.fill('25');
  await page.locator('.confirm-corner').getByRole('button', { name: 'OK' }).click();
  await expect(page.getByRole('treeitem', { name: 'Extrude1' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __parametric: { store: { doc: { features: { name: string; depth?: number }[] } } } }).__parametric.store.doc.features.find((f) => f.name === 'Extrude1')?.depth)).toBe(25);
});

test('Escape in a feature panel field takes back the typed value, then cancels the panel', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  const depthOf = () => page.evaluate(() => (window as unknown as { __parametric: { store: { doc: { features: { name: string; depth?: number }[] } } } }).__parametric.store.doc.features.find((f) => f.name === 'Extrude1')?.depth);
  const before = await depthOf();
  await page.getByRole('treeitem', { name: 'Extrude1' }).dblclick();
  const depth = page.getByRole('textbox', { name: 'Depth' }).first();
  await depth.click();
  await depth.fill('-');
  await page.keyboard.press('Escape');
  await expect(depth).toHaveValue(String(before));
  await expect(depth).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Extrude1' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Extrude1' })).toHaveCount(0);
  expect(await depthOf()).toBe(before);
  expect(errors).toEqual([]);
});

test('dragging the rollback bar rolls back past several features in one undo step', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  type P = { __parametric: { store: { doc: { rollback: number | null }; undoDepth: number } } };
  const state = () => page.evaluate(() => { const s = (window as unknown as P).__parametric.store; return { rollback: s.doc.rollback, undo: s.undoDepth }; });
  const before = await state();
  const bar = (await page.locator('.tree .rollback-bar').boundingBox())!;
  const target = (await page.getByRole('treeitem', { name: 'Extrude1' }).boundingBox())!;
  const x = bar.x + 40, y0 = bar.y + bar.height / 2;
  await page.mouse.move(x, y0);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x, y0 + (target.y + 2 - y0) * i / 10);
  await page.mouse.up();
  // The bar now sits above Extrude1, the second feature.
  await expect.poll(async () => (await state()).rollback).toBe(1);
  expect((await state()).undo).toBe(before.undo + 1);
});

test('Redo while a feature panel is open is not undone by the panel', async ({ page }) => {
  type Win = { __parametric: import('../../src/app/app').App };
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  const zMax = () => page.evaluate(() => (window as unknown as Win).__parametric.bbox?.max[2]);
  const depth = () => page.evaluate(() => (window as unknown as Win).__parametric.store.doc.features.find((f) => f.id === 'f1') as unknown as { depth: number }).then((f) => f.depth);
  await page.evaluate(() => {
    const app = (window as unknown as Win).__parametric;
    app.store.change('Depth', (d) => { (d.features.find((f) => f.id === 'f1') as { depth: number }).depth = 40; });
  });
  await expect.poll(zMax).toBe(40);
  await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('undo'));
  await expect.poll(zMax).toBe(30);
  // Edit the plate, then redo the deeper plate with its panel still open.
  await page.evaluate(() => (window as unknown as Win).__parametric.editFeature('f1'));
  await expect(page.getByRole('heading', { name: 'Extrude1' })).toBeVisible();
  await page.evaluate(() => (window as unknown as Win).__parametric.commands.run('redo'));
  // The panel's copy of the old plate is dropped instead of being written back by OK.
  await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__parametric.panel)).toBe(false);
  await expect.poll(zMax).toBe(40);
  expect(await depth()).toBe(40);
  expect(errors).toEqual([]);
});
