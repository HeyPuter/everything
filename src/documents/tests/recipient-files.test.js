import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { parseDelimited, detectDelimiter, rowsToList, readWorkbook, readRecipientFile, columnIndex, serialDate, listToCsv } from '../src/lib/recipient-files.js';
import { emlMessage, plainText, documentHtml, emlName, EMAIL_PATTERN } from '../src/lib/mail-messages.js';
import { TextDocument, paragraph } from '../src/engine/model.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const file = (name, data) => new File([data], name);

describe('delimited text', () => {
  it('parses quotes, embedded delimiters and line breaks, and a byte order mark', async () => {
    const list = await readRecipientFile(file('people.csv', readFileSync('tests/fixtures/mail-merge/recipients.csv')));
    expect(list.columns).toEqual(['Title', 'First Name', 'Last Name', 'Company', 'Address Line 1', 'City', 'State', 'ZIP Code', 'Country', 'Email']);
    expect(list.rows).toHaveLength(3);
    expect(list.rows[0].values[3]).toBe('Tide Works, Ltd.');
    expect(list.rows[1].values[4]).toBe('9 Elm St\nApt 4');
    expect(list.rows[2].values[2]).toBe('Silva "Nana"');
    expect(list.rows.every(r => r.included)).toBe(true);
  });
  it('leaves delimiters inside quoted values out of the guess, and follows a sep= line', async () => {
    const quoted = 'Email,Interests\nann@example.com,"tea; coffee; cake"\nbob@example.com,"golf; tennis"\n';
    expect(detectDelimiter(quoted)).toBe(',');
    const list = await readRecipientFile(file('list.csv', quoted));
    expect(list.columns).toEqual(['Email', 'Interests']);
    expect(list.rows.map(r => r.values)).toEqual([['ann@example.com', 'tea; coffee; cake'], ['bob@example.com', 'golf; tennis']]);
    const hinted = await readRecipientFile(file('excel.csv', '\uFEFFsep=;\nName;City, Country\nAnn;Oslo, Norway\n'));
    expect(hinted.columns).toEqual(['Name', 'City, Country']);
    expect(hinted.rows.map(r => r.values)).toEqual([['Ann', 'Oslo, Norway']]);
  });
  it('detects tabs and semicolons and names blank or repeated headings', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(parseDelimited('a;"b;c"\r\n1;2\r\n\r\n', ';')).toEqual([['a', 'b;c'], ['1', '2']]);
    expect(rowsToList([['Name', '', 'name'], ['x', 'y', 'z', 'extra']]).columns).toEqual(['Name', 'Column 2', 'name 2', 'Column 4']);
    expect(() => rowsToList([])).toThrow('no rows');
  });
  it('round-trips a list through CSV', () => {
    const list = { columns: ['Name', 'Note'], rows: [{ values: ['A, B', 'say "hi"'], included: true }] };
    expect(parseDelimited(listToCsv(list))).toEqual([['Name', 'Note'], ['A, B', 'say "hi"']]);
  });
  it('reads Excel ANSI CSV and Unicode Text, and refuses binary files', async () => {
    const ansi = new Uint8Array([...strToU8('Name,City\r\nJos'), 0xe9, ...strToU8(',M'), 0xfc, ...strToU8('nchen\r\n')]);
    expect((await readRecipientFile(file('list.csv', ansi))).rows[0].values).toEqual(['José', 'München']);
    const text = '﻿Name\tCity\r\nJosé\tMünchen\r\n', utf16 = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) { utf16[2 * i] = text.charCodeAt(i) & 255; utf16[2 * i + 1] = text.charCodeAt(i) >> 8; }
    const unicode = await readRecipientFile(file('list.txt', utf16));
    expect(unicode.columns).toEqual(['Name', 'City']);
    expect(unicode.rows[0].values).toEqual(['José', 'München']);
    const docx = zipSync({ 'word/document.xml': strToU8('<w:document/>') });
    await expect(readRecipientFile(file('letter.docx', docx))).rejects.toThrow('not a recipient list');
    await expect(readRecipientFile(file('photo.csv', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13])))).rejects.toThrow('not a recipient list');
  });
});

describe('workbooks', () => {
  it('reads shared and inline strings, dates, booleans and gaps from the first sheet', async () => {
    const list = await readRecipientFile(file('contacts.xlsx', readFileSync('tests/fixtures/mail-merge/recipients.xlsx')));
    expect(list.columns).toEqual(['First Name', 'Last Name', 'City', 'Ship Date', 'Member', 'Balance']);
    expect(list.rows.map(r => r.values)).toEqual([
      ['Rosa', 'Vidal', 'Oslo', '2026-03-01', 'TRUE', '1234.5'],
      ['Ken', 'Ito', 'Austin', '2026-03-02 12:00', 'FALSE', 'n/a'],
    ]);
    expect(list.sheets).toEqual(['Contacts']);
  });
  it('picks a sheet by index and rejects other spreadsheet formats', async () => {
    const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const sheet = rows => `<worksheet xmlns="${S}"><sheetData>${rows}</sheetData></worksheet>`;
    const bytes = zipSync({
      '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
      'xl/workbook.xml': strToU8(`<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="Empty" r:id="a"/><sheet name="People" r:id="b"/></sheets></workbook>`),
      'xl/_rels/workbook.xml.rels': strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="a" Type="${R}/worksheet" Target="sheets/one.xml"/><Relationship Id="b" Type="${R}/worksheet" Target="/xl/sheets/two.xml"/></Relationships>`),
      'xl/sheets/one.xml': strToU8(sheet('')),
      'xl/sheets/two.xml': strToU8(sheet('<row><c t="inlineStr"><is><t>Name</t></is></c><c t="str"><v>Total</v></c></row><row><c t="inlineStr"><is><t>Ana</t></is></c><c><v>0.1</v></c><c r="AB2"><v>3</v></c></row>')),
    });
    const sheets = readWorkbook(bytes);
    expect(sheets.map(s => s.name)).toEqual(['Empty', 'People']);
    expect(sheets[1].rows[1][27]).toBe('3');
    const list = await readRecipientFile(file('book.xlsx', bytes));
    expect(list.sheet).toBe(1);
    expect(list.rows[0].values.slice(0, 2)).toEqual(['Ana', '0.1']);
    await expect(readRecipientFile(file('old.xls', 'x'))).rejects.toThrow('.xlsx or .csv');
    expect(() => readWorkbook(new Uint8Array([1, 2, 3]))).toThrow('not a readable');
    expect(columnIndex('A')).toBe(0); expect(columnIndex('AB')).toBe(27);
    expect(serialDate(46082)).toBe('2026-03-01');
  });
  it('reads the escapes Excel writes for characters XML cannot hold', () => {
    // A carriage return in a cell is written _x000D_, and an underscore that would start an escape _x005F_.
    const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const bytes = zipSync({
      'xl/workbook.xml': strToU8(`<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="People" r:id="a"/></sheets></workbook>`),
      'xl/_rels/workbook.xml.rels': strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="a" Type="${R}/worksheet" Target="sheet.xml"/><Relationship Id="b" Type="${R}/sharedStrings" Target="strings.xml"/></Relationships>`),
      'xl/strings.xml': strToU8(`<sst xmlns="${S}"><si><t>Address</t></si><si><t>1 Pier Rd_x000D_\nUnit 4</t></si><si><r><t>code_x005F_x0041_</t></r><r><t>_x0041_</t></r></si></sst>`),
      'xl/sheet.xml': strToU8(`<worksheet xmlns="${S}"><sheetData><row><c t="s"><v>0</v></c><c t="inlineStr"><is><t>Code</t></is></c></row><row><c t="s"><v>1</v></c><c t="s"><v>2</v></c><c t="inlineStr"><is><t>tab_x0009_here</t></is></c></row></sheetData></worksheet>`),
    });
    expect(readWorkbook(bytes)[0].rows[1]).toEqual(['1 Pier Rd\r\nUnit 4', 'code_x0041_A', 'tab\there']);
  });
});

describe('email messages', () => {
  it('builds plain text, HTML and MIME messages from a model', () => {
    const d = new TextDocument([paragraph('Dear Rosa,'), paragraph('Line one\vline two <ok>')]);
    d.select(0, 4); d.setRunFormat({ bold: true });
    expect(plainText(d)).toBe('Dear Rosa,\nLine one\nline two <ok>\n');
    const html = documentHtml(d);
    expect(html).toContain('<p><b>Dear</b> Rosa,</p>');
    expect(html).toContain('Line one<br>line two &lt;ok&gt;');
    const eml = emlMessage({ to: 'rosa@example.com', subject: 'Größe', text: 'Hi', html: '<p>Hi</p>', date: new Date('2026-01-02T03:04:05Z') });
    expect(eml).toContain('To: rosa@example.com\r\nSubject: =?UTF-8?B?R3LDtsOfZQ==?=\r\n');
    expect(eml).toContain('Content-Type: multipart/alternative;');
    expect(eml).toContain('X-Unsent: 1');
    expect(emlMessage({ to: 'a@b.co\r\nBcc: x@y.z', text: 'x' })).toContain('To: a@b.coBcc: x@y.z\r\n');
    expect(emlName(3, 'a b@c.d')).toBe('003 a_b@c.d.eml');
    expect(EMAIL_PATTERN.test('a@b.co')).toBe(true); expect(EMAIL_PATTERN.test('a@b')).toBe(false);
  });
  it('leaves hidden text out of both bodies', () => {
    const d = new TextDocument([paragraph('Dear Rosa, (VIP list)')]);
    d.select(10, 21); d.setRunFormat({ vanish: true });
    expect(plainText(d)).toBe('Dear Rosa,\n');
    expect(documentHtml(d)).toContain('<p>Dear Rosa,</p>');
  });
});
