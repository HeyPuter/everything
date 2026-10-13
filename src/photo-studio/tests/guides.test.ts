import { describe, expect, it } from 'vitest';
import { cropDocument, mapDocumentGeometry, newDocument, type PhotoDocument } from '../src/model/document';
import { createArtboard } from '../src/model/artboard';
import { guideLines, mergeGuides, migrateGuides, parseGuideKey, placedGuides, rectGuides, removeGuides, setOwnerGuides, guideKey } from '../src/model/guides';
import { deserialize, serialize } from '../src/model/serialization';
import { Assets } from '../src/model/assets';
import { lineTargets } from '../src/model/transform';
import { layoutGuides } from '../src/features/guides';
import { actualSizeZoom } from '../src/app/view-transform';

function withArtboard(): PhotoDocument {
  const doc = newDocument(400, 300);
  const a = createArtboard(doc, { x: 100, y: 50, width: 200, height: 150 }, {}, 'Board');
  a.artboard.guides = [{ orientation: 'vertical', position: 20 }, { orientation: 'horizontal', position: 10 }];
  doc.layers = [a];
  doc.guides = [{ orientation: 'vertical', position: 5 }];
  return doc;
}

describe('canvas and artboard guides', () => {
  it('places artboard guides relative to their artboard, spanning only it', () => {
    const doc = withArtboard();
    const placed = placedGuides(doc);
    expect(placed.map((g) => [g.key.startsWith('a:') ? 'artboard' : 'canvas', g.orientation, g.position])).toEqual([
      ['canvas', 'vertical', 5],
      ['artboard', 'vertical', 120],
      ['artboard', 'horizontal', 60],
    ]);
    expect(placed[1].extent).toEqual({ x: 100, y: 50, width: 200, height: 150 });
    expect(placedGuides(doc, { artboards: false })).toHaveLength(1);
    expect(placedGuides(doc, { canvas: false })).toHaveLength(2);
  });

  it('moves artboard guides with the artboard', () => {
    const doc = withArtboard();
    doc.layers[0].artboard!.rect = { ...doc.layers[0].artboard!.rect, x: 0, y: 0 };
    expect(placedGuides(doc, { canvas: false }).map((g) => g.position)).toEqual([20, 10]);
  });

  it('snaps to canvas and artboard guides', () => {
    const doc = withArtboard();
    expect(guideLines(doc)).toEqual({ x: [5, 120], y: [60] });
    const t = lineTargets(doc, { document: false });
    expect(t.x).toEqual([5, 120]);
  });

  it('removes guides by key from either list', () => {
    const doc = withArtboard();
    const id = doc.layers[0].id;
    expect(parseGuideKey(guideKey({ artboard: id }, 1))).toEqual({ owner: { artboard: id }, index: 1 });
    expect(removeGuides(doc, ['c:0', `a:${id}:0`])).toBe(2);
    expect(doc.guides).toBeUndefined();
    expect(doc.layers[0].artboard!.guides).toEqual([{ orientation: 'horizontal', position: 10 }]);
    setOwnerGuides(doc, { artboard: id }, []);
    expect(doc.layers[0].artboard!.guides).toBeUndefined();
  });

  it('keeps artboard guides on the same image lines through canvas edits', () => {
    const doc = withArtboard();
    // 90° clockwise on a 400 × 300 canvas.
    mapDocumentGeometry(doc, (x, y) => [300 - y, x]);
    const a = doc.layers[0].artboard!;
    expect(a.rect).toEqual({ x: 100, y: 100, width: 150, height: 200 });
    // Vertical x=120 becomes horizontal y=120; horizontal y=60 becomes vertical x=240.
    expect(placedGuides(doc, { canvas: false }).map((g) => [g.orientation, g.position])).toEqual([
      ['horizontal', 120],
      ['vertical', 240],
    ]);
    cropDocument(doc, { x: 50, y: 50, width: 250, height: 250 });
    expect(placedGuides(doc, { canvas: false }).map((g) => [g.orientation, g.position])).toEqual([
      ['horizontal', 70],
      ['vertical', 190],
    ]);
  });

  it('migrates guides of older projects: canvas guides stay, invalid entries go', () => {
    const doc = withArtboard();
    (doc as unknown as { guides: unknown[] }).guides = [{ orientation: 'vertical', position: 12 }, { orientation: 'diagonal', position: 3 }, { orientation: 'horizontal', position: Number.NaN }, null];
    delete doc.layers[0].artboard!.guides;
    migrateGuides(doc);
    expect(doc.guides).toEqual([{ orientation: 'vertical', position: 12 }]);
    expect(doc.layers[0].artboard!.guides).toBeUndefined();
    (doc as unknown as { guides: unknown }).guides = 'nope';
    expect(() => migrateGuides(doc)).toThrow(/guides/);
  });

  it('round-trips artboard guides through .photo projects', async () => {
    const doc = withArtboard();
    const restored = await deserialize(await serialize(doc, new Assets()));
    expect(restored.document.guides).toEqual([{ orientation: 'vertical', position: 5 }]);
    expect(restored.document.layers[0].artboard!.guides).toEqual([{ orientation: 'vertical', position: 20 }, { orientation: 'horizontal', position: 10 }]);
  });

  it('opens a project saved before artboard guides with its guides as canvas guides', async () => {
    const doc = withArtboard();
    delete doc.layers[0].artboard!.guides;
    doc.guides = [{ orientation: 'vertical', position: 150 }, { orientation: 'horizontal', position: 75 }];
    const restored = await deserialize(await serialize(doc, new Assets()));
    expect(placedGuides(restored.document).map((g) => g.key)).toEqual(['c:0', 'c:1']);
  });

  it('makes guides from shape bounds and merges duplicates', () => {
    const g = rectGuides({ x: 10, y: 20, width: 100, height: 50 });
    expect(g.map((x) => x.position)).toEqual([10, 110, 20, 70, 60, 45]);
    expect(mergeGuides(g, [{ orientation: 'vertical', position: 10.001 }, { orientation: 'vertical', position: 11 }])).toHaveLength(7);
  });

  it('lays out columns with gutters and margins inside an area', () => {
    const g = layoutGuides(200, 100, 2, 0, 20, 10);
    expect(g).toEqual([
      { orientation: 'vertical', position: 10 },
      { orientation: 'vertical', position: 190 },
      { orientation: 'vertical', position: 90 },
      { orientation: 'vertical', position: 110 },
    ]);
  });
});

describe('actual size zoom', () => {
  it('shows one image pixel per display pixel', () => {
    expect(actualSizeZoom(1)).toBe(1);
    expect(actualSizeZoom(2)).toBe(0.5);
    expect(actualSizeZoom(1.25)).toBeCloseTo(0.8);
    // Unknown ratios fall back to CSS pixels.
    expect(actualSizeZoom(0)).toBe(1);
    expect(actualSizeZoom(Number.NaN)).toBe(1);
  });
});
