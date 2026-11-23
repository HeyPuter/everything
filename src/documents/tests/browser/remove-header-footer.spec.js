import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

// Insert > Header (or Footer) > Remove Header clears the header the current page shows. A page without one
// has nothing to remove: the command must not create an empty header part (§17.10.4 hdr) and a section
// reference to it (§17.10.5 headerReference).
async function save(page, path) {
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  const parts = unzipSync(new Uint8Array(readFileSync(path)));
  return { names: Object.keys(parts), body: strFromU8(parts['word/document.xml']) };
}

test('Remove Header and Remove Footer on a page without them add nothing to the file', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('A document without a header or a footer.');
  await onTab(page, 'insert');
  for (const [button, item] of [['Header', 'Remove Header'], ['Footer', 'Remove Footer']]) {
    await page.locator('#ribbon-panel-insert').getByRole('button', { name: button, exact: true }).click();
    await page.getByRole('menuitem', { name: item, exact: true }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
  }
  await expect(input).toBeFocused();
  const { names, body } = await save(page, info.outputPath('no-header.docx'));
  expect(names.filter(name => /^word\/(header|footer)\d*\.xml$/.test(name))).toEqual([]);
  expect(body).not.toMatch(/headerReference|footerReference/);
  expect(errors).toEqual([]);
});

test('Remove Header still clears a header the page shows', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('A document with a header.');
  await onTab(page, 'insert');
  const ribbon = page.locator('#ribbon-panel-insert');
  await ribbon.getByRole('button', { name: 'Header', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Blank: One line/ }).click();
  await expect(page.getByRole('tab', { name: 'Header & Footer' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.insertText('Running head');
  await page.getByRole('button', { name: 'Close Header and Footer' }).click();
  expect((await save(page, info.outputPath('header.docx'))).names).toContain('word/header1.xml');
  await onTab(page, 'insert');
  await ribbon.getByRole('button', { name: 'Header', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove Header', exact: true }).click();
  const path = info.outputPath('removed.docx');
  await expect.poll(async () => strFromU8(unzipSync(new Uint8Array(readFileSync((await save(page, path), path))))['word/header1.xml'])).not.toContain('Running head');
  expect(errors).toEqual([]);
});
