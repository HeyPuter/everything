import { describe, it, expect } from 'vitest';
import { VDocument } from '../src/model/document.js';
import { createPath, createGroup, createCompound } from '../src/model/nodes.js';
import { rectangle, line } from '../src/model/shapes.js';
import { MODES, withChannel, isWebSafe, parseChannel, spectrumColor, rampCss } from '../src/features/paint/color-modes.js';
import { insertStop, removeStop, moveStop, reverseGradient, setMidpoint, setGradientAngle, gradientAngle, setGradientVector } from '../src/features/paint/gradient-model.js';
import { expandStops, midpointWeight, sampleStops } from '../src/model/gradients.js';
import { addSwatch, updateSwatch, removeSwatches, paintFromSwatch, moveSwatches, addGroup, swatchRows, swatchUsage } from '../src/features/paint/swatch-model.js';
import { arrowheadContours, nodeArrowheads, arrowTrim, trimAnchors, alignedDash, ARROWHEADS } from '../src/features/paint/stroke-geometry.js';
import { colorTargets, colorPatches, collectColors, recolorFn, invertColor, grayscaleColor, saturateColor, adjustColor, blendFills } from '../src/features/paint/edit-colors.js';
import { normalizeEffect, serializeEffects, parseEffects, createEffect } from '../src/features/paint/effects-model.js';
import { effectFromValues } from '../src/features/paint/effects-ui.js';
import { roundCornerAnchors } from '../src/model/round-corners.js';
import { pathLength } from '../src/model/bezier.js';

const solid = (color) => ({ type: 'solid', color });

function docWith(...nodes) {
  const doc = VDocument.create();
  const layer = doc.layers()[0];
  doc.transact('setup', () => {
    for (const n of nodes) {
      if (n.children) {
        const kids = n.__kids || [];
        delete n.__kids;
        doc.insert(n, layer.id, Infinity, kids.map((k) => ({ ...k, parent: n.id })));
      } else doc.insert(n, layer.id);
    }
  });
  return doc;
}

describe('color modes', () => {
  it('round-trips colors through every mode', () => {
    for (const hex of ['#ff0000', '#12ab34', '#808080', '#000000', '#ffffff']) {
      for (const m of ['rgb', 'hsb', 'cmyk']) expect(MODES[m].to(MODES[m].from(hex))).toBe(hex);
    }
    expect(MODES.gray.to(MODES.gray.from('#808080'))).toBe('#808080');
  });

  it('edits single channels', () => {
    expect(withChannel('#000000', 'rgb', 0, 255)).toBe('#ff0000');
    expect(withChannel('#ff0000', 'hsb', 0, 120)).toBe('#00ff00');
    expect(withChannel('#ffffff', 'cmyk', 3, 100)).toBe('#000000');
    expect(MODES.gray.to([0])).toBe('#ffffff');
  });

  it('snaps web safe channels and detects web colors', () => {
    expect(MODES.web.from('#123456')).toEqual([0, 51, 102]);
    expect(isWebSafe('#3366cc')).toBe(true);
    expect(isWebSafe('#3366cd')).toBe(false);
    expect(parseChannel(MODES.web.channels[0], '34')).toBe(51);
    expect(parseChannel(MODES.rgb.channels[0], '300')).toBe(255);
    expect(parseChannel(MODES.rgb.channels[0], 'x')).toBeNull();
  });

  it('builds ramps and the spectrum', () => {
    expect(rampCss('rgb', [0, 0, 0], 0)).toBe('linear-gradient(to right, #000000 0%, #ff0000 100%)');
    expect(spectrumColor(0, 0)).toBe('#ffffff');
    expect(spectrumColor(0, 0.5)).toBe('#ff0000');
    expect(spectrumColor(0.5, 1)).toBe('#000000');
  });
});

describe('gradient stops', () => {
  const g = { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#000000', opacity: 1 }, { offset: 1, color: '#ffffff', opacity: 0 }] };

  it('inserts a stop with the interpolated color, sorted', () => {
    const r = insertStop(g, 0.5);
    expect(r.index).toBe(1);
    expect(r.paint.stops.map((s) => s.offset)).toEqual([0, 0.5, 1]);
    expect(r.paint.stops[1].color).toBe('#808080');
    expect(r.paint.stops[1].opacity).toBeCloseTo(0.5);
  });

  it('keeps at least two stops when removing', () => {
    const three = insertStop(g, 0.3).paint;
    expect(removeStop(three, 1).stops).toHaveLength(2);
    expect(removeStop(g, 0).stops).toHaveLength(2);
  });

  it('tracks a moved stop through re-sorting', () => {
    const three = insertStop(g, 0.5).paint;
    const r = moveStop(three, 0, 0.7);
    expect(r.index).toBe(1);
    expect(r.paint.stops[1]).toMatchObject({ color: '#000000', offset: 0.7 });
    expect(moveStop(g, 1, -3).paint.stops[0].offset).toBe(0);
  });

  it('honors midpoints when sampling and expanding', () => {
    expect(midpointWeight(0.25, 0.25)).toBeCloseTo(0.5);
    const m = setMidpoint(g, 0, 0.25);
    expect(sampleStops(m.stops, 0.25).color).toBe('#808080');
    expect(expandStops(g.stops)).toHaveLength(2);
    const exp = expandStops(m.stops);
    expect(exp.length).toBeGreaterThan(2);
    expect(exp.every((s, i) => i === 0 || s.offset >= exp[i - 1].offset)).toBe(true);
  });

  it('reverses stops and their midpoints', () => {
    const m = setMidpoint(g, 0, 0.2);
    const r = reverseGradient(m);
    expect(r.stops.map((s) => s.color)).toEqual(['#ffffff', '#000000']);
    expect(r.stops[0].midpoint).toBeCloseTo(0.8);
    expect(r.stops[1].midpoint).toBeUndefined();
  });

  it('sets angles with and without explicit vectors', () => {
    expect(gradientAngle(setGradientAngle(g, 45))).toBe(45);
    const v = setGradientVector(g, 0, 0, 100, 0);
    const rot = setGradientAngle(v, 90);
    expect(rot.x1).toBeCloseTo(50);
    expect(rot.y1).toBeCloseTo(50);
    expect(rot.y2).toBeCloseTo(-50);
    expect(gradientAngle(rot)).toBeCloseTo(90);
  });
});

describe('swatches', () => {
  it('updates every object linked to a global swatch in one undo step', () => {
    const a = createPath(rectangle(0, 0, 10, 10), true);
    const b = createPath(rectangle(20, 0, 10, 10), true);
    const doc = docWith(a, b);
    let id;
    doc.transact('add', () => {
      id = addSwatch(doc, { name: 'Brand', paint: solid('#ff0000'), global: true });
    });
    const sw = doc.root.swatches.find((s) => s.id === id);
    const paint = paintFromSwatch(sw);
    expect(paint).toEqual({ type: 'solid', color: '#ff0000', swatchId: id });
    doc.transact('apply', () => {
      doc.update(a.id, { fill: paint });
      doc.update(b.id, { stroke: paint, fill: { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ff0000', opacity: 1, swatchId: id }, { offset: 1, color: '#000000', opacity: 1 }] } });
    });
    expect(swatchUsage(doc, id)).toBe(2);
    doc.transact('edit', () => updateSwatch(doc, id, { paint: solid('#00ff00') }));
    expect(doc.get(a.id).fill).toEqual({ type: 'solid', color: '#00ff00', swatchId: id });
    expect(doc.get(b.id).stroke.color).toBe('#00ff00');
    expect(doc.get(b.id).fill.stops[0].color).toBe('#00ff00');
    expect(doc.get(b.id).fill.stops[1].color).toBe('#000000');
    doc.undo();
    expect(doc.get(a.id).fill.color).toBe('#ff0000');
    expect(doc.root.swatches.find((s) => s.id === id).paint.color).toBe('#ff0000');
  });

  it('process swatches do not link and deleting a global swatch unlinks', () => {
    const a = createPath(rectangle(0, 0, 10, 10), true);
    const doc = docWith(a);
    let g;
    let p;
    doc.transact('add', () => {
      g = addSwatch(doc, { name: 'G', paint: solid('#123456'), global: true });
      p = addSwatch(doc, { name: 'P', paint: solid('#654321') });
    });
    expect(paintFromSwatch(doc.root.swatches.find((s) => s.id === p))).toEqual(solid('#654321'));
    doc.transact('apply', () => doc.update(a.id, { fill: { type: 'solid', color: '#123456', swatchId: g } }));
    doc.transact('delete', () => removeSwatches(doc, [g]));
    expect(doc.get(a.id).fill).toEqual(solid('#123456'));
    expect(doc.root.swatches.some((s) => s.id === g)).toBe(false);
  });

  it('groups, reorders and filters swatches', () => {
    const doc = VDocument.create();
    doc.transact('setup', () => doc.updateRoot({ swatches: [] }));
    let ids = [];
    doc.transact('add', () => {
      ids = ['#ff0000', '#00ff00', '#0000ff'].map((c, i) => addSwatch(doc, { name: `S${i}`, paint: solid(c) }));
      addSwatch(doc, { name: 'Grad', paint: { type: 'linear', angle: 0, stops: [] } });
    });
    let gid;
    doc.transact('group', () => {
      gid = addGroup(doc, 'Warm', { swatchIds: [ids[0]] });
    });
    const rows = swatchRows(doc);
    expect(rows.map((r) => (r.kind === 'group' ? `[${r.group.name}]` : r.swatch.name))).toEqual(['S1', 'S2', 'Grad', '[Warm]', 'S0']);
    doc.transact('move', () => moveSwatches(doc, [ids[2]], ids[1]));
    expect(swatchRows(doc, { show: 'color' }).map((r) => r.swatch?.name || r.group.name)).toEqual(['S2', 'S1', 'Warm', 'S0']);
    expect(swatchRows(doc, { show: 'gradient' }).filter((r) => r.kind === 'swatch').map((r) => r.swatch.name)).toEqual(['Grad']);
    expect(swatchRows(doc, { query: 's0' }).map((r) => r.swatch?.name || r.group.name)).toEqual(['Warm', 'S0']);
    doc.transact('remove group', () => removeSwatches(doc, [gid]));
    expect(doc.root.swatches.some((s) => s.id === ids[0])).toBe(false);
  });
});

describe('stroke geometry', () => {
  const anchors = line(0, 0, 100, 0);

  it('places arrow tips beyond or at the path end', () => {
    const def = ARROWHEADS.triangle;
    const beyond = arrowheadContours(anchors, 'end', { shape: 'triangle', scale: 100, align: 'beyond' }, 2);
    const tipX = Math.max(...beyond[0].anchors.map((a) => a.x));
    expect(tipX).toBeCloseTo(100 - def.attach * 2);
    const atEnd = arrowheadContours(anchors, 'end', { shape: 'triangle', scale: 200, align: 'end' }, 2);
    expect(Math.max(...atEnd[0].anchors.map((a) => a.x))).toBeCloseTo(100);
    const start = arrowheadContours(anchors, 'start', { shape: 'triangle', scale: 100, align: 'end' }, 1);
    expect(Math.min(...start[0].anchors.map((a) => a.x))).toBeCloseTo(0);
    expect(Math.max(...start[0].anchors.map((a) => a.x))).toBeCloseTo(4.5);
  });

  it('trims the stroked path for tips placed at the end', () => {
    const node = createPath(anchors, false, { strokeWidth: 2, arrowEnd: { shape: 'triangle', scale: 100, align: 'end' }, arrowStart: { shape: 'bar', scale: 100, align: 'beyond' } });
    const t = arrowTrim(node);
    expect(t.start).toBe(0);
    expect(t.end).toBeCloseTo(8);
    const trimmed = trimAnchors(node.anchors, t.start, t.end);
    expect(pathLength(trimmed, false)).toBeCloseTo(92);
    expect(nodeArrowheads(node)).toHaveLength(2);
    expect(nodeArrowheads({ ...node, closed: true })).toHaveLength(0);
  });

  it('aligns dashes to fit a whole number of repeats', () => {
    const d = alignedDash([10, 5], 100, true);
    const P = d.dash[0] + d.dash[1];
    expect(100 / P).toBeCloseTo(Math.round(100 / P));
    expect(d.offset).toBeCloseTo(d.dash[0] / 2);
    expect(alignedDash([], 100, false)).toBeNull();
  });

  it('rounds straight corners and leaves smooth points alone', () => {
    const rect = rectangle(0, 0, 100, 50);
    const r = roundCornerAnchors(rect, true, 10);
    expect(r).toHaveLength(8);
    expect(r[0].x).toBeCloseTo(0);
    expect(r[0].y).toBeCloseTo(10);
    // Radius clamps to half the shortest edge.
    const big = roundCornerAnchors(rect, true, 500);
    expect(Math.min(...big.map((a) => a.y))).toBeCloseTo(0);
    expect(roundCornerAnchors(rect, true, 0)).toBe(rect);
  });
});

describe('edit colors', () => {
  it('recolors fills, strokes and gradient stops through groups and compounds', () => {
    const p1 = createPath(rectangle(0, 0, 10, 10), true, { fill: solid('#ff0000'), stroke: solid('#000000') });
    const p2 = createPath(rectangle(20, 0, 10, 10), true, { fill: { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ff0000', opacity: 1 }, { offset: 1, color: '#0000ff', opacity: 1 }] }, stroke: null });
    const sub = createPath(rectangle(40, 0, 10, 10), true);
    const comp = createCompound([sub.id], { fill: { type: 'solid', color: '#0000ff', swatchId: 'x' } });
    comp.__kids = [sub];
    const grp = createGroup([p1.id, p2.id]);
    grp.__kids = [p1, p2];
    const doc = docWith(grp, comp);
    const nodes = colorTargets(doc, [grp.id, sub.id]);
    expect(nodes.map((n) => n.id).sort()).toEqual([p1.id, p2.id, comp.id].sort());
    expect(collectColors(nodes)[0]).toEqual({ color: '#ff0000', count: 2 });
    const patches = colorPatches(nodes, recolorFn({ '#FF0000': '#00ff00' }));
    expect(patches.get(p1.id).fill.color).toBe('#00ff00');
    expect(patches.get(p1.id).stroke).toBeUndefined();
    expect(patches.get(p2.id).fill.stops.map((s) => s.color)).toEqual(['#00ff00', '#0000ff']);
    expect(patches.has(comp.id)).toBe(false);
    const inv = colorPatches(nodes, invertColor, { stroke: false });
    expect(inv.get(comp.id).fill).toEqual(solid('#ffff00'));
    expect(inv.get(p1.id).stroke).toBeUndefined();
  });

  it('converts, saturates and adjusts colors', () => {
    expect(grayscaleColor('#ff0000')).toBe('#4c4c4c');
    expect(saturateColor('#ff8000', -100)).toBe(grayscaleColor('#ff8000'));
    expect(saturateColor('#808080', 50)).toBe('#808080');
    expect(adjustColor('#000000', 'rgb', { r: 100 })).toBe('#ff0000');
    expect(adjustColor('#ffffff', 'cmyk', { k: 100 })).toBe('#000000');
    expect(recolorFn({}, { h: 120 })('#ff0000')).toBe('#00ff00');
  });

  it('blends fills between the extreme objects', () => {
    const a = createPath(rectangle(0, 0, 10, 10), true, { fill: solid('#000000') });
    const b = createPath(rectangle(50, 0, 10, 10), true, { fill: solid('#ffffff') });
    const c = createPath(rectangle(25, 0, 10, 10), true, { fill: solid('#ff0000') });
    const doc = docWith(a, b, c);
    const res = blendFills(doc, [a, b, c], 'horizontal');
    expect([...res.keys()]).toEqual([c.id]);
    expect(res.get(c.id)).toBe('#808080');
    expect(blendFills(doc, [a, b], 'horizontal')).toBeNull();
    const front = blendFills(doc, [a, b, c], 'front');
    // Front (c, red) to back (a, black): b sits in the middle of the stack.
    expect(front.get(b.id)).toBe('#800000');
  });
});

describe('effects', () => {
  it('normalizes effect records', () => {
    expect(normalizeEffect({ type: 'nope' })).toBeNull();
    const e = normalizeEffect({ type: 'dropShadow', opacity: 3, blur: -4, color: 'red', mode: 'bogus', extra: 1, hidden: true });
    expect(e).toEqual({ type: 'dropShadow', mode: 'multiply', opacity: 1, x: 7, y: 7, blur: 0, color: '#000000', shadowFrom: 'color', darkness: 1, hidden: true });
    expect(createEffect('innerGlow', { source: 'center' }).source).toBe('center');
  });

  it('serializes and parses effect lists', () => {
    const list = [createEffect('blur', { radius: 3 }), { type: 'roundCorners', radius: 4, hidden: true }, { type: 'junk' }];
    const json = serializeEffects(list);
    expect(parseEffects(json)).toEqual([{ type: 'blur', radius: 3 }, { type: 'roundCorners', radius: 4, hidden: true }]);
    expect(parseEffects('not json')).toEqual([]);
  });

  it('reads dialog values into effect params', () => {
    const fx = effectFromValues('outerGlow', { mode: 'screen', color: '#00ff00', opacity: 50, blur: 8, preview: true });
    expect(fx).toEqual({ type: 'outerGlow', mode: 'screen', opacity: 0.5, blur: 8, color: '#00ff00' });
  });
});
