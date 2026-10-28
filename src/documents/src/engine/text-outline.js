import { normalizeColor, luminanceTransform } from './colors.js';
import { UnsupportedDocumentError } from './errors.js';
import { childElements } from './docx-xml.js';

export const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const fail = () => { throw new UnsupportedDocumentError('unsupported text outline properties'); };
export function checkedTextOutline(value) {
  if (value === null) return null;
  if (!value || Object.keys(value).some(k => !['width', 'color', 'join', 'cap', 'miter'].includes(k))) fail();
  const { width, color, join = 'bevel', cap = 'flat', miter = 8 } = value;
  if (!Number.isInteger(width) || width < 0 || width > 20116800 || !['bevel', 'round', 'miter'].includes(join) || !['flat', 'rnd', 'sq'].includes(cap) || !Number.isFinite(miter) || miter < 0) fail();
  let rgb;
  try { rgb = normalizeColor(color); } catch { fail(); }
  if (rgb === 'auto') fail();
  return { width, color: rgb, join, cap, miter };
}

export function readTextOutline(rPr, readColor) {
  const nodes = childElements(rPr, W14, 'textOutline');
  if (!nodes.length) return {};
  if (nodes.length !== 1) fail();
  const node = nodes[0], children = [...node.children];
  const attr = (n, key, fallback) => n.getAttributeNS(W14, key) ?? fallback;
  if ([...node.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (a.namespaceURI !== W14 || !['w', 'cap', 'cmpd', 'algn'].includes(a.localName)))) fail();
  if (attr(node, 'cmpd', 'sng') !== 'sng' || attr(node, 'algn', 'ctr') !== 'ctr') fail();
  const groups = [['noFill', 'solidFill'], ['prstDash'], ['round', 'bevel', 'miter']];
  if (children.some(n => n.namespaceURI !== W14 || !groups.flat().includes(n.localName)) || groups.some(g => children.filter(n => g.includes(n.localName)).length > 1)) fail();
  const fill = children.find(n => groups[0].includes(n.localName)), dash = children.find(n => n.localName === 'prstDash'), join = children.find(n => groups[2].includes(n.localName));
  if (dash && (attr(dash, 'val') !== 'solid' || dash.children.length)) fail();
  if (join?.children.length) fail();
  const rawWidth = attr(node, 'w', '0');
  if (!/^\+?\d+$/.test(rawWidth)) fail();
  const width = Number(rawWidth), cap = attr(node, 'cap', 'flat');
  checkedTextOutline({ width, cap, color: '000000' });
  for (const child of children) {
    const allowed = child.localName === 'prstDash' ? ['val'] : child.localName === 'miter' ? ['lim'] : [];
    if ([...child.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (a.namespaceURI !== W14 || !allowed.includes(a.localName)))) fail();
  }
  if (fill?.localName === 'noFill') { if (fill.children.length) fail(); return { textOutline: null }; }
  if (!fill) { if (width) fail(); return { textOutline: null }; }
  const colors = [...fill.children], colorNode = colors[0];
  if (colors.length !== 1 || colorNode.namespaceURI !== W14 || !['srgbClr', 'schemeClr'].includes(colorNode.localName)) fail();
  if ([...colorNode.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (a.namespaceURI !== W14 || a.localName !== 'val'))) fail();
  let color = colorNode.localName === 'srgbClr' ? attr(colorNode, 'val') : readColor.drawingScheme(attr(colorNode, 'val'));
  if (colorNode.children.length) {
    if (!/^[\da-f]{6}$/i.test(color || '')) fail();
    let channels = color.match(/../g).map(v => parseInt(v, 16) / 255);
    for (const transform of colorNode.children) {
      if (transform.namespaceURI !== W14 || !['lumMod', 'lumOff'].includes(transform.localName) || transform.children.length ||
          [...transform.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (a.namespaceURI !== W14 || a.localName !== 'val'))) fail();
      const raw = attr(transform, 'val')?.trim();
      if (!/^[+-]?\d+$/.test(raw || '') || Number(raw) < -2147483648 || Number(raw) > 2147483647) fail();
      channels = luminanceTransform(channels, Number(raw) / 100000, transform.localName === 'lumOff');
    }
    color = channels.map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  const rawMiter = join?.localName === 'miter' ? attr(join, 'lim', '0') : '800000';
  if (!/^\d+$/.test(rawMiter)) fail();
  return { textOutline: checkedTextOutline({ width, color, cap, join: join?.localName || 'bevel', miter: Number(rawMiter) / 100000 }) };
}

export function writeTextOutline(properties, value) {
  const outline = checkedTextOutline(value), doc = properties.ownerDocument;
  const mc = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
  properties.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:w14', W14);
  properties.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:mc', mc);
  const ignored = new Set((properties.getAttributeNS(mc, 'Ignorable') || '').split(/\s+/).filter(Boolean));
  ignored.add('w14'); properties.setAttributeNS(mc, 'mc:Ignorable', [...ignored].join(' '));
  for (const n of [...properties.children]) if (n.namespaceURI === W14 && n.localName === 'textOutline') n.remove();
  const make = name => doc.createElementNS(W14, 'w14:' + name);
  const node = make('textOutline');
  if (!outline) node.append(make('noFill'));
  else {
    for (const [key, val] of Object.entries({ w: outline.width, cap: outline.cap, cmpd: 'sng', algn: 'ctr' })) node.setAttributeNS(W14, 'w14:' + key, String(val));
    const fill = make('solidFill'), color = make('srgbClr'); color.setAttributeNS(W14, 'w14:val', outline.color); fill.append(color); node.append(fill);
    const join = make(outline.join); if (outline.join === 'miter') join.setAttributeNS(W14, 'w14:lim', String(Math.round(outline.miter * 100000))); node.append(join);
  }
  properties.insertBefore(node, [...properties.children].find(n => n.namespaceURI === W14 && ['textFill', 'scene3d', 'props3d', 'ligatures', 'numForm', 'numSpacing', 'stylisticSets', 'cntxtAlts'].includes(n.localName)) || null);
}
