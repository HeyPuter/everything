import { describe, it, expect, beforeAll } from 'vitest';
import { installCanvasStub } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createCompound } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import { svgToDocument } from '../src/features/io/svg-import.js';
import { svgExportHooks, exportBakers } from '../src/features/io/hooks.js';
import { appearanceAttrs, layerAppearanceBaker, appearanceSpecBaker } from '../src/features/io/svg-appearance.js';
import { stackItems, itemPaint } from '../src/model/appearance.js';

beforeAll(() => {
  installCanvasStub();
  // What the io feature installs.
  if (!svgExportHooks.attrs.includes(appearanceAttrs)) svgExportHooks.attrs.push(appearanceAttrs);
  if (!exportBakers.includes(layerAppearanceBaker)) exportBakers.push(layerAppearanceBaker);
  if (!exportBakers.includes(appearanceSpecBaker)) exportBakers.push(appearanceSpecBaker);
});

const solid = (color) => ({ type: 'solid', color });
const rect = { x: 0, y: 0, w: 300, h: 200 };
const docWith = (...nodes) => {
  const doc = VDocument.create({ width: 300, height: 200 });
  const layer = doc.layers()[0].id;
  doc.transact('build', () => nodes.forEach((n) => doc.insert(n, layer)));
  return doc;
};
const roundTrip = (doc) => {
  const svg = exportSVG(doc, { rect });
  return { svg, back: svgToDocument(svg) };
};
const summary = (n) => stackItems(n).map((it) => (it.base ? `${it.type}*` : it.type));

describe('SVG appearance stacks with options the plain outline cannot show', () => {
  it('rebuilds inside and outside strokes', () => {
    const stack = [{ type: 'fill', base: true }, { type: 'stroke', stroke: solid('#00ff00'), strokeWidth: 6, strokeAlign: 'outside' }, { type: 'stroke', base: true }];
    const node = createPath(rectangle(20, 20, 100, 60), true, { fill: solid('#ff0000'), stroke: solid('#0000ff'), strokeWidth: 4, strokeAlign: 'inside', appearance: stack }, { name: 'Panel' });
    const { svg, back } = roundTrip(docWith(node));
    expect(svg).toContain('data-appearance-spec=');
    expect(svg).toContain('data-appearance-d=');
    const leaves = back.leaves();
    expect(leaves).toHaveLength(1);
    const n = leaves[0];
    expect(n.name).toBe('Panel');
    expect(n.anchors.map((a) => [a.x, a.y])).toEqual(node.anchors.map((a) => [a.x, a.y]));
    expect(summary(n)).toEqual(['fill*', 'stroke', 'stroke*']);
    expect(n.fill).toEqual(solid('#ff0000'));
    expect(n).toMatchObject({ stroke: solid('#0000ff'), strokeWidth: 4, strokeAlign: 'inside' });
    const extra = stackItems(n)[1];
    expect(itemPaint(n, extra)).toEqual(solid('#00ff00'));
    expect(extra).toMatchObject({ strokeWidth: 6, strokeAlign: 'outside' });
  });

  it('rebuilds arrowheads and items with their own geometry effects', () => {
    const line = [{ x: 20, y: 150, ix: 20, iy: 150, ox: 60, oy: 100 }, { x: 160, y: 150, ix: 120, iy: 100, ox: 160, oy: 150 }];
    const arrows = { arrowEnd: { shape: 'triangle', scale: 100, align: 'end' }, arrowStart: { shape: 'circle', scale: 80, align: 'beyond' } };
    const stack = [{ type: 'stroke', stroke: solid('#cccccc'), strokeWidth: 10, opacity: 0.5 }, { type: 'stroke', base: true }];
    const arrow = createPath(line, false, { fill: null, stroke: solid('#000000'), strokeWidth: 3, ...arrows, appearance: stack });
    const box = createPath(rectangle(180, 20, 80, 80), true, {
      fill: solid('#ffcc00'),
      stroke: null,
      appearance: [{ type: 'fill', base: true }, { type: 'stroke', stroke: solid('#333333'), strokeWidth: 2, effects: [{ type: 'roundCorners', radius: 12 }] }],
    });
    const { back } = roundTrip(docWith(arrow, box));
    const leaves = back.leaves();
    expect(leaves).toHaveLength(2);
    const a = leaves.find((n) => !n.closed);
    expect(summary(a)).toEqual(summary(arrow));
    expect(a).toMatchObject({ strokeWidth: 3, ...arrows });
    expect(stackItems(a).find((it) => it.type === 'stroke' && !it.base)).toMatchObject({ strokeWidth: 10, opacity: 0.5 });
    expect(a.anchors).toHaveLength(2);
    expect(a.anchors[0].ox).toBeCloseTo(60);
    const b = leaves.find((n) => n.closed);
    // The item's own effect comes back on the item; the object's outline stays square.
    expect(b.anchors).toHaveLength(4);
    expect(summary(b)).toEqual(summary(box));
    expect(stackItems(b).find((it) => it.type === 'stroke' && !it.base).effects).toEqual([{ type: 'roundCorners', radius: 12 }]);
    expect(b.effects || []).toEqual([]);
  });

  it('keeps object-level geometry effects and compound outlines', () => {
    const outer = createPath(rectangle(20, 20, 100, 100), true, { fill: null, stroke: null });
    const inner = createPath(rectangle(50, 50, 40, 40), true, { fill: null, stroke: null });
    const comp = createCompound([outer.id, inner.id], {
      fill: solid('#112233'),
      stroke: solid('#445566'),
      strokeWidth: 2,
      effects: [{ type: 'roundCorners', radius: 6 }],
      appearance: [{ type: 'fill', base: true }, { type: 'stroke', stroke: solid('#ff00ff'), strokeWidth: 8 }, { type: 'stroke', base: true }],
    }, { fillRule: 'evenodd' });
    const doc = VDocument.create({ width: 300, height: 200 });
    doc.transact('build', () => doc.insert(comp, doc.layers()[0].id, Infinity, [{ ...outer, parent: comp.id }, { ...inner, parent: comp.id }]));
    const { back } = roundTrip(doc);
    const n = [...back.nodes.values()].find((x) => x.type === 'compound');
    expect(n).toBeTruthy();
    expect(n.fillRule).toBe('evenodd');
    expect(n.children).toHaveLength(2);
    expect(back.get(n.children[0]).anchors).toHaveLength(4);
    expect(n.effects).toEqual([{ type: 'roundCorners', radius: 6 }]);
    expect(summary(n)).toEqual(['fill*', 'stroke', 'stroke*']);
    expect(n.fill).toEqual(solid('#112233'));
  });

  it('still merges plain stacks written by other programs', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><g data-appearance="stack"><path d="M10 10H90V90H10Z" fill="#f00" data-appearance-item="fill base"/><path d="M10 10H90V90H10Z" fill="none" stroke="#00f" stroke-width="3" data-appearance-item="stroke"/></g></svg>';
    const back = svgToDocument(svg);
    const [n] = back.leaves();
    // Paths always have a place for their own stroke (empty here).
    expect(summary(n)).toEqual(['fill*', 'stroke*', 'stroke']);
    expect(n.stroke).toBeNull();
    expect(itemPaint(n, stackItems(n)[2])).toEqual(solid('#0000ff'));
  });
});
