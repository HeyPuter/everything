import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString, decodePDFRawStream } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  documentDetails,
  setDocumentDetails,
  synchronizeDocumentMetadata,
} from '../src/core/details.js';
import { PdfSession, rotatePage } from '../src/core/document.js';

const n = PDFName.of;
const packet = (properties, prefix = 'dc') => `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:${prefix}="http://purl.org/dc/elements/1.1/"
 xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"
 xmlns:custom="https://example.com/metadata/">${properties}</rdf:Description>
</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
const title = (value, prefix = 'dc') =>
  `<${prefix}:title><rdf:Alt><rdf:li xml:lang="x-default">${value}</rdf:li><rdf:li xml:lang="fr">Titre français</rdf:li></rdf:Alt></${prefix}:title>`;
async function fixture(xml, compressed = false) {
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]);
  doc.setModificationDate(new Date('2020-01-01T00:00:00Z'));
  const stream = doc.context[compressed ? 'flateStream' : 'stream'](new TextEncoder().encode(xml), {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  doc.catalog.set(n('Metadata'), doc.context.register(stream));
  return PDFDocument.load(await doc.save(), { updateMetadata: false });
}
const xmlOf = (doc) =>
  new TextDecoder().decode(decodePDFRawStream(doc.catalog.lookup(n('Metadata'))).decode());
async function readerMetadata(doc) {
  const task = pdfjs.getDocument({ data: await doc.save() });
  try {
    return await (await task.promise).getMetadata();
  } finally {
    await task.destroy();
  }
}

describe('XMP document details', () => {
  it.each([false, true])(
    'preserves referenced carriage returns through metadata and page edits (compressed: %s)',
    async (compressed) => {
      const value = 'First\r\nsecond\rthird & <fourth>';
      const encoded = 'First&#13;\nsecond&#xD;third &amp; &lt;fourth&gt;';
      const doc = await fixture(
        packet(
          `${title(encoded)}<custom:notes>${encoded}<![CDATA[ & raw <text> ]]></custom:notes>`,
        ),
        compressed,
      );
      expect(documentDetails(doc).title).toBe(value);
      setDocumentDetails(doc, { author: 'Ada' });
      expect(documentDetails(doc).title).toBe(value);
      const metadata = (await readerMetadata(doc)).metadata;
      expect(metadata.get('dc:title')).toBe(`${value}Titre français`);
      expect(metadata.get('custom:notes')).toBe(`${value} & raw <text>`);
      expect(xmlOf(doc)).toContain('<![CDATA[ & raw <text> ]]>');
      const session = new PdfSession(await doc.save());
      await session.change((working) => rotatePage(working, 0, 90));
      const saved = await PDFDocument.load(session.bytes, { updateMetadata: false });
      expect(saved.getTitle()).toBe(value);
      expect(documentDetails(saved).title).toBe(value);
    },
  );

  it('escapes carriage returns in new text without bypassing well-formedness checks', async () => {
    const doc = await fixture(packet(title('Old title')));
    const value = 'First\r\nsecond & <third>';
    setDocumentDetails(doc, { title: value });
    expect(documentDetails(doc).title).toBe(value);
    expect((await readerMetadata(doc)).metadata.get('dc:title')).toBe(`${value}Titre français`);
    const before = xmlOf(doc);
    expect(() => setDocumentDetails(doc, { title: 'Bad\r\u0000value' })).toThrow();
    expect(xmlOf(doc)).toBe(before);
    expect(doc.getTitle()).toBe(value);
  });

  it.each([
    ['implicit XML 1.0', '', 'Title\u0085with\u2028separators', 'Title\u0085with\u2028separators'],
    [
      'explicit XML 1.0',
      '<?xml version="1.0"?>',
      'Title\u0085with\u2028separators',
      'Title\u0085with\u2028separators',
    ],
    [
      'XML 1.0 carriage returns',
      '',
      'Title\r\nwith\r\u0085separators',
      'Title\nwith\n\u0085separators',
    ],
    [
      'XML 1.1 line endings',
      "<?xml version = '1.1'?>",
      'Title\r\u0085with\u2028separators',
      'Title\nwith\nseparators',
    ],
    [
      'character references',
      '',
      'Title&#x85;with&#x2028;separators',
      'Title\u0085with\u2028separators',
    ],
  ])(
    'preserves characters according to %s before and after unrelated edits',
    async (_, declaration, value, expected) => {
      const doc = await fixture(declaration + packet(title(value)));
      expect(documentDetails(doc).title).toBe(expected);
      setDocumentDetails(doc, { author: 'Ada' });
      expect(doc.getTitle()).toBe(expected);
      expect(documentDetails(doc).title).toBe(expected);
      expect((await readerMetadata(doc)).metadata.get('dc:title')).toBe(
        `${expected}Titre français`,
      );
    },
  );

  it('preserves XML 1.0 next-line and line-separator characters in attribute values', async () => {
    const value = 'alpha\u0085beta\u2028gamma';
    const xml = packet('').replace('xmlns:custom=', `pdf:Keywords="${value}" xmlns:custom=`);
    const doc = await fixture(xml);
    expect(documentDetails(doc).keywords).toBe(value);
    setDocumentDetails(doc, { author: 'Ada' });
    expect(doc.getKeywords()).toBe(value);
  });

  it('keeps compressed metadata compact after an edit', async () => {
    const doc = await fixture(
      packet(`<custom:notes>${'Repeated metadata text. '.repeat(20000)}</custom:notes>`),
      true,
    );
    const before = (await doc.save()).length;
    setDocumentDetails(doc, { title: 'Edited' });
    const after = await doc.save();
    expect(after.length).toBeLessThan(before + 2000);
    expect((await readerMetadata(doc)).metadata.get('dc:title')).toBe('Edited');
    expect(xmlOf(doc)).toContain('Repeated metadata text.');
  });

  it('reconciles a large custom metadata dictionary without losing entries', async () => {
    const entries = Array.from(
      { length: 6000 },
      (_, i) => `<pdfx:Field${i}>Old</pdfx:Field${i}>`,
    ).join('');
    const doc = await fixture(
      packet(`<xmp:MetadataDate>2019-01-01T00:00:00Z</xmp:MetadataDate>${entries}`).replace(
        'xmlns:custom=',
        'xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/" xmlns:custom=',
      ),
    );
    for (let i = 0; i < 6000; i++)
      doc.getInfoDict().set(n(`Field${i}`), PDFString.of(`Value ${i}`));
    setDocumentDetails(doc, { title: 'New title' });
    const xml = xmlOf(doc);
    expect(xml).not.toContain('>Old</');
    expect(xml).toContain('>Value 0</pdfx:Field0>');
    expect(xml).toContain('>Value 5999</pdfx:Field5999>');
  });

  it.each([
    ['2019', 'Info'],
    ['2021', 'XMP'],
  ])('retains precedence for custom Info entries and trapping flags (%s)', async (year, source) => {
    const doc = await fixture(
      packet(
        `<pdf:Trapped>False</pdf:Trapped><xmp:MetadataDate>${year}-01-01T00:00:00Z</xmp:MetadataDate><pdfx:Customↂ0020Key xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/">XMP</pdfx:Customↂ0020Key>`,
      ),
    );
    doc.getInfoDict().set(n('Custom Key'), PDFString.of('Info'));
    doc.getInfoDict().set(n('Trapped'), n('True'));
    setDocumentDetails(doc, { title: 'Changed title' });
    expect(doc.getInfoDict().lookup(n('Custom Key')).decodeText()).toBe(source);
    expect(xmlOf(doc)).toContain(`>${source}</pdfx:Customↂ0020Key>`);
    expect(doc.getInfoDict().lookup(n('Trapped')).decodeText()).toBe(
      source === 'Info' ? 'True' : 'False',
    );
    expect(xmlOf(doc)).toContain(
      `<pdf:Trapped>${source === 'Info' ? 'True' : 'False'}</pdf:Trapped>`,
    );
  });

  it('keeps authoritative XMP values through a content edit that advances ModDate', async () => {
    const doc = await fixture(
      packet(
        `${title('Current XMP title')}<xmp:MetadataDate>2021-01-01T00:00:00Z</xmp:MetadataDate>`,
      ),
    );
    doc.setTitle('Outdated Info title');
    const session = new PdfSession(await doc.save());
    await session.change((current) => rotatePage(current, 0));
    const saved = await PDFDocument.load(session.bytes, { updateMetadata: false });
    expect(documentDetails(saved).title).toBe('Current XMP title');
    expect(saved.getTitle()).toBe('Current XMP title');
    expect(saved.getPage(0).getRotation().angle).toBe(90);
    const { metadata } = await readerMetadata(saved);
    expect(new Date(metadata.get('xmp:modifydate')).getTime()).toBe(
      saved.getModificationDate().getTime(),
    );
  });

  it('handles attribute shorthand, qualified values, and duplicate descriptions without changing another RDF subject', async () => {
    const xml = packet(
      `<dc:title rdf:parseType="Resource"><rdf:value><rdf:Alt><rdf:li xml:lang="x-default">Qualified title</rdf:li></rdf:Alt></rdf:value><custom:source>keep</custom:source></dc:title>`,
    )
      .replace(
        'xmlns:custom=',
        'pdf:Keywords="old keywords" xmp:MetadataDate="2021-01-01T00:00:00Z" xmlns:custom=',
      )
      .replace(
        '</rdf:RDF>',
        '<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"><pdf:Keywords>old keywords</pdf:Keywords></rdf:Description><rdf:Description rdf:about="another-resource" xmlns:pdf="http://ns.adobe.com/pdf/1.3/"><pdf:Keywords>unrelated</pdf:Keywords></rdf:Description></rdf:RDF>',
      );
    const doc = await fixture(xml);
    expect(documentDetails(doc)).toMatchObject({
      title: 'Qualified title',
      keywords: 'old keywords',
    });
    setDocumentDetails(doc, { title: 'New qualified title', keywords: 'new keywords' });
    expect(documentDetails(doc)).toMatchObject({
      title: 'New qualified title',
      keywords: 'new keywords',
    });
    const saved = xmlOf(doc);
    expect(saved).not.toContain('old keywords');
    expect(saved).toContain('<custom:source>keep</custom:source>');
    expect(saved).toContain('<pdf:Keywords>unrelated</pdf:Keywords>');
  });

  it.each(['utf-16le', 'utf-16be', 'utf-32le', 'utf-32be'])(
    'reads %s packets and writes a consistent UTF-8 declaration',
    async (encoding) => {
      const xml = `<?xml version="1.0" encoding="${encoding.toUpperCase()}"?>${packet(title('Résumé 日本語'))}`;
      const little = encoding.endsWith('le');
      let bytes;
      if (encoding.startsWith('utf-16')) {
        bytes = Buffer.from(`\uFEFF${xml}`, 'utf16le');
        if (!little) bytes.swap16();
      } else {
        const points = Array.from(`\uFEFF${xml}`, (ch) => ch.codePointAt(0));
        bytes = Buffer.alloc(points.length * 4);
        points.forEach((point, index) =>
          little ? bytes.writeUInt32LE(point, index * 4) : bytes.writeUInt32BE(point, index * 4),
        );
      }
      const doc = await fixture(packet(''));
      doc.catalog.set(
        n('Metadata'),
        doc.context.register(doc.context.stream(bytes, { Type: 'Metadata', Subtype: 'XML' })),
      );
      expect(documentDetails(doc).title).toBe('Résumé 日本語');
      setDocumentDetails(doc, { title: 'Updated 日本語' });
      expect(xmlOf(doc)).not.toContain('encoding=');
      expect((await readerMetadata(doc)).metadata.get('dc:title')).toBe(
        'Updated 日本語Titre français',
      );
    },
  );

  it('can initialize an empty RDF packet and clear the default title', async () => {
    const doc = await fixture('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>');
    setDocumentDetails(doc, { title: 'Added title' });
    expect((await readerMetadata(doc)).metadata.get('dc:title')).toBe('Added title');
    setDocumentDetails(doc, { title: '' });
    expect(documentDetails(doc).title).toBe('');
    expect(doc.getTitle()).toBe('');
    expect((await readerMetadata(doc)).metadata.get('dc:title')).toBe('');
  });

  it('isolates component metadata and does not retain obsolete unshared streams', async () => {
    const doc = await fixture(packet(title('Document and page')));
    const original = doc.catalog.get(n('Metadata'));
    doc.getPage(0).node.set(n('Metadata'), original);
    setDocumentDetails(doc, { title: 'Document only' });
    expect(doc.getPage(0).node.get(n('Metadata'))).toBe(original);
    expect(
      new TextDecoder().decode(decodePDFRawStream(doc.context.lookup(original)).decode()),
    ).toContain('Document and page');
    const previous = doc.catalog.get(n('Metadata'));
    setDocumentDetails(doc, { title: 'Document again' });
    expect(doc.context.lookup(previous)).toBeUndefined();
    expect(doc.context.lookup(original)).toBeDefined();
  });

  it.each([
    ['broken XML', '<xmp>'],
    ['excessive markup', packet('<custom:item/>'.repeat(100001))],
    [
      'external entity',
      '<!DOCTYPE x [<!ENTITY secret SYSTEM "https://example.com/private">]><x>&secret;</x>',
    ],
    [
      'oversized expanded stream',
      packet(`<custom:large>${'x'.repeat(8 * 1024 * 1024)}</custom:large>`),
    ],
  ])('does not partially write details when %s cannot be preserved', async (_, xml) => {
    const doc = await fixture(xml, true);
    doc.setTitle('Original');
    const original = doc.catalog.get(n('Metadata'));
    expect(documentDetails(doc).title).toBe('Original');
    expect(() => setDocumentDetails(doc, { title: 'Changed', author: 'Ada' })).toThrow(
      'metadata could not be updated safely',
    );
    expect(doc.getTitle()).toBe('Original');
    expect(doc.getAuthor()).toBeUndefined();
    expect(doc.catalog.get(n('Metadata'))).toBe(original);
    const session = new PdfSession(await doc.save());
    await session.change((current) => rotatePage(current, 0));
    expect((await PDFDocument.load(session.bytes)).getPage(0).getRotation().angle).toBe(90);
  });

  it('does not mistake literal markup in CDATA or comments for DOM nodes', async () => {
    const doc = await fixture(
      packet(
        `${title('Title')}<custom:literal><![CDATA[${'<x/>'.repeat(100001)}]]></custom:literal><!--${'<x/>'.repeat(100001)}-->`,
      ),
      true,
    );
    setDocumentDetails(doc, { title: 'Edited' });
    expect(documentDetails(doc).title).toBe('Edited');
  });

  it('does not treat a custom pdfx:Title as the standard title', async () => {
    const doc = await fixture(
      packet(
        `${title('Current title')}<xmp:MetadataDate>2021-01-01T00:00:00Z</xmp:MetadataDate><pdfx:Title xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/">Unrelated</pdfx:Title>`,
      ),
    );
    doc.setTitle('Stale title');
    setDocumentDetails(doc, { title: 'Edited title' });
    expect(doc.getTitle()).toBe('Edited title');
    expect(xmlOf(doc)).toContain('>Unrelated</pdfx:Title>');
  });

  it('validates every input before writing either metadata store', async () => {
    const doc = await fixture(packet(title('Original')));
    const original = doc.catalog.get(n('Metadata'));
    expect(() => setDocumentDetails(doc, { title: 'Changed', author: 'x'.repeat(1001) })).toThrow(
      '1,000',
    );
    expect(() => setDocumentDetails(doc, { title: 'Bad\0title' })).toThrow(
      'metadata could not be updated safely',
    );
    expect(documentDetails(doc).title).toBe('Original');
    expect(doc.catalog.get(n('Metadata'))).toBe(original);
  });

  it('edits the details of a file whose Info title has characters XML cannot hold', async () => {
    const doc = await fixture(packet('<pdf:Producer>Writer</pdf:Producer>'));
    doc.setTitle('Report\0');
    setDocumentDetails(doc, { author: 'Ada' });
    expect(documentDetails(doc)).toMatchObject({ title: 'Report', author: 'Ada' });
    expect(xmlOf(doc)).toContain('>Report</rdf:li>');
    // Edits elsewhere keep both stores in step too.
    const other = await fixture(packet('<pdf:Producer>Writer</pdf:Producer>'));
    other.setTitle('Summary\u0001');
    expect(synchronizeDocumentMetadata(other)).toBe(true);
    expect(xmlOf(other)).toContain('>Summary</rdf:li>');
  });

  it('reads XMP-only values using namespace URIs and the first creator', async () => {
    const doc = await fixture(
      packet(
        `${title('XMP title', 'd')}
      <d:creator><rdf:Seq><rdf:li>Ada</rdf:li><rdf:li>Grace</rdf:li></rdf:Seq></d:creator>
      <d:description><rdf:Alt><rdf:li xml:lang="x-default">Summary</rdf:li></rdf:Alt></d:description>
      <pdf:Keywords>one, two; three</pdf:Keywords>`,
        'd',
      ),
    );
    expect(documentDetails(doc)).toMatchObject({
      title: 'XMP title',
      author: 'Ada',
      subject: 'Summary',
      keywords: 'one, two; three',
    });
  });

  it.each([
    ['2019-01-01', 'Info title'],
    ['2020-01-01', 'XMP title'],
    ['2021-01-01', 'XMP title'],
  ])('reconciles Info and XMP using MetadataDate %s', async (date, expected) => {
    const doc = await fixture(
      packet(`${title('XMP title')}<xmp:MetadataDate>${date}T00:00:00Z</xmp:MetadataDate>`),
    );
    doc.setTitle('Info title');
    expect(documentDetails(doc).title).toBe(expected);
  });

  it.each([false, true])(
    'synchronizes edits in both stores, preserving translations and custom data (compressed=%s)',
    async (compressed) => {
      const doc = await fixture(
        packet(`${title('Old title')}
      <dc:creator><rdf:Seq><rdf:li>Ada</rdf:li><rdf:li>Grace</rdf:li></rdf:Seq></dc:creator>
      <dc:subject><rdf:Bag><rdf:li>separate keyword</rdf:li></rdf:Bag></dc:subject>
      <custom:record rdf:parseType="Resource"><custom:id>abc-123</custom:id></custom:record>
      <xmp:MetadataDate>2021-01-01T00:00:00Z</xmp:MetadataDate>`),
        compressed,
      );
      doc.setAuthor('Stale author');
      setDocumentDetails(doc, {
        title: 'New <title> & 日本語',
        author: 'Katherine',
        subject: 'New summary',
        keywords: 'x, y; z',
      });
      const { info, metadata } = await readerMetadata(doc);
      expect(info).toMatchObject({
        Title: 'New <title> & 日本語',
        Author: 'Katherine',
        Subject: 'New summary',
        Keywords: 'x, y; z',
      });
      // PDF.js concatenates language alternatives; both the new default and translation survive.
      expect(metadata.get('dc:title')).toBe('New <title> & 日本語Titre français');
      expect(metadata.get('dc:creator')).toEqual(['Katherine', 'Grace']);
      expect(metadata.get('dc:description')).toBe('New summary');
      expect(metadata.get('pdf:keywords')).toBe('x, y; z');
      expect(metadata.get('dc:subject')).toEqual(['separate keyword']);
      const xml = xmlOf(doc);
      expect(xml).toContain('Titre français');
      expect(xml).toContain('<custom:id>abc-123</custom:id>');
      expect(new Date(metadata.get('xmp:metadatadate')).getTime()).toBe(
        doc.getModificationDate().getTime(),
      );
      expect(metadata.get('xmp:modifydate')).toBe(metadata.get('xmp:metadatadate'));
      expect(
        setDocumentDetails(doc, {
          title: 'New <title> & 日本語',
          author: 'Katherine',
          subject: 'New summary',
          keywords: 'x, y; z',
        }),
      ).toBe(false);
    },
  );

  it('reconciles unchanged fields before advancing the metadata timestamp', async () => {
    const doc = await fixture(
      packet(`${title('Outdated title')}<xmp:MetadataDate>2019-01-01T00:00:00Z</xmp:MetadataDate>`),
    );
    doc.setTitle('Current Info title');
    setDocumentDetails(doc, { author: 'Ada' });
    const { info, metadata } = await readerMetadata(doc);
    expect(info.Title).toBe('Current Info title');
    expect(metadata.get('dc:title')).toBe(`${info.Title}Titre français`);
    expect(documentDetails(doc).title).toBe(info.Title);
  });

  it('restores both metadata stores on undo and keeps unchanged saves out of history', async () => {
    const doc = await fixture(
      packet(
        `${title('Original XMP title')}<xmp:MetadataDate>2021-01-01T00:00:00Z</xmp:MetadataDate>`,
      ),
    );
    doc.setTitle('Old Info title');
    const session = new PdfSession(await doc.save());
    expect(
      await session.change((current) =>
        setDocumentDetails(current, { title: 'Original XMP title' }),
      ),
    ).toBe(false);
    expect(session.past).toHaveLength(0);
    await session.change((current) => setDocumentDetails(current, { title: 'Final title' }));
    expect(
      (
        await readerMetadata(await PDFDocument.load(session.bytes, { updateMetadata: false }))
      ).metadata.get('dc:title'),
    ).toBe('Final titleTitre français');
    session.undo();
    const original = await PDFDocument.load(session.bytes, { updateMetadata: false });
    expect(original.getTitle()).toBe('Old Info title');
    expect(documentDetails(original).title).toBe('Original XMP title');
  });
});
