import { expect, test, type Page } from '@playwright/test';
import { openApp, waitForFeature } from './helpers';

type Kernel = {
  debugFail(mode: 'hang' | 'abort' | 'crash'): Promise<void>;
  massProperties(): Promise<{ volume: number } | null>;
  stallMs: number;
};
type W = { __parametric: { kernel: Kernel; whenBuilt(): Promise<void> }; __hung?: Promise<string> };

/** Volume computed by the (possibly restarted) worker once it has rebuilt the part. */
const volume = (page: Page) => page.evaluate(async () => {
  const app = (window as unknown as W).__parametric;
  await app.whenBuilt();
  return (await app.kernel.massProperties())?.volume ?? null;
});

test('the geometry engine is restarted and the part rebuilt when the worker dies, aborts or hangs', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  const v0 = await volume(page);
  expect(v0).toBeGreaterThan(0);
  const restarted = page.locator('.toast', { hasText: 'Geometry engine restarted' });

  for (const mode of ['crash', 'abort'] as const) {
    const msg = await page.evaluate((mode) => (window as unknown as W).__parametric.kernel.debugFail(mode).then(() => 'answered', (e: Error) => e.message), mode);
    if (mode === 'abort') expect(msg).toBe('The geometry kernel failed');
    await expect(restarted).toBeVisible();
    expect(await volume(page)).toBeCloseTo(v0!, 3);
    await restarted.getByRole('button', { name: 'Dismiss notification' }).click();
  }

  // A request that never answers: the user is offered a restart, and the
  // request rejects instead of waiting forever.
  await page.evaluate(() => {
    const w = window as unknown as W;
    w.__parametric.kernel.stallMs = 500;
    w.__hung = w.__parametric.kernel.debugFail('hang').then(() => 'answered', (e: Error) => e.message);
  });
  const stall = page.locator('.toast', { hasText: 'taking a long time' });
  await stall.getByRole('button', { name: 'Restart engine' }).click();
  expect(await page.evaluate(() => (window as unknown as W).__hung)).toMatch(/restarted because it stopped responding/);
  await expect(restarted).toBeVisible();
  expect(await volume(page)).toBeCloseTo(v0!, 3);
  await expect(page.locator('.ti.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an imported body is rebuilt after the geometry engine restarts', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  const v0 = await volume(page);
  // Import the bracket's own STEP into a new part.
  await page.evaluate(async () => {
    type A = W['__parametric'] & { kernel: { exportFile(f: 'step'): Promise<Uint8Array> }; newDocument(n: string): void; insertFeature(f: unknown): void; store: { doc: { blobs: Record<string, string> } } };
    const app = (window as unknown as { __parametric: A }).__parametric;
    const step = new TextDecoder().decode(await app.kernel.exportFile('step'));
    app.newDocument('Imported');
    app.store.doc.blobs.bx = step;
    app.insertFeature({ id: 'f9', name: 'Import1', type: 'import', format: 'step', blob: 'bx', fileName: 'bracket.step' });
  });
  await waitForFeature(page, 'Import1');
  expect(await volume(page)).toBeCloseTo(v0!, 1);
  await page.evaluate(() => (window as unknown as W).__parametric.kernel.debugFail('crash').catch(() => undefined));
  await expect(page.locator('.toast', { hasText: 'Geometry engine restarted' })).toBeVisible();
  // The new worker was given the file data again.
  expect(await volume(page)).toBeCloseTo(v0!, 1);
  await expect(page.locator('.ti.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a rebuild that leaves the body unchanged does not resend or re-upload its mesh', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  type A = W['__parametric'] & {
    renderer: { setModel(...a: unknown[]): void; modelMesh: unknown };
    store: { change(label: string, fn: (d: { features: { name: string; type: string; radius?: number }[] }) => void): void };
  };
  const uploads = () => page.evaluate(async () => {
    const app = (window as unknown as { __parametric: A }).__parametric;
    await app.whenBuilt();
    return (window as unknown as { __uploads: number }).__uploads;
  });
  await page.evaluate(async () => {
    const app = (window as unknown as { __parametric: A }).__parametric;
    await app.whenBuilt();
    const w = window as unknown as { __uploads: number };
    w.__uploads = 0;
    const set = app.renderer.setModel.bind(app.renderer);
    app.renderer.setModel = (...a: unknown[]) => { w.__uploads++; set(...a); };
    app.store.change('Rename', (d) => { d.features.find((f) => f.type === 'fillet')!.name = 'Round'; });
  });
  await expect(page.getByRole('treeitem', { name: 'Round' })).toBeVisible();
  expect(await uploads()).toBe(0);
  expect(await page.evaluate(() => !!(window as unknown as { __parametric: A }).__parametric.renderer.modelMesh)).toBe(true);
  // A change to the body still updates it.
  await page.evaluate(() => (window as unknown as { __parametric: A }).__parametric.store.change('Radius', (d) => { d.features.find((f) => f.type === 'fillet')!.radius = 2; }));
  expect(await uploads()).toBe(1);
  expect(errors).toEqual([]);
});

test('a part opened again while its first build runs shows its body', async ({ page }) => {
  // The first build's result was dropped (another open replaced the part), but
  // the worker counted its mesh as sent: the second build said "unchanged" and
  // the empty part's view stayed under a full design tree.
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  type A = W['__parametric'] & {
    renderer: { modelMesh: unknown };
    kernel: { busy: boolean };
    store: { doc: unknown };
    newDocument(n: string): void;
    loadDocument(doc: unknown, location: null): void;
  };
  const shown = await page.evaluate(async () => {
    const app = (window as unknown as { __parametric: A }).__parametric;
    await app.whenBuilt();
    const doc = JSON.stringify(app.store.doc);
    app.newDocument('Empty');
    await app.whenBuilt();
    app.loadDocument(JSON.parse(doc), null);
    while (!app.kernel.busy) await new Promise((r) => setTimeout(r, 0));
    app.loadDocument(JSON.parse(doc), null);
    await app.whenBuilt();
    return !!app.renderer.modelMesh;
  });
  expect(shown).toBe(true);
  expect(errors).toEqual([]);
});

test('a geometry worker replaced for its memory leaves the part as it was, without a word', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  type K = Kernel & { worker: unknown; recycleBytes: number; baseHeap: number; busy: boolean };
  type A = { __parametric: { kernel: K; whenBuilt(): Promise<void>; renderer: { modelMesh: unknown }; store: { change(l: string, fn: (d: { features: { type: string; radius?: number }[] }) => void): void } } };
  const v0 = await volume(page);
  const replaced = await page.evaluate(async () => {
    const app = (window as unknown as A).__parametric;
    const first = app.kernel.worker;
    // As if the kernel had grown far past what the part needs.
    app.kernel.recycleBytes = 1;
    app.kernel.baseHeap = 1;
    app.store.change('Radius', (d) => { d.features.find((f) => f.type === 'fillet')!.radius = 2; });
    await app.whenBuilt();
    while (app.kernel.busy) await new Promise((r) => setTimeout(r, 10));
    return app.kernel.worker !== first;
  });
  expect(replaced).toBe(true);
  // The new worker has the part: an edit and the mass properties work on it.
  const v1 = await volume(page);
  // The inside corner fillet adds material: a smaller one less.
  expect(v1).toBeLessThan(v0!);
  await page.evaluate(() => (window as unknown as A).__parametric.store.change('Radius', (d) => { d.features.find((f) => f.type === 'fillet')!.radius = 4; }));
  expect(await volume(page)).toBeCloseTo(v0!, 3);
  expect(await page.evaluate(() => !!(window as unknown as A).__parametric.renderer.modelMesh)).toBe(true);
  await expect(page.locator('.toast', { hasText: 'restarted' })).toHaveCount(0);
  await expect(page.locator('.ti.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a worker that dies mid-build is replaced, the part rebuilt, and nothing stays waiting', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  type K = Kernel & { busy: boolean; restart(reason?: string): void; recycleBytes: number; baseHeap: number; worker: unknown };
  type A = { __parametric: { kernel: K; whenBuilt(): Promise<void>; bbox: { max: number[] } | null; store: { change(l: string, fn: (d: { features: { id: string; depth?: number }[] }) => void): void } } };
  // Killed while rebuilding an edit: the edit is built on the new worker.
  const top = await page.evaluate(async () => {
    const app = (window as unknown as A).__parametric;
    await app.whenBuilt();
    app.store.change('Depth', (d) => { d.features.find((f) => f.id === 'f1')!.depth = 60; });
    while (!app.kernel.busy) await new Promise((r) => setTimeout(r, 0));
    app.kernel.restart('of a test');
    await app.whenBuilt();
    return app.bbox?.max[2];
  });
  expect(top).toBeCloseTo(60, 6);
  await expect(page.locator('.toast', { hasText: 'Geometry engine restarted' })).toBeVisible();
  expect(await volume(page)).toBeGreaterThan(0);
  // Killed while a worker replaced for its memory rebuilds the part on its own:
  // no edit is waiting on that build, and the part is still built again.
  const v = await page.evaluate(async () => {
    const app = (window as unknown as A).__parametric;
    app.kernel.recycleBytes = 1;
    app.kernel.baseHeap = 1;
    const first = app.kernel.worker;
    app.store.change('Depth', (d) => { d.features.find((f) => f.id === 'f1')!.depth = 50; });
    await app.whenBuilt();
    while (app.kernel.worker === first) await new Promise((r) => setTimeout(r, 0));
    app.kernel.restart('of a test');
    await new Promise((r) => setTimeout(r, 50));
    await app.whenBuilt();
    while (app.kernel.busy) await new Promise((r) => setTimeout(r, 10));
    return (await app.kernel.massProperties())?.volume ?? null;
  });
  expect(v).toBeGreaterThan(0);
  await expect(page.locator('.ti.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('quick successive edits show the last one, never an older result after a newer one', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Mounting Bracket/ }).click();
  await waitForFeature(page, 'Fillet1');
  type A = { __parametric: { whenBuilt(): Promise<void>; bbox: { max: number[] } | null; applyBuild(res: { bbox: { max: number[] } | null }, ms: number): void; store: { change(l: string, fn: (d: { features: { id: string; depth?: number }[] }) => void): void } } };
  const shown = await page.evaluate(async () => {
    const app = (window as unknown as A).__parametric;
    await app.whenBuilt();
    const tops: number[] = [];
    const apply = app.applyBuild.bind(app);
    app.applyBuild = (res, ms) => { tops.push(res.bbox?.max[2] ?? 0); apply(res, ms); };
    // As typing 31, 32 ... 45 a keystroke at a time, without waiting for rebuilds.
    for (let depth = 31; depth <= 45; depth++) {
      app.store.change('Depth', (d) => { d.features.find((f) => f.id === 'f1')!.depth = depth; });
      await new Promise((r) => setTimeout(r, depth % 3 ? 0 : 15));
    }
    await app.whenBuilt();
    return { tops, final: app.bbox?.max[2] };
  });
  expect(shown.final).toBeCloseTo(45, 6);
  expect(shown.tops[shown.tops.length - 1]).toBeCloseTo(45, 6);
  // Each shown result is newer than the one before.
  for (let i = 1; i < shown.tops.length; i++) expect(shown.tops[i]).toBeGreaterThan(shown.tops[i - 1]);
  expect(errors).toEqual([]);
});
