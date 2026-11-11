import { describe, it, expect } from 'vitest';
import { compileFilter, renderFilter, filtersFromSvg, filterRegion, filterOutset, parseColor } from '../src/features/pxfx/svg-filter-render.js';
import { BUILTIN_FILTERS, allFilters, importFilters } from '../src/features/pxfx/svg-filters.js';
import { filterDefMarkup } from '../src/features/pxfx/svg-export.js';
import { createImg } from '../src/features/pxfx/img.js';
import { VDocument } from '../src/model/document.js';

const NS = 'xmlns="http://www.w3.org/2000/svg"';

/** A 40 x 40 image with an opaque 20 x 20 square of `color` in the middle. */
function square(color = [1, 0, 0]) {
  const img = createImg(40, 40);
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      const i = y * 40 + x;
      [img.r[i], img.g[i], img.b[i]] = color;
      img.a[i] = x >= 10 && x < 30 && y >= 10 && y < 30 ? 1 : 0;
    }
  }
  return img;
}
const ctx = { k: 1, ox: 0, oy: 0, seed: 0, docBounds: { x: 10, y: 10, w: 20, h: 20 } };
const run = (body, attrs = 'x="-50%" y="-50%" width="200%" height="200%"', img = square()) => renderFilter(img, compileFilter(`<filter ${NS} ${attrs}>${body}</filter>`), ctx);
const at = (img, x, y) => {
  const i = y * img.w + x;
  return [img.r[i], img.g[i], img.b[i], img.a[i]].map((v) => Math.round(v * 1000) / 1000);
};

describe('SVG filter parsing', () => {
  it('compiles primitives with their attributes and children', () => {
    const f = compileFilter(`<filter ${NS} id="a" x="0" width="1"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge><desc>x</desc></filter>`);
    expect(f.prims.map((p) => p.type)).toEqual(['feGaussianBlur', 'feMerge']);
    expect(f.prims[0].attrs).toMatchObject({ stdDeviation: '2', result: 'b' });
    expect(f.prims[1].children.map((c) => c.attrs.in)).toEqual(['b', 'SourceGraphic']);
    expect(compileFilter('<not-xml')).toBeNull();
    expect(compileFilter(`<svg ${NS}><rect/></svg>`)).toBeNull();
  });

  it('finds the filters of an SVG file', () => {
    const text = `<svg ${NS} xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"><defs>
      <filter id="glow" inkscape:label="My Glow"><feGaussianBlur stdDeviation="3"/></filter>
      <filter id="empty"></filter>
      <filter id="tint"><title>Tint</title><feColorMatrix type="saturate" values="0"/></filter>
    </defs></svg>`;
    const found = filtersFromSvg(text);
    expect(found.map((f) => [f.id, f.name])).toEqual([['glow', 'My Glow'], ['tint', 'Tint']]);
    expect(compileFilter(found[0].markup).prims).toHaveLength(1);
    expect(filtersFromSvg('not svg')).toEqual([]);
  });

  it('computes the filter region and how far it reaches', () => {
    const b = { x: 0, y: 0, w: 100, h: 50 };
    expect(filterRegion(compileFilter(`<filter ${NS}><feFlood/></filter>`), b)).toEqual({ x: -10, y: -5, w: 120, h: 60 });
    expect(filterRegion(compileFilter(`<filter ${NS} x="-25%" y="0" width="1.5" height="1"><feFlood/></filter>`), b)).toEqual({ x: -25, y: 0, w: 150, h: 50 });
    expect(filterRegion(compileFilter(`<filter ${NS} filterUnits="userSpaceOnUse" x="1" y="2" width="3" height="4"><feFlood/></filter>`), b)).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(filterOutset(compileFilter(`<filter ${NS}><feFlood/></filter>`), b)).toBe(10);
    expect(parseColor('#abc')).toEqual([0xaa / 255, 0xbb / 255, 0xcc / 255, 1]);
    expect(parseColor('rgba(255, 0, 0, 0.5)')).toEqual([1, 0, 0, 0.5]);
  });
});

describe('SVG filter primitives', () => {
  it('flood fills the filter region (clipped to it)', () => {
    const out = run('<feFlood flood-color="#00ff00" flood-opacity="0.5"/>', 'x="0" y="0" width="1" height="1"');
    expect(at(out, 20, 20)).toEqual([0, 1, 0, 0.5]);
    expect(at(out, 5, 5)[3]).toBe(0);
  });

  it('offsets, merges and composites', () => {
    const off = run('<feOffset dx="5" dy="0"/>');
    expect(at(off, 12, 20)[3]).toBe(0);
    expect(at(off, 33, 20)[3]).toBe(1);
    const inside = run('<feFlood flood-color="#0000ff"/><feComposite in2="SourceAlpha" operator="in"/>');
    expect(at(inside, 20, 20)).toEqual([0, 0, 1, 1]);
    expect(at(inside, 5, 20)[3]).toBe(0);
    const outside = run('<feFlood flood-color="#0000ff"/><feComposite in2="SourceAlpha" operator="out"/>');
    expect(at(outside, 20, 20)[3]).toBe(0);
    expect(at(outside, 5, 20)[3]).toBe(1);
    const merged = run('<feOffset dx="4" dy="4" result="o"/><feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge>');
    expect(at(merged, 32, 32)[3]).toBe(1);
    expect(at(merged, 11, 11)[3]).toBe(1);
    const arith = run('<feFlood flood-color="#ffffff" result="w"/><feComposite in="SourceGraphic" in2="w" operator="arithmetic" k2="0.5" k3="0.5"/>', 'x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB"');
    expect(at(arith, 20, 20)).toEqual([1, 0.5, 0.5, 1]);
  });

  it('blurs evenly and only along the given axis', () => {
    const out = run('<feGaussianBlur stdDeviation="3"/>');
    expect(at(out, 8, 20)[3]).toBeGreaterThan(0.05);
    expect(at(out, 8, 20)[3]).toBeCloseTo(at(out, 31, 20)[3], 2);
    expect(at(out, 20, 20)[3]).toBeGreaterThan(0.95);
    const xOnly = run('<feGaussianBlur stdDeviation="3 0"/>');
    expect(at(xOnly, 8, 20)[3]).toBeGreaterThan(0.05);
    expect(at(xOnly, 20, 8)[3]).toBe(0);
  });

  it('transforms colors in the requested color space', () => {
    const gray = run('<feColorMatrix type="saturate" values="0"/>', 'color-interpolation-filters="sRGB"');
    const [r, g, b] = at(gray, 20, 20);
    expect(r).toBeCloseTo(0.213, 2);
    expect(g).toBeCloseTo(r, 3);
    expect(b).toBeCloseTo(r, 3);
    // In linear light (the default), the same matrix gives a lighter sRGB gray.
    const lin = run('<feColorMatrix type="saturate" values="0"/>');
    expect(at(lin, 20, 20)[0]).toBeGreaterThan(0.45);
    const inv = run('<feComponentTransfer><feFuncR type="table" tableValues="1 0"/><feFuncG type="linear" slope="0" intercept="0.25"/></feComponentTransfer>', 'color-interpolation-filters="sRGB"');
    expect(at(inv, 20, 20)).toEqual([0, 0.25, 0, 1]);
    const l2a = run('<feColorMatrix type="luminanceToAlpha"/>', 'color-interpolation-filters="sRGB"');
    expect(at(l2a, 20, 20)[3]).toBeCloseTo(0.2125, 2);
  });

  it('grows and shrinks shapes', () => {
    const dil = run('<feMorphology operator="dilate" radius="3"/>');
    expect(at(dil, 8, 20)[3]).toBe(1);
    expect(at(dil, 6, 20)[3]).toBe(0);
    const ero = run('<feMorphology operator="erode" radius="3"/>');
    expect(at(ero, 11, 20)[3]).toBe(0);
    expect(at(ero, 14, 20)[3]).toBe(1);
  });

  it('makes deterministic turbulence and displaces by it', () => {
    const a = run('<feTurbulence type="fractalNoise" baseFrequency="0.1" numOctaves="2" seed="3"/>');
    const b = run('<feTurbulence type="fractalNoise" baseFrequency="0.1" numOctaves="2" seed="3"/>');
    const c = run('<feTurbulence type="fractalNoise" baseFrequency="0.1" numOctaves="2" seed="4"/>');
    expect(a.r).toEqual(b.r);
    expect(a.r).not.toEqual(c.r);
    const vals = [...a.a].filter((v, i) => i % 40 > 2);
    expect(Math.min(...vals)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...vals)).toBeLessThanOrEqual(1);
    const shifted = run('<feFlood flood-color="#ffffff" result="m"/><feDisplacementMap in="SourceGraphic" in2="m" scale="10" xChannelSelector="R" yChannelSelector="G"/>');
    // A white map moves every sample by scale * (1 - 0.5) = 5 px.
    expect(at(shifted, 6, 6)[3]).toBe(1);
    expect(at(shifted, 27, 27)[3]).toBe(0);
  });

  it('lights a surface and convolves', () => {
    const lit = run('<feGaussianBlur in="SourceAlpha" stdDeviation="2"/><feDiffuseLighting surfaceScale="5" lighting-color="#ffffff"><feDistantLight azimuth="0" elevation="90"/></feDiffuseLighting>');
    expect(at(lit, 20, 20)[0]).toBeCloseTo(1, 2);
    expect(at(lit, 10, 20)[0]).toBeLessThan(0.9);
    const spec = run('<feSpecularLighting surfaceScale="1" specularExponent="10"><feDistantLight azimuth="0" elevation="90"/></feSpecularLighting>');
    expect(at(spec, 20, 20)[3]).toBeCloseTo(1, 2);
    const conv = run('<feConvolveMatrix order="3" kernelMatrix="0 0 0 0 0 1 0 0 0" divisor="1"/>');
    // The kernel is flipped (as convolution is): it picks the pixel to the left.
    expect(at(conv, 30, 20)[3]).toBe(1);
    expect(at(conv, 10, 20)[3]).toBe(0);
  });

  it('renders every built-in filter', () => {
    const ids = new Set();
    for (const f of BUILTIN_FILTERS) {
      ids.add(f.id);
      const c = compileFilter(f.markup);
      expect(c?.prims.length, f.name).toBeGreaterThan(0);
      const out = renderFilter(square([0.2, 0.5, 0.9]), c, ctx);
      for (const ch of ['r', 'g', 'b', 'a']) for (const v of out[ch]) expect(Number.isFinite(v) && v >= 0 && v <= 1, f.name).toBe(true);
      expect(out.a.some((v) => v > 0), f.name).toBe(true);
    }
    expect(ids.size).toBe(BUILTIN_FILTERS.length);
    expect(BUILTIN_FILTERS.length).toBeGreaterThanOrEqual(20);
  });
});

describe('document filters', () => {
  const file = `<svg ${NS}><filter id="a"><feGaussianBlur stdDeviation="1"/></filter><filter id="b"><feOffset dx="2"/></filter></svg>`;

  it('imports filters into the document once, with unique names, undoably', () => {
    const doc = VDocument.create({ width: 100, height: 100 });
    let added;
    doc.transact('Import', () => {
      added = importFilters(doc, file);
    });
    expect(added.map((f) => f.name)).toEqual(['a', 'b']);
    expect(doc.root.svgFilters).toHaveLength(2);
    doc.transact('Again', () => {
      expect(importFilters(doc, file)).toEqual([]);
    });
    doc.transact('Renamed copy', () => {
      importFilters(doc, file.replace('stdDeviation="1"', 'stdDeviation="2"'));
    });
    expect(doc.root.svgFilters.map((f) => f.name)).toEqual(['a', 'b', 'a 2']);
    expect(allFilters(doc).slice(-3).map((f) => f.name)).toEqual(['a', 'b', 'a 2']);
    expect(allFilters(doc)[0].builtin).toBe(true);
    // The import that added nothing left no undo step.
    doc.undo();
    expect(doc.root.svgFilters).toHaveLength(2);
    doc.undo();
    expect(doc.root.svgFilters || []).toHaveLength(0);
  });

  it('writes a filter definition with a new id in export coordinates', () => {
    const src = `<filter xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" id="old" inkscape:label="x" filterUnits="userSpaceOnUse" x="10" y="20" width="50" height="60"><feDiffuseLighting><fePointLight x="30" y="40" z="10"/></feDiffuseLighting></filter>`;
    const out = filterDefMarkup(src, 'f9', 10, 5);
    expect(out).toMatch(/^<filter /);
    expect(out).toContain('id="f9"');
    expect(out).not.toContain('old');
    expect(out).not.toContain('inkscape');
    expect(out).not.toContain('xmlns');
    expect(out).toContain('x="0"');
    expect(out).toContain('y="15"');
    expect(out).toMatch(/<fePointLight x="20" y="35" z="10"\/>/);
  });

  it('writes only filter primitives into exports: no scripts, event handlers or script links', () => {
    const src = `<filter xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" id="a" onload="alert(1)"><script>alert(2)</script><foreignObject><div>x</div></foreignObject><feGaussianBlur stdDeviation="2" onclick="alert(3)"/><feImage xlink:href="javascript:alert(4)"/><feImage href="#shape" result="s"/><feComponentTransfer><feFuncA type="linear" slope="0.5"/></feComponentTransfer><a href="javascript:alert(5)"><feFlood/></a></filter>`;
    const out = filterDefMarkup(src, 'f1');
    expect(out).not.toMatch(/alert|script|onload|onclick|foreignObject|<a[\s>]/i);
    expect(out).toContain('<feGaussianBlur stdDeviation="2"/>');
    expect(out).toContain('href="#shape"');
    expect(out).toContain('<feFuncA type="linear" slope="0.5"/>');
  });
});
