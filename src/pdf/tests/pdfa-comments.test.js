import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PDFDict, PDFDocument, PDFName, rgb } from 'pdf-lib';
import { convertToPdfA, pdfaSaveOptions, preflightPdfA } from '../src/core/pdfa.js';
import { addNote } from '../src/core/notes.js';
import {
  addReply,
  addShapeAnnotation,
  exportXfdf,
  importXfdf,
  listAnnotations,
  setReviewState,
} from '../src/core/annotations.js';

const assets = new URL('../node_modules/pdfjs-dist/', import.meta.url);
const loadAsset = async (path) => new Uint8Array(readFileSync(new URL(path, assets)));
const name = PDFName.of;
const errors = (report) => report.issues.filter((issue) => issue.severity === 'error');

/** A page with a colored mark, saved as PDF/A-2b with its sRGB output intent. */
async function pdfa() {
  const doc = await PDFDocument.create();
  doc
    .addPage([400, 400])
    .drawRectangle({ x: 20, y: 20, width: 40, height: 20, color: rgb(0, 0, 1) });
  const report = await convertToPdfA(doc, { part: 2, conformance: 'b', loadAsset });
  expect(report.compliant).toBe(true);
  return doc.save(pdfaSaveOptions(2));
}
const reopen = async (doc) =>
  PDFDocument.load(await doc.save(pdfaSaveOptions(2)), { updateMetadata: false });
const popupsOf = (doc) =>
  doc
    .getPage(0)
    .node.lookup(name('Annots'))
    .asArray()
    .map((ref) => doc.context.lookup(ref))
    .filter((dict) => dict instanceof PDFDict && dict.get(name('Subtype')) === name('Popup'));

describe('comments in a PDF/A file', () => {
  // A note's popup was written with no flags at all; PDF/A has every annotation print, so a
  // PDF/A file failed its check as soon as a note was added.
  it('a note added to a PDF/A file keeps it PDF/A, its popup set to print', async () => {
    const bytes = await pdfa();
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    addNote(doc, 0, { x: 100, y: 300, text: 'Check this', author: 'Ada' });
    const saved = await reopen(doc);
    const [popup] = popupsOf(saved);
    expect(popup.lookup(name('F')).asNumber() & 4).toBe(4);
    expect(errors(preflightPdfA(saved, { part: 2, conformance: 'b' }))).toEqual([]);
  });

  it('a note imported from a comments file keeps a PDF/A file PDF/A', async () => {
    const source = await PDFDocument.create();
    source.addPage([400, 400]);
    addNote(source, 0, { x: 100, y: 300, text: 'Imported', author: 'Ada' });
    const doc = await PDFDocument.load(await pdfa(), { updateMetadata: false });
    expect((await importXfdf(doc, exportXfdf(source))).comments).toBe(1);
    const saved = await reopen(doc);
    expect(popupsOf(saved)).toHaveLength(1);
    expect(errors(preflightPdfA(saved, { part: 2, conformance: 'b' }))).toEqual([]);
  });

  // Replies and review statuses are hidden notes in their comment's thread. Save as PDF/A
  // removed every hidden annotation, and with them every reply and status in the PDF.
  it('Save as PDF/A keeps replies and review statuses with their comments', async () => {
    const doc = await PDFDocument.create();
    doc
      .addPage([400, 400])
      .drawRectangle({ x: 20, y: 20, width: 40, height: 20, color: rgb(0, 0, 1) });
    const box = addShapeAnnotation(doc, 0, {
      kind: 'square',
      rect: { x: 100, y: 100, width: 80, height: 40 },
      text: 'Check the totals',
    });
    const reply = addReply(doc, 0, box, { text: 'Done', author: 'Grace' });
    addReply(doc, 0, reply, { text: 'Thanks', author: 'Ada' });
    setReviewState(doc, 0, box, { state: 'Accepted', author: 'Ada' });
    // A hidden comment of its own, and a reply to it, are still removed.
    const hidden = addShapeAnnotation(doc, 0, {
      kind: 'circle',
      rect: { x: 200, y: 200, width: 40, height: 40 },
    });
    addReply(doc, 0, hidden, { text: 'On a hidden circle' });
    const annots = doc.getPage(0).node.lookup(name('Annots'));
    const circle = annots
      .asArray()
      .map((ref) => doc.context.lookup(ref))
      .find((dict) => dict.get(name('Subtype')) === name('Circle'));
    circle.set(name('F'), doc.context.obj(2));
    const report = await convertToPdfA(doc, { part: 2, conformance: 'b', loadAsset });
    expect(report.compliant).toBe(true);
    const saved = await reopen(doc);
    expect(errors(preflightPdfA(saved, { part: 2, conformance: 'b' }))).toEqual([]);
    const [kept, ...rest] = listAnnotations(saved, 0);
    expect(rest).toEqual([]);
    expect(kept.contents).toBe('Check the totals');
    expect(kept.state).toBe('Accepted');
    expect(kept.replies.map((r) => [r.contents, r.replies.map((s) => s.contents)])).toEqual([
      ['Done', ['Thanks']],
    ]);
    const all = saved
      .getPage(0)
      .node.lookup(name('Annots'))
      .asArray()
      .map((ref) => saved.context.lookup(ref));
    expect(all.some((dict) => dict.get(name('Subtype')) === name('Circle'))).toBe(false);
    // The replies and statuses still draw nothing on the page.
    for (const dict of all.filter((d) => d.has(name('IRT')))) {
      const normal = dict.lookup(name('AP')).lookup(name('N'));
      expect(normal.getContents().length).toBe(0);
    }
  });
});
