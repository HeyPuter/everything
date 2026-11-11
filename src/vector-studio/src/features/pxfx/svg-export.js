/**
 * SVG export of the pixel effects (an svgExportHooks.element hook):
 *
 *   - objects with Effect Gallery filters are written as an image of the
 *     effected object, cropped to its visual bounds (and the export area),
 *     at the document's raster effects resolution;
 *   - SVG filters are written as real <filter> definitions, applied by
 *     groups around the object in stacking order (the object's opacity
 *     and blending move to the outermost group, as on the canvas).
 *
 * An SVG filter followed by a raster effect SVG cannot place after it
 * makes the object an image too, so the order of effects is kept.
 */
import { svgExportHooks } from '../io/hooks.js';
import { drawNode } from '../../render/draw.js';
import { RASTER_EFFECTS } from '../../render/effects.js';
import { visualBounds } from '../../model/geometry.js';
import { FILTER } from './catalog.js';
import { docScale } from './core.js';
import { recordFilter } from './svg-filters.js';

const MAX_SIDE = 4096;

const live = (node) => (node.effects || []).filter((e) => e && !e.hidden);
const galleryOn = (e) => e.type === 'gallery' && (e.stack || []).some((l) => !l.hidden && FILTER.has(l.filter));
const filterOn = (e) => e.type === 'svgFilter' && Boolean(recordFilter(e));

/** 'raster', 'filter' or null: how an object's pixel effects export to SVG. */
export function svgMode(node) {
  const fx = live(node);
  if (fx.some(galleryOn)) return 'raster';
  const first = fx.findIndex(filterOn);
  if (first < 0) return null;
  // Raster effects after an SVG filter would have to apply to its result.
  if (fx.slice(first + 1).some((e) => RASTER_EFFECTS.has(e.type) && !filterOn(e))) return 'raster';
  return 'filter';
}

/**
 * Renders a node for embedding: (doc, node, rect, k) -> PNG data URL or
 * null. Replaceable (tests run without a canvas implementation).
 */
export const svgRaster = {
  render(doc, node, rect, k) {
    if (typeof document === 'undefined') return null;
    const W = Math.max(1, Math.ceil(rect.w * k));
    const H = Math.max(1, Math.ceil(rect.h * k));
    const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(k, 0, 0, k, -rect.x * k, -rect.y * k);
    drawNode(ctx, doc, node, { viewRect: rect, outline: false, hairline: 1 / k, scale: k });
    let url = null;
    try {
      url = canvas.toDataURL('image/png');
    } catch {
      url = null;
    }
    return typeof url === 'string' && url.startsWith('data:image/png') ? url : null;
  },
};

function rasterMarkup(node, w, depth) {
  const doc = w.doc;
  const vb = visualBounds(doc, node);
  if (!vb || !(vb.w > 0) || !(vb.h > 0)) return '';
  let r = vb;
  if (w.cullRect) {
    const c = w.cullRect;
    const x0 = Math.max(r.x, c.x);
    const y0 = Math.max(r.y, c.y);
    const x1 = Math.min(r.x + r.w, c.x + c.w);
    const y1 = Math.min(r.y + r.h, c.y + c.h);
    if (!(x1 > x0 && y1 > y0)) return '';
    r = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const k = Math.min(Math.max(1, docScale(doc)), MAX_SIDE / r.w, MAX_SIDE / r.h);
  const plain = { ...node, opacity: 1, blendMode: 'normal' };
  const url = svgRaster.render(doc, plain, r, k);
  if (!url) return undefined;
  w.needsXlink = true;
  const p = w.map(r.x, r.y);
  return `${w.nl(depth)}<image${w.nameId(node.name)} x="${w.n(p.x)}" y="${w.n(p.y)}" width="${w.n(r.w)}" height="${w.n(r.h)}" preserveAspectRatio="none" xlink:href="${url}"${w.commonAttrs({ ...node, effects: [], isolate: false })}/>`;
}

/** Elements a filter definition may hold: the filter primitives and their parts. */
const FILTER_PARTS = new Set(
  'feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feImage feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence'.split(' '),
);

/**
 * A filter's markup as a definition with the given id, in the export's
 * coordinates. Filters come from imported files and shared documents, so
 * only filter primitives go out: no scripts, event handlers or links to
 * anything but the export's own elements and embedded images.
 */
export function filterDefMarkup(markup, id, ox = 0, oy = 0) {
  if (typeof DOMParser !== 'undefined' && typeof XMLSerializer !== 'undefined') {
    const xml = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${markup}</svg>`, 'image/svg+xml');
    const el = !xml.getElementsByTagName('parsererror').length && xml.getElementsByTagNameNS('*', 'filter')[0];
    if (el) {
      el.setAttribute('id', id);
      // Drop attributes of other vocabularies (editor labels); they would need their namespaces.
      const strip = (n) => {
        for (const a of [...n.attributes]) {
          const foreign = a.prefix && a.prefix !== 'xlink' && a.prefix !== 'xmlns';
          const link = a.localName === 'href' && !/^\s*(#|data:image\/)/i.test(a.value);
          if (foreign || link || /^on/i.test(a.localName)) n.removeAttributeNode(a);
        }
        for (const c of [...n.children]) {
          if (FILTER_PARTS.has(c.localName)) strip(c);
          else c.remove();
        }
      };
      strip(el);
      const shift = (n, ax, ay) => {
        for (const [a, d] of [[ax, ox], [ay, oy]]) {
          const v = n.getAttribute(a);
          if (v != null && /^-?[\d.]+(e-?\d+)?$/i.test(v.trim())) n.setAttribute(a, String(Number(v) - d));
        }
      };
      // User-space positions follow the export's origin.
      if (el.getAttribute('filterUnits') === 'userSpaceOnUse') shift(el, 'x', 'y');
      if (el.getAttribute('primitiveUnits') !== 'objectBoundingBox') {
        for (const l of el.querySelectorAll('*')) {
          if (l.localName === 'fePointLight' || l.localName === 'feSpotLight') shift(l, 'x', 'y');
          if (l.localName === 'feSpotLight') shift(l, 'pointsAtX', 'pointsAtY');
        }
      }
      return new XMLSerializer()
        .serializeToString(el)
        .replace(/\s+xmlns(:\w+)?="[^"]*"/g, '');
    }
  }
  // Without a parser to clean it, markup that could run anything is left out.
  if (/<(?!\/?(filter|fe)\w*[\s/>])|\son\w+\s*=|javascript:/i.test(markup)) return `<filter id="${id}"/>`;
  return markup.replace(/\s+xmlns="[^"]*"/, '').replace(/\sid="[^"]*"/, '').replace(/^<filter/, `<filter id="${id}"`);
}

function filterMarkup(node, w, depth) {
  const fx = live(node).filter(filterOn);
  let out = w.element({ ...node, opacity: 1, blendMode: 'normal', isolate: false }, depth + fx.length);
  if (!out) return '';
  fx.forEach((e, i) => {
    const d = depth + fx.length - 1 - i;
    const fid = w.def('f', (id) => `${w.nl(2)}${filterDefMarkup(e.markup, id, w.ox, w.oy)}`);
    if (/xlink:href/.test(e.markup)) w.needsXlink = true;
    const outer = i === fx.length - 1 ? w.commonAttrs({ ...node, effects: [] }) : '';
    out = `${w.nl(d)}<g filter="url(#${fid})"${outer}>${out}${w.nl(d)}</g>`;
  });
  return out;
}

/** Install the export hook (once). */
export function installSvgExport() {
  if (svgExportHooks.element.includes(exportHook)) return;
  svgExportHooks.element.push(exportHook);
}

function exportHook(node, writer, depth) {
  const mode = svgMode(node);
  if (mode === 'raster') return rasterMarkup(node, writer, depth);
  if (mode === 'filter') return filterMarkup(node, writer, depth);
  return undefined;
}
