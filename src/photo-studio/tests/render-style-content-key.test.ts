import { describe, expect, it } from 'vitest';
import { StyleCache } from '../src/renderer/layer-style';
import { layer, type Layer } from '../src/model/document';
import type { Backend } from '../src/renderer/backend';
import type { Assets } from '../src/model/assets';

// A styled group's cached effects are keyed by its content. Large groups
// (many full-size photos) serialize to hundreds of kilobytes.
function bigGroup(childBlend: Layer['blend'], childX: number): Layer {
  const g = layer('group', 'Photos', 6000, 4000);
  for (let n = 0; n < 24; n++) {
    const c = layer('pixel', `Photo ${n}`, 6000, 4000);
    const tiles: Record<string, string> = {};
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 24; x++) tiles[`${x},${y}`] = `tile-${n}-${x}-${y}`;
    c.id = `child-${n}`;
    c.pixels = {
      channels: 4,
      x: 0,
      y: 0,
      tiles,
      bounds: { x: 0, y: 0, width: 6000, height: 4000 },
    } as Layer['pixels'];
    if (n === 3) {
      c.blend = childBlend;
      c.transform = { ...c.transform, x: childX };
    }
    g.children.push(c);
  }
  g.id = 'group';
  return g;
}

describe('layer style content key', () => {
  const cache = new StyleCache({} as Backend) as unknown as {
    contentKey(l: Layer, assets: Assets, fast: boolean, pin: boolean): string;
  };
  const assets = { tiles: { version: () => 0 } } as unknown as Assets;
  const key = (l: Layer) => cache.contentKey(l, assets, false, false);

  it('changes when a child of a large group changes blend mode', () => {
    expect(JSON.stringify(bigGroup('normal', 100)).length).toBeGreaterThan(200000);
    expect(key(bigGroup('normal', 100))).not.toBe(key(bigGroup('screen', 100)));
  });
  it('changes when a child of a large group moves', () => {
    expect(key(bigGroup('normal', 100))).not.toBe(key(bigGroup('normal', 200)));
  });
  it('stays the same for identical content', () => {
    expect(key(bigGroup('normal', 100))).toBe(key(bigGroup('normal', 100)));
  });
});

describe('layer style cache memory', () => {
  // A result whose single layer texture holds `mb` megabytes.
  const result = (mb: number) => ({
    contentKey: '',
    styleKey: '',
    anchor: { x: 0, y: 0 },
    pinned: false,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    below: [],
    layer: { width: 1024, height: mb * 256, handle: {}, format: 'rgba8unorm' },
    above: [],
  });
  function setup() {
    const destroyed: unknown[] = [];
    const cache = new StyleCache({
      destroy: (t: unknown) => destroyed.push(t),
    } as unknown as Backend);
    const inner = cache as unknown as {
      entries: Map<string, { result?: ReturnType<typeof result>; seen: number }>;
      frame: number;
      pruned: number;
    };
    return { cache, inner, destroyed };
  }

  it('releases styles not drawn in the last frame beyond the budget, oldest first', () => {
    const { cache, inner, destroyed } = setup();
    const a = result(200),
      b = result(200),
      c = result(100);
    inner.entries.set('a', { result: a, seen: 10 });
    inner.entries.set('b', { result: b, seen: 5 });
    inner.entries.set('c', { result: c, seen: 3 });
    inner.frame = 10;
    inner.pruned = 8;
    cache.prune(new Set(['a', 'b', 'c']));
    expect(destroyed).toEqual([c.layer]);
    expect([...inner.entries.keys()]).toEqual(['a', 'b']);
  });
  it('keeps styles that were drawn, and idle ones within the budget', () => {
    const { cache, inner, destroyed } = setup();
    inner.entries.set('a', { result: result(300), seen: 10 });
    inner.entries.set('b', { result: result(100), seen: 5 });
    inner.frame = 10;
    inner.pruned = 8;
    cache.prune(new Set(['a', 'b']));
    expect(destroyed).toEqual([]);
    expect(inner.entries.size).toBe(2);
  });
});
