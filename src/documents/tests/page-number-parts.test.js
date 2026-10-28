import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { layoutPageStories } from '../src/engine/page-story-layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';

// Word's Insert > Page Number building blocks: headers and footers whose paragraphs sit in block-level
// docPartObj controls (fixture: tests/fixtures/page-number-parts, independently authored XML).
const source = readFileSync('public/fixtures/page-number-parts.docx');
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const model = (pkg, paragraphs = pkg.paragraphs, tables = pkg.tables) => new TextDocument(paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, tables, pkg.assets);
const measure = text => ({ width: text.length * 7, ascent: 12, descent: 4 });
const storyText = story => story.paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\n');
const save = async (pkg, body, edits) => unzipSync(new Uint8Array(await pkg.export(body.paragraphs, body.pageSettings, body.numbering, body.styles, body.tables, body.assets, edits).arrayBuffer()));

it('opens Top of Page, Bottom of Page and Page X of Y headers and footers for editing, showing their numbers', async () => {
  const pkg = await DocxPackage.open(source), body = model(pkg);
  expect(pkg.readOnly).toBeFalsy();
  const stories = pkg.pageStories.stories;
  for (const path of ['word/header1.xml', 'word/footer1.xml', 'word/footer2.xml']) expect(stories[path].editable, path).toBe(true);
  expect(stories['word/footer2.xml'].paragraphs[0].blockControls.map(c => /Bottom of Page/.test(c.shell) ? 'bottom' : 'top')).toEqual(['bottom', 'top']);
  const layout = layoutDocument(body.paragraphs, measure, pageGeometry(body.pageSettings), body.numbering, body.tables, pkg.pageStories);
  const placed = layoutPageStories(layout, pkg.pageStories, [body.pageSettings], measure, body.numbering, { styles: body.styles });
  const text = path => placed.lines.filter(l => l.pageStory === path).map(l => [l.page, l.fragments.filter(f => !f.image).map(f => f.text).join('')]).filter(([, t]) => t);
  expect(text('word/footer2.xml')).toEqual([[0, 'Page 1 of 3']]);
  expect(text('word/footer1.xml')).toEqual([[1, '2'], [2, '3']]);
  // The first page has its own (absent) first-page header.
  expect(text('word/header1.xml')).toEqual([[1, '2'], [2, '3']]);
  // Unedited, the package saves byte for byte.
  expect(await save(pkg, body)).toEqual(unzipSync(source));
});

it('saves an edited page-number footer inside its building-block wrappers and reopens it editable', async () => {
  const pkg = await DocxPackage.open(source), body = model(pkg);
  const edits = {};
  for (const path of ['word/footer1.xml', 'word/footer2.xml', 'word/header1.xml']) {
    const story = pkg.pageStories.stories[path], doc = model(pkg, story.paragraphs, story.tables);
    doc.select(0); doc.replace(path.includes('header') ? 'Chapter 1 ' : 'Draft · ');
    edits[path] = { paragraphs: doc.paragraphs, tables: doc.tables };
  }
  const parts = await save(pkg, body, edits);
  const footer = strFromU8(parts['word/footer2.xml']);
  // The Bottom of Page wrapper holds the Top of Page wrapper, which holds the edited paragraph.
  expect(footer).toMatch(/<w:sdt><w:sdtPr><w:id w:val="98404467"\/><w:docPartObj><w:docPartGallery w:val="Page Numbers \(Bottom of Page\)"\/><w:docPartUnique\/><\/w:docPartObj><\/w:sdtPr><w:sdtContent><w:sdt><w:sdtPr><w:id w:val="1728636285"\/>.*<w:sdtContent><w:p>.*Draft · .*NUMPAGES.*<\/w:p><\/w:sdtContent><\/w:sdt><\/w:sdtContent><\/w:sdt><w:p>/);
  expect(strFromU8(parts['word/footer1.xml'])).toMatch(/<w:sdtEndPr><w:rPr><w:noProof\/><\/w:rPr><\/w:sdtEndPr><w:sdtContent><w:p>.*Draft · .*PAGE.*<\/w:p><\/w:sdtContent><\/w:sdt>/);
  expect(strFromU8(parts['word/header1.xml'])).toMatch(/Page Numbers \(Top of Page\).*<w:sdtContent><w:p>.*Chapter 1 .*<\/w:p><\/w:sdtContent><\/w:sdt><w:p>/);
  for (const name of Object.keys(parts)) if (!/word\/(header1|footer[12])\.xml$/.test(name)) expect(parts[name], name).toEqual(unzipSync(source)[name]);
  const again = await DocxPackage.open(zipSync(parts));
  expect(storyText(again.pageStories.stories['word/footer2.xml'])).toBe('Draft · Page ￼ of ￼\n');
  expect(again.pageStories.stories['word/footer2.xml'].editable).toBe(true);
  expect(storyText(again.pageStories.stories['word/header1.xml'])).toBe('Chapter 1 ￼\n');
});

it('keeps a locked or inline page-number control retained, as before', async () => {
  const parts = unzipSync(source);
  parts['word/footer1.xml'] = strToU8(strFromU8(parts['word/footer1.xml']).replace('<w:docPartObj>', '<w:lock w:val="sdtContentLocked"/><w:docPartObj>'));
  const pkg = await DocxPackage.open(zipSync(parts));
  expect(pkg.readOnly).toBeFalsy();
  expect(pkg.pageStories.stories['word/footer1.xml'].editable).toBe(false);
  expect(storyText(pkg.pageStories.stories['word/footer1.xml'])).toBe('￼\n');
  expect(pkg.pageStories.stories['word/footer2.xml'].editable).toBe(true);
});
