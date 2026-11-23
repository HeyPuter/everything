import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFBool, PDFHexString } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  createSelfSignedId,
  preparePdfSignature,
  embedPdfSignature,
  verifySignatures,
} from '../src/core/digital-signature.js';
import { createSignedData } from '../src/core/cms.js';
import { digest, signingHash } from '../src/core/pki-crypto.js';
import { PdfSession, fillFields, rotatePage } from '../src/core/document.js';
import { crossReferenceChain, latin1, revisionEnds } from '../src/core/pdf-incremental.js';

let id;
beforeAll(async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url) =>
      new Response(await readFile(`public/fonts/${String(url).split('/fonts/').pop()}`)),
  );
  id = await createSelfSignedId({ name: 'Ada Lovelace', keyType: 'P-256' });
});
afterAll(() => vi.restoreAllMocks());

const ascii = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0));

/** A form with each kind of field, saved with object streams or a classic table. */
async function form({ objectStreams = true, needAppearances = false } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const fields = doc.getForm();
  fields.createTextField('Name').addToPage(page, { x: 72, y: 700, width: 200, height: 24 });
  fields.createCheckBox('Agree').addToPage(page, { x: 72, y: 650, width: 18, height: 18 });
  const size = fields.createRadioGroup('Size');
  for (const [i, option] of ['S', 'M', 'L'].entries())
    size.addOptionToPage(option, page, { x: 72 + i * 40, y: 600, width: 18, height: 18 });
  const country = fields.createDropdown('Country');
  country.addOptions(['Canada', 'France', 'Japan']);
  country.addToPage(page, { x: 72, y: 550, width: 150, height: 24 });
  const colors = fields.createOptionList('Colors');
  colors.addOptions(['Red', 'Green', 'Blue']);
  colors.enableMultiselect();
  colors.addToPage(page, { x: 300, y: 500, width: 120, height: 70 });
  if (needAppearances) fields.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  return doc.save({ useObjectStreams: objectStreams });
}

/**
 * Sign, then change the file's end (`tail` maps the signed text to new text) before the
 * signature is computed over it, as files written by other tools end.
 */
async function sign(bytes, { tail = (text) => text, ...options } = {}) {
  const signingTime = new Date();
  const prepared = await preparePdfSignature(bytes, {
    page: 0,
    rect: { x: 72, y: 72, width: 200, height: 50 },
    signingTime,
    certificate: id.certificate,
    ...options,
  });
  const before = latin1(prepared.bytes);
  const after = tail(before);
  const out = ascii(after);
  const range = [
    0,
    prepared.contentsStart,
    prepared.contentsEnd,
    out.length - prepared.contentsEnd,
  ];
  const at = before.lastIndexOf('/ByteRange [', prepared.contentsStart) + '/ByteRange '.length;
  const width = before.indexOf(']', at) + 1 - at;
  out.set(ascii(`[${range.join(' ')}`.padEnd(width - 1) + ']').subarray(0, width), at);
  const parts = [out.subarray(0, prepared.contentsStart), out.subarray(prepared.contentsEnd)];
  const cms = await createSignedData({
    privateKey: id.privateKey,
    certificate: id.certificate,
    chain: [],
    contentDigest: await digest(signingHash(id.privateKey), parts),
    signingTime,
    cades: true,
  });
  return embedPdfSignature({ ...prepared, bytes: out }, cms);
}

/** Every object the cross-reference sections list starts where they say it does. */
function checkCrossReferences(bytes) {
  const chain = crossReferenceChain(bytes);
  expect(chain).not.toBeNull();
  for (const [number, entry] of chain.entries) {
    if (entry.offset === undefined) continue;
    const head = latin1(bytes, entry.offset, entry.offset + 40);
    expect(head, `object ${number}`).toMatch(new RegExp(`^\\s*${number}\\s+\\d+\\s+obj`));
  }
}
/** The values PDF.js reads, by field name. */
async function pdfjsValues(bytes) {
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const doc = await task.promise;
  try {
    const values = {};
    const fields = (await doc.getFieldObjects()) ?? new Map();
    for (const [name, widgets] of fields instanceof Map ? fields : Object.entries(fields))
      values[name] = widgets.find((w) => w.value !== undefined)?.value;
    return values;
  } finally {
    await task.destroy();
  }
}
const fill = async (session, values) =>
  session.change((doc) => fillFields(doc, values), { incremental: true });
const VALUES = {
  Name: 'Grace',
  Agree: true,
  Size: 'M',
  Country: ['France'],
  Colors: ['Red', 'Blue'],
};
async function expectFilled(bytes, signed, { status = 'valid-unknown-identity' } = {}) {
  expect(bytes.subarray(0, signed.length)).toEqual(signed);
  checkCrossReferences(bytes);
  const reports = await verifySignatures(bytes);
  expect(reports.map((r) => r.status)).toEqual(reports.map(() => status));
  const values = await pdfjsValues(bytes);
  expect(values).toMatchObject({ Name: 'Grace', Size: 'M', Country: 'France' });
  expect(values.Agree).not.toBe('Off');
  const form = (await PDFDocument.load(bytes)).getForm();
  expect(form.getTextField('Name').getText()).toBe('Grace');
  expect(form.getCheckBox('Agree').isChecked()).toBe(true);
  expect(form.getRadioGroup('Size').getSelected()).toBe('M');
  expect(form.getOptionList('Colors').getSelected()).toEqual(['Red', 'Blue']);
}

describe('filling in a signed PDF, appended to files as other tools write them', () => {
  for (const objectStreams of [true, false])
    for (const needAppearances of [false, true])
      it(`${objectStreams ? 'cross-reference streams' : 'classic tables'}${needAppearances ? ', NeedAppearances' : ''}`, async () => {
        const signed = await sign(await form({ objectStreams, needAppearances }));
        const session = new PdfSession(signed);
        await fill(session, VALUES);
        expect(revisionEnds(session.bytes)).toHaveLength(revisionEnds(signed).length + 1);
        await expectFilled(session.bytes, signed);
      });

  for (const [name, tail] of [
    ['a last revision without an end of line', (text) => text.replace(/\n$/, '')],
    ['junk after %%EOF', (text) => `${text}\x00\x00junk %%EOX\n`],
    ['a carriage return end of line', (text) => text.replace(/\n$/, '\r\n')],
  ])
    it(name, async () => {
      const signed = await sign(await form(), { tail });
      expect((await verifySignatures(signed))[0].status).toBe('valid-unknown-identity');
      const session = new PdfSession(signed);
      await fill(session, VALUES);
      await expectFilled(session.bytes, signed);
    });

  it('a hybrid-reference file (a table whose trailer points at a cross-reference stream)', async () => {
    const original = await form();
    const text = latin1(original);
    const start = text.lastIndexOf('startxref');
    const offset = Number(/startxref\s+(\d+)/.exec(text.slice(start))[1]);
    const stream = text.slice(offset, offset + 400);
    const size = /\/Size (\d+)/.exec(stream)[1];
    const root = /\/Root (\d+ \d+ R)/.exec(stream)[1];
    const table = text.length - (text.length - start);
    const hybrid = ascii(
      `${text.slice(0, start)}xref\n0 1\n0000000000 65535 f\r\ntrailer\n<< /Size ${size} /Root ${root} /XRefStm ${offset} >>\nstartxref\n${table}\n%%EOF\n`,
    );
    checkCrossReferences(hybrid);
    const signed = await sign(hybrid);
    const session = new PdfSession(signed);
    await fill(session, VALUES);
    await expectFilled(session.bytes, signed);
  });

  it('a file whose cross-reference offset is wrong is written anew', async () => {
    const signed = await sign(await form(), {
      tail: (text) => text.replace(/startxref\n\d+\n%%EOF\n$/, 'startxref\n0\n%%EOF\n'),
    });
    const session = new PdfSession(signed);
    await fill(session, VALUES);
    // Nothing to append to that readers would find: the file is written whole, as before.
    expect(revisionEnds(session.bytes)).toHaveLength(1);
    checkCrossReferences(session.bytes);
    expect(await pdfjsValues(session.bytes)).toMatchObject({ Name: 'Grace', Size: 'M' });
  });

  it('a fill, saved and opened again, filled again: two revisions after the signature', async () => {
    const signed = await sign(await form());
    const first = new PdfSession(signed);
    await fill(first, { Name: 'Ada' });
    const second = new PdfSession(first.bytes);
    await fill(second, VALUES);
    expect(revisionEnds(second.bytes)).toHaveLength(revisionEnds(signed).length + 2);
    await expectFilled(second.bytes, signed);
  });

  it('a value filled in and taken back out, then Undo', async () => {
    const signed = await sign(await form());
    const session = new PdfSession(signed);
    await fill(session, { Name: 'Grace', Size: 'M' });
    await fill(session, { Name: '', Size: [] });
    checkCrossReferences(session.bytes);
    expect((await verifySignatures(session.bytes))[0].status).toBe('valid-unknown-identity');
    expect(await pdfjsValues(session.bytes)).toMatchObject({ Name: '', Size: 'Off' });
    session.undo();
    session.undo();
    expect(session.bytes).toEqual(signed);
  });

  it('a fill, then another edit, then a fill', async () => {
    const signed = await sign(await form());
    const session = new PdfSession(signed);
    await fill(session, { Name: 'Ada' });
    // Turning a page writes the file anew, and the signature then covers other bytes.
    await session.change((doc) => rotatePage(doc, 0));
    expect((await verifySignatures(session.bytes))[0].status).toBe('invalid');
    await fill(session, VALUES);
    checkCrossReferences(session.bytes);
    const values = await pdfjsValues(session.bytes);
    expect(values).toMatchObject({ Name: 'Grace', Size: 'M', Country: 'France' });
    expect((await PDFDocument.load(session.bytes)).getPage(0).getRotation().angle).toBe(90);
  });

  for (const certify of [2, 3])
    it(`a certification allowing form filling (P=${certify})`, async () => {
      const signed = await sign(await form(), { certify });
      const session = new PdfSession(signed);
      await fill(session, VALUES);
      await expectFilled(session.bytes, signed);
      const [report] = await verifySignatures(session.bytes);
      expect(report.modifications.disallowed).toEqual([]);
    });

  it('a certification allowing no changes (P=1) shows the fill as a change', async () => {
    const signed = await sign(await form(), { certify: 1 });
    const session = new PdfSession(signed);
    await fill(session, { Name: 'Grace' });
    checkCrossReferences(session.bytes);
    const [report] = await verifySignatures(session.bytes);
    expect(report.status).toBe('modified');
  });

  it('a field locked by a signature shows the fill as a change; others do not', async () => {
    const doc = await PDFDocument.load(await form());
    const page = doc.getPage(0);
    const field = doc.context.obj({
      FT: 'Sig',
      T: PDFHexString.fromText('Approver'),
      Type: 'Annot',
      Subtype: 'Widget',
      Rect: [300, 72, 500, 122],
      F: 4,
      P: page.ref,
      Lock: { Type: 'SigFieldLock', Action: 'Include', Fields: [PDFHexString.fromText('Name')] },
    });
    const ref = doc.context.register(field);
    doc.getForm().acroForm.addField(ref);
    page.node.addAnnot(ref);
    const signed = await sign(await doc.save(), { fieldName: 'Approver' });
    expect((await verifySignatures(signed))[0].fieldLock).toEqual({
      action: 'Include',
      fields: ['Name'],
    });
    const other = new PdfSession(signed);
    await fill(other, { Size: 'M' });
    expect((await verifySignatures(other.bytes))[0].status).toBe('valid-unknown-identity');
    const locked = new PdfSession(signed);
    await fill(locked, { Name: 'Grace' });
    checkCrossReferences(locked.bytes);
    expect((await verifySignatures(locked.bytes))[0].status).toBe('modified');
  });
});
