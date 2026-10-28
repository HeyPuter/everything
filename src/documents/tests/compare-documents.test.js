import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { tokenize, diffSequences, mergeDocuments, finalText, documentAuthor } from '../src/engine/compare.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
/** Independently written packages: body paragraphs and an optional two-cell table. */
function docx(body, { creator } = {}) {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' + (creator ? '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' : '') + '</Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' + (creator ? '<Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' : '') + '</Relationships>',
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
    ...(creator ? { 'docProps/core.xml': `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>${creator}</dc:creator></cp:coreProperties>` } : {}),
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}
const p = (text, extra = '') => `<w:p>${extra}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const table = cells => `<w:tbl><w:tblPr/><w:tblGrid>${cells[0].map(() => '<w:gridCol w:w="2000"/>').join('')}</w:tblGrid>${cells.map(row => `<w:tr>${row.map(c => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${p(c)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
const open = async bytes => DocxPackage.open(bytes);
const compare = async (a, b, options = {}) => {
  const original = await open(docx(a)), revised = await open(docx(b));
  const result = mergeDocuments({ paragraphs: revised.paragraphs, tables: revised.tables }, { paragraphs: original.paragraphs, tables: original.tables }, { author: 'Rev', date: '2026-02-03T04:05:06Z', ...options });
  const model = new TextDocument(result.paragraphs, revised.pageSettings, revised.numbering, revised.styles, result.tables, revised.assets);
  return { result, model, revised };
};
const changes = model => model.revisions.map(r => [r.type, model.text.slice(r.start, Math.min(r.end, model.text.length)) + (r.end > model.text.length ? '¶' : '')]);

describe('edit script', () => {
  it('tokenizes words, spaces and symbols, or graphemes', () => {
    expect(tokenize('Don’t stop—now!').map(t => t.text)).toEqual(['Don’t', ' ', 'stop', '—', 'now', '!']);
    expect(tokenize('re-use it').map(t => t.text)).toEqual(['re-use', ' ', 'it']);
    expect(tokenize('é👍🏽a', 'character').map(t => t.text)).toEqual(['é', '👍🏽', 'a']);
    expect(tokenize('a￼b').map(t => t.text)).toEqual(['a', '￼', 'b']);
  });

  it('finds a minimal script that turns one sequence into the other', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trial = 0; trial < 300; trial++) {
      const a = Array.from({ length: Math.floor(random() * 14) }, () => 'abcd'[Math.floor(random() * 4)]);
      const b = Array.from({ length: Math.floor(random() * 14) }, () => 'abcd'[Math.floor(random() * 4)]);
      const ops = diffSequences(a, b);
      const rebuilt = [];
      let edits = 0;
      for (const op of ops) {
        if (op.type === 'equal') { expect(a.slice(op.aStart, op.aEnd)).toEqual(b.slice(op.bStart, op.bEnd)); rebuilt.push(...a.slice(op.aStart, op.aEnd)); }
        if (op.type === 'insert') { rebuilt.push(...b.slice(op.bStart, op.bEnd)); edits += op.bEnd - op.bStart; }
        if (op.type === 'delete') edits += op.aEnd - op.aStart;
      }
      expect(rebuilt).toEqual(b);
      // Independent reference: the longest common subsequence by dynamic programming.
      const lcs = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
      for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) lcs[i][j] = a[i - 1] === b[j - 1] ? lcs[i - 1][j - 1] + 1 : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      expect(edits).toBe(a.length + b.length - 2 * lcs[a.length][b.length]);
    }
  });

  it('reports an over-long script as one replacement', () => {
    const ops = diffSequences([...'abcdef'], [...'uvwxyz'], undefined, { maxEdits: 2 });
    expect(ops.map(o => o.type)).toEqual(['delete', 'insert']);
  });

  it('keeps only the searched diagonals, so two long, very different texts take little memory', () => {
    const a = Array.from({ length: 20000 }, (_, i) => `old${i}`), b = Array.from({ length: 20000 }, (_, i) => `new${i}`);
    // Sample the memory held while the search runs: the trace is alive until it ends.
    const base = process.memoryUsage().arrayBuffers;
    let calls = 0, peak = 0;
    const equals = (x, y) => { if (++calls % 20000 === 0) peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); return x === y; };
    expect(diffSequences(a, b, equals).map(o => o.type)).toEqual(['delete', 'insert']);
    // Copying every diagonal for each of the 4,000 rounds held over a gigabyte here.
    expect(peak).toBeLessThan(200e6);
  });
});

describe('compare documents', () => {
  it('marks word changes in a paragraph, deletions before insertions', async () => {
    const { model } = await compare(p('The quick brown fox.'), p('The quick red fox jumps.'));
    expect(model.text).toBe('The quick brownred fox jumps.');
    expect(changes(model)).toEqual([['del', 'brown'], ['ins', 'red'], ['ins', ' jumps']]);
    expect(model.revisions.every(r => r.author === 'Rev')).toBe(true);
  });

  it('compares by character when asked', async () => {
    const { model } = await compare(p('colour'), p('color'), { granularity: 'character' });
    expect(changes(model)).toEqual([['del', 'u']]);
  });

  it('can ignore case changes', async () => {
    const { model } = await compare(p('Hello World'), p('hello world'), { caseChanges: false });
    expect(model.revisions).toEqual([]);
    const strict = await compare(p('Hello World'), p('hello world'));
    expect(changes(strict.model)).toEqual([['del', 'Hello'], ['ins', 'hello'], ['del', 'World'], ['ins', 'world']]);
  });

  it('marks inserted and deleted paragraphs whole', async () => {
    const { model } = await compare(p('One') + p('Two') + p('Three'), p('One') + p('Three') + p('Four'));
    expect(model.text).toBe('One\nTwo\nThree\nFour');
    expect(changes(model)).toEqual([['del', 'Two\n'], ['ins', '\nFour']]);
  });

  it('records formatting differences in otherwise equal text', async () => {
    const { model } = await compare(p('Plain words'), '<w:p><w:r><w:t xml:space="preserve">Plain </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>words</w:t></w:r></w:p>');
    expect(changes(model)).toEqual([['format', 'words']]);
    const off = await compare(p('Plain words'), '<w:p><w:r><w:t xml:space="preserve">Plain </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>words</w:t></w:r></w:p>', { formatting: false });
    expect(off.model.revisions).toEqual([]);
  });

  it('diffs table cells in place and keeps the revised table', async () => {
    const { model, result } = await compare(p('Intro') + table([['Alpha', 'Beta'], ['Gamma', 'Delta']]) + p('End'), p('Intro') + table([['Alpha', 'Bravo'], ['Gamma', 'Delta']]) + p('End'));
    expect(changes(model)).toEqual([['del', 'Beta'], ['ins', 'Bravo']]);
    expect(result.tables).toHaveLength(1);
    expect(model.paragraphs.filter(x => x.cellId)).toHaveLength(4);
  });

  it('places rows only in the original after the table as deleted text', async () => {
    const { model } = await compare(table([['A', 'B'], ['C', 'D']]) + p('End'), table([['A', 'B']]) + p('End'));
    expect(model.text).toBe('A\nB\nC\nD\nEnd');
    expect(changes(model)).toEqual([['del', 'C\nD\n']]);
  });

  it('accepts to the revised text and rejects to the original when the last paragraphs change', async () => {
    const cases = [[['Intro', 'Middle part', 'Old ending'], ['Intro text']], [['Intro', 'First old', 'Second old'], ['Intro', 'Brand new closing words']],
      [['Intro'], ['Intro', 'New one', 'New two']], [['Intro', 'Old one', 'Old two'], ['Intro']], [['Intro', 'Old'], ['Intro', 'New one', 'New two']]];
    // Seeded random documents whose paragraphs, the last ones included, are kept, rewritten, added or removed.
    let seed = 7;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const words = ['alpha', 'beta', 'gamma', 'delta', 'kept line', 'Intro'];
    const make = () => Array.from({ length: 1 + Math.floor(random() * 4) }, () => words[Math.floor(random() * words.length)] + (random() < 0.5 ? '' : ' end'));
    for (let n = 0; n < 40; n++) cases.push([make(), make()]);
    for (const [original, revised] of cases) {
      const { result, revised: pkg } = await compare(original.map(t => p(t)).join(''), revised.map(t => p(t)).join(''));
      const bytes = new Uint8Array(await pkg.export(result.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, result.tables, pkg.assets).arrayBuffer());
      for (const accept of [true, false]) {
        const reopened = await open(bytes), model = new TextDocument(reopened.paragraphs, reopened.pageSettings, reopened.numbering, reopened.styles, reopened.tables, reopened.assets);
        model.resolveRevisions(accept);
        expect(model.text, `${accept ? 'accept' : 'reject'} ${JSON.stringify([original, revised])}`).toBe((accept ? revised : original).join('\n'));
      }
    }
  });

  it('round-trips the comparison through DOCX with valid revision markup', async () => {
    const { result, revised } = await compare(p('Keep this line.') + p('Old ending.'), p('Keep this line!') + p('New ending.') + p('Added.'));
    const blob = revised.export(result.paragraphs, revised.pageSettings, revised.numbering, revised.styles, result.tables, revised.assets);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const xml = strFromU8(unzipSync(bytes)['word/document.xml']);
    expect(xml).toMatch(/<w:del w:id="\d+" w:author="Rev" w:date="2026-02-03T04:05:06Z"><w:r><w:delText xml:space="preserve">\.<\/w:delText><\/w:r><\/w:del><w:ins [^>]*><w:r><w:t xml:space="preserve">!<\/w:t>/);
    const reopened = await open(bytes);
    const model = new TextDocument(reopened.paragraphs, reopened.pageSettings, reopened.numbering, reopened.styles, reopened.tables, reopened.assets);
    expect(changes(model)).toEqual([['del', '.'], ['ins', '!'], ['del', 'Old'], ['ins', 'New'], ['ins', '\nAdded.']]);
    model.resolveRevisions(true);
    expect(model.text).toBe('Keep this line!\nNew ending.\nAdded.');
  });

  it('keeps revisions already in the base and visible text only for comparison', async () => {
    const tracked = '<w:p><w:r><w:t xml:space="preserve">Kept </w:t></w:r><w:del w:id="1" w:author="Ada" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:t xml:space="preserve"> text</w:t></w:r></w:p>';
    const { model } = await compare(p('Kept  text more'), tracked);
    expect(changes(model)).toEqual([['del', 'gone'], ['del', ' more']]);
    expect(model.revisions.map(r => r.author)).toEqual(['Ada', 'Rev']);
  });
});

it('keeps the comment, bookmark and field of a last paragraph that joins a removed one', async () => {
  const W16 = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files = unzipSync(docx(p('Intro') + '<w:p><w:commentRangeStart w:id="0"/><w:r><w:t xml:space="preserve">Brand new close by </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> AUTHOR </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Ada</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r><w:bookmarkStart w:id="5" w:name="Closing"/><w:bookmarkEnd w:id="5"/></w:p>'));
  files['word/_rels/document.xml.rels'] = strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="${W16}/comments" Target="comments.xml"/></Relationships>`);
  files['word/comments.xml'] = strToU8(`<w:comments xmlns:w="${W}"><w:comment w:id="0" w:author="Ada"><w:p><w:r><w:t>Check this</w:t></w:r></w:p></w:comment></w:comments>`);
  files['[Content_Types].xml'] = strToU8(strFromU8(files['[Content_Types].xml']).replace('</Types>', '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>'));
  const original = await open(docx(p('Intro') + p('Zzz qqq') + p('Xxx yyy'))), revised = await open(zipSync(files));
  const result = mergeDocuments({ paragraphs: revised.paragraphs, tables: revised.tables }, { paragraphs: original.paragraphs, tables: original.tables }, { author: 'Rev' });
  const model = new TextDocument(result.paragraphs, revised.pageSettings, revised.numbering, revised.styles, result.tables, revised.assets, { comments: revised.comments });
  expect(changes(model)).toEqual([['del', 'Zzz qqq\nXxx yyy'], ['ins', 'Brand new close by Ada']]);
  const anchored = m => m.commentList.map(c => m.text.slice(c.start, c.end));
  const fields = m => bodyFieldRanges(m.paragraphs).map(r => [r.field.type, m.text.slice(r.start, r.end)]);
  expect(anchored(model)).toEqual(['Brand new close by Ada']);
  expect(model.bookmarks.map(b => [b.name, b.start])).toEqual([['Closing', model.text.length]]);
  expect(fields(model)).toEqual([['AUTHOR', 'Ada']]);
  const bytes = new Uint8Array(await revised.export(result.paragraphs, revised.pageSettings, revised.numbering, revised.styles, result.tables, revised.assets, undefined, revised.comments).arrayBuffer());
  for (const accept of [true, false]) {
    const again = await open(bytes), reopened = new TextDocument(again.paragraphs, again.pageSettings, again.numbering, again.styles, again.tables, again.assets, { comments: again.comments });
    expect(anchored(reopened)).toEqual(['Brand new close by Ada']);
    reopened.resolveRevisions(accept);
    expect(reopened.text).toBe(accept ? 'Intro\nBrand new close by Ada' : 'Intro\nZzz qqq\nXxx yyy');
    if (accept) { expect(anchored(reopened)).toEqual(['Brand new close by Ada']); expect(fields(reopened)).toEqual([['AUTHOR', 'Ada']]); }
  }
});

describe('combine documents', () => {
  it('keeps the original with its changes and adds the copy\'s differences', async () => {
    const original = await open(docx(p('Shared start.') + p('Removed later.'))), copy = await open(docx(p('Shared start, extended.') + '<w:p><w:ins w:id="5" w:author="Bea" w:date="2026-01-05T00:00:00Z"><w:r><w:t>Tracked by Bea.</w:t></w:r></w:ins></w:p>'));
    const result = mergeDocuments({ paragraphs: original.paragraphs, tables: original.tables }, { paragraphs: copy.paragraphs, tables: copy.tables }, { mode: 'combine', author: 'Copy author' });
    const model = new TextDocument(result.paragraphs, original.pageSettings, original.numbering, original.styles, result.tables, original.assets);
    expect(finalText(model.paragraphs[0])).toBe('Shared start, extended.');
    // The removed last paragraph and Bea's added one share the final mark, which is never a change.
    expect(changes(model)).toEqual([['ins', ', extended'], ['del', 'Removed later.'], ['ins', 'Tracked by Bea.']]);
    expect(model.revisions.map(r => r.author)).toEqual(['Copy author', 'Copy author', 'Bea']);
    const resolved = accept => { const m = new TextDocument(structuredClone(result.paragraphs), original.pageSettings, original.numbering, original.styles, result.tables, original.assets); m.resolveRevisions(accept); return m.text; };
    expect(resolved(true)).toBe('Shared start, extended.\nTracked by Bea.');
    expect(resolved(false)).toBe('Shared start.\nRemoved later.');
  });
});

it('names the revised document\'s author from its core properties', async () => {
  const parts = unzipSync(docx(p('x'), { creator: 'Ada Lovelace' }));
  expect(documentAuthor(parts)).toBe('Ada Lovelace');
  expect(documentAuthor({})).toBeNull();
});

// Core properties are the part the package relationship names (ECMA-376 Part 2 §11), which
// System.IO.Packaging stores as package/services/metadata/core-properties/<id>.psmdcp.
it('names the author from a core properties part stored under another name', async () => {
  const parts = unzipSync(docx(p('x'), { creator: 'Ada Lovelace' }));
  const path = 'package/services/metadata/core-properties/7c1a.psmdcp';
  parts[path] = strToU8(strFromU8(parts['docProps/core.xml']).replace('</cp:coreProperties>', '<cp:lastModifiedBy>Grace Hopper</cp:lastModifiedBy></cp:coreProperties>'));
  delete parts['docProps/core.xml'];
  parts['_rels/.rels'] = strToU8(strFromU8(parts['_rels/.rels']).replace('Target="docProps/core.xml"', `Target="/${path}"`));
  expect(documentAuthor(parts)).toBe('Grace Hopper');
});
