// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { viewGeometry } from '../src/engine/document-views.js';
import { formattingMarks, breakMarks, sectionBreakLabels } from '../src/engine/formatting-marks.js';

// Draft view labels page, column and section breaks. It worked them out with every formatting mark
// (a mark per space, caret stops by offset for every line, a role for every paragraph of the
// document) and kept only the breaks, for each strip painted: 15 ms of every keystroke in a long
// document. breakMarks works out the breaks alone, exactly as formattingMarks gives them.
const measure = (text, style) => ({ width: [...text].length * (style.fontSize ?? 12) * 0.5, ascent: style.fontSize ?? 12, descent: (style.fontSize ?? 12) / 3 });
const views = [null, { kind: 'draft', width: 520 }, { kind: 'web', width: 700 }];

function expectSameBreaks(paragraphs, pageSettings, numbering, tables, pageStories) {
  const text = paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\n');
  let found = 0;
  for (const view of views) {
    const layout = layoutDocument(paragraphs, measure, pageGeometry(pageSettings), numbering, tables, pageStories, view ? { viewGeometry: viewGeometry(view) } : {});
    const sections = sectionBreakLabels(paragraphs, pageSettings);
    for (let index = 0; index < layout.pageCount; index++) {
      const lines = layout.lines.filter(line => line.page === index && !line.pageStory), page = layout.pages[index] || layout.page;
      const expected = formattingMarks(lines, text, paragraphs, pageSettings, page).filter(mark => mark.kind === 'break' || mark.kind === 'section');
      expect(breakMarks(lines, page, sections)).toEqual(expected);
      found += expected.length;
    }
  }
  return found;
}

it('gives the break and section marks of formattingMarks, in its order, for every page', () => {
  const doc = new TextDocument([paragraph('Before the break'), paragraph('After'), paragraph('Two columns'), paragraph('Last')]);
  doc.select(6); doc.replace('\f');
  doc.select(doc.text.indexOf('After') + 3); doc.replace('\v');
  doc.select(doc.text.indexOf('Two')); doc.insertTable(2, 2);
  // Each break is labelled by how the section after it starts; one section leaves its type out (a new page).
  for (const [i, type] of [[0, 'continuous'], [1, 'evenPage'], [2, undefined], [3, 'oddPage']]) {
    const p = doc.paragraphs.filter(q => !q.cellId)[i];
    p.sectionEnd = { ...doc.pageSettings, sectionType: type };
    if (!type) delete p.sectionEnd.sectionType;
  }
  doc.pageSettings = { ...doc.pageSettings, sectionType: 'continuous' };
  expect(expectSameBreaks(doc.paragraphs, doc.pageSettings, doc.numbering, doc.tables)).toBeGreaterThan(9);
});

it('gives the same break and section marks as formattingMarks for documents with breaks', async () => {
  let found = 0;
  for (const name of ['public/fixtures/leading-break-spacing-legacy11.docx', 'public/fixtures/bottom-line-boundary.docx', 'public/fixtures/empty-section-boundary.docx',
    'public/fixtures/anchor-position.docx', 'public/fixtures/break-metrics-split.docx', 'public/fixtures/general-page-fields.docx',
    'tests/fixtures/cell-breaks/column.docx', 'tests/fixtures/column-break-boundaries/full.docx']) {
    const pkg = await DocxPackage.open(new Uint8Array(readFileSync(name)));
    found += expectSameBreaks(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.tables, pkg.pageStories);
  }
  expect(found).toBeGreaterThan(50);
});
