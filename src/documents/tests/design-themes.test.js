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
