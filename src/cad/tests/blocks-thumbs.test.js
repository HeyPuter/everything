// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Drawing } from '../src/core/drawing.js';

const drawn = [];
vi.mock('../src/ui/preview.js', () => ({ drawPreview: (canvas) => drawn.push(canvas) }));
const { BlockLibrary } = await import('../src/ui/blocks.js');

const observers = [];
class FakeIntersectionObserver {
  constructor(cb) {
    this.cb = cb;
    this.targets = new Set();
    observers.push(this);
  }
  observe(t) {
    this.targets.add(t);
  }
  unobserve(t) {
    this.targets.delete(t);
  }
  disconnect() {
    this.targets.clear();
  }
  /** The browser reporting which thumbnails are on screen. */
  show(list) {
    this.cb(list.map((target) => ({ target, isIntersecting: true })), this);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  drawn.length = 0;
  observers.length = 0;
});

function library(count) {
  const d = new Drawing();
  d.transaction('blocks', () => {
    for (let i = 0; i < count; i++) d.setBlock(`B${i}`, { name: `B${i}`, base: { x: 0, y: 0 }, entities: [{ type: 'circle', cx: 0, cy: 0, r: 1, layer: '0' }] });
  });
  const bl = new BlockLibrary({ doc: { drawing: d }, run() {} });
  document.body.append(bl.el);
  return bl;
}

describe('block thumbnails', () => {
  it('are drawn only once they scroll into view', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const bl = library(300);
    bl.render();
    const thumbs = [...bl.grid.querySelectorAll('canvas')];
    expect(thumbs.length).toBe(300);
    expect(drawn).toEqual([]);
    const io = observers.at(-1);
    io.show(thumbs.slice(0, 8));
    expect(drawn).toEqual(thumbs.slice(0, 8));
    // Each one once.
    io.show(thumbs.slice(0, 8).filter((t) => io.targets.has(t)));
    expect(drawn.length).toBe(8);
    // A rebuilt list stops watching the old thumbnails.
    bl.render();
    expect(io.targets.size).toBe(0);
    expect(observers.at(-1).targets.size).toBe(300);
  });
});
