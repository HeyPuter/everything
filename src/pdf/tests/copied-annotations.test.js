import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { insertPdfPages } from '../src/core/document.js';
import { extractPages } from '../src/core/pages.js';
import { addNote, editNote, listNotes } from '../src/core/notes.js';
import { listAnnotations } from '../src/core/annotations.js';

const n = PDFName.of;

async function sourcePdf(indirect) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  addNote(doc, 0, { x: 30, y: 150, text: 'Original note' });
  const annots = page.node.Annots();
  const original = annots.get(0);
  // Replies and popups must follow the note belonging to their own copy of the page.
  annots.push(
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [30, 130, 50, 150],
        IRT: original,
        RT: 'R',
        Contents: PDFString.of('Reply'),
        P: page.ref,
      }),
    ),
  );
  if (indirect) page.node.set(n('Annots'), doc.context.register(annots));
  // A large shared page resource must not be duplicated to isolate small annotations.
  const image = doc.context.register(
    doc.context.stream(new Uint8Array(65536), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 256,
      Height: 256,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
    }),
  );
  page.node.set(n('Resources'), doc.context.obj({ XObject: { Image: image } }));
  return doc.save();
}

async function copyPages(bytes, method) {
  if (method === 'extract') return PDFDocument.load(await extractPages(bytes, [0, 0, 0]));
  const out = await PDFDocument.create();
  out.addPage([100, 100]);
  await insertPdfPages(out, bytes, { pages: [0, 0, 0], after: -1 });
  return out;
}

describe('annotations on repeated page selections', () => {
  for (const method of ['extract', 'insert']) {
    it.each([false, true])(
      `${method} keeps notes, replies and popups independent with indirect Annots=%s`,
      async (indirect) => {
        const out = await copyPages(await sourcePdf(indirect), method);
        editNote(out, 0, listNotes(out, 0)[0].id, { text: 'Only the first copy', x: 70 });
        const saved = await out.save();
        const reopened = await PDFDocument.load(saved);
        expect([0, 1, 2].map((i) => listNotes(reopened, i)[0].text)).toEqual([
          'Only the first copy',
          'Original note',
          'Original note',
        ]);
        const noteRefs = [];
        const imageRefs = [];
        for (let i = 0; i < 3; i++) {
          const page = reopened.getPage(i);
          const annots = page.node.Annots();
          const noteRef = annots.get(0);
          noteRefs.push(noteRef);
          const note = reopened.context.lookup(noteRef);
          const popup = note.lookup(n('Popup'));
          expect(popup.get(n('Parent'))).toBe(noteRef);
          expect(popup.lookup(n('Rect')).lookup(0).asNumber()).toBe(i === 0 ? 94 : 54);
          const reply = reopened.context.lookup(annots.get(2));
          expect(reply.get(n('IRT'))).toBe(noteRef);
          for (const ref of annots.asArray()) {
            const annot = reopened.context.lookup(ref);
            if (annot.has(n('P'))) expect(annot.get(n('P'))).toBe(page.ref);
          }
          imageRefs.push(page.node.Resources().lookup(n('XObject')).get(n('Image')));
        }
        expect(new Set(noteRefs).size).toBe(3);
        expect(new Set(imageRefs).size).toBe(1);
        const task = pdfjs.getDocument({ data: saved.slice() });
        try {
          const pdf = await task.promise;
          for (let i = 0; i < 3; i++) {
            const annotations = await (await pdf.getPage(i + 1)).getAnnotations();
            const note = annotations.find((a) => a.subtype === 'Text' && !a.inReplyTo);
            expect(note.contentsObj.str).toBe(i === 0 ? 'Only the first copy' : 'Original note');
          }
        } finally {
          await task.destroy();
        }
      },
    );
  }

  it.each([false, true])(
    'adding or removing annotations before the inserted pages are saved affects only that page (indirect=%s)',
    async (indirect) => {
      const out = await copyPages(await sourcePdf(indirect), 'insert');
      addNote(out, 0, { x: 20, y: 60, text: 'New note on the first copy' });
      editNote(out, 1, listNotes(out, 1)[0].id, { remove: true });
      const reopened = await PDFDocument.load(await out.save());
      expect(
        [0, 1, 2].map((i) =>
          listAnnotations(reopened, i).map((note) => [
            note.contents,
            note.replies.map((reply) => reply.contents),
          ]),
        ),
      ).toEqual([
        [
          ['Original note', ['Reply']],
          ['New note on the first copy', []],
        ],
        // Removing a note takes its reply with it, on that copy only.
        [],
        [['Original note', ['Reply']]],
      ]);
    },
  );
});
