import { elementChildren, parseXml } from './docx-xml.js';
import { relatedPartPath } from './docx-relationships.js';
import { UnsupportedDocumentError } from './errors.js';
import { drawingPresetColors } from './drawing-preset-colors.js';
import { drawingSystemColors } from './drawing-system-colors.js';
import { luminanceTransform } from './colors.js';

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const children = n => n?.children ? elementChildren(n) : [];
const fail = why => { throw new UnsupportedDocumentError(`drawing styles with ${why}`); };
const clamp = n => Math.max(0, Math.min(1, n));
// The input and final color resolve through linear RGB percentage units.
// Keep ordered transforms at full precision between these two boundaries.
function quantizedDrawingChannel(channel) {
  const c = clamp(channel);
  const linear = Math.round((c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4) * 100000) / 100000;
  return linear <= .0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - .055;
}
function only(n, name) {
  const found = children(n).filter(c => c.namespaceURI === A && c.localName === name);
  if (found.length > 1) fail(`duplicate ${name}`);
  return found[0];
}

// DrawingML shade/tint mix in linear RGB; luminance modifiers operate on HSL.
// Preserve floating-point channels between ordered transforms, rounding only
// the final paint color. These are not WordprocessingML themeTint/themeShade.
function colorValue(node, scheme, placeholder) {
  if (!node || node.namespaceURI !== A) fail('a missing color');
  const name = node.getAttribute('val');
  let rgb, channels, alpha = 1;
  if (node.localName === 'srgbClr' && /^[\da-f]{6}$/i.test(name || '')) rgb = name;
  else if (node.localName === 'prstClr' && Object.hasOwn(drawingPresetColors, name)) rgb = drawingPresetColors[name];
  else if (node.localName === 'sysClr') {
    const token = name?.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
    const last = node.getAttribute('lastClr')?.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
    if (!Object.hasOwn(drawingSystemColors, token) || last != null && !/^[\da-f]{6}$/i.test(last)) fail('an invalid system color');
    // lastClr is the producer's last computed value, not an override of val.
    rgb = drawingSystemColors[token];
  }
  else if (node.localName === 'schemeClr') {
    rgb = name === 'phClr' ? placeholder?.rgb : scheme?.(name);
    if (name === 'phClr') alpha = placeholder?.alpha ?? 1;
  } else if (node.localName === 'scrgbClr') {
    const linear = ['r', 'g', 'b'].map(key => {
      const raw = node.getAttribute(key)?.trim();
      if (!/^[+-]?\d+$/.test(raw || '') && !/^[+-]?\d+(?:\.\d+)?%$/.test(raw || '')) fail('an invalid scRGB channel');
      const value = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw) / 100000;
      if (!Number.isFinite(value) || Math.abs(value) > 2147483647 / 100000) fail('an invalid scRGB channel');
      return clamp(value);
    });
    channels = linear.map(c => c <= .0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - .055);
  }
  const attrs = node.localName === 'scrgbClr' ? ['r', 'g', 'b'] : node.localName === 'sysClr' ? ['val', 'lastClr'] : ['val'];
  if ([...node.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (a.namespaceURI || !attrs.includes(a.localName)))) fail('unsupported color attributes');
  if (!channels && !/^[\da-f]{6}$/i.test(rgb || '')) fail('an unresolved or unsupported color');
  channels ||= rgb.match(/../g).map(n => parseInt(n, 16) / 255);
  channels = channels.map(quantizedDrawingChannel);
  for (const modifier of children(node)) {
    const kind = modifier.localName, raw = modifier.getAttribute('val')?.trim();
    if (modifier.namespaceURI !== A || !['shade', 'tint', 'lumMod', 'lumOff', 'satMod', 'alpha', 'alphaMod', 'alphaOff', 'hueOff', 'satOff'].includes(kind) || children(modifier).length ||
        [...modifier.attributes].some(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && (a.namespaceURI || a.localName !== 'val'))) fail('an unsupported color transform');
    // Explicit identity offsets occur in saved DrawingML styles. Validate the
    // angle/percentage syntax before accepting zero; active offsets still need
    // independent native color controls and must not silently disappear.
    if (kind === 'hueOff' || kind === 'satOff') {
      const syntax = kind === 'hueOff' ? /^[+-]?\d+$/ : /^[+-]?\d+(?:\.\d+)?%$|^[+-]?\d+$/;
      if (!syntax.test(raw || '') || Number(raw.replace(/%$/, '')) !== 0) fail('unsupported hue or saturation offsets');
      continue;
    }
    if (!/^[+-]?\d+$/.test(raw || '') && !/^[+-]?\d+(?:\.\d+)?%$/.test(raw || '')) fail('an invalid color percentage');
    const amount = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw) / 100000;
    if (!Number.isFinite(amount) || Math.abs(amount) > 2147483647 / 100000 || !['lumOff', 'alphaOff', 'satMod'].includes(kind) && amount < 0 || ['tint','shade','alpha'].includes(kind) && amount > 1 || kind === 'alphaOff' && Math.abs(amount) > 1) fail('an invalid color percentage');
    if (kind.startsWith('alpha')) {
      alpha = clamp(kind === 'alpha' ? amount : kind === 'alphaMod' ? alpha * amount : alpha + amount);
    } else if (kind === 'tint' || kind === 'shade') {
      channels = channels.map(c => {
        const linear = c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
        const mixed = kind === 'shade' ? linear * amount : linear * amount + 1 - amount;
        return mixed <= .0031308 ? mixed * 12.92 : 1.055 * mixed ** (1 / 2.4) - .055;
      });
    } else if (kind === 'satMod') {
      // Preserve HSL lightness and scale chroma, then clamp RGB channels.
      // Negative modulation is also permitted (it reverses chroma).
      const light = (Math.max(...channels) + Math.min(...channels)) / 2;
      channels = channels.map(c => clamp(light + (c - light) * amount));
    } else {
      channels = luminanceTransform(channels, amount, kind === 'lumOff');
    }
  }
  return { rgb: channels.map(c => Math.round(quantizedDrawingChannel(c) * 255).toString(16).padStart(2, '0')).join('').toUpperCase(), alpha };
}

// Effects can interpret color alpha separately from RGB. In particular,
// duotone uses the two RGB endpoints while retaining the source pixel alpha.
export const drawingEffectColor = (node, scheme) => colorValue(node, scheme);

export function drawingColor(node, scheme, placeholder) {
  const value = colorValue(node, scheme, placeholder ? { rgb: placeholder, alpha: 1 } : undefined);
  if (value.alpha !== 1) fail('transparency in an opaque color context');
  return value.rgb;
}

export function drawingPaintColor(node, scheme, placeholder) {
  const { rgb, alpha } = colorValue(node, scheme, placeholder ? { rgb: placeholder, alpha: 1 } : undefined);
  return alpha === 1 ? `#${rgb}` : `rgba(${rgb.match(/../g).map(c => parseInt(c, 16)).join(',')},${alpha})`;
}

export function drawingStyleReader(parts, scheme) {
  let format;
  return (kind, reference) => {
    const raw = reference?.getAttribute('idx');
    if (!/^\d+$/.test(raw || '') || Number(raw) > 4294967295) fail('an invalid style index');
    const index = Number(raw);
    if (index === 0 || kind === 'fill' && index === 1000) return null;
    if (!format) {
      const path = relatedPartPath(parts, 'theme'); if (!path) fail('a missing theme');
      const root = parseXml(parts[path]).documentElement;
      if (root.namespaceURI !== A || root.localName !== 'theme') fail('an invalid theme');
      format = only(only(root, 'themeElements'), 'fmtScheme');
      if (!format) fail('a missing format scheme');
    }
    const list = only(format, kind === 'effect' ? 'effectStyleLst' : kind === 'line' ? 'lnStyleLst' : index > 1000 ? 'bgFillStyleLst' : 'fillStyleLst');
    const selected = children(list)[index - (kind === 'fill' && index > 1000 ? 1001 : 1)];
    if (!selected || selected.namespaceURI !== A) fail('a style index outside its matrix');
    if (children(reference).length !== 1) fail('a missing or conflicting reference color');
    const placeholder = colorValue(children(reference)[0], scheme), result = selected.cloneNode(true);
    // Replace only placeholder colors, retaining their own ordered modifiers.
    for (const color of [result, ...result.getElementsByTagNameNS(A, 'schemeClr')]) {
      if (color.localName !== 'schemeClr' || color.getAttribute('val') !== 'phClr') continue;
      const replacement = color.ownerDocument.createElementNS(A, 'a:srgbClr');
      const resolved = colorValue(color, scheme, placeholder);
      replacement.setAttribute('val', resolved.rgb);
      if (resolved.alpha !== 1) {
        const alpha = color.ownerDocument.createElementNS(A, 'a:alpha');
        alpha.setAttribute('val', String(Math.round(resolved.alpha * 100000)));
        replacement.append(alpha);
      }
      color.parentNode.replaceChild(replacement, color);
    }
    return result;
  };
}

export function mergeDrawingLine(inherited, direct) {
  if (!inherited) return direct;
  const result = inherited.cloneNode(true);
  if (!direct) return result;
  for (const attr of direct.attributes) result.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
  const groups = [['noFill','solidFill','gradFill','pattFill'],['prstDash','custDash'],['round','bevel','miter']];
  for (const node of children(direct)) {
    const names = groups.find(g => g.includes(node.localName)) || [node.localName];
    for (const prior of children(result)) if (prior.namespaceURI === node.namespaceURI && names.includes(prior.localName)) prior.remove();
    result.append(node.cloneNode(true));
  }
  return result;
}
