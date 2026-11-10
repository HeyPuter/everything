import { test, expect } from '@playwright/test';
import { onTab } from './helpers/editor-tools.js';

const ribbon = page => page.locator('#ribbon-panel-references');
const body = page => page.evaluate(() => window.__docs.current.view.engine.session.body.text);
const steps = page => page.evaluate(() => window.__docs.current.view.engine.session.history.length);
const storedSources = page => page.evaluate(async () => {
  const blob = await window.__docs.current.view.commands.exportPackage();
  const { unzipSync, strFromU8 } = await import('/node_modules/fflate/esm/browser.js');
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  return Object.entries(files).filter(([path]) => /^customXml\/item\d+\.xml$/.test(path)).map(([, bytes]) => strFromU8(bytes)).find(text => text.includes('Sources')) || '';
});
async function addSource(page, author, title, year) {
  await ribbon(page).getByRole('button', { name: 'Insert Citation', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add New Source…' }).click();
  const source = page.getByRole('dialog', { name: 'Create Source' });
  await source.getByLabel('Author', { exact: true }).fill(author);
  await source.getByLabel('Title', { exact: true }).fill(title);
  await source.getByLabel('Year', { exact: true }).fill(year);
  await source.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(source).toBeHidden();
}

test('a citation style change undoes with the style the document keeps, and a citation goes in as one step', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('First claim. Second claim.');
  await page.evaluate(() => { const m = window.__docs.current.view.engine.model; m.select(m.text.indexOf('.')); });
  await onTab(page, 'references');
  await addSource(page, 'Lovelace, Ada', 'Notes on engines', '2020');
  await expect.poll(() => body(page)).toBe('First claim (Lovelace, 2020). Second claim.');
  await page.evaluate(() => { const m = window.__docs.current.view.engine.model; m.select(m.text.length); m.replace('\n'); });
  await ribbon(page).getByRole('button', { name: 'Bibliography', exact: true }).click();
  await page.getByRole('menuitem', { name: /^References:/ }).click();
  await expect.poll(() => body(page)).toContain('References\nLovelace');

  // A second source cited: the citation and the bibliography entry it adds are one undo step.
  await page.evaluate(() => { const m = window.__docs.current.view.engine.model; m.select(m.text.indexOf('claim.\n') + 5); });
  await addSource(page, 'Babbage, Charles', 'Difference engines', '2019');
  await expect.poll(() => body(page)).toContain('Second claim (Babbage, 2019).');
  await expect.poll(() => body(page)).toMatch(/References\nBabbage[^\n]*\nLovelace/);
  const cited = await body(page), count = await steps(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => body(page)).not.toContain('Babbage, 2019');
  expect(await body(page)).not.toContain('Babbage, C.');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => body(page)).toBe(cited);
  expect(await steps(page)).toBe(count);

  // The style: MLA, then Undo goes back to APA in the text, the style box and the saved sources.
  const style = ribbon(page).getByRole('combobox', { name: 'Citation style' });
  await expect(style).toHaveValue('apa');
  await style.selectOption('mla');
  await expect.poll(() => body(page)).toContain('First claim (Lovelace).');
  expect(await storedSources(page)).toMatch(/SelectedStyle="[^"]*MLA/i);
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => body(page)).toBe(cited);
  await expect(style).toHaveValue('apa');
  expect(await storedSources(page)).toMatch(/SelectedStyle="[^"]*APA/i);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => body(page)).toContain('First claim (Lovelace).');
  await expect(style).toHaveValue('mla');
});
