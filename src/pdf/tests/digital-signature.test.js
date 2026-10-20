import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import {
  degrees,
  PDFArray,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  createSelfSignedId,
  embedPdfSignature,
  listSignatureFields,
  preparePdfSignature,
  signPdf,
  timestampPdf,
  verifySignatures,
} from '../src/core/digital-signature.js';
import {
  appendRevision,
  highestObjectNumber,
  lastCrossReference,
  objectBytes,
} from '../src/core/pdf-incremental.js';
import { protectPdf } from '../src/core/security.js';
import { createSignedData } from '../src/core/cms.js';
import { digest, signingHash } from '../src/core/pki-crypto.js';
import { decodeDer, toPem } from '../src/core/asn1.js';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const hasPdfsig = spawnSync('pdfsig', ['-v']).status === 0;
const scratch = () => mkdtempSync(join(tmpdir(), 'pdf-signature-'));
const RECT = { x: 72, y: 72, width: 220, height: 60 };

async function makePdf({ objectStreams = false, pages = 1, rotate = 0 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Agreement page ${i + 1}`, { x: 72, y: 700, size: 20, font });
    if (rotate) page.setRotation(degrees(rotate));
  }
  return doc.save({ useObjectStreams: objectStreams });
}

/** Append a revision made with pdf-lib objects, the way another incremental editor would. */
async function appendUpdate(bytes, edit) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const xref = lastCrossReference(bytes);
  doc.context.largestObjectNumber = Math.max(
    doc.context.largestObjectNumber,
    xref.size - 1,
    highestObjectNumber(bytes),
  );
  const changed = new Map();
  edit(doc, (ref, object) => changed.set(ref.objectNumber, { ref, body: objectBytes(object) }));
  return appendRevision(bytes, [...changed.values()], {
    xref,
    size: doc.context.largestObjectNumber + 1,
    trailer: {
      root: doc.context.trailerInfo.Root,
      info: doc.context.trailerInfo.Info,
      id: null,
    },
  }).bytes;
}
const addSquareAnnotation = (bytes) =>
  appendUpdate(bytes, (doc, mark) => {
    const page = doc.getPage(0);
    const annot = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Square',
      Rect: [300, 300, 400, 400],
      C: [1, 0, 0],
    });
    const ref = doc.context.nextRef();
    mark(ref, annot);
    const annots = page.node.lookup(PDFName.of('Annots'));
    if (annots instanceof PDFArray) annots.push(ref);
    else page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
    mark(page.ref, page.node);
  });
const addPageContent = (bytes) =>
  appendUpdate(bytes, (doc, mark) => {
    const page = doc.getPage(0);
    const stream = doc.context.stream('BT /F1 30 Tf 100 400 Td (Pay $1,000,000) Tj ET');
    const ref = doc.context.nextRef();
    mark(ref, stream);
    const contents = page.node.get(PDFName.of('Contents'));
    page.node.set(PDFName.of('Contents'), doc.context.obj([contents, ref]));
    mark(page.ref, page.node);
  });

async function openWithPdfjs(bytes) {
  const pdf = await pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
  }).promise;
  const annotations = [];
  for (let i = 1; i <= pdf.numPages; i++)
    annotations.push(...(await (await pdf.getPage(i)).getAnnotations()));
  return { pages: pdf.numPages, annotations };
}

function tinyPng() {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6; // RGBA
  const raw = Buffer.from([
    0, 0, 0, 255, 255, 255, 0, 0, 128, 0, 0, 0, 255, 0, 0, 255, 255, 0, 0, 0,
  ]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

let rsa;
let ec;
beforeAll(async () => {
  const notBefore = new Date('2026-01-01T00:00:00Z');
  rsa = await createSelfSignedId({
    name: 'Jane Signer',
    email: 'jane@example.com',
    organization: 'Acme Corp',
    keyType: 'RSA-2048',
    notBefore,
  });
  ec = await createSelfSignedId({
    name: 'Eve Approver',
    keyType: 'P-256',
    notBefore,
  });
});

describe('signing and validating', () => {
  it('signs with RSA and reports the signature like Acrobat', async () => {
    const original = await makePdf();
    const time = new Date('2026-10-01T09:30:00Z');
    const signed = await signPdf(original, rsa, {
      page: 0,
      rect: RECT,
      reason: 'I approve this document',
      location: 'Berlin',
      contactInfo: '+49 30 1234',
      signingTime: time,
    });
    // An incremental update: the original bytes are untouched.
    expect(Buffer.from(signed.subarray(0, original.length)).equals(Buffer.from(original))).toBe(
      true,
    );
    const [result] = await verifySignatures(signed, {
      now: new Date('2026-10-02T00:00:00Z'),
    });
    expect(result.status).toBe('valid-unknown-identity');
    expect(result.fieldName).toBe('Signature1');
    expect(result.page).toBe(0);
    expect(result.rect).toEqual([72, 72, 292, 132]);
    expect(result.subFilter).toBe('ETSI.CAdES.detached');
    expect(result.signer).toMatchObject({
      name: 'Jane Signer',
      email: 'jane@example.com',
      organization: 'Acme Corp',
    });
    expect(result.reason).toBe('I approve this document');
    expect(result.location).toBe('Berlin');
    expect(result.contactInfo).toBe('+49 30 1234');
    expect(result.signingTime.getTime()).toBe(time.getTime());
    expect(result.signingTimeSource).toBe('signature-dictionary');
    expect(result.coversWholeDocument).toBe(true);
    expect(result.laterRevisions).toBe(false);
    expect(result.revision).toBe(2);
    expect(result.totalRevisions).toBe(2);
    expect(result.integrity).toMatchObject({
      digestMatches: true,
      signatureValid: true,
      digestAlgorithm: 'SHA-256',
    });
    expect(result.selfSigned).toBe(true);
    expect(result.chain).toHaveLength(1);
    expect(result.certificateValidAtSigningTime).toBe(true);
    expect(result.trusted).toBe(false);

    const [trusted] = await verifySignatures(signed, {
      trustedCertificates: [toPem('CERTIFICATE', rsa.certificate)],
    });
    expect(trusted.status).toBe('valid');
    expect(trusted.trusted).toBe(true);
    expect(trusted.summary).toMatch(/Signature is valid/);
  });

  it('signs with ECDSA P-256 a file whose cross-reference is a stream', async () => {
    const original = await makePdf({ objectStreams: true });
    expect(lastCrossReference(original).kind).toBe('stream');
    const signed = await signPdf(original, ec, { page: 0, rect: RECT });
    expect(lastCrossReference(signed).kind).toBe('stream');
    const [result] = await verifySignatures(signed);
    expect(result.status).toBe('valid-unknown-identity');
    expect(result.integrity.signatureAlgorithm).toBe('ECDSA with SHA-256');
    expect(result.signer.name).toBe('Eve Approver');
  });

  it('writes signatures PDF.js and pdf-lib can open', async () => {
    for (const objectStreams of [false, true]) {
      const signed = await signPdf(await makePdf({ objectStreams }), rsa, {
        page: 0,
        rect: RECT,
        reason: 'OK',
      });
      const { pages, annotations } = await openWithPdfjs(signed);
      expect(pages).toBe(1);
      const widget = annotations.find((a) => a.fieldType === 'Sig');
      expect(widget).toBeTruthy();
      expect(widget.fieldName).toBe('Signature1');
      expect(widget.rect.map(Math.round)).toEqual([72, 72, 292, 132]);
      const doc = await PDFDocument.load(signed);
      expect(doc.getPageCount()).toBe(1);
      expect(
        doc
          .getForm()
          .getFields()
          .map((f) => f.getName()),
      ).toEqual(['Signature1']);
    }
  });

  it('detects tampering inside the signed byte range', async () => {
    const signed = await signPdf(await makePdf(), rsa, { page: 0, rect: RECT });
    const [{ byteRange }] = await verifySignatures(signed);
    for (const at of [Math.floor(byteRange[1] / 2), byteRange[2] + 5]) {
      const tampered = signed.slice();
      tampered[at] ^= 0x01;
      const [result] = await verifySignatures(tampered);
      expect(result.status).toBe('invalid');
      expect(result.integrity.digestMatches).toBe(false);
    }
    // A corrupted signature value (the last bytes of the CMS are the RSA signature).
    const hex = Buffer.from(signed.subarray(byteRange[1] + 1, byteRange[2] - 1)).toString('latin1');
    const cmsLength = decodeDer(Buffer.from(hex, 'hex')).end;
    const broken = signed.slice();
    const at = byteRange[1] + 1 + (cmsLength - 10) * 2;
    // Change the hex digit's value (not just its case, which decodes the same).
    const digit = parseInt(String.fromCharCode(broken[at]), 16);
    broken[at] = '0123456789abcdef'.charCodeAt((digit + 1) % 16);
    const [corrupted] = await verifySignatures(broken);
    expect(corrupted.status).toBe('invalid');
    expect(corrupted.integrity).toMatchObject({
      digestMatches: true,
      signatureValid: false,
    });
  });

  it('reports a full rewrite (as other edits do) as invalid', async () => {
    const signed = await signPdf(await makePdf(), rsa, { page: 0, rect: RECT });
    const rewritten = await (await PDFDocument.load(signed)).save();
    const [result] = await verifySignatures(rewritten);
    expect(result.status).toBe('invalid');
  });

  it('keeps a signature valid after allowed later revisions and flags disallowed ones', async () => {
    const signed = await signPdf(await makePdf(), rsa, { page: 0, rect: RECT });
    const annotated = await addSquareAnnotation(signed);
    const [allowed] = await verifySignatures(annotated);
    expect(allowed.status).toBe('valid-unknown-identity');
    expect(allowed.laterRevisions).toBe(true);
    expect(allowed.coversWholeDocument).toBe(false);
    expect(allowed.revision).toBe(2);
    expect(allowed.totalRevisions).toBe(3);
    expect(allowed.modifications.allowed).toContain('An annotation was added.');
    expect(allowed.modifications.disallowed).toEqual([]);
    expect(allowed.summary).toMatch(/later changes/);

    const changed = await addPageContent(signed);
    const [modified] = await verifySignatures(changed);
    expect(modified.status).toBe('modified');
    expect(modified.integrity.signatureValid).toBe(true);
    expect(modified.modifications.disallowed.join(' ')).toMatch(
      /Page properties were changed \(Contents\)/,
    );
  });

  it('signs twice without breaking the first signature', async () => {
    const once = await signPdf(await makePdf(), rsa, {
      page: 0,
      rect: RECT,
      reason: 'Author',
    });
    const twice = await signPdf(once, ec, {
      page: 0,
      rect: { x: 320, y: 72, width: 220, height: 60 },
      reason: 'Reviewer',
    });
    const results = await verifySignatures(twice);
    expect(results.map((r) => [r.fieldName, r.status, r.laterRevisions])).toEqual([
      ['Signature1', 'valid-unknown-identity', true],
      ['Signature2', 'valid-unknown-identity', false],
    ]);
    expect(results[0].modifications.allowed).toEqual(
      expect.arrayContaining(['The document was signed.', 'A signature field was added.']),
    );
    expect(await listSignatureFields(twice)).toEqual([
      {
        name: 'Signature1',
        page: 0,
        rect: [72, 72, 292, 132],
        invisible: false,
        signed: true,
      },
      {
        name: 'Signature2',
        page: 0,
        rect: [320, 72, 540, 132],
        invisible: false,
        signed: true,
      },
    ]);
  });

  it('fills an existing empty signature field by name', async () => {
    const doc = await PDFDocument.load(await makePdf({ pages: 2 }));
    const page = doc.getPage(1);
    const field = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      Rect: [100, 100, 300, 160],
      F: 4,
      P: page.ref,
    });
    field.set(PDFName.of('T'), PDFString.of('Approver'));
    const fieldRef = doc.context.register(field);
    page.node.set(PDFName.of('Annots'), doc.context.obj([fieldRef]));
    const text = doc.context.obj({ FT: 'Tx', T: PDFString.of('Notes') });
    const textRef = doc.context.register(text);
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [fieldRef, textRef] }));
    const prepared = await doc.save({ useObjectStreams: false });

    expect(await listSignatureFields(prepared)).toEqual([
      {
        name: 'Approver',
        page: 1,
        rect: [100, 100, 300, 160],
        invisible: false,
        signed: false,
      },
    ]);
    await expect(signPdf(prepared, rsa, { fieldName: 'Notes' })).rejects.toThrow(
      /not a signature field/,
    );
    const signed = await signPdf(prepared, rsa, {
      fieldName: 'Approver',
      reason: 'Approved',
    });
    const [result] = await verifySignatures(signed);
    expect(result).toMatchObject({
      fieldName: 'Approver',
      page: 1,
      status: 'valid-unknown-identity',
    });
    expect((await listSignatureFields(signed))[0].signed).toBe(true);
    await expect(signPdf(signed, rsa, { fieldName: 'Approver' })).rejects.toThrow(/already signed/);
    const { annotations } = await openWithPdfjs(signed);
    expect(annotations.filter((a) => a.fieldType === 'Sig').map((a) => a.fieldName)).toEqual([
      'Approver',
    ]);
  });

  it('signs invisibly, with an image, and on rotated pages', async () => {
    const invisible = await signPdf(await makePdf(), rsa, {});
    const [hidden] = await verifySignatures(invisible);
    expect(hidden.status).toBe('valid-unknown-identity');
    expect(hidden.invisible).toBe(true);

    const pictured = await signPdf(await makePdf({ rotate: 90 }), ec, {
      page: 0,
      rect: RECT,
      appearance: {
        image: tinyPng(),
        lines: ['Signed by Eve', 'With a picture'],
      },
    });
    const [withImage] = await verifySignatures(pictured);
    expect(withImage.status).toBe('valid-unknown-identity');
    const doc = await PDFDocument.load(pictured);
    const widget = doc.getPage(0).node.lookup(PDFName.of('Annots')).lookup(0);
    const appearance = widget.lookup(PDFName.of('AP')).lookup(PDFName.of('N'));
    expect(
      appearance.dict
        .lookup(PDFName.of('Matrix'))
        .asArray()
        .map((n) => n.asNumber()),
    ).toEqual([0, 1, -1, 0, 0, 0]);
    expect(
      appearance.dict
        .lookup(PDFName.of('Resources'))
        .lookup(PDFName.of('XObject'))
        .has(PDFName.of('Img')),
    ).toBe(true);
    expect((await openWithPdfjs(pictured)).annotations.some((a) => a.fieldType === 'Sig')).toBe(
      true,
    );
  });

  it('writes adbe.pkcs7.detached with a signing-time attribute', async () => {
    const time = new Date('2026-09-30T12:00:00Z');
    const signed = await signPdf(await makePdf(), rsa, {
      page: 0,
      rect: RECT,
      subFilter: 'adbe.pkcs7.detached',
      signingTime: time,
    });
    const [result] = await verifySignatures(signed);
    expect(result.subFilter).toBe('adbe.pkcs7.detached');
    expect(result.status).toBe('valid-unknown-identity');
    expect(result.signingTimeSource).toBe('signed-attribute');
    expect(result.signingTime.getTime()).toBe(time.getTime());
  });

  it('certifies documents and enforces the DocMDP permissions', async () => {
    const noChanges = await signPdf(await makePdf(), rsa, {
      page: 0,
      rect: RECT,
      certify: 1,
    });
    const [certified] = await verifySignatures(noChanges);
    expect(certified).toMatchObject({
      kind: 'certification',
      certification: { level: 1 },
      status: 'valid-unknown-identity',
    });
    await expect(signPdf(noChanges, ec, {})).rejects.toThrow(/certified/);
    const [annotatedP1] = await verifySignatures(await addSquareAnnotation(noChanges));
    expect(annotatedP1.status).toBe('modified');

    const formsOnly = await signPdf(await makePdf(), rsa, {
      page: 0,
      rect: RECT,
      certify: 2,
    });
    const approved = await signPdf(formsOnly, ec, {
      page: 0,
      rect: { x: 320, y: 72, width: 200, height: 50 },
    });
    expect((await verifySignatures(approved)).map((r) => r.status)).toEqual([
      'valid-unknown-identity',
      'valid-unknown-identity',
    ]);
    const [annotatedP2] = await verifySignatures(await addSquareAnnotation(formsOnly));
    expect(annotatedP2.status).toBe('modified');
    expect(annotatedP2.modifications.disallowed).toContain('An annotation was added.');

    const annotationsOk = await signPdf(await makePdf(), rsa, {
      page: 0,
      rect: RECT,
      certify: 3,
    });
    const [annotatedP3] = await verifySignatures(await addSquareAnnotation(annotationsOk));
    expect(annotatedP3.status).toBe('valid-unknown-identity');
    await expect(signPdf(approved, rsa, { certify: 2 })).rejects.toThrow(/certified only before/);
  });

  it('tells filling a certified form from moving or hiding its fields', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    for (const [fieldName, y] of [
      ['Name', 600],
      ['Amount', 500],
    ])
      doc
        .getForm()
        .createTextField(fieldName)
        .addToPage(page, { x: 72, y, width: 200, height: 24 });
    const certified = await signPdf(await doc.save({ useObjectStreams: false }), rsa, {
      page: 0,
      rect: RECT,
      certify: 2,
    });
    const editWidget = (edit) =>
      appendUpdate(certified, (doc, mark) => {
        const widget = doc.getForm().getTextField('Amount').acroField.getWidgets()[0];
        edit(widget.dict, doc);
        mark(doc.context.getObjectRef(widget.dict), widget.dict);
      });
    const filled = await appendUpdate(certified, (doc, mark) => {
      const field = doc.getForm().getTextField('Name');
      field.acroField.dict.set(PDFName.of('V'), PDFString.of('Ada'));
      mark(field.ref, field.acroField.dict);
    });
    const [fill] = await verifySignatures(filled);
    expect(fill.status).toBe('valid-unknown-identity');
    expect(fill.modifications.allowed).toEqual(['The form field "Name" was filled in.']);
    // Hiding a field or moving it elsewhere changes what the signer saw.
    for (const [edit, key] of [
      [(widget) => widget.set(PDFName.of('F'), PDFNumber.of(2)), 'F'],
      [
        (widget, doc) => widget.set(PDFName.of('Rect'), doc.context.obj([300, 300, 500, 324])),
        'Rect',
      ],
    ]) {
      const [changed] = await verifySignatures(await editWidget(edit));
      expect(changed.status).toBe('modified');
      expect(changed.modifications.disallowed).toEqual([
        `The form field "Amount" was changed (${key}).`,
      ]);
    }
  });

  it('rejects a byte range that leaves more than the signature value unsigned', async () => {
    // A signature over three ranges: its value, and also the certification level, left out.
    const prepared = await preparePdfSignature(await makePdf(), {
      certificate: rsa.certificate,
      page: 0,
      rect: RECT,
      certify: 1,
    });
    const { bytes } = prepared;
    const text = new TextDecoder('latin1').decode(bytes);
    const level = text.indexOf('/P 1 ') + 3;
    const [, before, after] = prepared.byteRange;
    const ranges = [0, before, after, level - after, level + 1, bytes.length - level - 1];
    const at = text.indexOf('/ByteRange [') + 11;
    const width = text.indexOf(']', at) + 1 - at;
    const written = `[${ranges.join(' ')}`;
    bytes.set(new TextEncoder().encode(`${written.padEnd(width - 1)}]`), at);
    const parts = [
      bytes.subarray(0, before),
      bytes.subarray(after, level),
      bytes.subarray(level + 1),
    ];
    const cms = await createSignedData({
      privateKey: rsa.privateKey,
      certificate: rsa.certificate,
      chain: [],
      contentDigest: await digest(signingHash(rsa.privateKey), parts),
      signingTime: new Date('2026-06-01T00:00:00Z'),
      cades: true,
    });
    const signed = embedPdfSignature(prepared, cms);
    // "No changes" becomes "annotations allowed" without touching a signed byte.
    signed.set(new TextEncoder().encode('3'), level);
    const [result] = await verifySignatures(signed);
    expect(result.status).toBe('invalid');
    expect(result.errors).toEqual(['The signature byte range leaves part of the file unsigned.']);
  });

  it('refuses password-protected files', async () => {
    const locked = await protectPdf(await makePdf(), {
      open: 'user',
      permissions: 'owner',
    });
    await expect(signPdf(locked, rsa, {})).rejects.toThrow(/Password-protected/);
  });

  it('never throws on malformed input', async () => {
    expect(await verifySignatures(new Uint8Array(100))).toEqual([]);
    expect(await verifySignatures(new TextEncoder().encode('%PDF-1.7\n garbage'))).toEqual([]);
    const signed = await signPdf(await makePdf(), rsa, { page: 0, rect: RECT });
    const [{ byteRange }] = await verifySignatures(signed);
    // Garbage DER in the signature value.
    const garbage = signed.slice();
    garbage.set(new TextEncoder().encode('3082FFFF0101'), byteRange[1] + 1);
    const [bad] = await verifySignatures(garbage);
    expect(['invalid', 'unsupported']).toContain(bad.status);
    // A truncated file.
    const truncated = await verifySignatures(signed.subarray(0, byteRange[1] + 100));
    expect(Array.isArray(truncated)).toBe(true);
    // A byte range that does not match the file.
    const shifted = new Uint8Array(signed.length + 1);
    shifted.set(signed.subarray(0, 10));
    shifted[10] = 0x20;
    shifted.set(signed.subarray(10), 11);
    const results = await verifySignatures(shifted);
    expect(results.every((r) => r.status === 'invalid')).toBe(true);
    expect(await listSignatureFields(new Uint8Array(3))).toEqual([]);
  });
});

describe.skipIf(!hasOpenssl)('interoperability with OpenSSL', () => {
  it('OpenSSL verifies the CMS of a signed PDF', async () => {
    const dir = scratch();
    for (const [id, subFilter] of [
      [rsa, 'ETSI.CAdES.detached'],
      [ec, 'adbe.pkcs7.detached'],
    ]) {
      const signed = await signPdf(await makePdf(), id, {
        page: 0,
        rect: RECT,
        subFilter,
      });
      const [{ byteRange }] = await verifySignatures(signed);
      const covered = Buffer.concat([
        signed.subarray(0, byteRange[1]),
        signed.subarray(byteRange[2]),
      ]);
      const hex = Buffer.from(signed.subarray(byteRange[1] + 1, byteRange[2] - 1))
        .toString('latin1')
        .replace(/(00)+$/, '');
      writeFileSync(join(dir, 'covered.bin'), covered);
      writeFileSync(join(dir, 'sig.der'), Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex'));
      const out = spawnSync(
        'openssl',
        [
          'cms',
          '-verify',
          '-inform',
          'DER',
          '-in',
          'sig.der',
          '-binary',
          '-content',
          'covered.bin',
          '-noverify',
          '-out',
          '/dev/null',
        ],
        { cwd: dir, encoding: 'utf8' },
      );
      expect(out.stderr).toContain('Verification successful');
    }
  });

  it('validates CMS signatures made by OpenSSL (RSA, RSA-PSS, ECDSA P-384, SHA-1/384/512, no attributes)', async () => {
    const dir = scratch();
    const run = (args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
    run([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'rsa.key',
      '-out',
      'rsa.crt',
      '-days',
      '30',
      '-subj',
      '/CN=OpenSSL RSA',
    ]);
    run([
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-384',
      '-nodes',
      '-keyout',
      'ec.key',
      '-out',
      'ec.crt',
      '-days',
      '30',
      '-subj',
      '/CN=OpenSSL P-384',
    ]);
    const variants = [
      ['rsa', ['-md', 'sha256'], 'RSA with SHA-256'],
      ['rsa', ['-md', 'sha1'], 'RSA with SHA-1'],
      ['rsa', ['-md', 'sha512', '-noattr'], 'RSA with SHA-512'],
      ['rsa', ['-md', 'sha384', '-keyopt', 'rsa_padding_mode:pss'], 'RSA-PSS with SHA-384'],
      ['ec', ['-md', 'sha384'], 'ECDSA with SHA-384'],
    ];
    for (const [key, extra, algorithm] of variants) {
      const prepared = await preparePdfSignature(await makePdf(), {
        page: 0,
        rect: RECT,
        subFilter: 'adbe.pkcs7.detached',
        signerName: 'External',
      });
      writeFileSync(join(dir, 'covered.bin'), Buffer.concat(prepared.signedParts()));
      run([
        'cms',
        '-sign',
        '-binary',
        '-in',
        'covered.bin',
        '-signer',
        `${key}.crt`,
        '-inkey',
        `${key}.key`,
        '-outform',
        'DER',
        '-out',
        'sig.der',
        ...extra,
      ]);
      const signed = embedPdfSignature(
        prepared,
        new Uint8Array(readFileSync(join(dir, 'sig.der'))),
      );
      const [result] = await verifySignatures(signed);
      expect(result.status, algorithm).toBe('valid-unknown-identity');
      expect(result.integrity.signatureAlgorithm).toBe(algorithm);
      const tampered = signed.slice();
      tampered[100] ^= 1;
      expect((await verifySignatures(tampered))[0].status).toBe('invalid');
    }
  });

  it('embeds and validates RFC 3161 timestamps from an OpenSSL TSA', async () => {
    const dir = scratch();
    const run = (args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
    run([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'tsa.key',
      '-out',
      'tsa.crt',
      '-days',
      '30',
      '-subj',
      '/CN=Test TSA',
      '-addext',
      'extendedKeyUsage=critical,timeStamping',
    ]);
    writeFileSync(join(dir, 'serial'), '01\n');
    writeFileSync(
      join(dir, 'tsa.cnf'),
      `[ tsa ]\ndefault_tsa = tsa1\n[ tsa1 ]\ndir = ${dir}\nserial = $dir/serial\ncrypto_device = builtin\nsigner_cert = $dir/tsa.crt\ncerts = $dir/tsa.crt\nsigner_key = $dir/tsa.key\nsigner_digest = sha256\ndefault_policy = 1.2.3.4.1\ndigests = sha256, sha384, sha512\naccuracy = secs:1\ness_cert_id_alg = sha256\n`,
    );
    const tsa = async (request) => {
      writeFileSync(join(dir, 'req.tsq'), request);
      run(['ts', '-reply', '-config', 'tsa.cnf', '-queryfile', 'req.tsq', '-out', 'resp.tsr']);
      return new Uint8Array(readFileSync(join(dir, 'resp.tsr')));
    };
    const signed = await signPdf(await makePdf(), rsa, {
      page: 0,
      rect: RECT,
      timestamp: tsa,
      signingTime: new Date(Date.now() - 60000),
    });
    const [result] = await verifySignatures(signed);
    expect(result.status).toBe('valid-unknown-identity');
    expect(result.timestamp).toMatchObject({
      valid: true,
      imprintMatches: true,
      tsa: 'Test TSA',
    });
    expect(result.signingTimeSource).toBe('timestamp');
    expect(Math.abs(result.signingTime - Date.now())).toBeLessThan(60000);

    const stamped = await timestampPdf(signed, { timestamp: tsa });
    const results = await verifySignatures(stamped);
    expect(results.map((r) => [r.kind, r.status])).toEqual([
      ['approval', 'valid-unknown-identity'],
      ['timestamp', 'valid-unknown-identity'],
    ]);
    expect(results[0].modifications.allowed).toContain('A document timestamp was added.');
    expect(results[1].signer.name).toBe('Test TSA');
  });
});

describe.skipIf(!hasPdfsig)('interoperability with Poppler (pdfsig)', () => {
  it('pdfsig validates single and double signatures', async () => {
    const dir = scratch();
    const once = await signPdf(await makePdf({ objectStreams: true }), rsa, {
      page: 0,
      rect: RECT,
      reason: 'Author',
    });
    const twice = await signPdf(once, ec, {
      page: 0,
      rect: { x: 320, y: 72, width: 200, height: 50 },
      subFilter: 'adbe.pkcs7.detached',
    });
    writeFileSync(join(dir, 'twice.pdf'), twice);
    const out = spawnSync('pdfsig', ['-nocert', join(dir, 'twice.pdf')], {
      encoding: 'utf8',
    }).stdout;
    expect(out.match(/Signature Validation: Signature is Valid\./g)).toHaveLength(2);
    expect(out).toContain('Signer Certificate Common Name: Jane Signer');
    expect(out).toContain('Signer Certificate Common Name: Eve Approver');
    expect(out).toContain('Not total document signed');
    expect(out).toContain('Total document signed');
  });
});

describe('PDF number and string details', () => {
  it('encodes non-ASCII reasons and names as UTF-16 text', async () => {
    const id = await createSelfSignedId({
      name: 'Zoë Ångström',
      keyType: 'P-256',
    });
    const signed = await signPdf(await makePdf(), id, {
      page: 0,
      rect: RECT,
      reason: 'Geprüft (ok)',
      location: '東京',
    });
    const [result] = await verifySignatures(signed);
    expect(result.reason).toBe('Geprüft (ok)');
    expect(result.location).toBe('東京');
    expect(result.signer.name).toBe('Zoë Ångström');
    expect(result.nameInSignature).toBe('Zoë Ångström');
    const doc = await PDFDocument.load(signed);
    const sig = doc.getForm().getFields()[0].acroField.dict.lookup(PDFName.of('V'));
    expect(sig.lookup(PDFName.of('Reason'))).toBeInstanceOf(PDFHexString);
    expect(
      sig
        .lookup(PDFName.of('ByteRange'))
        .asArray()
        .every((n) => n instanceof PDFNumber),
    ).toBe(true);
  });
});
