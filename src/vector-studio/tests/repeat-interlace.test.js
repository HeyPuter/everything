import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootAppWithFeatures } from './helpers.js';
import { setGeomSource } from '../src/features/geometry/engine/index.js';
import { createPath } from '../src/model/nodes.js';
import { ellipse, rectangle } from '../src/model/shapes.js';
import { liveArtwork, expandLive } from '../src/model/live.js';
import { nodeBounds, transformNodes } from '../src/model/geometry.js';
import { translate } from '../src/lib/matrix.js';
import { exportSVG } from '../src/features/io/svg-export.js';
import { orderAt, inZone, zoneBounds, objectsAt, pieceAt } from '../src/features/interlace/interlace-model.js';
import { overlapZoneAt } from '../src/features/interlace/index.js';

beforeAll(() => {
  setGeomSource(fs.readFileSync(path.resolve(__dirname, '../src/wasm/geom.wasm')));
});

const ring = (cx, color) => createPath(ellipse(cx - 50, 50, 100, 100), true, { fill: null, stroke: { type: 'solid', color }, strokeWidth: 14 });

function ev(app, x, y, extra = {}) {
  const s = app.editor.view.toScreen(x, y);
  return { x, y, sx: s.x, sy: s.y, shift: false, alt: false, mod: false, button: 0, pointerType: 'mouse', pressure: 0.5, native: {}, ...extra };
}

describe('interlace', () => {
  let app;
  let doc;
  let red;
  let blue;
  beforeEach(async () => {
    app = await bootAppWithFeatures();
    app.newDocument();
    app.editor.view.set({ zoom: 1, panX: 0, panY: 0, rotation: 0, width: 1000, height: 800 });
    doc = app.editor.doc;
    red = ring(100, '#ff0000');
    blue = ring(170, '#0000ff');
    doc.transact('add', () => {
      doc.insert(red, doc.layers()[0].id);
      doc.insert(blue, doc.layers()[0].id);
    });
    app.editor.select([red.id, blue.id]);
  });

  // The rings' center lines cross at x = 135, y = 100 +- sqrt(50^2 - 35^2).
  const dy = Math.sqrt(50 * 50 - 35 * 35);
  const top = { x: 135, y: 100 - dy };
  const bottom = { x: 135, y: 100 + dy };

  it('Make groups the rings and enters zone editing', async () => {
    await app.commands.run('interlace.make');
    const g = app.editor.topSelection()[0];
    expect(doc.get(g).live.kind).toBe('interlace');
    expect(doc.get(g).children).toEqual([red.id, blue.id]);
    expect(app.toolId).toBe('interlace');
    expect(objectsAt(doc, doc.get(g), top.x, top.y).sort()).toEqual([red.id, blue.id].sort());
  });

  it('finds the overlap zone around a click from the stroked outlines', async () => {
    await app.commands.run('interlace.make');
    const g = doc.get(app.editor.topSelection()[0]);
    const zone = await overlapZoneAt(doc, g, top.x, top.y);
    expect(zone).toBeTruthy();
    const b = zoneBounds(zone);
    // A small patch around the upper crossing, not the lower one.
    expect(b.w).toBeLessThan(40);
    expect(b.h).toBeLessThan(40);
    expect(inZone(zone, top.x, top.y)).toBe(true);
    expect(inZone(zone, bottom.x, bottom.y)).toBe(false);
    expect(await overlapZoneAt(doc, g, 60, 100)).toBe(null);
  });

  it('clicking brings the lower ring in front at that crossing only; Option sends it back', async () => {
    await app.commands.run('interlace.make');
    const gid = app.editor.topSelection()[0];
    const tool = app.tool;
    tool.onPointerDown(ev(app, top.x, top.y));
    await tool.onPointerUp(ev(app, top.x, top.y));
    let g = doc.get(gid);
    expect(g.live.zones).toHaveLength(1);
    expect(doc.undoLabel).toBe('Interlace');
    expect(orderAt(g, top.x, top.y)).toEqual([blue.id, red.id]);
    expect(orderAt(g, bottom.x, bottom.y)).toEqual([red.id, blue.id]);
    // The zone draws clipped copies of both rings, red on top.
    const items = liveArtwork(doc, g).items;
    expect(items).toHaveLength(3);
    const zoneGroup = items[2];
    expect(zoneGroup.clip).toBe(true);
    const { vdoc } = liveArtwork(doc, g);
    expect(vdoc.get(zoneGroup.children[1]).source).toBe(red.id);
    // Option+click at the same place sends red back: the zone goes away.
    tool.onPointerDown(ev(app, top.x, top.y, { alt: true }));
    await tool.onPointerUp(ev(app, top.x, top.y, { alt: true }));
    g = doc.get(gid);
    expect(g.live.zones).toHaveLength(0);
    doc.undo();
    expect(doc.get(gid).live.zones).toHaveLength(1);
  });

  it('zones move with the group, export, expand and release', async () => {
    await app.commands.run('interlace.make');
    const gid = app.editor.topSelection()[0];
    const tool = app.tool;
    tool.onPointerDown(ev(app, bottom.x, bottom.y));
    await tool.onPointerUp(ev(app, bottom.x, bottom.y));
    expect(tool.onKeyDown({ key: 'Escape' })).toBe(true);
    expect(app.toolId).toBe('selection');
    expect([...app.editor.selection]).toEqual([gid]);
    doc.transact('move', () => transformNodes(doc, [gid], translate(100, 0)));
    const g = doc.get(gid);
    expect(orderAt(g, bottom.x + 100, bottom.y)).toEqual([blue.id, red.id]);
    const svg = exportSVG(doc, { rect: { x: 0, y: 0, w: 500, h: 300 } });
    expect(svg).toContain('clipPath');
    let ex;
    doc.transact('expand', () => {
      ex = expandLive(doc, gid);
    });
    expect(ex.children).toHaveLength(3);
    expect(doc.get(ex.children[2]).clip).toBe(true);
    doc.undo();
    app.editor.select([gid]);
    await app.commands.run('interlace.release');
    expect(doc.get(gid)).toBeUndefined();
    expect(doc.get(red.id).parent).toBe(doc.layers()[0].id);
    // Edit re-enters zone editing.
    doc.undo();
    app.editor.select([gid]);
    await app.commands.run('interlace.edit');
    expect(app.toolId).toBe('interlace');
  });

  it('copies keep their zones: paste, paste into another document, duplicate and Alt-drag', async () => {
    await app.commands.run('interlace.make');
    const gid = app.editor.topSelection()[0];
    const tool = app.tool;
    tool.onPointerDown(ev(app, top.x, top.y));
    await tool.onPointerUp(ev(app, top.x, top.y));
    tool.onKeyDown({ key: 'Escape' });
    const crossing = (d, id) => {
      const g = d.get(id);
      expect(g.live.zones).toHaveLength(1);
      expect(g.live.zones[0].order.every((c) => g.children.includes(c))).toBe(true);
      // Inside the zone the copied red ring (the group's first child) is in front.
      expect(orderAt(g, top.x, top.y)).toEqual([g.children[1], g.children[0]]);
      expect(liveArtwork(d, g).items).toHaveLength(3);
    };
    app.editor.select([gid]);
    await app.commands.run('edit.copy');
    await app.commands.run('edit.pasteInPlace');
    crossing(doc, app.editor.topSelection()[0]);
    app.editor.select([gid]);
    await app.commands.run('edit.duplicate');
    crossing(doc, app.editor.topSelection()[0]);
    const { node, descendants } = doc.cloneSubtree(gid);
    doc.transact('Copy', () => doc.insert(node, doc.layers()[0].id, Infinity, descendants));
    crossing(doc, node.id);
    app.newDocument();
    await app.commands.run('edit.pasteInPlace');
    crossing(app.editor.doc, app.editor.topSelection()[0]);
  });

  it('keeps its crossings inside a symbol instance and a repeat', async () => {
    await app.commands.run('interlace.make');
    const gid = app.editor.topSelection()[0];
    const tool = app.tool;
    tool.onPointerDown(ev(app, top.x, top.y));
    await tool.onPointerUp(ev(app, top.x, top.y));
    tool.onKeyDown({ key: 'Escape' });
    // The generated interlace inside another live object still draws its zone (3 items: 2 rings + zone).
    const inner = (id) => {
      const { items, vdoc } = liveArtwork(doc, doc.get(id));
      return items.map((n) => liveArtwork(vdoc, n).items.length);
    };
    app.editor.select([gid]);
    await app.commands.run('repeat.grid');
    const rep = app.editor.topSelection()[0];
    expect(inner(rep).every((k) => k === 3)).toBe(true);
    doc.undo();
    app.editor.select([gid]);
    await app.commands.run('symbol.new', { direct: true, name: 'Rings' });
    expect(inner(app.editor.topSelection()[0])).toEqual([3]);
  });

  it('a dragged loop makes a freehand zone', async () => {
    await app.commands.run('interlace.make');
    const gid = app.editor.topSelection()[0];
    const tool = app.tool;
    const c = top;
    tool.onPointerDown(ev(app, c.x - 15, c.y - 15));
    for (const [x, y] of [[c.x + 15, c.y - 15], [c.x + 15, c.y + 15], [c.x - 15, c.y + 15], [c.x - 15, c.y - 14]]) tool.onPointerMove(ev(app, x, y));
    await tool.onPointerUp(ev(app, c.x - 15, c.y - 14));
    const g = doc.get(gid);
    expect(g.live.zones).toHaveLength(1);
    expect(orderAt(g, c.x, c.y)).toEqual([blue.id, red.id]);
    expect(zoneBounds(g.live.zones[0]).w).toBeCloseTo(30, 0);
  });

  it('picks the piece around a point from a result with holes', () => {
    const outer = { anchors: rectangle(0, 0, 100, 100), closed: true };
    const hole = { anchors: rectangle(25, 25, 50, 50).reverse(), closed: true };
    const other = { anchors: rectangle(200, 0, 10, 10), closed: true };
    const piece = pieceAt([outer, hole, other], 10, 10);
    expect(piece).toHaveLength(2);
    expect(pieceAt([outer, hole, other], 50, 50)).toBe(null);
    expect(pieceAt([outer, hole, other], 205, 5)).toHaveLength(1);
    expect(nodeBounds).toBeTruthy();
  });
});
