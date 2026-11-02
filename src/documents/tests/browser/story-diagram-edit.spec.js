import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { onTab } from './helpers/editor-tools.js';

// Edit Diagram on a diagram in a header edits it there: it used to leave the header for the body first
// and then report that the document had changed while the drawing was prepared.
const exported = page => page.evaluate(async () => [...new Uint8Array(await (await window.__docs.current.view.doc.exporter()).arrayBuffer())]);
const alts = page => page.evaluate(() => {
  const e = window.__docs.current.view.engine, of = paragraphs => paragraphs.flatMap(p => p.runs).filter(r => r.image).map(r => r.image.alt);
  return { path: e.session.path, body: of(e.session.body.paragraphs), header: of(Object.values(e.pageStories?.stories || {}).find(s => s.kind === 'header')?.paragraphs || []) };
});

test('Edit Diagram changes a diagram in a header where it is, saves it there and undoes', async ({ page }, info) => {
  test.setTimeout(90000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  const input = page.getByRole('textbox', { name: 'Document text' });
  await input.focus(); await page.keyboard.type('Body text.');
  const insert = page.locator('#ribbon-panel-insert');
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Diagram', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Basic Process/ }).click();
  await page.getByRole('dialog', { name: 'Diagram' }).getByRole('textbox', { name: 'Diagram text' }).fill('Plan\nBuild');
  await page.getByRole('dialog', { name: 'Diagram' }).getByRole('button', { name: 'Insert' }).click();
  await expect.poll(async () => (await alts(page)).body).toEqual(['Diagram: Basic Process (Blue)\nPlan\nBuild']);
  // The saved diagram moved into a default header.
  const parts = unzipSync(new Uint8Array(await exported(page)));
  const doc = strFromU8(parts['word/document.xml']), run = doc.match(/<w:r><w:drawing[\s\S]*?<\/w:drawing><\/w:r>/)[0];
  parts['word/document.xml'] = strToU8(doc.replace(run, '').replace('<w:sectPr>', '<w:sectPr><w:headerReference xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" w:type="default" r:id="rHeader"/>'));
  parts['word/header1.xml'] = strToU8(`<w:hdr${doc.match(/^<w:document([^>]*)>/)[1]}><w:p>${run}</w:p></w:hdr>`);
  parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']).replace('</Relationships>', '<Relationship Id="rHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>'));
  parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('</Types>', '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>'));
  const path = info.outputPath('header-diagram.docx'); writeFileSync(path, zipSync(parts));
  const previous = await input.elementHandle();
  page.once('dialog', dialog => dialog.accept());
  await page.getByLabel('Open DOCX file').setInputFiles(path);
  await expect.poll(() => previous.evaluate(el => el.isConnected)).toBe(false);
  await expect(input).toHaveValue('Body text.');
  await expect(input).toHaveJSProperty('readOnly', false);
  // Select the diagram in the header and edit it.
  await page.evaluate(() => {
    const e = window.__docs.current.view.engine, path = Object.keys(e.pageStories.stories).find(p => e.pageStories.stories[p].kind === 'header');
    e.editStory(path, 0); const at = e.model.text.indexOf('￼'); e.model.select(at, at + 1); e.focus(); e.onSelection?.();
  });
  await onTab(page, 'insert');
  await insert.getByRole('button', { name: 'Diagram', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit Selected Diagram…' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Diagram' });
  await expect(edit.getByRole('textbox', { name: 'Diagram text' })).toHaveValue('Plan\nBuild');
  await edit.getByRole('textbox', { name: 'Diagram text' }).fill('Draft\nReview\nPublish');
  await edit.getByRole('button', { name: 'Update' }).click();
  await expect(edit).toBeHidden();
  await expect.poll(() => alts(page)).toEqual({ path: 'word/header1.xml', body: [], header: ['Diagram: Basic Process (Blue)\nDraft\nReview\nPublish'] });
  await expect(page.getByText('The document changed while the drawing was prepared')).toHaveCount(0);
  // Saved in the header part; the body holds no drawing.
  const saved = unzipSync(new Uint8Array(await exported(page)));
  expect(strFromU8(saved['word/header1.xml'])).toMatch(/descr="Diagram: Basic Process \(Blue\)&#10;Draft&#10;Review&#10;Publish"/);
  expect(strFromU8(saved['word/document.xml'])).not.toMatch(/<w:drawing/);
  // One undo step brings the old diagram back.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await alts(page)).header).toEqual(['Diagram: Basic Process (Blue)\nPlan\nBuild']);
  expect(errors).toEqual([]);
});
