import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { createDocx, DocxPackage, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { StorySession } from '../src/engine/story-session.js';
import { outlineRows, outlineUnits, outlineLevelOf, moveOutlineBlock, moveOutlineSection, setOutlineLevels, promotedLevel, demotedLevel,
  deleteOutlineSection, insertOutlineHeading, styleForOutlineLevel, BODY_LEVEL } from '../src/engine/outline-editing.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const bytes = async blob => new Uint8Array(await blob.arrayBuffer());
/** A document of [text, style] pairs with the built-in writing styles. */
async function outlineDocument(spec) {
  const pkg = await DocxPackage.open(await bytes(createDocx(spec.map(([text, styleId]) => paragraph(text, styleId ? { styleId, styleChanged: true } : {})), undefined, undefined, undefined, [], {}, WRITING_STYLES).export()));
  const session = new StorySession(new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets), null);
  return { pkg, session, model: session.model, id: text => session.model.paragraphs.find(p => p.runs.map(r => r.text).join('') === text).id };
}
const SPEC = [['Intro', 'Heading1'], ['Intro body', null], ['Detail', 'Heading2'], ['Detail body', null], ['Results', 'Heading1'], ['Results body', null], ['', null]];
const texts = model => model.paragraphs.map(p => p.runs.map(r => r.text).join(''));
const levels = model => model.paragraphs.map(outlineLevelOf);

describe('outline structure', () => {
  it('reads heading and body levels and which headings lead others', async () => {
    const { model } = await outlineDocument(SPEC);
    expect(levels(model)).toEqual([1, BODY_LEVEL, 2, BODY_LEVEL, 1, BODY_LEVEL, BODY_LEVEL]);
    const rows = outlineRows(model.paragraphs);
    expect(rows.map(r => [r.text, r.level, r.parent])).toEqual([['Intro', 1, true], ['Intro body', 10, false], ['Detail', 2, true], ['Detail body', 10, false], ['Results', 1, true], ['Results body', 10, false], ['', 10, false]]);
    expect(rows[2].start).toBe('Intro\nIntro body\n'.length);
    expect(styleForOutlineLevel(model.styles, 2).id).toBe('Heading2');
    expect(styleForOutlineLevel(model.styles, BODY_LEVEL).id).toBe('Normal');
    expect(styleForOutlineLevel(model.styles, 8)).toBeNull();
  });
});

describe('moving sections', () => {
  it('moves a heading with its subtree past its sibling section, as one undo step', async () => {
    const { session, model, id } = await outlineDocument(SPEC);
    session.run(m => moveOutlineBlock(m, id('Results'), -1));
    expect(texts(model)).toEqual(['Results', 'Results body', 'Intro', 'Intro body', 'Detail', 'Detail body', '']);
    session.run(m => moveOutlineBlock(m, id('Results'), 1));
    expect(texts(model)).toEqual(['Intro', 'Intro body', 'Detail', 'Detail body', 'Results', 'Results body', '']);
    expect(session.history).toHaveLength(2);
    session.undo();
    expect(texts(model)).toEqual(['Results', 'Results body', 'Intro', 'Intro body', 'Detail', 'Detail body', '']);
  });
  it('moves a body paragraph one unit at a time and keeps the final paragraph last', async () => {
    const { session, model, id } = await outlineDocument(SPEC);
    session.run(m => moveOutlineBlock(m, id('Intro body'), 1, { withSubtree: false }));
    expect(texts(model).slice(0, 3)).toEqual(['Intro', 'Detail', 'Intro body']);
    session.run(m => moveOutlineBlock(m, id('Results body'), 1, { withSubtree: false }));
    expect(texts(model).at(-1)).toBe('');
    expect(session.run(m => moveOutlineBlock(m, id('Intro'), -1))).toBe(false);
  });
  it('keeps the caret in the text it was in', async () => {
    const { session, model, id } = await outlineDocument(SPEC);
    const at = model.text.indexOf('Results body') + 3;
    model.select(at);
    session.run(m => moveOutlineBlock(m, id('Results'), -1));
    expect(model.text.slice(model.selection.focus, model.selection.focus + 9)).toBe('ults body');
  });
  it('drags a section before or after another', async () => {
    const { session, model, id } = await outlineDocument(SPEC);
    session.run(m => moveOutlineSection(m, id('Detail'), id('Results'), 'after'));
    expect(texts(model)).toEqual(['Intro', 'Intro body', 'Results', 'Results body', 'Detail', 'Detail body', '']);
    session.run(m => moveOutlineSection(m, id('Results'), id('Intro'), 'before'));
    // Detail now sits under Results, so it travels with it.
    expect(texts(model)).toEqual(['Results', 'Results body', 'Detail', 'Detail body', 'Intro', 'Intro body', '']);
    // A section cannot be dropped into itself.
    expect(moveOutlineSection(model, id('Intro'), id('Intro body'))).toBe(false);
  });
  it('refuses to move section breaks', async () => {
    const { model, id } = await outlineDocument(SPEC);
    model.paragraphs[3].sectionEnd = { ...model.pageSettings };
    expect(() => moveOutlineBlock(model, id('Intro'), 1)).toThrow(/section breaks/);
  });
});

describe('promoting and demoting', () => {
  it('uses the heading styles and moves subheadings along when asked', async () => {
    const { session, model, id } = await outlineDocument(SPEC);
    const units = outlineUnits(model.paragraphs);
    expect(promotedLevel(BODY_LEVEL, 3, units)).toBe(2);
    expect(demotedLevel(9)).toBe(9);
    session.run(m => setOutlineLevels(m, [id('Intro')], demotedLevel, { withSubtree: true }));
    expect(levels(model).slice(0, 3)).toEqual([2, BODY_LEVEL, 3]);
    expect(model.paragraphs[0].styleId).toBe('Heading2');
    expect(model.paragraphs[2].styleId).toBe('Heading3');
    session.run(m => setOutlineLevels(m, [id('Intro body')], promotedLevel));
    expect(outlineLevelOf(model.paragraphs[1])).toBe(2);
    session.run(m => setOutlineLevels(m, [id('Intro body')], () => BODY_LEVEL));
    expect(model.paragraphs[1].styleId).toBe('Normal');
    session.run(m => setOutlineLevels(m, [id('Detail')], () => 1));
    expect(model.paragraphs[2].styleId).toBe('Heading1');
    expect(session.history).toHaveLength(4);
  });
  it('sets a direct outline level where the document has no heading style for it, and saves it', async () => {
    const { session, model, pkg, id } = await outlineDocument(SPEC);
    session.run(m => setOutlineLevels(m, [id('Intro body')], () => 8));
    expect(outlineLevelOf(model.paragraphs[1])).toBe(8);
    expect(model.paragraphs[1].styleId || '').not.toMatch(/Heading/);
    const xml = strFromU8(unzipSync(await bytes(pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets)))['word/document.xml']);
    expect(xml).toContain('<w:outlineLvl w:val="7"/>');
    // Body text again clears it.
    session.run(m => setOutlineLevels(m, [id('Intro body')], () => BODY_LEVEL));
    expect(outlineLevelOf(model.paragraphs[1])).toBe(BODY_LEVEL);
  });
  it('drops a direct level when a heading style takes over, so the saved level is the style\'s', async () => {
    const { session, model, pkg, id } = await outlineDocument(SPEC);
    session.run(m => setOutlineLevels(m, [id('Intro body')], () => 8));
    session.run(m => setOutlineLevels(m, [id('Intro body')], () => 2));
    expect(model.paragraphs[1].styleId).toBe('Heading2');
    expect(model.paragraphs[1].formatOverrides?.outlineLevel).toBeUndefined();
    const xml = strFromU8(unzipSync(await bytes(pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets)))['word/document.xml']);
    const saved = xml.match(/<w:p>(?:(?!<\/w:p>).)*?>Intro body<\/w:t>/)[0];
    expect(saved).toContain('<w:pStyle w:val="Heading2"/>');
    expect(saved).not.toContain('<w:outlineLvl');
    const reopened = await DocxPackage.open(await bytes(pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets)));
    expect(outlineLevelOf(new TextDocument(reopened.paragraphs, reopened.pageSettings, reopened.numbering, reopened.styles).paragraphs[1])).toBe(2);
  });
});

describe('Navigation pane section commands', () => {
  it('deletes a section and adds headings before and after', async () => {
    const { session, model, id } = await outlineDocument(SPEC);
    session.run(m => insertOutlineHeading(m, id('Intro'), 'after'));
    expect(texts(model)).toEqual(['Intro', 'Intro body', 'Detail', 'Detail body', '', 'Results', 'Results body', '']);
    expect(model.paragraphs[4].styleId).toBe('Heading1');
    expect(model.selection.focus).toBe(model.paragraphOffset(4));
    session.run(m => insertOutlineHeading(m, id('Detail'), 'before', 3));
    expect(model.paragraphs[2].styleId).toBe('Heading3');
    session.run(m => deleteOutlineSection(m, id('Intro')));
    expect(texts(model)).toEqual(['', 'Results', 'Results body', '']);
    session.undo(); session.undo(); session.undo();
    expect(texts(model)).toEqual(SPEC.map(([text]) => text));
  });
});
