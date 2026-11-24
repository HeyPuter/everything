import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';
import { reopenDocx } from './helpers/reopen-docx.js';

// A chart's typed height and width size it as its handles do; the Format pane offers no rotation for it
// (charts do not turn), rather than failing with "This object has no shape properties to format."
test('a chart takes a typed size from the ribbon and the Format pane, in one undo step each', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('Sales: '); await input.press('End');
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Chart', exact: true }).click();
  await page.getByRole('dialog', { name: 'Insert Chart' }).getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(page.locator('.canvas-image-frame')).toBeVisible();
  const extent = async name => {
    const download = page.waitForEvent('download'); await downloadDocx(page);
    const path = info.outputPath(name); await (await download).saveAs(path);
    const [, cx, cy] = strFromU8(unzipSync(readFileSync(path))['word/document.xml']).match(/<wp:extent cx="(\d+)" cy="(\d+)"/);
    return { path, size: [+cx, +cy] };
  };
  const inserted = (await extent('inserted.docx')).size;
  const height = page.getByRole('spinbutton', { name: 'Picture height (in)' });
  await height.fill('2'); await height.press('Enter');
  await expect.poll(async () => (await extent('ribbon.docx')).size).toEqual([inserted[0], 1828800]);
  await expect(page.getByText('This object has no shape properties to format.')).toHaveCount(0);

  const frame = await page.locator('.canvas-image-frame').boundingBox();
  await page.mouse.click(frame.x + frame.width / 2, frame.y + frame.height / 2, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Format Shape…' }).click();
  const pane = page.getByRole('complementary', { name: 'Format pane' });
  await expect(pane.getByLabel('Width')).toHaveValue('5.5');
  await expect(pane.getByLabel('Rotation')).toHaveCount(0);
  await pane.getByLabel('Width').fill('4'); await pane.getByLabel('Width').press('Tab');
  await expect.poll(async () => (await extent('pane.docx')).size).toEqual([3657600, 1828800]);
  await input.focus(); await input.press('ControlOrMeta+z');
  await expect.poll(async () => (await extent('undone.docx')).size).toEqual([inserted[0], 1828800]);
  const { path } = await extent('saved.docx');
  await reopenDocx(page, input, path, await input.inputValue());
  expect((await extent('reopened.docx')).size).toEqual([inserted[0], 1828800]);
  await expect(page.getByText(/no shape properties/)).toHaveCount(0);
  expect(errors).toEqual([]);
});
