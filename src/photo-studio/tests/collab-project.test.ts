// The shared document model: a document survives the round trip through Yjs,
// concurrent edits of different layers and properties merge, painting on one
// layer merges per tile, the same tile resolves the same way everywhere, and
// layer order and grouping converge.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { layer, newDocument, findLayer, type PhotoDocument } from '../src/model/document';
import { newPixelLayer } from '../src/model/pixel-layer';
import { TileStore, readRGBA, writeRect, TILE } from '../src/model/tiles';
import { Assets } from '../src/model/assets';
import { validateDocument } from '../src/model/serialization';
import { SharedProject, ORIGIN, documentTiles } from '../src/collab/shared-project';
import { TileIndex } from '../src/collab/tile-index';
import { keyBetween, orderKeys } from '../src/collab/order';

function paint(store: TileStore, doc: PhotoDocument, id: string, x: number, y: number, w: number, h: number, value: number) {
  const next = structuredClone(doc);
  const l = findLayer(next.layers, id)!;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set([value, value, value, 255], i);
  l.pixels = writeRect(store, l.pixels!, x, y, { width: w, height: h, data });
  return next;
}
function participant(ydoc?: Y.Doc) {
  const assets = new Assets();
  const tiles = new TileIndex(assets.tiles);
  return { assets, tiles, project: new SharedProject(tiles, ydoc) };
}
type P = ReturnType<typeof participant>;
/** Exchange Yjs state both ways and the tiles each side lacks. */
function exchange(...ps: P[]) {
  for (const a of ps)
    for (const b of ps) if (a !== b) Y.applyUpdate(b.project.ydoc, Y.encodeStateAsUpdate(a.project.ydoc, Y.encodeStateVector(b.project.ydoc)), ORIGIN.remote);
  for (const p of ps) {
    for (const h of p.project.missing(p.assets).tiles) {
      const source = ps.find((q) => q.tiles.tileFor(h))!;
      p.tiles.put(h, source.assets.tiles.get(source.tiles.tileFor(h)!) as unknown as Uint8Array);
    }
    p.project.invalidate();
  }
}
async function write(p: P, before: PhotoDocument | null, after: PhotoDocument) {
  p.project.write(before, after, await p.project.prepare(after, p.assets));
}
const view = (p: P) => p.project.project({ selection: null }).document;
function base() {
  const a = participant();
  const doc = newDocument(600, 400);
  const bg = newPixelLayer('Background', doc);
  const top = newPixelLayer('Top', doc);
  const text = layer('solid', 'Fill', 600, 400);
  doc.layers = [bg, top, text];
  return { a, doc, ids: { bg: bg.id, top: top.id, text: text.id } };
}

describe('shared document model', () => {
  it('round-trips a document with layers, groups and tiles', async () => {
    const { a, doc, ids } = base();
    let d = paint(a.assets.tiles, doc, ids.bg, 10, 10, 300, 300, 200);
    const group = layer('group', 'Group', 600, 400);
    d = structuredClone(d);
    const top = d.layers.splice(1, 1)[0];
    group.children = [top];
    d.layers.splice(1, 0, group);
    d.guides = [{ orientation: 'vertical', position: 40 }];
    await write(a, null, d);
    const b = participant();
    exchange(a, b);
    const out = view(b);
    expect(validateDocument(out)).toBe(out);
    expect(out.layers.map((l) => l.name)).toEqual(['Background', 'Group', 'Fill']);
    expect(out.layers[1].children.map((l) => l.name)).toEqual(['Top']);
    expect(out.guides).toEqual(d.guides);
    const bgOut = findLayer(out.layers, ids.bg)!;
    // Pixel layers take their transform from their (merged) content.
    expect(bgOut.transform).toEqual({ x: 10, y: 10, width: 300, height: 300, rotation: 0 });
    const px = readRGBA(b.assets.tiles, bgOut.pixels!, { x: 20, y: 20, width: 1, height: 1 }).data;
    expect([...px]).toEqual([200, 200, 200, 255]);
    // Identical tiles (two full tiles of one color) are received once.
    const before = view(a);
    const flat = paint(a.assets.tiles, before, ids.top, 0, 0, 2 * TILE, TILE, 7);
    await write(a, before, flat);
    exchange(a, b);
    const topTiles = findLayer(view(b).layers, ids.top)!.pixels!.tiles;
    expect(topTiles['0,0']).toBe(topTiles['1,0']);
    expect(documentTiles(view(b)).size).toBe(5);
  });

  it('merges concurrent edits of different layers and properties', async () => {
    const { a, doc, ids } = base();
    await write(a, null, doc);
    const b = participant();
    exchange(a, b);
    const da = view(a),
      db = view(b);
    const ea = structuredClone(da);
    findLayer(ea.layers, ids.top)!.opacity = 0.5;
    const eb = structuredClone(db);
    findLayer(eb.layers, ids.top)!.name = 'Renamed';
    findLayer(eb.layers, ids.text)!.visible = false;
    await write(a, da, ea);
    await write(b, db, eb);
    exchange(a, b);
    for (const p of [a, b]) {
      const out = view(p);
      expect(findLayer(out.layers, ids.top)).toMatchObject({ opacity: 0.5, name: 'Renamed' });
      expect(findLayer(out.layers, ids.text)!.visible).toBe(false);
    }
  });

  it('merges painting on one layer per tile; the same tile resolves identically everywhere', async () => {
    const { a, doc, ids } = base();
    await write(a, null, doc);
    const b = participant();
    exchange(a, b);
    const da = view(a),
      db = view(b);
    // A paints the first tile, B a far tile; both paint the tile at (1,1).
    let ea = paint(a.assets.tiles, da, ids.top, 0, 0, 50, 50, 10);
    ea = paint(a.assets.tiles, ea, ids.top, TILE + 5, TILE + 5, 20, 20, 30);
    let eb = paint(b.assets.tiles, db, ids.top, 2 * TILE - 40, 10, 30, 30, 60);
    eb = paint(b.assets.tiles, eb, ids.top, TILE + 5, TILE + 5, 20, 20, 90);
    await write(a, da, ea);
    await write(b, db, eb);
    exchange(a, b);
    const pick = (p: P, x: number, y: number) => {
      const l = findLayer(view(p).layers, ids.top)!;
      return readRGBA(p.assets.tiles, l.pixels!, { x, y, width: 1, height: 1 }).data[0];
    };
    for (const p of [a, b]) {
      expect(pick(p, 5, 5)).toBe(10);
      expect(pick(p, 2 * TILE - 30, 20)).toBe(60);
    }
    // Last writer wins per tile, decided the same way for everyone.
    expect(pick(a, TILE + 10, TILE + 10)).toBe(pick(b, TILE + 10, TILE + 10));
    expect([30, 90]).toContain(pick(a, TILE + 10, TILE + 10));
    // The merged transform follows the merged content.
    const l = findLayer(view(a).layers, ids.top)!;
    expect(l.transform).toMatchObject({ x: 0, y: 0, width: 2 * TILE - 10, height: TILE + 25 });
  });

  it('keeps concurrent reordering, grouping and deletion consistent', async () => {
    const { a, doc, ids } = base();
    await write(a, null, doc);
    const b = participant(),
      c = participant();
    exchange(a, b, c);
    const da = view(a),
      db = view(b),
      dc = view(c);
    // A moves Fill to the bottom; B deletes Background; C adds a layer on top.
    const ea = structuredClone(da);
    ea.layers.unshift(ea.layers.pop()!);
    const eb = structuredClone(db);
    eb.layers = eb.layers.filter((l) => l.id !== ids.bg);
    const ec = structuredClone(dc);
    const added = layer('solid', 'New', 10, 10);
    ec.layers.push(added);
    await write(a, da, ea);
    await write(b, db, eb);
    await write(c, dc, ec);
    exchange(a, b, c);
    const names = view(a).layers.map((l) => l.name);
    expect(names).toEqual(['Fill', 'Top', 'New']);
    expect(view(b).layers.map((l) => l.name)).toEqual(names);
    expect(view(c).layers.map((l) => l.name)).toEqual(names);
  });

  it('breaks a cycle from concurrent moves into each other', async () => {
    const a = participant();
    const doc = newDocument(100, 100);
    const g1 = layer('group', 'G1', 100, 100),
      g2 = layer('group', 'G2', 100, 100);
    doc.layers = [g1, g2];
    await write(a, null, doc);
    const b = participant();
    exchange(a, b);
    const da = view(a),
      db = view(b);
    const ea = structuredClone(da);
    ea.layers = [{ ...ea.layers[1], children: [ea.layers[0]] }];
    const eb = structuredClone(db);
    eb.layers = [{ ...eb.layers[0], children: [eb.layers[1]] }];
    await write(a, da, ea);
    await write(b, db, eb);
    exchange(a, b);
    const out = view(a);
    expect(JSON.stringify(out.layers.map((l) => l.id))).toBe(JSON.stringify(view(b).layers.map((l) => l.id)));
    expect(out.layers.length).toBe(1);
    expect(out.layers[0].children.length).toBe(1);
    expect(validateDocument(out)).toBe(out);
  });

  it('keeps each person’s selection private', async () => {
    const { a, doc } = base();
    const withSel = { ...doc, selection: { x: 1, y: 2, width: 3, height: 4 } };
    await write(a, null, withSel);
    const b = participant();
    exchange(a, b);
    expect(view(b).selection).toBeNull();
    expect(a.project.doc.has('selection')).toBe(false);
  });

  it('order keys sort between neighbors and keep unchanged ones', () => {
    let k = keyBetween(null, null);
    const keys = [k];
    for (let i = 0; i < 50; i++) keys.push((k = keyBetween(k, null)));
    expect([...keys].sort()).toEqual(keys);
    const mid = keyBetween(keys[3], keys[4]);
    expect(mid > keys[3] && mid < keys[4]).toBe(true);
    const current = new Map([['a', keys[0]], ['b', keys[1]], ['c', keys[2]]]);
    const out = orderKeys(['c', 'a', 'b'], (id) => current.get(id));
    expect([...out.keys()]).toEqual(['c']);
    const final = (id: string) => out.get(id) ?? current.get(id)!;
    expect(final('c') < final('a') && final('a') < final('b')).toBe(true);
  });
});
