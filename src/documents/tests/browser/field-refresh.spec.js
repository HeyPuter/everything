import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { reopenDocx } from './helpers/reopen-docx.js';

const folder = 'tests/fixtures/field-refresh';
const references = JSON.parse(readFileSync(`${folder}/reference.json`, 'utf8').replace(/^\uFEFF/, ''));
const values = text => [...text.matchAll(/(?:Simple|Complex|Dirty|Locked): (\d+)/g)].map(m => m[1]);
const download = async (page, info, name) => {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .docx', exact: true }).click();
  const path = info.outputPath(name); await (await pending).saveAs(path); return readFileSync(path);
};
for (const reference of references) {
  test(`paginated opening refresh and native explicit update: ${reference.name}`, async ({ page }, info) => {
    const source = readFileSync(`${folder}/${reference.name}.docx`);
    expect(createHash('sha256').update(source).digest('hex')).toBe(reference.sourceSha256);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto('/playground.html');
    await page.getByLabel('Open DOCX file').setInputFiles(`${folder}/${reference.name}.docx`);
    const input = page.getByRole('textbox', { name: 'Document text' });
    const opening = reference.name === 'true' ? ['2', '2', '2', '66'] : ['99', '88', '2', '66'];
    await expect.poll(async () => values(await input.inputValue())).toEqual(opening);
    await expect(input).toHaveJSProperty('readOnly', false);
    await expect(page.locator('canvas.canvas-page')).toHaveCount(2);
    const opened = await download(page, info, 'opening.docx');
    const openingParts = unzipSync(opened);
    for (const [name, bytes] of Object.entries(unzipSync(source))) if (name !== 'word/document.xml') expect(openingParts[name]).toEqual(bytes);
    // The native reference's early opening caches are a documented lifecycle divergence.
    // Explicit update is compared with its paginated native result.
    writeFileSync(info.outputPath('native-lifecycle.json'), JSON.stringify({ opening, nativeOpening: reference.opened.map(f => f.result), nativeExplicit: reference.explicitUpdate.map(f => f.result) }, null, 2));
    await input.focus(); await input.press('F9');
    await expect.poll(async () => values(await input.inputValue())).toEqual(reference.explicitUpdate.map(f => f.result));
    const updated = await download(page, info, 'updated.docx');
    if (reference.name !== 'true') {
      await input.press('ControlOrMeta+z');
      expect(values(await input.inputValue())).toEqual(opening);
      expect(unzipSync(await download(page, info, 'undo.docx'))).toEqual(openingParts);
      await input.press('ControlOrMeta+y');
    }
    await reopenDocx(page, input, { name: 'updated.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: updated }, await input.inputValue());
    await expect.poll(async () => values(await input.inputValue())).toEqual(['2', '2', '2', '66']);
    await page.screenshot({ path: info.outputPath('page-references.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
}
test('context menu updates page references and leaves text editable', async ({ page }) => {
  await page.goto('/playground.html'); await page.getByLabel('Open DOCX file').setInputFiles(`${folder}/absent.docx`);
  const input = page.getByRole('textbox', { name: 'Document text' }); await expect(input).toHaveValue(/Dirty: 2/);
  await page.locator('canvas.canvas-page').first().click({ button: 'right', position: { x: 100, y: 100 } });
  await page.getByRole('menuitem', { name: 'Update page references', exact: true }).click();
  await expect(input).toHaveValue(/Simple: 2/); await input.press('ControlOrMeta+End'); await page.keyboard.insertText(' Editable');
  await expect(input).toHaveValue(/Editable$/);
});
test('relative and hyperlink switches refresh while unsupported results retain an editable preview', async ({ page }, info) => {
  await page.goto('/playground.html'); await page.getByLabel('Open DOCX file').setInputFiles(`${folder}/switches.docx`);
  const input = page.getByRole('textbox', { name: 'Document text' });
  await expect(input).toHaveValue(/Simple: on page 2\nComplex: II\nDirty: 77\nLocked: 66/);
  await expect(input).toHaveJSProperty('readOnly', false);
  await expect(page.locator('.canvas-message')).toContainText('Cached results were retained');
  await expect(page.locator('canvas.canvas-page')).toHaveCount(2);
  const bytes = await download(page, info, 'switches-updated.docx');
  const inspection = await page.evaluate(async data => {
    const { DocxPackage } = await import('/src/engine/docx.js');
    const { TextDocument } = await import('/src/engine/model.js');
    const { bodyFieldRanges } = await import('/src/engine/body-fields.js');
    const p = await DocxPackage.open(new Uint8Array(data)), d = new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
    const ranges = bodyFieldRanges(d.paragraphs); d.select(ranges[0].start, ranges[0].end);
    return { anchor: d.hyperlink.link.anchor, dirty: ranges[2].field.dirty, locked: ranges[3].field.locked };
  }, [...bytes]);
  expect(inspection).toEqual({ anchor: 'Target', dirty: true, locked: true });
  await reopenDocx(page, input, { name: 'switches-updated.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: bytes }, await input.inputValue());
  await page.screenshot({ path: info.outputPath('switches-and-retained-cache.png'), fullPage: true });
});
test('Update Fields on the Tools menu and after inserting a field updates sequences as F9 does', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.fill('One: ');
  const menu = async name => page.getByRole('menubar', { name: 'Menu bar' }).getByRole('menuitem', { name, exact: true }).click();
  async function sequence() {
    await menu('Insert');
    await page.getByRole('menu', { name: 'Insert', exact: true }).getByRole('menuitem', { name: 'Field…' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Field' });
    await dialog.getByLabel('Field names').selectOption('SEQ');
    await dialog.getByLabel('Field argument').fill('Figure');
    await dialog.locator('button[type=submit]').click();
    await expect(dialog).toBeHidden();
  }
  await sequence(); await page.keyboard.type(' Two: '); await sequence(); await page.keyboard.type(' Three: '); await sequence();
  await expect(input).toHaveValue('One: 1 Two: 2 Three: 3');
  // A sequence number put in front of the others: Tools › Update Fields renumbers them all.
  await input.evaluate(el => { el.focus(); el.setSelectionRange(0, 0); el.dispatchEvent(new Event('select')); });
  await page.keyboard.type('Zero: ');
  await page.evaluate(async () => {
    const { insertBodyField } = await import('/src/engine/field-results.js');
    const engine = window.__docs.current.view.engine;
    engine.execute(() => { engine.model.select('Zero: '.length); insertBodyField(engine.model, ' SEQ Figure ', '9'); engine.model.replace(' '); });
  });
  await expect(input).toHaveValue('Zero: 9 One: 1 Two: 2 Three: 3');
  await menu('Tools');
  await page.getByRole('menu', { name: 'Tools', exact: true }).getByRole('menuitem', { name: /Update Fields/ }).click();
  await expect(input).toHaveValue('Zero: 1 One: 2 Two: 3 Three: 4');
  expect(errors).toEqual([]);
});
