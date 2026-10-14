import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { pageLookup } from '../src/engine/page-lookup.js';
import { noteNumbers } from '../src/engine/footnotes.js';
import { updateSequenceFields } from '../src/engine/field-update.js';
import { refreshPageReferences } from '../src/engine/page-reference-refresh.js';
import { readBibliographyPart, styleOf, updateCitations, updateBibliographies } from '../src/engine/bibliography-fields.js';
import { writeIndex, indexFields } from '../src/engine/index-entries.js';
import { writeTableOfAuthorities, tableFields } from '../src/engine/authorities.js';
import { insertTableOfContents, tableOfContents } from '../src/engine/toc.js';

// tools/references_fixture.py writes this package by hand from the specification.
const source = readFileSync('tests/fixtures/references/references.docx');
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const measure = (text, style) => ({ width: text.length * style.fontSize * .6, ascent: style.fontSize * .8, descent: style.fontSize * .2 });
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const layout = (pkg, d) => layoutDocument(d.paragraphs, measure, pageGeometry(d.pageSettings), d.numbering, d.tables, pkg.pageStories, { styles: d.styles });
const save = async (pkg, d) => new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer());

describe('independently written references fixture', () => {
  it('opens editable with its notes, settings and sources, and saves unchanged when untouched', async () => {
    const pkg = await DocxPackage.open(source), d = model(pkg);
    expect(pkg.readOnly).toBeFalsy();
    expect(pkg.pageStories.footnotes).toMatchObject({ format: 'upperRoman', start: 2, restart: 'continuous' });
    expect(pkg.pageStories.endnotes).toMatchObject({ format: 'decimal', position: 'docEnd' });
    const placed = layout(pkg, d);
    expect(placed.footnoteAreas.flatMap(a => a.notes.map(n => n.display))).toEqual(['II', '', 'III']);
    expect(placed.endnoteAreas.flatMap(a => a.notes.map(n => n.display))).toEqual(['1']);
    expect(bodyFieldRanges(d.paragraphs).map(r => r.field.type)).toEqual(['TOC', 'CITATION', 'NOTEREF', 'XE', 'XE', 'TC', 'TA', 'TA', 'SEQ', 'INDEX', 'TOA', 'BIBLIOGRAPHY']);
    const data = readBibliographyPart(pkg.parts).data;
    expect(styleOf(data)).toBe('harvard');
    expect(data.sources.map(s => s.tag)).toEqual(['Lov20', 'Hop19']);
    expect(unzipSync(await save(pkg, d))).toEqual(unzipSync(source));
  });

  it('refreshes every stale cache and keeps the result through a round trip', async () => {
    const pkg = await DocxPackage.open(source), d = model(pkg);
    const { sources } = readBibliographyPart(pkg.parts).data;
    updateCitations(d, sources, 'harvard'); updateBibliographies(d, sources, 'harvard');
    updateSequenceFields(d, { notes: { footnote: noteNumbers(d.paragraphs, pkg.pageStories.footnotes, 'footnote'), endnote: noteNumbers(d.paragraphs, pkg.pageStories.endnotes, 'endnote') } });
    const pages = () => pageLookup(layout(pkg, d), pkg.pageStories);
    writeIndex(d, { existing: indexFields(d.paragraphs)[0], pageOf: pages() });
    writeTableOfAuthorities(d, { existing: tableFields(d.paragraphs)[0], pageOf: pages() });
    insertTableOfContents(d, { existing: tableOfContents(d.paragraphs) });
    refreshPageReferences(d, x => layout(pkg, x), pkg.pageStories, { checkpoint: false });
    const text = d.text;
    expect(text).toContain('Engines compute￼ and machines learn￼ (Lovelace, 2020, p. 4).');
    expect(text).toContain('; see note III.');
    expect(text).toContain('Figure 1: Orbits');
    expect(text).toContain('Reference fixture\t1\nNotes and citations\t1\nPlain subtitle entry\t1\nIndex and authorities\t1\nHidden contents entry\t1\n');
    expect(text).toContain('\nM\nMercury\nplanet, 1\nV\nVenus, 1\n');
    expect(text).toContain('\nCases\nSmith v. Jones, 1 U.S. 1 (1999)\t1\n');
    expect(text).toContain('\nHopper, G. (2019) ‘Compilers’, Machine Review, 4(2), pp. 1–9.\nLovelace, A. (2020) Notes on engines. London: Harbor Press.');
    const bytes = await save(pkg, d);
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/references-fixture-refreshed.docx', bytes);
    const again = model(await DocxPackage.open(bytes));
    expect(again.text).toBe(text);
    const xml = strFromU8(unzipSync(bytes)['word/document.xml']);
    for (const instruction of [' TOC \\o "1-2" \\t "Subtitle,2" \\f C \\h \\z \\u ', ' CITATION Lov20 \\l 1033 \\p 4 ', ' INDEX \\h "A" \\c "1" \\z "1033" ', ' TOA \\h \\c "1" \\p ', ' BIBLIOGRAPHY \\l 1033 '])
      expect(xml).toContain(instruction.replace(/"/g, '&quot;').replace(/&quot;/g, '"'));
    const parts = unzipSync(bytes), original = unzipSync(source);
    for (const name of ['word/footnotes.xml', 'word/endnotes.xml', 'word/settings.xml', 'customXml/item1.xml', 'customXml/itemProps1.xml']) expect(parts[name]).toEqual(original[name]);
  });
});
