import { describe, it, expect } from 'vitest';
import { installCanvasStub } from './helpers.js';
import { createPath } from '../src/model/nodes.js';
import { rectangle } from '../src/model/shapes.js';

const red = { type: 'solid', color: '#ff0000' };

describe('Layers for effected shapes', () => {
  it('draws small effected shapes in an in-memory layer and large ones on the GPU', async () => {
    installCanvasStub();
    const { drawNode } = await import('../src/render/draw.js');
    const { VDocument } = await import('../src/model/document.js');
    const { regionPool, smallRegionPool } = await import('../src/render/effects.js');
    const used = [];
    const spy = (p, name) => {
      const acquire = p.acquire;
      p.acquire = (w, h) => (used.push(name), acquire.call(p, w, h));
      return () => (p.acquire = acquire);
    };
    const draw = (node) => {
      const doc = VDocument.create();
      doc.transact('add', () => doc.insert(node, doc.root.children[0]));
      const canvas = document.createElement('canvas');
      Object.assign(canvas, { width: 3000, height: 3000 });
      used.length = 0;
      drawNode(canvas.getContext('2d'), doc, doc.get(node.id), { scale: 1 });
      return used[0];
    };
    const undo = [spy(regionPool, 'gpu'), spy(smallRegionPool, 'memory')];
    const blur = [{ type: 'blur', radius: 2 }];
    const shadow = [{ type: 'dropShadow', x: 2, y: 2, blur: 2, opacity: 0.5, color: '#000000' }];
    try {
      expect(draw(createPath(rectangle(0, 0, 40, 40), true, { fill: red, effects: blur }))).toBe(
        'memory',
      );
      expect(
        draw(createPath(rectangle(0, 0, 2000, 2000), true, { fill: red, effects: blur })),
      ).toBe('gpu');
      // A drop shadow blurs on the GPU sooner.
      expect(draw(createPath(rectangle(0, 0, 10, 10), true, { fill: red, effects: shadow }))).toBe(
        'memory',
      );
      expect(
        draw(createPath(rectangle(0, 0, 100, 100), true, { fill: red, effects: shadow })),
      ).toBe('gpu');
      // Pattern paint stays on the GPU.
      const pattern = { type: 'pattern', id: 'p1' };
      expect(
        draw(createPath(rectangle(0, 0, 40, 40), true, { fill: pattern, effects: blur })),
      ).toBe('gpu');
    } finally {
      undo.forEach((f) => f());
    }
  });
});
