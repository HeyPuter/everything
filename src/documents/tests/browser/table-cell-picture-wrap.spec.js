import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { onTab } from './helpers/editor-tools.js';

// Drawings in table cells do not wrap text yet: the wrapping choices that would fail are unavailable there.
const PNG = readFileSync('icon-128.png');
const wraps = page => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image.anchor ? (r.image.anchor.behind ? 'behind' : r.image.anchor.wrap) : 'inline')));

test('a picture in a table cell offers only the wrapping it can take', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document text' }).focus();
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '2 columns, 1 row' }).click();
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect.poll(() => wraps(page)).toEqual(['inline']);
  const ribbon = page.locator('#ribbon-panel-picture');
  const wrapMenu = async () => { await onTab(page, 'picture'); await ribbon.getByRole('button', { name: 'Wrap Text', exact: true }).click(); };
  await wrapMenu();
  for (const name of ['Square', 'Tight', 'Through', 'Top and Bottom']) await expect(page.getByRole('menuitemradio', { name: new RegExp(`^${name}`) })).toBeDisabled();
  await expect(page.getByRole('menuitemradio', { name: 'In Front of Text', exact: true })).toBeEnabled();
  await page.getByRole('menuitemradio', { name: 'Behind Text', exact: true }).click();
  await expect.poll(() => wraps(page)).toEqual(['behind']);
  // The Layout dialog's wrapping styles agree.
  await wrapMenu();
  await page.getByRole('menuitem', { name: 'More Layout Options…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Layout' });
  await expect(dialog.getByRole('radio', { name: 'Square' })).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: 'In front of text' }).or(dialog.getByRole('radio', { name: 'In Front of Text' }))).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.toast')).toHaveCount(0);
  expect(errors).toEqual([]);
});
