import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { createSelfSignedId, signPdf, verifySignatures } from '../src/core/digital-signature.js';

afterEach(() => vi.restoreAllMocks());

let polish;
let english;
beforeAll(async () => {
  const notBefore = new Date('2026-01-01T00:00:00Z');
  polish = await createSelfSignedId({ name: 'Łukasz Żółć', keyType: 'P-256', notBefore });
  english = await createSelfSignedId({ name: 'Jane Signer', keyType: 'P-256', notBefore });
});

async function blankPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return doc.save();
}
/** The font the signature's drawing writes its words in, and the characters it maps. */
async function appearanceFont(bytes) {
  const doc = await PDFDocument.load(bytes);
  const widget = doc.getPage(0).node.Annots().lookup(0, PDFDict);
  const stream = widget.lookup(PDFName.of('AP')).lookup(PDFName.of('N'));
  const font = stream.dict.lookup(PDFName.of('Resources')).lookup(PDFName.of('Font'));
  const face = font.lookup(PDFName.of('Helv'), PDFDict);
  const cmap = face.lookup(PDFName.of('ToUnicode'));
  return {
    base: face.lookup(PDFName.of('BaseFont')).decodeText(),
    toUnicode:
      cmap instanceof PDFRawStream
        ? new TextDecoder().decode(decodePDFRawStream(cmap).decode())
        : '',
  };
}
const signingTime = new Date('2026-10-01T09:30:00Z');
const RECT = { x: 72, y: 72, width: 220, height: 60 };

// First: the face, once loaded, is kept for later signatures.
it('signs with question marks when the face cannot be loaded', async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  const signed = await signPdf(await blankPdf(), polish, { page: 0, rect: RECT, signingTime });
  expect((await appearanceFont(signed)).base).toBe('Helvetica');
  const [result] = await verifySignatures(signed);
  expect(result.status).toBe('valid-unknown-identity');
});

it('writes a signer’s name Helvetica cannot write in a face that has its letters', async () => {
  const fonts = await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url));
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(fonts));
  const signed = await signPdf(await blankPdf(), polish, {
    page: 0,
    rect: RECT,
    location: 'Kraków',
    signingTime,
  });
  expect(fetch).toHaveBeenCalled();
  const { base, toUnicode } = await appearanceFont(signed);
  expect(base).toMatch(/NotoSans/);
  // Ł and Ż have glyphs of their own, not question marks.
  expect(toUnicode).toMatch(/<0141>/i);
  expect(toUnicode).toMatch(/<017B>/i);
  const [result] = await verifySignatures(signed);
  expect(result.status).toBe('valid-unknown-identity');
  expect(result.signer.name).toBe('Łukasz Żółć');
});

it('keeps Helvetica, with nothing to download, for a name it can write', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const signed = await signPdf(await blankPdf(), english, { page: 0, rect: RECT, signingTime });
  expect(fetch).not.toHaveBeenCalled();
  expect((await appearanceFont(signed)).base).toBe('Helvetica');
});
