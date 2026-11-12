import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { installCanvasStub } from './helpers.js';
import { VDocument } from '../src/model/document.js';
import { createGroup, createPath, createText } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { drawNode } from '../src/render/draw.js';
import { regionPool } from '../src/render/effects.js';

/** A recording 2D context: every call with the compositing mode it was made in. */
function recorder(calls, layer) {
  const state = {
    lineWidth: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000',
    strokeStyle: '#000',
  };
  return new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'canvas') return { width: 1000, height: 1000 };
      if (key === 'measureText') return (s) => ({ width: String(s).length * 10 });
      if (key === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      return (...a) =>
        calls.push({ layer, op: key, gco: target.globalCompositeOperation, arg: a[0] });
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
}

function clipGroup(text) {
  const doc = VDocument.create({ width: 400, height: 300 });
  const L = doc.layers()[0].id;
  const bg = createPath(rectangle(0, 0, 400, 300), true, {
    fill: { type: 'solid', color: '#ff0000' },
    stroke: null,
  });
  const g = createGroup([], { clip: true });
  doc.transact('x', () => {
    doc.insert(g, L);
    doc.insert(bg, g.id);
    doc.insert(text, g.id);
  });
  return { doc, g: doc.get(g.id) };
}

function drawCalls(doc, node) {
  const calls = [];
  let n = 0;
  regionPool.acquire = (w, h) => {
    const layer = `layer${++n}`;
    const canvas = { width: w, height: h, layer };
    return { canvas, ctx: recorder(calls, layer), key: 'test' };
  };
  regionPool.release = () => {};
  drawNode(recorder(calls, 'main'), doc, node, {});
  return calls;
}

const { acquire, release } = regionPool;

// Type as a clipping mask keeps the content where any of its glyphs are, as in SVG and PDF export.
describe('type as a clipping mask', () => {
  beforeAll(() => installCanvasStub());
  afterEach(() => {
    regionPool.acquire = acquire;
    regionPool.release = release;
  });

  it('keeps the content under every line, not only where the lines overlap', () => {
    const t = createText('one\ntwo\nthree', 20, 40);
    t.char = { ...t.char, fontSize: 40 };
    const { doc, g } = clipGroup(t);
    const calls = drawCalls(doc, g);
    const glyphs = calls.filter((c) => c.op === 'fillText');
    expect(glyphs.length).toBe(3);
    // Painted one by one with destination-in, each line would erase the others.
    expect(glyphs.every((c) => c.gco === 'source-over')).toBe(true);
    const masked = calls.filter((c) => c.gco === 'destination-in');
    expect(masked.map((c) => c.op)).toEqual(['drawImage']);
    // The mask layer is the one the lines were painted on.
    expect(masked[0].arg.layer).toBe(glyphs[0].layer);
  });

  it('a single line of one style keeps the content directly, without a mask layer', () => {
    const t = createText('one', 20, 40);
    t.char = { ...t.char, fontSize: 40 };
    const { doc, g } = clipGroup(t);
    const calls = drawCalls(doc, g);
    expect(calls.filter((c) => c.op === 'fillText').map((c) => [c.layer, c.gco])).toEqual([
      ['layer1', 'destination-in'],
    ]);
    expect(new Set(calls.map((c) => c.layer))).toEqual(new Set(['main', 'layer1']));
  });

  it('area type in a shape masks with its glyphs only, not the outline of its frame', () => {
    const t = createText('one two three four', 40, 40, {
      kind: 'area',
      width: 300,
      height: 200,
      areaPath: rectangle(40, 40, 300, 200),
    });
    t.char = { ...t.char, fontSize: 40 };
    const { doc, g } = clipGroup(t);
    const calls = drawCalls(doc, g);
    expect(calls.some((c) => c.op === 'fillText')).toBe(true);
    expect(calls.filter((c) => c.op === 'stroke' || c.op === 'strokeRect')).toEqual([]);
  });
});
