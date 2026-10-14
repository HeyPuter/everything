import { test, expect } from '@playwright/test';
import { openApp, clickModel, inkCoverage } from './helpers.js';

test('the home screen offers templates and opens the sample house', async ({ page }) => {
  const errors = await openApp(page);
  await expect(page.getByRole('button', { name: /Metric project/ })).toBeVisible();
  await page.getByRole('button', { name: /Sample house/ }).click();
  await expect(page.locator('.vtab.active')).toContainText('Level 1');
  expect(await inkCoverage(page)).toBeGreaterThan(0.01);
  expect(errors).toEqual([]);
});

test('walls, a door and a floor drawn with shortcuts and clicks, then undone', async ({ page }) => {
  const errors = await openApp(page);
  await page.getByRole('button', { name: /Metric project/ }).click();
  await page.evaluate(() => {
    const c = window.bd.vc;
    c.cam = { cx: 4000, cy: 3000, zoom: 0.06 };
    c.userMoved = true;
  });
  await clickModel(page, -2000, -2000);
  await page.keyboard.type('wa');
  for (const [x, y] of [
    [0, 0],
    [8000, 0],
    [8000, 6000],
    [0, 6000],
    [0, 0],
  ])
    await clickModel(page, x, y);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.bd.doc.count('wall'))).toBe(4);
  await page.keyboard.type('dr');
  await clickModel(page, 4000, 200);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.bd.doc.count('door'))).toBe(1);
  await page.keyboard.type('sb');
  await clickModel(page, 4000, 6000);
  await page.getByRole('button', { name: 'Finish' }).click();
  expect(await page.evaluate(() => window.bd.doc.count('floor'))).toBe(1);
  // Rooms find the enclosed area.
  await page.evaluate(() => window.bd.run('rooms-auto'));
  expect(await page.evaluate(() => window.bd.doc.count('room'))).toBe(1);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => [window.bd.doc.count('room'), window.bd.doc.count('floor')])).toEqual([0, 0]);
  await page.keyboard.press('Control+y');
  expect(await page.evaluate(() => window.bd.doc.count('floor'))).toBe(1);
  expect(errors).toEqual([]);
});

test('the 3D view, sections and schedules render', async ({ page }) => {
  const errors = await openApp(page, '?sample');
  await page.locator('.tnode').filter({ has: page.locator('.tnode-name', { hasText: /^3D View$/ }) }).dblclick();
  await expect(page.locator('.vtab.active')).toContainText('3D View');
  expect(await inkCoverage(page)).toBeGreaterThan(0.02);
  await page.locator('.tnode').filter({ has: page.locator('.tnode-name', { hasText: /^Sections$/ }) }).click();
  await page.locator('.tnode').filter({ has: page.locator('.tnode-name', { hasText: /^Section 1$/ }) }).dblclick();
  await expect(page.locator('.vtab.active')).toContainText('Section 1');
  expect(await inkCoverage(page)).toBeGreaterThan(0.01);
  await page.evaluate(() => {
    const bd = window.bd;
    const v = { id: 'vsched', kind: 'schedule', name: 'Doors', category: 'door' };
    bd.commit('s', () => bd.doc.add(v));
    bd.openView('vsched');
  });
  await expect(page.locator('.schedule tbody tr')).toHaveCount(4);
  expect(errors).toEqual([]);
});

test('selecting shows properties and editing a value updates the model', async ({ page }) => {
  await openApp(page, '?sample');
  const id = await page.evaluate(() => {
    const bd = window.bd;
    const w = bd.doc.all('wall')[0];
    bd.select([w.id]);
    return w.id;
  });
  await expect(page.locator('.pane-props')).toContainText('Exterior - Brick on Timber Frame');
  const offset = page.locator('#prop-baseOffset');
  await offset.fill('100');
  await offset.press('Enter');
  expect(await page.evaluate((id) => window.bd.doc.get(id).baseOffset, id)).toBe(100);
});

test('the project browser works from the keyboard', async ({ page }) => {
  await openApp(page, '?sample');
  const level2 = page.locator('.tnode', { hasText: 'Level 2' }).first();
  await level2.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.vtab.active')).toContainText('Level 2');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(page.locator('.vtab.active')).toContainText('Level 1');
});

test('the theme follows the user choice', async ({ page }) => {
  await openApp(page, '?sample');
  await page.getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Theme' }).click();
  await page.getByRole('menuitemradio', { name: 'System' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
});
