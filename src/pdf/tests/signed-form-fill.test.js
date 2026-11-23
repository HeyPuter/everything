import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { createSelfSignedId, signPdf, verifySignatures } from '../src/core/digital-signature.js';
import { PdfSession, fillFields } from '../src/core/document.js';
import { revisionEnds } from '../src/core/pdf-incremental.js';

let id;
beforeAll(async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url) =>
      new Response(await readFile(`public/fonts/${String(url).split('/fonts/').pop()}`)),
  );
  id = await createSelfSignedId({ name: 'Ada Lovelace', keyType: 'P-256' });
});
afterAll(() => vi.restoreAllMocks());

async function form() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const fields = doc.getForm();
  fields.createTextField('Name').addToPage(page, { x: 72, y: 600, width: 200, height: 24 });
  fields.createCheckBox('Agree').addToPage(page, { x: 72, y: 550, width: 18, height: 18 });
  return doc.save();
}
const sign = async (bytes, options = {}) =>
  signPdf(bytes, id, { page: 0, rect: { x: 72, y: 72, width: 200, height: 50 }, ...options });

describe('filling in a signed PDF', () => {
  // Filling in a form someone signed rewrote the whole file, so the signature broke: the next
  // person could not fill in the fields left for them and keep the first signature.
  it('appends the values, so the signature stays valid', async () => {
    for (const certify of [undefined, 2]) {
      const signed = await sign(await form(), { certify });
      const session = new PdfSession(signed);
      await session.change((doc) => fillFields(doc, { Name: 'Grace Hopper', Agree: true }), {
        incremental: true,
      });
      // The signed bytes are kept as they were, with one revision after them.
      expect(session.bytes.subarray(0, signed.length)).toEqual(signed);
      expect(revisionEnds(session.bytes)).toHaveLength(revisionEnds(signed).length + 1);
      const [report] = await verifySignatures(session.bytes);
      expect(report.status).toBe('valid-unknown-identity');
      expect(report.modifications.disallowed).toEqual([]);
      expect(report.modifications.allowed).toContain('The form field "Name" was filled in.');
      const saved = (await PDFDocument.load(session.bytes)).getForm();
      expect(saved.getTextField('Name').getText()).toBe('Grace Hopper');
      expect(saved.getCheckBox('Agree').isChecked()).toBe(true);
    }
  });

  it('can sign again after filling in', async () => {
    const session = new PdfSession(await sign(await form()));
    await session.change((doc) => fillFields(doc, { Name: 'Grace Hopper' }), {
      incremental: true,
    });
    const twice = await sign(session.bytes, { rect: { x: 300, y: 72, width: 200, height: 50 } });
    expect((await verifySignatures(twice)).map((report) => report.status)).toEqual([
      'valid-unknown-identity',
      'valid-unknown-identity',
    ]);
  });

  it('still rewrites an unsigned PDF whole', async () => {
    const original = await form();
    const session = new PdfSession(original);
    await session.change((doc) => fillFields(doc, { Name: 'Grace Hopper' }), {
      incremental: true,
    });
    expect(revisionEnds(session.bytes)).toHaveLength(1);
    const saved = (await PDFDocument.load(session.bytes)).getForm();
    expect(saved.getTextField('Name').getText()).toBe('Grace Hopper');
  });

  it('leaves a signed PDF as it was when nothing changes', async () => {
    const signed = await sign(await form());
    const session = new PdfSession(signed);
    const result = await session.change((doc) => fillFields(doc, { Name: '' }), {
      incremental: true,
    });
    expect(result).toBe(false);
    expect(session.bytes).toEqual(signed);
  });
});
