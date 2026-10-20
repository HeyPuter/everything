import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from 'pdf-lib';

/**
 * How a PDF asks to be shown when it opens (a desktop editor's Document Properties > Initial
 * View), and the fonts it uses (the Fonts tab).
 *
 * initial view: { layout: 'single' | 'continuous' | 'two' | 'two-continuous',
 *                 panel: 'none' | 'bookmarks' | 'pages' | 'attachments' | 'layers',
 *                 page (0-based), zoom: 'default' | 'fit' | 'page' | number (1 = 100%),
 *                 fullScreen, displayTitle }
 */
const name = PDFName.of;
const LAYOUTS = {
  SinglePage: 'single',
  OneColumn: 'continuous',
  TwoPageLeft: 'two',
  TwoPageRight: 'two',
  TwoColumnLeft: 'two-continuous',
  TwoColumnRight: 'two-continuous',
};
// The two-page views pair pages 1 and 2, 3 and 4: odd pages on the left. The Right
// layouts would put page 1 alone, as a cover, in other readers.
const LAYOUT_NAMES = {
  single: 'SinglePage',
  continuous: 'OneColumn',
  two: 'TwoPageLeft',
  'two-continuous': 'TwoColumnLeft',
};
const MODES = {
  UseNone: 'none',
  UseOutlines: 'bookmarks',
  UseThumbs: 'pages',
  UseAttachments: 'attachments',
  UseOC: 'layers',
  FullScreen: 'none',
};
const MODE_NAMES = {
  none: 'UseNone',
  bookmarks: 'UseOutlines',
  pages: 'UseThumbs',
  attachments: 'UseAttachments',
  layers: 'UseOC',
};
const nameOf = (value) => (value instanceof PDFName ? value.decodeText() : null);

/** The page index a destination array points at, or null. */
function destinationPage(doc, dest) {
  if (!(dest instanceof PDFArray) || !dest.size()) return null;
  const target = dest.get(0);
  if (target instanceof PDFNumber) return target.asNumber();
  if (!(target instanceof PDFRef)) return null;
  const index = doc.getPages().findIndex((page) => page.ref === target);
  return index === -1 ? null : index;
}

/** The zoom a destination array asks for: 'fit', 'page', a scale, or 'default'. */
function destinationZoom(dest) {
  const kind = nameOf(dest?.get?.(1));
  if (kind === 'Fit' || kind === 'FitB') return 'page';
  if (kind === 'FitH' || kind === 'FitBH') return 'fit';
  if (kind === 'XYZ') {
    const zoom = dest.lookup(4);
    const value = zoom instanceof PDFNumber ? zoom.asNumber() : 0;
    return value > 0 ? value : 'default';
  }
  return 'default';
}

export function readInitialView(doc) {
  const catalog = doc.catalog;
  const mode = nameOf(catalog.lookup(name('PageMode')));
  const prefs = catalog.lookupMaybe(name('ViewerPreferences'), PDFDict);
  const open = catalog.lookup(name('OpenAction'));
  const dest =
    open instanceof PDFArray
      ? open
      : open instanceof PDFDict && nameOf(open.lookup(name('S'))) === 'GoTo'
        ? open.lookup(name('D'))
        : null;
  return {
    layout: LAYOUTS[nameOf(catalog.lookup(name('PageLayout')))] || 'default',
    panel: MODES[mode] || 'none',
    fullScreen: mode === 'FullScreen',
    page: destinationPage(doc, dest instanceof PDFArray ? dest : null) ?? 0,
    zoom: dest instanceof PDFArray ? destinationZoom(dest) : 'default',
    displayTitle: prefs?.lookup(name('DisplayDocTitle')) === PDFBool.True,
  };
}

/** Store how the PDF opens. Unset fields keep what the file already says. */
export function writeInitialView(doc, view) {
  const catalog = doc.catalog;
  if (view.layout !== undefined) {
    if (view.layout === 'default') catalog.delete(name('PageLayout'));
    else if (LAYOUT_NAMES[view.layout])
      catalog.set(name('PageLayout'), name(LAYOUT_NAMES[view.layout]));
  }
  if (view.panel !== undefined || view.fullScreen !== undefined) {
    const mode = view.fullScreen ? 'FullScreen' : MODE_NAMES[view.panel] || 'UseNone';
    catalog.set(name('PageMode'), name(mode));
  }
  if (view.page !== undefined || view.zoom !== undefined) {
    const current = readInitialView(doc);
    const index = Math.max(0, Math.min(doc.getPageCount() - 1, view.page ?? current.page));
    const zoom = view.zoom ?? current.zoom;
    const page = doc.getPage(index).ref;
    const dest =
      zoom === 'page'
        ? [page, name('Fit')]
        : zoom === 'fit'
          ? [page, name('FitH'), null]
          : [page, name('XYZ'), null, null, typeof zoom === 'number' ? zoom : null];
    catalog.set(name('OpenAction'), doc.context.obj(dest));
  }
  if (view.displayTitle !== undefined) {
    let prefs = catalog.lookupMaybe(name('ViewerPreferences'), PDFDict);
    if (!prefs) {
      prefs = doc.context.obj({});
      catalog.set(name('ViewerPreferences'), prefs);
    }
    prefs.set(name('DisplayDocTitle'), view.displayTitle ? PDFBool.True : PDFBool.False);
  }
}

/** Every font the pages use, with its type, encoding, and whether it is embedded. */
export function listFonts(doc) {
  const fonts = new Map();
  const seenResources = new Set();
  const visit = (resources, depth = 0) => {
    if (!(resources instanceof PDFDict) || seenResources.has(resources) || depth > 8) return;
    seenResources.add(resources);
    const fontDict = resources.lookupMaybe(name('Font'), PDFDict);
    for (const [, value] of fontDict?.entries() || []) {
      const font = doc.context.lookup(value);
      if (!(font instanceof PDFDict)) continue;
      const base = nameOf(font.lookup(name('BaseFont'))) || 'Unnamed font';
      const subtype = nameOf(font.lookup(name('Subtype'))) || 'Unknown';
      const descendant =
        subtype === 'Type0'
          ? doc.context.lookup(font.lookupMaybe(name('DescendantFonts'), PDFArray)?.get(0))
          : null;
      const descriptor = (descendant instanceof PDFDict ? descendant : font).lookupMaybe(
        name('FontDescriptor'),
        PDFDict,
      );
      const embedded =
        subtype === 'Type3' ||
        ['FontFile', 'FontFile2', 'FontFile3'].some((key) => descriptor?.has(name(key)));
      const encoding = font.lookup(name('Encoding'));
      const key = `${base}|${subtype}|${embedded}`;
      if (!fonts.has(key))
        fonts.set(key, {
          name: base.replace(/^[A-Z]{6}\+/, ''),
          subset: /^[A-Z]{6}\+/.test(base),
          type: subtype,
          embedded,
          encoding: nameOf(encoding) || (encoding instanceof PDFDict ? 'Custom' : 'Built-in'),
        });
      visit(font.lookupMaybe(name('Resources'), PDFDict), depth + 1);
    }
    const xobjects = resources.lookupMaybe(name('XObject'), PDFDict);
    for (const [, value] of xobjects?.entries() || []) {
      const xobject = doc.context.lookup(value);
      const dict = xobject?.dict;
      if (nameOf(dict?.lookup(name('Subtype'))) === 'Form')
        visit(dict.lookupMaybe(name('Resources'), PDFDict), depth + 1);
    }
  };
  for (const page of doc.getPages()) visit(page.node.Resources());
  return [...fonts.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The PDF/A level the file claims in its XMP metadata ({ part, conformance }), or null. A light
 * read for opening a file; the PDF standards tool checks the claim properly.
 */
export function readPdfaClaim(doc) {
  const stream = doc.catalog.lookup(name('Metadata'));
  if (!(stream instanceof PDFRawStream)) return null;
  let xml;
  try {
    xml = new TextDecoder().decode(decodePDFRawStream(stream).decode());
  } catch {
    return null;
  }
  const value = (key) =>
    new RegExp(`pdfaid:${key}\\s*=\\s*["']([^"']+)["']|<pdfaid:${key}>\\s*([^<\\s]+)`, 'i').exec(
      xml,
    );
  const part = value('part'),
    conformance = value('conformance');
  const number = Number(part?.[1] ?? part?.[2]);
  return Number.isInteger(number) && number > 0
    ? {
        part: number,
        conformance: String(conformance?.[1] ?? conformance?.[2] ?? 'b').toLowerCase(),
      }
    : null;
}
