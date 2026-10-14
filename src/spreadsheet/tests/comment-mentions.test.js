import { describe, expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { addComment, replyToThread, editThreadItem, getThread, copyThreads, pasteThreads, readComments, commentsJSON } from '../src/core/comments.js';
import {
  findMentions, remapMentions, mentionRuns, normalizeMentions, mentionIsOf, mentionAddress, mentionedPeople, mentionsOfPerson,
} from '../src/core/mentions.js';

const ANA = { name: 'ana', user: 'ana' };
const BEN = { name: 'Ben Ode', email: 'ben@example.com' };

describe('finding mentions in comment text', () => {
  it('finds each picked person where their @name stands, longer names first', () => {
    const text = '@ana and @Ben Ode, please check. Thanks @ana';
    const found = findMentions(text, [ANA, BEN, { name: 'Ben' }]);
    expect(found.map((m) => [m.name, m.start, m.length])).toEqual([['ana', 0, 4], ['Ben Ode', 9, 8], ['ana', 40, 4]]);
    expect(found[0].user).toBe('ana');
    expect(found[1].email).toBe('ben@example.com');
    for (const m of found) expect(text.slice(m.start, m.start + m.length)).toBe(`@${m.name}`);
    expect(new Set(found.map((m) => m.id)).size).toBe(3);
  });

  it('does not find a name inside a longer word or an address', () => {
    expect(findMentions('@anabel hi', [ANA])).toEqual([]);
    expect(findMentions('mail x@ana', [ANA])).toEqual([]);
  });

  it('takes a typed @address as a mention of that address', () => {
    const found = findMentions('Over to @Kim@Example.org.', []);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: 'kim@example.org', email: 'kim@example.org', start: 8, length: 16 });
  });

  it('keeps mentions through an edit where their @name still stands, and drops the others', () => {
    const before = findMentions('@ana and @Ben Ode', [ANA, BEN]);
    const after = remapMentions(before, 'Hi @Ben Ode, ana left');
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ name: 'Ben Ode', start: 3, id: before[1].id });
  });

  it('refuses mentions outside the text or overlapping one another', () => {
    expect(normalizeMentions([{ name: 'x', start: 5, length: 9 }], 'short')).toEqual([]);
    const two = normalizeMentions([{ name: 'ana', start: 0, length: 4 }, { name: 'an', start: 1, length: 2 }], '@ana');
    expect(two).toHaveLength(1);
  });

  it('splits text into runs for showing', () => {
    const text = 'Hey @ana!';
    expect(mentionRuns(text, findMentions(text, [ANA])).map((r) => [r.text, !!r.mention])).toEqual([['Hey ', false], ['@ana', true], ['!', false]]);
  });

  it('tells whom a mention is of, and where its email goes', () => {
    const [m] = findMentions('@ana', [ANA]);
    expect(mentionIsOf(m, { username: 'Ana' })).toBe(true);
    expect(mentionIsOf(m, { username: 'bob' })).toBe(false);
    expect(mentionAddress(m)).toBe('ana@puter.email');
    const [b] = findMentions('@Ben Ode', [BEN]);
    expect(mentionIsOf(b, { email: 'BEN@example.com' })).toBe(true);
    expect(mentionAddress(b)).toBe('ben@example.com');
    expect(mentionedPeople(findMentions('@ana @Ben Ode @ana', [ANA, BEN]))).toEqual([{ name: 'ana', user: 'ana' }, { name: 'Ben Ode', email: 'ben@example.com' }]);
  });
});

describe('mentions on comments', () => {
  it('are stored on the comment, undone with it, and serialized with the sheet', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const text = '@ana can you check this?';
    expect(addComment(wb, id, 1, 1, text, 'demo', null, { mentions: findMentions(text, [ANA]) })).toBe(true);
    const item = getThread(wb, id, 1, 1).items[0];
    expect(item.mentions).toEqual([expect.objectContaining({ name: 'ana', user: 'ana', start: 0, length: 4 })]);
    const back = readComments(commentsJSON(wb.sheet(id).comments));
    expect(back.get('1,1').items[0].mentions).toEqual(item.mentions);
    wb.undo();
    expect(getThread(wb, id, 1, 1)).toBeNull();
  });

  it('follow an edit and a reply, and get ids of their own when pasted', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    addComment(wb, id, 0, 0, 'Start', 'demo');
    const reply = '@Ben Ode see above';
    replyToThread(wb, id, 0, 0, reply, 'demo', null, { mentions: findMentions(reply, [BEN]) });
    const replyId = getThread(wb, id, 0, 0).items[1].id;
    editThreadItem(wb, id, 0, 0, replyId, 'Now @ana and @Ben Ode', { picked: [ANA] });
    const edited = getThread(wb, id, 0, 0).items[1];
    expect(edited.mentions.map((m) => m.name)).toEqual(['ana', 'Ben Ode']);
    const copied = copyThreads(wb, id, [0], [0]);
    pasteThreads(wb, id, copied, 3, 3);
    const pasted = getThread(wb, id, 3, 3).items[1];
    expect(pasted.mentions.map((m) => m.name)).toEqual(['ana', 'Ben Ode']);
    expect(pasted.mentions[0].id).not.toBe(edited.mentions[0].id);
  });

  it('lists the comments that mention someone, written by others', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    addComment(wb, id, 2, 2, '@ana look', 'demo', null, { mentions: findMentions('@ana look', [ANA]) });
    addComment(wb, id, 0, 0, '@ana note to self', 'ana', null, { mentions: findMentions('@ana note to self', [ANA]) });
    const found = mentionsOfPerson(wb, { username: 'ana' });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ sheetId: id, r: 2, c: 2 });
  });
});

describe('mentions in .xlsx threaded comments', () => {
  async function roundTrip(wb) {
    const bytes = await (await workbookToXlsx(wb)).arrayBuffer();
    return { bytes, back: await workbookFromFile(bytes, 'm.xlsx') };
  }

  it('write a <mentions> list naming persons, and read back the same mentions', async () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const text = '@ana and @Ben Ode: is B2 right?';
    addComment(wb, id, 1, 1, text, 'demo', new Date('2026-10-01T10:00:00Z'), { mentions: findMentions(text, [ANA, BEN]) });
    replyToThread(wb, id, 1, 1, 'Yes @demo', 'ana', null, { mentions: findMentions('Yes @demo', [{ name: 'demo', user: 'demo' }]) });
    const { bytes, back } = await roundTrip(wb);

    const zip = X.CFB.read(new Uint8Array(bytes), { type: 'array' });
    const read = (p) => new TextDecoder().decode(X.CFB.find(zip, p).content);
    const threaded = read('/xl/threadedComments/threadedComment1.xml');
    expect(threaded).toMatch(/<mentions><mention mentionpersonId="\{[0-9A-F-]+\}" mentionId="\{[0-9A-F-]+\}" startIndex="0" length="4"\/><mention [^>]*startIndex="9" length="8"\/><\/mentions>/);
    const persons = read('/xl/persons/person.xml');
    expect(persons).toContain('displayName="Ben Ode"');
    expect(persons).toContain('userId="ben@example.com"');
    // The author "ana" and the person mentioned as ana are one person.
    expect(persons.match(/displayName="ana"/g)).toHaveLength(1);

    const t = getThread(back, back.sheets[0].id, 1, 1);
    const original = getThread(wb, id, 1, 1);
    expect(t.items[0].mentions).toEqual(original.items[0].mentions);
    expect(t.items[1].mentions).toEqual([expect.objectContaining({ name: 'demo', user: 'demo', start: 4, length: 5 })]);
  });

  it('reads mentions of people known only by a directory id, with an address found in it', async () => {
    const { readThreadedCommentsXml, readXlsxPersons } = await import('../src/core/xlsx-threaded-comments.js');
    const persons = readXlsxPersons('<personList><person displayName="Jo Park" id="{11111111-1111-1111-1111-111111111111}" userId="S::jo.park@contoso.com::abc" providerId="AD"/></personList>');
    const xml = '<ThreadedComments><threadedComment ref="A1" id="{22222222-2222-2222-2222-222222222222}" personId="{11111111-1111-1111-1111-111111111111}">'
      + '<text>@Jo Park hello</text><mentions><mention mentionpersonId="{11111111-1111-1111-1111-111111111111}" mentionId="{33333333-3333-3333-3333-333333333333}" startIndex="0" length="8"/></mentions></threadedComment></ThreadedComments>';
    const threads = readThreadedCommentsXml(xml, persons);
    expect(threads['0,0'].items[0].mentions).toEqual([{ id: '{33333333-3333-3333-3333-333333333333}', name: 'Jo Park', email: 'jo.park@contoso.com', start: 0, length: 8 }]);
  });
});
