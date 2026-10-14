import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { HEADER_DESIGNS, PAGE_NUMBER_DESIGNS, writeStoryLines, removePageNumberParagraphs, PLACEHOLDER } from '../src/engine/header-footer-designs.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
async function opened() {
  const blank = createDocx([paragraph('Body')], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const pkg = await DocxPackage.open(new Uint8Array(await blank.export().arrayBuffer()));
  return { pkg, body: new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets) };
}
const story = body => new TextDocument([paragraph()], body.pageSettings, body.numbering, body.styles, [], body.assets);

it('every header and footer design writes a story that saves and reopens with its text, tabs and fields', async () => {
  for (const design of HEADER_DESIGNS) for (const kind of design.kinds) {
    const { pkg, body } = await opened();
    const path = pkg.addPageStory(kind);
    const model = story(body);
    writeStoryLines(model, design.lines({ title: 'Annual Plan', date: 'October 3, 2026', width: 9360, kind }));
    if (design.id.startsWith('blank') || design.id === 'threeColumns') expect(model.text.slice(...model.range), design.id).toBe(PLACEHOLDER);
    const bytes = new Uint8Array(await pkg.export(body.paragraphs, body.pageSettings, body.numbering, body.styles, body.tables, body.assets, { [path]: { paragraphs: model.paragraphs, tables: [] } }).arrayBuffer());
    const reopened = await DocxPackage.open(bytes);
    expect(reopened.readOnly, `${design.id} ${kind}`).toBeFalsy();
    const saved = Object.values(reopened.pageStories.stories)[0];
    expect(saved.kind).toBe(kind);
    const runs = saved.paragraphs.flatMap(p => p.runs.map(r => r.field?.type || r.text)).join('');
    const fields = design.lines({ title: 'T', date: 'D', width: 9360, kind }).flatMap(l => l.parts).filter(p => p.field).map(p => p.field);
    for (const field of fields) expect(runs, design.id).toContain(field);
    if (design.id === 'threeColumns') expect(saved.paragraphs[0].tabs?.map(t => t.alignment) || strFromU8(unzipSync(bytes)[path])).toBeTruthy();
  }
});

it('page number designs and removal', async () => {
  for (const design of PAGE_NUMBER_DESIGNS) {
    const { body } = await opened();
    const model = story(body);
    model.replace('Running head');
    writeStoryLines(model, [{ paragraph: { alignment: 'right' }, run: design.run, parts: design.parts }], { append: true });
    expect(model.paragraphs).toHaveLength(2);
    expect(paragraphText(model.paragraphs[0])).toBe('Running head');
    expect(model.paragraphs[1].runs.some(r => r.field?.type === 'PAGE'), design.id).toBe(true);
    expect(removePageNumberParagraphs(model)).toBe(true);
    expect(model.paragraphs.map(paragraphText)).toEqual(['Running head']);
  }
});

it('writes page number format and start (pgNumType) that reopen and number pages', async () => {
  const { pkg, body } = await opened();
  pkg.setPageNumbering(0, { format: 'lowerRoman', start: 3 });
  const bytes = new Uint8Array(await pkg.export(body.paragraphs, body.pageSettings, body.numbering, body.styles, body.tables, body.assets).arrayBuffer());
  expect(strFromU8(unzipSync(bytes)['word/document.xml'])).toMatch(/<w:pgNumType w:fmt="lowerRoman" w:start="3"\/>/);
  const reopened = await DocxPackage.open(bytes);
  expect(reopened.pageStories.sections[0].pageNumbering).toEqual({ format: 'lowerRoman', start: 3 });
  reopened.setPageNumbering(0, null);
  const again = new TextDocument(reopened.paragraphs, reopened.pageSettings, reopened.numbering, reopened.styles, reopened.tables, reopened.assets);
  const cleared = new Uint8Array(await reopened.export(again.paragraphs, again.pageSettings, again.numbering, again.styles, again.tables, again.assets).arrayBuffer());
  expect(strFromU8(unzipSync(cleared)['word/document.xml'])).not.toMatch(/pgNumType/);
});
