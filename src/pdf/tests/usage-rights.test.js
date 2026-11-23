import { expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { PdfSession, rotatePage } from '../src/core/document.js';
import { protectPdf, unlockPdf } from '../src/core/security.js';

const name = PDFName.of;

/** A Reader-enabled PDF: a usage-rights signature (/Perms /UR3) and a certification (/DocMDP). */
async function readerEnabled() {
  const doc = await PDFDocument.create();
  doc.addPage([400, 400]);
  const signature = (method) =>
    doc.context.register(
      doc.context.obj({
        Type: 'Sig',
        Filter: 'Adobe.PPKLite',
        SubFilter: 'adbe.pkcs7.detached',
        Contents: PDFHexString.of('00'.repeat(64)),
        ByteRange: [0, 0, 0, 0],
        Reference: [{ Type: 'SigRef', TransformMethod: method }],
      }),
    );
  doc.catalog.set(
    name('Perms'),
    doc.context.obj({ UR3: signature('UR3'), DocMDP: signature('DocMDP') }),
  );
  return doc.save();
}

it('an edit drops the usage-rights signature it breaks, and keeps the certification', async () => {
  const session = new PdfSession(await readerEnabled());
  await session.change((doc) => rotatePage(doc, 0));
  const saved = await PDFDocument.load(session.bytes);
  const perms = saved.catalog.lookup(name('Perms'));
  expect(perms).toBeInstanceOf(PDFDict);
  expect(perms.has(name('UR3'))).toBe(false);
  expect(perms.has(name('DocMDP'))).toBe(true);
});

it('an edit removes /Perms once the usage-rights signature was all it held', async () => {
  const doc = await PDFDocument.load(await readerEnabled());
  doc.catalog.lookup(name('Perms')).delete(name('DocMDP'));
  const session = new PdfSession(await doc.save());
  await session.change((d) => rotatePage(d, 0));
  expect((await PDFDocument.load(session.bytes)).catalog.has(name('Perms'))).toBe(false);
});

it('new or carried-over encryption drops the usage-rights signature too', async () => {
  const bytes = await readerEnabled();
  const protectedBytes = await protectPdf(bytes, { open: 'reader' });
  const opened = await unlockPdf(protectedBytes, 'reader');
  const perms = (await PDFDocument.load(opened.bytes)).catalog.lookup(name('Perms'));
  expect(perms.has(name('UR3'))).toBe(false);
  expect(perms.has(name('DocMDP'))).toBe(true);
  // An encrypted Reader-enabled file downloaded with its own protection, unedited.
  const original = await unlockPdf(await protectPdf(bytes, { open: 'reader' }), 'reader');
  const again = await protectPdf(bytes, { original: original.encryption });
  const reopened = (await PDFDocument.load((await unlockPdf(again, 'reader')).bytes)).catalog;
  expect(reopened.lookup(name('Perms')).has(name('UR3'))).toBe(false);
});
