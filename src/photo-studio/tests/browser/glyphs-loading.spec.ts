import { expect, test } from '@playwright/test';
import { boot, idle, openImage, panel, run } from './helpers';

for (const failure of ['HTTP error', 'network error']) test(`Glyphs reports and retries a ${failure}`, async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 200, '#ffffff');
  // Keep the panel request independent from missing-glyph protection prefetches.
  await page.evaluate(() => { window.photoStudio.preferences.missingGlyphProtection = false; });
  await run(page, 'type.add');
  await page.keyboard.insertText('ab');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let requests = 0;
  let fail = true;
  await page.route('**/fonts/caveat/*.woff', async (route) => {
    requests++;
    if (!fail) return route.continue();
    if (failure === 'HTTP error') await route.fulfill({ status: 503, body: 'Unavailable' });
    else await route.abort('failed');
  });
  await page.evaluate(() => window.photoStudio.dock.show('glyphs'));
  const body = await panel(page, 'Glyphs');
  await expect(body.locator('.gl-grid [data-cp="38"]')).toBeVisible();
  await body.locator('select[aria-label="Font family"]').selectOption('Caveat');
  await expect.poll(() => requests).toBe(1);
  await expect(body.locator('.gl-grid .gl-cell')).toHaveCount(0);
  await expect(body.locator('.gl-info')).toHaveText('Could not load glyphs. Try again.', { timeout: 5000 });
  const retry = body.getByRole('button', { name: 'Retry', exact: true });
  await expect(retry).toBeVisible();
  // Unrelated document updates must not hammer a failed resource.
  await page.evaluate(() => { for (let i = 0; i < 5; i++) window.photoStudio.update(); });
  expect(requests).toBe(1);
  fail = false;
  await retry.click();
  await expect(body.locator('.gl-grid [data-cp="38"]')).toBeVisible();
  expect(requests).toBe(2);
  expect(await body.locator('.gl-grid .gl-cell').count()).toBeGreaterThan(200);
  await expect(body.locator('.gl-info')).not.toContainText('Could not load');
  await expect(retry).toHaveCount(0);
  await body.locator('.gl-grid [data-cp="38"]').dblclick();
  await idle(page);
  const text = () => page.evaluate(() => window.photoStudio.doc.layers.at(-1)!.text);
  expect(await text()).toBe('ab&');
  expect(await page.evaluate(() => {
    const m = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType;
    return m.currentSession()!.data.content.paragraphs[0].runs.map((r) => [r.text, r.style.family]);
  })).toEqual([['ab', 'Inter'], ['&', 'Caveat']]);
  await run(page, 'edit.undo');
  expect(await text()).toBe('ab');
  await run(page, 'edit.redo');
  expect(await text()).toBe('ab&');
  expect(errors).toEqual([]);
});

for (const next of ['retry again', 'change category', 'change font']) test(`a failed glyph retry supports ${next}`, async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 200, '#ffffff');
  let requests = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/fonts/caveat/*.woff', async (route) => {
    requests++;
    if (requests === 1) return route.fulfill({ status: 503, body: 'Unavailable' });
    if (requests === 2) {
      await pending;
      if (next !== 'change category') return route.fulfill({ status: 503, body: 'Still unavailable' });
    }
    await route.continue();
  });
  await page.evaluate(() => window.photoStudio.dock.show('glyphs'));
  const body = await panel(page, 'Glyphs');
  await expect(body.locator('.gl-grid [data-cp="38"]')).toBeVisible();
  await body.locator('select[aria-label="Font family"]').selectOption('Caveat');
  const retry = body.getByRole('button', { name: 'Retry', exact: true });
  await expect(retry).toBeVisible();
  // Enter must work on the recovery button as well as a mouse click.
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => requests).toBe(2);
  await expect(body.getByRole('button', { name: 'Retrying…', exact: true })).toBeDisabled();
  await expect(body.locator('.gl-info')).toHaveText('Loading glyphs…');
  await page.evaluate(() => { for (let i = 0; i < 5; i++) window.photoStudio.update(); });
  expect(requests).toBe(2);
  if (next === 'change category') await body.locator('select[aria-label="Show"]').selectOption('currency');
  if (next === 'change font') {
    await body.locator('select[aria-label="Font family"]').selectOption('Inter');
    await expect(body.locator('.gl-grid [data-cp="38"]')).toBeVisible();
  }
  const response = page.waitForResponse('**/fonts/caveat/*.woff');
  release();
  await (await response).finished();
  await idle(page);
  if (next === 'retry again') {
    await expect(retry).toBeEnabled();
    await expect(body.locator('.gl-info')).toHaveText('Could not load glyphs. Try again.');
    await retry.click();
    await expect(body.locator('.gl-grid [data-cp="38"]')).toBeVisible();
    expect(requests).toBe(3);
  } else if (next === 'change category') {
    await expect(body.locator('.gl-grid [data-cp="36"]')).toBeVisible();
    await expect(body.locator('.gl-grid [data-cp="65"]')).toHaveCount(0);
    await expect(body.locator('select[aria-label="Show"]')).toHaveValue('currency');
    expect(requests).toBe(2);
  } else {
    // The old failure has settled and must not overwrite the newer font.
    await expect(body.locator('select[aria-label="Font family"]')).toHaveValue('Inter');
    await expect(body.locator('.gl-grid [data-cp="38"]')).toBeVisible();
    expect(requests).toBe(2);
  }
  await expect(retry).toHaveCount(0);
  await expect(body.locator('.gl-info')).not.toContainText('Could not load');
});

test('a genuinely empty glyph category stays distinct from a load error', async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 200, '#ffffff');
  await page.evaluate(() => window.photoStudio.dock.show('glyphs'));
  const body = await panel(page, 'Glyphs');
  await body.locator('select[aria-label="Font family"]').selectOption('Caveat');
  await expect(body.locator('.gl-grid [data-cp="38"]')).toBeVisible();
  await body.locator('select[aria-label="Show"]').selectOption('greek');
  await expect(body.locator('.gl-grid')).toHaveText('No glyphs in this category.');
  await expect(body.locator('.gl-info')).toHaveText('0 glyphs');
  await expect(body.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await body.locator('select[aria-label="Show"]').selectOption('all');
  await expect(body.locator('.gl-grid [data-cp="38"]')).toBeVisible();
});
