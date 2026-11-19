import { expect, test, type Page } from '@playwright/test';
import { boot, historyLabels, idle, openImage, run } from './helpers';

// View → Quick Compare: a before/after view that never changes the document.

test.beforeEach(async ({ page }) => {
  await boot(page);
  await openImage(page, 600, 400, '#3060c0', 'blue.png');
  // One edit to compare against: the inverted image.
  await run(page, 'adjust.invert');
  await expect.poll(() => historyLabels(page)).toEqual(['Invert']);
});

/** RGBA of the cached stored-state canvas at a document point. */
async function beforePixel(page: Page, x: number, y: number) {
  return page.evaluate(
    ([x, y]) => {
      const c = document.querySelector<HTMLCanvasElement>(
        '#stage .compare-before, .compare-stage .compare-before',
      )!;
      const k = c.width / window.photoStudio.doc.width;
      return Array.from(
        c.getContext('2d')!.getImageData(Math.floor(x * k), Math.floor(y * k), 1, 1).data,
      );
    },
    [x, y] as const,
  );
}
const near = (a: number[], b: number[], tol = 3) =>
  a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tol);
const snapshot = (page: Page) =>
  page.evaluate(() => {
    const e = window.photoStudio;
    (window as unknown as { __doc: unknown }).__doc = e.doc;
    return {
      json: JSON.stringify(e.doc),
      labels: e.history.labels,
      position: e.history.position,
      dirty: e.session.dirty,
    };
  });

test('compares with the opened state, drags the divider, switches state and exits without changing the document', async ({
  page,
}) => {
  const before = await snapshot(page);
  await run(page, 'view.quick-compare');
  const bar = page.getByRole('toolbar', { name: 'Quick Compare' });
  await expect(bar).toBeVisible();
  await expect(page.locator('#stage .compare-before')).toHaveCount(1);
  // The stored state is the opened (blue) image; the canvas shows the edit.
  await expect.poll(async () => near(await beforePixel(page, 300, 200), [48, 96, 192])).toBe(true);
  await expect(bar.getByRole('combobox', { name: 'Compare with' })).toHaveValue('opened');
  await expect(page.locator('.compare-label').filter({ hasText: 'Before' })).toContainText(
    'Opened state',
  );

  // Drag the divider from the middle to a quarter of the window.
  const divider = page.getByRole('slider', { name: /Divider/ });
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
  const clipAtHalf = await page
    .locator('#stage .compare-before')
    .evaluate((c) => (c as HTMLElement).style.clipPath);
  expect(clipAtHalf).toMatch(/^polygon\(/);
  const vp = (await page.locator('#viewport').boundingBox())!;
  const knob = (await divider.locator('.compare-knob').boundingBox())!;
  await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2);
  await page.mouse.down();
  await page.mouse.move(vp.x + vp.width * 0.25, knob.y + knob.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => Number(await divider.getAttribute('aria-valuenow')))
    .toBeLessThan(30);
  expect(
    await page.locator('#stage .compare-before').evaluate((c) => (c as HTMLElement).style.clipPath),
  ).not.toBe(clipAtHalf);
  // Keys move it too.
  await divider.focus();
  await page.keyboard.press('End');
  await expect(divider).toHaveAttribute('aria-valuenow', '100');

  // Switch to the history state after the edit: the stored side shows the inverted image.
  await bar
    .getByRole('combobox', { name: 'Compare with' })
    .selectOption({ label: 'Invert (current)' });
  await expect.poll(async () => near(await beforePixel(page, 300, 200), [207, 159, 63])).toBe(true);
  await expect(page.locator('.compare-label').filter({ hasText: 'Before' })).toContainText(
    'Invert',
  );

  // Escape finishes; nothing about the document or its history changed.
  await page.locator('#viewport').focus();
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
  await expect(page.locator('.compare-before')).toHaveCount(0);
  const after = await page.evaluate(() => {
    const e = window.photoStudio;
    return {
      json: JSON.stringify(e.doc),
      labels: e.history.labels,
      position: e.history.position,
      dirty: e.session.dirty,
      same: e.doc === (window as unknown as { __doc: unknown }).__doc,
    };
  });
  expect(after).toEqual({ ...before, same: true });
});

test('side by side, press and hold, snapshots and the \\ key', async ({ page }) => {
  const before = await snapshot(page);
  // A snapshot of the inverted state, then one more edit.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { sessionSnapshots } = await import('/src/features/history-tools.ts');
    sessionSnapshots(e).push({ id: crypto.randomUUID(), name: 'Inverted', doc: e.doc });
    e.update();
  });
  await run(page, 'adjust.invert');
  await page.locator('#viewport').focus();
  await page.keyboard.press('Backslash');
  await idle(page);
  const bar = page.getByRole('toolbar', { name: 'Quick Compare' });
  await expect(bar).toBeVisible();
  const select = bar.getByRole('combobox', { name: 'Compare with' });
  await select.selectOption({ label: 'Inverted' });
  await expect.poll(async () => near(await beforePixel(page, 300, 200), [207, 159, 63])).toBe(true);

  // Side by side: the live window takes half the width, the pane shows the stored state.
  const full = (await page.locator('#viewport').boundingBox())!.width;
  await bar.getByRole('radio', { name: 'Side by side' }).click();
  await expect(page.locator('.compare-pane')).toBeVisible();
  await expect(page.locator('.compare-stage .compare-before')).toHaveCount(1);
  await expect
    .poll(async () => (await page.locator('#viewport').boundingBox())!.width)
    .toBeLessThan(full * 0.6);
  // The pane and the window show the same view.
  const t = await page.evaluate(() => [
    document.querySelector<HTMLElement>('#stage')!.style.transform,
    document.querySelector<HTMLElement>('.compare-stage')!.style.transform,
  ]);
  expect(t[0]).toBe(t[1]);

  // Press and hold: the stored state shows only while pressed.
  await bar.getByRole('radio', { name: 'Press and hold' }).click();
  await expect(page.locator('.compare-pane')).toBeHidden();
  await expect
    .poll(async () => (await page.locator('#viewport').boundingBox())!.width)
    .toBeCloseTo(full, 0);
  const canvas = page.locator('#stage .compare-before');
  await expect(canvas).toBeHidden();
  const vp = (await page.locator('#viewport').boundingBox())!;
  await page.mouse.move(vp.x + vp.width / 2, vp.y + vp.height / 2);
  await page.mouse.down();
  await expect(canvas).toBeVisible();
  await page.mouse.up();
  await expect(canvas).toBeHidden();

  // The menu item shows the view is on; \ turns it off again.
  expect(
    await page.evaluate(async () =>
      (await import('/src/app/registry.ts')).commands.get('view.quick-compare')!.checked!(
        window.photoStudio,
      ),
    ),
  ).toBe(true);
  await page.locator('#viewport').focus();
  await page.keyboard.press('Backslash');
  await expect(bar).toBeHidden();
  const labels = await historyLabels(page);
  expect(labels).toEqual([...before.labels, 'Invert']);
});
