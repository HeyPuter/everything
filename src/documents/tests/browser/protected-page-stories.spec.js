import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

// Under Restrict Editing (read only), References and Insert commands that add a header or footer or change
// note and page-number settings leave the document as it is, as typing does, and say why.
test('a protected document gets no new header, note settings or page numbering from the ribbon', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('Locked contract text.');
  await onTab(page, 'review');
  await page.locator('#ribbon-panel-review [aria-label="Restrict Editing"]').evaluate(b => b.click());
  const pane = page.getByRole('complementary', { name: 'Restrict Editing pane' });
  await pane.getByRole('checkbox', { name: 'Allow only this type of editing in the document:' }).check();
  await pane.getByRole('button', { name: 'Yes, Start Enforcing Protection' }).click();
  await page.getByRole('dialog', { name: 'Start Enforcing Protection' }).getByRole('button', { name: 'OK', exact: true }).click();
  await expect(pane).toContainText('protected from unintentional editing');
  const stories = () => page.evaluate(() => Object.keys(window.__docs.current.view.engine.pageStories?.stories || {}));
  // Edit Header in a document without one.
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Header', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Header', exact: true }).click();
  await expect(page.getByText('This document is protected against editing, so its headers cannot be changed.', { exact: false })).toBeVisible();
  expect(await stories()).toEqual([]);
  // Footnote numbering.
  await onTab(page, 'references');
  await page.locator('#ribbon-panel-references').getByRole('button', { name: 'Footnote and Endnote Settings', exact: true }).click();
  const notes = page.getByRole('dialog', { name: 'Footnote and Endnote' });
  await notes.getByLabel('Number format').selectOption('lowerRoman');
  await notes.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(notes.getByRole('alert')).toContainText('its footnote and endnote settings cannot be changed');
  await notes.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Format Page Numbers.
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Page Number', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Format Page Numbers…', exact: true }).click();
  const numbers = page.getByRole('dialog', { name: 'Page Number Format' });
  await numbers.getByLabel('Number format').selectOption('lowerRoman');
  await numbers.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(numbers.getByRole('alert')).toContainText('its page numbering cannot be changed');
  await numbers.getByRole('button', { name: 'Cancel', exact: true }).click();
  const pending = page.waitForEvent('download');
  await downloadDocx(page);
  const path = info.outputPath('protected.docx'); await (await pending).saveAs(path);
  const parts = unzipSync(readFileSync(path));
  expect(Object.keys(parts).filter(name => /header|footer/.test(name))).toEqual([]);
  expect(strFromU8(parts['word/settings.xml'])).not.toContain('footnotePr');
  expect(strFromU8(parts['word/document.xml'])).not.toContain('pgNumType');
});
