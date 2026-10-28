import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';
import { insertCaption, referenceTargets, insertCrossReference, captionLabels } from '../src/engine/captions.js';
import { updateSequenceFields } from '../src/engine/field-update.js';
import { footnoteOpeningRuns } from '../src/engine/footnotes.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const setup = async () => {
  const blank = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const pkg = await DocxPackage.open(new Uint8Array(await blank.export().arrayBuffer()));
  const d = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  d.replace('Chart one\nChart two\nConclusion');
  return { pkg, d };
};
const save = async (pkg, d) => new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());

describe('captions and cross-references', () => {
  it('numbers captions in document order and renumbers after inserting one earlier', async () => {
    const { pkg, d } = await setup();
    d.select(d.text.indexOf('Chart two')); insertCaption(d, { label: 'Figure', text: 'Second chart' });
    expect(d.text).toBe('Chart one\nChart two\nFigure 1: Second chart\nConclusion');
    d.select(2); insertCaption(d, { label: 'Figure', text: 'First chart' });
    expect(d.text).toBe('Chart one\nFigure 1: First chart\nChart two\nFigure 2: Second chart\nConclusion');
    expect(d.paragraphs[1].runs[0]).toMatchObject({ italic: true, fontSize: 9 });
    const xml = strFromU8(unzipSync(await save(pkg, d))['word/document.xml']);
    expect(xml.match(/SEQ Figure \\\* ARABIC/g)).toHaveLength(2);
    const reopened = new TextDocument((await DocxPackage.open(await save(pkg, d))).paragraphs);
    expect(reopened.text).toBe(d.text);
  });

  it('numbers captions with a label in any script, as localized word processors write them (SEQ Рисунок)', async () => {
    const { pkg, d } = await setup();
    d.select(d.text.indexOf('Chart two')); insertCaption(d, { label: 'Рисунок', text: 'Схема' });
    d.select(2); insertCaption(d, { label: 'Рисунок', text: 'Обзор' });
    d.select(d.text.length); insertCaption(d, { label: '图表', text: 'Data' });
    expect(d.text).toBe('Chart one\nРисунок 1: Обзор\nChart two\nРисунок 2: Схема\nConclusion\n图表 1: Data');
    expect(bodyFieldRanges(d.paragraphs).map(r => r.field.instruction)).toEqual([' SEQ Рисунок \\* ARABIC ', ' SEQ Рисунок \\* ARABIC ', ' SEQ 图表 \\* ARABIC ']);
    const reopened = new TextDocument((await DocxPackage.open(await save(pkg, d))).paragraphs);
    expect(captionLabels(reopened)).toEqual(expect.arrayContaining(['Рисунок', '图表']));
    expect(() => insertCaption(d, { label: '1st' })).toThrow();
    expect(() => insertCaption(d, { label: 'Figure-A' })).toThrow();
  });

  it('puts a cross-reference inserted inside another one after it', async () => {
    const { d } = await setup();
    d.select(0, 5); d.addBookmark('First'); d.select(10, 15); d.addBookmark('Second');
    const [first, second] = referenceTargets(d).bookmarks;
    d.select(d.text.length); d.replace(' see '); insertCrossReference(d, first);
    const ref = bodyFieldRanges(d.paragraphs)[0];
    d.select(ref.start + 2); insertCrossReference(d, second);
    expect(d.text.split('\n').at(-1)).toBe('Conclusion see ChartChart');
    expect(bodyFieldRanges(d.paragraphs).map(r => [d.text.slice(r.start, r.end), r.parentId ?? null])).toEqual([['Chart', null], ['Chart', null]]);
  });

  it('inserts a cross-reference to a caption that follows renumbering', async () => {
    const { pkg, d } = await setup();
    d.select(d.text.indexOf('Chart two')); insertCaption(d, { label: 'Figure', text: 'Second chart' });
    const target = referenceTargets(d).captions[0];
    expect(target.numberLabel).toBe('Figure 1');
    d.select(d.text.length); d.replace(' See '); insertCrossReference(d, target);
    expect(d.text.endsWith('See Figure 1')).toBe(true);
    d.select(2); insertCaption(d, { label: 'Figure', text: 'First chart' });
    updateSequenceFields(d);
    expect(d.text.endsWith('See Figure 2')).toBe(true);
    expect(bodyFieldRanges(d.paragraphs).map(r => r.field.type)).toEqual(['SEQ', 'SEQ', 'REF']);
    const xml = strFromU8(unzipSync(await save(pkg, d))['word/document.xml']);
    expect(xml).toMatch(/<w:bookmarkStart w:id="\d+" w:name="_Ref\d+"\/>/);
    expect(xml).toMatch(/<w:hyperlink w:anchor="_Ref\d+"[^>]*>.*REF _Ref\d+ \\h .*<\/w:hyperlink>/);
  });

  it('leaves a note mark in the target out of a cross-reference\'s text', async () => {
    const { pkg, d } = await setup();
    d.select(d.text.indexOf('Chart two')); insertCaption(d, { label: 'Figure', text: 'Second chart' });
    const { id, path } = pkg.addFootnote();
    d.select(d.text.indexOf('Second chart') + 6); d.insertFootnoteReference(id);
    const note = new TextDocument([paragraph()], d.pageSettings, d.numbering, d.styles, [], d.assets);
    note.paragraphs[0].runs = footnoteOpeningRuns(note.typingRun(0));
    const target = referenceTargets(d).captions[0];
    expect(target.label).toBe('Figure 1: Second chart');
    expect(target.captionText).toBe('Second chart');
    for (const show of ['entire', 'caption', 'label']) { d.select(d.text.length); d.replace(` ${show}: `); insertCrossReference(d, target, { show }); }
    expect(d.text.split('\n').at(-1)).toBe('Conclusion entire: Figure 1: Second chart caption: Second chart label: Figure 1');
    // Updating fields keeps the results as inserted, and refreshes them, without reporting them as unrefreshable.
    const issues = [];
    expect(updateSequenceFields(d, { onIssue: issue => issues.push(issue.message) })).toBe(0);
    expect(issues).toEqual([]);
    d.select(d.text.indexOf('Second\uFFFC') + 7); d.replace(' bar');
    updateSequenceFields(d, { onIssue: issue => issues.push(issue.message) });
    expect(issues).toEqual([]);
    expect(d.text.split('\n').at(-1)).toBe('Conclusion entire: Figure 1: Second bar chart caption: Second bar chart label: Figure 1');
    const at = d.text.indexOf('Second\uFFFC') + 7; d.select(at, at + 4); d.replace('');
    updateSequenceFields(d);
    const bytes = new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets, { [path]: { paragraphs: note.paragraphs, tables: [] } }).arrayBuffer());
    expect(strFromU8(unzipSync(bytes)['word/document.xml'])).not.toContain('\uFFFC');
    const reopened = new TextDocument((await DocxPackage.open(bytes)).paragraphs);
    expect(reopened.text.split('\n').at(-1)).toBe('Conclusion entire: Figure 1: Second chart caption: Second chart label: Figure 1');
  });

  it('records a caption, cross-reference or table of contents inserted with Track Changes on as a tracked insertion', async () => {
    const { insertTableOfContents } = await import('../src/engine/toc.js');
    const { protectionGuard } = await import('../src/engine/protection.js');
    const { StorySession } = await import('../src/engine/story-session.js');
    const inserts = [
      ['caption below', d => { d.select(d.text.indexOf('Chart two')); insertCaption(d, { label: 'Figure', text: 'Second chart' }); }, 'Chart one\nChart two\nFigure 1: Second chart\nConclusion'],
      ['caption above', d => { d.select(2); insertCaption(d, { label: 'Figure', text: 'First', above: true }); }, 'Figure 1: First\nChart one\nChart two\nConclusion'],
      ['caption at the end', d => { d.select(d.text.length); insertCaption(d, { label: 'Table', text: 'Last' }); }, 'Chart one\nChart two\nConclusion\nTable 1: Last'],
      ['cross-reference', d => { d.select(0, 5); d.addBookmark('First'); d.select(d.text.length); insertCrossReference(d, referenceTargets(d).bookmarks[0]); }, 'Chart one\nChart two\nConclusionChart'],
      ['table of contents', d => { d.select(0); d.setParagraphStyle(Object.values(d.styles.definitions).find(s => s.name?.toLowerCase() === 'heading 1').id); d.select(0); insertTableOfContents(d, {}); }, null],
    ];
    for (const [name, insert, expected] of inserts) {
      const { pkg, d } = await setup();
      const original = d.text, shape = m => m.paragraphs.map(p => [m.text && p.runs.map(r => r.text).join(''), p.styleId || null]);
      const originalShape = JSON.stringify(shape(d));
      d.trackChanges = true; d.revisionAuthor = 'Me';
      const session = new StorySession(d);
      // Locked tracking (trackedChanges protection) lets the insertion through once it is tracked.
      session.guard = protectionGuard({ enforcement: true, edit: 'trackedChanges' });
      // As References commands run: untracked, then what was inserted is recorded as inserted.
      d.trackChanges = false;
      try { session.run(m => { const before = m.text; insert(m); expect(m.trackInsertion(before), name).toBe(true); }); } finally { d.trackChanges = true; }
      if (expected) expect(d.text, name).toBe(expected);
      expect(d.revisions.map(r => r.type), name).toEqual(['ins']);
      const bytes = await save(pkg, d);
      const reopened = new TextDocument((await DocxPackage.open(bytes)).paragraphs);
      expect(reopened.revisions.map(r => [r.type, r.author]), name).toEqual([['ins', 'Me']]);
      reopened.resolveRevisions(false);
      expect(reopened.text, name).toBe(original);
      d.resolveRevisions(false);
      expect(d.text, name).toBe(original);
      if (name !== 'table of contents') expect(JSON.stringify(shape(d)), name).toBe(originalShape);
    }
  });
  it('leaves a command that changed more than one stretch untracked', async () => {
    const { d } = await setup();
    d.select(d.text.indexOf('Chart two')); insertCaption(d, { label: 'Figure', text: 'Two' });
    const before = d.text;
    d.select(2); insertCaption(d, { label: 'Figure', text: 'One' });
    // The new caption renumbered the one after it: two changes, not one insertion.
    expect(d.text).toBe('Chart one\nFigure 1: One\nChart two\nFigure 2: Two\nConclusion');
    expect(d.trackInsertion(before)).toBe(false);
    expect(d.revisions).toEqual([]);
  });

  it('places a table caption below the table', async () => {
    const { d } = await setup();
    d.select(d.text.indexOf('Conclusion')); d.insertTable(2, 2);
    insertCaption(d, { label: 'Table', text: 'Results' });
    const text = d.text;
    expect(text.indexOf('Table 1: Results')).toBeGreaterThan(-1);
    expect(d.paragraphs.find(p => p.runs.map(r => r.text).join('') === 'Table 1: Results').cellId).toBeFalsy();
  });
});
