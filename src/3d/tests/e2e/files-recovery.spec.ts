import { test, expect, type Page } from '@playwright/test';
import { trackErrors, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Open the app the way a user does (with session recovery, not ?factory-startup). */
async function start(page: Page) {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).app);
  await page.evaluate(() => (window as any).appReady);
  return errors;
}

const cubeName = (page: Page) => page.evaluate(() => (Object.values((window as any).app.doc.objects) as any[]).find((o) => o.type === 'MESH')?.name);

/** Rename the cube and write this tab's auto save now. */
async function editAndAutosave(page: Page, name: string) {
  await page.evaluate(async (name) => {
    const a = (window as any).app;
    (Object.values(a.doc.objects) as any[]).find((o) => o.type === 'MESH').name = name;
    a.pushUndo('Rename');
    a.changed('doc');
    const { autosave } = await import('/src/io/files.ts');
    await autosave();
  }, name);
}

test('a new start recovers the last auto saved session', async ({ context }) => {
  const a = await context.newPage();
  const errA = await start(a);
  await editAndAutosave(a, 'Before');
  await a.close();
  const b = await context.newPage();
  const errB = await start(b);
  // startup work (fonts loading) re-evaluates the scene, which is not an edit of the new tab
  await expect.poll(() => cubeName(b)).toBe('Before');
  expect(await b.evaluate(() => (window as any).app.dirty)).toBe(true);
  await expectNoErrors([...errA, ...errB]);
});

test('every tab auto saves into its own slot; a new tab recovers a closed one, never a live one', async ({ context }) => {
  const a = await context.newPage();
  const errA = await start(a);
  await editAndAutosave(a, 'FromA');

  // a second tab while the first is open starts fresh and does not overwrite the first one's session
  const b = await context.newPage();
  const errB = await start(b);
  expect(await cubeName(b)).toBe('Cube');
  await editAndAutosave(b, 'FromB');
  await editAndAutosave(a, 'FromA2');

  // the first tab is closed (or crashes): the next tab gets its work back
  await a.close();
  const c = await context.newPage();
  const errC = await start(c);
  await expect.poll(() => cubeName(c)).toBe('FromA2');
  expect(await c.evaluate(() => (window as any).app.reports.some((r: any) => r.message === 'Recovered the last autosaved session'))).toBe(true);

  // the other tab's session stays on offer in Recover ▸ Auto Save once that tab is gone
  await b.close();
  const offered = await c.evaluate(async () => {
    const { listSnapshots } = await import('/src/io/session.ts');
    return (await listSnapshots()).filter((s: any) => s.recovery).map((s: any) => s.name);
  });
  expect(offered.length).toBe(1);
  const opened = await c.evaluate(async () => {
    const { listSnapshots, openSnapshot } = await import('/src/io/session.ts');
    const s = (await listSnapshots()).find((x: any) => x.recovery)!;
    return openSnapshot(s);
  });
  expect(opened).toBe(true);
  expect(await cubeName(c)).toBe('FromB');

  // a reloaded tab gets its own session back
  await editAndAutosave(c, 'FromC');
  await c.reload();
  await c.waitForFunction(() => !!(window as any).app);
  await c.evaluate(() => (window as any).appReady);
  await expect.poll(() => cubeName(c)).toBe('FromC');
  await expectNoErrors([...errA, ...errB, ...errC]);
});
