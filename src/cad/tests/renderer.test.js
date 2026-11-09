/**
 * Renderer bookkeeping (chunks, rebuilds, uploads) against a stand-in WebGL2
 * context that records buffer uploads instead of drawing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Renderer } from '../src/render/renderer.js';
import { Camera } from '../src/render/camera.js';
import { Drawing } from '../src/core/drawing.js';

globalThis.requestAnimationFrame ??= () => 1;
globalThis.cancelAnimationFrame ??= () => {};

function fakeGL() {
  const log = { uploads: 0, buffers: 0 };
  const consts = new Map();
  const gl = new Proxy(
    {},
    {
      get(_, name) {
        if (typeof name !== 'string') return undefined;
        if (name === '__log') return log;
        if (typeof name === 'string' && /^[A-Z0-9_]+$/.test(name)) {
          if (!consts.has(name)) consts.set(name, consts.size + 1);
          return consts.get(name);
        }
        if (name === 'getShaderParameter' || name === 'getProgramParameter') {
          return (o, p) => (p === consts.get('ACTIVE_UNIFORMS') ? 0 : true);
        }
        if (name === 'bufferData') return () => log.uploads++;
        if (name === 'createBuffer') return () => (log.buffers++, {});
        if (name === 'deleteBuffer') return () => log.buffers--;
        if (name.startsWith('create')) return () => ({});
        return () => {};
      },
    },
  );
  return gl;
}

function setup(n) {
  const gl = fakeGL();
  const canvas = { width: 1, height: 1, getContext: () => gl, addEventListener: () => {} };
  const camera = new Camera();
  camera.setSize(1000, 800);
  const r = new Renderer(canvas, camera);
  const d = new Drawing();
  d.transaction('add', () => {
    for (let i = 0; i < n; i++)
      d.add({ type: 'line', layer: '0', color: 256, x1: i, y1: 0, x2: i, y2: 10 });
  });
  r.setDrawing(d);
  d.on((c) => r.applyChange(c));
  camera.fit(0, 0, n, 10);
  r.frame();
  return { r, d, gl };
}

describe('Renderer chunks', () => {
  let t;
  beforeEach(() => {
    t = setup(5000);
  });

  it('builds every chunk once and an edit rebuilds only its chunk', () => {
    expect(t.r.chunks.length).toBe(5);
    expect(t.r.chunks.every((c) => !c.dirty)).toBe(true);
    const id = [...t.d.entities.keys()][2500];
    let builds = 0;
    const orig = t.r._buildChunk.bind(t.r);
    t.r._buildChunk = (c, ctx) => (builds++, orig(c, ctx));
    t.d.transaction('edit', () => t.d.update(id, { x2: 99 }));
    t.r.frame();
    expect(builds).toBe(1);
  });

  it('puts an erased object back in its own chunk and draw order on undo', () => {
    const ids = [...t.d.entities.keys()];
    const id = ids[1500];
    const home = t.r.chunkOf.get(id);
    const chunksBefore = t.r.chunks;
    t.d.transaction('erase', () => t.d.remove(id));
    t.r.frame();
    let builds = 0;
    const orig = t.r._buildChunk.bind(t.r);
    t.r._buildChunk = (c, ctx) => (builds++, orig(c, ctx));
    t.d.undo();
    t.r.frame();
    expect(builds).toBe(1);
    expect(t.r.chunks).toBe(chunksBefore);
    expect(t.r.chunkOf.get(id)).toBe(home);
    // Same order within the chunk as in the drawing.
    const inChunk = [...home.ids];
    expect(inChunk).toEqual(ids.filter((x) => t.r.chunkOf.get(x) === home));
    expect(inChunk.indexOf(id)).toBe(ids.indexOf(id) - ids.indexOf(inChunk[0]));
  });

  it('falls back to a full rebuild when the home chunk is gone', () => {
    const ids = [...t.d.entities.keys()].slice(4096);
    t.d.transaction('erase', () => ids.forEach((id) => t.d.remove(id)));
    t.r.frame();
    expect(t.r.chunks.length).toBe(4);
    t.d.undo();
    t.r.frame();
    expect(t.r.chunks.length).toBe(5);
    expect(t.r.chunkOf.size).toBe(5000);
    expect([...t.r.chunks.at(-1).ids]).toEqual(ids);
  });

  it('redraws at once when a resize clears the canvas', () => {
    let frames = 0;
    const orig = t.r.frame.bind(t.r);
    t.r.frame = () => (frames++, orig());
    t.r.resize(800, 600, 2);
    expect(t.r.canvas.width).toBe(1600);
    expect(frames).toBe(1);
    // Same size: nothing was cleared, so the frame can wait.
    t.r.resize(800, 600, 2);
    expect(frames).toBe(1);
  });

  it('keeps selected construction lines on screen without rebuilding the whole selection', () => {
    let xid;
    t.d.transaction('add', () => {
      xid = t.d.add({ type: 'xline', layer: '0', color: 256, x: 0, y: 0, dx: 1, dy: 0 }).id;
    });
    for (const n of [4000, 6000]) {
      t.r.setSelection(new Set([...t.d.entities.keys()].slice(0, n).concat(xid)));
      t.r.frame();
      const built = [];
      const orig = t.r._buildIds.bind(t.r);
      t.r._buildIds = (gpu, ids, flags, ctx) => (built.push(gpu), orig(gpu, ids, flags, ctx));
      t.r.camera.panBy(500, 0);
      t.r.frame();
      t.r._buildIds = orig;
      expect(built).toContain(t.r.selInfGpu);
      expect(built).not.toContain(t.r.selGpu);
    }
  });
});

describe('Renderer draw-order bands', () => {
  it('puts a new construction line in the last band, as a full rebuild does', () => {
    const { r, d } = setup(1);
    let hatch;
    d.transaction('add', () => {
      hatch = d.add({ type: 'hatch', layer: '0', color: 1, loops: [[0, 0, 0, 100, 0, 0, 100, 100, 0, 0, 100, 0]], pattern: 'SOLID', scale: 1, angle: 0 }).id;
    });
    r.frame();
    // DRAWORDER Back on the line: the hatch moves to band 1.
    d.transaction('Draw order', () => {
      d.update(1, { orderGroup: d.newId() });
      d.reorder([1], false);
    });
    r.frame();
    expect(r.bands.of.get(hatch)).toBe(1);
    let x;
    d.transaction('xline', () => (x = d.add({ type: 'xline', layer: '0', color: 256, x: 50, y: 50, dx: 1, dy: 0 }).id));
    r.frame();
    expect(r.bands.of.get(x)).toBe(1);
    // and objects added after it continue in the same band
    let l;
    d.transaction('line', () => (l = d.add({ type: 'line', layer: '0', color: 256, x1: 0, y1: 5, x2: 9, y2: 5 }).id));
    expect(r.bands.of.get(l)).toBe(1);
  });
});

describe('Renderer linetype patterns', () => {
  it('gives every distinct pattern its own row, past the first 63', () => {
    const { r } = setup(1);
    const rows = [];
    for (let i = 0; i < 300; i++) rows.push(r._patternRow([1 + i, -1]));
    // Rows are stored in a byte per segment: 255 patterns, the rest drawn solid.
    expect(rows.slice(0, 255)).toEqual(Array.from({ length: 255 }, (_, i) => i + 1));
    expect(rows.slice(255).every((x) => x === 0)).toBe(true);
    expect(r._patternRow([70, -1])).toBe(70);
    // The texture holds what was written for the earlier rows.
    expect(r.patternData[1 * 18 + 2]).toBe(1);
    expect(r.patternData[200 * 18 + 2]).toBe(200);
  });
});
