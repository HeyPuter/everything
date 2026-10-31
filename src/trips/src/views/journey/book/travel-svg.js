// SVG for travel elements (maps, route lines, country shapes). Sizes are in mm of the element box. `paint(name)` gives a
// CSS color: theme variables on screen, resolved light colors for image export.
import { loadCountries } from '../../../lib/atlas/boundaries.js';
import { featureCode } from '../../../lib/atlas/countries.js';
import { fitView, geometryPoints, linePath, projector, scopedPoints, shapePath } from '../../../lib/book/travel.js';

const NS = 'http://www.w3.org/2000/svg';
let byCode = null;

function svgEl(tag, attrs = {}, style = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  for (const [key, value] of Object.entries(style)) if (value) node.style.setProperty(key, value);
  return node;
}

/** Country features by alpha-2 code, loaded once; null until loaded or when the data is unavailable. */
export function countryShapes() {
  if (!byCode) {
    byCode = loadCountries().then(({ features }) => {
      const map = new Map();
      for (const feature of features.features) { const code = featureCode(feature); if (code && !map.has(code)) map.set(code, feature); }
      return map;
    }).catch(() => { byCode = null; return null; });
  }
  return byCode;
}

const frame = (w, h) => svgEl('svg', { xmlns: NS, viewBox: `0 0 ${w} ${h}`, width: '100%', height: '100%', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });

/** A map of the journey (or the page's entries) with country outlines, the dashed route and pins. */
export function mapSvg({ entries, page, item, w, h, shapes, paint, route = false }) {
  const svg = frame(w, h);
  const points = scopedPoints(entries, page, item.scope);
  const view = fitView(points, w / Math.max(h, 0.001));
  const project = projector(view, w, h);
  if (!route) {
    svg.append(svgEl('rect', { x: 0, y: 0, width: w, height: h }, { fill: paint(item.fill ?? 'surface-2', 'surface-2') }));
    if (shapes) {
      const land = svgEl('g', {}, { fill: paint('surface', 'surface'), stroke: paint('surface-3', 'surface-3'), 'stroke-width': `${Math.max(0.1, Math.min(w, h) / 400)}` });
      for (const feature of shapes.values()) {
        const d = shapePath(feature.geometry, project, w, h);
        if (d) land.append(svgEl('path', { d }));
      }
      svg.append(land);
    }
  }
  const stroke = Math.max(0.35, Math.min(w, h) / 120);
  const color = paint(item.color ?? 'day-1', 'day-1');
  const d = linePath(points, project);
  if (d) svg.append(svgEl('path', { d, fill: 'none' }, { stroke: color, 'stroke-width': `${stroke}`, 'stroke-dasharray': `${stroke * 3} ${stroke * 2}`, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  const radius = stroke * 1.8;
  for (const point of points) {
    const [x, y] = project(point.lng, point.lat);
    svg.append(svgEl('circle', { cx: x, cy: y, r: radius }, { fill: color, stroke: paint('surface', 'surface'), 'stroke-width': `${stroke * 0.6}` }));
  }
  return svg;
}

/** One country's outline (its largest landmass), fitted into the box. */
export function countrySvg({ item, w, h, shapes, paint }) {
  const svg = frame(w, h);
  const feature = shapes?.get(item.cc);
  if (!feature) return svg;
  const view = fitView(geometryPoints(feature.geometry), w / Math.max(h, 0.001), 0.04);
  const d = shapePath(feature.geometry, projector(view, w, h), w, h);
  svg.append(svgEl('path', { d }, { fill: paint(item.fill ?? 'day-1', 'day-1'), stroke: paint(item.color ?? 'none', 'none'), 'stroke-width': `${item.stroke ?? 0.3}` }));
  return svg;
}
