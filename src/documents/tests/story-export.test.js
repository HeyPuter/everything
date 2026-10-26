import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { DocxPackage, W } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const open = file => DocxPackage.open(readFileSync(file));
const model = (pkg, path) => {
  const story = pkg.pageStories.stories[path];
  return new TextDocument(story.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, story.tables, pkg.assets);
};
const save = async (pkg, path, d) => new Uint8Array(await pkg.export(undefined, undefined, undefined, undefined, undefined, undefined, { [path]: { paragraphs: d.paragraphs, tables: d.tables } }).arrayBuffer());

it.each([
  ['tests/fixtures/page-stories/footer-variants.docx', 'word/footer-even.xml'],
  ['public/fixtures/page-story-tables.docx', 'word/header.xml'],
  ['public/fixtures/header-drawings.docx', 'word/stories/header.xml'],
])('edits %s story text while preserving other parts, then undoes exactly', async (file, path) => {
  const pkg = await open(file), d = model(pkg, path);
  expect(unzipSync(await save(pkg, path, d))).toEqual(pkg.parts);
  const before = d.text;
  const fields = d.paragraphs.flatMap(p => p.runs).filter(r => r.field).map(r => r.field);
  d.select(0); d.replace('Edited story ');
  const bytes = await save(pkg, path, d), parts = unzipSync(bytes);
  expect(parts[path]).not.toEqual(pkg.parts[path]);
  for (const name of Object.keys(pkg.parts)) if (name !== path) expect(parts[name], name).toEqual(pkg.parts[name]);
  const reopened = await DocxPackage.open(bytes), result = model(reopened, path);
  expect(result.text).toBe('Edited story ' + before);
  expect(result.paragraphs.flatMap(p => p.runs).filter(r => r.field).map(r => r.field)).toEqual(fields);
  expect(result.tables).toHaveLength(d.tables.length);
  d.undo(); expect(unzipSync(await save(pkg, path, d))).toEqual(pkg.parts);
});

it('creates a story-local hyperlink and reopens it without changing body relationships', async () => {
  const pkg = await open('tests/fixtures/page-stories/footer-variants.docx'), path = 'word/footer-even.xml', d = model(pkg, path);
  d.select(0, 4); d.setHyperlink('https://example.org/story');
  const bytes = await save(pkg, path, d), parts = unzipSync(bytes), reopened = await DocxPackage.open(bytes);
  expect(parts['word/_rels/document.xml.rels']).toEqual(pkg.parts['word/_rels/document.xml.rels']);
  expect(reopened.pageStories.stories[path].paragraphs[0].runs[0].link.target).toBe('https://example.org/story');
  d.undo(); expect(unzipSync(await save(pkg, path, d))).toEqual(pkg.parts);
});

it('saves page-field formatting on the field rather than dropping the change', async () => {
  const pkg = await open('tests/fixtures/page-stories/footer-variants.docx'), path = 'word/footer-even.xml', d = model(pkg, path);
  const run = d.paragraphs.flatMap(p => p.runs).find(r => r.field);
  run.overrides = { bold: true };
  const reopened = await DocxPackage.open(await save(pkg, path, d));
  expect(reopened.pageStories.stories[path].paragraphs.flatMap(p => p.runs).find(r => r.field).bold).toBe(true);
  run.text = 'x';
  await expect(save(pkg, path, d)).rejects.toThrow('page-field results');
});

it('retains a simple field instruction and cached result after adjacent text is edited', async () => {
  const parts = unzipSync(readFileSync('tests/fixtures/page-stories/footer-variants.docx')), path = 'word/footer-even.xml';
  parts[path] = strToU8(`<w:ftr xmlns:w="${W}"><w:p><w:r><w:t>Page </w:t></w:r><w:fldSimple w:instr=" NUMPAGES " w:dirty="true"><w:r><w:rPr><w:b/></w:rPr><w:t>99</w:t></w:r></w:fldSimple></w:p></w:ftr>`);
  const pkg = await DocxPackage.open(zipSync(parts)), d = model(pkg, path), field = d.paragraphs[0].runs.find(r => r.field).field;
  d.select(0, 4); d.replace('Total');
  const reopened = await DocxPackage.open(await save(pkg, path, d));
  expect(reopened.pageStories.stories[path].paragraphs[0].runs.find(r => r.field).field).toEqual(field);
  d.undo(); expect(unzipSync(await save(pkg, path, d))).toEqual(parts);
});

it('does not rewrite projected content controls or unknown story paths', async () => {
  const pkg = await open('public/fixtures/retained-story-controls.docx');
  const path = Object.keys(pkg.pageStories.stories).find(path => new TextDecoder().decode(pkg.parts[path]).includes(':sdt'));
  const d = model(pkg, path); d.select(0); d.replace('Edit ');
  await expect(save(pkg, path, d)).rejects.toThrow('content controls');
  await expect(save(pkg, 'word/missing.xml', d)).rejects.toThrow('existing page stories');
});
