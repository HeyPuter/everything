import { describe, expect, it } from 'vitest';
import { DocumentSession, tileHolders } from '../src/app/session';
import { emptyGrid, gridTileIds, readRGBA, writeRect } from '../src/model/tiles';
import { StrokeSession } from '../src/engine/paint';

describe('tile cleanup', () => {
  it('keeps tiles held outside documents (Quick Mask) and frees the rest', () => {
    const s = new DocumentSession();
    const store = s.assets.tiles;
    const held = writeRect(store, emptyGrid(1), 0, 0, { width: 4, height: 4, data: new Uint8Array(16).fill(255) });
    const loose = writeRect(store, emptyGrid(1), 0, 0, { width: 4, height: 4, data: new Uint8Array(16).fill(9) });
    const holder = () => gridTileIds(held);
    tileHolders.push(holder);
    try {
      s.collectTiles();
      for (const id of gridTileIds(held)) expect(store.has(id)).toBe(true);
      for (const id of gridTileIds(loose)) expect(store.has(id)).toBe(false);
    } finally {
      tileHolders.splice(tileHolders.indexOf(holder), 1);
    }
    s.collectTiles();
    for (const id of gridTileIds(held)) expect(store.has(id)).toBe(false);
  });
  it('keeps the tiles of a stroke being painted, so the committed stroke has its pixels', () => {
    const s = new DocumentSession();
    const store = s.assets.tiles;
    const tip = { size: 20, hardness: 1, spacing: 0.25, roundness: 1, angle: 0 };
    const rgb: [number, number, number] = [255, 0, 0];
    const target = { kind: 'color' as const, rgb, mode: 'normal' as const };
    const stroke = new StrokeSession(store, emptyGrid(4), { tip, opacity: 1, flow: 1, target });
    stroke.addPoint(10, 10);
    // Another edit's cleanup runs while the stroke is being painted.
    s.collectTiles();
    stroke.addPoint(300, 10);
    const grid = stroke.commit();
    const px = readRGBA(store, grid, { x: 10, y: 10, width: 1, height: 1 }).data;
    expect([...px]).toEqual([255, 0, 0, 255]);
    // Committed, the tiles are the document's to keep: the stroke holds none.
    s.collectTiles();
    expect([...gridTileIds(grid)].some((id) => store.has(id))).toBe(false);
    // A cancelled stroke holds nothing either.
    const cancelled = new StrokeSession(store, emptyGrid(4), { tip, opacity: 1, flow: 1, target });
    cancelled.addPoint(10, 10);
    const ids = [...gridTileIds(cancelled.grid)];
    cancelled.cancel();
    expect(ids.some((id) => store.has(id))).toBe(false);
  });
});
