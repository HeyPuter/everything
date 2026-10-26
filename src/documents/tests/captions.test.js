import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';
import { insertCaption, referenceTargets, insertCrossReference } from '../src/engine/captions.js';
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
    const bytes = new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets, { [path]: { paragraphs: note.paragraphs, tables: [] } }).arrayBuffer());
    expect(strFromU8(unzipSync(bytes)['word/document.xml'])).not.toContain('\uFFFC');
    const reopened = new TextDocument((await DocxPackage.open(bytes)).paragraphs);
    expect(reopened.text.split('\n').at(-1)).toBe('Conclusion entire: Figure 1: Second chart caption: Second chart label: Figure 1');
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
