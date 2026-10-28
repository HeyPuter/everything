import { validateImage } from './images.js';
import { elementChildren } from './docx-xml.js';

const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const children = node => node?.children ? elementChildren(node) : [];

// Use only an unambiguous, unrotated inline frame. A floating placement or
// invalid dimensions cannot safely be approximated as an inline rectangle.
export function inlineDrawingPlaceholder(drawing, assets) {
  const nodes = children(drawing), inline = nodes[0];
  if (nodes.length !== 1 || inline.namespaceURI !== WP || inline.localName !== 'inline') return null;
  for (const transform of drawing.getElementsByTagNameNS(A, 'xfrm')) {
    const rotation = transform.getAttribute('rot');
    if (rotation !== null && (!/^[+-]?\d+$/.test(rotation) || Number(rotation) !== 0)) return null;
  }
  const extents = children(inline).filter(n => n.namespaceURI === WP && n.localName === 'extent');
  const effects = children(inline).filter(n => n.namespaceURI === WP && n.localName === 'effectExtent');
  if (extents.length !== 1 || effects.length > 1 || extents[0].children.length || effects[0]?.children.length) return null;
  const integer = (node, name) => /^\d+$/.test(node?.getAttribute(name) || '') ? Number(node.getAttribute(name)) : NaN;
  const properties = children(inline).find(n => n.namespaceURI === WP && n.localName === 'docPr');
  const id = integer(properties, 'id');
  const image = { width: integer(extents[0], 'cx'), height: integer(extents[0], 'cy'),
    alt: (properties?.getAttribute('descr') || 'Unsupported drawing').slice(0, 2000),
    name: properties?.getAttribute('name') || 'Unsupported drawing', id: Number.isSafeInteger(id) && id <= 4294967295 ? id : 0, previewPlaceholder: true,
    effectExtent: Object.fromEntries(['left', 'top', 'right', 'bottom'].map(side => [side, effects.length ? integer(effects[0], side[0]) : 0])) };
  try { validateImage(image); } catch { return null; }
  let assetId = 'preview:unsupported-drawing', index = 1;
  while (Object.hasOwn(assets, assetId)) assetId = `preview:unsupported-drawing:${index++}`;
  image.assetId = assetId;
  assets[assetId] = { previewPlaceholder: true };
  return image;
}
