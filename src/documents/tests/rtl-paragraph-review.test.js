import { it, expect } from 'vitest';
import { TextDocument, paragraph, paragraphFormat } from '../src/engine/model.js';
import { setCellAlignment } from '../src/engine/table-editing.js';

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
