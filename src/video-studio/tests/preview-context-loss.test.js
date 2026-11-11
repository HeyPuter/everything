// The shared preview renderer for effect, filter and transition tiles: a lost
// WebGL context must not leave blank tiles cached for the session.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockContext } from './canvas-mock.js';

const gl = vi.hoisted(() => ({ instances: [], loseNext: 0, renders: 0 }));
vi.mock('../src/engine/compositor.js', () => ({
  Compositor: class {
    constructor() {
      this.lost = gl.loseNext > 0;
      if (this.lost) gl.loseNext--;
      gl.instances.push(this);
    }
    render() {
      gl.renders++;
      return this.lost ? false : undefined;
    }
    resize() {}
  },
}));

const { lookPreview, gradePreview } = await import('../src/ui/panels/previews.js');

const realGetContext = HTMLCanvasElement.prototype.getContext;
const contexts = new WeakMap();
const ctxOf = (c) => contexts.get(c);
const drew = (c) => ctxOf(c).calls.some((x) => x[0] === 'drawImage');

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = function getContext() {
    if (!contexts.has(this)) contexts.set(this, mockContext());
    return contexts.get(this);
  };
});
afterEach(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

describe('preview renderer and a lost WebGL context', () => {
  it('does not cache a tile drawn while the context is lost, and starts a new renderer', () => {
    gl.loseNext = 2; // the first renderer and its first replacement are lost
    const a = lookPreview('filter', 'vivid', { lazy: false });
    expect(drew(a)).toBe(false);
    // Not cached: the next tile tries again, on a new renderer.
    const b = lookPreview('filter', 'vivid', { lazy: false });
    expect(gl.instances.length).toBeGreaterThanOrEqual(3);
    expect(drew(b)).toBe(true);
    // Now it is cached.
    const renders = gl.renders;
    const c = lookPreview('filter', 'vivid', { lazy: false });
    expect(drew(c)).toBe(true);
    expect(gl.renders).toBe(renders);
  });

  it('marks a color preview drawn while the context is lost', () => {
    // Lost, and the new renderers tried in its place are lost too.
    gl.instances.at(-1).lost = true;
    gl.loseNext = 2;
    const lost = gradePreview({ adjust: { contrast: 20 } });
    expect(lost.drawn).toBe(false);
    const ok = gradePreview({ adjust: { contrast: 20 } });
    expect(ok.drawn).toBe(true);
  });
});
