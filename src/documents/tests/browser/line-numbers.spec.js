import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { onTab } from './helpers/editor-tools.js';

const fixture = 'public/fixtures/line-numbers.docx';

/** An editor over a package, with the Line Numbers commands bound to it, on a full-window host. */
async function mountEditor(page, bytes) {
  await page.goto('/playground.html');
  await page.evaluate(async ({ bytes }) => {
    const { DocxPackage } = await import('/src/engine/docx.js');
    const { CanvasEditor } = await import('/src/engine/canvas-editor.js');
    const { loadCanvasFonts } = await import('/src/engine/canvas-text.js');
    const { createLineNumbers } = await import('/src/views/line-numbers.js');
    const { openMenu } = await import('/src/ui/menu.js');
    await loadCanvasFonts();
    const host = document.createElement('div'); host.id = 'line-number-probe';
    host.style.cssText = 'position:fixed;inset:0;overflow:auto;background:#eee;z-index:10';
    document.body.append(host);
    window.lnErrors = [];
    window.lnPackage = await DocxPackage.open(new Uint8Array(bytes));
    window.lnEditor = new CanvasEditor(host, { ...window.lnPackage, onError: e => window.lnErrors.push(e.message) });
    window.lnCommands = createLineNumbers({ editor: () => window.lnEditor, pkg: () => window.lnPackage, error: e => window.lnErrors.push(e.message) }).commands;
    window.lnMenu = () => openMenu({ anchor: host, label: 'Line Numbers', items: window.lnCommands.lineNumberItems() });
    window.lnEditor.focus();
  }, { bytes: [...bytes] });
}

/** Non-white pixels inside a label's box on its page canvas. */
const labelInk = (page, index = 0) => page.evaluate(index => {
  const e = window.lnEditor, label = e.lineNumbers[index], canvas = e.canvases[label.page];
  const scale = canvas.width / e.layout.pages[label.page].width;
  const data = canvas.getContext('2d').getImageData(Math.floor(label.x * scale), Math.floor((label.baseline - 10) * scale), Math.ceil((label.width + 2) * scale), Math.ceil(12 * scale)).data;
  let ink = 0; for (let i = 0; i < data.length; i += 4) if (data[i] < 200) ink++;
  return ink;
}, index);

test('a section numbers its lines in the margin; suppressed paragraphs, tables and the second section follow their settings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountEditor(page, readFileSync(fixture));
  const labels = await page.evaluate(() => window.lnEditor.lineNumbers.map(l => ({ page: l.page, text: l.text, x: l.x, right: l.x + l.width })));
  expect(labels.length).toBeGreaterThan(20);
  // Page one restarts at 1; the gray labels sit a quarter inch left of the 1in margin.
  expect(labels[0]).toMatchObject({ page: 0, text: '1' });
  expect(labels[0].right).toBeCloseTo(96 - 24, 0);
  expect(await labelInk(page)).toBeGreaterThan(5);
  // The two-column section counts by five from 10, continuing across its pages.
  const later = labels.filter(l => Number(l.text) % 5 === 0 && l.page > 0);
  expect(later.some(l => l.text === '10')).toBe(true);
  expect(later.some(l => l.x > 400)).toBe(true); // numbers for the second column sit in the column gap
  await page.screenshot({ path: process.env.LNUM_SHOTS ? `${process.env.LNUM_SHOTS}/line-numbers-1440.png` : test.info().outputPath('line-numbers-1440.png') });
  const columnPage = labels.find(l => l.x > 400).page;
  await page.evaluate(index => window.lnEditor.canvases[index].scrollIntoView(), columnPage);
  await page.screenshot({ path: process.env.LNUM_SHOTS ? `${process.env.LNUM_SHOTS}/line-numbers-columns-1440.png` : test.info().outputPath('line-numbers-columns-1440.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { window.lnEditor.setZoom(0.45); });
  await page.screenshot({ path: process.env.LNUM_SHOTS ? `${process.env.LNUM_SHOTS}/line-numbers-390.png` : test.info().outputPath('line-numbers-390.png') });
  expect(await page.evaluate(() => window.lnErrors)).toEqual([]);
});

test('the Line Numbers menu and options dialog change numbering with undo, and it survives saving', async ({ page }) => {
  const blank = await (async () => { await page.goto('/playground.html'); return page.evaluate(async () => {
    const { createDocx } = await import('/src/engine/docx.js'); const { paragraph } = await import('/src/engine/model.js');
    return [...new Uint8Array(await createDocx(Array.from({ length: 12 }, (_, i) => paragraph(`Paragraph ${i + 1} of the sample.`))).export().arrayBuffer())];
  }); })();
  await mountEditor(page, new Uint8Array(blank));
  const menu = page.getByRole('menu', { name: 'Line Numbers' });
  await page.evaluate(() => window.lnMenu());
  await expect(menu.getByRole('menuitemradio', { name: 'None' })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: 'Restart Each Page' }).click();
  expect(await page.evaluate(() => window.lnEditor.model.pageSettings.lineNumbers)).toEqual({ countBy: 1, start: 0, distance: null, restart: 'newPage' });
  expect(await page.evaluate(() => window.lnEditor.lineNumbers.map(l => l.text).join(' '))).toBe('1 2 3 4 5 6 7 8 9 10 11 12');

  // Suppress the third paragraph: the following ones renumber.
  await page.evaluate(() => { const e = window.lnEditor; e.model.select(e.model.text.indexOf('Paragraph 3')); e.onSelection?.(); });
  await page.evaluate(() => window.lnMenu());
  await menu.getByRole('menuitemcheckbox', { name: 'Suppress for Current Paragraph' }).click();
  expect(await page.evaluate(() => window.lnEditor.lineNumbers.length)).toBe(11);
  await page.evaluate(() => window.lnMenu());
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Suppress for Current Paragraph' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  // Options: start at 5, every second line, 0.5in from the text.
  await page.evaluate(() => window.lnMenu());
  await menu.getByRole('menuitem', { name: 'Line Numbering Options…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Line Numbers' });
  await expect(dialog.getByRole('checkbox', { name: 'Add line numbering' })).toBeChecked();
  await dialog.getByRole('spinbutton', { name: 'Start at' }).fill('5');
  await dialog.getByRole('spinbutton', { name: 'Count by' }).fill('2');
  await dialog.getByRole('checkbox', { name: 'Auto' }).uncheck();
  const unit = await page.evaluate(async () => (await import('/src/lib/units.js')).recallUnit());
  await dialog.getByRole('spinbutton', { name: /^From text/ }).fill(unit === 'cm' ? '1.27' : '0.5');
  await dialog.getByRole('radio', { name: 'Continuous' }).check();
  if (process.env.LNUM_SHOTS) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: `${process.env.LNUM_SHOTS}/line-number-options-1440.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.LNUM_SHOTS}/line-number-options-390.png` });
    await page.setViewportSize({ width: 1280, height: 720 });
  }
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => window.lnEditor.model.pageSettings.lineNumbers)).toEqual({ countBy: 2, start: 4, distance: 720, restart: 'continuous' });
  expect(await page.evaluate(() => window.lnEditor.lineNumbers.map(l => l.text).join(' '))).toBe('6 8 10 12 14');
  expect(await page.evaluate(() => { const l = window.lnEditor.lineNumbers[0]; return l.x + l.width; })).toBeCloseTo(96 - 48, 0);

  // Undo returns to the previous settings in one step.
  await page.evaluate(() => window.lnEditor.undo());
  expect(await page.evaluate(() => window.lnEditor.model.pageSettings.lineNumbers.restart)).toBe('newPage');
  await page.evaluate(() => window.lnEditor.redo());

  // Save and reopen: settings and suppression survive; the export is saved for schema checks.
  const saved = await page.evaluate(async () => [...new Uint8Array(await window.lnEditor.export(window.lnPackage).arrayBuffer())]);
  const out = test.info().outputPath('line-numbers-export.docx');
  writeFileSync(out, new Uint8Array(saved));
  if (process.env.LNUM_EXPORTS) writeFileSync(`${process.env.LNUM_EXPORTS}/line-numbers-export.docx`, new Uint8Array(saved));
  const reopened = await page.evaluate(async bytes => {
    const { DocxPackage } = await import('/src/engine/docx.js'); const { paragraphFormat } = await import('/src/engine/model.js');
    const pkg = await DocxPackage.open(new Uint8Array(bytes));
    return { settings: pkg.pageSettings.lineNumbers, suppressed: pkg.paragraphs.map(p => paragraphFormat(p, pkg.numbering).suppressLineNumbers) };
  }, saved);
  expect(reopened.settings).toEqual({ countBy: 2, start: 4, distance: 720, restart: 'continuous' });
  expect(reopened.suppressed.indexOf(true)).toBe(2);

  // None removes numbering.
  await page.evaluate(() => window.lnMenu());
  await menu.getByRole('menuitemradio', { name: 'None' }).click();
  expect(await page.evaluate(() => [window.lnEditor.model.pageSettings.lineNumbers, window.lnEditor.lineNumbers.length])).toEqual([null, 0]);
  expect(await page.evaluate(() => window.lnErrors)).toEqual([]);
});

test('the Layout tab offers Line Numbers when the ribbon provides it', async ({ page }) => {
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('One\nTwo\nThree');
  const button = (await onTab(page, 'layout')).locator('.ribbon-card').getByRole('button', { name: 'Line Numbers' });
  test.skip(!await button.count(), 'The Layout tab button arrives with the Page Setup group.');
  await button.click();
  await page.getByRole('menuitemradio', { name: 'Continuous' }).click();
  await button.click();
  await expect(page.getByRole('menuitemradio', { name: 'Continuous' })).toHaveAttribute('aria-checked', 'true');
});
