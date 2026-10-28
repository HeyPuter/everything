import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraphFormat } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { fontMetrics } from '../src/engine/font-metrics.js';

// §17.3.1.12 ind: leftChars, rightChars, firstLineChars and hangingChars give an indent in hundredths
// of a character unit and, when nonzero, override left, right, firstLine and hanging. Chinese and
// Japanese documents (Word, WPS) indent nearly every paragraph this way ("首行缩进 2 字符"), so they
// all opened read-only ("character-unit paragraph indents"). Word measures a character unit by the
// East Asian font size of the Normal style; here 10.5 pt, so 200 hundredths are 420 twips.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const paragraph = (ind, text, style = '') => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${ind ? `<w:ind ${ind}/>` : ''}</w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
const BODY = [
  paragraph('w:firstLineChars="200" w:firstLine="420"', 'Word pair'),
  paragraph('w:firstLineChars="200"', 'Characters only'),
  paragraph('w:leftChars="100" w:left="210" w:hangingChars="50" w:hanging="105"', 'Left and hanging'),
  paragraph('w:firstLineChars="200" w:firstLine="999"', 'Characters win'),
  paragraph('', 'From style', 'Indented'),
  paragraph('w:firstLineChars="0" w:firstLine="0"', 'Style cleared', 'Indented'),
  paragraph('w:rightChars="300" w:right="0"', 'Right'),
  paragraph('w:firstLineChars="200" w:firstLine="420"', 'Big heading', 'Big'),
  paragraph('', 'Child style', 'Child'),
].join('');
function source() {
  const styles = `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:jc w:val="both"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Indented"><w:name w:val="Indented"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:firstLineChars="200" w:firstLine="420"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Child"><w:name w:val="Child"/><w:basedOn w:val="Indented"/></w:style><w:style w:type="paragraph" w:styleId="Big"><w:name w:val="Big"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="44"/></w:rPr></w:style></w:styles>`;
  return zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/></Relationships>`,
    'word/styles.xml': styles,
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${BODY}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  }).map(([name, xml]) => [name, strToU8(xml)])));
}
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const indents = doc => Object.fromEntries(doc.paragraphs.map(p => { const f = paragraphFormat(p, doc.numbering); return [p.runs.map(r => r.text).join(''), [f.indentLeft, f.indentRight, f.firstLine]]; }));
const save = async (pkg, doc) => unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer()));
const EXPECTED = { 'Word pair': [0, 0, 420], 'Characters only': [0, 0, 420], 'Left and hanging': [210, 0, -105], 'Characters win': [0, 0, 420], 'From style': [0, 0, 420], 'Style cleared': [0, 0, 0], Right: [0, 630, 0], 'Big heading': [0, 0, 420], 'Child style': [0, 0, 420] };

it('opens character-unit indents for editing and lays the text out at their size', async () => {
  const pkg = await DocxPackage.open(source());
  expect(pkg.readOnly).toBeFalsy();
  const doc = model(pkg);
  expect(indents(doc)).toEqual(EXPECTED);
  const measure = (text, style) => ({ ...fontMetrics(style), width: [...text].length * style.fontSize / 2 });
  const lines = layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables).lines;
  const left = text => lines.find(l => doc.text.slice(l.start, l.end).startsWith(text)).fragments[0].x;
  // 420 twips are 28 CSS pixels.
  expect(left('Word pair') - left('Style cleared')).toBeCloseTo(28, 5);
  expect(left('Characters win') - left('Style cleared')).toBeCloseTo(28, 5);
});

it('keeps untouched character-unit attributes and writes an edited indent that Word reads the same way', async () => {
  const pkg = await DocxPackage.open(source()), doc = model(pkg);
  doc.select(doc.text.indexOf('Right') + 5); doc.replace(' edge');
  let xml = strFromU8((await save(pkg, doc))['word/document.xml']);
  for (const ind of ['w:firstLineChars="200" w:firstLine="420"', 'w:firstLineChars="200"/>', 'w:leftChars="100" w:left="210" w:hangingChars="50" w:hanging="105"', 'w:rightChars="300" w:right="0"']) expect(xml).toContain(ind);
  // A changed indent is written in twips, with its character-unit form set to zero so it no longer overrides them.
  doc.select(doc.text.indexOf('Word pair')); doc.setParagraphFormat({ firstLine: 720 });
  doc.select(doc.text.indexOf('From style')); doc.setParagraphFormat({ indentLeft: 360 });
  doc.select(doc.text.indexOf('Left and hanging')); doc.setParagraphFormat({ firstLine: 0 });
  const parts = await save(pkg, doc); xml = strFromU8(parts['word/document.xml']);
  expect(xml).toMatch(/<w:ind w:firstLineChars="0" w:firstLine="720"\/>|<w:ind w:firstLine="720" w:firstLineChars="0"\/>/);
  const reopened = model(await DocxPackage.open(zipSync(parts)));
  const { Right, ...rest } = EXPECTED;
  expect(indents(reopened)).toEqual({ ...rest, 'Word pair': [0, 0, 720], 'From style': [360, 0, 420], 'Left and hanging': [210, 0, 0], 'Right edge': Right });
  // A style that inherits its character-unit indent gets a zero character-unit form beside its own twips.
  doc.editParagraphStyle('Child', { paragraph: { firstLine: 120 } });
  const edited = await save(pkg, doc);
  expect(strFromU8(edited['word/styles.xml'])).toMatch(/w:styleId="Child">.*?<w:ind (?=[^>]*w:firstLine="120")(?=[^>]*w:firstLineChars="0")[^>]*\/>/);
  expect(indents(model(await DocxPackage.open(zipSync(edited))))['Child style']).toEqual([0, 0, 120]);
  // Editing a style's indent does the same in the style.
  doc.editParagraphStyle('Indented', { paragraph: { firstLine: 240 } });
  const styles = strFromU8((await save(pkg, doc))['word/styles.xml']);
  expect(styles).toMatch(/w:styleId="Indented">.*<w:ind [^>]*w:firstLine="240"/);
  expect(styles).toMatch(/w:styleId="Indented">.*<w:ind [^>]*w:firstLineChars="0"/);
  expect(indents(doc)['Style cleared']).toEqual([0, 0, 0]);
  expect(indents(doc)['From style']).toEqual([360, 0, 240]);
  expect(indents(doc)['Child style']).toEqual([0, 0, 120]);
});
