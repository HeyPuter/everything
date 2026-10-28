// Word's watermarks (Design > Watermark) are legacy VML shapes in a header paragraph (ECMA-376 Part 4
// §14.1 VML; Part 1 §17.3.3.19 w:pict): a WordArt text path for a text watermark, or a picture
// (v:imagedata, washed out with gain and black level) for a picture watermark, positioned absolutely
// behind the text, usually centred on the margins. The editor keeps such a w:pict as one retained
// object (its XML saved unchanged) and draws what it describes behind the page's text.
const V = 'urn:schemas-microsoft-com:vml', O = 'urn:schemas-microsoft-com:office:office', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const elements = node => [...(node?.children || [])];
const PT = 12700; // EMU per point

/** CSS-like `name:value;` pairs of a VML style attribute. */
export function vmlStyle(text = '') {
  const out = {};
  for (const part of String(text).split(';')) {
    const at = part.indexOf(':'); if (at < 0) continue;
    const name = part.slice(0, at).trim().toLowerCase(), value = part.slice(at + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}
/** A VML length (pt, in, cm, mm, px, pc or a bare number of pixels) in EMU, or null. */
export function vmlLength(value) {
  const m = /^(-?\d*\.?\d+)\s*(pt|in|cm|mm|px|pc|emu)?$/i.exec(String(value || '').trim());
  if (!m) return null;
  const n = Number(m[1]), unit = (m[2] || 'px').toLowerCase();
  return Math.round(n * { pt: PT, in: 914400, cm: 360000, mm: 36000, px: 9525, pc: 12 * PT, emu: 1 }[unit]);
}
// VML colours: #RRGGBB, #RGB, or the named colours Word writes for watermarks.
const NAMED = { silver: 'C0C0C0', gray: '808080', grey: '808080', black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', navy: '000080', maroon: '800000', teal: '008080', olive: '808000', purple: '800080', aqua: '00FFFF', fuchsia: 'FF00FF', lime: '00FF00' };
export function vmlColor(value) {
  const text = String(value || '').trim().split(/\s/)[0].toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text.slice(1).toUpperCase();
  if (/^#[0-9a-f]{3}$/.test(text)) return [...text.slice(1)].map(c => c + c).join('').toUpperCase();
  return NAMED[text] || null;
}
/** A VML fraction ("0.5", ".5", "32768f" in 1/65536ths), or null. */
export function vmlFraction(value) {
  const text = String(value ?? '').trim();
  if (/^-?\d+f$/i.test(text)) return Number(text.slice(0, -1)) / 65536;
  return /^-?\d*\.?\d+$/.test(text) ? Number(text) : null;
}

/**
 * The watermark a w:pict holds, or null when it is not one: one v:shape (beside an optional
 * v:shapetype), absolutely positioned, that Word names as a watermark, with a text path or picture.
 * { kind: 'text' | 'picture', text, font, color, opacity, imageRel, gain, blackLevel, width, height,
 *   rotation (degrees), horizontal: { align, relativeFrom, offset }, vertical: { … }, behind }.
 */
export function readVmlWatermark(pict) {
  const kids = elements(pict);
  if (!kids.length || kids.some(n => n.namespaceURI !== V || !['shapetype', 'shape'].includes(n.localName))) return null;
  const shapes = kids.filter(n => n.localName === 'shape');
  if (shapes.length !== 1) return null;
  const shape = shapes[0], id = shape.getAttribute('id') || '', spid = shape.getAttributeNS(O, 'spid') || '';
  if (!/^(PowerPlusWaterMarkObject|PowerPlusPictureWaterMarkObject|WordPictureWatermark)/.test(id) && !/WaterMark/i.test(spid)) return null;
  const style = vmlStyle(shape.getAttribute('style'));
  if (style.position !== 'absolute') return null;
  const width = vmlLength(style.width), height = vmlLength(style.height);
  if (!(width > 0) || !(height > 0)) return null;
  const child = name => elements(shape).find(n => n.namespaceURI === V && n.localName === name) || null;
  const textpath = child('textpath'), imagedata = child('imagedata'), fill = child('fill');
  const axis = (key, relativeKey, offsetKey) => ({ align: style[key] || null, relativeFrom: style[relativeKey] || (key.endsWith('horizontal') ? 'column' : 'paragraph'), offset: vmlLength(style[offsetKey]) || 0 });
  const common = {
    width, height, rotation: Number.parseFloat(style.rotation) || 0, behind: Number.parseInt(style['z-index'], 10) < 0,
    horizontal: axis('mso-position-horizontal', 'mso-position-horizontal-relative', 'margin-left'),
    vertical: axis('mso-position-vertical', 'mso-position-vertical-relative', 'margin-top'),
  };
  if (textpath && !imagedata) {
    const text = textpath.getAttribute('string') || '';
    if (!text.trim()) return null;
    const font = vmlStyle(textpath.getAttribute('style'))['font-family']?.replace(/^["']|["']$/g, '').replace(/&quot;/g, '') || 'Calibri';
    const filled = shape.getAttribute('filled') !== 'f' && shape.getAttribute('filled') !== 'false';
    return { kind: 'text', text, font, color: filled ? vmlColor(shape.getAttribute('fillcolor')) || 'C0C0C0' : null, opacity: Math.max(0, Math.min(1, vmlFraction(fill?.getAttribute('opacity')) ?? 1)), ...common };
  }
  if (imagedata && !textpath) {
    const imageRel = imagedata.getAttributeNS(R, 'id') || imagedata.getAttributeNS(R, 'pict') || '';
    if (!imageRel) return null;
    return { kind: 'picture', imageRel, gain: vmlFraction(imagedata.getAttribute('gain')) ?? 1, blackLevel: vmlFraction(imagedata.getAttribute('blacklevel')) ?? 0, ...common };
  }
  return null;
}

/**
 * The package part a picture watermark's v:imagedata names, resolved through its story's
 * relationships, or null when it is missing, external or not an image relationship.
 */
export function watermarkImagePart(parts, sourcePart, relId, { parseXml, relationshipPartPath, partPathForUrl }) {
  try {
    const relsPath = relationshipPartPath(sourcePart);
    if (!parts[relsPath]) return null;
    const rels = parseXml(parts[relsPath]), matches = [...rels.getElementsByTagNameNS('*', 'Relationship')].filter(n => n.getAttribute('Id') === relId);
    if (matches.length !== 1 || !/\/image$/.test(matches[0].getAttribute('Type') || '') || (matches[0].getAttribute('TargetMode') || 'Internal') !== 'Internal') return null;
    const url = new URL(matches[0].getAttribute('Target'), `https://docx.invalid/${sourcePart}`);
    if (url.origin !== 'https://docx.invalid' || url.search || url.hash) return null;
    const path = partPathForUrl(parts, url);
    return parts[path] ? path : null;
  } catch { return null; }
}

/**
 * Where a watermark sits on a page (CSS pixels): its box, before its rotation about the box's centre.
 * Positions relative to the page, or else to the margins (Word's own watermarks are centred on them).
 */
export function watermarkFrame(watermark, page) {
  const px = emu => emu / 9525, width = px(watermark.width), height = px(watermark.height);
  const place = (axis, size) => {
    const { align, relativeFrom, offset } = watermark[axis], horizontal = axis === 'horizontal';
    const extent = horizontal ? page.width : page.height;
    const [start, end] = relativeFrom === 'page' ? [0, extent] : horizontal ? [page.left, page.width - page.right] : [page.top, page.height - page.bottom];
    if (align === 'center') return start + (end - start - size) / 2;
    if (align === (horizontal ? 'right' : 'bottom') || align === 'outside') return end - size;
    if (align === (horizontal ? 'left' : 'top') || align === 'inside') return start;
    return start + px(offset);
  };
  return { x: place('horizontal', width), y: place('vertical', height), width, height };
}
