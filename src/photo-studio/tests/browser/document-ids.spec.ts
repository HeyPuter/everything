// Identifiers from a file or another person never become markup: projects
// with identifiers that could carry markup are refused, and panels escape
// identifiers they put into attributes.
import { test, expect, type Page } from '@playwright/test';
import { boot, idle, openImage, photoFile } from './helpers';

const evil = 'x" data-injected="1"><img src="x" onerror="window.__injected=1">';
const injected = (page: Page) =>
  page.evaluate(() => !!(window as unknown as { __injected?: number }).__injected || !!document.querySelector('[data-injected], img[src="x"]'));

test('a project with markup in a layer identifier is refused cleanly', async ({ page }) => {
  await boot(page);
  await openImage(page, 64, 48, '#336699', 'start.png');
  const before = await page.evaluate(() => window.photoStudio.doc.id);
  const doc = await page.evaluate(() => structuredClone(window.photoStudio.doc));
  doc.layers[0].id = evil;
  (doc.layers[0] as unknown as Record<string, unknown>).asset = undefined;
  await page.locator('#file-input').setInputFiles(photoFile({ ...doc, selectionMask: undefined }, [], 'evil.photo'));
  await expect(page.locator('#status')).toContainText(/Invalid|could not|Choose/i);
  await idle(page);
  expect(await page.evaluate(() => window.photoStudio.doc.id)).toBe(before);
  expect(await injected(page)).toBe(false);
});

test('the Layers panel escapes layer identifiers it writes into attributes', async ({ page }) => {
  await boot(page);
  await openImage(page, 64, 48, '#336699', 'start.png');
  // Past validation (as a script or a future bug could): the panel still renders it as text.
  await page.evaluate((id) => window.photoStudio.history.execute('Rename ID', (d) => (d.layers[0].id = id)), evil);
  await idle(page);
  expect(await injected(page)).toBe(false);
  expect(await page.evaluate(() => document.querySelector<HTMLElement>('#layers .layer-row')?.dataset.row)).toBe(evil);
});
