import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

// In a section of two columns, a new picture or table fits the column it is inserted in, as in Word,
// instead of taking the whole writing width and running over the next column.
test.use({ viewport: { width: 1440, height: 900 } });
const input = page => page.getByRole('textbox', { name: 'Document text' });
const COLUMN = (12240 - 2880 - 720) / 2; // Letter, 1 in margins, two columns 0.5 in apart (twips).

test('pictures and tables inserted in a two-column section fit the column', async ({ page }) => {
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await input(page).focus();
  await page.keyboard.type('Intro'); await page.keyboard.press('Enter');
  await (await onTab(page, 'layout')).getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Two' }).click();
  const drawings = () => page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs).filter(r => r.image).map(r => Math.round(r.image.width / 635)));
  // A raster picture 1600 px wide (16.7 in at 96 px/in) and an SVG as wide.
  const b64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 1600; c.height = 400; const g = c.getContext('2d'); g.fillStyle = '#3a7'; g.fillRect(0, 0, 1600, 400); return c.toDataURL('image/png').split(',')[1]; });
  await (await onTab(page, 'insert'));
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
  await expect.poll(drawings).toHaveLength(1);
  await input(page).press('End');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="400"><rect width="1600" height="400" fill="#a37"/></svg>';
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'wide.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await expect.poll(drawings).toHaveLength(2);
  for (const width of await drawings()) { expect(width).toBeLessThanOrEqual(COLUMN); expect(width).toBeGreaterThan(COLUMN - 30); }
  await input(page).press('End'); await page.keyboard.press('Enter');
  await (await onTab(page, 'insert')).getByRole('button', { name: 'Insert table', exact: true }).click();
  await page.getByRole('menuitem', { name: '3 columns, 2 rows' }).click();
  const grid = await page.evaluate(() => window.__docs.current.view.engine.model.tables[0].grid.reduce((a, b) => a + b, 0));
  expect(grid).toBeLessThanOrEqual(COLUMN);
  expect(grid).toBeGreaterThan(COLUMN - 30);
});
