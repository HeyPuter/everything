import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { importXfdf, listAnnotations } from '../src/core/annotations.js';

/** An FDF file as Acrobat writes one: each comment the PDF dictionary it is, with its Page. */
const fdf = (objects) => {
  const body = objects.map((object, i) => `${i + 2} 0 obj\n${object}\nendobj\n`).join('');
  const refs = objects
    .map((object, i) => (/\/Subtype\s*\/Popup/.test(object) ? null : `${i + 2} 0 R`))
    .filter(Boolean);
  return new TextEncoder().encode(
    `%FDF-1.2\n%âã\n1 0 obj\n<</FDF<</Annots[${refs.join(' ')}]/F(review.pdf)>>/Type/Catalog>>\nendobj\n${body}trailer\n<</Root 1 0 R>>\n%%EOF\n`,
  );
};

describe('importing comments from an FDF file', () => {
  // Acrobat exports comments as FDF as well as XFDF. An FDF file could not be imported at all:
  // it was read as XML and turned down as unreadable.
  it('adds the notes, markups, shapes, replies and statuses an FDF file holds', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    doc.addPage([612, 792]);
    const bytes = fdf([
      '<</Type/Annot/Subtype/Text/Page 0/Rect[100 600 120 620]/Contents(Check the totals)/T(Ada)/NM(note-1)/C[1 1 0]/F 4/Name/Comment/Popup 3 0 R/M(D:20240102030405Z)>>',
      '<</Type/Annot/Subtype/Popup/Page 0/Parent 2 0 R/Rect[120 500 300 620]/Open false/F 28>>',
      '<</Type/Annot/Subtype/Text/Page 0/Rect[100 600 120 620]/Contents(Done)/T(Grace)/NM(reply-1)/IRT 2 0 R/RT/R/F 28/M(D:20240103030405Z)>>',
      '<</Type/Annot/Subtype/Text/Page 0/Rect[100 600 120 620]/Contents(Accepted set by Grace)/T(Grace)/NM(state-1)/IRT 2 0 R/State(Accepted)/StateModel(Review)/F 28/M(D:20240104030405Z)>>',
      '<</Type/Annot/Subtype/Highlight/Page 1/Rect[40 690 240 712]/QuadPoints[40 712 240 712 40 690 240 690]/C[1 0.8 0]/NM(hl-1)/Contents(Key point)/F 4>>',
      '<</Type/Annot/Subtype/Square/Page 1/Rect[100 300 220 360]/C[1 0 0]/BS<</W 2/S/S>>/NM(box-1)/F 4>>',
      // A comment for a page this PDF does not have is counted as left out.
      '<</Type/Annot/Subtype/Square/Page 7/Rect[100 300 220 360]/C[1 0 0]/NM(box-2)/F 4>>',
    ]);
    const result = await importXfdf(doc, bytes);
    expect(result).toMatchObject({ comments: 3, replies: 1, statuses: 1, skipped: 1 });
    const saved = await PDFDocument.load(await doc.save());
    const [note] = listAnnotations(saved, 0);
    expect(note).toMatchObject({ kind: 'Note', contents: 'Check the totals', author: 'Ada' });
    expect(note.state).toBe('Accepted');
    expect(note.replies.map((reply) => [reply.author, reply.contents])).toEqual([
      ['Grace', 'Done'],
    ]);
    expect(listAnnotations(saved, 1).map((entry) => [entry.kind, entry.contents])).toEqual([
      ['Highlight', 'Key point'],
      ['Rectangle', ''],
    ]);
    // Importing the same file again adds nothing.
    expect((await importXfdf(doc, bytes)).imported).toBe(0);
  });

  it('turns down a damaged FDF file in words', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    await expect(
      importXfdf(doc, new TextEncoder().encode('%FDF-1.2\nnothing here')),
    ).rejects.toThrow('This comments file could not be read.');
  });
});
