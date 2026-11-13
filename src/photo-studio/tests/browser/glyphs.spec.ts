import { test, expect } from '@playwright/test';
import { boot, idle, openImage, panel, run } from './helpers';

const text = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => {
    const { session } = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType;
    const { plainText } = await import('/src/imaging/text/model.ts');
    return session ? plainText(session.data.content) : null;
  });

test('Glyphs panel lists the font’s characters and inserts them into text', async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 200, '#ffffff');
  await page.evaluate(() => window.photoStudio.runCommand('type.add'));
  await expect.poll(() => text(page)).toBe('');
  await page.keyboard.type('Cafe');
  await expect.poll(() => text(page)).toBe('Cafe');
  // Remove the plain "e" and insert "é" from the Glyphs panel.
  await page.keyboard.press('Backspace');
  await page.evaluate(() => window.photoStudio.dock.show('glyphs'));
  const body = await panel(page, 'Glyphs');
  await expect(body.locator('select[aria-label="Font family"]')).toHaveValue('Inter');
  const cell = body.locator('.gl-grid [data-cp="233"]');
  await expect(cell).toBeVisible();
  expect(await body.locator('.gl-grid .gl-cell').count()).toBeGreaterThan(200);
  await cell.dblclick();
  await expect.poll(() => text(page)).toBe('Café');
  // The glyph joins Recently Used and the filter narrows the grid.
  await expect(body.locator('.gl-recent [data-cp="233"]')).toHaveCount(1);
  await body.locator('select[aria-label="Show"]').selectOption('currency');
  await expect(body.locator('.gl-grid [data-cp="8364"]')).toHaveCount(1);
  await expect(body.locator('.gl-grid [data-cp="65"]')).toHaveCount(0);
  await body.locator('.gl-grid [data-cp="8364"]').dblclick();
  await expect.poll(() => text(page)).toBe('Café€');
  // Committing keeps the inserted characters in the layer.
  await run(page, 'select.deselect-layers');
  await idle(page);
  const layerText = await page.evaluate(() => window.photoStudio.doc.layers.find((l) => l.kind === 'text')?.text);
  expect(layerText).toBe('Café€');
});

test('a glyph from a font chosen in the Glyphs panel is inserted in that font', async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 200, '#ffffff');
  await page.evaluate(() => window.photoStudio.runCommand('type.add'));
  await expect.poll(() => text(page)).toBe('');
  await page.keyboard.type('ab');
  await page.evaluate(() => window.photoStudio.dock.show('glyphs'));
  const body = await panel(page, 'Glyphs');
  await body.locator('select[aria-label="Font family"]').selectOption('Caveat');
  const cell = body.locator('.gl-grid [data-cp="38"]');
  await expect(cell).toBeVisible();
  await cell.dblclick();
  await expect.poll(() => text(page)).toBe('ab&');
  const runs = () =>
    page.evaluate(() => {
      const { session } = (window as unknown as { photoStudioType: typeof import('../../src/features/type/session') }).photoStudioType;
      return session!.data.content.paragraphs[0].runs.map((r) => [r.text, r.style.family]);
    });
  expect(await runs()).toEqual([['ab', 'Inter'], ['&', 'Caveat']]);
  // Undo removes the glyph in one step.
  await page.keyboard.press('Meta+z');
  expect(await runs()).toEqual([['ab', 'Inter']]);
});

for (const invalid of [-1, 0x110000]) test(`Glyphs ignores an out-of-range recent code point ${invalid}`, async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await boot(page);
  await openImage(page, 400, 200, '#ffffff');
  await run(page, 'type.add');
  await page.keyboard.insertText('ab');
  await page.evaluate((invalid) => {
    localStorage.setItem('photo-studio-recent-glyphs', JSON.stringify([{ cp: invalid, family: 'Inter' }, { cp: 38, family: 'Inter' }]));
    window.photoStudio.dock.show('glyphs');
  }, invalid);
  const body = await panel(page, 'Glyphs');
  await idle(page);
  expect(errors).toEqual([]);
  await expect(body.locator('.gl-recent [data-cp="38"]')).toHaveCount(1);
  await expect(body.locator('.gl-recent .gl-cell')).toHaveCount(1);
  await expect(body.locator('.gl-grid [data-cp="65"]')).toBeVisible();
  await body.locator('.gl-recent [data-cp="38"]').dblclick();
  await expect.poll(() => text(page)).toBe('ab&');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('photo-studio-recent-glyphs')!))).toEqual([{ cp: 38, family: 'Inter' }]);
  await run(page, 'edit.undo');
  expect(await text(page)).toBe('ab');
  await run(page, 'edit.redo');
  expect(await text(page)).toBe('ab&');
});

for (const stored of ['not json', '{}', '[null,{}, {"cp":65.5,"family":"Inter"}, {"cp":"65","family":"Inter"}, {"cp":65,"family":7}]']) test(`Glyphs recovers an empty list from malformed saved recents ${stored}`, async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await boot(page);
  await openImage(page, 400, 200, '#ffffff');
  await run(page, 'type.add');
  await page.evaluate((stored) => {
    localStorage.setItem('photo-studio-recent-glyphs', stored);
    window.photoStudio.dock.show('glyphs');
  }, stored);
  const body = await panel(page, 'Glyphs');
  await expect(body.locator('.gl-recent')).toContainText('Double-click a glyph');
  await body.locator('.gl-grid [data-cp="65"]').dblclick();
  await expect.poll(() => text(page)).toBe('A');
  await expect(body.locator('.gl-recent [data-cp="65"]')).toHaveCount(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('photo-studio-recent-glyphs')!))).toEqual([{ cp: 65, family: 'Inter' }]);
  expect(errors).toEqual([]);
});

test('valid recent glyphs retain Unicode characters, order, limits, and insertion', async ({ page }) => {
  await boot(page);
  await openImage(page, 400, 200, '#ffffff');
  await run(page, 'type.add');
  await page.keyboard.insertText('ab');
  const expected = [0x1f600, ...Array.from({ length: 23 }, (_, i) => 65 + i)];
  await page.evaluate(() => {
    const invalid = Array.from({ length: 25 }, (_, i) => ({ cp: i % 2 ? -1 : 0x110000, family: 'Inter' }));
    const valid = [0x1f600, ...Array.from({ length: 24 }, (_, i) => 65 + i)].map((cp) => ({ cp, family: 'Inter' }));
    localStorage.setItem('photo-studio-recent-glyphs', JSON.stringify([...invalid, ...valid]));
    window.photoStudio.dock.show('glyphs');
  });
  const body = await panel(page, 'Glyphs');
  await expect(body.locator('.gl-recent .gl-cell')).toHaveCount(24);
  expect(await body.locator('.gl-recent .gl-cell').evaluateAll((cells) => cells.map((c) => Number((c as HTMLElement).dataset.cp)))).toEqual(expected);
  const emoji = body.locator('.gl-recent [data-cp="128512"]');
  await emoji.dblclick();
  await expect.poll(() => text(page)).toBe('ab😀');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('photo-studio-recent-glyphs')!))).toEqual(expected.map((cp) => ({ cp, family: 'Inter' })));
  await run(page, 'edit.undo');
  expect(await text(page)).toBe('ab');
  await run(page, 'edit.redo');
  expect(await text(page)).toBe('ab😀');
});
