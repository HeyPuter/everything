import { test, expect, type Page } from '@playwright/test';
import { openApp, expectNoErrors } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Win = { app: any };

const row = (page: Page, name: string, nth = 0) =>
  page
    .locator('.outliner .ol-row', {
      has: page.locator('.ol-name', { hasText: new RegExp(`^${name}$`) }),
    })
    .nth(nth);
const names = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.outliner .ol-row .ol-name')].map((e) => e.textContent));
const selected = (page: Page) =>
  page.evaluate(() => {
    const a = (window as unknown as Win).app;
    return Object.values(a.doc.objects as Record<string, { name: string; select: boolean }>)
      .filter((o) => o.select)
      .map((o) => o.name)
      .sort();
  });
const activeName = (page: Page) => page.evaluate(() => (window as unknown as Win).app.activeObject?.name ?? null);

async function hoverOutliner(page: Page) {
  const b = (await page.locator('.outliner .ol-list').first().boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height - 6);
}

test('outliner: click, ctrl and shift selection stay in sync with objects', async ({ page }) => {
  const errors = await openApp(page);
  await row(page, 'Light').locator('.ol-name').click();
  expect(await selected(page)).toEqual(['Light']);
  expect(await activeName(page)).toBe('Light');
  await row(page, 'Camera')
    .locator('.ol-name')
    .click({ modifiers: ['ControlOrMeta'] });
  expect(await selected(page)).toEqual(['Camera', 'Light']);
  expect(await activeName(page)).toBe('Camera');
  // shift: range from the active row
  await row(page, 'Light')
    .locator('.ol-name')
    .click({ modifiers: ['Shift'] });
  expect(await selected(page)).toEqual(['Camera', 'Cube', 'Light']);
  // clicking a collection selects it in the outliner and deselects objects
  await row(page, 'Collection').locator('.ol-name').click();
  expect(await selected(page)).toEqual([]);
  await expect(row(page, 'Collection')).toHaveClass(/selected/);
  // clicking empty space deselects everything
  await row(page, 'Cube').locator('.ol-name').click();
  const list = (await page.locator('.outliner .ol-list').first().boundingBox())!;
  await page.mouse.click(list.x + list.width / 2, list.y + list.height - 4);
  expect(await selected(page)).toEqual([]);
  await expectNoErrors(errors);
});

test('outliner: keyboard walk, expand and rename', async ({ page }) => {
  const errors = await openApp(page);
  await row(page, 'Camera').locator('.ol-name').click();
  await hoverOutliner(page);
  await page.keyboard.press('ArrowDown');
  expect(await activeName(page)).toBe('Cube');
  await page.keyboard.press('Shift+ArrowDown');
  expect(await selected(page)).toEqual(['Cube', 'Light']);
  expect(await activeName(page)).toBe('Light');
  // Right opens the active object, Left closes it again
  await page.keyboard.press('ArrowRight');
  await expect(row(page, 'Light', 1)).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(row(page, 'Light', 1)).toHaveCount(0);
  // Shift+A expands everything, again collapses
  await page.keyboard.press('Shift+A');
  await expect(page.locator('.outliner .ol-row', { hasText: 'Material' })).toHaveCount(1);
  await page.keyboard.press('Shift+A');
  await expect(page.locator('.outliner .ol-row', { hasText: 'Material' })).toHaveCount(0);
  // everything below the scene collection is closed now: Numpad + opens one level, Numpad - closes it
  await expect(row(page, 'Cube')).toHaveCount(0);
  await page.keyboard.press('NumpadAdd');
  await expect(row(page, 'Cube')).toHaveCount(1);
  await page.keyboard.press('NumpadSubtract');
  await expect(row(page, 'Cube')).toHaveCount(0);
  await page.keyboard.press('NumpadAdd');
  await expect(row(page, 'Cube')).toHaveCount(1);
  // F2 renames the active element
  await page.keyboard.press('F2');
  const input = page.locator('.outliner .ol-rename');
  await expect(input).toBeVisible();
  await input.fill('Lamp');
  await input.press('Enter');
  expect(await activeName(page)).toBe('Lamp');
  // double-click on a name renames too
  await row(page, 'Cube').locator('.ol-name').dblclick();
  await page.locator('.outliner .ol-rename').fill('Box');
  await page.locator('.outliner .ol-rename').press('Enter');
  expect((await names(page)).includes('Box')).toBe(true);
  await expectNoErrors(errors);
});

test('outliner: box select, hide and collection operations', async ({ page }) => {
  const errors = await openApp(page);
  // drag over the empty right part of the rows
  const cam = (await row(page, 'Camera').boundingBox())!;
  const light = (await row(page, 'Light').boundingBox())!;
  await page.mouse.move(cam.x + cam.width - 90, cam.y + cam.height / 2);
  await page.mouse.down();
  await page.mouse.move(cam.x + cam.width - 90, light.y + 12, { steps: 5 });
  await page.mouse.up();
  expect(await selected(page)).toEqual(['Camera', 'Cube', 'Light']);
  // H hides the selection, Alt+H shows everything again
  await row(page, 'Cube').locator('.ol-name').click();
  await hoverOutliner(page);
  await page.keyboard.press('h');
  expect(await page.evaluate(() => Object.values((window as unknown as Win).app.doc.objects as Record<string, any>).find((o) => o.name === 'Cube').hide)).toBe(true);
  await page.keyboard.press('Alt+h');
  expect(await page.evaluate(() => Object.values((window as unknown as Win).app.doc.objects as Record<string, any>).find((o) => o.name === 'Cube').hide)).toBe(false);
  // C adds a collection inside the selected one; E excludes it, Alt+E brings it back
  await row(page, 'Collection').locator('.ol-name').click();
  await hoverOutliner(page);
  await page.keyboard.press('c');
  await expect(row(page, 'Collection.001')).toHaveCount(1);
  await page.keyboard.press('e');
  await expect(row(page, 'Collection.001')).toHaveClass(/dim/);
  await page.keyboard.press('Alt+e');
  await expect(row(page, 'Collection.001')).not.toHaveClass(/dim/);
  // context menu: color tag and Visibility > Hide
  await row(page, 'Collection.001').locator('.ol-name').click({ button: 'right' });
  await page.locator('.menu-item', { hasText: 'Set Color Tag' }).hover();
  await page.locator('.menu-item', { hasText: 'Color 03' }).click();
  expect(await page.evaluate(() => Object.values((window as unknown as Win).app.doc.collections as Record<string, any>).find((c) => c.name === 'Collection.001').color_tag)).toBe('COLOR_03');
  await expect(row(page, 'Collection.001').locator('.ol-icon')).toHaveClass(/ct-COLOR_03/);
  // Duplicate the main collection: its objects are copied
  await row(page, 'Collection').locator('.ol-name').click({ button: 'right' });
  await page.locator('.menu-item', { hasText: /^Duplicate Collection/ }).click();
  await expect(row(page, 'Cube.001')).toHaveCount(1);
  // X deletes the selected objects
  await row(page, 'Cube.001').locator('.ol-name').click();
  await hoverOutliner(page);
  await page.keyboard.press('x');
  await expect(row(page, 'Cube.001')).toHaveCount(0);
  await expectNoErrors(errors);
});

test('outliner: drag and drop, restriction columns, filter and search', async ({ page }) => {
  const errors = await openApp(page);
  await page.evaluate(() =>
    (window as unknown as Win).app.run('outliner.collection_new', {
      nested: false,
    }),
  );
  await expect(row(page, 'Collection.001')).toHaveCount(1);
  // drop an object onto another collection moves it there
  await row(page, 'Light').locator('.ol-item').dragTo(row(page, 'Collection.001').locator('.ol-name'));
  const where = await page.evaluate(() => {
    const a = (window as unknown as Win).app;
    const light = Object.values(a.doc.objects as Record<string, any>).find((o) => o.name === 'Light');
    return Object.values(a.doc.collections as Record<string, any>)
      .filter((c) => c.objects.includes(light.id))
      .map((c) => c.name);
  });
  expect(where).toEqual(['Collection.001']);
  // drop onto an object parents it
  await row(page, 'Camera').locator('.ol-item').dragTo(row(page, 'Cube').locator('.ol-name'));
  expect(
    await page.evaluate(() => {
      const a = (window as unknown as Win).app;
      const obs = Object.values(a.doc.objects as Record<string, any>);
      return obs.find((o) => o.name === 'Camera').parent === obs.find((o) => o.name === 'Cube').id;
    }),
  ).toBe(true);
  // restriction toggles: the eye hides an object; the filter popover adds the selectable column
  await row(page, 'Cube').locator('.ol-toggle.col-hide').dispatchEvent('pointerdown');
  expect(await page.evaluate(() => Object.values((window as unknown as Win).app.doc.objects as Record<string, any>).find((o) => o.name === 'Cube').hide)).toBe(true);
  await expect(page.locator('.outliner .ol-toggle.col-select')).toHaveCount(0);
  await page.locator('.ol-filter-btn').dispatchEvent('pointerdown');
  await page.locator('.olf-col[aria-label="Selectable"]').click();
  await expect(page.locator('.outliner .ol-toggle.col-select').first()).toBeVisible();
  // filter popover: hide lights
  await page.locator('.olf-check', { hasText: 'Lights' }).locator('.checkbox').dispatchEvent('pointerdown');
  await expect(row(page, 'Light')).toHaveCount(0);
  await page.keyboard.press('Escape');
  // search
  await page.locator('.ol-search input').fill('cam');
  await expect(row(page, 'Camera')).toHaveCount(1);
  await expect(row(page, 'Light')).toHaveCount(0);
  await expect(row(page, 'Camera')).toHaveClass(/match/);
  // display modes
  await page.locator('.ol-search input').fill('');
  await page.locator('.ol-display-mode').dispatchEvent('pointerdown');
  await page.locator('.menu-item', { hasText: 'Blender File' }).click();
  await expect(page.locator('.outliner .ol-row', { hasText: 'Current File' })).toHaveCount(1);
  await expectNoErrors(errors);
});
