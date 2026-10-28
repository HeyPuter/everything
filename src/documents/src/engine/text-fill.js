import { normalizeColor, luminanceTransform } from './colors.js';
import { UnsupportedDocumentError } from './errors.js';
import { W14 } from './text-outline.js';
import { childElements } from './docx-xml.js';

const fail = () => { throw new UnsupportedDocumentError('unsupported text fill properties'); };
export function checkedTextFill(value) {
  if (value === null || value === 'none' || value === 'empty') return value;
  if (typeof value === 'string' && /^[0-9a-f]{8}$/i.test(value)) return (value.slice(6).toUpperCase() === 'FF' ? value.slice(0, 6) : value).toUpperCase();
  try { const color = normalizeColor(value); if (color !== 'auto') return color; } catch { /* Report the extension, not ordinary foreground color. */ }
  return fail();
}

export function readTextFill(rPr, readColor) {
  const nodes = childElements(rPr, W14, 'textFill');
  if (!nodes.length) return {};
  if (nodes.length !== 1) fail();
  const attrs = (n, allowed = []) => {
    if ([...n.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (a.namespaceURI !== W14 || !allowed.includes(a.localName)))) fail();
    if ([...n.childNodes].some(c => [3, 4].includes(c.nodeType) && c.textContent.trim())) fail();
  };
  const node = nodes[0]; attrs(node);
  const fills = [...node.children];
  if (!fills.length) return { textFill: 'empty' };
  if (fills.length !== 1) fail();
  const fill = fills[0]; attrs(fill);
  if (fill.namespaceURI !== W14) fail();
  if (fill.localName === 'noFill') {
    if (fill.children.length) fail();
    return { textFill: 'none' };
  }
  if (fill.localName !== 'solidFill' || fill.children.length !== 1) fail();
  const color = fill.children[0]; attrs(color, ['val']);
  if (color.namespaceURI !== W14 || !['srgbClr', 'schemeClr'].includes(color.localName)) fail();
  const val = color.getAttributeNS(W14, 'val');
  let resolved = color.localName === 'srgbClr' ? val : readColor?.drawingScheme(val);
  if (!resolved || !/^[0-9a-f]{6}$/i.test(resolved)) fail();
  resolved = checkedTextFill(resolved);
  let alpha = 255;
  if (color.children.length) {
    let channels = resolved.match(/../g).map(v => parseInt(v, 16) / 255);
    for (const transform of color.children) {
      attrs(transform, ['val']);
      if (transform.namespaceURI !== W14 || !['lumMod', 'lumOff', 'alpha'].includes(transform.localName) || transform.children.length) fail();
      const raw = transform.getAttributeNS(W14, 'val')?.trim();
      if (!/^[+-]?\d+$/.test(raw || '') || Number(raw) < -2147483648 || Number(raw) > 2147483647) fail();
      if (transform.localName === 'alpha') {
        if (Number(raw) < 0 || Number(raw) > 100000) fail();
        // W14 text-fill alpha is read as transparency, contrary to the
        // opacity wording in MS-DOCX. Quantize transparency before inversion.
        alpha = 255 - Math.round(Number(raw) * 255 / 100000);
      } else channels = luminanceTransform(channels, Number(raw) / 100000, transform.localName === 'lumOff');
    }
    // Keep intermediate channels unquantized. Absorb floating-point noise at
    // exact half-byte boundaries so, for example, 8.5 rounds up rather than
    // becoming 8 after the HSL conversion produces 8.499999999999998.
    resolved = channels.map(c => Math.round((c + Number.EPSILON) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  return { textFill: checkedTextFill(resolved + (alpha === 255 ? '' : alpha.toString(16).padStart(2, '0'))) };
}

export function writeTextFill(properties, value) {
  const fill = checkedTextFill(value), doc = properties.ownerDocument;
  for (const n of [...properties.children]) if (n.namespaceURI === W14 && n.localName === 'textFill') n.remove();
  if (fill === null) return;
  const mc = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
  properties.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:w14', W14);
  properties.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:mc', mc);
  const ignored = new Set((properties.getAttributeNS(mc, 'Ignorable') || '').split(/\s+/).filter(Boolean));
  ignored.add('w14'); properties.setAttributeNS(mc, 'mc:Ignorable', [...ignored].join(' '));
  const make = name => doc.createElementNS(W14, 'w14:' + name), node = make('textFill');
  if (fill === 'none') node.append(make('noFill'));
  else if (fill !== 'empty') {
    const solid = make('solidFill'), color = make('srgbClr');
    color.setAttributeNS(W14, 'w14:val', fill.slice(0, 6));
    if (fill.length === 8) {
      const alpha = make('alpha');
      alpha.setAttributeNS(W14, 'w14:val', String(Math.round((255 - parseInt(fill.slice(6), 16)) * 100000 / 255)));
      color.append(alpha);
    }
    solid.append(color); node.append(solid);
  }
  properties.insertBefore(node, [...properties.children].find(n => n.namespaceURI === W14 && ['scene3d', 'props3d', 'ligatures', 'numForm', 'numSpacing', 'stylisticSets', 'cntxtAlts'].includes(n.localName)) || null);
}

export const textFillColor = style => !style.textFill || style.textFill === 'none' ? style.color : style.textFill === 'empty' ? '000000' : style.textFill;
export const visibleUnderline = style => style.textFill !== 'none' || !!style.underlineColor && style.underlineColor !== 'auto';

// The native reference carries the preceding solid text-effect color across ordinary
// foreground and no-fill runs. CT_FillTextEffect specifies black for an empty
// declaration instead. Resolve only layout copies; preserve the empty XML.
export function resolveEmptyTextFills(paragraphs) {
  if (!paragraphs.some(p => p.runs.some(r => r.textFill === 'empty'))) return paragraphs;
  let color = '000000';
  return paragraphs.map(p => {
    let changed = false;
    const runs = p.runs.map(r => {
      if (r.textFill === 'empty') { changed = true; return { ...r, textFill: color }; }
      if (r.textFill && r.textFill !== 'none') color = r.textFill;
      return r;
    });
    return changed ? { ...p, runs } : p;
  });
}
