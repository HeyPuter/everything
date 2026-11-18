import { makeBackground } from '../src/model/housekeeping';
import { describe, expect, it } from 'vitest';
import { cropDocument, layer, newDocument, resizeDocument } from '../src/model/document';
import {
  artboardAt,
  artboardFill,
  artboardFromLayers,
  besideRect,
  createArtboard,
  dragRect,
  expandCanvasToArtboards,
  layerBounds,
  matchingPreset,
  nestIntoArtboards,
  newArtboardRect,
  placeDuplicateArtboards,
  canvasGrowth,
} from '../src/model/artboard';
import { moveLayers, groupLayers } from '../src/model/layers';
import { selectionFrame, transformSelection, snapTargets } from '../src/model/transform';
import { validateDocument } from '../src/model/serialization';
import { createFrame, ellipseCoverage, fitRect, frameAt, frameContains, placeInFrame } from '../src/model/frame';
import { mapRect } from '../src/model/layout-geometry';

function board(doc = newDocument(2000, 1000)) {
  const a = createArtboard(doc, { x: 0, y: 0, width: 400, height: 800 });
  doc.layers.push(a);
  const b = createArtboard(doc, { x: 500, y: 0, width: 400, height: 800 });
  doc.layers.push(b);
  return { doc, a, b };
}

describe('artboard geometry', () => {
  it('names artboards, resolves backgrounds and labels preset sizes', () => {
    const { doc, a, b } = board();
    expect([a.name, b.name]).toEqual(['Artboard 1', 'Artboard 2']);
    expect(artboardFill(a.artboard)).toBe('#ffffff');
    expect(artboardFill({ ...a.artboard, background: 'transparent' })).toBeNull();
    expect(artboardFill({ ...a.artboard, background: 'custom', color: '#123456' })).toBe('#123456');
    expect(matchingPreset(1080, 1920)?.id).toBe('social-story');
    expect(matchingPreset(1920, 1080, 'full-hd')?.id).toBe('full-hd');
    expect(validateDocument(doc)).toBe(doc);
  });
  it('places neighbors beside an artboard without overlapping others', () => {
    const { doc, a, b } = board();
    const gap = 40;
    const right = besideRect(doc, a.artboard.rect, 'right');
    // The slot to the right of A is taken by B, so the new one goes past it.
    expect(right.x).toBe(b.artboard.rect.x + 400 + gap);
    expect(besideRect(doc, a.artboard.rect, 'bottom')).toEqual({ x: 0, y: 800 + gap, width: 400, height: 800 });
    expect(besideRect(doc, a.artboard.rect, 'left').x).toBe(-gap - 400);
    expect(newArtboardRect(doc, 100, 100)).toEqual({ x: 900 + gap, y: 0, width: 100, height: 100 });
    expect(dragRect([10.4, 50], [3, 2])).toEqual({ x: 3, y: 2, width: 7, height: 48 });
  });
  it('picks the topmost artboard and reparents layers dragged across artboards', () => {
    const { doc, a, b } = board();
    const l = layer('solid', 'Box', 50, 50);
    l.transform = { x: 100, y: 100, width: 50, height: 50, rotation: 0 };
    a.children.push(l);
    expect(artboardAt(doc, 120, 120)).toBe(a);
    expect(artboardAt(doc, 450, 120)).toBeUndefined();
    l.transform.x = 600;
    expect(nestIntoArtboards(doc, [l.id])).toBe(true);
    expect(b.children).toEqual([l]);
    expect(a.children).toEqual([]);
    // Dropped between artboards: back onto the canvas, just above its old artboard.
    l.transform.x = 420;
    nestIntoArtboards(doc, [l.id]);
    expect(doc.layers.map((x) => x.id)).toEqual([a.id, b.id, l.id]);
    l.transform.x = 50;
    nestIntoArtboards(doc, [l.id]);
    expect(a.children).toEqual([l]);
    expect(nestIntoArtboards(doc, [l.id])).toBe(false);
  });
  it('wraps layers or a group into an artboard sized to their bounds', () => {
    const doc = newDocument(800, 600);
    const x = layer('solid', 'X', 10, 10),
      y = layer('solid', 'Y', 10, 10);
    x.transform = { x: 10.5, y: 20, width: 100, height: 50, rotation: 0 };
    y.transform = { x: 200, y: 100, width: 30, height: 30, rotation: 0 };
    doc.layers = [x, y];
    const id = artboardFromLayers(doc, new Set([x.id, y.id]));
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0].id).toBe(id);
    expect(doc.layers[0].artboard!.rect).toEqual({ x: 10, y: 20, width: 220, height: 110 });
    expect(doc.layers[0].children).toEqual([x, y]);
    expect(() => artboardFromLayers(doc, new Set([x.id]))).toThrow();
    const doc2 = newDocument(800, 600);
    const g = layer('group', 'G', 800, 600);
    g.blend = 'pass through';
    g.children = [x];
    doc2.layers = [g];
    expect(artboardFromLayers(doc2, new Set([g.id]), true)).toBe(g.id);
    expect(g.artboard!.rect).toEqual({ x: 10, y: 20, width: 101, height: 50 });
    expect(g.blend).toBe('normal');
  });
  it('leaves the Background and locked layers out of Artboard from Layers, as Group does', () => {
    const doc = newDocument(800, 600);
    const bg = layer('solid', 'Background', 800, 600);
    makeBackground(bg);
    const x = layer('solid', 'X', 10, 10);
    doc.layers = [bg, x];
    expect(() => artboardFromLayers(doc, new Set([bg.id, x.id]))).toThrow(/Background/);
    x.locked = true;
    expect(() => artboardFromLayers(doc, new Set([x.id]))).toThrow(/Unlock/);
    expect(doc.layers).toEqual([bg, x]);
    x.locked = false;
    artboardFromLayers(doc, new Set([x.id]));
    expect(doc.layers[0]).toBe(bg);
    expect(doc.layers[1].children).toEqual([x]);
  });
  it('keeps artboards at the top level', () => {
    const { doc, a, b } = board();
    expect(() => moveLayers(doc, new Set([b.id]), a.id, 'inside')).toThrow(/top level/);
    expect(() => groupLayers(doc, new Set([a.id]))).toThrow(/top level/);
    const bad = structuredClone(doc);
    bad.layers[0].children.push(structuredClone(bad.layers[1]));
    bad.layers[0].children[0].id = 'nested';
    expect(() => validateDocument(bad)).toThrow(/artboard/i);
  });
  it('moves artboards with their contents and snaps to their edges', () => {
    const { doc, a } = board();
    const l = layer('solid', 'Box', 50, 50);
    l.transform = { x: 100, y: 100, width: 50, height: 50, rotation: 0 };
    a.children.push(l);
    const before = selectionFrame([a])!;
    expect(before).toEqual({ x: 0, y: 0, width: 400, height: 800, rotation: 0 });
    transformSelection([a], before, { ...before, x: 30, y: 10 });
    expect(a.artboard.rect).toEqual({ x: 30, y: 10, width: 400, height: 800 });
    expect(l.transform.x).toBe(130);
    expect(() => transformSelection([a], before, { ...before, rotation: 10 })).toThrow(/rotated/);
    const t = snapTargets(doc, [l]);
    expect(t.x).toContain(430);
    expect(t.x).toContain(900);
    // An empty artboard still has a frame to drag.
    expect(selectionFrame([createArtboard(doc, { x: 5, y: 6, width: 7, height: 8 })])).toMatchObject({ x: 5, y: 6, width: 7, height: 8 });
  });
  it('grows the canvas to contain artboards and follows crops and resizes', () => {
    const doc = newDocument(500, 500);
    const a = createArtboard(doc, { x: -100, y: 50, width: 300, height: 600 });
    const l = layer('solid', 'L', 10, 10);
    l.transform = { x: 0, y: 0, width: 10, height: 10, rotation: 0 };
    doc.layers = [a, l];
    expect(expandCanvasToArtboards(doc)).toEqual({ dx: 100, dy: 0 });
    expect([doc.width, doc.height]).toEqual([600, 650]);
    expect(a.artboard.rect).toEqual({ x: 0, y: 50, width: 300, height: 600 });
    expect(l.transform.x).toBe(100);
    expect(expandCanvasToArtboards(doc)).toBeUndefined();
    cropDocument(doc, { x: 10, y: 10, width: 400, height: 400 });
    expect(a.artboard.rect).toEqual({ x: -10, y: 40, width: 300, height: 600 });
    resizeDocument(doc, 200, 200);
    expect(a.artboard.rect).toEqual({ x: -5, y: 20, width: 150, height: 300 });
    a.artboard.rect = { x: 0, y: 0, width: 9000, height: 10 };
    expect(() => expandCanvasToArtboards(doc)).toThrow(/8192/);
    expect(mapRect({ x: 0, y: 0, width: 10, height: 20 }, (x, y) => [-y, x])).toEqual({ x: -20, y: 0, width: 20, height: 10 });
  });
  it('places duplicated artboards beside the original and grows the canvas', () => {
    const doc = newDocument(500, 900);
    const a = createArtboard(doc, { x: 0, y: 0, width: 400, height: 800 });
    const child = layer('solid', 'C', 10, 10);
    child.transform = { x: 10, y: 10, width: 10, height: 10, rotation: 0 };
    a.children = [child];
    const copy = structuredClone(a);
    copy.id = 'copy';
    copy.children[0].id = 'copy-child';
    doc.layers = [a, copy];
    placeDuplicateArtboards(doc, [copy]);
    expect(copy.artboard!.rect).toEqual({ x: 440, y: 0, width: 400, height: 800 });
    expect(copy.children[0].transform.x).toBe(450);
    expect(doc.width).toBe(840);
    expect(canvasGrowth.pending).toEqual({ dx: 0, dy: 0, dw: 340, dh: 0 });
    canvasGrowth.pending = undefined;
  });
  it('reports bounds for groups, artboards and frames', () => {
    const doc = newDocument(100, 100);
    const g = layer('group', 'G', 100, 100);
    const c = layer('solid', 'C', 10, 10);
    c.transform = { x: 5, y: 5, width: 10, height: 20, rotation: 0 };
    g.children = [c];
    expect(layerBounds(g)).toEqual({ x: 5, y: 5, width: 10, height: 20 });
    const f = createFrame(doc, { x: 1, y: 2, width: 3, height: 4 }, 'rect');
    expect(layerBounds(f)).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(layerBounds(layer('group', 'Empty', 1, 1))).toBeUndefined();
  });
});

describe('frames', () => {
  it('fills or fits content into the frame, centered', () => {
    const frame = { x: 0, y: 0, width: 200, height: 100 };
    expect(fitRect({ width: 100, height: 100 }, frame, 'fill')).toEqual({ x: 0, y: -50, width: 200, height: 200 });
    expect(fitRect({ width: 100, height: 100 }, frame, 'fit')).toEqual({ x: 50, y: 0, width: 100, height: 100 });
    const l = layer('image', 'Photo', 400, 300);
    placeInFrame(l, { shape: 'rect', rect: frame, fit: 'fit' });
    expect(l.transform.width).toBeCloseTo(400 / 3);
    expect(l.transform).toMatchObject({ height: 100, y: 0 });
  });
  it('tests shapes and finds the topmost frame, also inside artboards', () => {
    const doc = newDocument(400, 400);
    const a = createArtboard(doc, { x: 0, y: 0, width: 400, height: 400 });
    const f = createFrame(doc, { x: 100, y: 100, width: 100, height: 50 }, 'ellipse');
    a.children.push(f);
    doc.layers = [a];
    expect(frameContains(f.frame, 150, 125)).toBe(true);
    expect(frameContains(f.frame, 101, 101)).toBe(false);
    expect(frameAt(doc, 150, 125)).toBe(f);
    expect(frameAt(doc, 10, 10)).toBeUndefined();
    expect(validateDocument(doc)).toBe(doc);
    f.children.push(createFrame(doc, { x: 0, y: 0, width: 1, height: 1 }, 'rect'));
    expect(() => validateDocument(doc)).toThrow(/frame/i);
  });
  it('computes antialiased ellipse coverage', () => {
    const rect = { x: 0, y: 0, width: 20, height: 10 };
    const cov = ellipseCoverage(rect, { x: 0, y: 0, width: 20, height: 10 });
    expect(cov[5 * 20 + 10]).toBe(1);
    expect(cov[0]).toBe(0);
    // Edge pixels are partially covered; the total approximates the area.
    const area = cov.reduce((s, v) => s + v, 0);
    expect(area).toBeGreaterThan(Math.PI * 10 * 5 - 3);
    expect(area).toBeLessThan(Math.PI * 10 * 5 + 3);
    expect([...cov].some((v) => v > 0 && v < 1)).toBe(true);
  });
});
