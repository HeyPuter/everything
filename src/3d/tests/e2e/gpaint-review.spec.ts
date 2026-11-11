// Grease Pencil and paint / sculpt modes: regressions found in review (real pointer input).
import { test, expect, type Page } from '@playwright/test';
import { openApp, viewportCenter, expectNoErrors } from './helpers';

const ev = <T>(page: Page, fn: () => T | Promise<T>) => page.evaluate(fn as never) as Promise<T>;

async function emptyGP(page: Page, mode = 'PAINT_GREASE_PENCIL') {
  await page.evaluate((m) => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    a.run('object.select_all', { action: 'SELECT' }, { invoke: false });
    a.run('object.delete', {}, { invoke: false });
    a.run('object.grease_pencil_add', { type: 'EMPTY' }, { invoke: false });
    a.run('object.mode_set', { mode: m }, { invoke: false });
  }, mode);
  await page.waitForTimeout(100);
}

const gpPoints = (page: Page) =>
  ev(page, () => {
    const a = (window as any).app; // eslint-disable-line @typescript-eslint/no-explicit-any
    const g = a.doc.grease_pencils[a.activeObject.data];
    return g.drawings.reduce((n: number, d: { position: ArrayLike<number> }) => n + d.position.length / 3, 0) as number;
  });

test('Esc during a Draw stroke drops the live preview', async ({ page }) => {
  const errors = await openApp(page);
  await emptyGP(page);
  const { x, y } = await viewportCenter(page);
  await page.mouse.move(x - 100, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x - 100 + i * 10, y);
  await page.waitForTimeout(50);
  const shown = () => ev(page, async () => (await import('/src/greasepencil/render.ts' as string)).strokePreviewObject());
  expect(await shown()).not.toBeNull();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await shown()).toBeNull();
  expect(await gpPoints(page)).toBe(0);
  await expectNoErrors(errors);
});
