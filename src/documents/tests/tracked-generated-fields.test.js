import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';
import { insertTableOfContents, tableOfContents } from '../src/engine/toc.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const open = async (pkg, d) => {
  const bytes = new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets, undefined, d.comments, d.trackChanges).arrayBuffer());
  const again = await DocxPackage.open(bytes);
  const model = new TextDocument(again.paragraphs, again.pageSettings, again.numbering, again.styles, again.tables, again.assets, { trackChanges: again.trackRevisions });
  model.revisionAuthor = d.revisionAuthor;
  return { pkg: again, d: model };
};
/** As the References commands that insert run: untracked, then the text they added recorded as one insertion when tracking is on. */
const tracked = (d, action) => {
  const before = d.text, fields = new Set(d.paragraphs.flatMap(p => (p.fieldMarkers || []).map(m => m.field.id)));
  d.trackChanges = false;
  try { action(); } finally { d.trackChanges = true; }
  d.trackInsertion(before, fields);
};
/** As Update Table runs: untracked. */
const untracked = (d, action) => { d.trackChanges = false; try { action(); } finally { d.trackChanges = true; } };
const changes = d => d.revisions.map(r => [r.type, d.text.slice(r.start, r.end)]);

// A table of contents inserted with Track Changes on, then updated (Update Table, entire table) before the insertion
// was accepted, was rebuilt untracked: Reject All left its entries in the document, run into the heading after it.
it('a table of contents still pending as an insertion stays one when it is rebuilt', async () => {
  const blank = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  let pkg = await DocxPackage.open(new Uint8Array(await blank.export().arrayBuffer()));
  let d = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  d.revisionAuthor = 'Ada';
  d.replace('Introduction\nEngines compute.\nHistory\nThe engine came first.');
  for (const [text, name] of [['Introduction', 'Heading 1'], ['History', 'Heading 2']]) { d.select(d.text.indexOf(text)); d.setParagraphStyle(d.paragraphStyles.find(s => s.name === name).id); }
  const original = d.text;
  d.trackChanges = true;
  d.select(0);
  tracked(d, () => insertTableOfContents(d, { title: 'Contents' }));
  const table = 'Contents\nIntroduction\t1\nHistory\t1\n';
  expect(changes(d)).toEqual([['ins', table]]);
  // The heading is edited (tracked), and the table rebuilt after a save and reopen.
  ({ pkg, d } = await open(pkg, d));
  expect(changes(d)).toEqual([['ins', table]]);
  d.select(d.text.lastIndexOf('History') + 7); d.replace(' and Future');
  untracked(d, () => insertTableOfContents(d, { existing: tableOfContents(d.paragraphs) }));
  expect(d.text).toBe(`Contents\nIntroduction\t1\nHistory and Future\t1\n${original.replace('History', 'History and Future')}`);
  expect(changes(d)).toEqual([['ins', 'Contents\nIntroduction\t1\nHistory and Future\t1\n'], ['ins', ' and Future']]);
  expect(bodyFieldRanges(d.paragraphs).map(f => [f.field.type, f.field.revision?.type])).toEqual([['TOC', 'ins'], ['PAGEREF', 'ins'], ['PAGEREF', 'ins']]);
  ({ pkg, d } = await open(pkg, d));
  expect(changes(d)).toEqual([['ins', 'Contents\nIntroduction\t1\nHistory and Future\t1\n'], ['ins', ' and Future']]);
  const rejected = await open(pkg, d);
  rejected.d.resolveRevisions(false);
  expect(rejected.d.text).toBe(original);
  expect(bodyFieldRanges(rejected.d.paragraphs)).toEqual([]);
  d.resolveRevisions(true);
  expect(d.text).toBe(`Contents\nIntroduction\t1\nHistory and Future\t1\n${original.replace('History', 'History and Future')}`);
  expect(changes(d)).toEqual([]);
  expect(bodyFieldRanges(d.paragraphs).map(f => [f.field.type, f.field.revision?.type ?? null])).toEqual([['TOC', null], ['PAGEREF', null], ['PAGEREF', null]]);
});

it('a table of contents that is not a pending insertion is rebuilt untracked, as before', async () => {
  const blank = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const pkg = await DocxPackage.open(new Uint8Array(await blank.export().arrayBuffer()));
  const d = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  d.revisionAuthor = 'Ada';
  d.replace('Introduction\nBody');
  d.select(0); d.setParagraphStyle(d.paragraphStyles.find(s => s.name === 'Heading 1').id);
  d.select(0); insertTableOfContents(d, { title: 'Contents' });
  d.trackChanges = true;
  d.select(d.text.lastIndexOf('Introduction') + 12); d.replace(' now');
  untracked(d, () => insertTableOfContents(d, { existing: tableOfContents(d.paragraphs) }));
  expect(changes(d)).toEqual([['ins', ' now']]);
  expect(d.text).toBe('Contents\nIntroduction now\t1\nIntroduction now\nBody');
});
