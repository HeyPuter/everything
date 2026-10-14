import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { createDocx, DocxPackage, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { viewGeometry, viewPageStories, fitContinuousPages, readingColumns, lineFocusBand, viewFromSetting, settingFromView, spacedFormat, STRIP_HEIGHT, READING_SPACING } from '../src/engine/document-views.js';
import { readDocumentView, writeDocumentView } from '../src/engine/docx-view-settings.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const measure = text => ({ width: text.length * 7, ascent: 12, descent: 4 });
const long = 'Every page is another chance to make the editor a little better. '.repeat(150);
const bytes = async blob => new Uint8Array(await blob.arrayBuffer());

describe('view geometry', () => {
  it('lays web and draft views out at the window width with no stories, borders or columns', () => {
    const authored = { ...pageGeometry({ columns: { count: 2, space: 720, equalWidth: true, separator: false } }), pageBorders: { top: {} } };
    for (const kind of ['web', 'draft']) {
      const page = viewGeometry({ kind, width: 1000 })(authored);
      expect(page).toMatchObject({ width: 1000, height: STRIP_HEIGHT, gap: 0, header: 0, footer: 0, top: 0, bottom: 0, pageBorders: null, columns: null, screenView: true });
      expect(page.left).toBeGreaterThan(0);
    }
    expect(viewGeometry({ kind: 'draft', width: 900 })({ ...authored, background: '#112233' }).background).toBe('#FFFFFF');
    expect(viewGeometry({ kind: 'web', width: 900 })({ ...authored, background: '#112233' }).background).toBe('#112233');
    expect(viewGeometry({ kind: 'print' })).toBeNull();
    expect(viewGeometry(null)).toBeNull();
  });
  it('gives Read Mode screen pages with a page colour and optional text spacing', () => {
    const page = viewGeometry({ kind: 'read', width: 600, height: 800, color: 'sepia', textSpacing: true })(pageGeometry());
    expect(page).toMatchObject({ width: 600, height: 800, background: '#F5ECD9', textSpacing: READING_SPACING, columns: null });
    expect(viewGeometry({ kind: 'read', width: 600, height: 800 })(pageGeometry()).textSpacing).toBeUndefined();
    expect(spacedFormat({ lineRule: 'auto', lineSpacing: 1, spaceAfter: 0 }, READING_SPACING)).toMatchObject({ lineSpacing: READING_SPACING.lineFactor, spaceAfter: READING_SPACING.paragraphAfter });
    expect(spacedFormat({ lineRule: 'exact', lineSpacing: 12 }, null)).toEqual({ lineRule: 'exact', lineSpacing: 12 });
  });
  it('hides headers and footers in screen views but keeps the story definitions', () => {
    const definition = { stories: { h: { kind: 'header', paragraphs: [paragraph('Head')] } }, sections: [{ header: { default: 'h' }, footer: {}, firstPageDifferent: true }] };
    const shown = viewPageStories(definition, 'web');
    expect(shown.sections[0].header).toEqual({});
    expect(shown.stories).toBe(definition.stories);
    expect(definition.sections[0].header.default).toBe('h');
    expect(viewPageStories(definition, 'print')).toBe(definition);
  });
  it('fits Read Mode columns to the window', () => {
    expect(readingColumns(1440, 800).count).toBe(2);
    expect(readingColumns(390, 700).count).toBe(1);
    expect(readingColumns(1440, 800, 'narrow').count).toBeGreaterThanOrEqual(2);
    expect(readingColumns(1440, 800, 'default', 2).width).toBeLessThan(readingColumns(1440, 800).width);
  });
  it('maps views to and from the settings value', () => {
    expect(['print', 'web', 'outline', 'draft'].map(settingFromView)).toEqual(['print', 'web', 'outline', 'normal']);
    expect(settingFromView('read')).toBeNull();
    expect(['print', 'web', 'outline', 'normal', 'masterPages', 'none', 'bogus'].map(viewFromSetting)).toEqual(['print', 'web', 'outline', 'draft', 'outline', 'print', null]);
  });
});

describe('screen layout', () => {
  const paragraphs = [paragraph('Opening line.'), paragraph(long), paragraph('Closing line.')];
  it('reflows text to the window width and joins strips without page gaps', () => {
    const print = layoutDocument(paragraphs, measure, pageGeometry(), undefined, [], undefined);
    const web = layoutDocument(paragraphs, measure, pageGeometry(), undefined, [], undefined, { viewGeometry: viewGeometry({ kind: 'web', width: 1200 }) });
    expect(print.pageCount).toBeGreaterThan(1);
    // A wider measure means fewer lines.
    expect(web.lines.length).toBeLessThan(print.lines.length);
    expect(Math.max(...web.lines.map(l => l.stops.at(-1).x))).toBeLessThanOrEqual(1200);
    expect(web.pageCount).toBe(1);
    const fitted = fitContinuousPages(web, null);
    expect(fitted.pages[0].height).toBeLessThan(STRIP_HEIGHT);
    expect(fitted.pages[0].height).toBeGreaterThanOrEqual(Math.max(...web.lines.map(l => l.y + l.height)));
    expect(web.pages[0].height).toBe(STRIP_HEIGHT);
    expect(fitted.pageOffsets).toEqual([0]);
  });
  it('starts a new strip at a page break and keeps offsets continuous', () => {
    const broken = [paragraph('Before the break\f'), paragraph('After the break')];
    const draft = fitContinuousPages(layoutDocument(broken, measure, pageGeometry(), undefined, [], undefined, { viewGeometry: viewGeometry({ kind: 'draft', width: 800 }) }), null);
    expect(draft.pageCount).toBe(2);
    expect(draft.pageOffsets[1]).toBe(draft.pages[0].height);
    expect(draft.pages.every(p => p.height < 200)).toBe(true);
  });
  it('spaces lines out in Read Mode text spacing', () => {
    const plain = layoutDocument(paragraphs, measure, pageGeometry(), undefined, [], undefined, { viewGeometry: viewGeometry({ kind: 'read', width: 600, height: 800 }) });
    const spaced = layoutDocument(paragraphs, measure, pageGeometry(), undefined, [], undefined, { viewGeometry: viewGeometry({ kind: 'read', width: 600, height: 800, textSpacing: { character: 0 } }) });
    const gap = layout => layout.lines[2].y - layout.lines[1].y;
    expect(gap(spaced)).toBeGreaterThan(gap(plain));
    expect(plain.pages[0]).toMatchObject({ width: 600, height: 800 });
  });
  it('picks the line focus band around a line', () => {
    const layout = layoutDocument(paragraphs, measure, pageGeometry(), undefined, [], undefined);
    const lines = layout.lines.filter(l => l.page === 0);
    const one = lineFocusBand(layout.lines, lines[3], 1), three = lineFocusBand(layout.lines, lines[3], 3);
    expect(one).toMatchObject({ page: 0, top: lines[3].y, bottom: lines[3].y + lines[3].height });
    expect(three.top).toBe(lines[2].y);
    expect(three.bottom).toBe(lines[4].y + lines[4].height);
    expect(lineFocusBand(layout.lines, null)).toBeNull();
  });
});

describe('the view setting in settings.xml', () => {
  it('opens in the saved view and writes only w:view when the view changes', async () => {
    const base = await bytes(createDocx([paragraph('Hello')], undefined, undefined, undefined, [], {}, WRITING_STYLES).export());
    const pkg = await DocxPackage.open(base);
    expect(pkg.documentView).toBeNull();
    // Print Layout on a document that never named a view: nothing to record, the package is unchanged.
    pkg.documentView = 'print';
    expect(unzipSync(await bytes(pkg.export()))).toEqual(unzipSync(base));
    pkg.documentView = 'web';
    const saved = unzipSync(await bytes(pkg.export())), original = unzipSync(base);
    const settings = Object.keys(saved).find(name => /^word\/settings\d*\.xml$/.test(name));
    expect(strFromU8(saved[settings])).toContain('<w:view w:val="web"/>');
    for (const [name, data] of Object.entries(original)) if (!['[Content_Types].xml', 'word/_rels/document.xml.rels'].includes(name)) expect(saved[name], name).toEqual(data);
    const reopened = await DocxPackage.open(zipSync(saved));
    expect(reopened.documentView).toBe('web');
    reopened.documentView = 'draft';
    const draft = unzipSync(await bytes(reopened.export()));
    expect(strFromU8(draft[settings])).toContain('<w:view w:val="normal"/>');
    expect((await DocxPackage.open(zipSync(draft))).documentView).toBe('draft');
  });
  it('places w:view first in an existing settings part and keeps everything else byte for byte', async () => {
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const parts = unzipSync(await bytes(createDocx([paragraph('Hello')]).export()));
    parts['word/settings.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:settings xmlns:w="${W}"><w:writeProtection w:recommended="1"/><w:zoom w:percent="120"/><w:defaultTabStop w:val="720"/></w:settings>`);
    parts['word/_rels/document.xml.rels'] = strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>`);
    const before = { ...parts };
    expect(writeDocumentView(parts, 'outline')).toBe(true);
    expect(strFromU8(parts['word/settings.xml'])).toMatch(/<w:writeProtection w:recommended="1"\/><w:view w:val="outline"\/><w:zoom w:percent="120"\/>/);
    expect(readDocumentView(parts)).toBe('outline');
    for (const name of Object.keys(before)) if (name !== 'word/settings.xml') expect(parts[name]).toBe(before[name]);
    expect(writeDocumentView(parts, 'outline')).toBe(false);
    expect(writeDocumentView(parts, 'read')).toBe(false);
    expect(writeDocumentView(parts, 'print')).toBe(true);
    expect(readDocumentView(parts)).toBe('print');
  });
});

describe('switching views does not change the document', () => {
  it('saves the same body after any view switch', async () => {
    const base = await bytes(createDocx([paragraph('Title'), paragraph(long)], undefined, undefined, undefined, [], {}, WRITING_STYLES).export());
    const pkg = await DocxPackage.open(base);
    const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
    const before = JSON.stringify(model.paragraphs);
    for (const kind of ['web', 'draft', 'read']) layoutDocument(model.paragraphs, measure, pageGeometry(model.pageSettings), model.numbering, model.tables, pkg.pageStories, { styles: model.styles, viewGeometry: viewGeometry({ kind, width: 700, height: 600, textSpacing: true }) });
    expect(JSON.stringify(model.paragraphs)).toBe(before);
    const saved = unzipSync(await bytes(pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets)));
    expect(saved).toEqual(unzipSync(base));
  });
});
