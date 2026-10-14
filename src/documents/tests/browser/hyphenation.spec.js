import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

const FIXTURE = 'public/fixtures/hyphenation.docx';
const TEXT = 'Typographers value hyphenation because justified paragraphs otherwise develop uncomfortable gaps. '
  + 'International organizations publish documentation about communication, responsibility and accessibility, '
  + 'and their readers appreciate consistent, beautiful, professional typography throughout every publication.';

/** Open the Layout tab's Hyphenation menu and choose an item. */
async function hyphenation(page, item) {
  await (await onTab(page, 'layout')).locator('.ribbon-card').getByRole('button', { name: 'Hyphenation', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Hyphenation' });
  await menu.getByRole(['None', 'Automatic'].includes(item) ? 'menuitemradio' : 'menuitem', { name: item, exact: true }).click();
}
/** Where each displayed line starts: the caret goes down a line at a time and Home finds its start. */
async function lineStarts(input) {
  await input.focus();
  await input.press('ControlOrMeta+Home');
  const starts = [0];
  for (let i = 0; i < 40; i++) {
    await input.press('ArrowDown'); await input.press('Home');
    const at = await input.evaluate(el => el.selectionStart);
    if (at <= starts.at(-1)) break;
    starts.push(at);
  }
  return starts;
}
const midWord = (starts, text) => starts.filter(at => at > 0 && /[a-z]/i.test(text[at - 1]) && /[a-z]/i.test(text[at]));

test('automatic hyphenation splits words at line ends, undoes in one step and saves the setting', async ({ page }, info) => {
  test.setTimeout(120000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(TEXT);
  const before = await lineStarts(input);
  expect(midWord(before, TEXT)).toEqual([]); // ordinary wrapping starts each line with a whole word

  await hyphenation(page, 'Automatic');
  await expect.poll(async () => midWord(await lineStarts(input), TEXT).length, { timeout: 20000 }).toBeGreaterThan(0);
  // Lines now break inside words, and the document text itself is unchanged.
  await expect(input).toHaveValue(TEXT);
  await page.screenshot({ path: info.outputPath('hyphenation-1440.png') });

  await (await onTab(page, 'layout')).locator('.ribbon-card').getByRole('button', { name: 'Hyphenation', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Automatic', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  const path = info.outputPath('automatic-hyphenation.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  expect(strFromU8(unzipSync(readFileSync(path))['word/settings.xml'])).toContain('<w:autoHyphenation/>');

  await input.focus();
  await input.press('ControlOrMeta+z');
  await expect.poll(async () => JSON.stringify(await lineStarts(input)), { timeout: 20000 }).toBe(JSON.stringify(before));
  expect(errors).toEqual([]);
});

test('hyphenation options set the zone, the limit and capitals, and survive saving', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(TEXT);
  await hyphenation(page, 'Hyphenation Options…');
  const dialog = page.getByRole('dialog', { name: 'Hyphenation' });
  await dialog.getByLabel('Hyphenate the document automatically').check();
  await dialog.getByLabel('Hyphenate words in CAPITALS').uncheck();
  const zone = dialog.getByRole('spinbutton', { name: /Hyphenation zone/ });
  await zone.fill(await zone.getAttribute('aria-label').then(label => label.includes('(cm)') ? '0.5' : '0.2'));
  await dialog.getByRole('spinbutton', { name: 'Limit consecutive hyphens to' }).fill('2');
  await page.screenshot({ path: info.outputPath('hyphenation-options.png') });
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(input).toBeFocused();

  await hyphenation(page, 'Hyphenation Options…');
  await expect(dialog.getByLabel('Hyphenate the document automatically')).toBeChecked();
  await expect(dialog.getByLabel('Hyphenate words in CAPITALS')).not.toBeChecked();
  await expect(dialog.getByRole('spinbutton', { name: 'Limit consecutive hyphens to' })).toHaveValue('2');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  const path = info.outputPath('hyphenation-options.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  const settings = strFromU8(unzipSync(readFileSync(path))['word/settings.xml']);
  expect(settings).toContain('<w:autoHyphenation/>');
  expect(settings).toContain('<w:consecutiveHyphenLimit w:val="2"/>');
  expect(settings).toMatch(/<w:hyphenationZone w:val="28\d"\/>/);
  expect(settings).toContain('<w:doNotHyphenateCaps/>');
  expect(errors).toEqual([]);
});

test('manual hyphenation proposes breaks and inserts accepted ones as soft hyphens', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(TEXT);
  await hyphenation(page, 'Manual…');
  const dialog = page.getByRole('dialog', { name: 'Manual Hyphenation' });
  await expect(dialog.getByRole('radiogroup', { name: 'Break point' })).toBeVisible();
  const chosen = dialog.getByRole('radio', { checked: true });
  await expect(chosen).toHaveCount(1);
  const label = await chosen.getAttribute('aria-label');
  const [head, tail] = label.split('-');
  await expect(dialog.getByRole('button', { name: 'Yes', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(input).toHaveValue(TEXT.replace(head + tail, `${head}­${tail}`));
  // Skip the rest, then close.
  for (let i = 0; i < 20 && await dialog.getByRole('button', { name: 'No', exact: true }).isVisible(); i++) await dialog.getByRole('button', { name: 'No', exact: true }).click();
  await expect(dialog.getByText(/Hyphenation is complete/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(dialog).toBeHidden();
  await input.focus();
  await input.press('ControlOrMeta+z');
  await expect(input).toHaveValue(TEXT);
  expect(errors).toEqual([]);
});

test('the hyphenation fixture lays out with real fonts and keeps untouched parts', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/playground.html');
  await page.getByLabel('Open DOCX file').setInputFiles(FIXTURE);
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/^Automatic hyphenation/);
  await expect(input).toHaveJSProperty('readOnly', false);
  const lines = await page.evaluate(async bytes => {
    const { DocxPackage } = await import('/src/engine/docx.js'), { loadCanvasFonts, measureCanvasText } = await import('/src/engine/canvas-text.js');
    const { layoutDocument } = await import('/src/engine/layout.js'), { pageGeometry } = await import('/src/engine/page-settings.js'), { TextDocument } = await import('/src/engine/model.js');
    const pkg = await DocxPackage.open(Uint8Array.from(atob(bytes), c => c.charCodeAt(0))); await loadCanvasFonts(pkg);
    const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    const context = document.createElement('canvas').getContext('2d');
    const layout = layoutDocument(model.paragraphs, (t, s) => measureCanvasText(context, t, s), pageGeometry(model.pageSettings), model.numbering, model.tables);
    return layout.lines.map(l => ({ paragraph: model.paragraphs.findIndex(p => p.id === l.paragraphId), text: l.fragments.map(f => f.text).join(''), auto: !!l.autoHyphen, right: Math.max(...l.stops.map(s => s.x)), edge: layout.pages[0].width - layout.pages[0].right }));
  }, readFileSync(FIXTURE).toString('base64'));
  const hyphenated = index => lines.filter(l => l.paragraph === index && l.auto);
  expect(hyphenated(1).length).toBeGreaterThan(0);
  for (const line of hyphenated(1)) { expect(line.text).toMatch(/[a-z]-$/); expect(line.right).toBeLessThanOrEqual(line.edge + 0.5); }
  for (const index of [3, 5, 7]) expect(hyphenated(index)).toEqual([]);
  let run = 0;
  for (const line of lines) { run = line.auto ? run + 1 : 0; expect(run).toBeLessThanOrEqual(2); }
  await page.screenshot({ path: info.outputPath('fixture.png'), fullPage: false });

  const parts = unzipSync(readFileSync(FIXTURE));
  await input.focus(); await input.press('ControlOrMeta+End'); await page.keyboard.insertText(' Done.');
  const path = info.outputPath('hyphenation-edited.docx');
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  const out = unzipSync(readFileSync(path));
  for (const name in parts) if (name !== 'word/document.xml') expect(out[name], name).toEqual(parts[name]);
  expect(strFromU8(out['word/document.xml'])).toContain('<w:suppressAutoHyphens/>');
  expect(errors).toEqual([]);
});

test('hyphenation menu and dialogs fit a phone screen', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill(TEXT);
  await hyphenation(page, 'Hyphenation Options…');
  const dialog = page.getByRole('dialog', { name: 'Hyphenation' });
  await expect(dialog.getByRole('button', { name: 'OK', exact: true })).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath('hyphenation-options-390.png') });
  await dialog.getByRole('button', { name: 'Manual…', exact: true }).click();
  const manual = page.getByRole('dialog', { name: 'Manual Hyphenation' });
  await expect(manual).toBeVisible();
  expect((await manual.boundingBox()).width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath('manual-390.png') });
});
