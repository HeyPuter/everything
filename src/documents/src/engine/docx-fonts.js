import { parseXml } from './docx-xml.js';
import { relatedPartPath } from './docx-relationships.js';
import { FONT_SLOTS, checkedFontName } from './font-families.js';
import { UnsupportedDocumentError } from './errors.js';
import { documentEmbeddedFonts } from './embedded-fonts.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const children = n => [...(n?.children || [])];
const fail = why => { throw new UnsupportedDocumentError(`font declarations with ${why}`); };
function only(n, ns, name) {
  const nodes = children(n).filter(c => c.namespaceURI === ns && c.localName === name);
  if (nodes.length > 1) fail(`duplicate ${name}`);
  return nodes[0];
}
const themes = { ascii: 'asciiTheme', hAnsi: 'hAnsiTheme', eastAsia: 'eastAsiaTheme', cs: 'cstheme' };
export const FONT_LANGUAGE_ATTRIBUTES = { fontLanguage: 'val', fontEastAsiaLanguage: 'eastAsia', fontBidiLanguage: 'bidi' };
function languageScript(language) {
  if (!language) return null;
  try {
    const locale = new Intl.Locale(language).maximize();
    return locale.language === 'ja' ? 'Jpan' : locale.language === 'ko' ? 'Hang' : locale.script;
  } catch { fail('an invalid theme language'); }
}

export function fontReader(parts, settings) {
  let scheme, charsets, alternatives, themeMissing;
  // The theme part is optional. Without one, a declaration's explicit name (which producers
  // write beside the theme reference) is the font; the theme reference is kept in the XML.
  const noTheme = () => themeMissing ??= relatedPartPath(parts, 'theme') === null;
  const themeFont = token => {
    const match = /^(major|minor)(Ascii|HAnsi|EastAsia|Bidi)$/.exec(token);
    if (!match) fail('an unknown theme font');
    if (!scheme) {
      const path = relatedPartPath(parts, 'theme'); if (!path) fail('a missing theme relationship');
      const root = parseXml(parts[path]).documentElement;
      if (root.namespaceURI !== A || root.localName !== 'theme') fail('an invalid theme part');
      scheme = only(only(root, A, 'themeElements'), A, 'fontScheme');
      if (!scheme) fail('a missing theme font scheme');
    }
    const collection = only(scheme, A, match[1] + 'Font'); if (!collection) fail('a missing theme font collection');
    const kind = match[2] === 'EastAsia' ? 'ea' : match[2] === 'Bidi' ? 'cs' : 'latin';
    const attr = kind === 'ea' ? 'eastAsia' : kind === 'cs' ? 'bidi' : 'val';
    const language = only(settings, W, 'themeFontLang')?.getAttributeNS(W, attr);
    const script = languageScript(language);
    const matching = script ? children(collection).filter(n => n.namespaceURI === A && n.localName === 'font' && n.getAttribute('script') === script) : [];
    if (matching.length > 1) fail('duplicate supplemental theme fonts');
    const font = matching[0] || only(collection, A, kind);
    const name = font?.getAttribute('typeface');
    if (name === null || name === undefined) fail('a missing theme typeface');
    // Empty theme script slots explicitly defer to the application's fallback.
    return name ? checkedFontName(name) : 'Noto Sans';
  };
  const charset = name => {
    if (!charsets) {
      charsets = new Map(); alternatives = {};
      const familyFallbacks = new Map(), explicitAlternatives = new Map();
      const path = relatedPartPath(parts, 'fontTable');
      if (path) {
        const root = parseXml(parts[path]).documentElement;
        if (root.namespaceURI !== W || root.localName !== 'fonts') fail('an invalid font table');
        for (const node of children(root).filter(n => n.namespaceURI === W && n.localName === 'font')) {
          const value = only(node, W, 'charset')?.getAttributeNS(W, 'val');
          if (value != null && !/^[\da-f]{2}$/i.test(value)) fail('an invalid font character set');
          const name = node.getAttributeNS(W, 'name');
          charsets.set(name, value || '');
          const alternateNode = only(node, W, 'altName');
          const alternate = alternateNode?.getAttributeNS(W, 'val');
          if (alternateNode && alternate === null) fail('a missing alternative font name');
          if (alternate !== null && alternate !== undefined) {
            const key = checkedFontName(name).toLowerCase();
            if (explicitAlternatives.has(key)) fail('duplicate font alternatives');
            explicitAlternatives.set(key, checkedFontName(alternate));
          }
          // The Latin missing-face fallback follows the declared family,
          // independently of theme fonts and PANOSE. Retain source names.
          const familyNode = only(node, W, 'family');
          const family = familyNode ? familyNode.getAttributeNS(W, 'val') : 'auto';
          if ((!value || value === '00') && ['auto', 'roman', 'swiss', 'modern', 'script', 'decorative'].includes(family)) {
            const key = checkedFontName(name).toLowerCase();
            const fallback = family === 'roman' ? 'Cambria' : 'Calibri';
            familyFallbacks.set(key, familyFallbacks.has(key) && familyFallbacks.get(key) !== fallback ? null : fallback);
          }
        }
      }
      for (const [key, alternate] of explicitAlternatives) {
        const fallback = familyFallbacks.get(key);
        const value = fallback && alternate.trim().toLowerCase() !== fallback.toLowerCase() ? [alternate, fallback] : alternate;
        Object.defineProperty(alternatives, key, { value, enumerable: true });
      }
      for (const [key, fallback] of familyFallbacks) if (fallback && !Object.hasOwn(alternatives, key)) {
        Object.defineProperty(alternatives, key, { value: fallback, enumerable: true });
      }
      const embedded = documentEmbeddedFonts(parts);
      if (embedded.size) alternatives = Object.fromEntries([...new Set([...Object.keys(alternatives), ...embedded.keys()])].map(key => {
        const fallback = Object.hasOwn(alternatives, key) ? alternatives[key] : undefined, alias = embedded.get(key.trim());
        return [key, alias ? [alias, ...(Array.isArray(fallback) ? fallback : fallback ? [fallback] : [])] : fallback];
      }).filter(([, value]) => value !== undefined));
    }
    return charsets.get(name) || '';
  };
  const read = rPr => {
    const fonts = only(rPr, W, 'rFonts'), result = {};
    if (fonts) {
      if (children(fonts).length) fail('nested font markup');
      for (const a of fonts.attributes) if (a.namespaceURI === W && ![...Object.values(FONT_SLOTS), ...Object.values(themes), 'hint'].includes(a.localName)) fail('an unknown font attribute');
      for (const [key, attr] of Object.entries(FONT_SLOTS)) {
        const name = fonts.getAttributeNS(W, attr), theme = fonts.getAttributeNS(W, themes[attr]);
        // Theme wins within this declaration. The resolved scalar then replaces
        // either kind of declaration at earlier levels of the style hierarchy.
        if (theme !== null && !(name !== null && noTheme())) result[key] = themeFont(theme);
        else if (name !== null) result[key] = checkedFontName(name);
      }
      if (result.fontEastAsia) result.fontEastAsiaCharset = charset(result.fontEastAsia);
      const hint = fonts.getAttributeNS(W, 'hint');
      if (hint !== null) { if (!['default', 'eastAsia', 'cs'].includes(hint)) fail('an invalid font hint'); result.fontHint = hint; }
    }
    const lang = only(rPr, W, 'lang');
    for (const [key, attr] of Object.entries(FONT_LANGUAGE_ATTRIBUTES)) {
      const value = lang?.getAttributeNS(W, attr); if (value != null) result[key] = value;
    }
    return result;
  };
  read.fontCharsets = () => { charset(''); return Object.fromEntries(charsets); };
  read.fontAlternatives = () => { charset(''); return alternatives; };
  read.drawingFont = name => {
    if (name === 'none') return {};
    if (!['major', 'minor'].includes(name)) fail('an invalid shape font reference');
    return { fontAscii: themeFont(name + 'Ascii'), fontHAnsi: themeFont(name + 'HAnsi'), fontEastAsia: themeFont(name + 'EastAsia'), fontCs: themeFont(name + 'Bidi') };
  };
  return read;
}

export function writeFontProperties(patch, ensure) {
  for (const [key, attr] of Object.entries(FONT_SLOTS)) if (key in patch) {
    const n = ensure('rFonts'); n.removeAttributeNS(W, themes[attr]); n.setAttributeNS(W, `w:${attr}`, patch[key]);
  }
  if ('fontHint' in patch) ensure('rFonts').setAttributeNS(W, 'w:hint', patch.fontHint);
  for (const [key, attr] of Object.entries(FONT_LANGUAGE_ATTRIBUTES)) if (patch[key]) ensure('lang').setAttributeNS(W, `w:${attr}`, patch[key]);
}

export function removeFontProperty(properties, key) {
  if (key === 'fontEastAsiaCharset') return;
  const attr = FONT_SLOTS[key], language = FONT_LANGUAGE_ATTRIBUTES[key];
  const node = only(properties, W, attr || key === 'fontHint' ? 'rFonts' : 'lang');
  for (const name of attr ? [attr, themes[attr]] : [language || 'hint']) node?.removeAttributeNS(W, name);
  if (node && !node.attributes.length) node.remove();
}
