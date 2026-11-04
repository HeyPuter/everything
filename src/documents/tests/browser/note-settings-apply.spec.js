import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

// The Footnote and Endnote dialog writes only the settings that were changed: Apply with nothing changed leaves
// settings.xml alone, and a footnote format change does not add endnote settings.
test('Footnote and Endnote Apply writes only changed note settings', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('A claim.');
  await onTab(page, 'references');
  const ribbon = page.locator('#ribbon-panel-references');
  const settings = async name => {
    const pending = page.waitForEvent('download');
    await downloadDocx(page);
    const path = info.outputPath(name); await (await pending).saveAs(path);
    return strFromU8(unzipSync(readFileSync(path))['word/settings.xml'] || new Uint8Array());
  };
  const before = await settings('before.docx');
  await ribbon.getByRole('button', { name: 'Footnote and Endnote Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Footnote and Endnote' });
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await settings('unchanged.docx')).toBe(before);
  await ribbon.getByRole('button', { name: 'Footnote and Endnote Settings', exact: true }).click();
  await dialog.getByLabel('Number format').selectOption('lowerRoman');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const changed = await settings('changed.docx');
  expect(changed).toContain('<w:footnotePr>');
  expect(changed).toContain('<w:numFmt w:val="lowerRoman"/>');
  expect(changed).not.toContain('endnotePr');
  expect(changed).not.toContain('numStart');
});

test('Footnote and endnote settings applied together are one undo step', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('A claim.');
  await onTab(page, 'references');
  const settings = () => page.evaluate(async () => {
    const blob = await window.__docs.current.view.commands.exportPackage();
    const { unzipSync, strFromU8 } = await import('/node_modules/fflate/esm/browser.js');
    const part = unzipSync(new Uint8Array(await blob.arrayBuffer()))['word/settings.xml'];
    return part ? strFromU8(part) : '';
  });
  const steps = () => page.evaluate(() => window.__docs.current.view.engine.session.history.length);
  const before = await settings(), count = await steps();
  await page.locator('#ribbon-panel-references').getByRole('button', { name: 'Footnote and Endnote Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Footnote and Endnote' });
  await dialog.getByLabel('Number format').selectOption('lowerRoman');
  await dialog.getByLabel('Endnotes').check();
  await dialog.getByLabel('Number format').selectOption('upperLetter');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const changed = await settings();
  expect(changed).toContain('<w:footnotePr>');
  expect(changed).toContain('<w:endnotePr>');
  expect(await steps()).toBe(count + 1);
  await page.getByRole('textbox', { name: 'Document text' }).press('ControlOrMeta+z');
  expect(await settings()).toBe(before);
  await page.getByRole('textbox', { name: 'Document text' }).press('ControlOrMeta+Shift+z');
  expect(await settings()).toBe(changed);
});
