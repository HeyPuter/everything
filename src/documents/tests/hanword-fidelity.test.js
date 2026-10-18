import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8, strToU8, zipSync } from 'fflate';
import { parseHwpx } from '../src/lib/hwp/hwpx.js';
import { parseHwp5 } from '../src/lib/hwp/hwp5.js';
import { modelToDocx } from '../src/lib/hwp/docx.js';
import { equationToOmml } from '../src/lib/hwp/equation.js';
import { imageSize } from '../src/lib/hwp/image.js';
import { png as pngImage } from './helpers/image-fixtures.js';
import { hwp, hwpx, paragraph, concat, record, u16, u32, utf16, controlText, string } from './helpers/hwp-fixtures.js';

beforeAll(() => { globalThis.DOMParser = new JSDOM('').window.DOMParser; });
const parse = (text) => new DOMParser().parseFromString(text, 'application/xml');
const elements = (node, name) => [...node.getElementsByTagNameNS('*', name)];
const attr = (node, name) => node?.getAttribute(`w:${name}`);
const xmlFiles = (model) => Object.fromEntries(Object.entries(unzipSync(modelToDocx(model))).filter(([name]) => name.endsWith('.xml') || name.endsWith('.rels')).map(([name, bytes]) => [name, strFromU8(bytes)]));
const content = (text) => `<hp:p><hp:run>${text}</hp:run></hp:p>`;
const ptext = (text) => content(`<hp:t>${text}</hp:t>`);
const field = (type, command, id = '1', more = '') => `<hp:ctrl><hp:fieldBegin type="${type}" id="${id}" ${more}><hp:parameters><hp:stringParam name="Command">${command}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl>`;
const end = (id = '1') => `<hp:ctrl><hp:fieldEnd beginIDRef="${id}"/></hp:ctrl>`;
const ctrl = (id, bytes, level = 1) => record(71, level, concat(Buffer.from(id).reverse(), bytes));
const summary = (properties) => {
  const entries = Object.entries(properties), values = [], offsets = []; let offset = 8 + entries.length * 8;
  for (const [id, bytes] of entries) { offsets.push(u32(Number(id)), u32(offset)); const padded = concat(bytes, new Uint8Array((4 - bytes.length % 4) % 4)); values.push(padded); offset += padded.length; }
  return concat(u16(0xfffe), u16(0), new Uint8Array(20), u32(1), Buffer.from('60b6a29f6110d411b4c6006097c09d8c', 'hex'), u32(48), u32(offset), u32(entries.length), ...offsets, ...values);
};

describe('Hanword equation conversion', () => {
  const math = (source) => {
    const result = equationToOmml(source);
    expect(result, source).not.toBeNull();
    const doc = parse(`<root xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${result}</root>`);
    expect(elements(doc, 'parsererror'), source).toHaveLength(0);
    return doc;
  };
  it('treats identifiers that name object members as ordinary text', () => {
    // `constructor`, `toString` and the like are not symbols; they used to resolve through Object.prototype.
    for (const word of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const doc = math(word);
      expect(elements(doc, 't').map((t) => t.textContent), word).toEqual([word]);
      expect(elements(doc, 'nary'), word).toHaveLength(0);
    }
    const doc = math('left constructor x right constructor');
    expect(elements(doc, 'begChr')[0].getAttribute('m:val')).toBe('constructor');
  });
  it('preserves the quadratic formula as a fraction, radical, and superscripts', () => {
    const doc = math('x = {-b +- sqrt {b^2 - 4ac}} over {2a}');
    expect(elements(doc, 'f')).toHaveLength(1);
    expect(elements(doc, 'rad')).toHaveLength(1);
    expect(elements(doc, 'sSup')).toHaveLength(1);
    expect(elements(doc, 'num')[0].textContent).toBe('-b±b2-4ac');
    expect(elements(doc, 'den')[0].textContent).toBe('2a');
  });
  it('keeps nested fractions, roots and combined scripts in their correct arguments', () => {
    const doc = math('{a over b} + root {3} of {x_i^2}');
    expect(elements(doc, 'num')[0].textContent).toBe('a');
    expect(elements(doc, 'den')[0].textContent).toBe('b');
    expect(elements(doc, 'deg')[0].textContent).toBe('3');
    expect(elements(doc, 'sub')[0].textContent).toBe('i');
    expect(elements(doc, 'sup')[0].textContent).toBe('2');
  });
  it.each(['sum', 'prod', 'int', 'oint', 'dint', 'tint'])('maps %s limits and operand to an n-ary structure', (op) => {
    const doc = math(`${op}_{i=0}^{n} {x_i^2}`), nary = elements(doc, 'nary')[0];
    expect(elements(nary, 'sub')[0].textContent).toBe('i=0');
    expect(elements(nary, 'sup')[0].textContent).toBe('n');
    expect(elements(nary, 'e')[0].textContent).toBe('xi2');
  });
  it.each(['matrix', 'pmatrix', 'bmatrix', 'dmatrix', 'cases'])('retains %s row/column boundaries', (kind) => {
    const doc = math(`${kind}{a_1 & b_1 # a_2 & b_2}`);
    expect(elements(doc, 'mr').map((row) => [...row.children].map((c) => c.textContent))).toEqual([['a1', 'b1'], ['a2', 'b2']]);
    expect(elements(doc, 'd')).toHaveLength(kind === 'matrix' ? 0 : 1);
  });
  it('keeps decorations, Greek letters, delimiters, functions and quoted text', () => {
    const doc = math('left ( bar x + vec y right ) = alpha + Gamma + sin theta + "한글 & text"');
    expect(elements(doc, 'bar')).toHaveLength(1);
    expect(elements(doc, 'acc')).toHaveLength(1);
    expect(doc.documentElement.textContent).toContain('α+Γ+sinθ+한글 & text');
  });
  it('uses whitespace-delimited terms for fractions and unbraced limits', () => {
    const doc = math('10a^3 over 2b + lim_N->inf 1 over N + sum_n=1^N {n}');
    expect(elements(doc, 'num').map((n) => n.textContent)).toEqual(['10a3', '1']);
    expect(elements(doc, 'den').map((n) => n.textContent)).toEqual(['2b', 'N']);
    expect(elements(doc, 'lim')[0].textContent).toBe('N→∞');
    expect(elements(elements(doc, 'nary')[0], 'sub')[0].textContent).toBe('n=1');
  });
  it('distinguishes capital Greek and double arrows from lowercase symbols', () => {
    expect(math('Alpha alpha RARROW rarrow +- !=').documentElement.textContent).toBe('Αα⇒→±≠');
  });
  it.each(['{x', 'x}', 'x^', 'x over', 'left ( x', 'matrix{x&#y', 'longdiv {2}{4}{8}', 'x'.repeat(65537), '{'.repeat(80) + 'x' + '}'.repeat(80)])('declines malformed or unsupported equations without losing their source (case %#)', (source) => {
    expect(equationToOmml(source)).toBeNull();
  });
  it.each(['HWP', 'HWPX'])('writes equations from %s as native Office Math and retains unsupported source', (format) => {
    const scripts = ['{a+b} over c', 'LONGDIV {2}{4}{8}'];
    const model = format === 'HWPX' ? parseHwpx(hwpx({ sections: [content(scripts.map((s) => `<hp:equation baseUnit="1200"><hp:script>${s}</hp:script></hp:equation>`).join(''))] }))
      : parseHwp5(hwp({ sections: [paragraph(concat(...scripts.map(() => controlText(11, 'eqed')), utf16('\r')), { children: scripts.map((s) => concat(ctrl('eqed', new Uint8Array()), record(88, 2, concat(u32(0), string(s), u32(1200), u32(0))))) })] }));
    const files = xmlFiles(model), document = parse(files['word/document.xml']);
    expect(elements(document, 'oMath')).toHaveLength(1);
    expect(document.documentElement.textContent).toContain('LONGDIV {2}{4}{8}');
    expect([...model.warnings].some((s) => s.includes('complete Hanword source'))).toBe(true);
  });
  it('keeps an equation\'s run size within the DOCX limit like every other run', () => {
    const model = parseHwpx(hwpx({ sections: [content('<hp:equation baseUnit="4294967295"><hp:script>a over b</hp:script></hp:equation>')] }));
    const sizes = elements(parse(xmlFiles(model)['word/document.xml']), 'sz').map((n) => Number(n.getAttribute('w:val')));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBe(3276);
  });
  it('writes only WordprocessingML values for HWPX alignment enumerations', () => {
    const header = '<hh:tabPr id="0"><hh:tabItem pos="1000" type="foo&quot;bar" leader="NONE"/></hh:tabPr><hh:paraPr id="0" tabPrIDRef="0"/>';
    const table = '<hp:tbl rowCnt="1" colCnt="1" pageBreak="NONE"><hp:pos horzAlign="SIDEWAYS"/><hp:tr><hp:tc><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="12000" height="3000"/><hp:subList vertAlign="SIDEWAYS">' + ptext('cell') + '</hp:subList></hp:tc></hp:tr></hp:tbl>';
    const doc = parse(xmlFiles(parseHwpx(hwpx({ header, sections: [content(table)] })))['word/document.xml']);
    expect(elements(doc, 'tab').map((t) => t.getAttribute('w:val'))).toEqual(['left']);
    expect(elements(doc, 'vAlign').map((t) => t.getAttribute('w:val'))).toEqual(['top']);
    expect(elements(doc, 'jc').map((t) => t.getAttribute('w:val'))).not.toContain('sideways');
  });
});

describe('Hanword fields, bookmarks, comments and revisions', () => {
  it('preserves a link across paragraphs and stops at its matching end', () => {
    const source = content(field('HYPERLINK', 'https\\://example.com/') + '<hp:t>first</hp:t>') + content('<hp:t>second</hp:t>' + end() + '<hp:t>outside</hp:t>');
    const document = parse(xmlFiles(parseHwpx(hwpx({ sections: [source] })))['word/document.xml']);
    expect(elements(document, 'hyperlink').map((l) => l.textContent)).toEqual(['first', 'second']);
    expect(document.documentElement.textContent).toBe('firstsecondoutside');
  });
  it('preserves binary links across paragraphs', () => {
    const start = paragraph(concat(controlText(3, '%hlk'), utf16('first\r')), { children: [ctrl('%hlk', concat(new Uint8Array(5), string('https\\://example.com/;1;0;0;')))] });
    const stop = paragraph(concat(utf16('second'), controlText(4, '%hlk'), utf16('outside\r')));
    const document = parse(xmlFiles(parseHwp5(hwp({ sections: [concat(start, stop)] })))['word/document.xml']);
    expect(elements(document, 'hyperlink').map((l) => l.textContent)).toEqual(['first', 'second']);
  });
  it('connects forward links to sanitized Korean bookmark names', () => {
    const source = content(field('HYPERLINK', '#한글 책갈피') + '<hp:t>go</hp:t>' + end()) + content('<hp:ctrl><hp:bookmark name="한글 책갈피"/></hp:ctrl><hp:t>destination</hp:t>');
    const files = xmlFiles(parseHwpx(hwpx({ sections: [source] }))), doc = parse(files['word/document.xml']);
    expect(attr(elements(doc, 'hyperlink')[0], 'anchor')).toBe(attr(elements(doc, 'bookmarkStart')[0], 'name'));
    expect(attr(elements(doc, 'bookmarkStart')[0], 'name')).toBe('한글_책갈피');
    expect(files['word/_rels/document.xml.rels']).not.toContain('hyperlink');
  });
  it('keeps ranged bookmarks across paragraphs and closes the correct field', () => {
    const source = content(field('BOOKMARK', '', '5', 'name="Section One"') + field('HYPERLINK', 'https://example.com', '6') + '<hp:t>one</hp:t>' + end('5')) + content('<hp:t>two</hp:t>' + end('6') + '<hp:t>end</hp:t>');
    const doc = parse(xmlFiles(parseHwpx(hwpx({ sections: [source] })))['word/document.xml']);
    expect(attr(elements(doc, 'bookmarkStart')[0], 'id')).toBe(attr(elements(doc, 'bookmarkEnd')[0], 'id'));
    expect(elements(doc, 'hyperlink').map((l) => l.textContent)).toEqual(['one', 'two']);
  });
  it('reads a binary bookmark ParameterSet and its internal target', () => {
    const bookmark = concat(ctrl('bokm', new Uint8Array()), record(87, 2, concat(u16(0x21), u16(1), u16(0), u16(1), string('표목차'))));
    const model = parseHwp5(hwp({ sections: [paragraph(concat(controlText(22, 'bokm'), utf16('text\r')), { children: [bookmark] })] }));
    expect(attr(elements(parse(xmlFiles(model)['word/document.xml']), 'bookmarkStart')[0], 'name')).toBe('표목차');
  });
  it('keeps comment content in a related part, with a range over its source text', () => {
    const source = content('<hp:ctrl><hp:fieldBegin type="MEMO" id="10"><hp:stringParam name="Author">Kim &amp; Lee</hp:stringParam><hp:subList>' + ptext('comment body') + '</hp:subList></hp:fieldBegin></hp:ctrl><hp:t>annotated</hp:t>' + end('10'));
    const files = xmlFiles(parseHwpx(hwpx({ sections: [source] }))), doc = parse(files['word/document.xml']);
    expect(doc.documentElement.textContent).toBe('annotated');
    expect(elements(doc, 'commentReference')).toHaveLength(1);
    expect(parse(files['word/comments.xml']).documentElement.textContent).toBe('comment body');
    expect(files['word/comments.xml']).toContain('w:author="Kim &amp; Lee"');
    expect(files['word/_rels/document.xml.rels']).toContain('Target="comments.xml"');
  });
  it('preserves inserted and deleted text with revision authors and dates', () => {
    const header = '<hh:trackChangeAuthor id="1" name="Editor"/><hh:trackChange id="2" type="Insert" authorID="1" date="2026-09-10T12:00:00Z"/>';
    const source = content('<hp:t>before<hp:insertBegin Id="4" TcId="2"/>new<hp:insertEnd Id="4"/><hp:deleteBegin Id="5" TcId="2"/>old<hp:deleteEnd Id="5"/>after</hp:t>');
    const doc = parse(xmlFiles(parseHwpx(hwpx({ header, sections: [source] })))['word/document.xml']);
    expect(elements(doc, 'ins')[0].textContent).toBe('new');
    expect(attr(elements(doc, 'ins')[0], 'author')).toBe('Editor');
    expect(attr(elements(doc, 'ins')[0], 'date')).toBe('2026-09-10T12:00:00Z');
    expect(elements(doc, 'delText')[0].textContent).toBe('old');
    expect(elements(doc, 't').map((n) => n.textContent).join('')).toBe('beforenewafter');
  });
  it('nests an inserted hyperlink as a revision inside the link, the only order the WordprocessingML schema allows', () => {
    const header = '<hh:trackChangeAuthor id="1" name="Editor"/><hh:trackChange id="2" type="Insert" authorID="1" date="2026-09-10T12:00:00Z"/>';
    const link = '<hp:ctrl><hp:fieldBegin type="HYPERLINK" id="1"><hp:parameters><hp:stringParam name="Command">https\\://example.com/</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl>';
    const source = content('<hp:t>before<hp:insertBegin Id="4" TcId="2"/></hp:t>' + link + '<hp:t>link</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="1"/></hp:ctrl><hp:t><hp:insertEnd Id="4"/>after</hp:t>');
    const doc = parse(xmlFiles(parseHwpx(hwpx({ header, sections: [source] })))['word/document.xml']);
    const hyperlink = elements(doc, 'hyperlink')[0];
    expect(hyperlink.textContent).toBe('link');
    expect(hyperlink.parentNode.localName).toBe('p');
    expect([...hyperlink.children].map((n) => n.localName)).toEqual(['ins']);
    expect(elements(doc, 'ins').every((n) => n.parentNode.localName !== 'p' || elements(n, 'hyperlink').length === 0)).toBe(true);
  });
  it('closes an unfinished bookmark at the end of its story and reports it', () => {
    const model = parseHwpx(hwpx({ sections: [content(field('BOOKMARK', '', '3', 'name="unfinished"') + '<hp:t>last paragraph</hp:t>')] }));
    const doc = parse(xmlFiles(model)['word/document.xml']);
    expect(elements(doc, 'bookmarkEnd')).toHaveLength(1);
    expect(attr(elements(doc, 'bookmarkEnd')[0], 'id')).toBe(attr(elements(doc, 'bookmarkStart')[0], 'id'));
    expect([...model.warnings].some((w) => w.includes('unterminated'))).toBe(true);
  });
  it('bounds overlapping fields before resolving links or expanding output', () => {
    const source = content(Array.from({ length: 65 }, (_, i) => field('HYPERLINK', 'https://example.com', String(i))).join('') + '<hp:t>body</hp:t>');
    expect(() => modelToDocx(parseHwpx(hwpx({ sections: [source] })))).toThrow(/overlapping fields/);
  });
});

describe('Hanword section and table fidelity', () => {
  it('preserves character effects and explicitly clears them on the following run', () => {
    const header = '<hh:charPr id="0" height="1000"><hh:bold/><hh:outline type="SOLID"/><hh:shadow type="DROP"/><hh:underline type="BOTTOM" shape="DASH"/><hh:strikeout shape="DOUBLE_SLIM"/><hh:relSz hangul="80"/><hh:offset hangul="10"/></hh:charPr><hh:charPr id="1" height="1000"/><hh:paraPr id="0"/><hh:style id="0" charPrIDRef="0" paraPrIDRef="0"/>';
    const source = '<hp:p><hp:run charPrIDRef="0"><hp:t>decorated</hp:t></hp:run><hp:run charPrIDRef="1"><hp:t>plain</hp:t></hp:run></hp:p>';
    const runs = elements(parse(xmlFiles(parseHwpx(hwpx({ header, sections: [source] })))['word/document.xml']), 'rPr');
    expect(['sz', 'position', 'u', 'dstrike', 'outline', 'shadow'].map((n) => attr(elements(runs[0], n)[0], 'val'))).toEqual(['16', '-2', 'dash', '1', '1', '1']);
    // Styles leave strikethrough to the runs (a property set holds only one of strike and dstrike), so the plain run turns off a single strike.
    expect(['sz', 'position', 'u', 'strike', 'outline', 'shadow'].map((n) => attr(elements(runs[1], n)[0], 'val'))).toEqual(['20', '0', 'none', '0', '0', '0']);
    expect(runs.map((props) => elements(props, 'strike').length + elements(props, 'dstrike').length)).toEqual([1, 1]);
    expect(xmlFiles(parseHwpx(hwpx({ header, sections: [source] })))['word/styles.xml']).not.toMatch(/<w:d?strike /);
  });
  it.each(['SimpleEquation', 'PageFunctions', 'SimpleComboBox', 'ChangeTrack', 'SimpleCompose'])('converts the real %s HWPX fixture into well-formed related parts', (name) => {
    const model = parseHwpx(readFileSync(new URL(`./fixtures/hwpx/${name}.hwpx`, import.meta.url))), files = xmlFiles(model), doc = parse(files['word/document.xml']);
    for (const [path, xml] of Object.entries(files)) expect(elements(parse(xml), 'parsererror'), path).toHaveLength(0);
    if (name === 'SimpleEquation') { expect(elements(doc, 'oMath')).toHaveLength(1); expect(elements(doc, 'f')[0].textContent).toContain('123'); }
    if (name === 'PageFunctions') expect(attr(elements(doc, 'pgNumType')[0], 'start')).toBe('23');
    if (name === 'SimpleComboBox') { expect([...model.warnings]).toContain('Document scripts are not imported.'); expect(doc.documentElement.textContent).not.toBe(''); }
    if (name === 'ChangeTrack') { expect(elements(doc, 'ins').length).toBeGreaterThan(0); expect(elements(doc, 'delText').length).toBeGreaterThan(0); }
    if (name === 'SimpleCompose') { expect(doc.documentElement.textContent).toContain('12'); expect(doc.documentElement.textContent).toContain('AO'); }
  });
  it('keeps a shape’s text, fill, geometry and floating placement', () => {
    const source = content('<hp:rect><hp:sz width="12000" height="6000"/><hp:pos treatAsChar="0" horzRelTo="PAPER" vertRelTo="PAPER" horzOffset="2500" vertOffset="3500"/><hp:lineShape color="#112233" width="100" style="DASH"/><hp:fillBrush><hp:winBrush faceColor="#FFDDEE"/></hp:fillBrush><hp:drawText><hp:subList>' + ptext('inside shape') + '</hp:subList></hp:drawText></hp:rect>');
    const doc = parse(xmlFiles(parseHwpx(hwpx({ sections: [source] })))['word/document.xml']);
    expect(elements(doc, 'txbxContent')[0].textContent).toBe('inside shape');
    expect(elements(doc, 'prstGeom')[0].getAttribute('prst')).toBe('rect');
    expect(elements(doc, 'anchor')).toHaveLength(1);
    expect(elements(doc, 'positionH')[0].getAttribute('relativeFrom')).toBe('page');
    expect(elements(doc, 'posOffset').map((p) => p.textContent)).toEqual(['317500', '444500']);
    expect(elements(doc, 'srgbClr').map((c) => c.getAttribute('val'))).toContain('FFDDEE');
  });
  it('keeps both ruby strings visible in the editor-compatible output', () => {
    const doc = parse(xmlFiles(parseHwpx(hwpx({ sections: [content('<hp:dutmal><hp:mainText>漢字</hp:mainText><hp:subText>한자</hp:subText></hp:dutmal>')] })))['word/document.xml']);
    // The annotation follows the base as small raised text, since the editor drops w:ruby.
    expect(doc.documentElement.textContent).toBe('漢字한자');
    const runs = elements(doc, 'r');
    expect(runs.map((r) => elements(r, 'vertAlign')[0]?.getAttribute('w:val'))).toEqual(['baseline', 'superscript']);
    expect(Number(elements(runs[1], 'sz')[0].getAttribute('w:val'))).toBeLessThan(Number(elements(runs[0], 'sz')[0].getAttribute('w:val')));
  });
  it('interprets unsigned negative HWPX offsets and bounds unrepresentable DOCX positions', () => {
    const model = parseHwpx(hwpx({ sections: [content('<hp:rect><hp:pos treatAsChar="0" horzOffset="4294966296" vertOffset="20000000"/></hp:rect>')] }));
    const doc = parse(xmlFiles(model)['word/document.xml']);
    expect(elements(doc, 'posOffset').map((p) => p.textContent)).toEqual(['-127000', '2147483647']);
    expect([...model.warnings].some((w) => w.includes('position exceeds'))).toBe(true);
  });
  it('reads binary drawing geometry, fill, rotation, flips and its own dimensions', () => {
    const component = concat(Buffer.from('$rec').reverse(), new Uint8Array(12), u32(12000), u32(6000), u32(12000), u32(6000), u32(1), u16(45), new Uint8Array(8), u16(0), new Uint8Array(48), u32(0x332211), u32(100), u32(1), [0], u32(1), u32(0xeeddff), u32(0), u32(0xffffffff));
    const object = concat(ctrl('gso ', concat(u32(1), new Uint8Array(8), u32(12000), u32(6000))), record(76, 2, component), record(79, 3, concat([0], new Uint8Array(32))));
    const model = parseHwp5(hwp({ sections: [paragraph(controlText(11, 'gso '), { children: [object] })] }));
    const doc = parse(xmlFiles(model)['word/document.xml']);
    const transform = elements(doc, 'xfrm')[0];
    expect([transform.getAttribute('rot'), transform.getAttribute('flipH')]).toEqual(['2700000', '1']);
    // A counterclockwise turn is stored as a negative 16-bit angle: -36 degrees is 324, not 65500.
    const turned = parseHwp5(hwp({ sections: [paragraph(controlText(11, 'gso '), { children: [concat(ctrl('gso ', concat(u32(1), new Uint8Array(8), u32(12000), u32(6000))), record(76, 2, Buffer.from(component).fill(0, 0)), record(79, 3, concat([0], new Uint8Array(32))))] })] }));
    void turned;
    const negative = Buffer.from(component); negative.writeUInt16LE(65500, 4 + 12 + 16 + 4);
    const turnedDoc = parse(xmlFiles(parseHwp5(hwp({ sections: [paragraph(controlText(11, 'gso '), { children: [concat(ctrl('gso ', concat(u32(1), new Uint8Array(8), u32(12000), u32(6000))), record(76, 2, negative), record(79, 3, concat([0], new Uint8Array(32))))] })] })))['word/document.xml']);
    expect(elements(turnedDoc, 'xfrm')[0].getAttribute('rot')).toBe(String(324 * 60000));
    expect(elements(doc, 'prstGeom')[0].getAttribute('prst')).toBe('rect');
    expect(elements(doc, 'srgbClr').map((c) => c.getAttribute('val'))).toEqual(['ffddee', '112233']);
    expect(elements(doc, 'extent')[0].getAttribute('cx')).toBe('1524000');
  });
  it('uses intrinsic raster size for binary cropping even when the picture is resized', () => {
    const png = pngImage(400, 200);
    const picture = concat(ctrl('gso ', concat(u32(1), new Uint8Array(8), u32(7200), u32(3600))), record(85, 2, concat(new Uint8Array(44), u32(7500), u32(1500), u32(22500), u32(13500), new Uint8Array(11), u16(1))));
    const model = parseHwp5(hwp({ compressed: false, sections: [paragraph(controlText(11, 'gso '), { children: [picture] })], infoExtra: [record(18, 1, concat(u16(1), u16(1), string('png')))], streams: { 'BinData/BIN0001.png': png } }));
    const doc = parse(xmlFiles(model)['word/document.xml']), crop = elements(doc, 'srcRect')[0];
    expect(['l', 't', 'r', 'b'].map((key) => crop.getAttribute(key))).toEqual(['25000', '10000', '25000', '10000']);
    expect(elements(doc, 'extent')[0].getAttribute('cx')).toBe('914400');
  });
  it('reads JPEG dimensions through metadata and rejects truncated or zero-sized rasters', () => {
    const jpeg = new Uint8Array([255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 11, 8, 0, 100, 0, 200, 1, 1, 17, 0, 255, 217]);
    expect(imageSize(jpeg)).toEqual({ width: 200, height: 100 });
    expect(imageSize(jpeg.subarray(0, 16))).toBeNull();
    expect(imageSize(new Uint8Array())).toBeNull();
    const gif = new Uint8Array([71, 73, 70, 56, 57, 97, 0, 0, 10, 0]);
    expect(imageSize(gif)).toBeNull();
  });
  it('generates mirrored page numbers, a section restart and a first-page exception', () => {
    const source = content('<hp:secPr><hp:startNum page="7" pageStartsOn="ODD"/><hp:visibility hideFirstPageNum="1"/></hp:secPr><hp:ctrl><hp:pageNum pos="OUTSIDE_BOTTOM" formatType="ROMAN_SMALL" sideChar="-"/></hp:ctrl><hp:t>body</hp:t>');
    const files = xmlFiles(parseHwpx(hwpx({ sections: [source] }))), doc = parse(files['word/document.xml']);
    expect(attr(elements(doc, 'pgNumType')[0], 'start')).toBe('7');
    expect(attr(elements(doc, 'pgNumType')[0], 'fmt')).toBe('lowerRoman');
    expect(attr(elements(doc, 'type')[0], 'val')).toBe('oddPage');
    expect(elements(doc, 'titlePg')).toHaveLength(1);
    const rels = parse(files['word/_rels/document.xml.rels']);
    const targets = new Map(elements(rels, 'Relationship').map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]));
    const footers = new Map(elements(doc, 'footerReference').map((r) => [attr(r, 'type'), parse(files['word/' + targets.get(r.getAttribute('r:id'))])]));
    expect(attr(elements(footers.get('default'), 'jc')[0], 'val')).toBe('right');
    expect(attr(elements(footers.get('even'), 'jc')[0], 'val')).toBe('left');
    expect(elements(footers.get('first'), 'fldSimple')).toHaveLength(0);
    expect(files['word/settings.xml']).toContain('evenAndOddHeaders');
  });
  it('keeps a visible first-page footer when only the header is hidden', () => {
    const source = content('<hp:secPr><hp:visibility hideFirstHeader="1"/></hp:secPr><hp:ctrl><hp:header><hp:subList>' + ptext('header') + '</hp:subList></hp:header><hp:footer><hp:subList>' + ptext('footer') + '</hp:subList></hp:footer></hp:ctrl>');
    const files = xmlFiles(parseHwpx(hwpx({ sections: [source] })));
    expect(files['word/header2.xml']).not.toContain('>header<');
    expect(Object.entries(files).filter(([name]) => /footer\d.xml$/.test(name)).some(([, xml]) => xml.includes('>footer<'))).toBe(true);
  });
  it('preserves unequal HWPX column widths, gutters and a separator', () => {
    const source = content('<hp:ctrl><hp:colPr colCount="2" sameSz="0" sameGap="1200"><hp:colSz width="12000" gap="1200"/><hp:colSz width="18000" gap="0"/><hp:colLine type="SOLID"/></hp:colPr></hp:ctrl>');
    const doc = parse(xmlFiles(parseHwpx(hwpx({ sections: [source] })))['word/document.xml']);
    expect(elements(doc, 'col').map((c) => attr(c, 'w'))).toEqual(['2400', '3600']);
    expect(attr(elements(doc, 'cols')[0], 'sep')).toBe('1');
  });
  it.each(['HWP', 'HWPX'])('keeps a later %s column change from altering earlier text', (format) => {
    const model = format === 'HWPX' ? parseHwpx(hwpx({ sections: [ptext('full width') + content('<hp:ctrl><hp:colPr colCount="2" sameSz="1" sameGap="1000"/></hp:ctrl><hp:t>two columns</hp:t>')] }))
      : parseHwp5(hwp({ sections: [concat(paragraph('full width'), paragraph('two columns', { children: [ctrl('cold', concat(u16(2 << 2 | 1 << 12), u16(1000)))] }))] }));
    const doc = parse(xmlFiles(model)['word/document.xml']);
    expect(model.sections.map((s) => s.blocks[0].runs[0].text)).toEqual(['full width', 'two columns']);
    expect(elements(doc, 'cols').map((c) => attr(c, 'num'))).toEqual(['1', '2']);
    expect(elements(doc, 'type').map((c) => attr(c, 'val'))).toEqual(['nextPage', 'continuous']);
  });
  it('writes the default tab before even/odd settings and drops invalid explicit stops', () => {
    // Legacy tab values are half HWPUNITs: 1000 is a 100-twip stop, and 400000 lies beyond the DOCX range.
    const header = '<hh:tabPr id="0"><hh:tabItem pos="1000" type="LEFT" leader="DOT"/><hh:tabItem pos="400000" type="LEFT"/></hh:tabPr><hh:paraPr id="0" tabPrIDRef="0"/>';
    const model = parseHwpx(hwpx({ header, sections: [content('<hp:secPr tabStop="8000"/><hp:ctrl><hp:pageNum pos="OUTSIDE_BOTTOM"/></hp:ctrl>')] }));
    const files = xmlFiles(model);
    const settings = parse(files['word/settings.xml']).documentElement;
    expect([...settings.children].map((c) => c.localName)).toEqual(['defaultTabStop', 'evenAndOddHeaders', 'compat']);
    expect(attr(settings.children[0], 'val')).toBe('800');
    expect(elements(parse(files['word/document.xml']), 'tab').map((t) => [attr(t, 'pos'), attr(t, 'leader')])).toEqual([['100', 'dot']]);
    expect([...model.warnings].some((w) => w.includes('Tab stops'))).toBe(true);
  });
  it('preserves table padding inheritance, minimum heights and vertical cell text', () => {
    const table = '<hp:tbl rowCnt="1" colCnt="1" cellSpacing="100" pageBreak="NONE"><hp:inMargin left="500" right="500" top="200" bottom="200"/><hp:tr><hp:tc hasMargin="0"><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="12000" height="3000"/><hp:cellMargin left="0"/><hp:subList textDirection="VERTICAL">' + ptext('cell') + '</hp:subList></hp:tc></hp:tr></hp:tbl>';
    const doc = parse(xmlFiles(parseHwpx(hwpx({ sections: [content(table)] })))['word/document.xml']);
    expect(elements(doc, 'tcMar')).toHaveLength(0);
    expect(attr(elements(doc, 'trHeight')[0], 'val')).toBe('600');
    expect(attr(elements(doc, 'trHeight')[0], 'hRule')).toBe('atLeast');
    expect(attr(elements(doc, 'tblCellSpacing')[0], 'w')).toBe('20');
    expect(attr(elements(doc, 'textDirection')[0], 'val')).toBe('tbRl');
    expect(elements(doc, 'cantSplit')).toHaveLength(1);
  });
  it('preserves binary page number placement and restart', () => {
    const model = parseHwp5(hwp({ sections: [paragraph('body', { children: [ctrl('pgnp', concat(u32(5 << 8 | 3), u16(0), u16(45), u16(45), u16(45))), ctrl('nwno', concat(u32(0), u16(12)))] })] }));
    const files = xmlFiles(model);
    expect(files['word/document.xml']).toContain('<w:pgNumType w:start="12" w:fmt="lowerRoman"/>');
    expect(Object.entries(files).find(([name]) => /footer\d.xml$/.test(name))[1]).toContain('w:instr="PAGE"');
  });
  it.each(['HWP', 'HWPX'])('keeps %s total-page counters as dynamic NUMPAGES fields', (format) => {
    const model = format === 'HWPX' ? parseHwpx(hwpx({ sections: [content('<hp:autoNum numType="TOTAL_PAGE" num="12"/>')] }))
      : parseHwp5(hwp({ sections: [paragraph(controlText(18, 'atno'), { children: [ctrl('atno', concat(u32(6), u16(12)))] })] }));
    const fields = elements(parse(xmlFiles(model)['word/document.xml']), 'fldSimple');
    expect(attr(fields[0], 'instr')).toBe('NUMPAGES');
    expect(fields[0].textContent).toBe('12');
  });
  it('reads UTF-16BE sections and carries document metadata into DOCX properties', () => {
    const archive = unzipSync(hwpx());
    const utf = Buffer.from(strFromU8(archive['Contents/section0.xml']), 'utf16le'); utf.swap16(); archive['Contents/section0.xml'] = concat([254, 255], utf);
    archive['Contents/content.hpf'] = strToU8(strFromU8(archive['Contents/content.hpf']).replace('<manifest>', '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>한글 제목</dc:title><dc:creator>Kim</dc:creator></metadata><manifest>'));
    const files = xmlFiles(parseHwpx(zipSync(archive)));
    expect(files['word/document.xml']).toContain('안녕하세요 HWPX');
    expect(files['docProps/core.xml']).toContain('<dc:title>한글 제목</dc:title>');
    expect(files['_rels/.rels']).toContain('Target="docProps/core.xml"');
  });
  it.each([949, 1200])('reads code-page %s HWP summary strings and FILETIME dates', (codepage) => {
    const text = codepage === 949 ? new Uint8Array([0xb0, 0xa1, 0]) : utf16('가\0');
    const timestamp = Buffer.alloc(8); timestamp.writeBigUInt64LE(BigInt(Date.parse('2026-09-10T12:00:00Z') + 11644473600000) * 10000n);
    const bytes = summary({ 1: concat(u32(2), u16(codepage)), 2: concat(u32(30), u32(text.length), text), 4: concat(u32(31), u32(4), utf16('작성자\0')), 12: concat(u32(64), timestamp) });
    const files = xmlFiles(parseHwp5(hwp({ streams: { '\x05HwpSummaryInformation': bytes } })));
    expect(files['docProps/core.xml']).toContain('<dc:title>가</dc:title>');
    expect(files['docProps/core.xml']).toContain('<dc:creator>작성자</dc:creator>');
    expect(files['docProps/core.xml']).toContain('<dcterms:created xsi:type="dcterms:W3CDTF">2026-09-10T12:00:00.000Z</dcterms:created>');
  });
  it('reports corrupt optional summary properties while retaining document content', () => {
    const bytes = Buffer.from(summary({ 2: concat(u32(31), u32(1), utf16('\0')) })); bytes.writeUInt32LE(0xffffffff, 60);
    const model = parseHwp5(hwp({ streams: { '\x05HwpSummaryInformation': bytes } }));
    expect(xmlFiles(model)['word/document.xml']).toContain('안녕하세요 Hanword');
    expect([...model.warnings]).toContain('Some document summary properties could not be decoded.');
  });
});

describe('number formats DOCX accepts', () => {
  it('writes Hanword-only page and note number formats with the names WordprocessingML defines', () => {
    const model = parseHwpx(hwpx());
    model.sections[0].pageNumber = { position: 'BOTTOM_CENTER', format: 'heavenlyStems' };
    model.sections[0].footNote = { format: 'circledGanada', start: 1 };
    model.sections[0].endNote = { format: 'circledUpperLetter', start: 1 };
    const xml = xmlFiles(model)['word/document.xml'];
    expect(xml).toContain('w:fmt="ganada"');
    expect(xml).toContain('<w:footnotePr><w:numFmt w:val="ganada"/>');
    expect(xml).toContain('<w:endnotePr><w:numFmt w:val="upperLetter"/>');
    expect(xml).not.toMatch(/heavenlyStems|circled/);
  });
});

describe('line spacing bounds', () => {
  it('keeps a damaged line height within what DOCX readers accept', () => {
    const model = parseHwpx(hwpx());
    const para = model.paras[model.sections[0].blocks[0].para];
    para.line = -2147483648; para.lineType = 2;
    expect(xmlFiles(model)['word/document.xml']).toContain('w:line="1" w:lineRule="atLeast"');
    para.line = 2147483647; para.lineType = 1;
    expect(xmlFiles(model)['word/document.xml']).toContain('w:line="31680" w:lineRule="exact"');
    para.line = 160; para.lineType = 0;
    expect(xmlFiles(model)['word/document.xml']).toContain('w:line="384" w:lineRule="auto"');
  });
});

describe('field text', () => {
  it('keeps the spaces around a field result, which DOCX readers would otherwise trim', () => {
    const model = parseHwpx(hwpx());
    model.sections[0].blocks[0].runs.push({ kind: 'field', instruction: 'SEQ Table', text: ' 3 ', char: 0 });
    expect(xmlFiles(model)['word/document.xml']).toContain('<w:fldSimple w:instr="SEQ Table"><w:r><w:rPr>');
    expect(xmlFiles(model)['word/document.xml']).toContain('<w:t xml:space="preserve"> 3 </w:t></w:r></w:fldSimple>');
  });
});

describe('numbered headings at a section start', () => {
  it('keeps the list number of a heading whose page break starts a page with its number hidden', () => {
    const header = '<hh:charPr id="0" height="1000"/><hh:numbering id="1" start="1"><hh:paraHead start="1" level="1" numFormat="DIGIT">^1.</hh:paraHead></hh:numbering>'
      + '<hh:paraPr id="0"/><hh:paraPr id="1"><hh:heading type="NUMBER" idRef="1" level="0"/><hh:breakSetting pageBreakBefore="1"/></hh:paraPr><hh:style id="0" name="Body" paraPrIDRef="0" charPrIDRef="0"/>';
    const p = (para, text, extra = '') => `<hp:p paraPrIDRef="${para}"><hp:run charPrIDRef="0">${extra}<hp:t>${text}</hp:t></hp:run></hp:p>`;
    const hiding = '<hp:ctrl><hp:pageHiding hidePageNum="1"/></hp:ctrl>';
    const model = parseHwpx(hwpx({ header, sections: [p(0, 'cover') + p(1, 'Chapter one', hiding) + p(1, 'Chapter two')] }));
    const numbers = xmlFiles(model)['word/document.xml'].match(/<w:numId w:val="(\d+)"\/>/g);
    expect(numbers).toEqual(['<w:numId w:val="0"/>', '<w:numId w:val="1"/>', '<w:numId w:val="1"/>']);
  });
});

describe('list levels beyond the definition', () => {
  it('defines every level a paragraph can use, so a deep item does not show an empty marker', () => {
    const header = '<hh:charPr id="0" height="1000"/><hh:numbering id="1" start="1"><hh:paraHead start="1" level="1" numFormat="DIGIT">^1.</hh:paraHead></hh:numbering>'
      + '<hh:paraPr id="0"/><hh:paraPr id="1"><hh:heading type="NUMBER" idRef="1" level="8"/></hh:paraPr><hh:style id="0" name="Body" paraPrIDRef="0" charPrIDRef="0"/>';
    const model = parseHwpx(hwpx({ header, sections: ['<hp:p paraPrIDRef="1"><hp:run charPrIDRef="0"><hp:t>deep</hp:t></hp:run></hp:p>'] }));
    const files = xmlFiles(model);
    expect(files['word/document.xml']).toContain('<w:ilvl w:val="8"/>');
    expect(files['word/numbering.xml'].match(/<w:lvl w:ilvl="\d"/g)).toHaveLength(9);
    expect(files['word/numbering.xml']).toContain('<w:lvl w:ilvl="8"><w:start w:val="1"/><w:numFmt w:val="decimal"/>');
  });
});

describe('hyperlink targets', () => {
  it('writes a link address as a URI DOCX readers accept, encoding the characters one cannot hold', () => {
    const model = parseHwpx(hwpx());
    model.sections[0].blocks[0].runs[0].href = 'https://example.com/?q={x}|y^z`w\\v';
    const rels = xmlFiles(model)['word/_rels/document.xml.rels'];
    expect(rels).toContain('Target="https://example.com/?q=%7Bx%7D%7Cy%5Ez%60w%5Cv" TargetMode="External"');
  });
});
