import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

// A shape chosen from the gallery is drawn wherever the drag starts, also on the selected shape's
// handles, Move button or Layout Options button, which no longer take the drag for themselves.
for (const control of ['Resize from bottom-right corner', 'Move selected image', 'Layout Options']) {
  test(`a new shape drawn from the selected shape's ${control} button is drawn, and the selected shape keeps its size and place`, async ({ page }, info) => {
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/playground.html');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('textbox', { name: 'Document text' }).fill('Shapes sit beside this paragraph of text. '.repeat(4));
    const choose = async name => {
      await onTab(page, 'insert');
      await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Shapes', exact: true }).click();
      await page.getByRole('menuitem', { name, exact: true }).click();
    };
    const drag = async (x, y, width, height) => { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + width, y + height, { steps: 4 }); await page.mouse.up(); };
    await choose('Rectangle');
    const box = await page.locator('canvas.canvas-page').first().boundingBox();
    await drag(box.x + 300, box.y + 300, 120, 70);
    await expect(page.locator('#ribbon-tab-shapeFormat')).toBeVisible();
    const start = await page.getByRole('button', { name: control, exact: true }).boundingBox();
    await choose('Oval');
    await drag(start.x + start.width / 2, start.y + start.height / 2, 100, 60);
    await expect(page.getByText(/^Oval: drag on the page/)).toHaveCount(0);
    const path = info.outputPath('shapes.docx');
    const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
    const xml = strFromU8(unzipSync(readFileSync(path))['word/document.xml']);
    expect([...xml.matchAll(/<wp:docPr [^>]*name="([^"]*)"/g)].map(m => m[1])).toEqual(['Rectangle 1', 'Oval 2']);
    expect([...xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)].map(m => [+m[1], +m[2]])).toEqual([[1143000, 666750], [952500, 571500]]);
    expect([...xml.matchAll(/<wp:posOffset>(\d+)</g)].slice(0, 2).map(m => +m[1])).toEqual([2857500, 2857500]);
    expect(errors).toEqual([]);
  });
}
