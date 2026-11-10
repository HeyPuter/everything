/**
 * Renderer bookkeeping (chunks, rebuilds, uploads) against a stand-in WebGL2
 * context that records buffer uploads instead of drawing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Renderer, HOME_LIMIT } from '../src/render/renderer.js';
import { Camera } from '../src/render/camera.js';
import { SEG_VS, TRI_VS } from '../src/render/shaders.js';
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

  it('does not remember the chunk of every object ever erased', () => {
    // A long session of drawing and erasing, 1000 objects at a time.
    for (let k = 0; k < 300; k++) {
      const ids = [];
      t.d.transaction('add', () => {
        for (let i = 0; i < 1000; i++) ids.push(t.d.add({ type: 'line', layer: '0', color: 256, x1: i, y1: 20, x2: i, y2: 30 }).id);
      });
      t.d.transaction('erase', () => ids.forEach((id) => t.d.remove(id)));
    }
    expect(t.r.homeOf.size).toBeLessThanOrEqual(HOME_LIMIT);
    // The latest erase still goes back into its chunk without a full rebuild.
    const id = [...t.d.entities.keys()][1500];
    const home = t.r.chunkOf.get(id);
    t.d.transaction('erase', () => t.d.remove(id));
    const chunks = t.r.chunks;
    t.d.undo();
    expect(t.r.chunks).toBe(chunks);
    expect(t.r.chunkOf.get(id)).toBe(home);
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

describe('Renderer block changes', () => {
  const line = (x2) => ({ type: 'line', layer: '0', color: 256, x1: 0, y1: 0, x2, y2: 1 });
  const insert = (name) => ({ type: 'insert', layer: '0', color: 256, name, x: 0, y: 0, sx: 1, sy: 1, rot: 0 });

  it('does not rebuild everything for a block no reference uses', () => {
    const { r, d } = setup(3000);
    let rebuilds = 0;
    const orig = r.rebuildAll.bind(r);
    r.rebuildAll = () => (rebuilds++, orig());
    d.transaction('block', () => d.setBlock('Unused', { name: 'Unused', bx: 0, by: 0, entities: [line(1)] }));
    d.transaction('purge', () => d.setBlock('Unused', null));
    expect(rebuilds).toBe(0);
    // A block made from objects and inserted in the same step (BLOCK command).
    d.transaction('BLOCK', () => {
      d.remove(1);
      d.setBlock('B', { name: 'B', bx: 0, by: 0, entities: [line(2)] });
      d.add(insert('B'));
    });
    expect(rebuilds).toBe(0);
    // Redefining a block that is in use still rebuilds.
    d.transaction('redefine', () => d.setBlock('B', { ...d.blocks.get('B'), entities: [line(3)] }));
    expect(rebuilds).toBe(1);
  });

  it('places a later reference to a nested block that gained a construction line as infinite', () => {
    const { r, d } = setup(1);
    d.transaction('blocks', () => {
      d.setBlock('X', { name: 'X', bx: 0, by: 0, entities: [line(1)] });
      d.setBlock('Y', { name: 'Y', bx: 0, by: 0, entities: [insert('X')] });
    });
    // Ask once so the "has construction lines" answer for Y is cached.
    expect(r._isInfinite(insert('Y'))).toBe(false);
    d.transaction('redefine', () => d.setBlock('X', { name: 'X', bx: 0, by: 0, entities: [{ type: 'xline', layer: '0', color: 256, x: 0, y: 0, dx: 1, dy: 0 }] }));
    let id;
    d.transaction('insert', () => (id = d.add(insert('Y')).id));
    expect(r.infinite.has(id)).toBe(true);
  });
});

describe('Renderer long lines', () => {
  it('cuts a line far longer than the view and rebuilds once the view leaves the cut part', () => {
    const t = setup(10);
    t.d.transaction('add', () => {
      t.d.add({ type: 'line', layer: '0', color: 256, x1: -1e6, y1: -1e6, x2: 1e6, y2: 1e6 });
    });
    t.r.camera.state = { cx: 0, cy: 0, scale: 1e4 };
    t.r.frame();
    const c = t.r.chunks[0];
    expect(c.safe).toBeTruthy();
    let builds = 0;
    const orig = t.r._buildChunk.bind(t.r);
    t.r._buildChunk = (ch, ctx) => (builds++, orig(ch, ctx));
    // Panning within the cut part reuses the buffers.
    t.r.camera.panBy(-3000, 3000);
    t.r.frame();
    expect(builds).toBe(0);
    // Far along the line the cut part has run out.
    t.r.camera.state = { cx: 500, cy: 500, scale: 1e4 };
    t.r.frame();
    expect(builds).toBe(1);
    expect(c.safe[0]).toBeLessThan(500);
    expect(c.safe[2]).toBeGreaterThan(500);
  });

  it('leaves drawings without such lines alone', () => {
    const t = setup(2000);
    expect(t.r.chunks.every((c) => !c.safe)).toBe(true);
  });
});

describe('Renderer very large curves', () => {
  it('tessellates the part in view exactly and rebuilds once the view leaves it', () => {
    const t = setup(10);
    const R = 1e5;
    t.d.transaction('add', () => {
      t.d.add({ type: 'circle', layer: '0', color: 256, cx: 0, cy: 0, r: R });
    });
    // Looking at the circle between two vertices of its 4096-chord outline.
    const a = Math.PI / 4096;
    t.r.camera.state = { cx: R * Math.cos(a), cy: R * Math.sin(a), scale: 1000 };
    const lines = [];
    const line = t.r.batch.line.bind(t.r.batch);
    t.r.batch.line = (pts, closed, style) => (lines.push(pts), line(pts, closed, style));
    t.r.frame();
    const c = t.r.chunks[0];
    expect(c.safe).toBeTruthy();
    // Every chord crossing the view stays within a quarter pixel of the circle.
    const v = t.r.camera.bounds();
    const pts = lines.find((p) => p.length > 8000);
    let seen = 0,
      worst = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const mx = (pts[i] + pts[i + 2]) / 2,
        my = (pts[i + 1] + pts[i + 3]) / 2;
      if (Math.min(pts[i], pts[i + 2]) > v[2] || Math.max(pts[i], pts[i + 2]) < v[0]) continue;
      if (Math.min(pts[i + 1], pts[i + 3]) > v[3] || Math.max(pts[i + 1], pts[i + 3]) < v[1]) continue;
      seen++;
      worst = Math.max(worst, R - Math.hypot(mx, my));
    }
    expect(seen).toBeGreaterThan(0);
    expect(worst * 1000).toBeLessThan(0.26);
    expect(pts.length / 2).toBeLessThan(4096 + 3000);
    t.r.batch.line = line;
    let builds = 0;
    const orig = t.r._buildChunk.bind(t.r);
    t.r._buildChunk = (ch, ctx) => (builds++, orig(ch, ctx));
    t.r.camera.panBy(-3000, 3000);
    t.r.frame();
    expect(builds).toBe(0);
    // A quarter turn away the exact part has run out.
    t.r.camera.state = { cx: 0, cy: R, scale: 1000 };
    t.r.frame();
    expect(builds).toBe(1);
    expect(c.safe[3]).toBeGreaterThan(R);
  });

  it('leaves ordinary curves alone', () => {
    const t = setup(10);
    t.d.transaction('add', () => {
      t.d.add({ type: 'circle', layer: '0', color: 256, cx: 0, cy: 0, r: 500 });
      t.d.add({ type: 'polyline', layer: '0', color: 256, pts: [0, 0, 1, 50, 0, 0, 50, 50, 0], closed: true });
    });
    t.r.camera.state = { cx: 500, cy: 0, scale: 100 };
    t.r.frame();
    expect(t.r.chunks.every((c) => !c.safe)).toBe(true);
  });
});

describe('Camera fit', () => {
  it('fits inside the margins', () => {
    const c = new Camera();
    c.setSize(1000, 800);
    c.fit(0, 0, 100, 100, 24);
    expect(c.scale).toBeCloseTo(7.52, 6);
    expect([c.cx, c.cy]).toEqual([50, 50]);
  });

  it('does not zoom out to nothing on a canvas squeezed to no height', () => {
    const c = new Camera();
    // A short window leaves the canvas no height at all.
    c.setSize(667, 0);
    c.fit(0, 0, 100, 100, 24);
    expect(c.scale).toBeCloseTo(6.19, 6);
    // Smaller than the margins: they give way.
    c.setSize(667, 40);
    c.fit(0, 0, 100, 100, 24);
    expect(c.scale).toBeCloseTo(0.2, 6);
    // No size at all: the zoom is kept.
    c.setSize(0, 0);
    c.scale = 3;
    c.fit(0, 0, 100, 100, 24);
    expect(c.scale).toBe(3);
    expect([c.cx, c.cy]).toEqual([50, 50]);
  });
});

describe('Shaders', () => {
  it('keep vertex positions exact where the compiler uses fast math', () => {
    // Metal regroups (hi - camHi) + (lo - camLo) unless the position is
    // invariant, which loses the low parts far from the origin.
    for (const src of [SEG_VS, TRI_VS]) expect(src).toMatch(/^invariant gl_Position;$/m);
  });
});
