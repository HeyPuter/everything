import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8, zipSync, strToU8, deflateSync } from 'fflate';
import { convertHanword } from '../src/lib/hwp/index.js';
import { parseHwp5 } from '../src/lib/hwp/hwp5.js';
import { parseHwpx, hwpxArchive } from '../src/lib/hwp/hwpx.js';
import { compoundFile, records, budget, inflate, LIMITS } from '../src/lib/hwp/binary.js';
import { modelToDocx } from '../src/lib/hwp/docx.js';
import { hwp, hwpx, paragraph, concat, record, u16, u32, utf16, controlText, string, cfb } from './helpers/hwp-fixtures.js';

beforeAll(() => { globalThis.DOMParser = new JSDOM('').window.DOMParser; });
const xmlPart = (bytes, name = 'word/document.xml') => strFromU8(unzipSync(bytes)[name]);
const docXml = (model) => xmlPart(modelToDocx(model));
const plain = (model) => model.sections.flatMap((s) => s.blocks.flatMap((p) => p.runs.map((r) => r.text || ''))).join('');
const file = (bytes, name = '문서.hwp') => new File([bytes], name);

describe('Hanword header and footer page ranges', () => {
  function withHeaders(format, oddOnly) {
    if (format === 'HWPX') return parseHwpx(hwpx({ sections: [`<hp:p><hp:run><hp:ctrl><hp:header applyPageType="${oddOnly ? 'ODD' : 'BOTH'}"><hp:subList><hp:p><hp:run><hp:t>Header</hp:t></hp:run></hp:p></hp:subList></hp:header>${oddOnly ? '' : '<hp:footer applyPageType="EVEN"><hp:subList><hp:p><hp:run><hp:t>Footer</hp:t></hp:run></hp:p></hp:subList></hp:footer>'}</hp:ctrl><hp:t>Body</hp:t></hp:run></hp:p>`] }));
    const header = (id, apply, text) => concat(record(71, 1, concat(Buffer.from(id).reverse(), u32(apply))), record(72, 2, concat(u32(1), u32(0))), paragraph(text, { level: 2 }));
    return parseHwp5(hwp({ sections: [paragraph('Body', { children: [header('head', oddOnly ? 2 : 0, 'Header'), ...(oddOnly ? [] : [header('foot', 1, 'Footer')])] })] }));
  }
  it.each(['HWP', 'HWPX'])('keeps both-page headers on even pages when %s has an even-only footer', (format) => {
    const parts = unzipSync(modelToDocx(withHeaders(format, false)));
    const doc = new DOMParser().parseFromString(strFromU8(parts['word/document.xml']), 'application/xml');
    const headers = [...doc.getElementsByTagNameNS('*', 'headerReference')];
    expect(headers.map((r) => r.getAttribute('w:type'))).toEqual(['default', 'even']);
    expect(new Set(headers.map((r) => r.getAttribute('r:id'))).size).toBe(1);
    expect(strFromU8(parts['word/settings.xml'])).toContain('<w:evenAndOddHeaders/>');
  });
  it.each(['HWP', 'HWPX'])('keeps odd-only %s headers off even pages without an explicit even header', (format) => {
    const parts = unzipSync(modelToDocx(withHeaders(format, true)));
    expect(strFromU8(parts['word/settings.xml'])).toContain('<w:evenAndOddHeaders/>');
    const doc = new DOMParser().parseFromString(strFromU8(parts['word/document.xml']), 'application/xml');
    expect([...doc.getElementsByTagNameNS('*', 'headerReference')].map((r) => r.getAttribute('w:type'))).toEqual(['default']);
  });
});

describe('HWP 5 binary documents', () => {
  it('keeps an emoji whole when a formatting change falls between its two halves', () => {
    const model = parseHwp5(hwp({ sections: [paragraph(utf16('a😀b\r'), { changes: [[0, 0], [2, 1], [3, 0]] })] }));
    expect(model.sections[0].blocks[0].runs.map((r) => r.text)).toEqual(['a😀b']);
    expect(xmlPart(modelToDocx(model))).toContain('a😀b');
  });
  it.each([true, false])('reads Korean Unicode and character formatting (compressed=%s)', async (compressed) => {
    const source = hwp({ compressed, sections: [paragraph('한글 & <English> 😀', { char: 1 })] });
    const result = await convertHanword(file(source));
    expect(result.format).toBe('HWP');
    expect(result.blob.type).toContain('wordprocessingml.document');
    const document = xmlPart(new Uint8Array(await result.blob.arrayBuffer()));
    expect(document).toContain('한글 &amp; &lt;English&gt; 😀');
    expect(document).toContain('w:eastAsia="맑은 고딕"');
    expect(document).toContain('<w:b w:val="1"/>');
    expect(document).toContain('<w:color w:val="ff0000"/>');
    expect(document).toContain('<w:sz w:val="24"/>');
  });

  it('reads mini streams, regular streams, and 4096-byte CFB sectors', () => {
    const long = '긴 문장 '.repeat(1200);
    const source = hwp({ compressed: false, sectorSize: 4096, sections: [paragraph(long, { extended: true })] });
    expect(plain(parseHwp5(source))).toBe(long);
    expect(compoundFile(source).read('FileHeader').length).toBe(256);
  });

  it('keeps run offsets across eight-unit controls and preserves tabs, line breaks, and spaces', () => {
    const p = paragraph(concat(utf16('앞'), controlText(9, '\0\0\0\0'), utf16('뒤\n\u001e\u001f\r')), { changes: [[0, 0], [9, 1]] });
    const model = parseHwp5(hwp({ sections: [p] }));
    expect(model.sections[0].blocks[0].runs).toEqual([{ kind: 'text', text: '앞\t', char: 0 }, { kind: 'text', text: '뒤\n\u00a0\u2007', char: 1 }]);
    expect(docXml(model)).toContain('<w:tab/>');
    expect(docXml(model)).toContain('<w:br/>');
  });

  it('sorts sections numerically and imports their paper dimensions', () => {
    const page = concat(...[59528, 84188, 5000, 6000, 7000, 8000, 1000, 2000, 0, 0].map(u32));
    const section = paragraph(concat(controlText(2, 'secd'), utf16('첫째\r')), { children: [record(71, 1, Buffer.from('secd').reverse()), record(73, 2, page)] });
    const model = parseHwp5(hwp({ sections: [section, ...Array.from({ length: 10 }, (_, i) => paragraph(String(i + 1)))] }));
    expect(plain(model)).toBe('첫째12345678910');
    expect(model.sections[0].page).toMatchObject({ width: 59528, height: 84188, top: 8000, bottom: 10000 });
    expect(docXml(model)).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
  });

  it('converts actual Hanword tables, captions, nested tables, fonts, and images', async () => {
    const bytes = readFileSync(new URL('./fixtures/hwp/basicsReport.hwp', import.meta.url));
    const result = await convertHanword(file(bytes));
    const parts = unzipSync(new Uint8Array(await result.blob.arrayBuffer())), document = strFromU8(parts['word/document.xml']);
    expect(document).toContain('리포트의 제목');
    const parsedDocument = new DOMParser().parseFromString(document, 'application/xml');
    expect(parsedDocument.documentElement.textContent).toContain('[표 캡션 1]');
    expect((document.match(/<w:tbl>/g) || []).length).toBeGreaterThan(2);
    expect(Object.keys(parts).some((n) => n.startsWith('word/media/'))).toBe(true);
    expect(parts['word/numbering.xml']).toBeDefined();
    expect(result.warnings).not.toContain('Table captions are placed after their table.');
    for (const [name, data] of Object.entries(parts)) if (name.endsWith('.xml') || name.endsWith('.rels')) {
      const parsed = new DOMParser().parseFromString(strFromU8(data), 'application/xml');
      expect(parsed.querySelector('parsererror'), name).toBeNull();
      if (name.endsWith('.rels')) for (const rel of parsed.querySelectorAll('Relationship')) if (rel.getAttribute('TargetMode') !== 'External') {
        const owner = name === '_rels/.rels' ? '' : name.split('/_rels/')[0] + '/';
        expect(parts[owner + rel.getAttribute('Target')], `${name}: ${rel.getAttribute('Target')}`).toBeDefined();
      }
    }
  });

  it('writes horizontal and vertical merged cells without duplicating their content', () => {
    const cell = (col, row, colSpan, rowSpan, text) => concat(record(72, 2, concat(u32(1), u32(32), u16(col), u16(row), u16(colSpan), u16(rowSpan), u32(7200 * colSpan), u32(3600), new Uint8Array(8), u16(0))), paragraph(text, { level: 2 }));
    const table = concat(record(71, 1, concat(Buffer.from('tbl ').reverse(), u32(1), new Uint8Array(16))), record(77, 2, concat(u32(4), u16(3), u16(2), new Uint8Array(10), u16(2), u16(1), u16(1), u16(0))), cell(0, 0, 2, 1, '가로 병합'), cell(0, 1, 1, 2, '세로 병합'), cell(1, 1, 1, 1, '나'), cell(1, 2, 1, 1, '다'));
    const model = parseHwp5(hwp({ sections: [paragraph(concat(controlText(11, 'tbl '), utf16('\r')), { children: [table] })] }));
    const document = docXml(model);
    expect(document).toContain('<w:gridSpan w:val="2"/>');
    expect(document).toContain('<w:vMerge w:val="restart"/>');
    expect(document).toContain('<w:vMerge w:val="continue"/>');
    expect(document.split('세로 병합').length).toBe(2);
    expect(document).toContain('<w:tblHeader/>');
    expect(document).toContain('<w:tblLayout w:type="fixed"/>');
  });

  it('keeps footnote content outside the body and writes related OOXML parts', () => {
    const note = concat(record(71, 1, Buffer.from('fn  ').reverse()), record(72, 2, concat(u32(1), u32(0))), paragraph('각주 내용', { level: 2 }));
    const model = parseHwp5(hwp({ sections: [paragraph(concat(utf16('본문'), controlText(17, 'fn  '), utf16('\r')), { children: [note] })] }));
    const parts = unzipSync(modelToDocx(model));
    expect(strFromU8(parts['word/document.xml'])).toContain('<w:footnoteReference w:id="1"/>');
    expect(strFromU8(parts['word/document.xml'])).not.toContain('각주 내용');
    expect(strFromU8(parts['word/footnotes.xml'])).toContain('각주 내용');
    expect(strFromU8(parts['word/footnotes.xml'])).toContain('<w:footnoteRef/>');
  });

  it('preserves text around a table nested in a text box', () => {
    const table = concat(
      record(71, 3, Buffer.from('tbl ').reverse()),
      record(77, 4, concat(u32(0), u16(1), u16(1), new Uint8Array(10), u16(1), u16(0))),
      record(72, 4, concat(u32(1), u32(0), u16(0), u16(0), u16(1), u16(1), u32(7200), u32(3600), new Uint8Array(8), u16(0))),
      paragraph('Cell', { level: 4 }));
    const box = concat(record(71, 1, Buffer.from('gso ').reverse()), record(72, 2, new Uint8Array(8)),
      paragraph(concat(utf16('Before'), controlText(11, 'tbl '), utf16('After\r')), { level: 2, children: [table] }));
    const bytes = hwp({ sections: [paragraph(controlText(11, 'gso '), { children: [box] })] });
    const document = new DOMParser().parseFromString(docXml(parseHwp5(bytes)), 'application/xml');
    expect(document.documentElement.textContent).toBe('BeforeCellAfter');
    expect(document.getElementsByTagNameNS('*', 'tbl')).toHaveLength(1);
  });

  it('imports a text box picture once, using its own dimensions', () => {
    const picture = concat(record(71, 3, concat(Buffer.from('gso ').reverse(), u32(1), new Uint8Array(8), u32(7200), u32(3600))),
      record(85, 4, concat(new Uint8Array(71), u16(1))));
    const box = concat(record(71, 1, concat(Buffer.from('gso ').reverse(), u32(1), new Uint8Array(8), u32(30000), u32(20000))),
      record(72, 2, new Uint8Array(8)), paragraph(concat(utf16('Before'), controlText(11, 'gso '), utf16('After\r')), { level: 2, children: [picture] }));
    const bytes = hwp({ compressed: false, sections: [paragraph(controlText(11, 'gso '), { children: [box] })],
      infoExtra: [record(18, 1, concat(u16(1), u16(1), string('png')))], streams: { 'BinData/BIN0001.png': new Uint8Array([137, 80, 78, 71]) } });
    const document = new DOMParser().parseFromString(docXml(parseHwp5(bytes)), 'application/xml');
    expect(document.documentElement.textContent).toBe('BeforeAfter');
    expect(document.getElementsByTagNameNS('*', 'drawing')).toHaveLength(1);
    const size = document.getElementsByTagNameNS('*', 'extent')[0];
    expect([size.getAttribute('cx'), size.getAttribute('cy')]).toEqual(['914400', '457200']);
  });

  it('imports external hyperlink fields without linking the following text', () => {
    const field = concat(Buffer.from('%hlk').reverse(), new Uint8Array(5), string('https\\://example.com/?a=1&b=2;1;0;0;'));
    const p = paragraph(concat(controlText(3, '%hlk'), utf16('링크'), controlText(4, '%hlk'), utf16(' 본문\r')), { children: [record(71, 1, field)] });
    const parts = unzipSync(modelToDocx(parseHwp5(hwp({ sections: [p] }))));
    const document = new DOMParser().parseFromString(strFromU8(parts['word/document.xml']), 'application/xml');
    expect(document.getElementsByTagNameNS('*', 'hyperlink')[0].textContent).toBe('링크');
    expect(strFromU8(parts['word/_rels/document.xml.rels'])).toContain('Target="https://example.com/?a=1&amp;b=2" TargetMode="External"');
  });

  it('matches repeated controls in order and retains controls without text markers', () => {
    const count = 4000;
    const field = (i) => record(71, 1, concat(Buffer.from('%hlk').reverse(), new Uint8Array(5), string(`https://example.com/${i};1;0;0;`)));
    const pageNumber = record(71, 1, concat(Buffer.from('atno').reverse(), u32(0), u16(7)));
    const markers = Array.from({ length: count }, () => concat(controlText(3, '%hlk'), utf16('링크'), controlText(4, '%hlk')));
    const bytes = hwp({ sections: [paragraph(concat(controlText(18, 'atno'), ...markers, controlText(3, '%hlk'), utf16('\r')), { children: [...Array.from({ length: count }, (_, i) => field(i)), pageNumber] })] });
    const model = parseHwp5(bytes), runs = model.sections[0].blocks[0].runs;
    expect(runs[0]).toMatchObject({ kind: 'field', instruction: 'PAGE', text: '7' });
    expect(runs.filter((r) => r.kind === 'fieldStart').map((r) => r.href)).toEqual(Array.from({ length: count }, (_, i) => `https://example.com/${i}`));
    // Repeated targets reuse a relationship within a part; another part owns its own IDs.
    const repeated = { kind: 'text', text: 'again', href: 'https://example.com/0' };
    runs.push(repeated);
    model.sections[0].headers.push({ type: 'default', blocks: [{ kind: 'p', runs: [repeated] }] });
    const parts = unzipSync(modelToDocx(model));
    const relationships = (owner) => [...new DOMParser().parseFromString(strFromU8(parts[`word/_rels/${owner}.xml.rels`]), 'application/xml').querySelectorAll('Relationship')];
    const links = relationships('document').filter((r) => r.getAttribute('Type').endsWith('/hyperlink'));
    expect(links.map((r) => r.getAttribute('Target'))).toEqual(Array.from({ length: count }, (_, i) => `https://example.com/${i}`));
    expect(new Set(relationships('document').map((r) => r.getAttribute('Id'))).size).toBe(relationships('document').length);
    expect(relationships('header1').map((r) => [r.getAttribute('Id'), r.getAttribute('Target')])).toEqual([['rId1', repeated.href]]);
    const unmarked = parseHwp5(hwp({ sections: [paragraph('본문', { children: [pageNumber] })] }));
    expect(unmarked.sections[0].blocks[0].runs.at(-1)).toMatchObject({ kind: 'field', text: '7' });
  });
});

describe('malformed and unsupported HWP files', () => {
  it.each([128, 512, 128 | 512])('imports unencrypted files with signature flags (%s) and reports signature loss', async (flags) => {
    const result = await convertHanword(file(hwp({ flags })));
    expect(xmlPart(new Uint8Array(await result.blob.arrayBuffer()))).toContain('안녕하세요 Hanword');
    expect(result.warnings).toContain('Digital signature information is not preserved in the editable DOCX copy.');
  });
  it('bounds generated XML when paragraphs repeatedly reference a large formatting definition', () => {
    const header = '<hh:tabPr id="0">' + '<hh:tabItem pos="720" type="LEFT" leader="NONE"/>'.repeat(1000)
      + '</hh:tabPr><hh:paraPr id="0" tabPrIDRef="0"/>';
    const bytes = hwpx({ header, sections: ['<hp:p><hp:run><hp:t>x</hp:t></hp:run></hp:p>'.repeat(2200)] });
    expect(bytes.length).toBeLessThan(2000);
    const model = parseHwpx(bytes), limit = LIMITS.output;
    // 2200 paragraphs of 1000 tabs each write about 110 MB; the check must stop the aggregate before it is joined.
    try { LIMITS.output = 64 * 1024 * 1024; expect(() => modelToDocx(model)).toThrow(/converted.*256 MB/i); } finally { LIMITS.output = limit; }
  });

  it('serializes shared tab definitions once per conversion without changing paragraph formatting', () => {
    const header = '<hh:tabPr id="0">' + '<hh:tabItem pos="720" type="LEFT" leader="NONE"/>'.repeat(100)
      + '</hh:tabPr><hh:paraPr id="0" tabPrIDRef="0"/>';
    const bytes = hwpx({ header, sections: ['<hp:p><hp:run><hp:t>x</hp:t></hp:run></hp:p>'.repeat(100)] });
    const model = parseHwpx(bytes);
    const tab = model.paras[0].tabs[0], align = tab.align;
    let reads = 0;
    Object.defineProperty(tab, 'align', { get: () => { reads++; return align; } });
    const converted = modelToDocx(model);
    expect(reads).toBe(1);
    // Equivalent per-paragraph definitions must produce identical OOXML.
    const inline = parseHwpx(bytes);
    for (const paragraph of inline.sections[0].blocks) paragraph.props = structuredClone(inline.paras[paragraph.para]);
    expect(unzipSync(converted)).toEqual(unzipSync(modelToDocx(inline)));
    // Reusing a model after editing it must not reuse stale cached XML.
    tab.leader = 'dot';
    expect(docXml(model)).toContain('w:leader="dot"');
    expect(reads).toBe(2);
  }, 20000); // deep-equal over unzipped packages takes several seconds when many workers share the machine

  it('counts UTF-8 bytes across all generated parts in the output budget', () => {
    const model = parseHwpx(hwpx({ sections: [`<hp:p><hp:run><hp:t>${'한글😀'.repeat(300)}</hp:t></hp:run></hp:p>`] }));
    const parts = Object.values(unzipSync(modelToDocx(model)));
    const total = parts.reduce((size, part) => size + part.length, 0), limit = LIMITS.output;
    try {
      LIMITS.output = total;
      expect(() => modelToDocx(model)).not.toThrow();
      LIMITS.output = total - 1;
      expect(parts.every((part) => part.length < LIMITS.output)).toBe(true);
      expect(() => modelToDocx(model)).toThrow(/converted.*256 MB/i);
    } finally { LIMITS.output = limit; }
  });

  it.each([2, 4, 16, 256, 1024, 128 | 256, 512 | 256])('rejects protected documents (flag %s)', async (flags) => {
    await expect(convertHanword(file(hwp({ flags })))).rejects.toThrow(/protected/);
  });
  it('rejects legacy HWP 3, renamed non-documents, and large files', async () => {
    await expect(convertHanword(file(strToU8('HWP Document File V3.00')))).rejects.toThrow(/HWP 3/);
    await expect(convertHanword(file(strToU8('not a document')))).rejects.toThrow(/not a valid/);
    await expect(convertHanword({ size: LIMITS.file + 1 })).rejects.toThrow(/32 MB/);
  });
  it('rejects truncated payloads, broken record nesting, cyclic FAT and directory chains', () => {
    expect(() => records(concat(u32(66 | 100 << 20), [0]))).toThrow();
    expect(() => records(record(66, 3, [0]))).toThrow();
    const source = Buffer.from(hwp()); const fatId = source.readUInt32LE(76), dirId = source.readUInt32LE(48);
    const cycle = Buffer.from(source); cycle.writeUInt32LE(dirId, (fatId + 1) * 512 + dirId * 4);
    expect(() => compoundFile(cycle)).toThrow();
    const dirCycle = Buffer.from(source); dirCycle.writeUInt32LE(0, (dirId + 1) * 512 + 76);
    expect(() => compoundFile(dirCycle)).toThrow();
    expect(() => compoundFile(source.subarray(0, source.length - 1))).toThrow();
  });
  it('enforces decompression budgets and rejects invalid compressed data', () => {
    const consume = budget(); consume(LIMITS.expanded);
    expect(() => inflate(deflateSync(strToU8('overflow')), consume)).toThrow(/96 MB/);
    expect(() => inflate(new Uint8Array([255]), budget())).toThrow(/compressed/);
  });
  it('rejects missing body sections rather than importing the preview', () => {
    const source = compoundFile(hwp());
    const damaged = cfb({ FileHeader: source.read('FileHeader'), DocInfo: source.read('DocInfo'), PrvText: utf16('preview only') });
    expect(() => parseHwp5(damaged)).toThrow(/body sections/);
  });
});

describe('HWPX', () => {
  it('embeds an image once when multiple manifest IDs refer to the same file', () => {
    const picture = (id) => `<hp:pic><hp:sz width="7200" height="3600"/><hp:pos treatAsChar="1"/><hp:img binaryItemIDRef="${id}"/></hp:pic>`;
    const archive = unzipSync(hwpx({ sections: [`<hp:p><hp:run>${picture('first')}${picture('alias')}<hp:t>본문</hp:t><hp:ctrl><hp:header><hp:subList><hp:p><hp:run>${picture('headerImage')}</hp:run></hp:p></hp:subList></hp:header></hp:ctrl></hp:run></hp:p>`] }));
    archive['Contents/content.hpf'] = strToU8(strFromU8(archive['Contents/content.hpf']).replace('</manifest>', '<item id="first" href="BinData/image.png"/><item id="alias" href="../BinData/image.png"/><item id="headerImage" href="../BinData/./image.png"/></manifest>'));
    archive['BinData/image.png'] = new Uint8Array([137, 80, 78, 71]);
    const parts = unzipSync(modelToDocx(parseHwpx(zipSync(archive))));
    expect(Object.keys(parts).filter((name) => name.startsWith('word/media/'))).toEqual(['word/media/image1.png']);
    expect(strFromU8(parts['word/document.xml']).match(/<w:drawing>/g)).toHaveLength(2);
    for (const owner of ['document', 'header1']) {
      expect(strFromU8(parts[`word/_rels/${owner}.xml.rels`])).toContain('Target="media/image1.png"');
    }
  });

  it('preserves CDATA text alongside ordinary text and inline controls', () => {
    const bytes = hwpx({ sections: ['<hp:p><hp:run><hp:t>앞<![CDATA[한글 <내용> & 😀]]><hp:tab/>뒤<![CDATA[끝]]></hp:t></hp:run></hp:p>'] });
    const model = parseHwpx(bytes);
    expect(plain(model)).toBe('앞한글 <내용> & 😀\t뒤끝');
    const document = new DOMParser().parseFromString(docXml(model), 'application/xml');
    expect(document.documentElement.textContent).toBe('앞한글 <내용> & 😀뒤끝');
    expect(document.getElementsByTagNameNS('*', 'tab')).toHaveLength(1);
  });

  it('allows declaration examples inside CDATA, comments, and processing instructions', () => {
    const example = '<!DOCTYPE html> <!ENTITY example "value">';
    const bytes = hwpx({ sections: [`<!-- ${example} --><?example ${example}?><hp:p><hp:run><hp:t><![CDATA[${example}]]></hp:t></hp:run></hp:p>`] });
    const model = parseHwpx(bytes);
    expect(plain(model)).toBe(example);
    const document = new DOMParser().parseFromString(docXml(model), 'application/xml');
    expect(document.documentElement.textContent).toBe(example);
  });

  it('still rejects actual entity declarations after comments and processing instructions', () => {
    const archive = unzipSync(hwpx());
    archive['Contents/section0.xml'] = strToU8('<!-- <![CDATA[ harmless --><?example <!DOCTYPE harmless?>\n<!DOCTYPE hs:sec [<!ENTITY x "expanded">]>\n'
      + strFromU8(archive['Contents/section0.xml']).replace('안녕하세요 HWPX', '&x;'));
    expect(() => parseHwpx(zipSync(archive))).toThrow(/entity declarations/);
  });

  it.each(['<!--', '<![CDATA[', '<?example'])('rejects an unterminated XML construct beginning with %s', (prefix) => {
    const bytes = hwpx({ sections: [`<hp:p><hp:run><hp:t>${prefix.repeat(5000)}</hp:t></hp:run></hp:p>`] });
    expect(() => parseHwpx(bytes)).toThrow(/damaged/);
  });

  it('imports hyperlinks, page fields, and cropped pictures in headers with local relationships', () => {
    const picture = '<hp:pic><hp:sz width="7200" height="3600"/><hp:pos treatAsChar="1"/><hp:img binaryItemIDRef="image1"/><hp:imgDim dimwidth="1000" dimheight="500"/><hp:imgClip left="100" top="50" right="800" bottom="450"/><hp:rotationInfo angle="90"/><hp:flip horizontal="1" vertical="0"/></hp:pic>';
    const link = '<hp:ctrl><hp:fieldBegin type="HYPERLINK"><hp:parameters><hp:stringParam name="Command">https\\://example.com/;1;0;0;</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl><hp:t>누리집</hp:t><hp:ctrl><hp:fieldEnd/></hp:ctrl>';
    const inside = `<hp:p><hp:run>${picture}${link}<hp:t> 다음</hp:t><hp:ctrl><hp:autoNum numType="PAGE" num="3"/></hp:ctrl></hp:run></hp:p>`;
    const sections = [`<hp:p><hp:run><hp:ctrl><hp:header applyPageType="EVEN"><hp:subList>${inside}</hp:subList></hp:header></hp:ctrl><hp:t>본문</hp:t></hp:run></hp:p>`];
    const archive = unzipSync(hwpx({ sections }));
    archive['Contents/content.hpf'] = strToU8(strFromU8(archive['Contents/content.hpf']).replace('</manifest>', '<item id="image1" href="../BinData/image1.png" media-type="image/png"/></manifest>'));
    archive['BinData/image1.png'] = new Uint8Array([137, 80, 78, 71]);
    const parts = unzipSync(modelToDocx(parseHwpx(zipSync(archive))));
    const header = strFromU8(parts['word/header1.xml']);
    expect(header).toContain('<a:srcRect l="10000" t="10000" r="20000" b="10000"/>');
    expect(header).toContain('<a:xfrm rot="5400000" flipH="1">');
    expect(header).toContain('w:instr="PAGE"');
    expect(strFromU8(parts['word/document.xml'])).toContain('w:type="even"');
    expect(strFromU8(parts['word/settings.xml'])).toContain('<w:evenAndOddHeaders/>');
    const parsed = new DOMParser().parseFromString(header, 'application/xml');
    expect(parsed.getElementsByTagNameNS('*', 'hyperlink')[0].textContent).toBe('누리집');
    const rels = strFromU8(parts['word/_rels/header1.xml.rels']);
    expect(rels).toContain('Target="media/image1.png"');
    expect(rels).toContain('Target="https://example.com/" TargetMode="External"');
    expect(strFromU8(parts['word/_rels/document.xml.rels'])).not.toContain('/hyperlink');
    expect(parts['word/media/image1.png']).toEqual(archive['BinData/image1.png']);
  });

  it('keeps unsupported or unsafe field targets as plain text', () => {
    const bytes = hwpx({ sections: ['<hp:p><hp:run><hp:ctrl><hp:fieldBegin type="HYPERLINK"><hp:stringParam name="Command">javascript:alert(1)</hp:stringParam></hp:fieldBegin></hp:ctrl><hp:t>보이는 글</hp:t><hp:ctrl><hp:fieldEnd/></hp:ctrl></hp:run></hp:p>'] });
    const model = parseHwpx(bytes), document = docXml(model);
    expect(document).toContain('보이는 글');
    expect(document).not.toContain('<w:hyperlink');
    expect([...model.warnings]).toContain('Some fields or internal hyperlinks were converted to plain text.');
  });

  it('overrides inherited lists and translates hanging indent origins', () => {
    const model = parseHwpx(hwpx());
    model.paras = [{ heading: 2, numId: 1, level: 0 }, { heading: 0, left: 330, indent: -3820 }];
    model.styles[0].para = 0; model.sections[0].blocks[0].para = 1;
    const document = docXml(model);
    expect(document).toContain('<w:numPr><w:numId w:val="0"/></w:numPr>');
    expect(document).toContain('w:left="830" w:right="0" w:hanging="764"');
    expect(document).toContain('<w:pageBreakBefore w:val="0"/>');
  });
  it('uses the package spine instead of filenames or ZIP entry order', async () => {
    const sections = ['첫째', '둘째'].map((t) => `<hp:p><hp:run><hp:t>${t}</hp:t></hp:run></hp:p>`);
    const bytes = hwpx({ sections, spine: [1, 0], sectionNames: ['section2.xml', 'section10.xml'] });
    const result = await convertHanword(file(bytes, '문서.hwpx'));
    expect(result.format).toBe('HWPX');
    expect(plain(parseHwpx(bytes))).toBe('둘째첫째');
  });
  it('handles alternate XML prefixes and imports only one switch branch', () => {
    const archive = unzipSync(hwpx({ sections: ['<hp:p><hp:run><hp:t>가<hp:tab/>나<hp:lineBreak/>다</hp:t></hp:run></hp:p>'] }));
    archive['Contents/section0.xml'] = strToU8(strFromU8(archive['Contents/section0.xml']).replaceAll('hp:', 'custom:').replace('xmlns:hp=', 'xmlns:custom='));
    expect(plain(parseHwpx(zipSync(archive)))).toBe('가\t나\n다');
    const withSwitch = hwpx({ sections: ['<hp:p><hp:run><hp:switch><hp:case><hp:t>wrong</hp:t></hp:case><hp:default><hp:t>right</hp:t></hp:default></hp:switch></hp:run></hp:p>'] });
    expect(plain(parseHwpx(withSwitch))).toBe('right');
  });
  it('imports explicit character and paragraph styles', () => {
    const bytes = hwpx({ header: '<hh:charPr id="0" height="1800" textColor="#336699"><hh:bold/><hh:italic/><hh:underline type="BOTTOM"/></hh:charPr><hh:paraPr id="0"><hh:align horizontal="CENTER"/><hh:breakSetting keepWithNext="1"/><hh:margin><hh:left value="7200"/></hh:margin></hh:paraPr>' });
    const document = docXml(parseHwpx(bytes));
    expect(document).toContain('<w:sz w:val="36"/>'); expect(document).toContain('<w:jc w:val="center"/>');
    expect(document).toContain('w:left="1440"'); expect(document).toContain('<w:keepNext w:val="1"/>');
  });

  it('keeps character scale, size, spacing, and position within DOCX limits', () => {
    const bytes = hwpx({
      header: '<hh:charPr id="0" height="4294967295"><hh:ratio hangul="99999"/><hh:spacing hangul="99999"/><hh:offset hangul="-99999"/></hh:charPr><hh:paraPr id="0"/><hh:style id="0" name="Base" paraPrIDRef="0" charPrIDRef="0"/>',
      sections: ['<hp:p styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>Huge</hp:t></hp:run></hp:p>'],
    });
    const document = new DOMParser().parseFromString(docXml(parseHwpx(bytes)), 'application/xml');
    const props = document.getElementsByTagNameNS('*', 'rPr')[0];
    const value = (tag) => Number(props.getElementsByTagNameNS('*', tag)[0]?.getAttribute('w:val'));
    expect(value('w')).toBe(600);
    expect(value('sz')).toBe(3276);
    expect(Math.abs(value('spacing'))).toBeLessThanOrEqual(31680);
    expect(Math.abs(value('position'))).toBeLessThanOrEqual(3168);
  });

  it('keeps a drawing shape\'s stroke width and rotation within DrawingML limits', () => {
    const shape = '<hp:rect><hp:sz width="7200" height="3600"/><hp:pos treatAsChar="1"/><hp:lineShape width="4294967295" color="#000000"/><hp:rotationInfo angle="40000"/></hp:rect>';
    const document = docXml(parseHwpx(hwpx({ sections: [`<hp:p><hp:run>${shape}<hp:t>after</hp:t></hp:run></hp:p>`] })));
    expect(document).toContain('<a:ln w="20116800"');
    expect(document).toContain('<a:xfrm rot="2400000"');
  });

  it('resets resolved character formatting inherited from a paragraph style', () => {
    const bytes = hwpx({
      header: '<hh:charPr id="0" height="1200" textColor="#FF0000" shadeColor="#FFFF00"><hh:supscript/><hh:ratio hangul="50"/><hh:spacing hangul="30"/></hh:charPr><hh:charPr id="1" height="1200"><hh:ratio hangul="100"/><hh:spacing hangul="0"/></hh:charPr><hh:paraPr id="0"/><hh:style id="0" name="Base" paraPrIDRef="0" charPrIDRef="0"/>',
      sections: ['<hp:p styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>Raised</hp:t></hp:run><hp:run charPrIDRef="1"><hp:t>Normal</hp:t></hp:run></hp:p>'],
    });
    const document = new DOMParser().parseFromString(docXml(parseHwpx(bytes)), 'application/xml');
    const [raised, normal] = document.getElementsByTagNameNS('*', 'rPr');
    const value = (props, tag) => props.getElementsByTagNameNS('*', tag)[0]?.getAttribute('w:val');
    expect(value(raised, 'vertAlign')).toBe('superscript');
    expect(value(raised, 'w')).toBe('50');
    expect(value(raised, 'spacing')).toBe('72');
    expect(value(normal, 'vertAlign')).toBe('baseline');
    expect(value(normal, 'w')).toBe('100');
    expect(value(normal, 'spacing')).toBe('0');
    expect(value(normal, 'color')).toBe('auto');
    expect(value(normal, 'shd')).toBe('clear');
    expect(normal.getElementsByTagNameNS('*', 'shd')[0].getAttribute('w:fill')).toBe('auto');
  });
  it('rejects encrypted packages, missing sections, entity declarations, malformed XML, CRC errors, and wrong MIME types', () => {
    expect(() => parseHwpx(hwpx({ extra: { 'META-INF/manifest.xml': strToU8('<manifest><encryption-data/></manifest>') } }))).toThrow(/encrypted/);
    const archive = unzipSync(hwpx()); delete archive['Contents/section0.xml']; expect(() => parseHwpx(zipSync(archive))).toThrow(/missing/);
    archive['Contents/section0.xml'] = strToU8('<!DOCTYPE x [<!ENTITY x "bad">]><x/>'); expect(() => parseHwpx(zipSync(archive))).toThrow(/entity/);
    archive['Contents/section0.xml'] = strToU8('<broken>'); expect(() => parseHwpx(zipSync(archive))).toThrow(/damaged/);
    archive.mimetype = strToU8('application/zip'); expect(() => parseHwpx(zipSync(archive))).toThrow(/not a Hanword/);
    const corrupt = Buffer.from(hwpx()); const central = corrupt.indexOf(Buffer.from('504b0102', 'hex')); corrupt.writeUInt32LE(0, central + 16);
    expect(() => hwpxArchive(corrupt).read('mimetype')).toThrow(/damaged/);
  });
});

describe('table cell budgets', () => {
  const table = (rows, cols) => `<hp:p><hp:run><hp:tbl rowCnt="${rows}" colCnt="${cols}"><hp:tr><hp:tc><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="1000" height="1000"/><hp:subList><hp:p><hp:run><hp:t>x</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p>`;
  it('takes a long document with many tables, and names the reason when one table is too large', () => {
    const many = parseHwpx(hwpx({ sections: [Array.from({ length: 6 }, () => table(60, 60)).join('')] }));
    expect(JSON.stringify(many.sections).match(/"kind":"table"/g)).toHaveLength(6);
    expect(() => parseHwpx(hwpx({ sections: [table(700, 30)] }))).toThrow('more table cells than can be imported');
  });
});

describe('opening converted Hanword documents', () => {
  it.each(['ChangeTrack', 'PageFunctions', 'SimpleCompose', 'SimpleEquation'])('opens %s.hwpx for editing, not as a read-only preview', async (name) => {
    globalThis.XMLSerializer ??= new JSDOM('').window.XMLSerializer;
    const { DocxPackage } = await import('../src/engine/docx.js');
    const { blob } = await convertHanword(file(readFileSync(`tests/fixtures/hwpx/${name}.hwpx`), `${name}.hwpx`));
    const pkg = await DocxPackage.open(new Uint8Array(await blob.arrayBuffer()), { bestEffort: true });
    expect(pkg.previewIssues || []).toEqual([]);
    expect(pkg.readOnly).toBeFalsy();
  });
  it('writes one strikethrough property per run and leaves strikethrough out of styles', () => {
    const xml = docXml(parseHwpx(hwpx({ sections: ['<hp:p><hp:run><hp:t>Plain</hp:t></hp:run></hp:p>'] })));
    expect(xml).not.toMatch(/<w:strike [^>]*\/><w:dstrike/);
    expect(xml).not.toContain('w:val="nil" w:fill');
  });
});
