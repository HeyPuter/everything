import { type Page, expect, test } from '@playwright/test';
import { openApp } from './helpers';

type W = { __parametric: import('../../src/app/app').App };

/** Where the centre of a face (by name) is on the page, once the camera stopped moving. */
async function facePoint(page: Page, name: string): Promise<{ x: number; y: number }> {
  return page.evaluate(async (name) => {
    const a = (window as unknown as W).__parametric;
    await a.whenBuilt();
    const f = a.faces.find((x) => x.name === name)!;
    const at = () => {
      const [x, y] = a.viewport.project(f.center);
      const r = a.viewport.canvas.getBoundingClientRect();
      return { x: r.x + x, y: r.y + y };
    };
    let last = at();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const n = at();
      if (Math.abs(n.x - last.x) + Math.abs(n.y - last.y) < 0.5) break;
      last = n;
    }
    return last;
  }, name);
}

test('sets up a static study, runs it, reads the plot and saves it with the part', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.waitForFunction(() => !!(window as unknown as W).__parametric.bbox);
  await page.getByRole('tab', { name: 'Analysis' }).click();

  // Material: the preset's elastic properties are shown; Alloy Steel is chosen.
  await page.locator('.cm-tools [data-cmd="material"]').click();
  const mat = page.getByRole('dialog', { name: 'Material' });
  await expect(mat.locator('.fea-material-props')).toContainText('Elastic modulus 68.9 GPa');
  await mat.getByLabel('Material', { exact: true }).selectOption({ label: 'Alloy Steel  (7700 kg/m³)' });
  await expect(mat.locator('.fea-material-props')).toContainText('yield strength 415 MPa');
  await mat.getByRole('button', { name: 'Apply' }).click();

  // A fixed face, picked in the graphics area.
  await page.locator('[data-cmd="fea:fixed"]').click();
  await expect(page.locator('.pm-head').getByText('Fixed', { exact: true })).toBeVisible();
  let p = await facePoint(page, 'f1:side:bl1');
  await page.mouse.click(p.x, p.y);
  await expect(page.getByRole('group', { name: 'Faces' })).toContainText('Face');
  await page.locator('.confirm-corner .ok').click();
  await expect(page.getByRole('treeitem', { name: /^Fixed-1/ })).toBeVisible();

  // A 500 N force pressing on the top of the upright.
  await page.locator('[data-cmd="fea:force"]').click();
  p = await facePoint(page, 'f1:side:bl4');
  await page.mouse.click(p.x, p.y);
  await page.getByLabel('Total force (N)').fill('500');
  await page.locator('.confirm-corner .ok').click();
  await expect(page.getByRole('treeitem', { name: /^Force-1/ })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as W).__parametric.store.doc.study!.loads[0])).toMatchObject({ type: 'force', value: 500, dir: null, faces: [{ name: 'f1:side:bl4' }] });

  // Run: the plot, its legend and the summary.
  await page.locator('[data-cmd="fea:run"]').click();
  await expect(page.locator('.fea-summary')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('.fea-legend')).toContainText('von Mises stress (MPa)');
  await expect(page.locator('.fea-legend')).toContainText('Yield strength: 415 MPa');
  const summary = page.locator('.fea-summary');
  await expect(summary).toContainText('Max von Mises stress');
  await expect(summary).toContainText('Min factor of safety');
  // Equilibrium: the reaction carries the 500 N.
  await expect(page.locator('.fea-forces')).toContainText('0.000, 500.000, 0.000 N');

  // Displacement plot, then a probe on the top of the base.
  await page.getByLabel('Plot', { exact: true }).selectOption('disp');
  await expect(page.locator('.fea-legend')).toContainText('Displacement (mm)');
  await page.getByLabel('Plot', { exact: true }).selectOption('vonMises');
  await page.getByRole('button', { name: 'Probe' }).click();
  p = await facePoint(page, 'f1:side:bl2');
  await page.mouse.click(p.x + 30, p.y);
  await expect(page.locator('.fea-probe')).toHaveCount(1);
  await expect(page.locator('.fea-probe')).toContainText('MPa');
  await expect(page.locator('.fea-pin')).toHaveCount(1);

  // Editing the study puts the results out of date.
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.fea-legend')).toHaveCount(0);
  await expect(page.getByRole('treeitem', { name: /^Results/ })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: /^Results/ })).not.toHaveAttribute('aria-description', /Out of date/);
  await page.evaluate(() => (window as unknown as W).__parametric.store.change('Edit', (d) => { d.study!.loads[0].value = 600; }));
  await expect(page.getByRole('treeitem', { name: /^Results/ })).toHaveAttribute('aria-description', /Out of date/);

  // Saved with the part, and read back.
  await page.evaluate(() => (window as unknown as W).__parametric.commands.run('save'));
  const saveAs = page.getByRole('dialog', { name: 'Save As' });
  if (await saveAs.isVisible().catch(() => false)) await saveAs.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveTitle(/Mounting Bracket - Parametric/);
  const saved = await page.evaluate(async (url) => {
    const { loadText } = await import(url);
    const a = (window as unknown as W).__parametric;
    return JSON.parse(await loadText(a.location!));
  }, '/src/platform/files.ts');
  expect(saved.study.fixtures).toHaveLength(1);
  expect(saved.study.loads[0]).toMatchObject({ type: 'force', value: 600 });
  expect(saved.material).toMatchObject({ name: 'Alloy Steel', E: 205000 });
  await page.evaluate(async ({ text, url }) => {
    const a = (window as unknown as W).__parametric;
    const { parseDocument } = await import(url) as typeof import('../../src/model/document');
    a.loadDocument(parseDocument(text), null);
  }, { text: JSON.stringify(saved), url: '/src/model/document.ts' });
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await expect(page.getByRole('treeitem', { name: /^Force-1/ })).toBeVisible();
  await page.locator('[data-cmd="fea:run"]').click();
  await expect(page.locator('.fea-summary')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('.fea-forces')).toContainText('0.000, 600.000, 0.000 N');
  expect(errors).toEqual([]);
});

test('explains a study that cannot run', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.waitForFunction(() => !!(window as unknown as W).__parametric.bbox);
  await page.getByRole('tab', { name: 'Analysis' }).click();
  // No fixtures: the results panel says what is missing.
  await page.locator('[data-cmd="fea:force"]').click();
  const p = await facePoint(page, 'f1:side:bl4');
  await page.mouse.click(p.x, p.y);
  await page.locator('.confirm-corner .ok').click();
  await page.locator('[data-cmd="fea:run"]').click();
  await expect(page.getByRole('alert').filter({ hasText: 'Add a fixture' })).toBeVisible();
  // A roller alone leaves the part free to slide: unstable.
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('[data-cmd="fea:roller"]').click();
  const q = await facePoint(page, 'f1:side:bl1');
  await page.mouse.click(q.x, q.y);
  await page.locator('.confirm-corner .ok').click();
  await page.locator('[data-cmd="fea:run"]').click();
  await expect(page.getByRole('alert').filter({ hasText: /unstable/ })).toBeVisible({ timeout: 60_000 });
  expect(errors).toEqual([]);
});

/** The bracket with Alloy Steel and a study holding one fixture and one force (set in the document, one undo step). */
async function bracketStudy(page: Page) {
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await page.waitForFunction(() => !!(window as unknown as W).__parametric.bbox);
  await page.evaluate(async () => {
    const a = (window as unknown as W).__parametric;
    await a.whenBuilt();
    const ref = (n: string) => { const f = a.faces.find((x) => x.name === n)!; return { name: f.name, sig: { type: f.type, c: f.center, n: f.normal, area: f.area } }; };
    a.store.change('Set up', (d) => {
      d.material = { name: 'Alloy Steel', density: 7700, E: 205000, nu: 0.29, yield: 415, uts: 655 };
      d.study = { id: 'st900', name: 'Static Study', fixtures: [{ id: 'fx901', name: 'Fixed-1', type: 'fixed', faces: [ref('f1:side:bl1')] }], loads: [{ id: 'ld902', name: 'Force-1', type: 'force', faces: [ref('f1:side:bl4')], value: 500, dir: null, flip: false }], mesh: { fineness: 0.2 } };
    });
  });
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await expect(page.getByRole('treeitem', { name: /^Force-1/ })).toBeVisible();
}

test('a load direction to pick stays chosen until it is picked', async ({ page }) => {
  const errors = await openApp(page);
  await bracketStudy(page);
  // "Along a picked edge or face" stays chosen while the edge is picked.
  for (const cmd of ['fea:force', 'fea:gravity']) {
    await page.locator(`[data-cmd="${cmd}"]`).click();
    const dir = page.getByLabel('Direction', { exact: true });
    await dir.selectOption('ref');
    await expect(page.getByRole('group', { name: 'Direction reference' })).toBeVisible();
    await expect(dir).toHaveValue('ref');
    if (cmd === 'fea:gravity') {
      await page.locator('.confirm-corner .ok').click();
      await expect(page.locator('.pm-msg')).toContainText('Pick an edge or face for the direction');
    }
    await page.locator('.confirm-corner .cancel').click();
  }
  expect(errors).toEqual([]);
});

test('the panel of a fixture or load closes when it is deleted', async ({ page }) => {
  const errors = await openApp(page);
  await bracketStudy(page);
  // Editing Force-1 when it is deleted (here by Undo of its study): OK must not bring it back.
  await page.getByRole('treeitem', { name: /^Force-1/ }).dblclick();
  await expect(page.locator('.pm-head').getByText('Force-1', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as W).__parametric.store.change('Delete Force-1', (d) => { d.study!.loads = []; }));
  await expect(page.locator('.pm-head')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as W).__parametric.store.doc.study!.loads)).toEqual([]);
  // A new fixture when the study goes (Undo): its panel closes too.
  await page.locator('[data-cmd="fea:fixed"]').click();
  await expect(page.locator('.pm-head').getByText('Fixed', { exact: true })).toBeVisible();
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Meta+z');
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__parametric.store.doc.study ?? null)).toBeNull();
  await expect(page.locator('.pm-head')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the results panel shows the progress of the first run, with Cancel', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await openApp(page);
  await bracketStudy(page);
  await page.evaluate(() => (window as unknown as W).__parametric.store.change('Finer', (d) => { d.study!.mesh.fineness = 0.7; }));
  await page.locator('[data-cmd="fea:run"]').click();
  const bar = page.getByRole('progressbar', { name: 'Analysis progress' });
  await expect(bar).toBeVisible();
  await expect(page.locator('.fea-stage')).not.toBeEmpty();
  await page.locator('.pm-content').getByRole('button', { name: 'Cancel' }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.getByText('Run the study to see its results.')).toBeVisible();
  await expect(page.locator('.statusbar .msg')).toHaveText('Analysis cancelled');
  // Mesh Now in the study panel shows its progress too.
  await page.locator('[data-cmd="fea:study"]').click();
  // The cancelled run may have finished meshing before it was cancelled (its mesh's stats stay shown).
  const statsBefore = await page.locator('.fea-stats').count();
  await page.getByRole('button', { name: 'Mesh Now' }).click();
  await expect(page.getByRole('progressbar', { name: 'Progress' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mesh Now' })).toBeDisabled();
  // It can be cancelled there (no new mesh is shown), and meshed again.
  await page.locator('.pm-content').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('progressbar', { name: 'Progress' })).toHaveCount(0);
  await expect(page.locator('.fea-stats')).toHaveCount(statsBefore);
  await expect(page.locator('.statusbar .msg')).toHaveText('Analysis cancelled');
  await page.getByRole('button', { name: 'Mesh Now' }).click();
  await expect(page.locator('.fea-stats')).toBeVisible({ timeout: 120_000 });
  expect(errors).toEqual([]);
});

test('a study edited while it runs leaves its results out of date', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await openApp(page);
  await bracketStudy(page);
  await page.evaluate(() => (window as unknown as W).__parametric.store.change('Finer', (d) => { d.study!.mesh.fineness = 0.7; }));
  await page.locator('[data-cmd="fea:run"]').click();
  // While the part is being meshed, the force goes from 500 to 900 N.
  await expect(page.locator('.fea-stage')).toContainText('Meshing', { timeout: 60_000 });
  await page.evaluate(() => (window as unknown as W).__parametric.store.change('Edit', (d) => { d.study!.loads[0].value = 900; }));
  await expect(page.locator('.fea-summary')).toBeVisible({ timeout: 120_000 });
  // Solved with 500 N: shown as out of date.
  await expect(page.locator('.fea-forces')).toContainText('0.000, 500.000, 0.000 N');
  await expect(page.getByRole('note').filter({ hasText: 'Out of date' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run Again' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('results stay up to date when the part is edited back to the shape solved', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await openApp(page);
  await bracketStudy(page);
  await page.locator('[data-cmd="fea:run"]').click();
  await expect(page.locator('.fea-summary')).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const results = page.getByRole('treeitem', { name: /^Results/ });
  await expect(results).not.toHaveAttribute('aria-description', /Out of date/);
  // A feature opened for editing and cancelled: the same shape.
  const v0 = await page.evaluate(() => (window as unknown as W).__parametric.geometryVersion);
  await page.getByRole('treeitem', { name: /^Extrude1/ }).dblclick();
  await expect(page.locator('.pm-head').getByText('Extrude1')).toBeVisible();
  await page.locator('.confirm-corner .cancel').click();
  await expect(page.locator('.pm-head')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as W).__parametric.whenBuilt());
  expect(await page.evaluate(() => (window as unknown as W).__parametric.geometryVersion)).toBeGreaterThan(v0);
  await expect(results).not.toHaveAttribute('aria-description', /Out of date/);
  // A new shape puts them out of date; Undo brings the solved shape back.
  await page.evaluate(() => {
    const a = (window as unknown as W).__parametric;
    a.store.change('Deeper', (d) => { const f = d.features.find((x) => x.name === 'Extrude1') as unknown as { depth: number }; f.depth = 33.3; });
  });
  await expect(results).toHaveAttribute('aria-description', /Out of date/);
  await page.keyboard.press('Meta+z');
  await expect(results).not.toHaveAttribute('aria-description', /Out of date/);
  expect(errors).toEqual([]);
});

test('loads of an inch part are in pounds-force and psi, with round defaults', async ({ page }) => {
  const errors = await openApp(page);
  await bracketStudy(page);
  await page.evaluate(() => (window as unknown as W).__parametric.store.change('Units', (d) => { d.units = 'IPS'; }));
  await page.locator('[data-cmd="fea:force"]').click();
  await expect(page.getByLabel('Total force (lbf)')).toHaveValue('100');
  await page.locator('.confirm-corner .cancel').click();
  await page.locator('[data-cmd="fea:pressure"]').click();
  await expect(page.getByLabel('Pressure (psi)')).toHaveValue('100');
  await page.locator('.confirm-corner .cancel').click();
  await page.locator('[data-cmd="fea:gravity"]').click();
  await expect(page.getByLabel('Acceleration (in/s²)')).toHaveValue('386.08858');
  await page.locator('.confirm-corner .cancel').click();
  // Force-1 (500 N) reads in lbf, and a value typed in lbf is kept in newtons.
  await page.getByRole('treeitem', { name: /^Force-1/ }).dblclick();
  await expect(page.getByLabel('Total force (lbf)')).toHaveValue('112.40447');
  await page.getByLabel('Total force (lbf)').fill('50');
  await page.locator('.confirm-corner .ok').click();
  await expect(page.locator('.pm-head')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as W).__parametric.store.doc.study!.loads[0].value)).toBeCloseTo(222.411, 3);
  expect(errors).toEqual([]);
});

test('the printable report says what its plot shows', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await openApp(page);
  await bracketStudy(page);
  await page.locator('[data-cmd="fea:run"]').click();
  await expect(page.locator('.fea-summary')).toBeVisible({ timeout: 120_000 });
  await page.getByLabel('Plot', { exact: true }).selectOption('disp');
  await page.getByRole('button', { name: 'Report...' }).click();
  const popup = page.waitForEvent('popup');
  await page.getByRole('dialog', { name: 'Results Report' }).getByRole('button', { name: 'Printable Report' }).click();
  const report = await popup;
  await report.evaluate(() => { window.print = () => {}; });
  await expect(report.locator('figcaption')).toContainText(/^Displacement from 0 mm to 0\.\d+ mm \(blue lowest, red highest\); deformation scale \d+/);
  await expect(report.locator('img')).toHaveAttribute('alt', /^Displacement from/);
  await report.close();
  expect(errors).toEqual([]);
});

test('the fixture and load symbols follow the part when it is edited', async ({ page }) => {
  const errors = await openApp(page);
  await bracketStudy(page);
  // Highest Z of the tinted faces of the fixtures and loads.
  const top = () => page.evaluate(() => {
    const r = (window as unknown as W).__parametric.renderer as unknown as { tris: Map<string, { positions: Float32Array }> };
    const p = r.tris.get('feaFix')?.positions;
    let z = -Infinity;
    for (let i = 2; p && i < p.length; i += 3) z = Math.max(z, p[i]);
    return z;
  });
  await expect.poll(top).toBeCloseTo(30, 3);
  await page.evaluate(() => (window as unknown as W).__parametric.store.change('Deeper', (d) => { (d.features.find((x) => x.name === 'Extrude1') as unknown as { depth: number }).depth = 80; }));
  await expect.poll(top).toBeCloseTo(80, 3);
  expect(errors).toEqual([]);
});

test('a part with a study opened while the Analysis tab is shown shows its fixtures and loads', async ({ page, browser }) => {
  const errors = await openApp(page);
  await bracketStudy(page);
  const text = await page.evaluate(async (url) => {
    const { serializeDocument } = await import(url) as typeof import('../../src/model/document');
    return serializeDocument((window as unknown as W).__parametric.store.doc);
  }, '/src/model/document.ts');
  // A new window, where the analysis has not been loaded yet.
  const other = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const otherErrors = await openApp(other);
  await other.getByRole('button', { name: /New part/ }).click();
  await other.getByRole('tab', { name: 'Analysis' }).click();
  await other.evaluate(async ({ text, url }) => {
    const { parseDocument } = await import(url) as typeof import('../../src/model/document');
    (window as unknown as W).__parametric.loadDocument(parseDocument(text), null);
  }, { text, url: '/src/model/document.ts' });
  await expect(other.getByRole('tab', { name: 'Analysis' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => other.evaluate(() => ((window as unknown as W).__parametric.renderer as unknown as { tris: Map<string, unknown> }).tris.has('feaFix'))).toBe(true);
  await other.context().close();
  expect(errors).toEqual([]);
  expect(otherErrors).toEqual([]);
});
