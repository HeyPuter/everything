import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

// "Mark as decorative" clears a picture's description; clearing the box again gives the description back
// rather than leaving the picture with none.
test('a description taken away by Mark as decorative comes back when the box is cleared', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Logo: ');
  await onTab(page, 'insert');
  await page.getByLabel('Insert picture file').setInputFiles('icon.png');
  await expect(page.locator('#ribbon-tab-picture')).toHaveAttribute('aria-selected', 'true');
  await page.locator('#ribbon-panel-picture').getByRole('button', { name: 'Alt Text', exact: true }).click();
  const pane = page.getByRole('complementary', { name: 'Alt Text pane' });
  const description = pane.getByRole('textbox', { name: 'Description' }), decorative = pane.getByLabel('Mark as decorative');
  const docPr = async name => {
    const download = page.waitForEvent('download'); await downloadDocx(page);
    const path = info.outputPath(name); await (await download).saveAs(path);
    return strFromU8(unzipSync(readFileSync(path))['word/document.xml']).match(/<wp:docPr\b[^>]*>/)[0];
  };
  await description.fill('The company logo');
  await decorative.check();
  await expect(description).toBeDisabled();
  await expect.poll(() => docPr('decorative.docx')).not.toContain('descr="The company logo"');
  await decorative.uncheck();
  await expect(description).toBeEnabled();
  await expect(description).toHaveValue('The company logo');
  await expect.poll(() => docPr('described.docx')).toContain('descr="The company logo"');
  expect(errors).toEqual([]);
});
