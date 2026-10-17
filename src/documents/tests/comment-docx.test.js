import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { initialsFor } from '../src/engine/comments.js';

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

  it('derives initials from the author name', () => {
    expect(initialsFor('Ada Lovelace')).toBe('AL');
    expect(initialsFor('plato')).toBe('PL');
    expect(initialsFor('')).toBe('');
  });
});
