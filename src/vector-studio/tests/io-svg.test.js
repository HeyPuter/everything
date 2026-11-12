import { describe, it, expect } from 'vitest';
import { parsePathData, tokenizePath, arcToCubics, pathDataFromSubpaths, numberFormatter } from '../src/features/io/svg-path.js';
import { parseTransform, parseStylesheet, specificity, parseLength, mediaMatches } from '../src/features/io/svg-style.js';
import { convertSVG, svgToDocument, svgToNodes, viewBoxTransform } from '../src/features/io/svg-import.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import { pathBounds, segmentCount, segmentPoints, pointAt } from '../src/model/bezier.js';
import { nodeBounds } from '../src/model/geometry.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createCompound, createGroup, createText } from '../src/model/nodes.js';
import { rectangle, ellipse } from '../src/model/shapes.js';
import { apply } from '../src/lib/matrix.js';

const close = (a, b, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

function samplePath(anchors, closed, n = 8) {
  const pts = [];
  const segs = segmentCount(anchors, closed);
  for (let i = 0; i < segs; i++) {
    const c = segmentPoints(anchors, i);
    for (let k = 0; k < n; k++) pts.push(pointAt(c, k / n));
  }
  return pts;
}

describe('path data parsing', () => {
  it('tokenizes compact numbers and arc flags', () => {
    expect(tokenizePath('M1.5.5-2-3')).toEqual([['M', [1.5, 0.5, -2, -3]]]);
    expect(tokenizePath('a10 10 0 01100 100')).toEqual([['a', [10, 10, 0, 0, 1, 100, 100]]]);
    expect(tokenizePath('M1e2,2E-1')).toEqual([['M', [100, 0.2]]]);
  });

  it('handles absolute and relative lines, H/V and implicit lineto after M', () => {
    const [sp] = parsePathData('M10 10 20 10 h10 v10 H10 z');
    expect(sp.closed).toBe(true);
    expect(sp.anchors.map((a) => [a.x, a.y])).toEqual([[10, 10], [20, 10], [30, 10], [30, 20], [10, 20]]);
    const [r] = parsePathData('m10 10 10 0 0 10');
    expect(r.anchors.map((a) => [a.x, a.y])).toEqual([[10, 10], [20, 10], [20, 20]]);
  });

  it('parses cubic, smooth cubic, quadratic and smooth quadratic segments', () => {
    const [c] = parsePathData('M0 0 C10 0 20 10 20 20 S30 40 40 40');
    expect(c.anchors[1]).toMatchObject({ x: 20, y: 20, ix: 20, iy: 10, ox: 20, oy: 30 });
    expect(c.anchors[2]).toMatchObject({ x: 40, y: 40, ix: 30, iy: 40 });
    const [q] = parsePathData('M0 0 Q30 0 30 30 T60 60');
    // Quadratic control (30,0) becomes cubic handles at 2/3.
    expect(q.anchors[0].ox).toBeCloseTo(20);
    expect(q.anchors[0].oy).toBeCloseTo(0);
    expect(q.anchors[1].ix).toBeCloseTo(30);
    expect(q.anchors[1].iy).toBeCloseTo(10);
    // Reflected control (30,60) for T.
    expect(q.anchors[1].ox).toBeCloseTo(30);
    expect(q.anchors[1].oy).toBeCloseTo(50);
    const [rel] = parsePathData('m10 10 c0 10 10 10 10 0 s10 -10 10 0');
    expect(rel.anchors[2]).toMatchObject({ x: 30, y: 10 });
    expect(rel.anchors[1].ox).toBeCloseTo(20);
    expect(rel.anchors[1].oy).toBeCloseTo(0);
  });

  it('converts arcs to cubics that stay on the ellipse', () => {
    const [sp] = parsePathData('M0 50 A50 50 0 0 1 100 50');
    const pts = samplePath(sp.anchors, false, 10);
    for (const p of pts) close(Math.hypot(p.x - 50, p.y - 50), 50, 0.05);
    // Sweep 1 from the left goes through the top (y < 50 on a y-down screen).
    const b = pathBounds(sp.anchors, false);
    close(b.y, 0, 1e-3);
    const segs = arcToCubics(0, 0, 10, 5, 30, 1, 0, 10, 10);
    expect(segs.length).toBeGreaterThan(0);
    const last = segs[segs.length - 1];
    expect([last[4], last[5]]).toEqual([10, 10]);
  });

  it('scales up radii that are too small and treats zero radii as lines', () => {
    const [sp] = parsePathData('M0 0 A1 1 0 0 0 100 0');
    const b = pathBounds(sp.anchors, false);
    close(b.w, 100, 1e-6);
    close(b.h, 50, 0.05);
    const [line] = parsePathData('M0 0 A0 5 0 0 0 10 0');
    expect(line.anchors).toHaveLength(2);
  });

  it('merges the closing anchor and starts new subpaths after z', () => {
    const subs = parsePathData('M0 0 L10 0 L10 10 L0 0 Z l5 5 l5 0');
    expect(subs[0].anchors).toHaveLength(3);
    expect(subs[1].anchors[0]).toMatchObject({ x: 0, y: 0 });
    expect(subs[1].anchors[1]).toMatchObject({ x: 5, y: 5 });
  });

  it('keeps everything before a syntax error and never throws', () => {
    const subs = parsePathData('M0 0 L10 10 L20 # 30');
    expect(subs[0].anchors).toHaveLength(2);
    expect(parsePathData('garbage')).toEqual([]);
    expect(parsePathData(null)).toEqual([]);
  });

  it('writes compact path data and round trips it', () => {
    const subs = [{ anchors: rectangle(0, 0, 10, 20), closed: true }, { anchors: ellipse(20, 20, 10, 10), closed: true }];
    const d = pathDataFromSubpaths(subs, { precision: 2 });
    expect(d.startsWith('M 0 0 H 10 V 20 H 0 Z')).toBe(true);
    const min = pathDataFromSubpaths(subs, { precision: 2, minify: true });
    expect(min.length).toBeLessThan(d.length);
    for (const src of [d, min]) {
      const back = parsePathData(src);
      expect(back).toHaveLength(2);
      const b = pathBounds(back[1].anchors, true);
      close(b.x, 20, 0.01);
      close(b.w, 10, 0.02);
    }
    expect(numberFormatter(3, true)(-0.5)).toBe('-.5');
    expect(numberFormatter(2)(1.005)).toBe('1');
    expect(numberFormatter(3)(-0.0001)).toBe('0');
  });

  it('keeps a separator before a leading-dot number that follows an integer', () => {
    const pt = (x, y) => ({ x, y, ix: x, iy: y, ox: x, oy: y });
    const min = pathDataFromSubpaths([{ anchors: [pt(0, 0), pt(10, 10), pt(0.5, 20)], closed: false }], { minify: true });
    expect(min).not.toContain('10.5');
    const back = parsePathData(min)[0].anchors.map((p) => [p.x, p.y]);
    expect(back).toEqual([
      [0, 0],
      [10, 10],
      [0.5, 20],
    ]);
  });
});

describe('transforms, lengths and CSS', () => {
  it('parses and composes transform lists left to right', () => {
    expect(parseTransform('translate(10 20)')).toEqual([1, 0, 0, 1, 10, 20]);
    const m = parseTransform('translate(10,20) scale(2)');
    expect(apply(m, 1, 1)).toEqual({ x: 12, y: 22 });
    const r = parseTransform('rotate(90 10 10)');
    const p = apply(r, 20, 10);
    close(p.x, 10);
    close(p.y, 20);
    const s = parseTransform('skewX(45)');
    close(apply(s, 0, 10).x, 10);
    expect(parseTransform('matrix(1,2,3,4,5,6)')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(parseTransform('bogus(1)')).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('converts lengths', () => {
    expect(parseLength('1in')).toBe(72);
    expect(parseLength('50%', { ref: 200 })).toBe(100);
    expect(parseLength('2em', { fontSize: 10 })).toBe(20);
    expect(parseLength('abc', { fallback: 7 })).toBe(7);
  });

  it('parses stylesheets with specificity and at-rules', () => {
    const rules = parseStylesheet('/* c */ .a, #b { fill: red } @media screen { rect.c { stroke: blue !important } } @font-face { font-family: x }');
    expect(rules.map((r) => r.selector)).toEqual(['.a', '#b', 'rect.c']);
    expect(rules[2].decls.stroke).toEqual({ value: 'blue', important: true });
    expect(specificity('#a .b rect')).toBeGreaterThan(specificity('.b .c rect'));
    expect(specificity('.b')).toBeGreaterThan(specificity('rect'));
  });

  it('applies class rules, inline style and presentation attributes in cascade order', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <style>.red { fill: #ff0000; stroke: #000; stroke-width: 4 } #b.red { fill: #00ff00 } g .inherit { stroke-width: 2 }</style>
      <rect id="a" class="red" fill="blue" width="10" height="10"/>
      <rect id="b" class="red" width="10" height="10"/>
      <rect id="c" class="red" style="fill:#123456" width="10" height="10"/>
      <g stroke="#ff00ff"><rect class="inherit" width="5" height="5"/></g>
    </svg>`;
    const doc = svgToDocument(svg);
    const paths = doc.leaves();
    expect(paths[0].fill.color).toBe('#ff0000'); // CSS beats presentation attribute
    expect(paths[0].strokeWidth).toBe(4);
    expect(paths[1].fill.color).toBe('#00ff00'); // higher specificity
    expect(paths[2].fill.color).toBe('#123456'); // inline style wins
    expect(paths[3].stroke.color).toBe('#ff00ff'); // inherited from the group
    expect(paths[3].strokeWidth).toBe(2);
  });
});

describe('SVG @media rules', () => {
  it('apply only when they match a light screen at the drawing\'s own size', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32">
      <style>
        .a { fill: #ff0000 } .b { fill: #ff0000 } .c { fill: #ff0000 } .d { fill: #ff0000 } .e { fill: #ff0000 }
        @media (prefers-color-scheme: dark) { .a { fill: #ffffff } }
        @media (prefers-color-scheme: light) { .b { fill: #00ff00 } }
        @media screen and (max-width: 100px) { .c { fill: #00ff00 } }
        @media (min-width: 500px), print { .d { fill: #0000ff } }
        @media (width >= 60px) and (orientation: landscape) { .e { fill: #00ff00 } }
      </style>
      <rect class="a" width="5" height="5"/><rect class="b" width="5" height="5"/><rect class="c" width="5" height="5"/>
      <rect class="d" width="5" height="5"/><rect class="e" width="5" height="5"/>
    </svg>`;
    const fills = svgToDocument(svg).leaves().map((n) => n.fill.color);
    expect(fills).toEqual(['#ff0000', '#00ff00', '#00ff00', '#ff0000', '#00ff00']);
  });

  it('match media query lists', () => {
    expect(mediaMatches('screen')).toBe(true);
    expect(mediaMatches('print')).toBe(false);
    expect(mediaMatches('not print')).toBe(true);
    expect(mediaMatches('only screen and (min-width: 10px)', { width: 20, height: 20 })).toBe(true);
    expect(mediaMatches('(max-width: 10px)', { width: 20, height: 20 })).toBe(false);
    expect(mediaMatches('(max-width: 10px)')).toBe(true); // no size known: kept
    expect(mediaMatches('(prefers-reduced-motion: reduce), (hover: hover)')).toBe(true);
    expect(mediaMatches('(min-resolution: 2dppx)')).toBe(false);
    expect(mediaMatches('(unknown-feature: 1)')).toBe(false);
    expect(mediaMatches('(400px < width)', { width: 300, height: 10 })).toBe(false);
  });
});

describe('SVG import', () => {
  it('maps the root viewBox to an artboard', () => {
    const doc = svgToDocument('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 20 10"><rect x="0" y="0" width="10" height="10"/></svg>');
    expect(doc.artboards[0]).toMatchObject({ x: 0, y: 0, w: 200, h: 100 });
    const b = nodeBounds(doc, doc.leaves()[0]);
    expect(b).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    // preserveAspectRatio meet centers the content.
    expect(viewBoxTransform([0, 0, 10, 10], 0, 0, 20, 10)).toEqual([1, 0, 0, 1, 5, 0]);
  });

  it('starts circles, ellipses and rounded rects where SVG does, so dashes keep their phase', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
      <circle cx="60" cy="150" r="35" fill="none" stroke="#000" stroke-dasharray="20 10"/>
      <ellipse cx="150" cy="35" rx="40" ry="20"/>
      <rect x="10" y="10" width="40" height="30" rx="5"/>
    </svg>`);
    const [c, e, r] = doc.leaves();
    expect([c.anchors[0].x, c.anchors[0].y]).toEqual([95, 150]);
    expect([c.anchors[1].x, c.anchors[1].y]).toEqual([60, 185]);
    expect([e.anchors[0].x, e.anchors[0].y]).toEqual([190, 35]);
    expect([r.anchors[0].x, r.anchors[0].y]).toEqual([15, 10]);
    expect(r.anchors).toHaveLength(8);
  });

  it('imports basic shapes with live shape params', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <rect x="10" y="10" width="20" height="10" rx="2"/>
      <circle cx="50" cy="50" r="10" fill="none" stroke="red" stroke-width="3"/>
      <ellipse cx="50" cy="50" rx="10" ry="5" transform="translate(5 5)"/>
      <line x1="0" y1="0" x2="10" y2="10" stroke="black"/>
      <polygon points="0,0 10,0 5,10"/>
      <polyline points="0 0 10 0 5 10" fill="none" stroke="#000"/>
    </svg>`);
    const [rect, circle, ell, line, poly, polyline] = doc.leaves();
    expect(rect.shape).toMatchObject({ kind: 'rect', cx: 20, cy: 15, w: 20, h: 10, radii: [2, 2, 2, 2] });
    expect(circle.shape).toMatchObject({ kind: 'ellipse', cx: 50, cy: 50, w: 20, h: 20 });
    expect(circle.fill).toBe(null);
    expect(circle.stroke).toEqual({ type: 'solid', color: '#ff0000' });
    expect(circle.strokeWidth).toBe(3);
    expect(ell.shape).toMatchObject({ cx: 55, cy: 55, w: 20, h: 10 });
    expect(line.shape).toMatchObject({ kind: 'line', x2: 10, y2: 10 });
    expect(line.fill).toBe(null);
    expect(poly.closed).toBe(true);
    expect(polyline.closed).toBe(false);
  });

  it('bakes nested transforms and scales stroke widths', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <g transform="translate(10 10)"><g transform="scale(2)"><path d="M0 0 L10 0" stroke="#000" stroke-width="2" stroke-dasharray="1 2 3"/></g></g>
    </svg>`);
    const p = doc.leaves()[0];
    expect(p.anchors[0]).toMatchObject({ x: 10, y: 10 });
    expect(p.anchors[1]).toMatchObject({ x: 30, y: 10 });
    expect(p.strokeWidth).toBe(4);
    expect(p.dash).toEqual([2, 4, 6, 2, 4, 6]);
  });

  it('turns multi-subpath paths into compound paths with the fill rule', () => {
    const doc = svgToDocument('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path fill-rule="evenodd" d="M0 0H10V10H0Z M2 2H8V8H2Z"/></svg>');
    const c = doc.leaves()[0];
    expect(c.type).toBe('compound');
    expect(c.fillRule).toBe('evenodd');
    expect(c.children).toHaveLength(2);
    expect(doc.get(c.children[0]).parent).toBe(c.id);
  });

  it('maps gradients with units, transforms and href inheritance', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="200">
      <defs>
        <linearGradient id="base"><stop offset="0" stop-color="red"/><stop offset="100%" stop-color="blue" stop-opacity=".5"/></linearGradient>
        <linearGradient id="obb" xlink:href="#base"/>
        <linearGradient id="user" href="#base" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="100" gradientTransform="translate(10 0)"/>
        <radialGradient id="rad" href="#base" cx="0.5" cy="0.5" r="0.5"/>
      </defs>
      <rect x="100" y="0" width="50" height="20" fill="url(#obb)"/>
      <rect width="10" height="10" fill="url(#user)" fill-opacity="0.5"/>
      <rect x="0" y="100" width="40" height="40" fill="url(#rad)"/>
      <rect width="10" height="10" fill="url(#missing) green"/>
    </svg>`);
    const [a, b, c, d] = doc.leaves();
    expect(a.fill.type).toBe('linear');
    expect(a.fill.stops).toEqual([{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 0.5 }]);
    expect([a.fill.x1, a.fill.y1, a.fill.x2, a.fill.y2]).toEqual([100, 0, 150, 0]);
    expect(b.fill.x1).toBe(10);
    expect(b.fill.y2).toBe(100);
    expect(b.fill.stops[0].opacity).toBe(0.5);
    expect(b.fill.angle).toBe(-90);
    expect(c.fill.type).toBe('radial');
    expect([c.fill.x1, c.fill.y1]).toEqual([20, 120]);
    close(c.fill.x2 - c.fill.x1, 20);
    expect(d.fill).toEqual({ type: 'solid', color: '#008000' });
  });

  it('maps skewed objectBoundingBox linear gradients exactly', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0"/><stop offset="1" stop-color="#fff"/></linearGradient>
      <rect width="100" height="50" fill="url(#g)"/></svg>`);
    const g = doc.leaves()[0].fill;
    // In bbox space the gradient runs along the diagonal; in user space the
    // isolines stay parallel to the other diagonal, so the far corner is t = 1.
    const t = (x, y) => ((x - g.x1) * (g.x2 - g.x1) + (y - g.y1) * (g.y2 - g.y1)) / ((g.x2 - g.x1) ** 2 + (g.y2 - g.y1) ** 2);
    close(t(100, 50), 1);
    close(t(100, 0), 0.5);
    close(t(0, 50), 0.5);
  });

  it('turns clip-path into clip groups and resolves use/symbol', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100">
      <defs>
        <clipPath id="c"><circle cx="50" cy="50" r="20"/></clipPath>
        <symbol id="s" viewBox="0 0 10 10"><rect width="10" height="10" fill="currentColor"/></symbol>
        <path id="p" d="M0 0H5V5Z"/>
      </defs>
      <g clip-path="url(#c)" style="color: #00f"><rect width="100" height="100"/></g>
      <use xlink:href="#s" x="10" y="10" width="20" height="20" color="#f00"/>
      <use href="#p" x="50" y="50"/>
    </svg>`);
    const layer = doc.layers()[0];
    const clip = doc.get(layer.children[0]);
    expect(clip.type).toBe('group');
    expect(clip.clip).toBe(true);
    const mask = doc.get(clip.children[clip.children.length - 1]);
    expect(nodeBounds(doc, mask)).toMatchObject({ x: 30, y: 30 });
    const sym = doc.leaves().find((n) => n.fill?.color === '#ff0000');
    expect(nodeBounds(doc, sym)).toEqual({ x: 10, y: 10, w: 20, h: 20 });
    const used = doc.leaves().at(-1);
    expect(nodeBounds(doc, used)).toEqual({ x: 50, y: 50, w: 5, h: 5 });
  });

  it('imports text, tspans, opacity, blend modes and filters', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <filter id="f"><feGaussianBlur stdDeviation="3"/></filter>
      <text x="10" y="20" font-family="'Open Sans', Arial" font-size="12" font-weight="bold" text-anchor="middle" opacity=".5">Hello <tspan>world</tspan></text>
      <text x="0" y="50"><tspan x="0" y="50">One</tspan><tspan x="0" y="65">Two</tspan></text>
      <rect width="5" height="5" style="mix-blend-mode: multiply" filter="url(#f)"/>
    </svg>`);
    const [t1, t2, r] = doc.leaves();
    expect(t1.type).toBe('text');
    expect(t1.text).toBe('Hello world');
    expect(t1.char).toMatchObject({ fontFamily: 'Open Sans', fontSize: 12, fontWeight: 700 });
    expect(t1.para.align).toBe('center');
    expect(t1.opacity).toBe(0.5);
    expect(t2.text).toBe('One\nTwo');
    expect(t2.char.leading).toBe(15);
    expect(r.blendMode).toBe('multiply');
    expect(r.effects).toEqual([{ type: 'blur', radius: 3 }]);
  });

  it('imports differently styled tspans as one text object with style runs', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
      <text x="10" y="30" font-size="18" fill="#000">Mixed <tspan fill="red" font-weight="bold">bold red</tspan> end</text>
      <text x="10" y="70" font-size="16">x<tspan baseline-shift="super" font-size="10">2</tspan> + y<tspan baseline-shift="-2">i</tspan></text>
    </svg>`);
    const [t1, t2] = doc.leaves();
    expect(doc.leaves()).toHaveLength(2);
    expect(t1.text).toBe('Mixed bold red end');
    expect(t1.fill).toEqual({ type: 'solid', color: '#000000' });
    expect(t1.runs).toEqual([{ len: 6 }, { len: 8, fontWeight: 700, fill: { type: 'solid', color: '#ff0000' } }, { len: 4 }]);
    expect(t2.text).toBe('x2 + yi');
    const [, sup, , sub] = t2.runs;
    expect(sup).toMatchObject({ len: 1, fontSize: 10 });
    expect(sup.baselineShift).toBeGreaterThan(4);
    expect(sub).toMatchObject({ len: 1, baselineShift: -2 });
  });

  it('expands pattern fills into tiles clipped to the shape', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <pattern id="p" patternUnits="userSpaceOnUse" width="10" height="10"><rect width="5" height="5" fill="#09c"/></pattern>
      <rect x="0" y="0" width="40" height="20" fill="url(#p)" stroke="#000"/>
    </svg>`);
    expect(doc.importWarnings).toEqual([]);
    const top = doc.get(doc.layers()[0].children[0]);
    expect(top.type).toBe('group');
    const [clip, outline] = top.children.map((id) => doc.get(id));
    expect(clip).toMatchObject({ type: 'group', clip: true });
    expect(outline).toMatchObject({ type: 'path', fill: null, stroke: { type: 'solid', color: '#000000' } });
    const tiles = clip.children.slice(0, -1).map((id) => doc.get(id));
    expect(tiles).toHaveLength(8);
    expect(tiles.every((t) => t.fill.color === '#0099cc')).toBe(true);
    expect(nodeBounds(doc, tiles[7])).toEqual({ x: 30, y: 10, w: 5, h: 5 });
  });

  it('falls back to the pattern background color for patterns too fine to expand', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1000" height="1000">
      <pattern id="h" patternUnits="userSpaceOnUse" width="1" height="1"><rect width="2" height="2" fill="#ee3333"/><path d="M0 0L1 1" stroke="#000"/></pattern>
      <pattern id="h2" xlink:href="#h"/>
      <rect width="1000" height="1000" fill="url(#h)"/>
      <rect width="1000" height="1000" style="fill: url(#h2)" fill-opacity="0.5"/>
    </svg>`);
    const [a, b] = doc.leaves();
    expect(a.fill).toEqual({ type: 'solid', color: '#ee3333' });
    expect(b.fill).toEqual({ type: 'solid', color: '#ee3333', opacity: 0.5 });
    expect(doc.importWarnings).toContain('Pattern fills were replaced with a flat color.');
  });

  it('expands markers into artwork oriented along the path', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
      <marker id="a" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#c00"/></marker>
      <path d="M20 50 L120 50" stroke="#000" stroke-width="2" marker-start="url(#a)" marker-end="url(#a)"/>
    </svg>`);
    expect(doc.importWarnings.join(' ')).not.toMatch(/Markers/);
    const leaves = doc.leaves();
    expect(leaves).toHaveLength(3);
    const [line, start, end] = leaves;
    expect(doc.get(line.parent).type).toBe('group');
    // 4 x stroke width 2 = 8 units long, tip at the vertex.
    const be = nodeBounds(doc, end);
    expect(be.x + be.w).toBeCloseTo(120, 5);
    expect(be.w).toBeCloseTo(8, 5);
    expect(be.y + be.h / 2).toBeCloseTo(50, 5);
    // The start marker is reversed: its tip points left at the start vertex.
    const bs = nodeBounds(doc, start);
    expect(bs.x).toBeCloseTo(20, 5);
    expect(start.fill).toEqual({ type: 'solid', color: '#cc0000' });
  });

  it('repeats and reflects gradient stops across the object for spreadMethod', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <linearGradient id="r" x1="0" x2="0.25" spreadMethod="reflect"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>
      <rect width="100" height="10" fill="url(#r)"/>
    </svg>`);
    const g = doc.leaves()[0].fill;
    expect(doc.importWarnings).toEqual([]);
    expect(g.x1).toBeCloseTo(0);
    expect(g.x2).toBeCloseTo(100);
    expect(g.stops.map((s) => [s.offset, s.color])).toEqual([
      [0, '#ff0000'], [0.25, '#0000ff'],
      [0.25, '#0000ff'], [0.5, '#ff0000'],
      [0.5, '#ff0000'], [0.75, '#0000ff'],
      [0.75, '#0000ff'], [1, '#ff0000'],
    ]);
  });

  it('keeps reused paths independent when one path is used many times', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <defs><path id="m" d="M0 0 L10 0 L10 10 Z"/></defs>
      <use href="#m" x="5" y="5" style="fill: #f00"/>
      <use href="#m" x="50" y="50" style="fill: #00f"/>
      <path d="M0 0 L10 0 L10 10 Z" fill="#0f0"/>
    </svg>`);
    const [a, b, c] = doc.leaves();
    expect(a.anchors[0]).toMatchObject({ x: 5, y: 5 });
    expect(b.anchors[0]).toMatchObject({ x: 50, y: 50 });
    expect(c.anchors[0]).toMatchObject({ x: 0, y: 0 });
    expect([a.fill.color, b.fill.color, c.fill.color]).toEqual(['#ff0000', '#0000ff', '#00ff00']);
    expect(a.anchors).not.toBe(c.anchors);
  });

  it('places characters at their own x and dy positions', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
      <text x="10 30 50 70" y="40" font-size="18">ABCD</text>
      <text x="10" y="80" dy="0 5 5">xyz</text>
    </svg>`);
    const texts = doc.leaves();
    expect(texts.slice(0, 4).map((t) => [t.text, t.x, t.y])).toEqual([['A', 10, 40], ['B', 30, 40], ['C', 50, 40], ['D', 70, 40]]);
    const [x, y, z] = texts.slice(4);
    expect([x.text, y.text, z.text]).toEqual(['x', 'y', 'z']);
    expect([x.y, y.y, z.y]).toEqual([80, 85, 90]);
    expect(y.x).toBeGreaterThan(x.x);
  });

  it('reads drop shadows written by design tools (flood placeholder, color matrix, blends)', () => {
    const doc = svgToDocument(`<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
      <g filter="url(#f)"><rect x="10" y="10" width="50" height="40" fill="#5B8DEF"/></g>
      <filter id="f" x="0" y="0" width="100" height="100" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
        <feFlood flood-opacity="0" result="BackgroundImageFix"/>
        <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
        <feOffset dx="2" dy="4"/>
        <feGaussianBlur stdDeviation="4"/>
        <feComposite in2="hardAlpha" operator="out"/>
        <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/>
        <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow"/>
        <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape"/>
      </filter>
    </svg>`);
    expect(doc.importWarnings).toEqual([]);
    const n = [...doc.nodes.values()].find((x) => x.effects?.length);
    expect(n.effects).toEqual([{ type: 'dropShadow', x: 2, y: 4, blur: 8, color: '#ff0000', opacity: 0.25 }]);
  });

  it('skips switch branches that need extensions, without a warning', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><switch>
      <foreignObject requiredExtensions="http://example.com/ext" width="1" height="1"><p>private</p></foreignObject>
      <g><rect width="10" height="10"/></g>
    </switch></svg>`);
    expect(doc.importWarnings).toEqual([]);
    expect(doc.leaves()).toHaveLength(1);
  });

  it('embeds data URL images with their pixel size', () => {
    // 1x1 PNG
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><image href="${png}" x="10" y="10" width="20" height="40"/></svg>`);
    const img = doc.leaves()[0];
    expect(img.type).toBe('image');
    expect(img.width).toBe(1);
    expect(nodeBounds(doc, img)).toEqual({ x: 10, y: 20, w: 20, h: 20 });
    expect(doc.assets.get(img.asset).mime).toBe('image/png');
  });

  it('survives malformed input and reports unsupported features', () => {
    expect(() => svgToDocument('not svg at all')).toThrow();
    const doc = svgToDocument('<svg width="10" height="10"><rect width="5" height="5" fill="red"><foreignObject/></svg>');
    expect(doc.leaves()).toHaveLength(1);
    expect(doc.importWarnings.join(' ')).toMatch(/leniently/);
    const r = convertSVG('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/><path d="M0 0 L5 5" marker-end="url(#m)" stroke="#000"/></svg>');
    expect(r.warnings.join(' ')).toMatch(/foreignObject/);
    // A marker that does not exist draws nothing, as in browsers.
    expect(r.warnings.join(' ')).not.toMatch(/Markers/);
    // Content bounds become the artboard when there is no size.
    expect(r.artboard).toMatchObject({ x: 0, y: 0, w: 5, h: 5 });
  });

  it('returns placeable subtrees', () => {
    const r = svgToNodes('<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/><circle cx="20" cy="20" r="5"/></svg>');
    expect(r.nodes[0].type).toBe('group');
    expect(r.nodes).toHaveLength(3);
    expect(r.bounds).toEqual({ x: 0, y: 0, w: 25, h: 25 });
    const doc = VDocument.create();
    doc.transact('Place', () => doc.importSubtree(r.subtree, doc.layers()[0].id));
    expect(doc.leaves()).toHaveLength(2);
  });
});

function buildDoc() {
  const doc = VDocument.create({ width: 200, height: 100 });
  const layer = doc.layers()[0].id;
  doc.transact('build', () => {
    doc.insert(createPath(rectangle(10, 10, 50, 30), true, { fill: { type: 'linear', stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 0.5 }], angle: 0 }, stroke: null }, { shape: { kind: 'rect', cx: 35, cy: 25, w: 50, h: 30, radii: [0, 0, 0, 0], angle: 0 } }), layer);
    const kids = [createPath(rectangle(100, 10, 40, 40), true, { fill: null, stroke: null }), createPath(rectangle(110, 20, 20, 20), true, { fill: null, stroke: null })];
    doc.insert(createCompound(kids.map((k) => k.id), { fill: { type: 'solid', color: '#00aa00' }, stroke: null }, { fillRule: 'evenodd' }), layer, Infinity, kids);
    const content = createPath(ellipse(150, 50, 60, 60), true, { fill: { type: 'radial', stops: [{ offset: 0, color: '#ffffff', opacity: 1 }, { offset: 1, color: '#000000', opacity: 1 }] }, stroke: { type: 'solid', color: '#333333' }, strokeWidth: 2, dash: [4, 2] });
    const mask = createPath(rectangle(150, 50, 40, 40), true, { fill: null, stroke: null });
    doc.insert(createGroup([content.id, mask.id], { clip: true }), layer, Infinity, [content, mask]);
    const g1 = createPath([{ x: 5, y: 90, ix: 5, iy: 90, ox: 20, oy: 70 }, { x: 40, y: 90, ix: 25, iy: 70, ox: 40, oy: 90 }], false, { fill: null, stroke: { type: 'solid', color: '#000000' }, strokeWidth: 3, strokeCap: 'round' });
    doc.insert(createGroup([g1.id], { opacity: 0.5 }), layer, Infinity, [g1]);
  });
  doc.repairParents();
  return doc;
}

describe('SVG export and round trip', () => {
  it('writes standards-compliant markup', () => {
    const doc = buildDoc();
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 200, h: 100 } });
    expect(svg).toMatch(/^<\?xml/);
    expect(svg).toContain('viewBox="0 0 200 100"');
    expect(svg).toContain('<rect x="10" y="10" width="50" height="30"');
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).toContain('<clipPath');
    expect(svg).toContain('gradientUnits="userSpaceOnUse"');
    expect(svg).toContain('stroke-dasharray="4 2"');
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(parsed.getElementsByTagName('parsererror')).toHaveLength(0);
    const responsive = exportSVG(doc, { rect: { x: 0, y: 0, w: 200, h: 100 }, responsive: true, minify: true });
    expect(responsive).not.toContain('width="200"');
    expect(responsive.length).toBeLessThan(svg.length);
  });

  it('round trips shapes, gradients, groups, clip groups and compound paths', () => {
    const doc = buildDoc();
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 200, h: 100 }, precision: 4 });
    const back = svgToDocument(svg);
    const a = doc.leaves();
    const b = back.leaves();
    expect(b.map((n) => n.type)).toEqual(a.map((n) => n.type));
    for (let i = 0; i < a.length; i++) {
      const ba = nodeBounds(doc, a[i]);
      const bb = nodeBounds(back, b[i]);
      for (const k of ['x', 'y', 'w', 'h']) close(ba[k], bb[k], 1e-3);
    }
    expect(b[0].fill.type).toBe('linear');
    close(b[0].fill.x1, 10, 1e-3);
    close(b[0].fill.x2, 60, 1e-3);
    expect(b[0].fill.stops[1].opacity).toBe(0.5);
    expect(b[1].fillRule).toBe('evenodd');
    expect(b[2].fill.type).toBe('radial');
    expect(b[2].dash).toEqual([4, 2]);
    const clipGroup = back.parentOf(b[2].id);
    expect(clipGroup.clip).toBe(true);
    const group = back.parentOf(b[b.length - 1].id);
    expect(group.opacity).toBe(0.5);
    expect(b[b.length - 1].strokeCap).toBe('round');
    // Anchor geometry survives within tolerance.
    const pa = samplePath(a[a.length - 1].anchors, false);
    const pb = samplePath(b[b.length - 1].anchors, false);
    pa.forEach((p, i) => {
      close(p.x, pb[i].x, 1e-3);
      close(p.y, pb[i].y, 1e-3);
    });
  });

  it('keeps the alignment of a clipping path\'s stroke', () => {
    const doc = VDocument.create({ width: 120, height: 120 });
    const layer = doc.layers()[0].id;
    const content = createPath(rectangle(0, 0, 120, 120), true, { fill: { type: 'solid', color: '#ff0000' }, stroke: null });
    const mask = createPath(ellipse(20, 20, 80, 80), true, { fill: null, stroke: { type: 'solid', color: '#0000ff' }, strokeWidth: 10, strokeAlign: 'inside', opacity: 0.5 });
    doc.transact('build', () => doc.insert(createGroup([content.id, mask.id], { clip: true }), layer, Infinity, [content, mask]));
    doc.repairParents();
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 120, h: 120 } });
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    // An inside stroke is a double-width stroke clipped to the shape (a centered 10pt stroke would spill 5pt outside).
    const stroke = [...parsed.getElementsByTagName('*')].find((el) => el.getAttribute('stroke') === '#0000ff');
    expect(stroke.getAttribute('stroke-width')).toBe('20');
    expect(stroke.parentNode.getAttribute('clip-path')).toMatch(/^url\(#c\d+\)$/);
    // The clipping path's own opacity does not apply to its stroke (as on the canvas).
    expect(svg).not.toContain('opacity="0.5"');
  });

  it('offsets content to the exported artboard', () => {
    const doc = buildDoc();
    const svg = exportSVG(doc, { rect: { x: 100, y: 10, w: 40, h: 40 } });
    const back = svgToDocument(svg);
    const c = back.leaves().find((n) => n.type === 'compound');
    expect(nodeBounds(back, c)).toEqual({ x: 0, y: 0, w: 40, h: 40 });
    // Objects outside the rect are culled.
    expect(back.leaves().some((n) => n.shape?.kind === 'rect' && n.fill?.type === 'linear')).toBe(false);
  });
});

describe('effects in SVG export', () => {
  it('writes an inner glow with its blend mode and room for the glow', () => {
    const doc = VDocument.create({ name: 'Glow', width: 200, height: 200 });
    const layer = doc.layers()[0];
    const p = createPath(rectangle(20, 20, 100, 60), true, { effects: [{ type: 'innerGlow', mode: 'normal', opacity: 1, blur: 8, color: '#003366', source: 'edge' }] });
    doc.transact('Add', () => doc.insert(p, layer.id));
    const svg = exportSVG(doc, { rect: doc.artboards[0] });
    expect(svg).toContain('mode="normal"');
    const m = /<filter[^>]*x="([-\d.]+)"[^>]*width="([\d.]+)"/.exec(svg);
    expect(Number(m[1])).toBeLessThanOrEqual(20 - 24);
    // And it comes back as the same effect.
    const back = svgToDocument(svg).leaves()[0];
    expect(back.effects).toEqual([{ type: 'innerGlow', mode: 'normal', opacity: 1, blur: 8, color: '#003366', source: 'edge' }]);
  });

  it('keeps effects on scaled images and turned type in document units', async () => {
    const { createImage, createText } = await import('../src/model/nodes.js');
    const doc = VDocument.create({ width: 120, height: 120 });
    const layer = doc.layers()[0].id;
    const shadow = { type: 'dropShadow', x: 6, y: 6, blur: 4, color: '#000000', opacity: 0.75 };
    doc.assets.set('a1', { data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', width: 2, height: 2 });
    doc.transact('add', () => {
      doc.insert(createImage('a1', 2, 2, [30, 0, 0, 30, 20, 20], { name: 'Photo', effects: [shadow] }), layer);
      doc.insert(createText('Rot', 0, 0, { transform: [0, 1, -1, 0, 50, 20], effects: [shadow] }), layer);
    });
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 120, h: 120 } });
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    // The filter sits on a group outside the element's transform, so the 6pt offset is not scaled 30x or turned.
    for (const tag of ['image', 'text']) {
      const el = parsed.getElementsByTagName(tag)[0];
      expect(el.getAttribute('filter')).toBeNull();
      const wrap = el.parentNode;
      expect(wrap.localName).toBe('g');
      expect(wrap.getAttribute('transform')).toBeNull();
      const f = parsed.getElementById(wrap.getAttribute('filter').slice(5, -1));
      expect(f.getAttribute('filterUnits')).toBe('userSpaceOnUse');
      expect(f.querySelector('feOffset').getAttribute('dx')).toBe('6');
    }
    expect(parsed.getElementsByTagName('image')[0].getAttribute('id')).toBe('Photo');
    // The filter region covers the shadow (the image spans 20..80).
    const region = parsed.getElementById(parsed.getElementsByTagName('image')[0].parentNode.getAttribute('filter').slice(5, -1));
    expect(Number(region.getAttribute('x')) + Number(region.getAttribute('width'))).toBeGreaterThan(80 + 6);
    // And the effects read back unchanged.
    const back = svgToDocument(svg).leaves();
    expect(back.find((n) => n.type === 'image').effects).toEqual([shadow]);
    expect(back.find((n) => n.type === 'text').effects).toEqual([shadow]);
  });

  it('imports a white mask with a black cut-out as a clipping path with a hole', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <mask id="m"><rect width="100" height="100" fill="#fff"/><circle cx="50" cy="50" r="20" fill="#000"/></mask>
      <rect width="100" height="100" fill="#e60" mask="url(#m)"/>
    </svg>`);
    const clip = doc.get(doc.layers()[0].children[0]);
    expect(clip).toMatchObject({ type: 'group', clip: true });
    const mask = doc.get(clip.children.at(-1));
    expect(mask).toMatchObject({ type: 'compound', fillRule: 'evenodd' });
    expect(mask.children).toHaveLength(2);
    expect(doc.importWarnings).not.toContain('Masks with transparency were ignored.');
  });
});

describe('text export', () => {
  it('writes <text> with a <tspan> per line or outlines per paint', async () => {
    const { createText } = await import('../src/model/nodes.js');
    const { normalizeTextOutlines } = await import('../src/features/io/outlines.js');
    const doc = VDocument.create({ width: 100, height: 100 });
    let t;
    doc.transact('t', () => {
      t = doc.insert(createText('A & B\nSecond', 10, 20, { transform: [1, 0, 0, 1, 5, 0] }), doc.layers()[0].id);
    });
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 100, h: 100 }, cull: false });
    expect(svg).toContain('transform="translate(5 0)"');
    expect(svg).toContain('>A &amp; B</tspan>');
    expect(svg).toContain('>Second</tspan>');
    expect(svg).toMatch(/font-family="Inter, sans-serif"/);
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(parsed.getElementsByTagName('parsererror')).toHaveLength(0);
    const red = { type: 'solid', color: '#ff0000' };
    const glyphs = [
      { index: 0, fill: red, stroke: null, strokeWidth: 0, contours: [{ anchors: rectangle(15, 10, 5, 10), closed: true }] },
      { index: 1, fill: red, stroke: null, strokeWidth: 0, contours: [{ anchors: rectangle(25, 10, 5, 10), closed: true }] },
      { index: 2, fill: null, stroke: red, strokeWidth: 1, contours: [{ anchors: rectangle(35, 10, 5, 10), closed: true }] },
    ];
    const runs = normalizeTextOutlines(glyphs, t);
    expect(runs).toHaveLength(2);
    const out = exportSVG(doc, { rect: { x: 0, y: 0, w: 100, h: 100 }, cull: false, textMode: 'outlines', outlines: new Map([[t.id, runs]]) });
    expect(out).not.toContain('<text');
    expect(out).toContain('<path d="M 15 10 H 20 V 20 H 15 Z M 25 10 H 30 V 20 H 25 Z" fill="#ff0000"');
    expect(out).toContain('fill="none" stroke="#ff0000"');
  });
});

describe('SVG masks with gray levels', () => {
  it('import as opacity masks instead of being dropped', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
      <defs>
        <linearGradient id="fade"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>
        <mask id="m"><rect width="100" height="100" fill="url(#fade)"/></mask>
        <mask id="t"><text x="10" y="50" font-size="30" fill="#fff">Hi</text></mask>
        <mask id="a" style="mask-type:alpha"><rect width="100" height="100" fill="url(#fade)"/></mask>
      </defs>
      <rect width="100" height="100" fill="#ff0000" mask="url(#m)"/>
      <g mask="url(#t)"><rect x="100" width="50" height="50" fill="#00ff00"/><rect x="150" width="50" height="50"/></g>
      <rect y="50" width="10" height="10" fill="#0000ff" mask="url(#a)"/>
    </svg>`);
    const top = doc.layers()[0].children.map((id) => doc.get(id));
    expect(top).toHaveLength(3);
    const [red, pair, blue] = top;
    expect(red.type).toBe('path');
    expect(red.opacityMask).toMatchObject({ clip: true, invert: false, transform: [1, 0, 0, 1, 0, 0] });
    const art = red.opacityMask.art;
    expect(art.nodes[0].id).toBe(art.root);
    expect(art.nodes.find((n) => n.type === 'path').fill.type).toBe('linear');
    // The art lives only in the mask, not in the document tree.
    for (const n of art.nodes) expect(doc.get(n.id)).toBeUndefined();
    // Several masked objects are grouped; type in a mask is kept as type.
    expect(pair.type).toBe('group');
    expect(pair.children).toHaveLength(2);
    expect(pair.opacityMask.art.nodes.some((n) => n.type === 'text')).toBe(true);
    // Alpha masks have no equivalent and are still reported.
    expect(blue.opacityMask).toBeUndefined();
    expect(doc.importWarnings).toContain('Masks with transparency were ignored.');
    expect(doc.importWarnings).not.toContain('Text used as a clipping path was approximated by its bounding box.');
  });

  it('round-trip the export\'s opacity masks with their clip and invert options', async () => {
    const { installOpacityMasks } = await import('../src/features/paint/opacity-mask.js');
    installOpacityMasks();
    const doc = VDocument.create({ width: 200, height: 100 });
    const layer = doc.layers()[0].id;
    const add = (clip, invert, x) => {
      const m = createPath(ellipse(x + 10, 10, 30, 30), true, { fill: { type: 'solid', color: '#808080' }, stroke: null });
      const node = createPath(rectangle(x, 0, 50, 50), true, { fill: { type: 'solid', color: '#ff0000' }, stroke: null }, { opacityMask: { art: { root: m.id, nodes: [m] }, transform: [1, 0, 0, 1, 5, 0], clip, invert } });
      doc.insert(node, layer);
    };
    doc.transact('Masks', () => {
      add(false, false, 0);
      add(true, true, 100);
    });
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 200, h: 100 } });
    const back = svgToDocument(svg);
    const nodes = back.layers()[0].children.map((id) => back.get(id));
    expect(nodes.map((n) => [n.type, n.opacityMask.clip, n.opacityMask.invert])).toEqual([['path', false, false], ['path', true, true]]);
    // The full-size backdrop is not part of the art; the art keeps its place (transform baked in).
    const artPaths = nodes[0].opacityMask.art.nodes.filter((n) => n.type === 'path');
    expect(artPaths).toHaveLength(1);
    expect(pathBounds(artPaths[0].anchors, true).x).toBeCloseTo(15, 3);
    expect(back.importWarnings).toEqual([]);
  });
});

describe('SVG CSS custom properties', () => {
  it('resolve var() references with inheritance, fallbacks and :root values', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" style="--main: #2a9d8f">
      <style>:root { --w: 6px } .a { fill: var(--main); stroke: var(--accent); stroke-width: var(--w) } .b { fill: var(--none, var(--main2, #264653)) } .c { fill: var(--none) }</style>
      <g style="--accent: #e76f51"><rect class="a" width="10" height="10"/></g>
      <rect class="b" width="10" height="10"/>
      <g fill="#ff0000"><rect class="c" width="10" height="10"/></g>
      <rect class="a" style="--main: #000080" width="10" height="10"/>
    </svg>`);
    const [a, b, c, d] = doc.leaves();
    expect(a.fill.color).toBe('#2a9d8f');
    expect(a.stroke.color).toBe('#e76f51');
    expect(a.strokeWidth).toBe(6);
    expect(b.fill.color).toBe('#264653');
    // An undefined variable without a fallback leaves the property unset (fill inherits).
    expect(c.fill.color).toBe('#ff0000');
    expect(d.fill.color).toBe('#000080');
    expect(d.stroke).toBeNull();
  });
});

describe('SVG transform-box', () => {
  it('rotates about the shape\'s own box with transform-box: fill-box', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
      <style>.d { transform: rotate(90deg); transform-origin: center; transform-box: fill-box } .e { transform: scale(2); transform-box: fill-box }</style>
      <rect class="d" x="100" y="100" width="40" height="20"/>
      <rect class="e" x="10" y="10" width="10" height="10"/>
      <rect style="transform: rotate(90deg); transform-origin: center" x="100" y="100" width="40" height="20"/>
    </svg>`);
    const [d, e, v] = doc.leaves().map((n) => nodeBounds(doc, n));
    // About its own center (120, 110).
    for (const [k, want] of Object.entries({ x: 110, y: 90, w: 20, h: 40 })) close(d[k], want, 1e-6);
    // The default origin is the box's top-left corner.
    for (const [k, want] of Object.entries({ x: 10, y: 10, w: 20, h: 20 })) close(e[k], want, 1e-6);
    // Without it, the origin is the viewport's center (100, 100).
    for (const [k, want] of Object.entries({ x: 80, y: 100, w: 20, h: 40 })) close(v[k], want, 1e-6);
  });
});

describe('SVG switch', () => {
  it('skips branches for languages the user does not read', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <switch><rect systemLanguage="xx-YY" width="10" height="10" fill="#ff0000"/><rect systemLanguage="" width="10" height="10" fill="#0000ff"/><rect width="10" height="10" fill="#00ff00"/></switch>
      <switch><rect systemLanguage="xx, ${navigator.language.split('-')[0]}" width="10" height="10" fill="#00ff00"/><rect width="10" height="10" fill="#ff0000"/></switch>
    </svg>`);
    expect(doc.leaves().map((n) => n.fill.color)).toEqual(['#00ff00', '#00ff00']);
  });
});

describe('SVG text positions in em', () => {
  it('measure em against the element\'s font size', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">
      <text x="10" y="110" font-size="20"><tspan x="10" dy="0">Line one</tspan><tspan x="10" dy="1.2em">Line two</tspan><tspan x="10" dy="1.2em">Line three</tspan></text>
      <text x="10" y="200" font-size="10"><tspan font-size="30" dx="1em">wide</tspan></text>
    </svg>`);
    const [lines, wide] = doc.leaves();
    expect(lines.text).toBe('Line one\nLine two\nLine three');
    expect(lines.char.leading).toBe(24);
    expect(wide.x).toBe(40);
  });
});

describe('SVG text on a path', () => {
  it('imports as type on a path with its offset, anchor and side', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="300" height="300">
      <defs><path id="line" d="M0 0 H200" transform="translate(50 100)"/></defs>
      <text font-size="20"><textPath xlink:href="#line" startOffset="50%" text-anchor="middle">Mid</textPath></text>
      <text font-size="20"><textPath href="#line" startOffset="30" side="right">Two <tspan fill="#ff0000">runs</tspan></textPath></text>
      <text font-size="20"><textPath path="M0 200 L100 200" text-anchor="end" startOffset="100%">End</textPath></text>
      <text font-size="20"><textPath href="#missing">Lost</textPath></text>
    </svg>`);
    const [mid, two, end, lost] = doc.leaves();
    expect(mid).toMatchObject({ kind: 'path', text: 'Mid', pathClosed: false, pathOptions: { start: 0, align: 'baseline' }, para: { align: 'center' } });
    // The target's transform is part of the path.
    expect(mid.pathAnchors.map((a) => [a.x, a.y])).toEqual([[50, 100], [250, 100]]);
    expect(two).toMatchObject({ kind: 'path', text: 'Two runs', pathOptions: { start: 30, flip: true }, para: { align: 'left' } });
    expect(two.runs.some((r) => r.fill?.color === '#ff0000')).toBe(true);
    expect(end).toMatchObject({ kind: 'path', pathOptions: { start: 0 }, para: { align: 'right' } });
    expect(lost.kind).toBe('point');
    expect(doc.importWarnings).toEqual(['Text on a path was imported as straight text.']);
  });
});

describe('SVG layers round trip', () => {
  it('export marks layers and import restores them, names and order included', () => {
    const doc = VDocument.create({ width: 100, height: 100 });
    const [first] = doc.layers();
    doc.transact('layers', () => {
      doc.update(first.id, { name: 'Back ground' });
      const top = { ...doc.layers()[0], id: 'L2', name: 'Ink', children: [] };
      doc.insert(top, 'root');
      doc.insert(createPath(rectangle(0, 0, 10, 10), true, { fill: { type: 'solid', color: '#ff0000' }, stroke: null }), first.id);
      doc.insert(createPath(rectangle(5, 5, 10, 10), true, { fill: { type: 'solid', color: '#0000ff' }, stroke: null }), 'L2');
    });
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 100, h: 100 } });
    expect(svg.match(/data-layer=""/g)).toHaveLength(2);
    const back = svgToDocument(svg);
    const layers = back.layers();
    expect(layers.map((l) => l.name)).toEqual(['Back ground', 'Ink']);
    expect(layers.map((l) => l.children.map((id) => back.get(id).type))).toEqual([['path'], ['path']]);
    // A second round trip is stable (no extra group per trip).
    expect(exportSVG(back, { rect: { x: 0, y: 0, w: 100, h: 100 } })).toBe(svg);
    // Placed, each layer becomes a named group.
    const placed = svgToNodes(svg);
    const root = placed.nodes.find((n) => n.id === placed.root);
    expect(root.children.map((id) => placed.nodes.find((n) => n.id === id).name)).toEqual(['Back ground', 'Ink']);
    // Minified output for the web stays free of the marker.
    expect(exportSVG(doc, { rect: { x: 0, y: 0, w: 100, h: 100 }, minify: true })).not.toContain('data-layer');
  });
});

describe('SVG type on a path export', () => {
  const pathDoc = (opts = {}, char = {}) => {
    const doc = VDocument.create({ width: 200, height: 200 });
    const arc = [{ x: 20, y: 150, ix: 20, iy: 150, ox: 20, oy: 50 }, { x: 180, y: 150, ix: 180, iy: 50, ox: 180, oy: 150 }];
    doc.transact('t', () => {
      const t = createText('On the arc', 20, 150, { kind: 'path', pathAnchors: arc, pathClosed: false, pathOptions: { effect: 'rainbow', align: 'baseline', start: 12 }, ...opts });
      doc.insert({ ...t, char: { ...t.char, fontSize: 16, ...char } }, doc.layers()[0].id);
    });
    return doc;
  };

  it('writes <textPath>, which opens again as the same type on a path', () => {
    for (const align of ['left', 'center', 'right']) {
      const doc = pathDoc();
      const id = doc.layers()[0].children[0];
      doc.transact('a', () => doc.update(id, { para: { ...doc.get(id).para, align } }));
      const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 200, h: 200 } });
      expect(svg).toMatch(/<defs>[\s\S]*<path id="tp1" d="M 20 150 C /);
      expect(svg).toContain('<textPath xlink:href="#tp1"');
      const back = svgToDocument(svg).leaves()[0];
      expect(back).toMatchObject({ kind: 'path', text: 'On the arc', para: { align } });
      expect(back.pathOptions.start).toBeCloseTo(align === 'right' ? 0 : 12, 2);
    }
  });

  it('keeps writing glyph by glyph what a textPath cannot follow', () => {
    for (const doc of [pathDoc({}, { tracking: 200 }), pathDoc({ pathOptions: { effect: 'skew', start: 0 } })]) {
      const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 200, h: 200 } });
      expect(svg).not.toContain('textPath');
      expect(svg.match(/<text /g).length).toBeGreaterThan(5);
    }
  });
});

describe('SVG vertical writing', () => {
  it('imports writing-mode columns as vertical type', () => {
    const doc = svgToDocument(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
      <text x="40" y="20" font-size="20" writing-mode="tb">VERTICAL</text>
      <g style="writing-mode: vertical-rl"><text x="120" y="20" font-size="20" style="text-orientation: upright">縦書きABC</text></g>
      <text x="10" y="190" font-size="20">Across</text>
    </svg>`);
    const [tb, upright, across] = doc.leaves();
    expect(tb).toMatchObject({ vertical: true, x: 40, y: 20, text: 'VERTICAL', char: { verticalRoman: true } });
    expect(upright).toMatchObject({ vertical: true, char: { verticalRoman: false } });
    expect(across.vertical).toBeFalsy();
  });
});

describe('SVG with absurd sizes', () => {
  it('never makes an artboard the canvas cannot show', () => {
    const sized = svgToDocument('<svg xmlns="http://www.w3.org/2000/svg" width="1e30" height="1e30" viewBox="0 0 100 50"><rect width="50" height="50"/></svg>');
    expect(sized.artboards[0]).toMatchObject({ x: 0, y: 0, w: 100, h: 50 });
    expect(nodeBounds(sized, sized.leaves()[0]).w).toBe(50);
    expect(sized.importWarnings).toContain("The drawing's size was too large and was ignored.");
    const unsized = svgToDocument('<svg xmlns="http://www.w3.org/2000/svg"><rect x="-1e25" width="1e30" height="1e30"/></svg>');
    const a = unsized.artboards[0];
    expect(Math.max(Math.abs(a.x), Math.abs(a.y), a.w, a.h)).toBeLessThanOrEqual(1e6);
    // Large but real drawings keep their size.
    expect(svgToDocument('<svg xmlns="http://www.w3.org/2000/svg" width="50000" height="20000"/>').artboards[0]).toMatchObject({ w: 50000, h: 20000 });
  });
});
