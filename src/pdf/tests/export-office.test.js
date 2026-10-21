import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, StandardFonts, rgb, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { DOMParser } from '@xmldom/xmldom';
import { exportDocument, analyzeDocument, EXPORT_FORMATS } from '../src/core/export-office.js';
import { OPS, describeFont, listMarker } from '../src/core/export-layout.js';
import { parseCellValue } from '../src/core/export-xlsx.js';
import { encodePng } from '../src/core/export-images.js';
import { zipPackage } from '../src/core/ooxml-zip.js';
import { crc32 } from '../src/lib/crc32.js';

/* ------------------------------------------------------------------ helpers */

/** Read a ZIP archive into { name: Uint8Array }, checking CRCs and sizes. */
async function unzip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('No end of central directory');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const files = {};
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('Bad central directory');
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const raw = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (view.getUint32(offset, true) !== 0x04034b50) throw new Error('Bad local header');
    const localName = view.getUint16(offset + 26, true),
      localExtra = view.getUint16(offset + 28, true);
    expect(view.getUint32(offset + 14, true)).toBe(crc);
    const start = offset + 30 + localName + localExtra;
    let data = bytes.subarray(start, start + size);
    if (method === 8)
      data = new Uint8Array(
        await new Response(
          new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')),
        ).arrayBuffer(),
      );
    else expect(method).toBe(0);
    expect(data.length).toBe(raw);
    expect(crc32(data)).toBe(crc);
    files[name] = data;
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

const text = (bytes) => new TextDecoder().decode(bytes);

function parseXml(source, name) {
  const errors = [];
  const doc = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') errors.push(`${name}: ${message}`);
    },
  }).parseFromString(source, 'application/xml');
  expect(errors).toEqual([]);
  return doc;
}

const elements = (node, tag) => Array.from(node.getElementsByTagName(tag));
const attr = (node, name) => node.getAttribute(name);

/** Every XML part parses; every part has a content type; every relationship resolves. */
function checkPackage(files) {
  const names = Object.keys(files);
  expect(names[0]).toBe('[Content_Types].xml');
  const docs = {};
  for (const name of names)
    if (/\.(xml|rels)$/.test(name)) docs[name] = parseXml(text(files[name]), name);
  const types = docs['[Content_Types].xml'];
  const defaults = new Set(
    elements(types, 'Default').map((d) => attr(d, 'Extension').toLowerCase()),
  );
  const overrides = new Set(elements(types, 'Override').map((o) => attr(o, 'PartName')));
  for (const name of names) {
    if (name === '[Content_Types].xml') continue;
    const ext = name.split('.').pop().toLowerCase();
    expect(overrides.has('/' + name) || defaults.has(ext), `content type for ${name}`).toBe(true);
  }
  for (const part of overrides) expect(names, `override ${part} exists`).toContain(part.slice(1));
  for (const name of names.filter((n) => n.endsWith('.rels'))) {
    const dir = name.replace(/_rels\/[^/]*\.rels$/, '');
    for (const rel of elements(docs[name], 'Relationship')) {
      if (attr(rel, 'TargetMode') === 'External') continue;
      const target = attr(rel, 'Target');
      const parts = (target.startsWith('/') ? target.slice(1) : dir + target).split('/');
      const resolved = [];
      for (const p of parts) {
        if (p === '..') resolved.pop();
        else if (p !== '.') resolved.push(p);
      }
      expect(names, `${name} -> ${target}`).toContain(resolved.join('/'));
    }
    // Relationship ids are unique within a part.
    const ids = elements(docs[name], 'Relationship').map((r) => attr(r, 'Id'));
    expect(new Set(ids).size).toBe(ids.length);
  }
  return docs;
}

function inOrder(haystack, needles) {
  let at = -1;
  for (const needle of needles) {
    const next = haystack.indexOf(needle, at + 1);
    expect(next, `"${needle}" after position ${at}`).toBeGreaterThan(at);
    at = next;
  }
}

/* ------------------------------------------------------------------ fixture */

function jpegPicture() {
  const canvas = createCanvas(64, 48),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = '#3366cc';
  ctx.fillRect(0, 0, 64, 48);
  ctx.fillStyle = '#ffcc00';
  ctx.fillRect(10, 10, 30, 20);
  return canvas.toBuffer('image/jpeg');
}

async function pngPicture() {
  const width = 20,
    height = 10,
    data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = (i * 7) % 256;
    data[i * 4 + 1] = 120;
    data[i * 4 + 2] = 200;
    data[i * 4 + 3] = i % 3 ? 255 : 128;
  }
  return encodePng({ width, height, data, kind: 3 });
}

let jpegBytes;
async function fixturePdf() {
  const doc = await PDFDocument.create();
  doc.setTitle('Export Fixture');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic);
  jpegBytes = jpegPicture();
  const jpeg = await doc.embedJpg(jpegBytes);
  const png = await doc.embedPng(await pngPicture());

  // Page 1: portrait letter.
  const p1 = doc.addPage([612, 792]);
  let y = 740;
  p1.drawText('Quarterly Report', {
    x: 72,
    y,
    size: 24,
    font: bold,
    color: rgb(0.1, 0.2, 0.5),
  });
  y -= 40;
  p1.drawText('Introduction', { x: 72, y, size: 16, font: bold });
  y -= 24;
  const body = [
    'This report summarises the results of the quarter for every region of the',
    'company. Revenue grew in most markets while costs stayed broadly flat, and',
    'the outlook for the coming year remains positive.',
  ];
  for (const line of body) {
    p1.drawText(line, { x: 72, y, size: 11, font: regular });
    y -= 14;
  }
  y -= 10;
  p1.drawText('An italic remark closes the introduction.', {
    x: 72,
    y,
    size: 11,
    font: italic,
  });
  y -= 26;
  for (const item of ['First bullet point', 'Second bullet point', 'Third bullet point']) {
    p1.drawText('•', { x: 80, y, size: 11, font: regular });
    p1.drawText(item, { x: 94, y, size: 11, font: regular });
    y -= 15;
  }
  y -= 10;
  ['Alpha step', 'Beta step'].forEach((item, k) => {
    p1.drawText(`${k + 1}.`, { x: 80, y, size: 11, font: regular });
    p1.drawText(item, { x: 98, y, size: 11, font: regular });
    y -= 15;
  });
  // A ruled table: 3 columns x 4 rows.
  y -= 20;
  const cols = [72, 222, 372, 522];
  const rows = [
    ['Region', 'Revenue', 'Growth'],
    ['North', '$1,250.50', '12.5%'],
    ['South', '980', '(3.2%)'],
    ['Total', '2,230.50', '4.1%'],
  ];
  const rowHeight = 20;
  const top = y;
  rows.forEach((row, r) => {
    row.forEach((cell, c) =>
      p1.drawText(cell, {
        x: cols[c] + 6,
        y: top - r * rowHeight - 14,
        size: 10,
        font: r === 0 ? bold : regular,
      }),
    );
  });
  for (let r = 0; r <= rows.length; r++)
    p1.drawLine({
      start: { x: cols[0], y: top - r * rowHeight },
      end: { x: cols[3], y: top - r * rowHeight },
      thickness: 0.75,
    });
  for (const x of cols)
    p1.drawLine({
      start: { x, y: top },
      end: { x, y: top - rows.length * rowHeight },
      thickness: 0.75,
    });
  y = top - rows.length * rowHeight - 30;
  p1.drawImage(jpeg, { x: 72, y: y - 96, width: 128, height: 96 });
  p1.drawImage(png, { x: 300, y: y - 50, width: 100, height: 50 });

  // Page 2: landscape, with an unruled numeric table.
  const p2 = doc.addPage([792, 612]);
  p2.drawText('Appendix', { x: 72, y: 540, size: 16, font: bold });
  p2.drawText('Figures below are in thousands of dollars.', {
    x: 72,
    y: 510,
    size: 11,
    font: regular,
  });
  const table = [
    ['Item', '2023', '2022', 'Change'],
    ['Net revenue', '615,404', '456,679', '35 %'],
    ['Net income', '47,913', '(40,006)', 'n/m'],
    ['Margin', '12.5%', '8.1%', '4.4 %'],
  ];
  const xs = [72, 300, 420, 540];
  table.forEach((row, r) =>
    row.forEach((cell, c) => {
      const font = r === 0 ? bold : regular;
      const width = font.widthOfTextAtSize(cell, 11);
      // Numbers are right-aligned in their columns, labels left-aligned.
      const x = c === 0 ? xs[0] : xs[c] + 80 - width;
      p2.drawText(cell, { x, y: 470 - r * 16, size: 11, font });
    }),
  );
  p2.drawText('Rotated note', {
    x: 740,
    y: 100,
    size: 9,
    font: regular,
    rotate: degrees(90),
  });
  return doc.save();
}

/* ------------------------------------------------------------------ tests */

let pdfBytes, task, pdf;
const outputs = {};
beforeAll(async () => {
  pdfBytes = await fixturePdf();
  task = pdfjs.getDocument({
    data: pdfBytes.slice(),
    verbosity: 0,
    useSystemFonts: false,
    standardFontDataUrl: new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
      .pathname,
  });
  pdf = await task.promise;
  for (const format of Object.keys(EXPORT_FORMATS))
    outputs[format] = await exportDocument(pdf, pdfBytes, format);
}, 60000);
afterAll(() => task?.destroy());

it('uses the operator codes of the installed PDF.js', () => {
  for (const [name, code] of Object.entries(OPS)) expect(pdfjs.OPS[name], name).toBe(code);
});

describe('layout analysis', () => {
  it('finds headings, paragraphs, lists, tables and pictures in reading order', async () => {
    const model = await analyzeDocument(pdf, pdfBytes);
    expect(model.body.size).toBe(11);
    const [first, second] = model.pages;
    expect(first.width).toBe(612);
    expect(second.width).toBe(792);
    const kinds = first.blocks.map((b) => b.type);
    expect(kinds.filter((k) => k === 'image')).toHaveLength(2);
    const headings = first.blocks.filter((b) => b.heading);
    expect(headings.map((b) => b.runs.map((r) => r.text).join(''))).toEqual([
      'Quarterly Report',
      'Introduction',
    ]);
    expect(headings[0].heading).toBe(1);
    expect(headings[1].heading).toBe(2);
    expect(headings[0].runs[0].color).toBe('1A3380');
    const intro = first.blocks.find((b) => b.type === 'paragraph' && b.lineCount === 3);
    expect(intro.runs.map((r) => r.text).join('')).toBe(
      'This report summarises the results of the quarter for every region of the company. Revenue grew in most markets while costs stayed broadly flat, and the outlook for the coming year remains positive.',
    );
    const italic = first.blocks.find((b) => b.runs?.[0]?.italic);
    expect(italic.runs[0].font).toBe('Times New Roman');
    const bullets = first.blocks.filter((b) => b.list?.kind === 'bullet');
    expect(bullets.map((b) => b.runs.map((r) => r.text).join(''))).toEqual([
      'First bullet point',
      'Second bullet point',
      'Third bullet point',
    ]);
    expect(new Set(bullets.map((b) => b.list.instance)).size).toBe(1);
    const numbered = first.blocks.filter((b) => b.list?.kind === 'decimal');
    expect(numbered.map((b) => [b.list.start, b.runs[0].text])).toEqual([
      [1, 'Alpha step'],
      [1, 'Beta step'],
    ]);
    const table = first.blocks.find((b) => b.type === 'table');
    expect(table.ruled).toBe(true);
    const cells = table.rows.map((row) =>
      row.cells.map((c) => c.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('')),
    );
    expect(cells).toEqual([
      ['Region', 'Revenue', 'Growth'],
      ['North', '$1,250.50', '12.5%'],
      ['South', '980', '(3.2%)'],
      ['Total', '2,230.50', '4.1%'],
    ]);
    expect(table.rows[0].header).toBe(true);
    const aligned = second.blocks.find((b) => b.type === 'table');
    expect(aligned.ruled).toBe(false);
    expect(
      aligned.rows.map((row) =>
        row.cells.map((c) => c.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('')),
      ),
    ).toEqual([
      ['Item', '2023', '2022', 'Change'],
      ['Net revenue', '615,404', '456,679', '35 %'],
      ['Net income', '47,913', '(40,006)', 'n/m'],
      ['Margin', '12.5%', '8.1%', '4.4 %'],
    ]);
    expect(aligned.rows[1].cells[1].align).toBe('right');
  });

  it('reads list markers and font names', () => {
    expect(listMarker('• Item')).toMatchObject({ kind: 'bullet' });
    expect(listMarker('3. Step')).toMatchObject({
      kind: 'decimal',
      value: 3,
      pattern: '%1.',
    });
    expect(listMarker('(b) Option')).toMatchObject({
      kind: 'lowerLetter',
      value: 2,
      pattern: '(%1)',
    });
    expect(listMarker('iv) Four')).toMatchObject({
      kind: 'lowerRoman',
      value: 4,
      pattern: '%1)',
    });
    expect(listMarker('2023 results')).toBeNull();
    expect(listMarker('1.5 million')).toBeNull();
    expect(describeFont('ABCDEF+TimesNewRomanPS-BoldItalicMT')).toMatchObject({
      family: 'Times New Roman',
      bold: true,
      italic: true,
    });
    expect(describeFont('Helvetica-Oblique')).toMatchObject({
      family: 'Arial',
      bold: false,
      italic: true,
    });
    expect(describeFont('XYZABC+Calibri-Bold')).toMatchObject({
      family: 'Calibri',
      bold: true,
    });
    expect(describeFont('Unknown-Light', 'serif')).toMatchObject({
      family: 'Times New Roman',
      bold: false,
    });
  });
});

describe('DOCX', () => {
  it('is a valid WordprocessingML package with styles, numbering, tables, sections and pictures', async () => {
    const out = outputs.docx;
    expect(out.mime).toBe(EXPORT_FORMATS.docx.mime);
    expect(out.blob.type).toBe(out.mime);
    const files = await unzip(out.bytes);
    const docs = checkPackage(files);
    for (const part of [
      'word/document.xml',
      'word/styles.xml',
      'word/numbering.xml',
      'word/settings.xml',
      'docProps/core.xml',
      'docProps/app.xml',
      '_rels/.rels',
      'word/_rels/document.xml.rels',
    ])
      expect(files[part], part).toBeDefined();
    const document = docs['word/document.xml'];
    const allText = elements(document, 'w:t')
      .map((t) => t.textContent)
      .join('|');
    inOrder(allText, [
      'Quarterly Report',
      'Introduction',
      'This report summarises',
      'First bullet point',
      'Third bullet point',
      'Alpha step',
      'Region',
      'North',
      '$1,250.50',
      'Total',
      'Appendix',
      'Net revenue',
      '615,404',
      'Margin',
    ]);
    const paragraphs = elements(document, 'w:p');
    const styleOf = (p) => elements(p, 'w:pStyle')[0]?.getAttribute('w:val');
    const textOf = (p) =>
      elements(p, 'w:t')
        .map((t) => t.textContent)
        .join('');
    expect(textOf(paragraphs.find((p) => styleOf(p) === 'Heading1'))).toBe('Quarterly Report');
    expect(paragraphs.filter((p) => styleOf(p) === 'Heading2').map(textOf)).toContain(
      'Introduction',
    );
    // Heading styles exist with outline levels.
    const styles = docs['word/styles.xml'];
    const ids = elements(styles, 'w:style').map((s) => s.getAttribute('w:styleId'));
    for (const id of ['Normal', 'Heading1', 'Heading2', 'Heading3']) expect(ids).toContain(id);
    // Lists point at numbering definitions that exist.
    const numbering = docs['word/numbering.xml'];
    const numIds = new Set(elements(numbering, 'w:num').map((n) => n.getAttribute('w:numId')));
    const listParagraphs = paragraphs.filter((p) => elements(p, 'w:numId').length);
    expect(listParagraphs.map(textOf)).toEqual([
      'First bullet point',
      'Second bullet point',
      'Third bullet point',
      'Alpha step',
      'Beta step',
    ]);
    for (const p of listParagraphs)
      expect(numIds.has(elements(p, 'w:numId')[0].getAttribute('w:val'))).toBe(true);
    const formats = elements(numbering, 'w:numFmt').map((n) => n.getAttribute('w:val'));
    expect(formats).toContain('bullet');
    expect(formats).toContain('decimal');
    // abstractNum elements come before num elements (schema order).
    const children = Array.from(numbering.documentElement.childNodes)
      .filter((n) => n.nodeType === 1)
      .map((n) => n.nodeName);
    expect(children.lastIndexOf('w:abstractNum')).toBeLessThan(children.indexOf('w:num'));
    // Tables.
    const tables = elements(document, 'w:tbl');
    expect(tables.length).toBe(2);
    const rows = elements(tables[0], 'w:tr').map((tr) => elements(tr, 'w:tc').map(textOf));
    expect(rows).toEqual([
      ['Region', 'Revenue', 'Growth'],
      ['North', '$1,250.50', '12.5%'],
      ['South', '980', '(3.2%)'],
      ['Total', '2,230.50', '4.1%'],
    ]);
    for (const table of tables) {
      const grid = elements(table, 'w:gridCol').length;
      for (const tr of elements(table, 'w:tr')) {
        const spans = elements(tr, 'w:tc').reduce(
          (n, tc) => n + Number(elements(tc, 'w:gridSpan')[0]?.getAttribute('w:val') || 1),
          0,
        );
        expect(spans).toBe(grid);
      }
    }
    expect(elements(tables[0], 'w:insideH')[0].getAttribute('w:val')).toBe('single');
    // One section per page with the page size and orientation.
    const sections = elements(document, 'w:sectPr');
    expect(sections).toHaveLength(2);
    const size = (s) => elements(s, 'w:pgSz')[0];
    expect(size(sections[0]).getAttribute('w:w')).toBe('12240');
    expect(size(sections[0]).getAttribute('w:h')).toBe('15840');
    expect(size(sections[1]).getAttribute('w:w')).toBe('15840');
    expect(size(sections[1]).getAttribute('w:orient')).toBe('landscape');
    // The body's last child is the final section's properties.
    const body = elements(document, 'w:body')[0];
    const last = Array.from(body.childNodes)
      .filter((n) => n.nodeType === 1)
      .at(-1);
    expect(last.nodeName).toBe('w:sectPr');
    // Pictures: the JPEG is passed through byte for byte; the other picture is PNG.
    const media = Object.keys(files).filter((n) => n.startsWith('word/media/'));
    const jpeg = media.find((n) => n.endsWith('.jpeg'));
    const png = media.find((n) => n.endsWith('.png'));
    expect(jpeg && png).toBeTruthy();
    expect(Buffer.from(files[jpeg]).equals(Buffer.from(jpegBytes))).toBe(true);
    expect(Array.from(files[png].subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const blips = elements(document, 'a:blip').map((b) => b.getAttribute('r:embed'));
    const rels = Object.fromEntries(
      elements(docs['word/_rels/document.xml.rels'], 'Relationship').map((r) => [
        r.getAttribute('Id'),
        r.getAttribute('Target'),
      ]),
    );
    expect(blips.map((id) => rels[id]).sort()).toEqual(
      media.map((n) => n.replace('word/', '')).sort(),
    );
    const docPrIds = elements(document, 'wp:docPr').map((d) => d.getAttribute('id'));
    expect(new Set(docPrIds).size).toBe(docPrIds.length);
    expect(text(files['docProps/core.xml'])).toContain('<dc:title>Export Fixture</dc:title>');
  });
});

describe('XLSX', () => {
  it('writes one typed worksheet per page with shared strings and number formats', async () => {
    const files = await unzip(outputs.xlsx.bytes);
    const docs = checkPackage(files);
    const sheets = elements(docs['xl/workbook.xml'], 'sheet');
    expect(sheets.map((s) => s.getAttribute('name'))).toEqual(['Page 1', 'Page 2']);
    const strings = elements(docs['xl/sharedStrings.xml'], 'si').map((si) => si.textContent);
    const formats = Object.fromEntries(
      elements(docs['xl/styles.xml'], 'numFmt').map((f) => [
        f.getAttribute('numFmtId'),
        f.getAttribute('formatCode'),
      ]),
    );
    const xfs = elements(elements(docs['xl/styles.xml'], 'cellXfs')[0], 'xf');
    const cells = (name) => {
      const out = {};
      for (const c of elements(docs[name], 'c')) {
        const v = elements(c, 'v')[0]?.textContent;
        const style = xfs[Number(c.getAttribute('s') || 0)];
        out[c.getAttribute('r')] = {
          value:
            c.getAttribute('t') === 's' ? strings[Number(v)] : v === undefined ? null : Number(v),
          type: c.getAttribute('t') || 'n',
          format: formats[style.getAttribute('numFmtId')] || null,
        };
      }
      return out;
    };
    const first = cells('xl/worksheets/sheet1.xml');
    const find = (sheet, value) => Object.entries(sheet).find(([, c]) => c.value === value);
    expect(find(first, 'Quarterly Report')).toBeTruthy();
    const region = find(first, 'Region')[0];
    const row = Number(region.slice(1));
    expect(first[`B${row + 1}`]).toMatchObject({ value: 1250.5, type: 'n' });
    expect(first[`B${row + 1}`].format).toContain('#,##0.00');
    expect(first[`C${row + 1}`]).toMatchObject({
      value: 0.125,
      type: 'n',
      format: '0.0%',
    });
    expect(first[`C${row + 2}`].value).toBeCloseTo(-0.032, 10);
    expect(first[`B${row + 3}`]).toMatchObject({ value: 2230.5, type: 'n' });
    const second = cells('xl/worksheets/sheet2.xml');
    const item = find(second, 'Item')[0];
    const r2 = Number(item.slice(1));
    expect(second[`B${r2}`]).toMatchObject({ value: 2023, type: 'n' });
    expect(second[`B${r2 + 1}`]).toMatchObject({
      value: 615404,
      type: 'n',
      format: '#,##0',
    });
    expect(second[`C${r2 + 2}`]).toMatchObject({ value: -40006, type: 'n' });
    expect(second[`D${r2 + 1}`]).toMatchObject({ value: 0.35, format: '0%' });
    expect(second[`D${r2 + 2}`]).toMatchObject({ value: 'n/m', type: 's' });
    // Column widths come from the PDF geometry.
    expect(elements(docs['xl/worksheets/sheet2.xml'], 'col').length).toBeGreaterThanOrEqual(4);
  });

  it('can put the whole document on one sheet', async () => {
    const out = await exportDocument(pdf, pdfBytes, 'xlsx', {
      singleSheet: true,
    });
    const files = await unzip(out.bytes);
    const docs = checkPackage(files);
    expect(elements(docs['xl/workbook.xml'], 'sheet')).toHaveLength(1);
  });

  it('types numbers, money, percentages and dates', () => {
    expect(parseCellValue('1,234.50')).toEqual({
      type: 'n',
      value: 1234.5,
      format: '#,##0.00',
    });
    expect(parseCellValue('$ 615,404')).toMatchObject({
      type: 'n',
      value: 615404,
      format: '\\$#,##0',
    });
    expect(parseCellValue('(40,006)')).toMatchObject({
      type: 'n',
      value: -40006,
    });
    expect(parseCellValue('-12.5%')).toMatchObject({
      type: 'n',
      value: -0.125,
      format: '0.0%',
    });
    expect(parseCellValue('2024-03-31')).toEqual({
      type: 'n',
      value: 45382,
      format: 'yyyy-mm-dd',
    });
    expect(parseCellValue('Jan 29, 2024')).toMatchObject({
      type: 'n',
      value: 45320,
    });
    expect(parseCellValue('007')).toEqual({ type: 's', value: '007' });
    expect(parseCellValue('n/m')).toEqual({ type: 's', value: 'n/m' });
    expect(parseCellValue('2023')).toEqual({
      type: 'n',
      value: 2023,
      format: null,
    });
  });
});

describe('PPTX', () => {
  it('writes one slide per page with positioned text, tables and pictures', async () => {
    const files = await unzip(outputs.pptx.bytes);
    const docs = checkPackage(files);
    const presentation = docs['ppt/presentation.xml'];
    const size = elements(presentation, 'p:sldSz')[0];
    expect(size.getAttribute('cx')).toBe(String(612 * 12700));
    expect(size.getAttribute('cy')).toBe(String(792 * 12700));
    expect(elements(presentation, 'p:sldId')).toHaveLength(2);
    for (const part of [
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/theme/theme1.xml',
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
    ])
      expect(files[part], part).toBeDefined();
    const slide1 = docs['ppt/slides/slide1.xml'];
    const allText = elements(slide1, 'a:t')
      .map((t) => t.textContent)
      .join('|');
    inOrder(allText, ['Quarterly Report', 'Introduction', 'First bullet point', 'Region', 'North']);
    expect(elements(slide1, 'p:pic')).toHaveLength(2);
    expect(elements(slide1, 'a:tbl')).toHaveLength(1);
    // Shape ids are unique per slide.
    const ids = elements(slide1, 'p:cNvPr').map((n) => n.getAttribute('id'));
    expect(new Set(ids).size).toBe(ids.length);
    // Table rows have one cell per grid column.
    for (const tbl of [
      ...elements(slide1, 'a:tbl'),
      ...elements(docs['ppt/slides/slide2.xml'], 'a:tbl'),
    ]) {
      const grid = elements(tbl, 'a:gridCol').length;
      for (const tr of elements(tbl, 'a:tr')) expect(elements(tr, 'a:tc')).toHaveLength(grid);
    }
    // The title sits near the top of the slide at its PDF size.
    const title = elements(slide1, 'p:sp').find((sp) =>
      elements(sp, 'a:t').some((t) => t.textContent === 'Quarterly Report'),
    );
    expect(elements(title, 'a:rPr')[0].getAttribute('sz')).toBe('2400');
    expect(Number(elements(title, 'a:off')[0].getAttribute('x'))).toBe(72 * 12700);
  });

  it('can put a rendered page behind each slide', async () => {
    const png = await pngPicture();
    const calls = [];
    const out = await exportDocument(pdf, pdfBytes, 'pptx', {
      slideBackgrounds: true,
      renderPage: async (index, scale) => {
        calls.push([index, scale]);
        return png;
      },
    });
    expect(calls).toEqual([
      [0, 2],
      [1, 2],
    ]);
    const files = await unzip(out.bytes);
    const docs = checkPackage(files);
    expect(elements(docs['ppt/slides/slide2.xml'], 'p:bg')).toHaveLength(1);
  });
});

describe('text formats', () => {
  it('writes plain text in reading order with a form feed between pages', () => {
    const txt = text(outputs.txt.bytes);
    const [one, two] = txt.split('\f');
    inOrder(one, [
      'Quarterly Report',
      'Introduction',
      'This report summarises the results of the quarter for every region of the company.',
      '• First bullet point',
      '1. Alpha step',
      '2. Beta step',
      'Region\tRevenue\tGrowth',
      'North\t$1,250.50\t12.5%',
    ]);
    inOrder(two, ['Appendix', 'Item\t2023\t2022\tChange', 'Net revenue\t615,404\t456,679\t35 %']);
    expect(two).toContain('Rotated note');
  });

  it('writes semantic HTML with embedded pictures', () => {
    const html = text(outputs.html.bytes);
    const doc = parseXml(
      html
        .replace('<!DOCTYPE html>', '')
        .replace(/<meta([^>]*)>/g, '<meta$1/>')
        .replace(/<img([^>]*)>/g, '<img$1/>')
        .replace(/<br>/g, '<br/>'),
      'html',
    );
    expect(elements(doc, 'h1')[0].textContent).toBe('Quarterly Report');
    expect(elements(doc, 'h2').map((h) => h.textContent)).toEqual(['Introduction', 'Appendix']);
    expect(elements(doc, 'ul')[0].getElementsByTagName('li')).toHaveLength(3);
    expect(elements(doc, 'ol')[0].getElementsByTagName('li')).toHaveLength(2);
    expect(elements(doc, 'table')).toHaveLength(2);
    expect(
      elements(doc, 'th')
        .map((th) => th.textContent)
        .slice(0, 3),
    ).toEqual(['Region', 'Revenue', 'Growth']);
    const sources = elements(doc, 'img').map((img) => img.getAttribute('src'));
    expect(sources.some((s) => s.startsWith('data:image/jpeg;base64,'))).toBe(true);
    expect(sources.some((s) => s.startsWith('data:image/png;base64,'))).toBe(true);
    expect(elements(doc, 'title')[0].textContent).toBe('Export Fixture');
  });

  it('writes RTF with sections, tables and pictures', () => {
    const rtf = text(outputs.rtf.bytes);
    expect(rtf.startsWith('{\\rtf1')).toBe(true);
    expect(rtf.endsWith('}')).toBe(true);
    let depth = 0;
    for (let i = 0; i < rtf.length; i++) {
      if (rtf[i] === '\\') i++;
      else if (rtf[i] === '{') depth++;
      else if (rtf[i] === '}') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    expect(rtf).toContain('\\jpegblip');
    expect(rtf).toContain('\\pngblip');
    expect(rtf).toContain('\\trowd');
    expect(rtf).toContain('\\lndscpsxn');
    expect(rtf).toContain('Quarterly Report');
  });
});

describe('progress and cancellation', () => {
  it('reports progress and honours the page selection', async () => {
    const progress = [];
    const out = await exportDocument(pdf, pdfBytes, 'txt', {
      pages: [1],
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(progress[0]).toEqual([1, 2]);
    expect(progress.at(-1)).toEqual([2, 2]);
    const txt = text(out.bytes);
    expect(txt).toContain('Appendix');
    expect(txt).not.toContain('Quarterly Report');
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    const promise = exportDocument(pdf, pdfBytes, 'docx', {
      signal: controller.signal,
      onProgress: () => controller.abort(new Error('Stopped')),
    });
    await expect(promise).rejects.toThrow('Stopped');
    const aborted = AbortSignal.abort(new Error('Already stopped'));
    await expect(exportDocument(pdf, pdfBytes, 'xlsx', { signal: aborted })).rejects.toThrow(
      'Already stopped',
    );
  });

  it('rejects unknown formats and empty page selections', async () => {
    await expect(exportDocument(pdf, pdfBytes, 'odt')).rejects.toThrow('Unsupported');
    await expect(exportDocument(pdf, pdfBytes, 'txt', { pages: [99] })).rejects.toThrow('page');
  });
});

it('stores entries that do not compress and keeps package entries in order', async () => {
  const random = new Uint8Array(4096).map((_, i) => (i * 2654435761) >>> 24);
  const zip = await zipPackage([
    { name: '[Content_Types].xml', data: '<Types/>'.repeat(40) },
    { name: 'media/x.bin', data: random, store: true },
  ]);
  const files = await unzip(zip);
  expect(Object.keys(files)).toEqual(['[Content_Types].xml', 'media/x.bin']);
  expect(Buffer.from(files['media/x.bin']).equals(Buffer.from(random))).toBe(true);
});

describe('columns, running heads and decorations', () => {
  const words =
    'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(
      ' ',
    );
  const column = (seed) =>
    Array.from({ length: 12 }, (_, k) =>
      Array.from({ length: 5 }, (_, j) => words[(seed + k * 5 + j) % words.length]).join(' '),
    );
  let task2, pdf2, bytes2;
  beforeAll(async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    for (let n = 1; n <= 3; n++) {
      const page = doc.addPage([612, 792]);
      page.drawText('ACME Corp Annual Review', { x: 72, y: 760, size: 9, font });
      page.drawText(`Page ${n} of 3`, { x: 500, y: 30, size: 9, font });
      page.drawText(`Chapter ${n}`, { x: 72, y: 700, size: 22, font: bold });
      const left = column(n),
        right = column(n + 40);
      left[0] = 'Left column opens ' + left[0].split(' ').slice(0, 2).join(' ');
      right[0] = 'Right column opens ' + right[0].split(' ').slice(0, 2).join(' ');
      left.forEach((line, k) => page.drawText(line, { x: 72, y: 650 - k * 14, size: 11, font }));
      right.forEach((line, k) => page.drawText(line, { x: 330, y: 650 - k * 14, size: 11, font }));
      // An underlined phrase below the columns.
      page.drawText('Important notice', { x: 72, y: 440, size: 11, font });
      page.drawLine({
        start: { x: 72, y: 438 },
        end: { x: 72 + font.widthOfTextAtSize('Important notice', 11), y: 438 },
        thickness: 0.6,
      });
      page.drawText(' applies to everyone reading this page today.', {
        x: 72 + font.widthOfTextAtSize('Important notice', 11),
        y: 440,
        size: 11,
        font,
      });
    }
    bytes2 = await doc.save();
    task2 = pdfjs.getDocument({ data: bytes2.slice(), verbosity: 0 });
    pdf2 = await task2.promise;
  });
  afterAll(() => task2?.destroy());

  it('reads the left column before the right one and finds running heads', async () => {
    const model = await analyzeDocument(pdf2, bytes2);
    const page = model.pages[0];
    expect(page.header.map((b) => b.runs.map((r) => r.text).join(''))).toEqual([
      'ACME Corp Annual Review',
    ]);
    expect(page.footer.map((b) => b.runs.map((r) => r.text).join(''))).toEqual(['Page 1 of 3']);
    const text = page.blocks.map((b) => b.runs?.map((r) => r.text).join('') || '').join('\n');
    inOrder(text, ['Chapter 1', 'Left column opens', 'Right column opens', 'Important notice']);
    const left = page.blocks.find((b) => b.runs?.[0]?.text.startsWith('Left column'));
    const right = page.blocks.find((b) => b.runs?.[0]?.text.startsWith('Right column'));
    expect(left.lineCount).toBe(12);
    expect(left.band).toMatchObject({ count: 2, index: 0 });
    expect(right.band).toMatchObject({ count: 2, index: 1, id: left.band.id });
    const notice = page.blocks.find((b) => b.runs?.[0]?.text === 'Important notice');
    expect(notice.runs[0].underline).toBe(true);
    expect(notice.runs[1].underline).toBe(false);
  });

  it('writes column sections, header and footer parts with page fields', async () => {
    const out = await exportDocument(pdf2, bytes2, 'docx');
    const files = await unzip(out.bytes);
    const docs = checkPackage(files);
    const document = docs['word/document.xml'];
    const cols = elements(document, 'w:cols').filter((c) => c.getAttribute('w:num') === '2');
    expect(cols.length).toBe(3);
    expect(
      elements(document, 'w:br').filter((b) => b.getAttribute('w:type') === 'column').length,
    ).toBe(3);
    const header = Object.keys(files).find((n) => /^word\/header\d+\.xml$/.test(n));
    const footer = Object.keys(files).find((n) => /^word\/footer\d+\.xml$/.test(n));
    expect(text(files[header])).toContain('ACME Corp Annual Review');
    const fields = elements(docs[footer], 'w:instrText').map((n) => n.textContent.trim());
    expect(fields).toEqual(['PAGE', 'NUMPAGES']);
    // Running heads are not repeated in the body.
    const body = elements(document, 'w:t')
      .map((t) => t.textContent)
      .join('');
    expect(body).not.toContain('ACME Corp Annual Review');
    const underlined = elements(document, 'w:r').filter((r) => elements(r, 'w:u').length);
    expect(underlined.map((r) => elements(r, 'w:t')[0].textContent)).toEqual([
      'Important notice',
      'Important notice',
      'Important notice',
    ]);
  });
});

it('lays out rotated pages in their displayed orientation', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.setRotation(degrees(90));
  page.drawText('Sideways heading', { x: 100, y: 700, size: 20, font });
  page.drawText('Body text below the heading on a rotated page.', {
    x: 100,
    y: 670,
    size: 11,
    font,
  });
  const bytes = await doc.save();
  const loading = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  const rotated = await loading.promise;
  try {
    const model = await analyzeDocument(rotated, bytes);
    expect(model.pages[0]).toMatchObject({ width: 792, height: 612 });
    const out = await exportDocument(rotated, bytes, 'docx');
    const files = await unzip(out.bytes);
    const docs = checkPackage(files);
    const size = elements(docs['word/document.xml'], 'w:pgSz')[0];
    expect(size.getAttribute('w:orient')).toBe('landscape');
    expect(
      elements(docs['word/document.xml'], 'w:t')
        .map((t) => t.textContent)
        .join(' '),
    ).toContain('Sideways heading');
  } finally {
    await loading.destroy();
  }
});

it('turns pictures the way their page shows them', async () => {
  // A landscape scan stored sideways and shown upright with /Rotate, the usual way scanners
  // write such pages: red on the picture's left, blue on its right.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.setRotation(degrees(90));
  const canvas = createCanvas(200, 100),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 100, 100);
  ctx.fillStyle = '#0000ff';
  ctx.fillRect(100, 0, 100, 100);
  page.drawImage(await doc.embedJpg(canvas.toBuffer('image/jpeg')), {
    x: 100,
    y: 300,
    width: 400,
    height: 200,
  });
  page.drawText('Caption text under the picture here.', { x: 100, y: 250, size: 11, font });
  const bytes = await doc.save();
  const loading = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  try {
    const pdf = await loading.promise;
    const out = await exportDocument(pdf, bytes, 'docx');
    const files = await unzip(out.bytes);
    const docs = checkPackage(files);
    const extent = elements(docs['word/document.xml'], 'wp:extent')[0];
    // Turned a quarter clockwise with its page: 200 by 400 points, red above blue.
    expect(Number(attr(extent, 'cx')) / Number(attr(extent, 'cy'))).toBeCloseTo(0.5, 2);
    const [name] = Object.keys(files).filter((file) => file.startsWith('word/media/'));
    const picture = await loadImage(Buffer.from(files[name]));
    expect([picture.width, picture.height]).toEqual([100, 200]);
    const view = createCanvas(100, 200).getContext('2d');
    view.drawImage(picture, 0, 0);
    const [top, bottom] = [50, 150].map((y) => [...view.getImageData(50, y, 1, 1).data]);
    expect(top[0]).toBeGreaterThan(200);
    expect(top[2]).toBeLessThan(60);
    expect(bottom[2]).toBeGreaterThan(200);
    expect(bottom[0]).toBeLessThan(60);
  } finally {
    await loading.destroy();
  }
});

it('reads right-to-left words drawn one at a time from the rightmost', async () => {
  // Hebrew set word by word, as many writers do: the first word is drawn rightmost. The font
  // draws Latin glyphs, but its ToUnicode map reads them as Hebrew letters.
  const letters = 'שלוםעולםטוב';
  const cmap =
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Hebrew def ' +
    '1 begincodespacerange <00> <FF> endcodespacerange ' +
    `${letters.length} beginbfchar ` +
    [...letters]
      .map(
        (c, i) => `<${(0x41 + i).toString(16)}> <${c.charCodeAt(0).toString(16).padStart(4, '0')}>`,
      )
      .join(' ') +
    ' endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 200]);
  const font = doc.context.register(
    doc.context.obj({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Helvetica',
      ToUnicode: doc.context.register(doc.context.stream(cmap)),
    }),
  );
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font } }));
  // Each word's codes run left to right on the page, so they are its letters reversed.
  const word = (from, count, x) =>
    `1 0 0 1 ${x} 100 Tm <${Array.from({ length: count }, (_, i) => (from + count - 1 - i).toString(16)).join('')}> Tj`;
  const content = `BT /F1 12 Tf ${word(0x41, 4, 300)} ${word(0x45, 4, 263.7)} ${word(0x49, 3, 243.4)} ET`;
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
  const bytes = await doc.save();
  const loading = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  try {
    const out = await exportDocument(await loading.promise, bytes, 'txt');
    expect(text(out.bytes)).toBe('שלום עולם טוב');
  } finally {
    await loading.destroy();
  }
});

it('keeps the numbers of an HTML list after a nested list and across pages', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [
    [
      [0, '1.', 'First step of the process'],
      [1, '•', 'A detail of the first step'],
      [1, '•', 'Another detail of it'],
      [0, '2.', 'Second step of the process'],
      [0, '3.', 'Third step of the process'],
    ],
    [[0, '4.', 'Fourth step of the process']],
  ];
  for (const items of pages) {
    const page = doc.addPage([612, 792]);
    items.forEach(([level, marker, line], k) => {
      const x = 80 + level * 24;
      page.drawText(marker, { x, y: 700 - k * 15, size: 11, font });
      page.drawText(line, { x: x + 16, y: 700 - k * 15, size: 11, font });
    });
  }
  const bytes = await doc.save();
  const loading = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  try {
    const html = text((await exportDocument(await loading.promise, bytes, 'html')).bytes);
    const parsed = new DOMParser().parseFromString(
      html.slice(html.indexOf('<body>'), html.indexOf('</body>') + 7),
      'text/html',
    );
    const [first, second] = elements(parsed, 'section');
    // One numbered list on the first page holds all three steps, the bullets nested in it.
    const lists = elements(first, 'ol');
    expect(lists).toHaveLength(1);
    expect(
      Array.from(lists[0].childNodes).map((item) => item.firstChild.textContent.trim()),
    ).toEqual([
      'First step of the process',
      'Second step of the process',
      'Third step of the process',
    ]);
    expect(elements(lists[0], 'ul')).toHaveLength(1);
    // The list goes on at 4 on the next page.
    expect(elements(second, 'ol')[0].getAttribute('start')).toBe('4');
  } finally {
    await loading.destroy();
  }
});

it('keeps text that looks like an Excel character escape as it reads', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([400, 200]).drawText('Column field_x0020_name', { x: 40, y: 100, size: 12, font });
  const bytes = await doc.save();
  const loading = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 });
  try {
    const files = await unzip((await exportDocument(await loading.promise, bytes, 'xlsx')).bytes);
    const strings = elements(parseXml(text(files['xl/sharedStrings.xml']), 'sst'), 't');
    // Excel turns "_x0020_" into a space unless its underscore is escaped as "_x005F_".
    expect(strings.map((t) => t.textContent)).toEqual(['Column field_x005F_x0020_name']);
  } finally {
    await loading.destroy();
  }
});
