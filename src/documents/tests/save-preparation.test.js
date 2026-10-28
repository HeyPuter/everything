// @vitest-environment jsdom
import { it, expect, vi, beforeEach } from 'vitest';
import { Blob } from 'node:buffer';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { docxWithParagraphs } from './helpers/docx.js';

// jsdom's Blob cannot be read back; Node's can.
beforeEach(() => vi.stubGlobal('Blob', Blob));
const source = () => docxWithParagraphs(Array.from({ length: 30 }, (_, i) => ({ text: `Paragraph ${i} of the saved document.`, heading: i % 10 === 0 })));
const documentXml = async blob => strFromU8(unzipSync(new Uint8Array(await blob.arrayBuffer()))['word/document.xml']);
async function saved(pkg, edit) {
  const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  edit(model);
  return model;
}

it('saves each edit as a freshly opened package would, however often it saved before and whatever it parsed ahead', async () => {
  const pkg = await DocxPackage.open(source());
  // Parse ahead a little at a time, as the editor does while the page is idle.
  let calls = 0;
  while (pkg.prepareSave(() => (calls++ % 2 ? 0 : 5))) if (calls > 1000) throw new Error('prepareSave never finished');
  for (const [at, text] of [[10, 'one '], [200, 'two '], [5, 'three ']]) {
    const model = await saved(pkg, m => { m.select(at); m.replace(text); });
    const fresh = await DocxPackage.open(source());
    const expected = await documentXml(fresh.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets));
    expect(await documentXml(pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets))).toBe(expected);
    expect(await documentXml(await pkg.exportAsync(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets))).toBe(expected);
    expect(expected).toContain(text.trim());
  }
});

it('zips the same parts asynchronously as at once', async () => {
  const pkg = await DocxPackage.open(source());
  const model = await saved(pkg, m => { m.select(0); m.replace('Start: '); });
  const args = [model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets];
  const now = unzipSync(new Uint8Array(await pkg.export(...args).arrayBuffer()));
  const later = unzipSync(new Uint8Array(await (await pkg.exportAsync(...args)).arrayBuffer()));
  expect(Object.keys(later).sort()).toEqual(Object.keys(now).sort());
  for (const name of Object.keys(now)) if (!/core\.xml$/.test(name)) expect(strFromU8(later[name])).toBe(strFromU8(now[name]));
});
