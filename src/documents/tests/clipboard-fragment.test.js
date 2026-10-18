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

it('marks headings and nested lists, and keeps a lone phrase in the destination paragraph', () => {
  const fragment = htmlFragment('<h3>Title</h3><ol><li>One<ul><li>Inner</li></ul></li></ol>');
  expect(fragment.paragraphs.map(p => [p.text, p.styleName, p.list, p.mark])).toEqual([
    ['Title', 'Heading 3', null, true], ['One', 'Normal', { kind: 'number', level: 0 }, true], ['Inner', 'Normal', { kind: 'bullet', level: 1 }, true]]);
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
