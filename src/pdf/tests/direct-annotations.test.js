import { expect, it } from 'vitest';
import { PDFDocument, PDFDict, PDFName, PDFRef } from 'pdf-lib';
import {
  addReply,
  addShapeAnnotation,
  deleteAnnotation,
  editAnnotation,
  exportXfdf,
  importXfdf,
  listAnnotations,
} from '../src/core/annotations.js';
import { addNote, editNote, listNotes } from '../src/core/notes.js';
import { addHighlight, editHighlight, listHighlights, rectQuad } from '../src/core/highlight.js';
import { removeAnnotationThread } from '../src/core/structure.js';

// Some writers put annotation dictionaries in a page's Annots array itself instead of
// referring to objects of their own.
async function directPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  addNote(doc, 0, { x: 100, y: 300, text: 'Note' });
  addHighlight(doc, 0, {
    text: 'Mark',
    quads: [rectQuad({ x: 100, y: 150, width: 120, height: 24 })],
  });
  addShapeAnnotation(doc, 0, {
    kind: 'square',
    rect: { x: 220, y: 40, width: 80, height: 60 },
    text: 'Box',
  });
  const direct = page.node
    .Annots()
    .asArray()
    .map((ref) => doc.context.lookup(ref))
    .filter((dict) => dict.lookup(PDFName.of('Subtype')) !== PDFName.of('Popup'));
  for (const dict of direct) dict.delete(PDFName.of('Popup'));
  page.node.set(PDFName.of('Annots'), doc.context.obj(direct));
  return PDFDocument.load(await doc.save());
}
const box = (doc) => listAnnotations(doc, 0).find((entry) => entry.subtype === 'Square');

it('lists comments written directly into Annots, with IDs that last through edits', async () => {
  const doc = await directPdf();
  expect(listAnnotations(doc, 0).map((entry) => entry.subtype)).toEqual([
    'Text',
    'Highlight',
    'Square',
  ]);
  const { id } = box(doc);
  expect(id).toBe('direct:2');
  expect(listNotes(doc, 0)[0].id).toBe('direct:0');
  expect(listHighlights(doc, 0)[0].id).toBe('direct:1');
  expect(await editAnnotation(doc, 0, id, { color: '#1144cc', width: 3 })).toBe(id);
  expect(box(doc)).toMatchObject({ id, color: '#1144cc', width: 3 });
  editNote(doc, 0, 'direct:0', { text: 'Changed' });
  expect(editHighlight(doc, 0, 'direct:1', { hex: '#22aa44' })).toBe('direct:1');
  const saved = await PDFDocument.load(await doc.save());
  expect(listNotes(saved, 0)[0]).toMatchObject({ id: 'direct:0', text: 'Changed' });
  expect(listHighlights(saved, 0)[0]).toMatchObject({ id: 'direct:1', hex: '#22aa44' });
});

it('makes a direct comment an object of its own for a reply to point at', async () => {
  const doc = await directPdf();
  addReply(doc, 0, 'direct:2', { text: 'Reply' });
  const annots = doc.getPage(0).node.Annots();
  expect(annots.get(2)).toBeInstanceOf(PDFRef);
  const entry = box(doc);
  expect(entry.id).toBe(annots.get(2).toString());
  expect(entry.replies.map((reply) => reply.contents)).toEqual(['Reply']);
  deleteAnnotation(doc, 0, entry.id);
  expect(box(doc)).toBeUndefined();
  // The reply went with it.
  expect(annots.size()).toBe(2);
});

it('deletes direct comments by ID, and by the dictionary as redaction names them', async () => {
  const doc = await directPdf();
  deleteAnnotation(doc, 0, 'direct:2');
  expect(box(doc)).toBeUndefined();
  const page = doc.getPage(0);
  const highlight = page.node.Annots().get(1);
  expect(highlight).toBeInstanceOf(PDFDict);
  removeAnnotationThread(page, highlight.toString());
  expect(listHighlights(doc, 0)).toEqual([]);
  editNote(doc, 0, 'direct:0', { remove: true });
  expect(page.node.Annots().size()).toBe(0);
});

it('takes a direct comment as already there when its comments file is imported again', async () => {
  const doc = await directPdf();
  const xfdf = exportXfdf(doc);
  const nm = /<square [^>]*name="([^"]+)"/.exec(xfdf)[1];
  // A reply to it from another reviewer's file finds it.
  const reply = `<text page="0" rect="0,0,20,20" name="reply-1" inreplyto="${nm}"><contents>Agreed</contents></text>`;
  const result = await importXfdf(doc, xfdf.replace('</annots>', `${reply}</annots>`));
  expect(result).toMatchObject({ imported: 1, replies: 1, duplicates: 3 });
  const entry = box(doc);
  expect(entry.replies.map((item) => item.contents)).toEqual(['Agreed']);
  expect(listAnnotations(doc, 0)).toHaveLength(3);
});
