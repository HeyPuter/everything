import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { listMarkers, levelFor } from '../src/engine/numbering.js';
import { advancedFind } from '../src/engine/advanced-search.js';
import { revealFormatting } from '../src/engine/format-inspection.js';
import { deleteStyle } from '../src/engine/style-management.js';
import { defineBullet } from '../src/engine/list-definitions.js';

// tools/format_features_fixture.py writes this package directly as WordprocessingML.
const FIXTURE = 'tests/fixtures/format-features/format.docx';
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const open = async bytes => { const pkg = await DocxPackage.open(bytes); return { pkg, doc: new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets) }; };
const save = async (pkg, doc) => new Uint8Array(await (await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets)).arrayBuffer());

it('opens the independent Format fixture for editing with every feature resolved', async () => {
  const { pkg, doc } = await open(readFileSync(FIXTURE));
  expect(pkg.readOnly).toBeFalsy();
  const [hidden, mirrored, bar, star, step, shaded, outlined, aside] = doc.paragraphs;
  expect(hidden.runs.find(r => r.text === 'hidden words').vanish).toBe(true);
  expect(mirrored.format).toMatchObject({ mirrorIndents: true, suppressLineNumbers: true, suppressAutoHyphens: true, indentLeft: 1440, indentRight: 360 });
  expect(bar.format.tabs).toEqual([{ position: 720, alignment: 'bar' }, { position: 2880, alignment: 'left' }]);
  expect(listMarkers(doc.paragraphs, doc.numbering).map(m => m?.text ?? null)).toEqual([null, null, null, '★', 'Step III:', null, null, null]);
  expect(levelFor(doc.numbering, step.list)).toMatchObject({ suffix: 'space', markerStyle: { bold: true } });
  expect(shaded.format.paragraphShading).toBe('BFBFBF');
  expect(outlined.runs[0].textOutline).toMatchObject({ width: 9525, color: 'C00000' });
  expect(aside.format.alignment).toBe('right');
  expect(doc.pageSettings.pageBorders).toMatchObject({ offsetFrom: 'page', borders: { top: { style: 'double', size: 6 } } });
  // Advanced find sees the hidden run's formatting; Reveal Formatting reports the style's alignment as not direct.
  expect(advancedFind(doc.paragraphs, '', { format: { vanish: true } }, { styles: doc.styles, numbering: doc.numbering }).map(m => m.text)).toEqual(['hidden words']);
  doc.select(doc.text.indexOf('Aside'));
  const alignment = revealFormatting(doc).find(s => s.title === 'Paragraph').entries.find(e => e.label === 'Alignment');
  expect(alignment).toMatchObject({ value: 'Right', direct: false });
});

it('edits the fixture and keeps untouched declarations and parts on save', async () => {
  const source = readFileSync(FIXTURE);
  const { pkg, doc } = await open(source);
  doc.select(doc.text.indexOf('Star'));
  defineBullet(doc, { character: '✓' });
  deleteStyle(doc, 'Aside');
  const bytes = await save(pkg, doc), files = unzipSync(bytes), original = unzipSync(new Uint8Array(source));
  const xml = strFromU8(files['word/document.xml']);
  expect(xml).toMatch(/<w:vanish\/>[\s\S]*hidden words/);
  expect(xml).toMatch(/<w:mirrorIndents\/>/);
  expect(xml).toMatch(/<w:tab w:val="bar" w:pos="720"\/>/);
  expect(xml).toMatch(/<w:shd w:val="pct25"/);
  expect(xml).toMatch(/<w:pgBorders w:offsetFrom="page">/);
  expect(strFromU8(files['word/styles.xml'])).not.toContain('Aside');
  expect(strFromU8(files['word/numbering.xml'])).toContain('<w:lvlText w:val="Step %1:"/>');
  expect(files['[Content_Types].xml']).toEqual(original['[Content_Types].xml']);
  const reopened = await open(bytes);
  expect(listMarkers(reopened.doc.paragraphs, reopened.doc.numbering).map(m => m?.text ?? null)).toEqual([null, null, null, '✓', 'Step III:', null, null, null]);
  expect(reopened.doc.paragraphs[7].format.alignment).toBe('left');
});
