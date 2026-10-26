import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraphText } from '../src/engine/model.js';
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = name => readFileSync(`tests/fixtures/alternate-run-recovery/${name}.docx`);
const all = p => [...p.paragraphs, ...Object.values(p.pageStories.stories).flatMap(s => s.paragraphs)];
const cases = ['before', 'after', 'both'].flatMap(position => ['choice', 'fallback', 'empty'].map(branch => ({ position, branch })));
it.each(cases)('retains selected $branch content $position a healthy picture', async ({ position, branch }) => {
  const name = `${position}-${branch}`, bytes = source(name + '-wrapped');
  await expect(DocxPackage.open(bytes)).rejects.toThrow('alternate content other than one drawing');
  const pkg = await DocxPackage.open(bytes, { bestEffort: true });
  const control = await DocxPackage.open(source(name + '-matched'));
  expect(pkg.readOnly).toBe(true); expect(control.readOnly).not.toBe(true);
  const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { displayOnly: true });
  const matched = new TextDocument(control.paragraphs, control.pageSettings, control.numbering, control.styles, control.tables, control.assets);
  expect(model.text).toBe(matched.text); expect(model.text).not.toContain('UNSELECTED');
  expect(pkg.tables).toHaveLength(1);
  expect(all(pkg).flatMap(p => p.runs).filter(r => r.image && r.bold && r.link)).toHaveLength(branch === 'empty' ? 4 : position === 'both' ? 12 : 8);
  for (const number of [10, 20, 30, 40]) {
    const p = all(pkg).find(p => paragraphText(p).includes(`Linked ${number}`));
    expect(p.format.indentLeft).toBe(360);
    expect(p.runs.find(r => r.text.startsWith(`Linked ${number}`))).toMatchObject({ bold: true, color: '803020', fontSize: 14 });
    expect(p.runs.find(r => r.text === 'Linked tail')).toMatchObject({ italic: true, link: { target: 'https://example.com/retained' } });
  }
  for (const part of ['word/document.xml', 'word/header1.xml', 'word/footer1.xml']) expect(pkg.previewIssues.some(s => s.includes(part) && s.includes('selected branch'))).toBe(true);
  expect(pkg.parts).toEqual(unzipSync(bytes)); expect(() => pkg.export()).toThrow('read-only');
  expect(unzipSync(new Uint8Array(await control.export().arrayBuffer()))).toEqual(control.parts);
});
it('expands nested selected branches without displaying an unselected fallback', async () => {
  const parts = unzipSync(source('both-choice-wrapped'));
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replaceAll('<w:t>Selected</w:t>',
    '<mc:AlternateContent><mc:Choice Requires="w"><w:t>Selected</w:t></mc:Choice><mc:Fallback><w:t>WRONG BRANCH</w:t></mc:Fallback></mc:AlternateContent>'));
  const pkg = await DocxPackage.open(zipSync(parts), { bestEffort: true });
  const matched = await DocxPackage.open(source('both-choice-matched'));
  expect(pkg.paragraphs.map(paragraphText)).toEqual(matched.paragraphs.map(paragraphText));
  expect(all(pkg).flatMap(p => p.runs).filter(r => r.image && r.bold && r.link)).toHaveLength(12);
  expect(pkg.parts).toEqual(parts);
});
it('contains an unsupported selected child instead of trying the fallback', async () => {
  const parts = unzipSync(source('before-choice-wrapped'));
  const ruby = '<w:ruby><w:rubyPr><w:rubyAlign w:val="center"/><w:hps w:val="14"/><w:hpsRaise w:val="20"/><w:hpsBaseText w:val="28"/><w:lid w:val="ja-JP"/></w:rubyPr><w:rt><w:r><w:t>reading</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>BASE</w:t></w:r></w:rubyBase></w:ruby>';
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replaceAll('<w:t>Selected</w:t>', ruby));
  const pkg = await DocxPackage.open(zipSync(parts), { bestEffort: true });
  const text = pkg.paragraphs.map(paragraphText).join('\n');
  expect(text).toContain('readingBASE'); expect(text).not.toContain('UNSELECTED');
  expect(all(pkg).flatMap(p => p.runs).filter(r => r.image && r.bold && r.link)).toHaveLength(8);
  expect(pkg.previewIssues.some(s => s.includes('ruby'))).toBe(true);
  expect(pkg.parts).toEqual(parts);
});
it('opens emoji that Word stores as symbol extensions for editing', async () => {
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const emoji = (char, text) => `<w:r><w:rPr><w:b/></w:rPr><mc:AlternateContent><mc:Choice Requires="w16se"><w16se:symEx w16se:font="Segoe UI Emoji" w16se:char="${char}"/></mc:Choice><mc:Fallback><w:t>${text}</w:t></mc:Fallback></mc:AlternateContent></w:r>`;
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<w:document xmlns:w="${W}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex" mc:Ignorable="w16se"><w:body>`
      + `<w:p><w:r><w:t xml:space="preserve">Great work </w:t></w:r>${emoji('1F600', '😀')}${emoji('1F44D', '👍')}<w:r><w:t xml:space="preserve"> team</w:t></w:r></w:p>`
      + `<w:p><w:r><w:t xml:space="preserve">Untouched </w:t></w:r>${emoji('1F389', '🎉')}</w:p><w:sectPr/></w:body></w:document>`,
  };
  const bytes = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
  const pkg = await DocxPackage.open(bytes, { bestEffort: true });
  expect(pkg.readOnly).not.toBe(true);
  const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  expect(model.text).toBe('Great work 😀👍 team\nUntouched 🎉');
  expect(model.paragraphs[0].runs.find(r => r.text.includes('😀')).bold).toBe(true);
  expect(unzipSync(new Uint8Array(await pkg.export().arrayBuffer()))).toEqual(unzipSync(bytes));
  model.select(0, 5); model.replace('Nice');
  const saved = unzipSync(new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets).arrayBuffer()));
  const xml = strFromU8(saved['word/document.xml']);
  // The rewritten paragraph keeps its emoji as text; the untouched one keeps its symbol extension.
  expect(xml.match(/w16se:symEx/g)).toHaveLength(1);
  const reopened = await DocxPackage.open(zipSync(saved));
  expect(reopened.readOnly).not.toBe(true);
  expect(new TextDocument(reopened.paragraphs).text).toBe('Nice work 😀👍 team\nUntouched 🎉');
  expect(reopened.paragraphs[0].runs.find(r => r.text.includes('👍')).bold).toBe(true);
});
