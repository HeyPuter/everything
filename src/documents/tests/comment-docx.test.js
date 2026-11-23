import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { initialsFor } from '../src/engine/comments.js';
import { revisionTime, revisionTimes } from '../src/engine/revisions.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml';

/** An independently written package: two paragraphs, a ranged comment with a reply, and a point comment. */
function commentedDocx({ extended = true } = {}) {
  const types = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>${extended ? '<Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/>' : ''}</Types>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>${extended ? '<Relationship Id="rId2" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>' : ''}</Relationships>`;
  const document = `<w:document xmlns:w="${W}"><w:body>`
    + `<w:p><w:r><w:t xml:space="preserve">The quick </w:t></w:r><w:commentRangeStart w:id="3"/><w:commentRangeStart w:id="4"/><w:r><w:t>brown</w:t></w:r><w:commentRangeEnd w:id="3"/><w:r><w:commentReference w:id="3"/></w:r><w:commentRangeEnd w:id="4"/><w:r><w:commentReference w:id="4"/></w:r><w:r><w:t xml:space="preserve"> fox.</w:t></w:r></w:p>`
    + `<w:p><w:r><w:t xml:space="preserve">Second </w:t></w:r><w:r><w:commentReference w:id="7"/></w:r><w:r><w:t>line</w:t></w:r></w:p>`
    + `<w:sectPr/></w:body></w:document>`;
  const comments = `<w:comments xmlns:w="${W}" xmlns:w14="${W14}">`
    + `<w:comment w:id="3" w:author="Ada Lovelace" w:initials="AL" w:date="2026-01-02T03:04:05Z"><w:p w14:paraId="1A2B3C4D"><w:r><w:annotationRef/></w:r><w:r><w:t>Which brown?</w:t></w:r></w:p></w:comment>`
    + `<w:comment w:id="4" w:author="Grace Hopper" w:initials="GH" w:date="2026-01-03T00:00:00Z"><w:p w14:paraId="2B3C4D5E"><w:r><w:t>Chestnut.</w:t></w:r></w:p></w:comment>`
    + `<w:comment w:id="7" w:author="Ada Lovelace" w:initials="AL"><w:p w14:paraId="3C4D5E6F"><w:r><w:t>First</w:t></w:r></w:p><w:p w14:paraId="4D5E6F70"><w:r><w:t>Second</w:t><w:tab/><w:t>para</w:t></w:r></w:p></w:comment>`
    + `</w:comments>`;
  const ext = `<w15:commentsEx xmlns:w15="${W15}"><w15:commentEx w15:paraId="1A2B3C4D" w15:done="0"/><w15:commentEx w15:paraId="2B3C4D5E" w15:paraIdParent="1A2B3C4D" w15:done="0"/><w15:commentEx w15:paraId="4D5E6F70" w15:done="1"/></w15:commentsEx>`;
  const files = {
    '[Content_Types].xml': types,
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': rels, 'word/document.xml': document, 'word/comments.xml': comments,
    ...(extended ? { 'word/commentsExtended.xml': ext } : {}),
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

const open = async bytes => { const pkg = await DocxPackage.open(bytes); return { pkg, model: new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { comments: pkg.comments }) }; };
const save = async (pkg, d) => new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets, undefined, d.comments).arrayBuffer());

describe('DOCX comments', () => {
  it('removes a deleted comment\'s reference from the paragraph after its range', async () => {
    // Some producers put the reference run at the start of the next paragraph, which is saved as it was read.
    const body = `<w:p><w:commentRangeStart w:id="3"/><w:r><w:t>brown</w:t></w:r><w:commentRangeEnd w:id="3"/></w:p>`
      + `<w:p><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="3"/></w:r><w:r><w:t>fox</w:t><w:commentReference w:id="7"/></w:r></w:p>`;
    const parts = unzipSync(commentedDocx());
    parts['word/document.xml'] = strToU8(`<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`);
    const { pkg, model } = await open(zipSync(parts));
    // Untouched, the reference stays where it was.
    expect(strFromU8(unzipSync(await save(pkg, model))['word/document.xml'])).toContain('<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="3"/></w:r>');
    model.deleteComment('3');
    let xml = strFromU8(unzipSync(await save(pkg, model))['word/document.xml']);
    expect(xml).not.toMatch(/w:id="3"/);
    expect(xml).toContain('<w:p><w:r><w:t>fox</w:t><w:commentReference w:id="7"/></w:r></w:p>');
    model.deleteComment('7');
    xml = strFromU8(unzipSync(await save(pkg, model))['word/document.xml']);
    expect(xml).not.toMatch(/comment(Reference|RangeStart|RangeEnd)/);
    expect(xml).toMatch(/<w:p><w:r><w:t[^>]*>fox<\/w:t><\/w:r><\/w:p>/);
  });

  it('opens a commented document for editing with anchors, replies, resolved state and text', async () => {
    const { pkg, model } = await open(commentedDocx());
    expect(pkg.readOnly).toBeFalsy();
    expect(model.text).toBe('The quick brown fox.\nSecond line');
    const list = model.commentList;
    expect(list.map(c => [c.id, c.author, c.parentId, c.done])).toEqual([['3', 'Ada Lovelace', null, false], ['4', 'Grace Hopper', '3', false], ['7', 'Ada Lovelace', null, true]]);
    expect(model.text.slice(list[0].start, list[0].end)).toBe('brown');
    expect(list[2].start).toBe(list[2].end);
    expect(model.text.slice(0, list[2].start)).toBe('The quick brown fox.\nSecond ');
    expect(list[2].text).toBe('First\nSecond\tpara');
  });

  it('saves an untouched document byte for byte', async () => {
    const source = commentedDocx(), { pkg, model } = await open(source);
    expect(unzipSync(await save(pkg, model))).toEqual(unzipSync(source));
  });

  it('keeps anchors on their text through edits and round trips', async () => {
    const { pkg, model } = await open(commentedDocx());
    model.select(0); model.replace('Oh, ');
    model.select(model.text.indexOf('brown') + 2); model.replace('ight-');
    expect(model.text.slice(model.commentList[0].start, model.commentList[0].end)).toBe('bright-own');
    const again = await open(await save(pkg, model));
    expect(again.model.text).toBe(model.text);
    const c = again.model.commentList[0];
    expect(again.model.text.slice(c.start, c.end)).toBe('bright-own');
    expect(again.model.commentList.map(x => [x.id, x.parentId, x.done, x.text])).toEqual(model.commentList.map(x => [x.id, x.parentId, x.done, x.text]));
  });

  it('adds, replies to, edits, resolves and deletes comments with undo', async () => {
    const { pkg, model } = await open(commentedDocx({ extended: false }));
    expect(model.commentList.every(c => !c.parentId)).toBe(true);
    model.select(model.text.indexOf('fox'), model.text.indexOf('fox') + 3);
    const id = model.addComment({ author: 'Katherine Johnson', text: 'Animal?' });
    expect(model.comments.find(c => c.id === id).initials).toBe('KJ');
    const reply = model.replyToComment(id, { author: 'Ada Lovelace', text: 'Yes.' });
    model.editComment(id, 'An animal?');
    model.setCommentDone(reply, true);
    expect(model.comments.filter(c => [id, reply].includes(c.id)).every(c => c.done)).toBe(true);
    let again = await open(await save(pkg, model));
    let mine = again.model.commentList.find(c => c.id === id);
    expect(again.model.text.slice(mine.start, mine.end)).toBe('fox');
    expect(mine.text).toBe('An animal?');
    expect(again.model.commentList.find(c => c.id === reply)).toMatchObject({ parentId: id, done: true, text: 'Yes.', author: 'Ada Lovelace' });
    model.deleteComment(id);
    expect(model.comments.some(c => c.id === id || c.id === reply)).toBe(false);
    again = await open(await save(pkg, model));
    expect(again.model.commentList.map(c => c.id)).toEqual(['3', '4', '7']);
    model.undo();
    expect(model.comments.some(c => c.id === id)).toBe(true);
    model.deleteAllComments();
    const bytes = await save(pkg, model), parts = unzipSync(bytes);
    expect(strFromU8(parts['word/document.xml'])).not.toMatch(/comment/);
    expect((await open(bytes)).model.commentList).toEqual([]);
  });

  it('deletes a resolved thread\'s replies with it when only its first comment is marked done', async () => {
    // A resolved thread as Word writes it: done on the thread's first comment, not on its replies.
    const parts = unzipSync(commentedDocx());
    parts['word/commentsExtended.xml'] = strToU8(`<w15:commentsEx xmlns:w15="${W15}"><w15:commentEx w15:paraId="1A2B3C4D" w15:done="1"/><w15:commentEx w15:paraId="2B3C4D5E" w15:paraIdParent="1A2B3C4D" w15:done="0"/><w15:commentEx w15:paraId="4D5E6F70" w15:done="0"/></w15:commentsEx>`);
    const { pkg, model } = await open(zipSync(parts));
    expect(model.commentList.map(c => [c.id, c.rootId, c.done])).toEqual([['3', '3', true], ['4', '3', false], ['7', '7', false]]);
    expect(model.deleteAllComments({ resolvedOnly: true })).toBe(true);
    expect(model.commentList.map(c => c.id)).toEqual(['7']);
    const again = await open(await save(pkg, model));
    expect(again.model.commentList.map(c => [c.id, c.text])).toEqual([['7', 'First\nSecond\tpara']]);
    expect(strFromU8(unzipSync(await save(pkg, model))['word/document.xml'])).not.toMatch(/w:id="[34]"/);
  });

  it('anchors a caret comment to the surrounding word', async () => {
    const { model } = await open(commentedDocx());
    model.select(model.text.indexOf('fox') + 1);
    const id = model.addComment({ author: 'Me', text: 'x' });
    const c = model.commentList.find(x => x.id === id);
    expect(model.text.slice(c.start, c.end)).toBe('fox');
  });

  it('creates the comments part, relationship and content type in a document without one', async () => {
    const bare = unzipSync(commentedDocx());
    for (const name of ['word/comments.xml', 'word/commentsExtended.xml']) delete bare[name];
    bare['word/_rels/document.xml.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
    bare['word/document.xml'] = strToU8(`<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Hello world</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
    const { pkg, model } = await open(zipSync(bare));
    expect(model.comments).toEqual([]);
    model.select(0, 5); model.addComment({ author: 'Me', text: 'Greeting' });
    const parts = unzipSync(await save(pkg, model));
    expect(strFromU8(parts['word/_rels/document.xml.rels'])).toMatch(/relationships\/comments" Target="comments.xml"/);
    expect(strFromU8(parts['[Content_Types].xml'])).toMatch(/\/word\/comments.xml/);
    const reopened = await open(zipSync(parts));
    expect(reopened.model.commentList[0]).toMatchObject({ author: 'Me', initials: 'ME', text: 'Greeting', start: 0, end: 5 });
  });

  it('regenerates an unreadable commentsExtended companion instead of failing every save', async () => {
    const parts = unzipSync(commentedDocx());
    parts['word/commentsExtended.xml'] = strToU8(`<w15:commentsEx xmlns:w15="${W15}"><w15:commentEx`);
    const { pkg, model } = await open(zipSync(parts));
    const id = model.commentList[0].id;
    const reply = model.replyToComment(id, { author: 'Me', text: 'Agreed.' });
    const saved = unzipSync(await save(pkg, model));
    expect(new DOMParser().parseFromString(strFromU8(saved['word/commentsExtended.xml']), 'application/xml').getElementsByTagName('parsererror')).toHaveLength(0);
    const reopened = await open(zipSync(saved));
    expect(reopened.model.comments.find(c => c.id === reply)).toMatchObject({ text: 'Agreed.', parentId: id });
  });

  // Word writes w:date in local time with a "Z" it ignores ([MS-OI29500] 2.1.313), and the UTC time in
  // commentsExtensible (comments) and w16du:dateUtc (changes). Read as UTC, a comment made just now in Word by someone
  // west of Greenwich showed as hours old, and one made east of it as in the future.
  it('takes a comment\'s and a change\'s time from the UTC time Word writes beside w:date', async () => {
    const parts = unzipSync(commentedDocx());
    const CID = 'http://schemas.microsoft.com/office/word/2016/wordml/cid', CEX = 'http://schemas.microsoft.com/office/word/2018/wordml/cex', DU = 'http://schemas.microsoft.com/office/word/2023/wordml/word16du';
    parts['word/commentsIds.xml'] = strToU8(`<w16cid:commentsIds xmlns:w16cid="${CID}"><w16cid:commentId w16cid:paraId="1A2B3C4D" w16cid:durableId="11111111"/><w16cid:commentId w16cid:paraId="2B3C4D5E" w16cid:durableId="22222222"/></w16cid:commentsIds>`);
    parts['word/commentsExtensible.xml'] = strToU8(`<w16cex:commentsExtensible xmlns:w16cex="${CEX}"><w16cex:commentExtensible w16cex:durableId="11111111" w16cex:dateUtc="2026-01-02T11:04:05Z"/></w16cex:commentsExtensible>`);
    parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']).replace('</Relationships>', '<Relationship Id="rId8" Type="http://schemas.microsoft.com/office/2016/09/relationships/commentsIds" Target="commentsIds.xml"/><Relationship Id="rId9" Type="http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible" Target="commentsExtensible.xml"/></Relationships>'));
    parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace(`<w:document xmlns:w="${W}">`, `<w:document xmlns:w="${W}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:w16du="${DU}" mc:Ignorable="w16du">`)
      .replace('<w:r><w:t>line</w:t></w:r>', `<w:ins w:id="90" w:author="Ada Lovelace" w:date="2026-01-04T01:00:00Z" w16du:dateUtc="2026-01-04T09:00:00Z"><w:r><w:t>line</w:t></w:r></w:ins>`));
    const source = zipSync(parts), { pkg, model } = await open(source);
    expect(model.comments.map(c => [c.id, c.date, c.dateUtc])).toEqual([['3', '2026-01-02T03:04:05Z', '2026-01-02T11:04:05Z'], ['4', '2026-01-03T00:00:00Z', undefined], ['7', '', undefined]]);
    expect(revisionTime(model.commentList[0])).toBe(Date.parse('2026-01-02T11:04:05Z'));
    // Without a UTC time, w:date is what there is.
    expect(revisionTime(model.comments[1])).toBe(Date.parse('2026-01-03T00:00:00Z'));
    expect(model.revisions.map(r => [r.type, revisionTime(r)])).toEqual([['ins', Date.parse('2026-01-04T09:00:00Z')]]);
    // Read, nothing changes in the file.
    expect(unzipSync(await save(pkg, model))).toEqual(unzipSync(source));
  });

  // Comments and changes made here were saved with a UTC w:date, which Word reads as local time: they showed shifted
  // by the reader's time zone. They are saved as Word saves them: w:date in local time, and the UTC time beside it.
  it('saves a comment\'s and a change\'s time as local w:date with its UTC companion, and reads both back', async () => {
    const at = new Date(2026, 10, 23, 9, 5, 7);
    expect(revisionTimes(at)).toEqual({ date: '2026-11-23T09:05:07', dateUtc: at.toISOString().replace(/\.\d+Z$/, 'Z') });
    const { pkg, model } = await open(commentedDocx());
    model.select(0, 3); const id = model.addComment({ author: 'Ann', text: 'New' });
    model.replyToComment(id, { author: 'Bob', text: 'Re' });
    model.trackChanges = true; model.revisionAuthor = 'Ann'; model.select(4); model.replace('very ');
    const made = model.comments.filter(c => ['New', 'Re'].includes(c.text));
    for (const item of [...made, model.revisions[0]]) {
      expect(item.date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/);
      expect(Date.parse(item.date)).toBe(Date.parse(item.dateUtc));
    }
    const saved = unzipSync(await save(pkg, model));
    const xml = name => strFromU8(saved[name]);
    expect(xml('word/comments.xml')).toContain(`w:date="${made[0].date}"`);
    expect(xml('word/document.xml')).toMatch(new RegExp(`<w:ins w:id="\\d+" w:author="Ann" w:date="${model.revisions[0].date}" w16du:dateUtc="${model.revisions[0].dateUtc}">`));
    expect(xml('word/document.xml')).toMatch(/^<w:document [^>]*xmlns:w16du="http:\/\/schemas.microsoft.com\/office\/word\/2023\/wordml\/word16du"[^>]*mc:Ignorable="w16du"/);
    expect(xml('word/commentsExtensible.xml').match(/w16cex:dateUtc="[^"]+"/g)).toEqual([`w16cex:dateUtc="${made[0].dateUtc}"`, `w16cex:dateUtc="${made[1].dateUtc}"`]);
    expect(xml('word/commentsIds.xml').match(/<w16cid:commentId /g)).toHaveLength(2);
    expect(xml('[Content_Types].xml')).toContain('<Override PartName="/word/commentsIds.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml"/>');
    expect(xml('[Content_Types].xml')).toContain('<Override PartName="/word/commentsExtensible.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtensible+xml"/>');
    expect(xml('word/_rels/document.xml.rels')).toMatch(/Type="http:\/\/schemas.microsoft.com\/office\/2016\/09\/relationships\/commentsIds" Target="commentsIds.xml"/);
    expect(xml('word/_rels/document.xml.rels')).toMatch(/Type="http:\/\/schemas.microsoft.com\/office\/2018\/08\/relationships\/commentsExtensible" Target="commentsExtensible.xml"/);
    // Read back exactly, and saved again unchanged.
    const again = await open(zipSync(saved));
    expect(again.model.comments.map(c => [c.text, c.date, c.dateUtc])).toEqual(model.comments.map(c => [c.text, c.date, c.dateUtc]));
    expect(again.model.revisions.map(r => [r.type, r.date, r.dateUtc])).toEqual(model.revisions.map(r => [r.type, r.date, r.dateUtc]));
    expect(unzipSync(await save(again.pkg, again.model))).toEqual(saved);
  });

  it('derives initials from the author name', () => {
    expect(initialsFor('Ada Lovelace')).toBe('AL');
    expect(initialsFor('plato')).toBe('PL');
    expect(initialsFor('')).toBe('');
  });
});
