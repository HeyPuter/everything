import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  StandardFonts,
  decodePDFRawStream,
  rgb,
} from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import {
  convertToPdfA,
  pdfaIdentification,
  pdfaSaveOptions,
  preflightPdfA,
} from '../src/core/pdfa.js';
import { readCff, standardFontKey } from '../src/core/pdfa-fonts.js';
import { srgbProfile } from '../src/core/pdfa-icc.js';
import { PdfSession } from '../src/core/document.js';

const assets = new URL('../node_modules/pdfjs-dist/', import.meta.url);
const loadAsset = async (path) => new Uint8Array(readFileSync(new URL(path, assets)));
const standardFontDataUrl = new URL('standard_fonts/', assets).pathname;
const name = PDFName.of;
afterEach(() => vi.restoreAllMocks());
const ids = (report) => report.issues.map((issue) => issue.id);
const errors = (issues) => issues.filter((issue) => issue.severity === 'error');

/** A document that breaks several PDF/A rules at once, as pdf-lib writes them by default. */
async function violatingPdf({ transparent = true, title = 'Quarterly report' } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setAuthor('Ada Lovelace');
  const page = doc.addPage([400, 300]);
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  const times = await doc.embedFont(StandardFonts.TimesRomanBold);
  const courier = await doc.embedFont(StandardFonts.Courier);
  page.drawText('Hello PDF/A', {
    x: 40,
    y: 240,
    size: 24,
    font: helvetica,
    color: rgb(0.1, 0.2, 0.6),
  });
  page.drawText('Times bold – café', { x: 40, y: 200, size: 18, font: times });
  page.drawText('Courier 12345', { x: 40, y: 170, size: 14, font: courier });
  page.drawRectangle({
    x: 40,
    y: 40,
    width: 120,
    height: 80,
    color: rgb(0.9, 0.3, 0.2),
    ...(transparent && { opacity: 0.5 }),
  });
  doc.addJavaScript('greeting', 'app.alert("hi")');
  const context = doc.context;
  const link = context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [40, 230, 200, 270],
    Border: [0, 0, 0],
    A: {
      Type: 'Action',
      S: 'JavaScript',
      JS: PDFHexString.fromText('app.alert(1)'),
    },
  });
  const note = context.obj({
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: [40, 160, 200, 190],
    QuadPoints: [40, 190, 200, 190, 40, 160, 200, 160],
    C: [1, 1, 0],
    F: 2 | 4, // Hidden
  });
  const visible = context.obj({
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: [40, 195, 200, 220],
    QuadPoints: [40, 220, 200, 220, 40, 195, 200, 195],
    C: [1, 1, 0],
  });
  page.node.set(
    name('Annots'),
    context.obj([context.register(link), context.register(note), context.register(visible)]),
  );
  return doc.save({ useObjectStreams: false });
}

async function render(bytes) {
  const task = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport }).promise;
    const text = (await page.getTextContent()).items.map((item) => item.str).join(' ');
    return {
      pixels: context.getImageData(0, 0, canvas.width, canvas.height).data,
      text,
    };
  } finally {
    await task.destroy();
  }
}
function differingPixels(a, b) {
  let count = 0;
  for (let i = 0; i < a.length; i += 4)
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24)
      count++;
  return count;
}
function metadataText(doc) {
  const stream = doc.catalog.lookup(name('Metadata'));
  expect(stream.dict.has(name('Filter'))).toBe(false);
  const bytes =
    stream instanceof PDFRawStream
      ? decodePDFRawStream(stream).decode()
      : stream.getUnencodedContents();
  return new TextDecoder().decode(bytes);
}

describe('PDF/A preflight', () => {
  it('lists the violations of an ordinary pdf-lib document', async () => {
    const doc = await PDFDocument.load(await violatingPdf());
    const report = preflightPdfA(doc, { part: 2, conformance: 'b' });
    expect(report.compliant).toBe(false);
    expect(ids(report)).toEqual(
      expect.arrayContaining([
        'xmp-missing',
        'pdfa-id',
        'file-id',
        'device-rgb',
        'font-not-embedded',
        'javascript',
        'annotation-flags',
        'annotation-ap-missing',
      ]),
    );
    // Transparency is fine from PDF/A-2 on.
    expect(ids(report)).not.toContain('transparency');
    const fonts = report.issues.filter((issue) => issue.id === 'font-not-embedded');
    expect(fonts.map((issue) => issue.message).join(' ')).toMatch(
      /Helvetica.*Times-Bold.*Courier/s,
    );
    expect(
      fonts.every((issue) => issue.fixable && issue.rule === '6.2.11.4.1' && issue.page === 1),
    ).toBe(true);
    expect(report.issues.find((issue) => issue.id === 'javascript')).toMatchObject({
      rule: '6.5.1',
      fixable: true,
    });

    const part1 = preflightPdfA(doc, { part: 1, conformance: 'b' });
    expect(part1.issues.find((issue) => issue.id === 'transparency')).toMatchObject({
      rule: '6.4',
      severity: 'error',
      fixable: false,
      page: 1,
    });
    expect(part1.issues.find((issue) => issue.id === 'font-not-embedded').rule).toBe('6.3.4');
    // Object streams are a property of the saved bytes.
    const compact = await doc.save();
    expect(ids(preflightPdfA(doc, { part: 1, conformance: 'b', bytes: compact }))).toContain(
      'object-streams',
    );
    expect(() => preflightPdfA(doc, { part: 1, conformance: 'u' })).toThrow();
  });

  it('checks Unicode mappings and structure for the u and a levels', async () => {
    const doc = await PDFDocument.load(await violatingPdf());
    const a = preflightPdfA(doc, { part: 2, conformance: 'a' });
    expect(ids(a)).toEqual(expect.arrayContaining(['untagged', 'marked']));
    expect(ids(preflightPdfA(doc, { part: 2, conformance: 'b' }))).not.toContain('untagged');
  });
});

describe('Save as PDF/A', () => {
  it('converts to PDF/A-2b, keeps the page looking the same, and stays compliant when saved', async () => {
    const original = await violatingPdf();
    const doc = await PDFDocument.load(original);
    const report = await convertToPdfA(doc, {
      part: 2,
      conformance: 'b',
      loadAsset,
    });
    expect(errors(report.remaining)).toEqual([]);
    expect(report.compliant).toBe(true);
    const messages = report.fixed.map((entry) => entry.message).join('\n');
    expect(messages).toMatch(/Embedded LiberationSans in place of Helvetica/);
    expect(messages).toMatch(/Embedded ChromSerifOTF-Bold in place of Times-Bold/);
    expect(messages).toMatch(/Embedded ChromFixedOTF in place of Courier/);
    expect(messages).toMatch(/sRGB output intent/);
    expect(messages).toMatch(/JavaScript/);
    expect(messages).toMatch(/Removed hidden annotations/);

    const saved = await doc.save(pdfaSaveOptions(2));
    const reopened = await PDFDocument.load(saved, { updateMetadata: false });
    const again = preflightPdfA(reopened, {
      part: 2,
      conformance: 'b',
      bytes: saved,
    });
    expect(errors(again.issues)).toEqual([]);
    expect(pdfaIdentification(reopened)).toEqual({ part: 2, conformance: 'b' });

    // XMP carries the identification and matches the document information dictionary.
    const xmp = metadataText(reopened);
    expect(xmp).toMatch(/<pdfaid:part>2<\/pdfaid:part>/);
    expect(xmp).toMatch(/<pdfaid:conformance>B<\/pdfaid:conformance>/);
    expect(xmp).toContain('Quarterly report');
    expect(xmp).toContain('Ada Lovelace');
    expect(xmp).toMatch(/^<\?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"\?>/);
    expect(reopened.getTitle()).toBe('Quarterly report');
    const modified = xmp.match(/<xmp:ModifyDate[^>]*>([^<]+)</)[1];
    expect(Math.abs(new Date(modified) - reopened.getModificationDate())).toBeLessThan(1000);

    // Output intent with an sRGB ICC profile, a trailer ID, and every font embedded.
    const intent = reopened.catalog.lookup(name('OutputIntents'), PDFArray).lookup(0, PDFDict);
    expect(intent.get(name('S'))).toBe(name('GTS_PDFA1'));
    expect(intent.lookup(name('DestOutputProfile'), PDFStream).dict.get(name('N')).asNumber()).toBe(
      3,
    );
    expect(reopened.context.trailerInfo.ID).toBeDefined();
    const fonts = reopened.getPage(0).node.Resources().lookup(name('Font'), PDFDict);
    const times = fonts
      .values()
      .map((ref) => reopened.context.lookup(ref))
      .find((font) => font.get(name('BaseFont')) === name('ChromSerifOTF-Bold'));
    // Times-Bold metrics: A is 722 units wide.
    const first = times.lookup(name('FirstChar'), PDFNumber).asNumber();
    expect(
      times
        .lookup(name('Widths'), PDFArray)
        .lookup(65 - first, PDFNumber)
        .asNumber(),
    ).toBe(722);

    // Still opens and renders in PDF.js, essentially as before (same substitute faces).
    const [before, after] = [await render(original), await render(saved)];
    expect(after.text).toContain('Hello PDF/A');
    // PDF.js splits monospaced runs at spaces; it extracts the same text before and after.
    expect(after.text).toBe(before.text);
    expect(differingPixels(before.pixels, after.pixels)).toBeLessThan(
      before.pixels.length / 4 / 200,
    );
  });

  it('converts to PDF/A-1b when nothing transparent is left, and reports transparency it cannot remove', async () => {
    const doc = await PDFDocument.load(await violatingPdf({ transparent: false }));
    const report = await convertToPdfA(doc, {
      part: 1,
      conformance: 'b',
      loadAsset,
    });
    expect(errors(report.remaining)).toEqual([]);
    const saved = await doc.save(pdfaSaveOptions(1));
    expect(new TextDecoder('latin1').decode(saved)).not.toMatch(/\/Type\s*\/(ObjStm|XRef)/);
    const reopened = await PDFDocument.load(saved, { updateMetadata: false });
    expect(
      errors(preflightPdfA(reopened, { part: 1, conformance: 'b', bytes: saved }).issues),
    ).toEqual([]);
    expect(metadataText(reopened)).toMatch(/<pdfaid:part>1<\/pdfaid:part>/);
    expect((await render(saved)).text).toContain('Hello PDF/A');

    const transparent = await PDFDocument.load(await violatingPdf());
    const partial = await convertToPdfA(transparent, {
      part: 1,
      conformance: 'b',
      loadAsset,
    });
    expect(partial.compliant).toBe(false);
    expect(errors(partial.remaining).map((issue) => issue.id)).toEqual(['transparency']);
  });

  it('runs as an editor operation and survives the session’s own save and metadata sync', async () => {
    const session = new PdfSession(await violatingPdf());
    let report;
    await session.change(async (doc) => {
      report = await convertToPdfA(doc, {
        part: 3,
        conformance: 'b',
        loadAsset,
      });
    });
    expect(report.compliant).toBe(true);
    const doc = await PDFDocument.load(session.bytes, {
      updateMetadata: false,
    });
    expect(errors(preflightPdfA(doc, { part: 3, conformance: 'b' }).issues)).toEqual([]);
    // A later ordinary edit keeps the identification and the Info/XMP agreement.
    await session.change((d) => {
      d.getPage(0).drawRectangle({
        x: 10,
        y: 10,
        width: 5,
        height: 5,
        color: rgb(0, 0, 0),
      });
    });
    const edited = await PDFDocument.load(session.bytes, {
      updateMetadata: false,
    });
    const issues = preflightPdfA(edited, { part: 3, conformance: 'b' }).issues;
    expect(pdfaIdentification(edited)).toEqual({ part: 3, conformance: 'b' });
    expect(issues).toEqual([]);
  });

  it('regenerates form appearances, drops NeedAppearances and XFA, and embeds the form font', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const form = doc.getForm();
    const field = form.createTextField('name');
    field.setText('Grace');
    field.addToPage(page, { x: 20, y: 120, width: 200, height: 24 });
    form.acroForm.dict.set(name('NeedAppearances'), doc.context.obj(true));
    form.acroForm.dict.set(name('XFA'), doc.context.obj([]));
    const bytes = await doc.save({ updateFieldAppearances: false });
    const loaded = await PDFDocument.load(bytes);
    expect(ids(preflightPdfA(loaded, { part: 2, conformance: 'b' }))).toEqual(
      expect.arrayContaining(['need-appearances', 'xfa']),
    );
    const report = await convertToPdfA(loaded, {
      part: 2,
      conformance: 'b',
      loadAsset,
    });
    expect(errors(report.remaining)).toEqual([]);
    const saved = await loaded.save(pdfaSaveOptions(2));
    const reopened = await PDFDocument.load(saved);
    const acro = reopened.catalog.lookup(name('AcroForm'), PDFDict);
    expect(acro.has(name('NeedAppearances'))).toBe(false);
    expect(acro.has(name('XFA'))).toBe(false);
    expect(errors(preflightPdfA(reopened, { part: 2, conformance: 'b' }).issues)).toEqual([]);
    expect((await render(saved)).pixels.some((v, i) => i % 4 === 0 && v < 100)).toBe(true);
  });

  it('draws form fields in Polish, Cyrillic, or Korean with a bundled face', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url) =>
        new Response(
          await readFile(
            new URL(`../public/fonts/${String(url).split('/').pop()}`, import.meta.url),
          ),
        ),
    );
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const form = doc.getForm();
    const values = { city: 'Łódź', name: 'Иван', greeting: '안녕하세요' };
    Object.entries(values).forEach(([key, value], i) => {
      const field = form.createTextField(key);
      field.addToPage(page, { x: 20, y: 40 + 60 * i, width: 200, height: 30 });
      field.acroField.setValue(PDFHexString.fromText(value));
    });
    form.acroForm.dict.set(name('NeedAppearances'), doc.context.obj(true));
    const loaded = await PDFDocument.load(await doc.save({ updateFieldAppearances: false }));
    const report = await convertToPdfA(loaded, { part: 2, conformance: 'b', loadAsset });
    expect(errors(report.remaining)).toEqual([]);
    const saved = await loaded.save(pdfaSaveOptions(2));
    const reopened = await PDFDocument.load(saved);
    expect(reopened.catalog.lookup(name('AcroForm'), PDFDict).has(name('NeedAppearances'))).toBe(
      false,
    );
    expect(errors(preflightPdfA(reopened, { part: 2, conformance: 'b' }).issues)).toEqual([]);
    // Each field is drawn with the bundled face its text needs.
    const faces = Object.keys(values).map((key) => {
      const widget = reopened.getForm().getTextField(key).acroField.getWidgets()[0];
      const stream = reopened.context.lookup(widget.getNormalAppearance());
      const fonts = stream.dict.lookup(name('Resources')).lookup(name('Font'));
      return fonts
        .values()
        .map((ref) => reopened.context.lookup(ref).get(name('BaseFont')).decodeText());
    });
    expect(faces).toEqual([
      [expect.stringMatching(/^NotoSans-/)],
      [expect.stringMatching(/^NotoSans-/)],
      [expect.stringMatching(/^NotoSansKR-/)],
    ]);
  });

  it('removes embedded files for PDF/A-2 and describes them for PDF/A-3', async () => {
    const make = async () => {
      const doc = await PDFDocument.create();
      doc.addPage();
      await doc.attach(new TextEncoder().encode('a,b\n1,2\n'), 'data.csv', {
        mimeType: 'text/csv',
      });
      return PDFDocument.load(await doc.save());
    };
    const two = await make();
    expect(ids(preflightPdfA(two, { part: 2, conformance: 'b' }))).toContain('embedded-file');
    const twoReport = await convertToPdfA(two, {
      part: 2,
      conformance: 'b',
      loadAsset,
    });
    expect(errors(twoReport.remaining)).toEqual([]);
    expect(twoReport.fixed.map((f) => f.message).join()).toMatch(/Removed embedded files/);

    const three = await make();
    const threeReport = await convertToPdfA(three, {
      part: 3,
      conformance: 'b',
      loadAsset,
    });
    expect(errors(threeReport.remaining)).toEqual([]);
    const af = three.catalog.lookup(name('AF'), PDFArray);
    const spec = af.lookup(0, PDFDict);
    expect(spec.get(name('AFRelationship'))).toBeInstanceOf(PDFName);
    expect(spec.has(name('UF'))).toBe(true);
  });

  it('re-encodes LZW streams with Flate', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const content = new TextEncoder().encode('0 0 1 rg 20 20 100 100 re f');
    const stream = doc.context.stream(lzw(content), { Filter: 'LZWDecode' });
    page.node.set(name('Contents'), doc.context.register(stream));
    const loaded = await PDFDocument.load(await doc.save());
    expect(ids(preflightPdfA(loaded, { part: 2, conformance: 'b' }))).toContain('lzw');
    const report = await convertToPdfA(loaded, {
      part: 2,
      conformance: 'b',
      loadAsset,
    });
    expect(errors(report.remaining)).toEqual([]);
    const contents = loaded.getPage(0).node.lookup(name('Contents'), PDFStream);
    expect(contents.dict.get(name('Filter'))).toBe(name('FlateDecode'));
    const { pixels } = await render(await loaded.save());
    // The blue square is still drawn.
    const centre = (100 * 200 + 70) * 4;
    expect([pixels[centre], pixels[centre + 1], pixels[centre + 2]]).toEqual([0, 0, 255]);
  });
});

describe('PDF/A fonts and protection', () => {
  it('embeds Symbol and ZapfDingbats substitutes and reports what Unicode levels still need', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 120]);
    const symbol = await doc.embedFont(StandardFonts.Symbol);
    const dingbats = await doc.embedFont(StandardFonts.ZapfDingbats);
    page.drawText('αβγ', { x: 20, y: 70, size: 24, font: symbol });
    page.drawText('✓✔', { x: 20, y: 30, size: 24, font: dingbats });
    const original = await doc.save();

    const b = await PDFDocument.load(original);
    const report = await convertToPdfA(b, { part: 2, conformance: 'b', loadAsset });
    expect(errors(report.remaining)).toEqual([]);
    const saved = await b.save(pdfaSaveOptions(2));
    const [before, after] = [await render(original), await render(saved)];
    expect(differingPixels(before.pixels, after.pixels)).toBeLessThan(
      before.pixels.length / 4 / 200,
    );

    // Dingbat glyph names (a1, a20, …) have no standard Unicode values: level U needs ToUnicode.
    const u = await PDFDocument.load(original);
    const unicode = await convertToPdfA(u, { part: 2, conformance: 'u', loadAsset });
    expect(errors(unicode.remaining).map((issue) => issue.id)).toEqual(['font-to-unicode']);
    expect(errors(unicode.remaining)[0].message).toContain('ChromDingbatsOTF');
  });

  it('reports encryption as something only removing the password can fix', async () => {
    const bytes = readFileSync(new URL('./fixtures/security/aes-128.pdf', import.meta.url));
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const issue = preflightPdfA(doc, { part: 2, conformance: 'b' }).issues.find(
      (entry) => entry.id === 'encrypted',
    );
    expect(issue).toMatchObject({ rule: '6.1.3', severity: 'error', fixable: false });
  });
});

describe('PDF/A building blocks', () => {
  it('generates a well-formed ICC v2 sRGB display profile', () => {
    const profile = srgbProfile();
    const view = new DataView(profile.buffer);
    expect(view.getUint32(0)).toBe(profile.length);
    expect(profile[8]).toBe(2);
    expect(String.fromCharCode(...profile.subarray(12, 24))).toBe('mntrRGB XYZ ');
    expect(String.fromCharCode(...profile.subarray(36, 40))).toBe('acsp');
    expect([view.getUint32(68), view.getUint32(72), view.getUint32(76)]).toEqual([
      0xf6d6, 0x10000, 0xd32d,
    ]);
    const tags = view.getUint32(128);
    const signatures = [];
    for (let i = 0; i < tags; i++) {
      const at = 132 + i * 12;
      signatures.push(String.fromCharCode(...profile.subarray(at, at + 4)));
      const offset = view.getUint32(at + 4),
        size = view.getUint32(at + 8);
      expect(offset % 4).toBe(0);
      expect(offset + size).toBeLessThanOrEqual(profile.length);
    }
    expect(signatures).toEqual([
      'desc',
      'cprt',
      'wtpt',
      'rXYZ',
      'gXYZ',
      'bXYZ',
      'rTRC',
      'gTRC',
      'bTRC',
    ]);
  });

  it('recognizes the standard 14 names and reads the substitute CFF faces', async () => {
    expect(standardFontKey('Helvetica-BoldOblique')).toEqual({
      family: 'sans',
      style: 'boldItalic',
    });
    expect(standardFontKey('Arial,Bold')).toEqual({
      family: 'sans',
      style: 'bold',
    });
    expect(standardFontKey('Times-Roman')).toEqual({
      family: 'serif',
      style: 'regular',
    });
    expect(standardFontKey('Garamond')).toBeNull();
    const courier = readCff(await loadAsset('standard_fonts/FoxitFixed.pfb'));
    expect(courier.widths.get('A')).toBe(600);
    const times = readCff(await loadAsset('standard_fonts/FoxitSerif.pfb'));
    expect([times.widths.get('space'), times.widths.get('a'), times.widths.get('W')]).toEqual([
      250, 444, 944,
    ]);
  });

  it('gives the save options each part needs', () => {
    expect(pdfaSaveOptions(1)).toMatchObject({
      useObjectStreams: false,
      updateFieldAppearances: false,
    });
    expect(pdfaSaveOptions(2).useObjectStreams).toBe(true);
  });
});

/** A minimal LZW encoder (9-bit codes, restarting before the code width grows). */
function lzw(bytes) {
  const out = [];
  let buffer = 0,
    bits = 0;
  const write = (code) => {
    buffer = (buffer << 9) | code;
    bits += 9;
    while (bits >= 8) {
      out.push((buffer >> (bits - 8)) & 255);
      bits -= 8;
    }
  };
  write(256);
  bytes.forEach((byte, i) => {
    if (i && i % 200 === 0) write(256);
    write(byte);
  });
  write(257);
  if (bits) out.push((buffer << (8 - bits)) & 255);
  return new Uint8Array(out);
}
