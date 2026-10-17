import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { paragraph } from '../src/engine/model.js';
import { applyDesignTheme, applyStyleSetParts, captureStyleSet, currentStyleSetName, readThemeInfo, refreshStyleThemeColors } from '../src/engine/package-design.js';
import { THEMES, STYLE_SETS, resolvedTheme, fontScheme, colorScheme, effectScheme, COLOR_SLOTS } from '../src/engine/document-themes.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const blank = () => {
  const p1 = paragraph('Annual summary'), p2 = paragraph('Body text');
  p1.styleId = 'Heading1';
  return createDocx([p1, p2], undefined, undefined, undefined, [], {}, WRITING_STYLES);
};
const partsOf = async pkg => unzipSync(new Uint8Array(await pkg.export().arrayBuffer()));
const styleRun = (pkg, id) => pkg.styles.definitions[id]?.run || {};

it('ships complete original schemes for every theme', () => {
  for (const theme of THEMES) {
    const resolved = resolvedTheme(theme);
    expect(resolved.fonts, theme.name).toBeTruthy(); expect(resolved.effects, theme.name).toBeTruthy();
    for (const slot of COLOR_SLOTS) expect(resolved.colors[slot], `${theme.name} ${slot}`).toMatch(/^[0-9A-F]{6}$/);
  }
  expect(new Set(THEMES.map(t => t.name)).size).toBe(THEMES.length);
  for (const set of STYLE_SETS) expect(Object.keys(set.styles)).toContain('Heading1');
});

it('creates a theme part for a new document, links its styles, and reads back theme fonts and colors', async () => {
  const parts = await partsOf(blank());
  const untouched = Object.keys(parts).filter(name => !['word/styles.xml', '[Content_Types].xml', 'word/_rels/document.xml.rels'].includes(name));
  const before = Object.fromEntries(untouched.map(name => [name, parts[name]]));
  const result = applyDesignTheme(parts, { theme: resolvedTheme('Harbor') });
  expect(result.created).toBe(true);
  expect(result.path).toBe('word/theme/theme1.xml');
  for (const name of untouched) expect(parts[name], name).toEqual(before[name]);
  expect(strFromU8(parts['[Content_Types].xml'])).toContain('/word/theme/theme1.xml');
  expect(strFromU8(parts['word/_rels/document.xml.rels'])).toMatch(/relationships\/theme" Target="theme\/theme1\.xml"/);
  const info = readThemeInfo(parts);
  expect(info).toMatchObject({ name: 'Harbor', fonts: { major: 'Montserrat', minor: 'Open Sans' }, effects: 'Soft Shadow' });
  expect(info.colors.accent1).toBe('1B6A8C');
  const pkg = await DocxPackage.open(zipSync(parts));
  expect(pkg.readOnly).not.toBe(true);
  expect(styleRun(pkg, 'Heading1').fontAscii).toBe('Montserrat');
  expect(pkg.styles.defaults.run.fontAscii).toBe('Open Sans');
  // Heading 1 takes accent 1, darkened, from the Default style set.
  expect(styleRun(pkg, 'Heading1').color).toMatch(/^[0-9A-F]{6}$/);
  expect(currentStyleSetName(parts)).toBe('Default');
});

it('changes only the colors, fonts or effects asked for and keeps imported explicit fonts', async () => {
  const parts = await partsOf(blank());
  applyDesignTheme(parts, { theme: resolvedTheme('Paper') });
  const heading = async () => styleRun(await DocxPackage.open(zipSync(parts)), 'Heading1');
  const paperColor = (await heading()).color;
  applyDesignTheme(parts, { colors: { name: 'Ember', ...colorScheme('Ember').colors } });
  refreshStyleThemeColors(parts);
  let info = readThemeInfo(parts);
  expect(info.colorName).toBe('Ember'); expect(info.fonts.major).toBe('Noto Sans'); expect(info.effects).toBe('Flat');
  expect((await heading()).color).not.toBe(paperColor);
  applyDesignTheme(parts, { fonts: fontScheme('Bookish') });
  info = readThemeInfo(parts);
  expect(info.fonts).toMatchObject({ name: 'Bookish', major: 'Cambria', minor: 'Times New Roman' });
  expect((await heading()).fontAscii).toBe('Cambria');
  applyDesignTheme(parts, { effects: effectScheme('Raised') });
  expect(readThemeInfo(parts).effects).toBe('Raised');
  // A document that names its own fonts keeps them; only theme references follow the theme.
  const imported = await partsOf(blank());
  const styles = strFromU8(imported['word/styles.xml']).replace('w:ascii="Noto Sans" w:hAnsi="Noto Sans"', 'w:ascii="Arial" w:hAnsi="Arial"');
  imported['word/styles.xml'] = new TextEncoder().encode(styles);
  applyDesignTheme(imported, { theme: resolvedTheme('Aurora') });
  const reopened = await DocxPackage.open(zipSync(imported));
  expect(reopened.styles.defaults.run.fontAscii).toBe('Arial');
  expect(currentStyleSetName(imported)).toBe(null);
});

it('applies, recognizes and captures style sets, creating built-in styles a set needs', async () => {
  const parts = await partsOf(blank());
  applyDesignTheme(parts, { theme: resolvedTheme('Meadow') });
  for (const set of STYLE_SETS) {
    applyStyleSetParts(parts, set);
    expect(currentStyleSetName(parts), set.name).toBe(set.name);
    const pkg = await DocxPackage.open(zipSync(parts));
    expect(pkg.readOnly, set.name).not.toBe(true);
    expect(pkg.styles.definitions.Quote?.name, set.name).toBe('Quote');
    expect(styleRun(pkg, 'Heading1').fontSize, set.name).toBe(set.styles.Heading1.size);
  }
  const saved = { name: 'Mine', snippets: captureStyleSet(parts) };
  applyStyleSetParts(parts, STYLE_SETS[0]);
  expect(currentStyleSetName(parts)).toBe('Default');
  applyStyleSetParts(parts, saved);
  expect(currentStyleSetName(parts, [...STYLE_SETS, saved])).toBe(STYLE_SETS.at(-1).name);
});

// A 2×2 opaque PNG, written here byte by byte.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));

it('writes a text watermark into every page header and reads it back as a behind-text drawing', async () => {
  const { setWatermarkParts, readWatermark } = await import('../src/engine/package-design.js');
  const parts = await partsOf(blank());
  const watermark = { kind: 'text', text: 'DRAFT', size: 'auto', color: 'C0C0C0', semitransparent: true, layout: 'diagonal', font: 'Noto Sans' };
  setWatermarkParts(parts, watermark);
  expect(readWatermark(parts)).toEqual(watermark);
  const header = Object.keys(parts).find(name => /^word\/header\d+\.xml$/.test(name));
  expect(strFromU8(parts['word/document.xml'])).toMatch(/<w:headerReference w:type="default" r:id="rIdheader1"\/>/);
  expect(strFromU8(parts[header])).toContain('behindDoc="1"');
  const pkg = await DocxPackage.open(zipSync(parts));
  expect(pkg.readOnly).not.toBe(true);
  const story = Object.values(pkg.pageStories.stories).find(s => s.kind === 'header');
  const images = story.paragraphs.flatMap(p => p.runs.filter(r => r.image).map(r => r.image));
  expect(images).toHaveLength(1);
  expect(images[0].anchor.behind).toBe(true);
  // Replacing keeps one watermark; removing leaves the header without it.
  setWatermarkParts(parts, { ...watermark, text: 'SAMPLE', layout: 'horizontal' });
  expect(readWatermark(parts).text).toBe('SAMPLE');
  expect(strFromU8(parts[header]).match(/name="Document Watermark"/g)).toHaveLength(1);
  setWatermarkParts(parts, null);
  expect(readWatermark(parts)).toBe(null);
  expect(strFromU8(parts[header])).not.toContain('Document Watermark');
});

it('adds a washed-out picture watermark and a tiled picture page background', async () => {
  const { setWatermarkParts, readWatermark, setPageFillParts, hasPageFill } = await import('../src/engine/package-design.js');
  const parts = await partsOf(blank());
  setWatermarkParts(parts, { kind: 'picture', bytes: PNG, mime: 'image/png', width: 2, height: 2, scale: 'auto', washout: true });
  expect(readWatermark(parts)).toMatchObject({ kind: 'picture', washout: true });
  setPageFillParts(parts, { bytes: PNG, mime: 'image/png', title: 'Texture', color: 'FFFFFF' });
  expect(hasPageFill(parts)).toBe(true);
  expect(strFromU8(parts['word/settings.xml'])).toContain('<w:displayBackgroundShape/>');
  const pkg = await DocxPackage.open(zipSync(parts));
  expect(pkg.readOnly).not.toBe(true);
  expect(pkg.pageSettings.backgroundPicture).toMatchObject({ width: expect.any(Number) });
  setPageFillParts(parts, null);
  expect(hasPageFill(parts)).toBe(false);
});

it('effect schemes change the fills, outlines and shadows of shapes that use theme styles', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('public/fixtures/shape-theme.docx');
  const scenes = pkg => Object.values(pkg.assets).filter(a => a.scene).map(a => a.scene);
  const results = {};
  for (const scheme of ['Flat', 'Bold Outline', 'Soft Shadow', 'Gradient', 'Raised']) {
    const parts = unzipSync(source);
    applyDesignTheme(parts, { effects: effectScheme(scheme) });
    const pkg = await DocxPackage.open(zipSync(parts));
    expect(pkg.readOnly, scheme).not.toBe(true);
    results[scheme] = scenes(pkg);
  }
  expect(JSON.stringify(results['Bold Outline'])).not.toBe(JSON.stringify(results.Flat));
  // Theme colors apply to the same shapes.
  const parts = unzipSync(source);
  applyDesignTheme(parts, { colors: { name: 'Lagoon', ...colorScheme('Lagoon').colors } });
  const recolored = scenes(await DocxPackage.open(zipSync(parts)));
  expect(recolored.map(s => s.fill)).not.toEqual(scenes(await DocxPackage.open(source)).map(s => s.fill));
});

it('puts the watermark on first and even pages too, reusing headers a section already has', async () => {
  const { setWatermarkParts, readWatermark } = await import('../src/engine/package-design.js');
  const { strToU8 } = await import('fflate');
  const parts = await partsOf(blank());
  const document = strFromU8(parts['word/document.xml']).replace(/<w:sectPr>/, '<w:sectPr><w:titlePg/>');
  parts['word/document.xml'] = strToU8(document);
  parts['word/settings.xml'] = strToU8('<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:evenAndOddHeaders/></w:settings>');
  parts['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']).replace('</Relationships>', '<Relationship Id="rSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>'));
  parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('</Types>', '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>'));
  setWatermarkParts(parts, { kind: 'text', text: 'INTERNAL', size: 'auto', color: '999999', semitransparent: false, layout: 'horizontal' });
  const headers = Object.keys(parts).filter(name => /^word\/header\d+\.xml$/.test(name));
  expect(headers).toHaveLength(3);
  const xml = strFromU8(parts['word/document.xml']);
  for (const kind of ['default', 'first', 'even']) expect(xml).toContain(`w:type="${kind}"`);
  for (const header of headers) expect(strFromU8(parts[header])).toContain('INTERNAL');
  // Applying again reuses the same headers rather than adding new ones.
  setWatermarkParts(parts, { kind: 'text', text: 'FINAL', size: 72, color: '999999', semitransparent: false, layout: 'diagonal' });
  expect(Object.keys(parts).filter(name => /^word\/header\d+\.xml$/.test(name))).toHaveLength(3);
  expect(readWatermark(parts)).toMatchObject({ text: 'FINAL', size: 72 });
  const pkg = await DocxPackage.open(zipSync(parts));
  expect(pkg.readOnly).not.toBe(true);
});

it('imports theme files from .thmx packages and rejects files that are not themes', async () => {
  const { themeFileXml, themeXml } = await import('../src/engine/package-design.js');
  const { strToU8 } = await import('fflate');
  const xml = themeXml(resolvedTheme('Citrus'));
  expect(themeFileXml(zipSync({ 'theme/theme/theme1.xml': strToU8(xml) }))).toContain('name="Citrus"');
  expect(themeFileXml(strToU8(xml))).toContain('<a:fontScheme name="Poster">');
  expect(() => themeFileXml(strToU8('<w:document xmlns:w="urn:x"/>'))).toThrow('not a document theme');
  expect(() => themeFileXml(zipSync({ 'readme.txt': strToU8('x') }))).toThrow('does not contain a theme');
});

it('restyles the independently authored design fixture and keeps its explicit fonts, header text and background', async () => {
  const { readFileSync } = await import('node:fs');
  const { setWatermarkParts, readWatermark, hasPageFill } = await import('../src/engine/package-design.js');
  const source = readFileSync('public/fixtures/design-theme.docx');
  const original = await DocxPackage.open(source);
  expect(original.readOnly).not.toBe(true);
  expect(styleRun(original, 'Heading1')).toMatchObject({ fontAscii: 'Montserrat', color: '2E7D5B' });
  expect(original.pageSettings.backgroundPicture).toBeTruthy();
  const parts = unzipSync(source);
  expect(readThemeInfo(parts)).toMatchObject({ name: 'Probe Forest', fonts: { major: 'Montserrat', minor: 'Open Sans' } });
  expect(readWatermark(parts)).toEqual({ kind: 'text' });
  expect(hasPageFill(parts)).toBe(true);
  const untouched = { ...parts };
  applyDesignTheme(parts, { theme: resolvedTheme('Ember') });
  refreshStyleThemeColors(parts);
  // Only the theme part and the theme-colored style values change.
  for (const name of Object.keys(untouched)) if (!['word/theme/forest.xml', 'word/styles.xml'].includes(name)) expect(parts[name], name).toEqual(untouched[name]);
  const themed = await DocxPackage.open(zipSync(parts));
  expect(styleRun(themed, 'Heading1')).toMatchObject({ fontAscii: 'Oswald', color: 'C0392B' });
  expect(styleRun(themed, 'Signature').fontAscii).toBe('Courier New');
  expect(themed.styles.defaults.run.fontAscii).toBe('Source Sans Pro');
  setWatermarkParts(parts, { kind: 'text', text: 'REPLACED', size: 'auto', color: 'C0C0C0', semitransparent: true, layout: 'diagonal' });
  const header = strFromU8(parts['word/top.xml']);
  expect(header).toContain('REPLACED'); expect(header).not.toContain('PROBE'); expect(header).toContain('Probe header');
  expect((await DocxPackage.open(zipSync(parts))).readOnly).not.toBe(true);
});

it('applies Design changes to a package whose parts are UTF-16', async () => {
  const { setWatermarkParts, readWatermark, setPageFillParts, hasPageFill, themePartXml } = await import('../src/engine/package-design.js');
  const utf16 = text => new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<?xml version="1.0" encoding="UTF-16" standalone="yes"?>' + text.replace(/^<\?xml[^>]*\?>/, ''), 'utf16le')]));
  const source = await partsOf(blank());
  applyDesignTheme(source, { theme: resolvedTheme('Ember') });
  const parts = Object.fromEntries(Object.entries(source).map(([name, bytes]) => [name, utf16(strFromU8(bytes))]));
  expect(themePartXml(parts)).toBe(strFromU8(source[Object.keys(source).find(name => name.startsWith('word/theme/'))]).replace(/^(<\?xml[^>]*encoding=")[^"]*/, '$1UTF-8'));
  applyDesignTheme(parts, { theme: resolvedTheme('Paper') });
  setWatermarkParts(parts, { kind: 'text', text: 'DRAFT', size: 'auto', color: 'C0C0C0', semitransparent: true, layout: 'diagonal' });
  setPageFillParts(parts, { bytes: PNG, mime: 'image/png', title: 'Texture', color: 'FFFFFF' });
  const reopened = await DocxPackage.open(zipSync(parts));
  expect(reopened.readOnly).not.toBe(true);
  expect(readThemeInfo(parts).name).toBe('Paper');
  expect(readWatermark(parts)).toMatchObject({ text: 'DRAFT' });
  expect(hasPageFill(parts)).toBe(true);
});
