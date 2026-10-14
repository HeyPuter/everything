import { imageTransform } from '../core/charts.js';
import { pictureGeometry } from '../core/picture-geometry.js';
import { toneCurve } from '../core/picture-format.js';
import { el } from './dom.js';
import { drawingSvg } from '../core/drawingml-svg.js';

let filterIds = 0;
const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = (name, attrs) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

/** The SVG filter a picture's corrections and grayscale draw through (Picture Format ▸ Corrections, Color). */
function correctionFilter(obj) {
  if (!obj.adjust && obj.recolor !== 'grayscale') return null;
  const filter = svg('filter', { id: `picture-filter-${++filterIds}`, 'color-interpolation-filters': 'sRGB', x: 0, y: 0, width: 1, height: 1 });
  if (obj.recolor === 'grayscale') filter.append(svg('feColorMatrix', { type: 'saturate', values: 0 }));
  if (obj.adjust) {
    const { slope, intercept } = toneCurve(obj.adjust);
    const transfer = svg('feComponentTransfer', {});
    for (const channel of ['feFuncR', 'feFuncG', 'feFuncB']) transfer.append(svg(channel, { type: 'linear', slope, intercept }));
    filter.append(transfer);
  }
  return filter;
}

/** Use the same source/fill mapping on screen and in print, without flattening image bytes. */
export function pictureNode(obj) {
  const node = basePictureNode(obj);
  // Picture Format ▸ Transparency fades the picture alone, not the frame a style draws round it.
  if (obj.transparency) node.style.opacity = String(Math.max(0, 1 - obj.transparency));
  return node;
}

function basePictureNode(obj) {
  const filter = correctionFilter(obj);
  const drawing = obj.drawingShape && !obj.srcRect && !obj.fillRect && !filter && drawingSvg(obj.src);
  if (drawing) {
    drawing.setAttribute('role', obj.decorative ? 'presentation' : 'img');
    if (obj.decorative) drawing.setAttribute('aria-hidden', 'true');
    else drawing.setAttribute('aria-label', obj.description || obj.title || 'Image');
    drawing.style.transform = imageTransform(obj);
    return drawing;
  }
  const label = obj.description || obj.title || 'Image';
  if (!obj.srcRect && !obj.fillRect && !filter) return el('img', { src: obj.src, alt: obj.decorative ? '' : label, draggable: false, style: { transform: imageTransform(obj), borderRadius: 'inherit' } });
  const root = svg('svg', { viewBox: '0 0 1 1', preserveAspectRatio: 'none', ...(obj.decorative ? { role: 'presentation', 'aria-hidden': 'true' } : { role: 'img', 'aria-label': label }) });
  root.style.transform = imageTransform(obj);
  root.style.overflow = 'hidden';
  root.style.borderRadius = 'inherit';
  if (filter) { const defs = svg('defs', {}); defs.append(filter); root.append(defs); }
  const g = pictureGeometry(obj);
  if (g) {
    const { source: s, fill: f } = g;
    const crop = svg('svg', { x: f.x, y: f.y, width: f.w, height: f.h, viewBox: `${s.x} ${s.y} ${s.w} ${s.h}`, preserveAspectRatio: 'none', overflow: 'hidden' });
    // Override generic chart/print SVG sizing for this nested viewport.
    crop.style.width = `${f.w * 100}%`;
    crop.style.height = `${f.h * 100}%`;
    const image = svg('image', { href: obj.src, x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'none' });
    if (filter) image.setAttribute('filter', `url(#${filter.id})`);
    crop.append(image);
    root.append(crop);
  }
  return root;
}
