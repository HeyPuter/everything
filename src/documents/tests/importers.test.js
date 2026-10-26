// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { importKind, textToHtml, htmlBody, toInsertPayload, applyImport, decodeTextFile, declaredCharset, TEXT_IMPORTABLE } from '../src/lib/importers.js';

describe('importKind', () => {
  it('recognizes markdown, html, and text by extension', () => {
    expect(importKind('notes.md')).toBe('markdown');
    expect(importKind('README.MARKDOWN')).toBe('markdown');
    expect(importKind('page.htm')).toBe('html');
    expect(importKind('log.txt')).toBe('text');
    expect(importKind('a.docx')).toBeNull();
    expect(importKind('')).toBeNull();
    // A file the OS dialog offered as text, with an extension that says nothing.
    expect(importKind('README', 'text/plain')).toBe('text');
    expect(importKind('notes.log', 'text/plain; charset=utf-8')).toBe('text');
    expect(importKind('page.xhtml', 'application/xhtml+xml')).toBe('html');
    expect(importKind('notes.text', 'text/markdown')).toBe('markdown');
    expect(importKind('data.bin', 'application/octet-stream')).toBeNull();
    expect(TEXT_IMPORTABLE.test('x.html')).toBe(true);
    expect(TEXT_IMPORTABLE.test('x.png')).toBe(false);
  });
});

describe('textToHtml', () => {
  it('makes one paragraph per line and keeps blank lines, escaping markup', () => {
    expect(textToHtml('one\r\n\r\n<two> & "three"\n')).toBe('<p>one</p><p></p><p>&lt;two&gt; &amp; &quot;three&quot;</p>');
    expect(textToHtml('﻿bom')).toBe('<p>bom</p>');
    expect(textToHtml('')).toBe('<p></p>');
  });
});

describe('htmlBody', () => {
  it('keeps the body content and drops scripts, styles, and controls', () => {
    const html = '<!doctype html><html><head><title>T</title><style>p{}</style></head><body><h1>Hi</h1><script>x()</script><p>Text <b>bold</b></p><form><input></form></body></html>';
    expect(htmlBody(html)).toBe('<h1>Hi</h1><p>Text <b>bold</b></p>');
    expect(htmlBody('<p>fragment</p>')).toBe('<p>fragment</p>');
  });
  it('keeps the text of a page whose body is one form', () => {
    expect(htmlBody('<body><form action="/x"><h1>Title</h1><p>Body</p><input name="q"><button>Go</button></form></body>')).toBe('<h1>Title</h1><p>Body</p>');
  });
});

describe('toInsertPayload', () => {
  it('passes markdown and plain text through and extracts html content', () => {
    expect(toInsertPayload('# Hi', 'markdown')).toEqual({ value: '# Hi', type: 'markdown' });
    expect(toInsertPayload('﻿a\r\nb\rc\n', 'text')).toEqual({ value: 'a\nb\nc\n', type: 'text' });
    expect(toInsertPayload('<body><p>x</p><script></script></body>', 'html')).toEqual({ value: '<p>x</p>', type: 'html' });
  });
  it('turns form feeds into paragraph breaks and drops the control characters no document can hold', () => {
    // A printout's page breaks, a log's color codes, and NUL from a mis-decoded file all made the import fail.
    expect(toInsertPayload('page one\fpage two\x1b[31mred\x1b[0m\x00\x07 tab\tkept\n', 'text')).toEqual({ value: 'page one\npage two[31mred[0m tab\tkept\n', type: 'text' });
    expect(toInsertPayload('# Hi\x1b\x00', 'markdown')).toEqual({ value: '# Hi', type: 'markdown' });
    expect(toInsertPayload('<p>a\x00b</p>', 'html')).toEqual({ value: '<p>ab</p>', type: 'html' });
  });
});

describe('decodeTextFile', () => {
  const bytes = (...parts) => new Uint8Array(parts.flat());
  it('reads UTF-16 by its byte-order mark, UTF-8 otherwise, and legacy bytes as Windows-1252', () => {
    expect(decodeTextFile(bytes(0xff, 0xfe, [...Buffer.from('Hé\r\n', 'utf16le')]))).toBe('Hé\r\n');
    expect(decodeTextFile(bytes(0xfe, 0xff, 0x00, 0x48, 0x00, 0xe9))).toBe('Hé');
    expect(decodeTextFile(bytes([...Buffer.from('café ✓', 'utf8')]))).toBe('café ✓');
    // A UTF-8 file cut short mid-character, or with one stray byte, keeps its text.
    expect(decodeTextFile(bytes([...Buffer.from('Résumé — café naïve'.repeat(20), 'utf8'), 0xc3]))).toBe(`${'Résumé — café naïve'.repeat(20)}\ufffd`);
    expect(decodeTextFile(bytes([...Buffer.from('déjà ', 'utf8'), 0xe9, ...Buffer.from(' vu', 'utf8')]))).toBe('déjà \ufffd vu');
    expect(decodeTextFile(bytes(0xef, 0xbb, 0xbf, [...Buffer.from('bom', 'utf8')]))).toBe('bom');
    // Not UTF-8: Windows-1252 "café" and a smart quote.
    expect(decodeTextFile(bytes(0x63, 0x61, 0x66, 0xe9, 0x20, 0x93))).toBe('café “');
    // A Windows-1252 letter whose "ß“" happens to be a UTF-8 character is still read as Windows-1252.
    const letter = 'Liebe Grüße aus München! Wir wünschen euch „viel Spaß“ und schöne Tage. Eure Jörg und Käthe.';
    expect(decodeTextFile(new Uint8Array([...letter].map(ch => ({ '„': 0x84, '“': 0x93 })[ch] ?? ch.charCodeAt(0))))).toBe(letter);
    expect(decodeTextFile(new ArrayBuffer(0))).toBe('');
  });

  it('reads a legacy HTML page in the encoding it declares, once the bytes are not UTF-8', () => {
    const ascii = (s) => [...Buffer.from(s, 'latin1')];
    const hangul = [0xc7, 0xd1, 0xb1, 0xdb]; // 한글 in EUC-KR
    const page = (meta) => bytes(ascii(`<html><head>${meta}</head><body><p>`), hangul, ascii('</p></body></html>'));
    expect(decodeTextFile(page('<meta charset="euc-kr">'), 'html')).toContain('<p>한글</p>');
    expect(decodeTextFile(page('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=ks_c_5601-1987">'), 'html')).toContain('<p>한글</p>');
    expect(decodeTextFile(bytes(ascii('<?xml version="1.0" encoding="EUC-KR"?><html><body>'), hangul), 'html')).toContain('한글');
    // Only an HTML file carries a declaration; other kinds keep the plain fallback.
    const cyrillic = bytes(ascii('<meta charset="windows-1251"><p>'), 0xcc, 0xe8, 0xf0);
    expect(decodeTextFile(cyrillic, 'html')).toContain('Мир');
    expect(decodeTextFile(cyrillic, 'text')).not.toContain('Мир');
    expect(declaredCharset(page('<meta charset="euc-kr">'))).toBe('euc-kr');
    expect(declaredCharset(page(''))).toBeNull();
    // Valid UTF-8 wins over a stale declaration; unknown and unusable labels fall back to the byte sniff.
    expect(decodeTextFile(bytes(ascii('<meta charset="euc-kr">'), [...Buffer.from('한글', 'utf8')]), 'html')).toContain('한글');
    expect(decodeTextFile(page('<meta charset="x-nonsense">'), 'html')).toContain('<p>한글</p>');
    expect(decodeTextFile(page('<meta charset="iso-2022-kr">'), 'html')).not.toBe('\ufffd');
    expect(decodeTextFile(bytes(ascii('<meta charset="windows-1252"><p>caf'), 0xe9, 0x20, 0x93), 'html')).toContain('café “');
    // A page that claims UTF-16 but holds single bytes is read like one without the claim, as browsers do.
    for (const label of ['unicode', 'utf-16', 'UTF-16LE', 'ucs-2']) expect(decodeTextFile(bytes(ascii(`<meta charset="${label}"><p>caf`), 0xe9), 'html')).toContain('café');
  });
});

describe('legacy Korean, Japanese and Chinese text', () => {
  // Bytes as Windows editors of each language saved them (EUC-KR/CP949, Shift_JIS, GBK), written out here.
  const korean = [0xb4, 0xeb, 0xc7, 0xd1, 0xb9, 0xce, 0xb1, 0xb9, 0xc0, 0xba, 0x20, 0xb9, 0xce, 0xc1, 0xd6, 0xb0, 0xf8, 0xc8, 0xad, 0xb1, 0xb9, 0xc0, 0xcc, 0xb4, 0xd9, 0x2e];
  const japanese = [0x96, 0xbc, 0x91, 0x4f, 0x82, 0xcd, 0x82, 0xdc, 0x82, 0xbe, 0x96, 0xb3, 0x82, 0xa2, 0x81, 0x42];
  const chinese = [0xce, 0xd2, 0xc3, 0xc7, 0xbd, 0xf1, 0xcc, 0xec, 0xd4, 0xda, 0xd5, 0xe2, 0xc0, 0xef, 0xbf, 0xaa, 0xbb, 0xe1, 0xa1, 0xa3];
  it('reads a file saved in its language\'s legacy code page as its text, not as replacement characters', () => {
    expect(decodeTextFile(new Uint8Array(korean))).toBe('대한민국은 민주공화국이다.');
    expect(decodeTextFile(new Uint8Array(japanese))).toBe('名前はまだ無い。');
    expect(decodeTextFile(new Uint8Array(chinese))).toBe('我们今天在这里开会。');
    expect(decodeTextFile(new Uint8Array([...korean, 0x0a, ...korean]), 'markdown')).toBe('대한민국은 민주공화국이다.\n대한민국은 민주공화국이다.');
  });
  it('leaves Western text in Windows-1252, whose accented letters some of those code pages also accept', () => {
    for (const text of ['Le cœur a ses raisons que la raison ne connaît point. Ça va très bien, déjà vu, à côté.',
      'Größe, Straße, übermäßig schön; Fußgänger über die Brücke.', '¿Qué tal? ¡Mañana será otro día! El niño comió piña.',
      'Não há ação sem reação. O coração é grande.', 'Þórður og Ægir fóru í ferðalag. Ég á þrjá hesta.', '© ® ° ± × ÷ µ ¶ · ¼ ½ ¾ £ ¥ € §']) {
      const bytes = new Uint8Array([...text].map(ch => ({ 'œ': 0x9c, '€': 0x80 })[ch] ?? ch.charCodeAt(0)));
      expect(decodeTextFile(bytes)).toBe(text);
    }
  });
});

describe('applyImport', () => {
  const fakeApi = ({ blank = true } = {}) => {
    const calls = [];
    let blocks = blank ? [{ nodeId: 'p0', isEmpty: true }] : [{ nodeId: 'p0', isEmpty: false }];
    return {
      calls,
      insert: async (payload) => { calls.push(['insert', payload]); blocks = [...blocks, { nodeId: 'p1' }]; return { success: true }; },
      blocks: { list: async () => ({ blocks }), delete: async (input) => { calls.push(['delete', input]); blocks = blocks.filter((b) => b.nodeId !== input.target.nodeId); return { success: true }; } },
    };
  };

  it('reports the pictures the converter dropped', async () => {
    const api = fakeApi();
    api.insert = async () => ({ success: true, conversion: { format: 'html', lossy: true, diagnostics: [
      { code: 'conversion-unsafe-content', construct: 'image', disposition: 'dropped' },
      { code: 'conversion-unsafe-content', construct: 'image', disposition: 'dropped' },
      // A picture with a relative address is reported twice, once for the element and once for its address.
      { code: 'conversion-unsafe-url', construct: 'image', disposition: 'dropped', path: 'body/p[2]/img[0]/@src' },
      { code: 'conversion-unsafe-content', construct: 'image', disposition: 'dropped', path: 'body/p[2]/img[0]' },
      // The engine writes those paths as arrays of steps.
      { code: 'conversion-unsafe-url', construct: 'image', disposition: 'dropped', path: [3, 1, '@src'] },
      { code: 'conversion-unsafe-content', construct: 'image', disposition: 'dropped', path: [3, 1] },
      { code: 'other', construct: 'table', disposition: 'kept' },
    ] } });
    const seen = [];
    expect(await applyImport(api, { value: '<p>x</p>', type: 'html' }, { onDiagnostics: (d) => seen.push(d) })).toBe(true);
    expect(seen).toEqual([{ droppedImages: 4 }]);
  });

  it('reports dropped pictures when the content was converted to a fragment before insertion', async () => {
    const api = fakeApi();
    // Explicit formatting resets send the page through the fragment converter; its receipt, not the insert's, names the pictures.
    api.htmlToFragment = async () => ({ fragment: [{ kind: 'paragraph' }], diagnostics: [
      { code: 'conversion-unsafe-content', construct: 'image', disposition: 'dropped', path: [0, 1] },
      { code: 'conversion-unsafe-content', construct: 'image', disposition: 'dropped', path: [0, 3] },
      { code: 'conversion-dropped-style', construct: 'style', disposition: 'dropped', path: [1, '@style'] },
    ] });
    const seen = [];
    expect(await applyImport(api, { value: '<p style="font-weight: initial">a <img src="https://example.com/a.png"> b <img src="https://example.com/b.png"></p>', type: 'html' }, { onDiagnostics: (d) => seen.push(d) })).toBe(true);
    expect(api.calls.filter(([kind]) => kind === 'insert').map(([, payload]) => Object.keys(payload))).toEqual([['content']]);
    expect(seen).toEqual([{ droppedImages: 2 }]);
  });

  it('inserts a long Markdown file with link definitions piece by piece, without splitting a piece again', async () => {
    const api = fakeApi();
    let lists = 0;
    const listBlocks = api.blocks.list; api.blocks.list = async (...args) => { lists += 1; return listBlocks(...args); };
    const paragraphs = Array.from({ length: 401 }, (_, i) => `Paragraph ${i} of the [guide][g].`);
    // A piece carries the definition it refers to; split again it would come out the same size, forever.
    expect(await applyImport(api, { value: `${paragraphs.join('\n\n')}\n\n[g]: https://example.com/guide`, type: 'markdown' })).toBe(true);
    const inserts = api.calls.filter(([kind]) => kind === 'insert');
    expect(inserts.length).toBeGreaterThan(1);
    for (const [, payload] of inserts) expect(payload.value).toContain('[g]: https://example.com/guide');
    expect(inserts.map(([, payload]) => payload.value.match(/^Paragraph \d+/gm).length).reduce((a, b) => a + b)).toBe(401);
    // The document's blocks are listed for the first piece only (before and after it), not once more per piece.
    expect(lists).toBe(2);
  });

  it('inserts the content and removes the starting blank paragraph', async () => {
    const api = fakeApi();
    expect(await applyImport(api, { value: '# Hi', type: 'markdown' })).toBe(true);
    expect(api.calls).toEqual([['insert', { value: '# Hi', type: 'markdown' }], ['delete', { target: { kind: 'block', nodeType: 'paragraph', nodeId: 'p0' } }]]);
  });

  it('treats a piece that converts to nothing as nothing to insert, counting its dropped pictures', async () => {
    const api = fakeApi({ blank: false });
    const diagnostics = [];
    api.insert = async () => ({ success: false, failure: { code: 'INVALID_PAYLOAD', message: 'Markdown produced no safe canonical content.' }, conversion: { format: 'markdown', lossy: true, diagnostics: [
      { code: 'conversion-unsafe-content', construct: 'image', disposition: 'dropped', path: [0, 0] },
      { code: 'conversion-unsafe-url', construct: 'image', disposition: 'dropped', path: [0, 0, '@src'] },
      { code: 'conversion-empty-result', severity: 'error', message: 'Markdown produced no safe canonical content.' },
    ] } });
    expect(await applyImport(api, { value: '![badge](https://x.example/b.png)', type: 'markdown' }, { onDiagnostics: (d) => diagnostics.push(d) })).toBe(false);
    expect(diagnostics).toEqual([{ droppedImages: 1 }]);
    // A conversion that produced nothing for another reason is still a failure.
    api.insert = async () => ({ success: false, failure: { message: 'Row-spanning table cells cannot be represented by this conversion.' }, conversion: { diagnostics: [
      { code: 'conversion-unsupported-construct', severity: 'error', construct: 'rowSpan' },
      { code: 'conversion-empty-result', severity: 'error' },
    ] } });
    await expect(applyImport(api, { value: '<table><tr><td rowspan="2">r</td></tr></table>', type: 'html' })).rejects.toThrow('Row-spanning');
  });

  it('keeps existing content, skips empty imports, and surfaces failures', async () => {
    const api = fakeApi({ blank: false });
    await applyImport(api, { value: '<p>x</p>', type: 'html' });
    expect(api.calls.map((c) => c[0])).toEqual(['insert']);
    expect(await applyImport(api, { value: '   ', type: 'html' })).toBe(false);
    api.insert = async () => ({ success: false, failure: { message: 'bad html' } });
    await expect(applyImport(api, { value: '<p>x</p>', type: 'html' })).rejects.toThrow('bad html');
  });
});

describe('control characters written as character references', () => {
  it('takes them out of the text, where the converter would refuse the whole page', () => {
    expect(htmlBody('<p>a&#11;b&#1;c&#x7f;d&#xfffe;e&#12;f</p><pre>x&#11;y&#13;z</pre>')).toBe('<p>a bcde f</p><pre>x y z</pre>');
    // A tab and a line feed are text a document can hold.
    expect(htmlBody('<pre>a&#9;b&#10;c</pre>')).toBe('<pre>a\tb\nc</pre>');
    expect(toInsertPayload('<p>one&#11;two</p>', 'html').value).toBe('<p>one two</p>');
  });
});
