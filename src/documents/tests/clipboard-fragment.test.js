// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { htmlFragment, fragmentHtml, formattedPasteFits, FRAGMENT_ATTRIBUTE } from '../src/engine/clipboard-fragment.js';

const texts = html => htmlFragment(html)?.paragraphs.map(p => p.text);

it('collapses HTML whitespace and keeps line breaks, tabs between cells and preformatted lines', () => {
  expect(texts('<p>  Two\n   spaced   words </p><p>Line<br>break</p>')).toEqual(['Two spaced words', 'Line\vbreak']);
  expect(texts('<table><tr><td>A</td><td>B</td></tr><tr><th>C</th><td>D</td></tr></table>')).toEqual(['A\tB', 'C\tD']);
  expect(texts('<pre>one\n  two</pre>')).toEqual(['one\v  two']);
  expect(texts('<p>Kept</p><script>alert(1)</script><style>p{}</style><img alt="x">')).toEqual(['Kept']);
  expect(htmlFragment('<p> </p><br>')).toBeNull();
});

it('keeps the tabs, spaces and indentation of preformatted text, as Google Docs and code editors copy it', () => {
  // A preformatted block keeps the spaces its first line starts with.
  expect(texts('<pre>    indented\n  more</pre>')).toEqual(['    indented\v  more']);
  // Google Docs writes each run with white-space: pre-wrap.
  expect(texts('<b style="font-weight:normal" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:400;white-space:pre;white-space:pre-wrap;">Name\tQty   x</span></p><p dir="ltr"><span style="white-space:pre-wrap">    indented</span></p></b>')).toEqual(['Name\tQty   x', '    indented']);
  // Code editors write lines of code inside a white-space: pre block.
  expect(texts('<div style="white-space: pre;"><div><span>def f():</span></div><div><span>    return 1</span></div></div>')).toEqual(['def f():', '    return 1']);
  // Ordinary white space inside it collapses again.
  expect(texts('<p style="white-space:pre-wrap">a  <span style="white-space:normal">b   c</span>  d</p>')).toEqual(['a  b c  d']);
  // What this editor copies comes back the same without its own fragment, as another application may hand it on.
  const own = fragmentHtml({ paragraphs: [{ text: '\tTab   spaced', runs: [{ text: '\tTab   spaced', format: {} }], mark: false, styleId: null, alignment: 'left', list: null }] });
  expect(texts(own.replace(new RegExp(`\\s${FRAGMENT_ATTRIBUTE}="[^"]*"`), ''))).toEqual(['\tTab   spaced']);
});

it('pastes Word\'s tabs and runs of spaces as a tab and spaces, not no-break spaces', () => {
  const nbsp = n => '&nbsp;'.repeat(n);
  expect(texts(`<p class=MsoNormal>Name<span style='mso-tab-count:1'>${nbsp(11)} </span>Qty<o:p></o:p></p><p class=MsoNormal>Pens<span style='mso-tab-count:2'>${nbsp(22)} </span>2<o:p></o:p></p>`)).toEqual(['Name\tQty', 'Pens\t\t2']);
  expect(texts(`<p class=MsoNormal><span style='mso-spacerun:yes'>${nbsp(2)} </span>indented, two<span style='mso-spacerun:yes'>${nbsp(1)} </span>spaces<o:p></o:p></p>`)).toEqual(['   indented, two  spaces']);
  // The tab takes the formatting around it.
  expect(htmlFragment(`<p class=MsoNormal><b>bold<span style='mso-tab-count:1'>${nbsp(3)} </span>after</b></p>`).paragraphs[0].runs).toEqual([{ text: 'bold\tafter', format: expect.objectContaining({ bold: true }) }]);
});

it('marks headings and nested lists, and keeps a lone phrase in the destination paragraph', () => {
  const fragment = htmlFragment('<h3>Title</h3><ol><li>One<ul><li>Inner</li></ul></li></ol>');
  expect(fragment.paragraphs.map(p => [p.text, p.styleName, p.list, p.mark])).toEqual([
    ['Title', 'Heading 3', null, true], ['One', 'Normal', { kind: 'number', level: 0, id: 1 }, true], ['Inner', 'Normal', { kind: 'bullet', level: 1, id: 2 }, true]]);
  expect(htmlFragment('<p>Just a <b>phrase</b></p>').paragraphs[0].mark).toBe(false);
});

it('reads its own embedded fragment and ignores a malformed one', () => {
  const fragment = { paragraphs: [{ text: 'Mine', runs: [{ text: 'Mine', format: { bold: true } }], mark: false, styleId: null, styleName: null, alignment: 'left', list: null }] };
  expect(htmlFragment(fragmentHtml(fragment))).toEqual(fragment);
  const forged = `<div ${FRAGMENT_ATTRIBUTE}="{&quot;paragraphs&quot;:[{&quot;text&quot;:&quot;A&quot;,&quot;runs&quot;:[{&quot;text&quot;:&quot;B&quot;}]}]}"><p>Visible</p></div>`;
  expect(texts(forged)).toEqual(['Visible']);
});

it('carries formatting into a paste only while that stays a bounded number of commands', () => {
  const paragraphs = (n, body) => Array.from({ length: n }, (_, i) => `<p>${body(i)}</p>`).join('');
  expect(formattedPasteFits(htmlFragment(paragraphs(600, i => `Line ${i} <b>bold</b> <i>tail</i>`)))).toBe(true);
  // Every paragraph and formatted run is a command over the whole document.
  expect(formattedPasteFits(htmlFragment(paragraphs(800, i => `Line ${i} <b>bold</b> <i>tail</i>`)))).toBe(false);
  // Another application's plain runs apply nothing, so they cost nothing.
  expect(formattedPasteFits(htmlFragment(`<p>${Array.from({ length: 3000 }, (_, i) => `<span>w${i} </span>`).join('')}</p>`))).toBe(true);
});

it('turns Word’s list paragraphs into list items without their typed-out markers', () => {
  // As Word puts a bulleted, nested and numbered list on the clipboard.
  const item = (cls, list, font, marker, text) => `<p class=${cls} style='text-indent:-.25in;mso-list:${list}'><![if !supportLists]><span style='font-family:${font}'><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]>${text}<o:p></o:p></p>`;
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style><!-- p.MsoListParagraph {margin-left:.5in} --></style></head><body><!--StartFragment-->`
    + item('MsoListParagraphCxSpFirst', 'l0 level1 lfo1', 'Symbol', '·', 'First item')
    + item('MsoListParagraphCxSpMiddle', 'l0 level2 lfo1', '"Courier New"', 'o', 'Nested item')
    + item('MsoListParagraphCxSpLast', 'l1 level1 lfo2', 'Calibri', '1.', 'Numbered <b>item</b>')
    + `<p class=MsoNormal>After the list<o:p></o:p></p><!--EndFragment--></body></html>`;
  expect(htmlFragment(html).paragraphs.map(p => [p.text, p.list])).toEqual([
    ['First item', { kind: 'bullet', level: 0 }], ['Nested item', { kind: 'bullet', level: 1 }],
    ['Numbered item', { kind: 'number', level: 0 }], ['After the list', null]]);
});

it('reads Word’s multilevel numbers (1.1., 1.2, 1.2.1) as numbered items', () => {
  const item = (list, marker, text) => `<p class=MsoListParagraph style='mso-list:${list}'><![if !supportLists]><span><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span></span><![endif]>${text}</p>`;
  const html = `<html><body><!--StartFragment-->${item('l0 level1 lfo1', '1.', 'Scope')}${item('l0 level2 lfo1', '1.1.', 'Definitions')}${item('l0 level2 lfo1', '1.2', 'Terms')}${item('l0 level3 lfo1', '1.2.1', 'Detail')}${item('l0 level1 lfo1', '2', 'Plain')}${item('l1 level1 lfo2', '§', 'Section mark')}<!--EndFragment--></body></html>`;
  expect(htmlFragment(html).paragraphs.map(p => [p.text, p.list])).toEqual([
    ['Scope', { kind: 'number', level: 0 }], ['Definitions', { kind: 'number', level: 1 }], ['Terms', { kind: 'number', level: 1 }],
    ['Detail', { kind: 'number', level: 2 }], ['Plain', { kind: 'number', level: 0 }], ['Section mark', { kind: 'bullet', level: 0 }]]);
});

it('reads Word’s empty paragraphs as empty, without the no-break space that holds them open', () => {
  const word = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><body lang=EN-US><!--StartFragment--><p class=MsoNormal>First<o:p></o:p></p>
<p class=MsoNormal><o:p>&nbsp;</o:p></p>
<p class=MsoNormal>Third&nbsp;word<o:p></o:p></p><!--EndFragment--></body></html>`;
  expect(texts(word)).toEqual(['First', '', 'Third word']);
});

it('writes tel: and mailto: links into the copied HTML, and never unsafe schemes', () => {
  const run = (text, link) => ({ text, link, format: { bold: false, italic: false } });
  const html = fragmentHtml({ paragraphs: [{ text: 'Call mail bad data', mark: false, styleId: null, alignment: 'left', list: null,
    runs: [run('Call', 'tel:+1-555-0100'), run(' mail', 'mailto:a@example.com'), run(' bad', 'javascript:alert(1)'), run(' data', 'data:text/html,x')] }] });
  const anchors = [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href')]);
  expect(anchors).toEqual([['Call', 'tel:+1-555-0100'], [' mail', 'mailto:a@example.com']]);
});

it('keeps a link whose address has spaces or line breaks around it, as a browser follows it', () => {
  const links = html => htmlFragment(html)?.paragraphs.flatMap(p => p.runs.filter(r => r.link).map(r => [r.text, r.link]));
  expect(links('<p>See <a href=" https://example.com/a ">the site</a>.</p>')).toEqual([['the site', 'https://example.com/a']]);
  expect(links('<p><a href="\n\tmailto:someone@example.com\n">Write</a></p>')).toEqual([['Write', 'mailto:someone@example.com']]);
  // An address that is not a web, mail or phone link still gives no link.
  expect(links('<p><a href=" javascript:alert(1)">No</a></p>')).toEqual([]);
});

it('keeps a table row on one line when its cells hold paragraphs, as Word, LibreOffice and Google Docs write them', () => {
  expect(texts('<table><tr><td><p class="MsoNormal">Name</p></td><td><p class="MsoNormal">Qty</p></td></tr><tr><td><p>Apples</p></td><td><p>3</p></td></tr></table>')).toEqual(['Name\tQty', 'Apples\t3']);
  expect(texts('<table><tbody><tr><td><p dir="ltr"><span>Item</span></p></td><td><div>Two</div><div>lines</div></td></tr></tbody></table><p>After</p>')).toEqual(['Item\tTwo lines', 'After']);
  expect(texts('<table><tr><th><h3>Head</h3></th><td>Plain</td></tr></table>')).toEqual(['Head\tPlain']);
});

it('keeps the emphasis a span inherits when its style says inherit, as a reset style sheet makes it say', () => {
  const runs = html => htmlFragment(html)?.paragraphs.flatMap(p => p.runs.map(r => [r.text, !!r.format.bold, !!r.format.italic]));
  expect(runs('<p><b>Bold <span style="font-weight:inherit">word</span></b> <i>Slanted <span style="font-style:unset">word</span></i></p>'))
    .toEqual([['Bold word', true, false], [' ', false, false], ['Slanted word', false, true]]);
  // A weight or style of its own still counts.
  expect(runs('<p><b>Bold <span style="font-weight:normal">plain</span></b></p>')).toEqual([['Bold ', true, false], ['plain', false, false]]);
});
