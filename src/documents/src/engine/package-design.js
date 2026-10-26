/**
 * Design-wide changes made on the saved package: the theme part (§20.1.6), the paragraph styles a
 * style set manages (§17.7), header watermarks and the page background fill (§17.2.1). Each function
 * takes a parts map (path → bytes) as the package writer produces it, edits only the parts and the
 * elements it owns, and leaves every other part byte-for-byte unchanged. The editor reopens the result,
 * so what is displayed is read back through the ordinary readers.
 */
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { relatedPartPath } from './docx-relationships.js';
import { parseXml } from './docx-xml.js';
import { relationshipPartPath, relativePartTarget, zipPackage } from './package-part-paths.js';
import { createPageStoryPart } from './docx-page-story-create.js';
import { themeColorTransform } from './colors.js';
import { COLOR_SLOTS, STYLE_SET_STYLES, resolvedTheme, STYLE_SETS } from './document-themes.js';

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  v: 'urn:schemas-microsoft-com:vml',
  o: 'urn:schemas-microsoft-com:office:office',
};
const W = NS.w, A = NS.a;
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const THEME_TYPE = 'application/vnd.openxmlformats-officedocument.theme+xml';
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/** The drawing name that marks a watermark this editor wrote, so it can be found and replaced. */
export const WATERMARK_NAME = 'Document Watermark';

const children = (node, ns, name) => [...(node?.children || [])].filter(n => (!ns || n.namespaceURI === ns) && (!name || n.localName === name));
const child = (node, ns, name) => children(node, ns, name)[0] || null;
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function readPart(parts, path) {
  // Decode as the package reader does: UTF-8 or a UTF-16 part with its BOM.
  try { return parseXml(parts[path]); }
  catch { throw new Error(`The package part ${path} is not well-formed XML.`); }
}
export function writePart(parts, path, doc) {
  parts[path] = strToU8(DECLARATION + new XMLSerializer().serializeToString(doc.documentElement));
}
const fragment = (xml, namespaces = '') => {
  const doc = new DOMParser().parseFromString(`<root xmlns:w="${W}" xmlns:a="${A}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:wps="${NS.wps}" xmlns:pic="${NS.pic}" xmlns:v="${NS.v}" xmlns:o="${NS.o}"${namespaces}>${xml}</root>`, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Invalid generated XML.');
  return [...doc.documentElement.children];
};

/* ---- Relationships and content types ---- */
function addRelationship(parts, source, type, target) {
  const path = relationshipPartPath(source);
  const doc = parts[path] ? readPart(parts, path) : new DOMParser().parseFromString(`<Relationships xmlns="${NS.rel}"/>`, 'application/xml');
  const ids = new Set(children(doc.documentElement).map(n => n.getAttribute('Id')));
  let i = 1; while (ids.has(`rIdDesign${i}`)) i++;
  const node = doc.createElementNS(NS.rel, 'Relationship');
  node.setAttribute('Id', `rIdDesign${i}`); node.setAttribute('Type', type); node.setAttribute('Target', target);
  doc.documentElement.append(node);
  writePart(parts, path, doc);
  return `rIdDesign${i}`;
}
function relationshipTarget(parts, source, id) {
  const path = relationshipPartPath(source);
  if (!parts[path]) return null;
  const node = children(readPart(parts, path).documentElement).find(n => n.getAttribute('Id') === id);
  if (!node || node.getAttribute('TargetMode') === 'External') return null;
  const target = node.getAttribute('Target');
  const base = source.split('/').slice(0, -1);
  const resolved = [];
  for (const segment of (target.startsWith('/') ? target.slice(1).split('/') : [...base, ...target.split('/')])) {
    if (segment === '..') resolved.pop(); else if (segment && segment !== '.') resolved.push(segment);
  }
  return resolved.join('/');
}
function ensureOverride(parts, path, type) {
  const doc = readPart(parts, '[Content_Types].xml'), root = doc.documentElement;
  const name = '/' + path;
  if (children(root, NS.ct, 'Override').some(n => n.getAttribute('PartName').toLowerCase() === name.toLowerCase())) return;
  const node = doc.createElementNS(NS.ct, 'Override');
  node.setAttribute('PartName', name); node.setAttribute('ContentType', type);
  root.append(node); writePart(parts, '[Content_Types].xml', doc);
}
function ensureDefault(parts, extension, type) {
  const doc = readPart(parts, '[Content_Types].xml'), root = doc.documentElement;
  if (children(root, NS.ct, 'Default').some(n => n.getAttribute('Extension').toLowerCase() === extension)) return;
  const node = doc.createElementNS(NS.ct, 'Default');
  node.setAttribute('Extension', extension); node.setAttribute('ContentType', type);
  root.insertBefore(node, root.firstElementChild); writePart(parts, '[Content_Types].xml', doc);
}
function uniquePath(parts, stem, extension) {
  let n = 1; while (Object.hasOwn(parts, `${stem}${n}.${extension}`)) n++;
  return `${stem}${n}.${extension}`;
}

/* ---- Theme part ---- */
export function themePartPath(parts) {
  try { return relatedPartPath(parts, 'theme'); } catch { return null; }
}

const fillXml = (kind) => kind === 'gradient'
  ? '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="60000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>'
  : `<a:solidFill><a:schemeClr val="phClr">${kind === 'tint' ? '<a:tint val="70000"/>' : kind === 'shade' ? '<a:shade val="85000"/>' : ''}</a:schemeClr></a:solidFill>`;
const effectXml = effect => effect
  ? `<a:effectStyle><a:effectLst><a:outerShdw blurRad="${effect.blur}" dist="${effect.distance}" dir="5400000" algn="t" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="${Math.round(effect.alpha * 100000)}"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>`
  : '<a:effectStyle><a:effectLst/></a:effectStyle>';
/** The format scheme (§20.1.4.1.14) for an effect scheme. */
export function formatSchemeXml(scheme) {
  return `<a:fmtScheme name="${escape(scheme.name)}"><a:fillStyleLst>${scheme.fills.map(fillXml).join('')}</a:fillStyleLst>`
    + `<a:lnStyleLst>${scheme.lines.map(width => `<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`).join('')}</a:lnStyleLst>`
    + `<a:effectStyleLst>${scheme.effects.map(effectXml).join('')}</a:effectStyleLst>`
    + `<a:bgFillStyleLst>${fillXml('solid')}${fillXml('tint')}${fillXml('gradient')}</a:bgFillStyleLst></a:fmtScheme>`;
}
export function colorSchemeXml(name, colors) {
  return `<a:clrScheme name="${escape(name)}">${COLOR_SLOTS.map(slot => `<a:${slot}><a:srgbClr val="${colors[slot]}"/></a:${slot}>`).join('')}</a:clrScheme>`;
}
const fontCollection = (tag, typeface) => `<a:${tag}><a:latin typeface="${escape(typeface)}"/><a:ea typeface=""/><a:cs typeface=""/></a:${tag}>`;
export function fontSchemeXml(scheme) {
  return `<a:fontScheme name="${escape(scheme.name)}">${fontCollection('majorFont', scheme.major)}${fontCollection('minorFont', scheme.minor)}</a:fontScheme>`;
}
/** A complete theme part for a resolved theme ({ name, colors, fonts, effects }). */
export function themeXml(theme) {
  return `${DECLARATION}<a:theme xmlns:a="${A}" name="${escape(theme.name)}"><a:themeElements>${colorSchemeXml(theme.colors.name || theme.name, theme.colors)}${fontSchemeXml(theme.fonts)}${formatSchemeXml(theme.effects)}</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

/** What the document's theme part declares: { name, colors, colorName, fonts: { name, major, minor }, effects }, or null. */
export function readThemeInfo(parts) {
  const path = themePartPath(parts);
  if (!path) return null;
  const root = readPart(parts, path).documentElement;
  if (root.namespaceURI !== A || root.localName !== 'theme') return null;
  const elements = child(root, A, 'themeElements'), scheme = child(elements, A, 'clrScheme');
  const colors = {};
  for (const slot of COLOR_SLOTS) {
    const value = child(child(scheme, A, slot));
    colors[slot] = value?.localName === 'sysClr' ? value.getAttribute('lastClr') : value?.getAttribute('val') || null;
  }
  const fonts = child(elements, A, 'fontScheme');
  const typeface = tag => child(child(fonts, A, tag), A, 'latin')?.getAttribute('typeface') || '';
  return { path, name: root.getAttribute('name') || '', colors, colorName: scheme?.getAttribute('name') || '',
    fonts: { name: fonts?.getAttribute('name') || '', major: typeface('majorFont'), minor: typeface('minorFont') },
    effects: child(elements, A, 'fmtScheme')?.getAttribute('name') || '' };
}

/** Validate theme part XML (a §20.1.6.9 a:theme with theme elements) from a .xml or .thmx file. */
export function checkedThemeXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (doc.getElementsByTagName('parsererror').length || root.namespaceURI !== A || root.localName !== 'theme') throw new Error('This file is not a document theme.');
  const elements = child(root, A, 'themeElements');
  if (!child(elements, A, 'clrScheme') || !child(elements, A, 'fontScheme') || !child(elements, A, 'fmtScheme')) throw new Error('This theme is missing its colors, fonts or effects.');
  return text.trimStart().startsWith('<?xml') ? text : DECLARATION + text;
}

function replaceThemeElement(root, name, xml) {
  const elements = child(root, A, 'themeElements');
  const [node] = fragment(xml);
  const imported = root.ownerDocument.importNode(node, true);
  const old = child(elements, A, name);
  if (old) old.replaceWith(imported); else elements.append(imported);
}

/**
 * Apply a whole theme or a part of one: { theme } (a resolved theme), or any of { colors: { name,
 * ...slots }, fonts: { name, major, minor }, effects: scheme, name }, or { xml } (a theme file). A
 * document without a theme part gets one, related from the main document. Returns { created }.
 */
export function applyThemeParts(parts, change) {
  let path = themePartPath(parts), created = false;
  if (change.xml) {
    const xml = checkedThemeXml(change.xml);
    if (!path) { path = createThemePart(parts); created = true; }
    parts[path] = strToU8(resolvableThemeXml(parts, path, xml));
    return { created, path };
  }
  if (!path) {
    path = createThemePart(parts); created = true;
    parts[path] = strToU8(themeXml(resolvedTheme('Paper')));
  }
  const doc = readPart(parts, path), root = doc.documentElement;
  if (root.namespaceURI !== A || root.localName !== 'theme' || !child(root, A, 'themeElements')) throw new Error('The document theme cannot be changed: its theme part is not recognized.');
  const theme = change.theme;
  const colors = theme?.colors || change.colors, fonts = theme?.fonts || change.fonts, effects = theme?.effects || change.effects;
  if (colors) replaceThemeElement(root, 'clrScheme', colorSchemeXml(colors.name || 'Custom', colors));
  if (fonts) {
    const scheme = child(child(root, A, 'themeElements'), A, 'fontScheme');
    // Keep supplemental script fonts: only the Latin typefaces and the scheme name change.
    if (scheme && child(scheme, A, 'majorFont') && child(scheme, A, 'minorFont')) {
      scheme.setAttribute('name', fonts.name || 'Custom');
      for (const [tag, face] of [['majorFont', fonts.major], ['minorFont', fonts.minor]]) {
        const collection = child(scheme, A, tag);
        let latin = child(collection, A, 'latin');
        if (!latin) { latin = doc.createElementNS(A, 'a:latin'); collection.prepend(latin); }
        latin.setAttribute('typeface', face);
        for (const attr of ['panose', 'pitchFamily', 'charset']) latin.removeAttribute(attr);
      }
    } else replaceThemeElement(root, 'fontScheme', fontSchemeXml(fonts));
  }
  if (effects) replaceThemeElement(root, 'fmtScheme', formatSchemeXml(effects));
  const name = change.name ?? theme?.name;
  if (name) root.setAttribute('name', name);
  writePart(parts, path, doc);
  return { created, path };
}
/**
 * Theme XML from another package (a .thmx file, a saved or default theme) can name pictures by
 * relationship IDs (r:embed) that only its own package resolved. Here a picture fill whose IDs do
 * not resolve from the theme part is replaced by a plain fill of the style color, and any other
 * unresolved reference is dropped, so the saved package never refers to a missing relationship.
 */
function resolvableThemeXml(parts, path, xml) {
  if (!xml.includes(NS.r)) return xml;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const relsPath = relationshipPartPath(path), known = new Set();
  if (parts[relsPath]) {
    try {
      for (const node of children(readPart(parts, relsPath).documentElement, NS.rel, 'Relationship')) {
        const id = node.getAttribute('Id'), target = node.getAttribute('TargetMode') === 'External' || relationshipTarget(parts, path, id);
        if (target === true || target && Object.hasOwn(parts, target)) known.add(id);
      }
    } catch { known.clear(); }
  }
  const unresolved = node => [...node.attributes].filter(a => a.namespaceURI === NS.r && !known.has(a.value));
  let changed = false;
  for (const node of [...doc.getElementsByTagNameNS('*', '*')]) {
    if (!node.isConnected || !unresolved(node).length) continue;
    changed = true;
    let fill = node;
    while (fill && !(fill.namespaceURI === A && fill.localName === 'blipFill')) fill = fill.parentElement;
    if (fill) {
      const [solid] = fragment('<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>');
      fill.replaceWith(doc.importNode(solid, true));
    } else for (const attribute of unresolved(node)) node.removeAttributeNode(attribute);
  }
  return changed ? DECLARATION + new XMLSerializer().serializeToString(doc.documentElement) : xml;
}
function createThemePart(parts) {
  const path = uniquePath(parts, 'word/theme/theme', 'xml');
  parts[path] = strToU8(themeXml(resolvedTheme('Paper')));
  addRelationship(parts, 'word/document.xml', OFFICE_REL + 'theme', path.slice('word/'.length));
  ensureOverride(parts, path, THEME_TYPE);
  return path;
}

/* ---- Styles ---- */
const STYLES_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';
function stylesPartPath(parts) {
  let path = null;
  try { path = relatedPartPath(parts, 'styles'); } catch { path = null; }
  if (path) return path;
  path = Object.hasOwn(parts, 'word/styles.xml') ? uniquePath(parts, 'word/styles', 'xml') : 'word/styles.xml';
  parts[path] = strToU8(`${DECLARATION}<w:styles xmlns:w="${W}"/>`);
  addRelationship(parts, 'word/document.xml', OFFICE_REL + 'styles', path.slice('word/'.length));
  ensureOverride(parts, path, STYLES_TYPE);
  return path;
}
const PPR_ORDER = ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'];
const RPR_ORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange'];
const STYLE_ORDER = ['name', 'aliases', 'basedOn', 'next', 'link', 'autoRedefine', 'hidden', 'uiPriority', 'semiHidden', 'unhideWhenUsed', 'qFormat', 'locked', 'personal', 'personalCompose', 'personalReply', 'rsid', 'pPr', 'rPr', 'tblPr', 'trPr', 'tcPr', 'tblStylePr'];
/** The paragraph and run properties a style set owns; everything else in a style is left alone. */
export const MANAGED_PPR = ['pBdr', 'spacing', 'ind', 'jc'];
export const MANAGED_RPR = ['rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'color', 'spacing', 'sz', 'szCs'];
function insertOrdered(parent, node, order) {
  parent.insertBefore(node, children(parent).find(n => order.indexOf(n.localName) > order.indexOf(node.localName)) || null);
}
function ensureChild(parent, name, order) {
  let node = child(parent, W, name);
  if (!node) { node = parent.ownerDocument.createElementNS(W, `w:${name}`); insertOrdered(parent, node, order); }
  return node;
}

/** Theme color values for resolved w:val attributes: themeColor name → hex. */
function themeColorValues(parts) {
  const info = readThemeInfo(parts), c = info?.colors || resolvedTheme('Paper').colors;
  return { text1: c.dk1, background1: c.lt1, text2: c.dk2, background2: c.lt2, dark1: c.dk1, light1: c.lt1, dark2: c.dk2, light2: c.lt2,
    ...Object.fromEntries([1, 2, 3, 4, 5, 6].map(i => [`accent${i}`, c[`accent${i}`]])), hyperlink: c.hlink, followedHyperlink: c.folHlink };
}
const resolvedColor = (color, values) => themeColorTransform(values[color.theme] || '000000', color.tint ? parseInt(color.tint, 16) / 255 : undefined, color.shade ? parseInt(color.shade, 16) / 255 : undefined);
const colorAttributes = (color, values) => `w:val="${resolvedColor(color, values)}" w:themeColor="${color.theme}"${color.tint ? ` w:themeTint="${color.tint}"` : ''}${color.shade ? ` w:themeShade="${color.shade}"` : ''}`;
/** One style's managed properties as { pPr: [xml], rPr: [xml] } from a style set declaration. */
export function styleSnippets(spec, values) {
  const pPr = [], rPr = [];
  if (spec.border) {
    const b = spec.border;
    pPr.push(`<w:pBdr><w:${b.side} w:val="single" w:sz="${b.size}" w:space="${b.space}" ${b.color ? `w:color="${resolvedColor(b.color, values)}" w:themeColor="${b.color.theme}"` : 'w:color="auto"'}/></w:pBdr>`);
  }
  const spacing = [['before', spec.before], ['after', spec.after]].filter(([, v]) => v !== undefined).map(([k, v]) => `w:${k}="${Math.round(v * 20)}"`);
  if (spec.line !== undefined) spacing.push(`w:line="${Math.round(spec.line * 240)}"`, 'w:lineRule="auto"');
  if (spacing.length) pPr.push(`<w:spacing ${spacing.join(' ')}/>`);
  if (spec.indent !== undefined) pPr.push(`<w:ind w:left="${Math.round(spec.indent * 1440)}" w:right="${Math.round(spec.indent * 1440)}"/>`);
  if (spec.align) pPr.push(`<w:jc w:val="${spec.align === 'justify' ? 'both' : spec.align}"/>`);
  if (spec.font) rPr.push(`<w:rFonts w:asciiTheme="${spec.font}HAnsi" w:hAnsiTheme="${spec.font}HAnsi"/>`);
  if (spec.bold) rPr.push('<w:b/>', '<w:bCs/>');
  if (spec.italic) rPr.push('<w:i/>', '<w:iCs/>');
  if (spec.caps) rPr.push('<w:caps/>');
  if (spec.color) rPr.push(`<w:color ${colorAttributes(spec.color, values)}/>`);
  if (spec.spacing) rPr.push(`<w:spacing w:val="${Math.round(spec.spacing * 20)}"/>`);
  if (spec.size) rPr.push(`<w:sz w:val="${Math.round(spec.size * 2)}"/>`, `<w:szCs w:val="${Math.round(spec.size * 2)}"/>`);
  return { pPr, rPr };
}
/** A style set's snippets for every style it manages. */
export function styleSetSnippets(set, parts) {
  if (set.snippets) return set.snippets;
  const values = themeColorValues(parts);
  return Object.fromEntries(Object.entries(set.styles).map(([id, spec]) => [id, styleSnippets(spec, values)]));
}

function styleNode(doc, id, create) {
  const root = doc.documentElement;
  let node = children(root, W, 'style').find(n => n.getAttributeNS(W, 'styleId') === id && (n.getAttributeNS(W, 'type') || 'paragraph') === 'paragraph');
  if (node || !create) return node || null;
  const info = STYLE_SET_STYLES[id] || { name: id, basedOn: 'Normal', next: 'Normal' };
  node = doc.createElementNS(W, 'w:style');
  node.setAttributeNS(W, 'w:type', 'paragraph'); node.setAttributeNS(W, 'w:styleId', id);
  if (id === 'Normal') node.setAttributeNS(W, 'w:default', '1');
  const add = (name, value) => { const n = doc.createElementNS(W, `w:${name}`); if (value !== undefined) n.setAttributeNS(W, 'w:val', value); insertOrdered(node, n, STYLE_ORDER); return n; };
  add('name', info.name);
  const hasNormal = children(root, W, 'style').some(n => n.getAttributeNS(W, 'styleId') === 'Normal');
  if (info.basedOn && hasNormal) add('basedOn', info.basedOn);
  if (info.next && hasNormal) add('next', info.next);
  add('qFormat');
  if (info.keep || info.outline !== undefined) {
    const pPr = add('pPr');
    if (info.keep) { ensureChild(pPr, 'keepNext', PPR_ORDER); ensureChild(pPr, 'keepLines', PPR_ORDER); }
    if (info.outline !== undefined) ensureChild(pPr, 'outlineLvl', PPR_ORDER).setAttributeNS(W, 'w:val', String(info.outline));
  }
  root.append(node);
  return node;
}
/** Replace the managed properties of each style with the set's, creating built-in styles a set needs. */
export function applyStyleSetParts(parts, set) {
  const snippets = styleSetSnippets(set, parts);
  const path = stylesPartPath(parts), doc = readPart(parts, path);
  for (const [id, { pPr, rPr }] of Object.entries(snippets)) {
    const node = styleNode(doc, id, true);
    for (const [tag, managed, xml, order] of [['pPr', MANAGED_PPR, pPr, PPR_ORDER], ['rPr', MANAGED_RPR, rPr, RPR_ORDER]]) {
      let properties = child(node, W, tag);
      for (const old of children(properties, W)) if (managed.includes(old.localName)) old.remove();
      if (!xml.length) { if (properties && !properties.children.length && !properties.attributes.length) properties.remove(); continue; }
      if (!properties) { properties = doc.createElementNS(W, `w:${tag}`); insertOrdered(node, properties, STYLE_ORDER); }
      for (const n of fragment(xml.join(''))) insertOrdered(properties, doc.importNode(n, true), order);
    }
  }
  writePart(parts, path, doc);
}
const normalizedSnippet = xml => xml.replace(/ w:val="[0-9A-F]{6}"(?= w:themeColor)/g, '').replace(/ w:color="[0-9A-Fa-f]{6}"(?= w:themeColor)/g, '');
/** The managed properties of the document's styles, as a style set's snippets (for Save as a New Style Set). */
export function captureStyleSet(parts) {
  const path = stylesPartPath(parts), doc = readPart(parts, path), serializer = new XMLSerializer();
  const result = {};
  for (const id of Object.keys(STYLE_SET_STYLES)) {
    const node = styleNode(doc, id, false);
    if (!node) continue;
    const pick = (tag, managed) => children(child(node, W, tag), W).filter(n => managed.includes(n.localName))
      .map(n => serializer.serializeToString(n).replace(/ xmlns:w="[^"]*"/g, ''));
    result[id] = { pPr: pick('pPr', MANAGED_PPR), rPr: pick('rPr', MANAGED_RPR) };
  }
  return result;
}
/** The name of the built-in style set the document's styles match, or null. */
export function currentStyleSetName(parts, sets = STYLE_SETS) {
  let captured;
  try { captured = captureStyleSet({ ...parts }); } catch { return null; }
  const comparable = snippets => JSON.stringify(Object.keys(STYLE_SET_STYLES).map(id => {
    const s = snippets[id] || { pPr: [], rPr: [] };
    return [s.pPr.map(normalizedSnippet).sort(), s.rPr.map(normalizedSnippet).sort()];
  }));
  const current = comparable(captured);
  return sets.find(set => comparable(styleSetSnippets(set, parts)) === current)?.name ?? null;
}

/**
 * The first time an app-authored document (body text in the app's default font and no theme part)
 * takes a theme, its styles are linked to the theme: the default font becomes the theme body font and
 * the built-in styles take the Default style set, so later theme, font and color changes show.
 */
export function linkStylesToTheme(parts) {
  const path = stylesPartPath(parts), doc = readPart(parts, path);
  const fonts = child(child(child(child(doc.documentElement, W, 'docDefaults'), W, 'rPrDefault'), W, 'rPr'), W, 'rFonts');
  const ascii = fonts?.getAttributeNS(W, 'ascii');
  if (fonts && ascii !== null && ascii !== 'Noto Sans') return false;
  if (fonts) {
    for (const attr of ['ascii', 'hAnsi']) fonts.removeAttributeNS(W, attr);
    fonts.setAttributeNS(W, 'w:asciiTheme', 'minorHAnsi'); fonts.setAttributeNS(W, 'w:hAnsiTheme', 'minorHAnsi');
    writePart(parts, path, doc);
  }
  applyStyleSetParts(parts, STYLE_SETS[0]);
  return true;
}
/** Whether the document's styles look like a new document's (the app default font, no theme part). */
export function appAuthoredStyles(parts) {
  if (themePartPath(parts)) return false;
  try {
    const doc = readPart(parts, stylesPartPath({ ...parts }));
    const fonts = child(child(child(child(doc.documentElement, W, 'docDefaults'), W, 'rPrDefault'), W, 'rPr'), W, 'rFonts');
    return !fonts || fonts.getAttributeNS(W, 'ascii') === 'Noto Sans';
  } catch { return false; }
}
/** Theme change entry point used by the Design tab: also links a new document's styles. */
export function applyDesignTheme(parts, change) {
  const link = appAuthoredStyles(parts);
  const result = applyThemeParts(parts, change);
  if (link) linkStylesToTheme(parts);
  return result;
}
/** Re-resolve the w:val of theme-colored style declarations after a color change (their themeColor wins on reading). */
export function refreshStyleThemeColors(parts) {
  let path;
  try { path = relatedPartPath(parts, 'styles'); } catch { return; }
  if (!path) return;
  const doc = readPart(parts, path), values = themeColorValues(parts);
  let changed = false;
  for (const node of [...doc.getElementsByTagNameNS(W, 'color')]) {
    const name = node.getAttributeNS(W, 'themeColor');
    if (!name || !values[name]) continue;
    const tint = node.getAttributeNS(W, 'themeTint'), shade = node.getAttributeNS(W, 'themeShade');
    const value = themeColorTransform(values[name], tint ? parseInt(tint, 16) / 255 : undefined, shade ? parseInt(shade, 16) / 255 : undefined);
    if (node.getAttributeNS(W, 'val') !== value) { node.setAttributeNS(W, 'w:val', value); changed = true; }
  }
  if (changed) writePart(parts, path, doc);
}

/* ---- Watermarks ---- */
const HEADER_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml';
const onValue = node => !!node && !['0', 'false', 'off'].includes(node.getAttributeNS(W, 'val') || 'true');
function documentSections(doc) {
  return [...doc.getElementsByTagNameNS(W, 'sectPr')].filter(n => n.parentNode.localName === 'body' || n.parentNode.localName === 'pPr');
}
function evenAndOdd(parts) {
  let path; try { path = relatedPartPath(parts, 'settings'); } catch { path = null; }
  return !!path && onValue(child(readPart(parts, path).documentElement, W, 'evenAndOddHeaders'));
}
/**
 * The header parts every page shows: each section's referenced headers for the page kinds in use
 * (default, first when titlePg, even with evenAndOddHeaders). A kind the first section lacks gets a new
 * empty header so the watermark reaches its pages; later sections inherit missing kinds.
 */
function watermarkHeaders(parts, create) {
  const doc = readPart(parts, 'word/document.xml');
  let sections = documentSections(doc);
  if (!sections.length) {
    if (!create) return [];
    const body = child(doc.documentElement, W, 'body');
    body.append(doc.createElementNS(W, 'w:sectPr'));
    sections = documentSections(doc);
  }
  const even = evenAndOdd(parts), paths = new Set(), available = new Set();
  let changed = false;
  for (const section of sections) {
    const kinds = ['default', ...(onValue(child(section, W, 'titlePg')) ? ['first'] : []), ...(even ? ['even'] : [])];
    for (const kind of kinds) {
      const ref = children(section, W, 'headerReference').find(n => (n.getAttributeNS(W, 'type') || 'default') === kind);
      if (ref) {
        const path = relationshipTarget(parts, 'word/document.xml', ref.getAttributeNS(NS.r, 'id'));
        if (path && parts[path]) { paths.add(path); available.add(kind); }
        continue;
      }
      if (available.has(kind) || !create) continue;
      const { path, id } = createPageStoryPart(parts, 'header');
      const node = doc.createElementNS(W, 'w:headerReference');
      node.setAttributeNS(W, 'w:type', kind); node.setAttributeNS(NS.r, 'r:id', id);
      section.insertBefore(node, section.firstElementChild);
      if (!doc.documentElement.lookupNamespaceURI('r')) doc.documentElement.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:r', NS.r);
      paths.add(path); available.add(kind); changed = true;
    }
  }
  if (changed) writePart(parts, 'word/document.xml', doc);
  return [...paths];
}
const isWatermark = drawing => [...drawing.getElementsByTagNameNS(NS.wp, 'docPr')].some(n => n.getAttribute('name') === WATERMARK_NAME);
function removeWatermarkRuns(doc) {
  let removed = false;
  for (const drawing of [...doc.getElementsByTagNameNS(W, 'drawing')]) {
    if (!isWatermark(drawing)) continue;
    const run = drawing.parentNode;
    if (run?.namespaceURI === W && run.localName === 'r') run.remove(); else drawing.remove();
    removed = true;
  }
  return removed;
}
/**
 * The document's watermark as this editor wrote it: { kind: 'text', text, font, size, color, layout, ... } |
 * { kind: 'picture', ..., bytes?, mime? } | null. A picture watermark carries its image when the header
 * still holds it, so it can be kept when only its scale or washout changes.
 */
export function readWatermark(parts) {
  for (const path of watermarkHeaders({ ...parts }, false)) {
    const doc = readPart(parts, path);
    const drawing = [...doc.getElementsByTagNameNS(W, 'drawing')].find(isWatermark);
    if (!drawing) continue;
    const docPr = drawing.getElementsByTagNameNS(NS.wp, 'docPr')[0];
    let watermark;
    try { watermark = JSON.parse(docPr.getAttribute('descr') || 'null') || { kind: 'text' }; } catch { return { kind: 'text' }; }
    if (watermark.kind === 'picture') {
      const embed = drawing.getElementsByTagNameNS(A, 'blip')[0]?.getAttributeNS(NS.r, 'embed');
      const media = embed ? relationshipTarget(parts, path, embed) : null;
      if (media && parts[media] instanceof Uint8Array) Object.assign(watermark, { bytes: parts[media], mime: /\.png$/i.test(media) ? 'image/png' : 'image/jpeg' });
    }
    return watermark;
  }
  return null;
}
const EMU = 914400;
/** The writing area of the first section in EMU: { width, height }. */
function textArea(parts) {
  const doc = readPart(parts, 'word/document.xml'), sections = documentSections(doc), section = sections.at(-1);
  const size = child(section, W, 'pgSz'), margins = child(section, W, 'pgMar');
  const n = (node, name, fallback) => { const v = Number(node?.getAttributeNS(W, name)); return Number.isFinite(v) && node?.hasAttributeNS(W, name) ? v : fallback; };
  const width = n(size, 'w', 12240) - n(margins, 'left', 1440) - n(margins, 'right', 1440);
  const height = n(size, 'h', 15840) - Math.abs(n(margins, 'top', 1440)) - Math.abs(n(margins, 'bottom', 1440));
  return { width: Math.max(1440, width) * 635, height: Math.max(1440, height) * 635 };
}
/** A text watermark's size in points when "Auto": the text spans most of its line (diagonal or across). */
export function automaticWatermarkSize(text, layout, area) {
  const length = layout === 'horizontal' ? area.width * 0.9 : Math.hypot(area.width, area.height) * 0.55;
  const points = length / 12700 / Math.max(1, [...text].length * 0.68);
  return Math.max(8, Math.min(240, Math.round(points)));
}
const blend = (hex, amount) => hex.match(/../g).map(c => Math.round(parseInt(c, 16) + (255 - parseInt(c, 16)) * amount).toString(16).padStart(2, '0')).join('').toUpperCase();
function watermarkDrawingXml(watermark, area, id, embed) {
  const anchor = (cx, cy, graphic) => `<w:r><w:rPr><w:noProof/></w:rPr><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="251658240" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">`
    + '<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="margin"><wp:align>center</wp:align></wp:positionH><wp:positionV relativeFrom="margin"><wp:align>center</wp:align></wp:positionV>'
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${id}" name="${WATERMARK_NAME}" descr="${escape(JSON.stringify(watermark))}"/><wp:cNvGraphicFramePr/>${graphic}</wp:anchor></w:drawing></w:r>`;
  if (watermark.kind === 'picture') {
    const { width, height } = watermark;
    const scale = watermark.scale === 'auto' || !watermark.scale ? Math.min(area.width * 0.8 / width, area.height * 0.8 / height) : watermark.scale * 9525;
    const cx = Math.max(9525, Math.round(width * scale)), cy = Math.max(9525, Math.round(height * scale));
    const washout = watermark.washout ? '<a:lum bright="70000" contrast="-70000"/>' : '';
    return anchor(cx, cy, `<a:graphic><a:graphicData uri="${NS.pic}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${WATERMARK_NAME}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${embed}">${washout}</a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`);
  }
  const text = watermark.text || 'DRAFT', points = watermark.size === 'auto' || !watermark.size ? automaticWatermarkSize(text, watermark.layout, area) : watermark.size;
  const color = watermark.semitransparent ? blend(watermark.color || 'C0C0C0', 0.5) : (watermark.color || 'C0C0C0');
  const cx = Math.round([...text].length * points * 0.8 * 12700 + 12700 * 8), cy = Math.round(points * 1.4 * 12700);
  const font = watermark.font ? `<w:rFonts w:ascii="${escape(watermark.font)}" w:hAnsi="${escape(watermark.font)}"/>` : '';
  const language = watermark.language ? `<w:lang w:val="${escape(watermark.language)}"/>` : '';
  const rotation = watermark.layout === 'horizontal' ? '' : ' rot="18900000"';
  return anchor(cx, cy, `<a:graphic><a:graphicData uri="${NS.wps}"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm${rotation}><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr>`
    + `<wps:txbx><w:txbxContent><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr>${font}<w:color w:val="${color}"/><w:sz w:val="${Math.round(points * 2)}"/><w:szCs w:val="${Math.round(points * 2)}"/>${language}</w:rPr><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p></w:txbxContent></wps:txbx>`
    + '<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr" anchorCtr="0"><a:noAutofit/></wps:bodyPr></wps:wsp></a:graphicData></a:graphic>');
}
/**
 * Put a watermark behind the text of every page, or remove it (watermark null). A text watermark is
 * { kind: 'text', text, font?, size ('auto' | points), color (hex), semitransparent, layout
 * ('diagonal' | 'horizontal'), language? }; a picture one is { kind: 'picture', bytes, mime, width,
 * height (pixels), scale ('auto' | factor), washout }.
 */
export function setWatermarkParts(parts, watermark) {
  const headers = watermarkHeaders(parts, !!watermark);
  const area = watermark ? textArea(parts) : null;
  let media = null;
  for (const path of headers) {
    const doc = readPart(parts, path);
    const removed = removeWatermarkRuns(doc);
    if (!watermark) { if (removed) writePart(parts, path, doc); continue; }
    let embed = null;
    if (watermark.kind === 'picture') {
      const extension = watermark.mime === 'image/png' ? 'png' : 'jpeg';
      if (!media) {
        media = uniquePath(parts, 'word/media/watermark', extension);
        parts[media] = watermark.bytes;
        ensureDefault(parts, extension, watermark.mime);
      }
      embed = addRelationship(parts, path, OFFICE_REL + 'image', relativePartTarget(path, media));
    }
    const used = new Set([...doc.getElementsByTagNameNS(NS.wp, 'docPr')].map(n => Number(n.getAttribute('id'))));
    let id = 4096; while (used.has(id)) id++;
    const stored = watermark.kind === 'picture' ? { kind: 'picture', width: watermark.width, height: watermark.height, scale: watermark.scale, washout: !!watermark.washout } : watermark;
    const [run] = fragment(watermarkDrawingXml(stored, area, id, embed));
    const root = doc.documentElement;
    let paragraph = child(root, W, 'p');
    if (!paragraph) { paragraph = doc.createElementNS(W, 'w:p'); root.append(paragraph); }
    // The anchor goes first in the header's first paragraph: it takes no space in the text.
    const properties = child(paragraph, W, 'pPr');
    paragraph.insertBefore(doc.importNode(run, true), properties ? properties.nextSibling : paragraph.firstChild);
    for (const prefix of ['wp', 'a', 'wps', 'pic', 'r']) if (!root.lookupNamespaceURI(prefix)) root.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${prefix}`, NS[prefix]);
    writePart(parts, path, doc);
    ensureOverride(parts, path, HEADER_TYPE);
  }
}

/* ---- Page background fill effects ---- */
/**
 * Set a picture page background (§17.2.1 w:background with a VML background fill), shown when the
 * displayBackgroundShape setting (§17.15.1.29) is on: { bytes, mime, title, color? } tiles the picture
 * over every page. Gradients and patterns are stored as the picture they render to. null removes the
 * fill and keeps the page color.
 */
export function setPageFillParts(parts, fill) {
  const doc = readPart(parts, 'word/document.xml'), root = doc.documentElement;
  let background = child(root, W, 'background');
  if (!fill) {
    if (background) { for (const n of children(background)) n.remove(); writePart(parts, 'word/document.xml', doc); }
    return;
  }
  const extension = fill.mime === 'image/png' ? 'png' : 'jpeg';
  const media = uniquePath(parts, 'word/media/background', extension);
  parts[media] = fill.bytes;
  ensureDefault(parts, extension, fill.mime);
  const id = addRelationship(parts, 'word/document.xml', OFFICE_REL + 'image', relativePartTarget('word/document.xml', media));
  if (!background) { background = doc.createElementNS(W, 'w:background'); root.insertBefore(background, root.firstElementChild); }
  for (const n of children(background)) n.remove();
  background.setAttributeNS(W, 'w:color', fill.color || 'FFFFFF');
  for (const attr of ['themeColor', 'themeTint', 'themeShade']) background.removeAttributeNS(W, attr);
  for (const [prefix, uri] of [['v', NS.v], ['o', NS.o], ['r', NS.r]]) if (!root.lookupNamespaceURI(prefix)) root.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${prefix}`, uri);
  const [shape] = fragment(`<v:background id="_x0000_s1025" o:bwmode="white"><v:fill r:id="${id}" o:title="${escape(fill.title || 'Background')}" type="tile"/></v:background>`);
  background.append(doc.importNode(shape, true));
  writePart(parts, 'word/document.xml', doc);
  setDisplayBackgroundShape(parts, true);
}
const SETTINGS_ORDER = ['writeProtection', 'view', 'zoom', 'removePersonalInformation', 'removeDateAndTime', 'doNotDisplayPageBoundaries', 'displayBackgroundShape'];
const SETTINGS_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml';
function setDisplayBackgroundShape(parts, on) {
  let path; try { path = relatedPartPath(parts, 'settings'); } catch { path = null; }
  if (!path) {
    path = Object.hasOwn(parts, 'word/settings.xml') ? uniquePath(parts, 'word/settings', 'xml') : 'word/settings.xml';
    parts[path] = strToU8(`${DECLARATION}<w:settings xmlns:w="${W}"/>`);
    addRelationship(parts, 'word/document.xml', OFFICE_REL + 'settings', path.slice('word/'.length));
    ensureOverride(parts, path, SETTINGS_TYPE);
  }
  const doc = readPart(parts, path), root = doc.documentElement;
  let node = child(root, W, 'displayBackgroundShape');
  if (on && node && onValue(node)) return;
  if (!on) { if (node) { node.remove(); writePart(parts, path, doc); } return; }
  if (!node) {
    node = doc.createElementNS(W, 'w:displayBackgroundShape');
    root.insertBefore(node, children(root).find(n => !SETTINGS_ORDER.includes(n.localName) || SETTINGS_ORDER.indexOf(n.localName) > SETTINGS_ORDER.indexOf('displayBackgroundShape')) || null);
  }
  node.removeAttributeNS(W, 'val');
  writePart(parts, path, doc);
}
/** Whether the document has a picture page background (for the Fill Effects check mark). */
export function hasPageFill(parts) {
  const background = child(readPart(parts, 'word/document.xml').documentElement, W, 'background');
  return !!child(background, NS.v, 'background');
}

/* ---- Packages as blobs ---- */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export async function blobParts(blob) { return unzipSync(new Uint8Array(await blob.arrayBuffer())); }
export function partsBlob(parts) { return new Blob([zipPackage(parts)], { type: DOCX_MIME }); }
/** A theme part's XML text, or null. */
export function themePartXml(parts) {
  const path = themePartPath(parts), bytes = path && parts[path];
  if (!bytes) return null;
  // A UTF-16 part (with its BOM) decodes as such; its text is written back as UTF-8.
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  return encoding ? new TextDecoder(encoding).decode(bytes).replace(/^(<\?xml\s[^?]*?\bencoding\s*=\s*)(["'])[^"']*\2/, '$1"UTF-8"') : strFromU8(bytes);
}
/** The theme part inside a .thmx theme package (a ZIP), or the text of a .xml theme file. */
export function themeFileXml(bytes) {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = unzipSync(bytes);
    const name = Object.keys(files).filter(n => /(^|\/)theme\/theme\d*\.xml$/i.test(n)).sort()[0];
    if (!name) throw new Error('This theme package does not contain a theme.');
    return checkedThemeXml(strFromU8(files[name]));
  }
  return checkedThemeXml(strFromU8(bytes));
}
