import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildShape, shapeDrawingXml, EMU_PER_INCH } from '../src/engine/authored-shapes.js';
import { readShapeGeometry } from '../src/engine/docx-shapes.js';
import { PRESET_GEOMETRIES, PRESET_CATEGORIES } from '../src/engine/preset-geometries.js';
import { MORE_PRESET_GEOMETRIES, appendArc } from '../src/engine/preset-geometries-more.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const ALL = Object.values(PRESET_CATEGORIES).flat();
const CALLOUTS = new Set(PRESET_CATEGORIES.callouts);
const SPECIAL = ['star5', 'round2SameRect', 'donut', 'octagon', 'plaque', 'roundRect', 'hexagon', 'downArrow', 'triangle', 'rtTriangle', 'homePlate', 'chevron', 'frame', 'halfFrame', 'ribbon2', 'cloud', 'cloudCallout', 'rect', 'ellipse', 'line', 'straightConnector1', 'flowChartOffpageConnector'];
const defaults = name => key => PRESET_GEOMETRIES[name].defaults[key];
const build = (name, w, h, adj = defaults(name)) => PRESET_GEOMETRIES[name].build(w, h, adj);
const pathsOf = (geometry, w, h) => geometry.paths ? geometry.paths.map(p => ({ width: w, height: h, fill: true, stroke: true, ...p })) : [{ width: w, height: h, points: geometry.points, fill: true, stroke: true }];
const vertices = points => points.filter(p => p[0] !== 'Z');

/** Points on the drawn outline in shape units: segment ends plus sampled curves, scaled from each path's grid. */
function outlinePoints(path, w, h) {
  const sx = path.width ? w / path.width : 1, sy = path.height ? h / path.height : 1, out = [];
  let x = 0, y = 0;
  for (const [op, ...v] of path.points) {
    if (op === 'C' || op === 'Q') {
      const pts = [[x, y], ...Array.from({ length: v.length / 2 }, (_, i) => [v[2 * i], v[2 * i + 1]])];
      for (let s = 1; s <= 8; s++) {
        const t = s / 8;
        let level = pts;
        while (level.length > 1) level = level.slice(1).map((p, i) => [level[i][0] + (p[0] - level[i][0]) * t, level[i][1] + (p[1] - level[i][1]) * t]);
        out.push([level[0][0] * sx, level[0][1] * sy]);
      }
    }
    if (op !== 'Z') { x = v[v.length - 2]; y = v[v.length - 1]; if (op === 'M' || op === 'L') out.push([x * sx, y * sy]); }
  }
  return out;
}

describe('more ECMA-376 preset geometries', () => {
  it('adds every listed preset once, without shadowing special cases or existing presets', () => {
    expect(new Set(ALL).size).toBe(ALL.length);
    expect(Object.keys(MORE_PRESET_GEOMETRIES).sort()).toEqual([...ALL].sort());
    for (const name of SPECIAL) expect(ALL, name).not.toContain(name);
    for (const name of ['diamond', 'parallelogram', 'trapezoid', 'pentagon', 'plus', 'rightArrow', 'leftArrow', 'upArrow', 'leftRightArrow', 'star4']) {
      expect(ALL).not.toContain(name);
      expect(PRESET_GEOMETRIES[name]).toBeDefined();
    }
  });

  for (const [w, h] of [[2 * EMU_PER_INCH, EMU_PER_INCH], [EMU_PER_INCH, EMU_PER_INCH], [EMU_PER_INCH / 2, 1.5 * EMU_PER_INCH]]) {
    it(`builds finite outlines inside a ${w / EMU_PER_INCH} × ${h / EMU_PER_INCH} in frame with a text box inside it`, () => {
      for (const name of ALL) {
        const geometry = build(name, w, h), paths = pathsOf(geometry, w, h);
        expect(paths.length, name).toBeGreaterThan(0);
        for (const path of paths) {
          expect(path.points.length, name).toBeGreaterThan(1);
          expect(path.points[0][0], name).toBe('M');
          for (const [op, ...v] of path.points) {
            expect(['M', 'L', 'C', 'Q', 'Z'], name).toContain(op);
            expect(v.length, `${name} ${op}`).toBe({ M: 2, L: 2, C: 6, Q: 4, Z: 0 }[op]);
            for (const n of v) expect(Number.isFinite(n), name).toBe(true);
          }
          // Callout tails reach outside the frame; mathNotEqual's slash keeps its angle, so it overhangs narrow frames.
          if (CALLOUTS.has(name) || name === 'mathNotEqual' && w < h) continue;
          // Outlines stay in the frame, up to a hair of curve overshoot.
          const margin = .01;
          for (const [x, y] of outlinePoints(path, w, h)) {
            expect(x, name).toBeGreaterThanOrEqual(-margin * w); expect(x, name).toBeLessThanOrEqual((1 + margin) * w);
            expect(y, name).toBeGreaterThanOrEqual(-margin * h); expect(y, name).toBeLessThanOrEqual((1 + margin) * h);
          }
        }
        // The standard's rounded trigonometric constants can overshoot by a few EMU.
        const [l, t, r, b] = geometry.text, eps = 1e-5 * Math.max(w, h);
        for (const n of geometry.text) expect(Number.isFinite(n), name).toBe(true);
        expect(l, name).toBeGreaterThanOrEqual(-eps); expect(t, name).toBeGreaterThanOrEqual(-eps);
        expect(r, name).toBeLessThanOrEqual(w + eps); expect(b, name).toBeLessThanOrEqual(h + eps);
        expect(r - l, name).toBeGreaterThan(0); expect(b - t, name).toBeGreaterThan(0);
      }
    });
  }

  it('reads every preset back from a wps:wsp drawing into painted paths', () => {
    for (const name of ALL) {
      for (const [w, h] of [[2, 1], [1, 1]]) {
        const { asset } = buildShape({ id: 1, name, preset: name, width: w * EMU_PER_INCH, height: h * EMU_PER_INCH, fill: 'ABCDEF', line: '123456', lineWidth: 12700, assetId: 'drawing:t' });
        const { paths, textRect } = asset.scene;
        expect(paths.length, name).toBeGreaterThan(0);
        expect(paths.some(p => p.points.length > 1 && p.fill), name).toBe(true);
        expect(paths.some(p => p.points.length > 1 && p.stroke), name).toBe(true);
        for (const p of paths) expect(p.width > 0 && p.height > 0, name).toBe(true);
        if (textRect) for (const v of Object.values(textRect)) expect(v, name).toBeGreaterThanOrEqual(-1e-9);
      }
    }
  });

  it('carries stroke-only details, fill modes and fixed path grids into the scene', () => {
    const shape = preset => buildShape({ id: 1, name: preset, preset, width: EMU_PER_INCH, height: EMU_PER_INCH, fill: 'ABCDEF', line: '123456', lineWidth: 12700, assetId: 'd' }).asset.scene.paths;
    const callout = shape('borderCallout1');
    expect(callout.map(p => [p.fill, p.stroke])).toEqual([[true, true], [false, true]]);
    expect(shape('callout1').map(p => [p.fill, p.stroke])).toEqual([[true, false], [false, true]]);
    expect(shape('cube').map(p => p.fillMode)).toEqual([undefined, 'darkenLess', 'lightenLess', undefined]);
    const document = shape('flowChartDocument')[0];
    expect([document.width, document.height]).toEqual([21600, 21600]);
    expect(shape('flowChartPredefinedProcess').map(p => [p.fill, p.stroke])).toEqual([[true, false], [false, true], [false, true]]);
  });

  it('honours adjustments written in the drawing and rejects unknown ones', () => {
    const width = EMU_PER_INCH, height = EMU_PER_INCH;
    const read = (preset, avLst) => {
      const xml = shapeDrawingXml({ id: 1, name: preset, preset, width, height, fill: 'ABCDEF', line: null, lineWidth: 0 }).replace('<a:avLst/>', `<a:avLst>${avLst}</a:avLst>`);
      const spPr = new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagNameNS('http://schemas.microsoft.com/office/word/2010/wordprocessingShape', 'spPr')[0];
      return readShapeGeometry(spPr, { width, height });
    };
    expect(read('snip1Rect', '').paths[0].points[1]).toEqual(['L', width * (1 - .16667), 0]);
    const adjusted = read('snip1Rect', '<a:gd name="adj" fmla="val 40000"/>');
    expect(adjusted.paths[0].points[1]).toEqual(['L', width * .6, 0]);
    expect(adjusted.textRect.top).toBeCloseTo(.2, 6);
    // Pins clamp out-of-range values; adjustments the preset does not define are refused.
    expect(read('snip1Rect', '<a:gd name="adj" fmla="val 900000"/>').paths[0].points[1]).toEqual(['L', width / 2, 0]);
    expect(() => read('snip1Rect', '<a:gd name="adj9" fmla="val 1"/>')).toThrow(/snip1Rect adjustment/);
    // Angle adjustments are in 60000ths of a degree: a 0°–180° pie is the lower half.
    const pie = read('pie', '<a:gd name="adj1" fmla="val 0"/><a:gd name="adj2" fmla="val 10800000"/>').paths[0].points;
    expect(pie.at(-3).slice(-2).map(v => +v.toFixed(3))).toEqual([0, height / 2]);
  });
});

describe('spot checks of exact geometry', () => {
  const close = (a, b) => { expect(a.length).toBe(b.length); a.forEach((p, i) => { expect(p[0]).toBe(b[i][0]); p.slice(1).forEach((v, j) => expect(v).toBeCloseTo(b[i][j + 1], 6)); }); };

  it('flowChartDecision is a diamond on its two-unit grid', () => {
    const { paths, text } = build('flowChartDecision', 200, 100);
    close(paths[0].points, [['M', 0, 1], ['L', 1, 0], ['L', 2, 1], ['L', 1, 2], ['Z']]);
    expect([paths[0].width, paths[0].height]).toEqual([2, 2]);
    expect(text).toEqual([50, 25, 150, 75]);
  });

  it('mathMinus is a centred bar of the default height and 73.49% width', () => {
    const { points, text } = build('mathMinus', 1000, 1000);
    const bar = .2352 * 1000 / 2, half = 734.9 / 2;
    close(points, [['M', 500 - half, 500 - bar], ['L', 500 + half, 500 - bar], ['L', 500 + half, 500 + bar], ['L', 500 - half, 500 + bar], ['Z']]);
    expect(text[3] - text[1]).toBeCloseTo(235.2, 6);
  });

  it('stars have 2n vertices alternating between the outer and inner ellipses', () => {
    for (const [name, n] of [['star6', 6], ['star7', 7], ['star8', 8], ['star10', 10], ['star12', 12], ['star16', 16], ['star24', 24], ['star32', 32]]) {
      const { points } = build(name, 100, 100);
      expect(vertices(points), name).toHaveLength(2 * n);
      expect(points[0][1], name).toBeCloseTo(50, 6);
      expect(Math.min(...vertices(points).map(p => p[2])), name).toBeCloseTo(0, 6);
    }
    // star6's hf stretch puts its side points exactly on the frame's left and right edges.
    const star6 = vertices(build('star6', 100, 100).points);
    expect(Math.min(...star6.map(p => p[1]))).toBeCloseTo(0, 3);
    expect(Math.max(...star6.map(p => p[1]))).toBeCloseTo(100, 3);
  });

  it('snip and round rectangles follow the shorter side', () => {
    close(build('snip2SameRect', 200, 100).points, [['M', 16.667, 0], ['L', 183.333, 0], ['L', 200, 16.667], ['L', 200, 100], ['L', 200, 100], ['L', 0, 100], ['L', 0, 100], ['L', 0, 16.667], ['Z']]);
    const round = build('round1Rect', 200, 100).points;
    expect(round[1]).toEqual(['L', 200 - 16.667, 0]);
    expect(round.at(-4)).toEqual(expect.arrayContaining(['C']));
    expect(round[round.length - 4].slice(-2).map(v => +v.toFixed(6))).toEqual([200, 16.667]);
  });

  it('mathEqual, mathPlus and mathMultiply are symmetric about the centre', () => {
    for (const name of ['mathEqual', 'mathPlus', 'mathMultiply', 'mathDivide', 'mathNotEqual']) {
      const pts = vertices(build(name, 300, 200).points);
      const xs = pts.flatMap(p => p.slice(1).filter((_, i) => i % 2 === 0)), ys = pts.flatMap(p => p.slice(1).filter((_, i) => i % 2 === 1));
      expect(Math.min(...xs) + Math.max(...xs), name).toBeCloseTo(300, 6);
      expect(Math.min(...ys) + Math.max(...ys), name).toBeCloseTo(200, 6);
    }
  });

  it('blockArc defaults to the upper half ring; pie is three quarters of the ellipse', () => {
    const arc = build('blockArc', 100, 100);
    expect(arc.points[0].slice(1).map(v => +v.toFixed(6))).toEqual([0, 50]);
    expect(arc.text.map(v => +v.toFixed(6))).toEqual([0, 0, 100, 50]);
    const pie = vertices(build('pie', 100, 100).points);
    expect(pie[0].slice(1).map(v => +v.toFixed(6))).toEqual([100, 50]);
    expect(pie.at(-1)).toEqual(['L', 50, 50]);
    expect(pie.at(-2).slice(-2).map(v => +v.toFixed(6))).toEqual([50, 0]);
  });

  it('wedge callouts point their tail at the adjusted tip, below and left by default', () => {
    const tip = [100 - 200 * .20833, 50 + 100 * .625];
    const rect = vertices(build('wedgeRectCallout', 200, 100).points);
    expect(rect.filter(p => Math.abs(p[1] - tip[0]) < 1e-6 && Math.abs(p[2] - tip[1]) < 1e-6)).toHaveLength(1);
    expect(build('wedgeEllipseCallout', 200, 100).points[0].slice(1).map(v => +v.toFixed(6))).toEqual(tip.map(v => +v.toFixed(6)));
  });

  it('ribbon is ribbon2 reflected top to bottom; verticalScroll is horizontalScroll transposed', () => {
    const ribbon = build('ribbon', 200, 100);
    expect(ribbon.text[3]).toBe(100);
    expect(ribbon.paths[0].points[0]).toEqual(['M', 0, 0]);
    const h = build('horizontalScroll', 100, 200), v = build('verticalScroll', 200, 100);
    expect(v.paths[0].points[0]).toEqual(['M', h.paths[0].points[0][2], h.paths[0].points[0][1]]);
    expect(v.text).toEqual([h.text[1], h.text[0], h.text[3], h.text[2]]);
  });

  it('arcs become cubic segments of at most 45° that land on the ellipse', () => {
    const points = [];
    const end = appendArc(points, 100, 50, 100, 50, 0, 90);
    expect(points).toHaveLength(2);
    expect(end.map(v => +v.toFixed(9))).toEqual([0, 100]);
    const full = [];
    expect(appendArc(full, 0, 50, 50, 50, 180, 360).map(v => +v.toFixed(9))).toEqual([0, 50]);
    expect(full).toHaveLength(8);
    // A collapsed radius degrades to a straight move instead of failing.
    const flat = [];
    expect(appendArc(flat, 0, 0, 10, 0, 180, 180)).toEqual([20, 0]);
  });
});
