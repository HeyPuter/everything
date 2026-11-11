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
