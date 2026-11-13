import { describe, it, expect, vi } from 'vitest';
import { bootApp } from './helpers.js';
import { createGroup, createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';
import { nodeBounds } from '../src/model/geometry.js';
import { drawHooks } from '../src/render/draw.js';
import { regionPool } from '../src/render/effects.js';
import { TransformSession, PREVIEW_THRESHOLD } from '../src/tools/transform-session.js';

function scene(properties, count = 3) {
  const app = bootApp();
  const ed = app.newDocument();
  const group = createGroup([], properties);
  const ids = [];
  ed.doc.transact('Artwork', () => {
    ed.doc.insert(group, ed.targetLayer().id);
    for (let i = 0; i < count; i++) {
      const shape = createPath(rectangle(i % 20, 0, 10, 10), true, { opacity: 0.5, blendMode: 'multiply' });
      ed.doc.insert(shape, group.id);
      ids.push(shape.id);
    }
  });
  return { ed, ids, group, view: app.views.get(ed) };
}

const mask = createPath(rectangle(0, 0, 15, 10), true, { fill: { type: 'solid', color: '#888888' } });
const composites = [
  ['opacity mask', { opacityMask: { art: { root: mask.id, nodes: [mask] }, clip: true } }],
  ['isolated blending', { isolate: true }],
  ['knockout', { knockout: true }],
];

describe.each(composites)('transforms inside %s groups', (_name, properties) => {
  it('composites stationary siblings with the moving child in a slow scene', () => {
    // The hook stands in for mask pixels; the actual renderer must still composite the group once.
    const previousMask = drawHooks.opacityMask;
    drawHooks.opacityMask = () => {};
    const acquire = vi.spyOn(regionPool, 'acquire');
    let session;
    try {
      const { ed, ids, view } = scene(properties);
      view.renderNow();
      const fullCompositeCount = acquire.mock.calls.length;
      expect(fullCompositeCount).toBeGreaterThan(0);
      acquire.mockClear();
      ed.select([ids[1]]);
      session = new TransformSession(ed, 'Move');
      session.apply([1, 0, 0, 1, 4, 0]);
      view.slowScene = true;
      view.renderNow();
      // Separately compositing below/moving/above loses shared mask and blend semantics.
      expect(acquire.mock.calls.length).toBe(fullCompositeCount);
      expect(view.interaction).toBeNull();
    } finally {
      session?.cancel();
      acquire.mockRestore();
      drawHooks.opacityMask = previousMask;
    }
  });

  it('updates large selections live inside their stationary parent', () => {
    const { ed, ids, group, view } = scene(properties, PREVIEW_THRESHOLD + 1);
    ed.select(ids);
    const before = ed.doc.get(group.id);
    const session = new TransformSession(ed, 'Move');
    try {
      session.apply([1, 0, 0, 1, 4, 0]);
      expect(nodeBounds(ed.doc, ed.doc.get(ids[0])).x).toBe(4);
      expect(ed.doc.get(group.id)).toEqual(before);
      view.slowScene = true;
      view.renderNow();
      expect(view.previewCache).toBeNull();
      expect(view.interaction).toBeNull();
      session.commit();
      ed.doc.undo();
      expect(nodeBounds(ed.doc, ed.doc.get(ids[0])).x).toBe(0);
    } finally {
      if (ed.doc.tx) session.cancel();
    }
  });
});

it('retains the bitmap fast path when an ancestor opacity mask is disabled', () => {
  const { ed, ids } = scene({ opacityMask: { disabled: true } }, PREVIEW_THRESHOLD + 1);
  ed.select(ids);
  const session = new TransformSession(ed, 'Move');
  try {
    session.apply([1, 0, 0, 1, 4, 0]);
    expect(ed.dragPreview).toBeTruthy();
  } finally {
    session.cancel();
  }
});
