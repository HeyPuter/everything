import { it, expect, beforeAll, afterAll } from 'vitest';
import { JSDOM } from 'jsdom';
import { TextDocument, paragraph, paragraphFormat } from '../src/engine/model.js';
import { setCellAlignment } from '../src/engine/table-editing.js';
import { directedRuns } from '../src/engine/script-input.js';
import { copyFragment, fragmentHtml, htmlFragment } from '../src/engine/clipboard-fragment.js';
import { documentHtml } from '../src/lib/document-export.js';
import { documentHtml as mailHtml } from '../src/lib/mail-messages.js';
import { layoutDocument, hitTest, hitTestStop, selectionRects } from '../src/engine/layout.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; });

// Right-to-left paragraphs (ECMA-376 Part 1 §17.3.1.6 bidi) where other commands meet them.

// §17.3.1.13 jc is read from the paragraph's leading edge: the alignment grid names sides of the cell.
it('aligns right-to-left cell text to the side of the cell the alignment grid names', () => {
  const doc = new TextDocument([paragraph('x')]);
  doc.insertTable(1, 2, 600);
  doc.setParagraphDirection(true);
  const cell = () => paragraphFormat(doc.selectedParagraphs[0], doc.numbering);
  expect(setCellAlignment(doc, { horizontal: 'right', vertical: 'top' })).toBe(true);
  // The leading edge of a right-to-left paragraph is its right one: stored as w:jc left.
  expect(cell()).toMatchObject({ bidi: true, alignment: 'left' });
  expect(doc.paragraphFormatting.alignmentSide).toBe('right');
  setCellAlignment(doc, { horizontal: 'left' });
  expect(cell().alignment).toBe('right');
  expect(doc.paragraphFormatting.alignmentSide).toBe('left');
  setCellAlignment(doc, { horizontal: 'center' });
  expect(cell().alignment).toBe('center');
  // A left-to-right cell stores the side as it is.
  doc.setParagraphDirection(false);
  setCellAlignment(doc, { horizontal: 'right' });
  expect(cell()).toMatchObject({ bidi: false, alignment: 'right' });
});

// A click on a letter puts the caret beside that letter. Where a word changes direction, the letter's
// edge is also the edge of the run beyond it, and the click put the caret there instead: clicking the
// end of "abc" in a right-to-left paragraph and typing wrote before "abc" (Unicode UAX #9 reordering).
it('a click on a letter at a direction change puts the caret beside that letter', () => {
  const measure = text => ({ width: [...text].length * 10, ascent: 12, descent: 3 });
  const texts = ['שלום abc', 'abc שלום def', 'مرحبا 123 hello world.', 'שלום (עולם) 3.14% abc-def, שלום!'];
  for (const bidi of [true, false]) for (const text of texts) {
    const p = paragraph(text, { format: { bidi } }); p.runs = directedRuns(p.runs, 0, text.length);
    const layout = layoutDocument([p], measure, { width: 1000, height: 400, margin: 20 });
    for (let i = 0; i < text.length; i++) {
      const [box] = selectionRects(layout, i, i + 1);
      for (const share of [.25, .75]) {
        const hit = hitTest(layout, box.page, box.x + box.width * share, box.y + box.height / 2);
        expect([i, i + 1], `${bidi ? 'rtl' : 'ltr'} "${text}" letter ${i} at ${share}`).toContain(hit);
      }
    }
  }
  // Typing there continues the word clicked.
  const p = paragraph('שלום abc', { format: { bidi: true } }); p.runs = directedRuns(p.runs, 0, 8);
  const layout = layoutDocument([p], measure, { width: 1000, height: 400, margin: 20 }), [c] = selectionRects(layout, 7, 8);
  expect(hitTestStop(layout, 0, c.x + c.width * .75, c.y + 5)).toMatchObject({ offset: 8, x: c.x + c.width });
});

// HTML lists are laid out in their own direction: in a left-to-right <ol>, a right-to-left item's number stood
// past the page's right edge. The list takes its first item's direction; an item of the other direction says so.
it('writes a right-to-left list as a right-to-left HTML list, for the page and the clipboard', () => {
  const doc = new TextDocument([paragraph('אחד'), paragraph('שתיים'), paragraph('three'), paragraph('after')]);
  doc.select(0, doc.text.indexOf('after')); doc.toggleList('number');
  doc.select(0, doc.text.indexOf('three')); doc.setParagraphDirection(true);
  const page = documentHtml(doc), body = page.slice(page.indexOf('<body>') + 6, page.indexOf('</body>')).trim();
  expect(body).toBe('<ol dir="rtl"><li dir="rtl">אחד</li><li dir="rtl">שתיים</li><li dir="ltr">three</li></ol><p>after</p>');
  doc.select(0, doc.text.length);
  const html = fragmentHtml(copyFragment(doc));
  const tags = html.replace(/^<div [^>]*>/, '').replace(/<span[^>]*>|<\/span>/g, '').replace(/ style="[^"]*"/g, '');
  expect(tags).toBe('<ol dir="rtl"><li dir="rtl">אחד</li><li dir="rtl">שתיים</li><li dir="ltr">three</li></ol><p>after</p></div>');
  // A left-to-right list says nothing, as before; one nested in a right-to-left item says it is left-to-right.
  const ltr = new TextDocument([paragraph('one'), paragraph('two')]);
  ltr.select(0, ltr.text.length); ltr.toggleList('number');
  expect(documentHtml(ltr)).toContain('<ol><li>one</li><li>two</li></ol>');
  // Read back as HTML from elsewhere, each paragraph keeps its direction.
  const foreign = htmlFragment(html.replace(/^<div [^>]*>/, '<div>'), { copied: false });
  expect(foreign.paragraphs.map(p => p.bidi)).toEqual([true, true, false, undefined]);
});

// A merged message written from a right-to-left letter reads right-to-left, its sides as the page shows them.
it('writes right-to-left paragraphs of a merged message right-to-left', () => {
  const doc = new TextDocument([paragraph('שלום רב,'), paragraph('בברכה'), paragraph('Dear Dana,')]);
  doc.select(0, doc.text.indexOf('Dear')); doc.setParagraphDirection(true);
  doc.select(doc.text.indexOf('בברכה')); doc.setParagraphAlignment('left');
  const html = mailHtml(doc);
  expect(html).toContain('<p dir="rtl">שלום רב,</p>\n<p dir="rtl" style="text-align:left">בברכה</p>\n<p>Dear Dana,</p>');
});
