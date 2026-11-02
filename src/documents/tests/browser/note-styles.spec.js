import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { onTab, downloadDocx } from './helpers/editor-tools.js';

// A new footnote or endnote uses Word's note styles: the note's paragraph in Footnote Text (Endnote
// Text), its reference marks in Footnote Reference (Endnote Reference). A document without them gets
// Word's definitions, so the notes look the same and stay restyleable together in Word.
const input = page => page.getByRole('textbox', { name: 'Document text' });
const ribbon = page => page.locator('#ribbon-panel-references');

async function save(page, info, name) {
  const path = info.outputPath(`${name}.docx`);
  const download = page.waitForEvent('download'); await downloadDocx(page); await (await download).saveAs(path);
  const parts = unzipSync(new Uint8Array(readFileSync(path)));
  return { path, xml: part => strFromU8(parts[part]) };
}

test('new notes use the footnote and endnote text and reference styles, created when the document lacks them', async ({ page }, info) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/mock.html#/new');
  await expect((await onTab(page, 'home')).getByRole('button', { name: 'Bold', exact: true })).toBeEnabled();
  await page.locator('canvas.canvas-page').first().click({ position: { x: 150, y: 110 } });
  await page.keyboard.type('First claim. Second claim.');
  await page.evaluate(() => { const m = window.__docs.current.view.engine.model; m.select(m.text.indexOf('.')); });
  await onTab(page, 'references');
  await ribbon(page).getByRole('button', { name: 'Insert Footnote', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Footnote text' })).toBeFocused();
  await page.keyboard.type('A footnote.');
  await page.keyboard.press('Escape');
  await input(page).press('ControlOrMeta+End');
  await ribbon(page).getByRole('button', { name: 'Insert Endnote', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Endnote text' })).toBeFocused();
  await page.keyboard.type('An endnote.');
  // Laid out at 10 pt with no space after, as before.
  const note = await page.evaluate(() => {
    const engine = window.__docs.current.view.engine, story = engine.session.model;
    return { size: story.paragraphs[0].runs.at(-1).fontSize, after: story.paragraphs[0].format.spaceAfter };
  });
  expect(note).toEqual({ size: 10, after: 0 });
  const { xml } = await save(page, info, 'note-styles');
  const styles = xml('word/styles.xml'), body = xml('word/document.xml');
  for (const [kind, Kind] of [['footnote', 'Footnote'], ['endnote', 'Endnote']]) {
    const part = xml(`word/${kind}s.xml`);
    const paragraph = part.match(new RegExp(`<w:${kind} w:id="1">([\\s\\S]*?)</w:${kind}>`))[1];
    expect(paragraph).toContain(`<w:pStyle w:val="${Kind}Text"/>`);
    expect(paragraph).toMatch(new RegExp(`<w:rStyle w:val="${Kind}Reference"/>[\\s\\S]*<w:${kind}Ref/>`));
    // No direct size or spacing: the style carries them.
    expect(paragraph).not.toMatch(/<w:sz |<w:spacing /);
    expect(body).toMatch(new RegExp(`<w:rStyle w:val="${Kind}Reference"/>(?:(?!</w:r>)[\\s\\S])*<w:${kind}Reference `));
    const text = styles.match(new RegExp(`<w:style [^>]*w:styleId="${Kind}Text"[^>]*>[\\s\\S]*?</w:style>`))?.[0];
    expect(text).toMatch(new RegExp(`<w:name w:val="${kind} text"/>`));
    expect(text).not.toContain('w:customStyle');
    expect(text).toMatch(/<w:spacing [^>]*w:after="0"/);
    expect(text).toContain('<w:sz w:val="20"/>');
    const reference = styles.match(new RegExp(`<w:style [^>]*w:styleId="${Kind}Reference"[^>]*>[\\s\\S]*?</w:style>`))?.[0];
    expect(reference).toMatch(new RegExp(`<w:name w:val="${kind} reference"/>`));
    expect(reference).toContain('<w:vertAlign w:val="superscript"/>');
  }
  expect(errors).toEqual([]);
});
