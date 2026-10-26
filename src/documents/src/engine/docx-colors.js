import { parseXml } from './docx-xml.js';
import { UnsupportedDocumentError } from './errors.js';
import { normalizeColor, themeColorTransform } from './colors.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const children = n => [...(n?.children || [])];
const fail = reason => { throw new UnsupportedDocumentError(`text colors with ${reason}`); };
const names = { dark1: 'dk1', light1: 'lt1', dark2: 'dk2', light2: 'lt2', hyperlink: 'hlink', followedHyperlink: 'folHlink', ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`accent${i + 1}`, `accent${i + 1}`])) };
const aliases = { background1: ['bg1', 'light1'], background2: ['bg2', 'light2'], text1: ['t1', 'dark1'], text2: ['t2', 'dark2'] };
function only(parent, ns, name) {
  const nodes = children(parent).filter(n => n.namespaceURI === ns && n.localName === name);
  if (nodes.length > 1) fail(`duplicate ${name}`);
  return nodes[0];
}
function rgb(value) {
  try { return normalizeColor(value); } catch { fail('invalid RGB values'); }
}

// Resolve lazily: unused theme entries and unused style definitions can remain
// untouched even when they contain a color space this preview cannot display.
export function colorReader(parts, settings) {
  let theme, mapping, themeLinks;
  const themeRelationships = () => {
    if (!themeLinks) {
      const rels = parts['word/_rels/document.xml.rels'] && parseXml(parts['word/_rels/document.xml.rels']);
      themeLinks = children(rels?.documentElement).filter(n => n.namespaceURI === REL && n.getAttribute('Type') === R + 'theme');
    }
    return themeLinks;
  };
  const themeBase = name => {
    if (!theme) {
      const links = themeRelationships();
      if (links.length !== 1 || ![null, 'Internal'].includes(links[0].getAttribute('TargetMode'))) fail('a missing, external or duplicate theme relationship');
      const target = links[0].getAttribute('Target') || '';
      if (/[\\?#%:]/.test(target)) fail('an unsupported theme target');
      const segments = (target.startsWith('/') ? target.slice(1) : 'word/' + target).split('/'), normalized = [];
      for (const segment of segments) {
        if (segment === '..') { if (!normalized.length) fail('a theme target outside the package'); normalized.pop(); }
        else if (segment && segment !== '.') normalized.push(segment);
      }
      const path = normalized.join('/'); if (!parts[path]) fail('a missing theme part');
      const root = parseXml(parts[path]).documentElement;
      if (root.namespaceURI !== A || root.localName !== 'theme') fail('an invalid theme part');
      const scheme = only(only(root, A, 'themeElements'), A, 'clrScheme');
      if (!scheme) fail('a missing theme color scheme');
      const nextMapping = only(settings, W, 'clrSchemeMapping');
      theme = scheme; mapping = nextMapping;
    }
    const [attribute, fallback] = aliases[name] || [name, name];
    const mapped = mapping?.getAttributeNS(W, attribute) || fallback;
    if (!Object.hasOwn(names, mapped)) fail('an unsupported theme color mapping');
    const entry = only(theme, A, names[mapped]), nodes = children(entry);
    if (nodes.length !== 1 || nodes[0].namespaceURI !== A || !['srgbClr', 'sysClr'].includes(nodes[0].localName) || children(nodes[0]).length) fail('an unsupported theme color space or transform');
    const value = rgb(nodes[0].getAttribute(nodes[0].localName === 'sysClr' ? 'lastClr' : 'val'));
    if (value === 'auto') fail('an invalid theme RGB value');
    return value;
  };
  const readColor = (rPr, tag = 'color', channel) => {
    const node = only(rPr, W, tag); if (!node) return undefined;
    const border = channel === 'border';
    const attr = tag === 'shd' ? channel : tag === 'u' || tag === 'background' || border ? 'color' : 'val';
    const themeAttr = attr === 'fill' ? 'themeFill' : 'themeColor', tintAttr = attr === 'fill' ? 'themeFillTint' : 'themeTint', shadeAttr = attr === 'fill' ? 'themeFillShade' : 'themeShade';
    const allowed = border ? ['val', 'color', 'sz', 'space', 'frame', 'shadow', 'themeColor', 'themeTint', 'themeShade'] : tag === 'shd' ? ['val', 'color', 'fill', 'themeColor', 'themeTint', 'themeShade', 'themeFill', 'themeFillTint', 'themeFillShade'] : [attr, 'themeColor', 'themeTint', 'themeShade', ...(tag === 'u' ? ['val'] : [])];
    for (const a of [...node.attributes]) if (a.namespaceURI === W && !allowed.includes(a.localName)) fail(`an unsupported ${tag} attribute`);
    if (children(node).length) fail('nested color markup');
    const value = node.getAttributeNS(W, attr), name = node.getAttributeNS(W, themeAttr);
    if (tag === 'color' && value === null) fail('a missing required color value');
    if (value !== null) rgb(value);
    const modifiers = {};
    for (const key of [tintAttr, shadeAttr]) {
      const value = node.getAttributeNS(W, key);
      if (value !== null) { if (!/^[\da-fA-F]{2}$/.test(value)) fail(`invalid ${key}`); modifiers[key] = parseInt(value, 16) / 255; }
    }
    if (name !== null && name !== 'none') {
      if (!Object.hasOwn(names, name) && !Object.hasOwn(aliases, name)) fail('an unknown theme color');
      // A package without a theme part (it is optional) leaves the stored color, which producers
      // write as the resolved value, as the only one to show. The theme attributes are kept.
      if (value !== null && !themeRelationships().length) return rgb(value);
      return themeColorTransform(themeBase(name), modifiers[tintAttr], modifiers[shadeAttr]);
    }
    return value === null ? 'auto' : rgb(value);
  };
  readColor.drawingScheme = name => {
    const drawingNames = { dk1: 'dark1', lt1: 'light1', dk2: 'dark2', lt2: 'light2', bg1: 'background1', bg2: 'background2', tx1: 'text1', tx2: 'text2', hlink: 'hyperlink', folHlink: 'followedHyperlink' };
    const mapped = drawingNames[name] || (/^accent[1-6]$/.test(name) ? name : null);
    if (!mapped) fail('an unsupported DrawingML scheme color');
    return themeBase(mapped);
  };
  return readColor;
}
