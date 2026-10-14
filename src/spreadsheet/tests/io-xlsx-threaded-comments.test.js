import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { addComment, replyToThread, setThreadResolved, getThread } from '../src/core/comments.js';
import { readThreadedCommentsXml, readXlsxPersons } from '../src/core/xlsx-threaded-comments.js';

const parser = new (new JSDOM('').window.DOMParser)();
const TC = 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments';
const T0 = new Date('2026-10-09T10:00:00Z'), T1 = new Date('2026-10-09T11:30:15.250Z');

function parts(bytes) {
  const zip = X.CFB.read(new Uint8Array(bytes), { type: 'array' });
  const read = (path) => { const f = X.CFB.find(zip, path); return f ? new TextDecoder().decode(f.content) : null; };
  return { zip, read };
}

async function sample() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Revenue');
  wb.setInput(id, 1, 1, '42');
  addComment(wb, id, 1, 1, 'Is this <right> & final? _x0041_', 'Ada Lovelace', T0);
  replyToThread(wb, id, 1, 1, '@Ada yes\nchecked twice', 'Grace Hopper', T1);
  replyToThread(wb, id, 1, 1, 'Thanks', 'Ada Lovelace', T1);
  addComment(wb, id, 4, 2, 'Resolved one', 'Grace Hopper', T0);
  setThreadResolved(wb, id, 4, 2, true);
  wb.setNote(id, 0, 0, 'A plain note');
  return wb;
}

it('writes threaded comments, persons, legacy notes, relationships and content types', async () => {
  const bytes = await (await workbookToXlsx(await sample())).arrayBuffer();
  const { read } = parts(bytes);
  const threaded = read('/xl/threadedComments/threadedComment1.xml');
  expect(threaded).toBeTruthy();
  const doc = parser.parseFromString(threaded, 'application/xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  const comments = [...doc.getElementsByTagNameNS(TC, 'threadedComment')];
  expect(comments.map((c) => c.getAttribute('ref'))).toEqual(['B2', 'B2', 'B2', 'C5']);
  const root = comments[0].getAttribute('id');
  expect(comments[1].getAttribute('parentId')).toBe(root);
  expect(comments[2].getAttribute('parentId')).toBe(root);
  expect(comments[0].getAttribute('dT')).toBe('2026-10-09T10:00:00.00');
  expect(comments[1].getAttribute('dT')).toBe('2026-10-09T11:30:15.25');
  expect(comments[3].getAttribute('done')).toBe('1');
  expect(comments[0].hasAttribute('done')).toBe(false);
  expect(comments[0].textContent).toBe('Is this <right> & final? _x005F_x0041_');

  const persons = parser.parseFromString(read('/xl/persons/person.xml'), 'application/xml');
  const people = [...persons.getElementsByTagNameNS(TC, 'person')];
  expect(people.map((p) => p.getAttribute('displayName')).sort()).toEqual(['Ada Lovelace', 'Grace Hopper']);
  const ids = new Set(people.map((p) => p.getAttribute('id')));
  for (const c of comments) expect(ids.has(c.getAttribute('personId'))).toBe(true);
  for (const p of people) expect(p.getAttribute('providerId')).toBe('None');

  expect(read('/xl/worksheets/_rels/sheet1.xml.rels')).toMatch(/Type="http:\/\/schemas.microsoft.com\/office\/2017\/10\/relationships\/threadedComment" Target="..\/threadedComments\/threadedComment1.xml"/);
  expect(read('/xl/_rels/workbook.xml.rels')).toMatch(/relationships\/person" Target="persons\/person.xml"/);
  const types = read('/[Content_Types].xml');
  expect(types).toContain('PartName="/xl/threadedComments/threadedComment1.xml" ContentType="application/vnd.ms-excel.threadedcomments+xml"');
  expect(types).toContain('PartName="/xl/persons/person.xml" ContentType="application/vnd.ms-excel.person+xml"');

  // The legacy note for older readers: authored after the thread, with the conversation in it.
  const legacy = read('/xl/comments1.xml');
  expect(legacy).toContain(`<author>tc=${root}</author>`);
  expect(legacy).toMatch(new RegExp(`<comment ref="B2" authorId="\\d+" shapeId="0" xr:uid="${root.replace(/[{}]/g, '\\$&')}">`));
  expect(legacy).toContain('mc:Ignorable="xr"');
  expect(legacy).toMatch(/<comment ref="A1" authorId="\d+">/);
  expect(legacy).toContain('[Threaded comment]');
  expect(legacy).toMatch(/Comment:\s+Is this &lt;right&gt; &amp; final\?[\s\S]*Reply:\s+@Ada yes/);
  expect(legacy).toContain('A plain note');
});

it('reads its own threads back exactly, beside the plain note', async () => {
  const wb = await sample();
  const id = wb.activeSheetId;
  const back = await workbookFromFile(await workbookToXlsx(wb), 'threads.xlsx');
  const sid = back.activeSheetId;
  const t = getThread(back, sid, 1, 1);
  expect(t).toEqual(getThread(wb, id, 1, 1));
  expect(getThread(back, sid, 4, 2)).toMatchObject({ done: true, items: [{ text: 'Resolved one', author: 'Grace Hopper' }] });
  expect(back.getNote(sid, 1, 1)).toBeNull();
  expect(back.getNote(sid, 0, 0)).toBe('A plain note');
  // And again: a second save keeps them.
  const again = await workbookFromFile(await workbookToXlsx(back), 'again.xlsx');
  expect(getThread(again, again.activeSheetId, 1, 1)).toEqual(t);
});

it('reads a threadedComments part as Excel writes it', () => {
  const persons = readXlsxPersons(`<?xml version="1.0"?><personList xmlns="${TC}" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
    <person displayName="Jane Doe" id="{11111111-2222-3333-4444-555555555555}" userId="S::jane@example.com::abc" providerId="AD"/></personList>`);
  const threads = readThreadedCommentsXml(`<?xml version="1.0"?><ThreadedComments xmlns="${TC}" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
    <threadedComment ref="D7" dT="2024-02-01T09:15:42.31" personId="{11111111-2222-3333-4444-555555555555}" id="{AAAAAAAA-0000-0000-0000-000000000001}" done="1"><text>First &amp; foremost <![CDATA[<raw>]]></text><mentions><mention mentionpersonId="{11111111-2222-3333-4444-555555555555}" mentionId="{BBBBBBBB-0000-0000-0000-000000000001}" startIndex="0" length="3"/></mentions></threadedComment>
    <threadedComment ref="D7" dT="2024-02-01T09:20:00.00" personId="{11111111-2222-3333-4444-555555555555}" id="{AAAAAAAA-0000-0000-0000-000000000002}" parentId="{AAAAAAAA-0000-0000-0000-000000000001}"><text>Reply_x000D_</text></threadedComment>
    <!-- <threadedComment ref="Z1" id="{AAAAAAAA-0000-0000-0000-000000000009}"><text>fake</text></threadedComment> -->
  </ThreadedComments>`, persons);
  expect(Object.keys(threads)).toEqual(['6,3']);
  expect(threads['6,3']).toEqual({ done: true, items: [
    { id: '{AAAAAAAA-0000-0000-0000-000000000001}', author: 'Jane Doe', time: '2024-02-01T09:15:42.310Z', text: 'First & foremost <raw>', userId: 'S::jane@example.com::abc', providerId: 'AD',
      // Its <mentions> name the person mentioned, whose address is read from their directory id.
      mentions: [{ id: '{BBBBBBBB-0000-0000-0000-000000000001}', name: 'Jane Doe', email: 'jane@example.com', start: 0, length: 3 }] },
    { id: '{AAAAAAAA-0000-0000-0000-000000000002}', author: 'Jane Doe', time: '2024-02-01T09:20:00.000Z', text: 'Reply\r', userId: 'S::jane@example.com::abc', providerId: 'AD' },
  ] });
});

it('imports a file whose threads another writer made, replacing the note the reader made of them', async () => {
  const book = X.utils.book_new(), sheet = X.utils.aoa_to_sheet([['Data']]);
  sheet.A1.c = [{ a: 'Person One', t: 'Root text', T: true }, { a: 'Person Two', t: 'Reply text', T: true }];
  X.utils.book_append_sheet(book, sheet, 'Data');
  const bytes = new Uint8Array(X.write(book, { type: 'array', bookType: 'xlsx' }));
  const wb = await workbookFromFile(bytes, 'other.xlsx');
  const t = getThread(wb, wb.activeSheetId, 0, 0);
  expect(t.items.map((i) => [i.author, i.text])).toEqual([['Person One', 'Root text'], ['Person Two', 'Reply text']]);
  expect(wb.getNote(wb.activeSheetId, 0, 0)).toBeNull();
});
