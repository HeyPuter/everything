import { expect, test } from '@playwright/test';
import { openApp, waitForFeature } from './helpers';

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

for (const replacement of ['another part', 'another sketch'] as const) for (const timing of ['while open', 'on Discard'] as const) test(`Discard confirmation cannot affect ${replacement} opened ${timing}`, async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /New part/ }).click();
  await page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    a.startSketchOn({ kind: 'base', plane: 'front' });
    void a.discardSketch();
  });
  const dialog = page.getByRole('dialog', { name: 'Discard changes?', exact: true });
  await expect(dialog).toBeVisible();
  const expected = await page.evaluate(({ replacement, timing }) => {
    const a = (window as unknown as Handle).__parametric;
    if (timing === 'on Discard') [...document.querySelectorAll<HTMLButtonElement>('.dialog-foot button')].find((b) => b.textContent === 'Discard changes')!.click();
    if (replacement === 'another part') a.newDocument('Replacement');
    else a.exitSketch(true);
    a.startSketchOn({ kind: 'base', plane: 'top' });
    a.sketchEditor!.edit('New work', (sk) => { sk.entities.push({ id: 'newpoint', t: 'point', x: 20, y: 10 }); });
    return { name: a.store.doc.name, features: a.store.doc.features, sketchId: a.sketchEditor!.sketchId };
  }, { replacement, timing });
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  expect(await page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    return { name: a.store.doc.name, features: a.store.doc.features, sketchId: a.sketchEditor?.sketchId };
  })).toEqual(expected);
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Delete and Suppress in the design tree act on every selected feature', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  const hole = page.getByRole('treeitem', { name: 'Hole1' });
  const fillet = page.getByRole('treeitem', { name: 'Fillet1' });
  await hole.click();
  await fillet.click({ modifiers: ['ControlOrMeta'] });
  // The context menu of a selected row suppresses the whole selection.
  await fillet.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Suppress' }).click();
  expect(await page.evaluate(() => (window as unknown as Handle).__parametric.store.doc.features.filter((f) => f.suppressed).map((f) => f.name))).toEqual(['Hole1', 'Fillet1']);
  // The Delete key on a selected row deletes the whole selection.
  await fillet.focus();
  await page.keyboard.press('Delete');
  const dialog = page.getByRole('dialog', { name: 'Delete', exact: true });
  await expect(dialog).toContainText('Hole1, Fillet1?');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(hole).toHaveCount(0);
  await expect(fillet).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('editing a fillet highlights its edges and a second pick of one removes it', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  await page.getByRole('treeitem', { name: 'Fillet1' }).focus();
  await page.keyboard.press('Enter');
  const removes = page.getByRole('group', { name: 'Items to fillet' }).getByRole('button', { name: /^Remove / });
  await expect(removes).toHaveCount(1);
  // The filleted edge exists only on the rolled-back part the panel previews.
  await expect.poll(() => page.evaluate(() => {
    const a = (window as unknown as Handle).__parametric;
    return a.extraHighlights().filter((x) => x.kind === 'edge' && a.edges[x.index]?.name === x.name).length;
  })).toBe(1);
  /** Picks the edge named `name` (or another edge when null) and returns the fillet's edges. */
  const pick = (name: string | null) => page.evaluate((name) => {
    const a = (window as unknown as Handle).__parametric;
    const f = (a.panel as unknown as { f: { edges: { name: string }[] } }).f;
    const i = a.edges.findIndex((e) => (name ? e.name === name : !f.edges.some((x) => x.name === e.name)));
    a.panel!.onPick({ kind: 'edge', index: i, name: a.edges[i].name }, true);
    return f.edges.map((e) => e.name);
  }, name);
  const [original] = await pick(null).then((edges) => edges);
  // Adding another edge kept the one already filleted.
  expect(await page.evaluate(() => ((window as unknown as Handle).__parametric.panel as unknown as { f: { edges: unknown[] } }).f.edges.length)).toBe(2);
  await expect(removes).toHaveCount(2);
  // Picking the existing edge again toggles it off instead of listing it twice.
  const left = await pick(original);
  expect(left).toHaveLength(1);
  expect(left[0]).not.toBe(original);
  await expect(removes).toHaveCount(1);
  expect(errors).toEqual([]);
});
