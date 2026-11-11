import { describe, it, expect, beforeAll } from 'vitest';
import { installCanvasStub } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createPath, createGroup, defaultLabel } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { registerLive, liveArtwork, virtualId, expandLive, isLive } from '../src/model/live.js';
import { registerGeomEffect, effectiveSubpaths } from '../src/model/geom-effects.js';
import { nodeBounds, visualBounds, transformNodes } from '../src/model/geometry.js';
import { hitTest } from '../src/render/hit.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import { svgToDocument } from '../src/features/io/svg-import.js';
import { expandNodeAppearance } from '../src/ops/expand-appearance.js';
import { translate } from '../src/lib/matrix.js';

beforeAll(() => installCanvasStub());

// A test kind: the source children plus `count` copies moved `dx` to the right.
registerLive('testCopies', {
  label: '<Copies>',
  generate(doc, node) {
    const extra = new Map();
    const items = [...node.children];
    for (let i = 1; i <= node.live.count; i++) {
      for (const c of node.children) {
        const src = doc.get(c);
        const id = virtualId(src.id);
        extra.set(id, { ...src, id, source: src.id, anchors: src.anchors.map((a) => ({ ...a, x: a.x + i * node.live.dx, ix: a.ix + i * node.live.dx, ox: a.ox + i * node.live.dx })) });
        items.push(id);
      }
    }
    return { items, extra };
  },
  transformParams(node, m) {
    return { live: { ...node.live, dx: node.live.dx * m[0] } };
  },
});

// A test geometry effect: shifts the outline down by `dy`.
registerGeomEffect('testShift', {
  apply: (subs, fx) => subs.map((s) => ({ closed: s.closed, anchors: s.anchors.map((a) => ({ ...a, y: a.y + fx.dy, iy: a.iy + fx.dy, oy: a.oy + fx.dy })) })),
});

const red = { type: 'solid', color: '#ff0000' };

function setup() {
  const doc = VDocument.create({ width: 400, height: 200 });
  const layer = doc.layers()[0].id;
  const r = createPath(rectangle(10, 10, 20, 20), true, { fill: red, stroke: null });
  let gid;
  doc.transact('make', () => {
    gid = doc.insert(createGroup([r.id], { live: { kind: 'testCopies', count: 2, dx: 50 } }), layer, Infinity, [r]).id;
  });
  doc.repairParents();
  return { doc, gid, rid: r.id, layer };
}

describe('live artwork', () => {
  it('generates, measures and labels live groups', () => {
    const { doc, gid } = setup();
    const g = doc.get(gid);
    expect(isLive(g)).toBe(true);
    expect(defaultLabel(g)).toBe('<Copies>');
    expect(liveArtwork(doc, g).items).toHaveLength(3);
    const b = nodeBounds(doc, g);
    expect(b.x).toBeCloseTo(10);
    expect(b.w).toBeCloseTo(120);
    expect(visualBounds(doc, g).w).toBeCloseTo(120);
  });

  it('caches until the source changes', () => {
    const { doc, gid, rid } = setup();
    const a = liveArtwork(doc, doc.get(gid));
    expect(liveArtwork(doc, doc.get(gid))).toBe(a);
    doc.transact('edit', () => doc.update(rid, { fill: { type: 'solid', color: '#00ff00' } }));
    const b = liveArtwork(doc, doc.get(gid));
    expect(b).not.toBe(a);
    expect(b.items[1].fill.color).toBe('#00ff00');
  });

  it('hit tests generated copies back to their source', () => {
    const { doc, rid } = setup();
    expect(hitTest(doc, 120, 20, 1)?.id).toBe(rid);
    expect(hitTest(doc, 20, 20, 1)?.id).toBe(rid);
    expect(hitTest(doc, 90, 20, 1)).toBe(null);
  });

  it('keeps parameters in step with transforms', () => {
    const { doc, gid } = setup();
    doc.transact('scale', () => transformNodes(doc, [gid], [2, 0, 0, 1, 0, 0]));
    expect(doc.get(gid).live.dx).toBe(100);
    doc.transact('move', () => transformNodes(doc, [gid], translate(5, 0)));
    expect(doc.get(gid).live.dx).toBe(100);
  });

  it('exports the generated artwork', () => {
    const { doc } = setup();
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 400, h: 200 } });
    expect(svgToDocument(svg).leaves()).toHaveLength(3);
  });

  it('expands to real, editable objects', () => {
    const { doc, gid, layer } = setup();
    let g;
    doc.transact('expand', () => {
      g = expandLive(doc, gid);
    });
    expect(doc.get(gid)).toBeUndefined();
    expect(isLive(g)).toBe(false);
    expect(g.children).toHaveLength(3);
    expect(g.parent).toBe(layer);
    for (const c of g.children) {
      expect(c).not.toContain('~');
      expect(doc.get(c).parent).toBe(g.id);
      expect(doc.get(c).source).toBeUndefined();
    }
    doc.undo();
    expect(doc.get(gid)).toBeTruthy();
  });
});

describe('geometry effects', () => {
  it('apply at render time and bake on Expand Appearance', () => {
    const doc = VDocument.create({ width: 400, height: 200 });
    const layer = doc.layers()[0].id;
    const r = createPath(rectangle(10, 10, 20, 20), true, { fill: red, stroke: null, effects: [{ type: 'testShift', dy: 100 }] });
    doc.transact('add', () => doc.insert(r, layer));
    const n = doc.get(r.id);
    expect(effectiveSubpaths(doc, n)[0].anchors[0].y).toBeCloseTo(110);
    // The selection box stays on the stored geometry; what renders moved.
    expect(nodeBounds(doc, n).y).toBeCloseTo(10);
    expect(visualBounds(doc, n).y).toBeCloseTo(110);
    expect(hitTest(doc, 20, 120, 1)?.id).toBe(r.id);
    expect(hitTest(doc, 20, 20, 1)).toBe(null);
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 400, h: 200 } });
    expect(nodeBounds(svgToDocument(svg), svgToDocument(svg).leaves()[0]).y).toBeCloseTo(110);
    doc.transact('expand', () => expandNodeAppearance(doc, r.id));
    const baked = doc.get(r.id);
    expect(baked.effects).toEqual([]);
    expect(nodeBounds(doc, baked).y).toBeCloseTo(110);
  });

  it('on a group, frame every path by the group', () => {
    const doc = VDocument.create({ width: 400, height: 200 });
    const layer = doc.layers()[0].id;
    const a = createPath(rectangle(10, 10, 20, 20), true, { fill: red, stroke: null });
    const b = createPath(rectangle(60, 10, 20, 20), true, { fill: red, stroke: null });
    let gid;
    doc.transact('add', () => {
      gid = doc.insert(createGroup([a.id, b.id], { effects: [{ type: 'testShift', dy: 50 }] }), layer, Infinity, [a, b]).id;
    });
    doc.repairParents();
    const g = doc.get(gid);
    expect(isLive(g)).toBe(true);
    expect(nodeBounds(doc, g).y).toBeCloseTo(10);
    expect(visualBounds(doc, g).y).toBeCloseTo(60);
    expect(hitTest(doc, 70, 70, 1)?.id).toBe(b.id);
    let out;
    doc.transact('expand', () => {
      out = expandNodeAppearance(doc, gid);
    });
    const leaves = doc.get(out).children.flatMap((c) => doc.get(c).children || [c]).map((c) => doc.get(c));
    expect(leaves).toHaveLength(2);
    for (const l of leaves) {
      expect(nodeBounds(doc, l).y).toBeCloseTo(60);
      expect(l.effects).toEqual([]);
    }
  });
});

describe('live kind lookup cache', () => {
  it('finds a kind registered after a node was first looked up', () => {
    const n = createPath(rectangle(0, 0, 10, 10), true, { fill: null });
    const tagged = { ...n, cacheProbe: true };
    expect(isLive(tagged)).toBe(false);
    registerLive('cacheProbe', { test: (x) => Boolean(x.cacheProbe), generate: () => [] });
    expect(isLive(tagged)).toBe(true);
    expect(isLive(n)).toBe(false);
  });
});
