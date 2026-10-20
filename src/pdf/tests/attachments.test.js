import { expect, it } from 'vitest';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  addAttachment,
  attachmentBytes,
  listAttachments,
  removeAttachment,
} from '../src/core/attachments.js';

const bytesOf = (text) => new TextEncoder().encode(text);

async function reopen(doc) {
  return PDFDocument.load(await doc.save());
}

it('attaches files, numbers repeated names, and removes one by its key', async () => {
  let doc = await PDFDocument.create();
  doc.addPage();
  await addAttachment(doc, { name: 'notes.txt', bytes: bytesOf('first'), mimeType: 'text/plain' });
  doc = await reopen(doc);
  await addAttachment(doc, { name: 'notes.txt', bytes: bytesOf('second') });
  doc = await reopen(doc);
  expect(listAttachments(doc).map((entry) => entry.key)).toEqual(['notes.txt', 'notes (2).txt']);
  expect(removeAttachment(doc, 'notes.txt')).toBe(true);
  expect(removeAttachment(doc, 'missing.txt')).toBe(false);
  const bytes = await doc.save();
  const reopened = await PDFDocument.load(bytes);
  expect(listAttachments(reopened).map((entry) => entry.key)).toEqual(['notes (2).txt']);
  expect(new TextDecoder().decode(attachmentBytes(reopened, 'notes (2).txt'))).toBe('second');
  // Other readers see the same single attachment.
  const task = pdfjs.getDocument({ data: bytes.slice() });
  const pdf = await task.promise;
  expect([...(await pdf.getAttachments()).keys()]).toEqual(['notes (2).txt']);
  await task.destroy();
});

it('refuses files over the attachment limit', async () => {
  const doc = await PDFDocument.create();
  await expect(
    addAttachment(doc, { name: 'big.bin', bytes: new Uint8Array(20 * 1024 * 1024 + 1) }),
  ).rejects.toThrow(/20 MB/);
});

it('files a new attachment where readers look when the list branches into kids', async () => {
  let doc = await PDFDocument.create();
  doc.addPage();
  await addAttachment(doc, { name: 'b.txt', bytes: bytesOf('b') });
  doc = await reopen(doc);
  // Longer attachment lists are written as a root whose Kids hold the entries.
  const tree = doc.catalog.lookup(PDFName.of('Names')).lookup(PDFName.of('EmbeddedFiles'));
  const key = PDFHexString.fromText('b.txt');
  const leaf = doc.context.obj({ Names: tree.get(PDFName.of('Names')), Limits: [key, key] });
  tree.delete(PDFName.of('Names'));
  tree.set(PDFName.of('Kids'), doc.context.obj([doc.context.register(leaf)]));
  doc = await reopen(doc);
  await addAttachment(doc, { name: 'a.txt', bytes: bytesOf('a') });
  const bytes = await doc.save();
  const reopened = await PDFDocument.load(bytes);
  expect(new TextDecoder().decode(attachmentBytes(reopened, 'a.txt'))).toBe('a');
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    const found = await (await task.promise).getAttachments();
    expect([...found.keys()]).toEqual(['a.txt', 'b.txt']);
    expect(found.get('a.txt').filename).toBe('a.txt');
  } finally {
    await task.destroy();
  }
});
