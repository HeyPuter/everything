import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8 } from 'fflate';
import { onTab } from './helpers/editor-tools.js';

// What the user takes out of a document leaves the saved file: the old chart part (with its data) after Edit
// Chart Data or a delete, and the processed copy of a picture after Reset Picture. Undo after a save brings
// either back whole.
const PNG = readFileSync('icon-128.png');
const exported = async page => unzipSync(new Uint8Array(await page.evaluate(async () => [...new Uint8Array(await (await window.__docs.current.view.doc.exporter()).arrayBuffer())])));
const names = (parts, pattern) => Object.keys(parts).filter(name => pattern.test(name)).sort();
const containing = (parts, needle) => Object.keys(parts).filter(name => strFromU8(parts[name]).includes(needle));
async function reopen(page, input, parts, info, name, text) {
  const path = info.outputPath(`${name}.docx`); writeFileSync(path, zipSync(parts));
  const previous = await input.elementHandle();
  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel('Open DOCX file').setInputFiles(path);
  await expect.poll(() => previous.evaluate(el => el.isConnected)).toBe(false);
  await expect(input).toHaveValue(text);
  await expect(input).toHaveJSProperty('readOnly', false);
}
const selectObject = (page, nth = 0) => page.evaluate(nth => { const e = window.__docs.current.view.engine, m = e.model; let at = -1; for (let i = 0; i <= nth; i++) at = m.text.indexOf('￼', at + 1); m.select(at, at + 1); e.syncInput?.(); e.focus(); e.onSelection?.(); }, nth);
async function start(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.focus(); await page.keyboard.type('Report.');
  return input;
}

test('an edited or deleted chart leaves no chart part with its old data in the saved file', async ({ page }, info) => {
  test.setTimeout(120000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await start(page);
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Chart', exact: true }).click();
  const insert = page.getByRole('dialog', { name: 'Insert Chart' });
  await insert.getByRole('textbox', { name: 'Category 1', exact: true }).fill('Secret plan');
  await insert.getByRole('button', { name: 'Insert' }).click();
  await expect(input).toHaveValue('Report.￼');
  // Saved and opened again: the chart is now a part of the file.
  const first = await exported(page);
  expect(names(first, /^word\/charts\//)).toHaveLength(1);
  await reopen(page, input, first, info, 'chart', 'Report.￼');
  // Edit Chart Data: the category renamed.
  await selectObject(page);
  await onTab(page, 'insert');
  await page.locator('#ribbon-panel-insert').getByRole('button', { name: 'Chart', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Chart' });
  await edit.getByRole('textbox', { name: 'Category 1', exact: true }).fill('Public plan');
  await edit.getByRole('button', { name: 'Update' }).click();
  await expect(edit).toBeHidden();
  const edited = await exported(page);
  writeFileSync(info.outputPath('chart-edited.docx'), zipSync(edited));
  expect(names(edited, /^word\/charts\//)).toHaveLength(1);
  expect(containing(edited, 'Secret plan')).toEqual([]);
  expect(containing(edited, 'Public plan')).toHaveLength(1);
  // Deleted: no chart part, relationship or content type is left.
  await selectObject(page);
  await page.keyboard.press('Delete');
  await expect(input).toHaveValue('Report.');
  const deleted = await exported(page);
  writeFileSync(info.outputPath('chart-deleted.docx'), zipSync(deleted));
  expect(names(deleted, /chart/i)).toEqual([]);
  expect(strFromU8(deleted['word/_rels/document.xml.rels'])).not.toMatch(/chart/);
  expect(strFromU8(deleted['[Content_Types].xml'])).not.toMatch(/drawingml\.chart/);
  // Undo after the save: the chart is back and saves whole.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(input).toHaveValue('Report.￼');
  const restored = await exported(page);
  expect(names(restored, /^word\/charts\//)).toHaveLength(1);
  expect(containing(restored, 'Public plan')).toHaveLength(1);
  await reopen(page, input, restored, info, 'chart-restored', 'Report.￼');
  expect(await page.evaluate(() => window.__docs.current.view.engine.model.paragraphs.flatMap(p => p.runs).filter(r => r.image?.kind === 'chart').length)).toBe(1);
  expect(errors).toEqual([]);
});

test('Reset Picture leaves no processed copy of the picture in the saved file', async ({ page }, info) => {
  test.setTimeout(120000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const input = await start(page);
  await onTab(page, 'insert');
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect(input).toHaveValue('Report.￼');
  const ribbon = page.locator('#ribbon-panel-picture');
  await ribbon.getByRole('button', { name: 'Artistic Effects', exact: true }).click();
  await page.getByRole('menuitem', { name: /Pencil/ }).click();
  await expect.poll(async () => names(await exported(page), /^word\/media\//).length, { timeout: 30000 }).toBe(2);
  await reopen(page, input, await exported(page), info, 'processed', 'Report.￼');
  // Reset Picture shows the original again; the processed copy goes from the file.
  await selectObject(page);
  await onTab(page, 'picture');
  await ribbon.getByRole('button', { name: 'Reset Picture', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Reset Picture', exact: true }).click();
  await expect.poll(async () => strFromU8((await exported(page))['word/document.xml'])).not.toMatch(/a14:imgLayer/);
  const reset = await exported(page);
  writeFileSync(info.outputPath('picture-reset.docx'), zipSync(reset));
  expect(names(reset, /^word\/media\//)).toHaveLength(1);
  const embed = strFromU8(reset['word/document.xml']).match(/r:embed="([^"]+)"/)[1];
  expect(strFromU8(reset['word/_rels/document.xml.rels'])).toContain(`Id="${embed}"`);
  // Undo after the save: the processed picture is back, with both images.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => names(await exported(page), /^word\/media\//).length).toBe(2);
  expect(errors).toEqual([]);
});
