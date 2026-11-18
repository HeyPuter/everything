import { describe, expect, it } from 'vitest';
import { layer, newDocument, allLayers, type PhotoDocument } from '../src/model/document';
import { allLinked, cleanLinks, expandLinked, followLinkedMasks, linkLayers, linkedPartners, maskLinked, renewLinkGroups, unlinkLayers } from '../src/model/links';
import { isEmptyLayer, makeBackground, pasteMask, releaseBackground, removeEmptyLayers, removeHiddenLayers, transparencyToMask } from '../src/model/housekeeping';
import { selectedRoots } from '../src/model/layers';
import { selectionFrame, transformSelection } from '../src/model/transform';
import { newPixelLayer, commitPixelTranslation } from '../src/model/pixel-layer';
import { emptyGrid, readMask, TileStore, writeRect } from '../src/model/tiles';
import { serialize, deserialize, validateDocument } from '../src/model/serialization';
import { Assets } from '../src/model/assets';
import { History } from '../src/history/history';
import { ownLock } from '../src/model/locks';
import type { VectorMask } from '../src/model/vector';

function fixture() {
  const doc = newDocument(400, 300);
  const a = layer('solid', 'A', 40, 20),
    b = layer('solid', 'B', 40, 20),
    c = layer('solid', 'C', 40, 20);
  b.transform.x = 100;
  c.transform.x = 200;
  doc.layers = [a, b, c];
  return { doc, a, b, c };
}
const square = (x: number, y: number): VectorMask => ({
  fillStartsWithAllPixels: false,
  paths: [{ open: false, fillRule: 'non-zero', operation: 'combine', knots: [[x, y], [x + 10, y], [x + 10, y + 10], [x, y + 10]].map(([px, py]) => ({ linked: false, points: [px, py, px, py, px, py] })) }],
} as unknown as VectorMask);

describe('layer links', () => {
  it('links, expands and unlinks groups of layers', () => {
    const { doc, a, b, c } = fixture();
    linkLayers(doc.layers, [a.id, b.id], 'g1');
    expect(a.linkGroup).toBe('g1');
    expect(b.linkGroup).toBe('g1');
    expect([...expandLinked(doc.layers, [a.id])].sort()).toEqual([a.id, b.id].sort());
    expect(linkedPartners(doc.layers, b.id).map((l) => l.id)).toEqual([a.id]);
    expect(allLinked(doc.layers, [a.id, b.id])).toBe(true);
    expect(allLinked(doc.layers, [a.id, c.id])).toBe(false);
    // Linking a layer to a linked one merges it into the existing group.
    linkLayers(doc.layers, [b.id, c.id], 'g2');
    expect(new Set(doc.layers.map((l) => l.linkGroup))).toEqual(new Set(['g2']));
    unlinkLayers(doc.layers, [a.id, b.id]);
    // C is left alone in its group, so the group dissolves.
    expect(doc.layers.every((l) => !l.linkGroup)).toBe(true);
  });
  it('dissolves single-member groups and validates the field', () => {
    const { doc, a } = fixture();
    a.linkGroup = 'lonely';
    cleanLinks(doc.layers);
    expect(a.linkGroup).toBeUndefined();
    a.linkGroup = '' as string;
    expect(() => validateDocument(doc)).toThrow('Invalid layer link');
  });
  it('moves linked layers together through selection roots', () => {
    const { doc, a, b, c } = fixture();
    linkLayers(doc.layers, [a.id, c.id]);
    const roots = selectedRoots(doc.layers, expandLinked(doc.layers, [a.id]));
    expect(roots.map((l) => l.id)).toEqual([a.id, c.id]);
    const before = selectionFrame(roots)!;
    transformSelection(roots, before, { ...before, x: before.x + 5, y: before.y + 7 });
    expect([a.transform.x, a.transform.y, c.transform.x, c.transform.y]).toEqual([5, 7, 205, 7]);
    expect(b.transform.x).toBe(100);
  });
  it('round-trips links, background and mask link flags through .photo projects', async () => {
    const { doc, a, b, c } = fixture();
    linkLayers(doc.layers, [b.id, c.id], 'link-1');
    c.maskUnlinked = true;
    c.vectorMask = { mask: square(0, 0), unlinked: true };
    makeBackground(a);
    const restored = await deserialize(await serialize(doc, new Assets()));
    const [ra, rb, rc] = restored.document.layers;
    expect(ra.background).toBe(true);
    expect(rb.linkGroup).toBe('link-1');
    expect(rc.linkGroup).toBe('link-1');
    expect(rc.maskUnlinked).toBe(true);
    expect(rc.vectorMask?.unlinked).toBe(true);
  });
});

describe('mask links', () => {
  it('moves linked document-space masks with pure translations only', () => {
    const { doc, b } = fixture();
    b.maskGrid = { ...emptyGrid(1), fill: 255 };
    b.vectorMask = { mask: square(100, 0) };
    const after: PhotoDocument = structuredClone(doc);
    after.layers[1].transform.x += 12.4;
    after.layers[1].transform.y -= 3;
    followLinkedMasks(doc, after);
    const moved = after.layers[1];
    expect([moved.maskGrid!.x, moved.maskGrid!.y]).toEqual([12, -3]);
    expect(moved.vectorMask!.mask.paths[0].knots[0].points.slice(2, 4)).toEqual([112.4, -3]);
    // Unlinked masks stay; resizes are not translations.
    const unlinked: PhotoDocument = structuredClone(doc);
    unlinked.layers[1].maskUnlinked = true;
    unlinked.layers[1].vectorMask!.unlinked = true;
    const later: PhotoDocument = structuredClone(unlinked);
    later.layers[1].transform.x += 20;
    followLinkedMasks(unlinked, later);
    expect(later.layers[1].maskGrid!.x).toBe(0);
    const resized: PhotoDocument = structuredClone(doc);
    resized.layers[1].transform.width *= 2;
    resized.layers[1].transform.x += 5;
    followLinkedMasks(doc, resized);
    expect(resized.layers[1].maskGrid!.x).toBe(0);
  });
  it('scales and turns linked masks with the layer when a tile store is given', () => {
    const store = new TileStore();
    const { doc, b } = fixture();
    // B covers (100, 0)–(140, 20); its mask hides the left half.
    b.maskGrid = writeRect(store, { ...emptyGrid(1), fill: 255 }, 100, 0, { width: 20, height: 20, data: new Uint8Array(400) });
    b.vectorMask = { mask: square(100, 0) };
    const after: PhotoDocument = structuredClone(doc);
    after.layers[1].transform = { ...after.layers[1].transform, width: 80, height: 40 };
    followLinkedMasks(doc, after, store);
    const m = after.layers[1];
    const at = (x: number) => readMask(store, m.maskGrid!, { x, y: 10, width: 1, height: 1 }).data[0];
    expect([at(110), at(130), at(150), at(170)]).toEqual([0, 0, 255, 255]);
    expect(m.vectorMask!.mask.paths[0].knots[0].points.slice(2, 4)).toEqual([100, 0]);
    expect(m.vectorMask!.mask.paths[0].knots[2].points.slice(2, 4)).toEqual([120, 20]);
  });
  it('bakes pixel-layer moves into the mask only when linked', () => {
    const store = new TileStore();
    const doc = newDocument(64, 64);
    const content = { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(255) };
    const l = newPixelLayer('P', doc, writeRect(store, emptyGrid(4), 10, 10, content));
    l.maskGrid = { ...emptyGrid(1), fill: 255 };
    l.transform = { ...l.transform, x: l.transform.x + 5 };
    commitPixelTranslation(l);
    expect(l.maskGrid.x).toBe(5);
    l.maskUnlinked = true;
    l.transform = { ...l.transform, x: l.transform.x + 5 };
    commitPixelTranslation(l);
    expect(l.maskGrid.x).toBe(5);
    expect(maskLinked(l)).toBe(false);
  });
  it('follows linked masks through history edits', () => {
    const { doc } = fixture();
    doc.layers[2].maskGrid = { ...emptyGrid(1), fill: 255 };
    const h = new History(doc);
    h.normalize = (d, before) => followLinkedMasks(before, d);
    h.execute('Move', (d) => (d.layers[2].transform.x += 30));
    expect(h.document.layers[2].maskGrid!.x).toBe(30);
    h.undo();
    expect(h.document.layers[2].maskGrid!.x).toBe(0);
  });
});

describe('housekeeping', () => {
  it('finds and removes empty layers, including groups they empty', () => {
    const store = new TileStore();
    const doc = newDocument(32, 32);
    const empty = newPixelLayer('Empty', doc);
    const full = newPixelLayer('Full', doc, writeRect(store, emptyGrid(4), 0, 0, { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) }));
    const text = layer('text', 'Blank', 10, 10);
    text.text = '   ';
    const group = layer('group', 'Group', 32, 32);
    group.children = [newPixelLayer('Nested', doc)];
    const bg = newPixelLayer('Background', doc);
    makeBackground(bg);
    doc.layers = [bg, empty, full, text, group];
    expect([empty, full, text, group].map(isEmptyLayer)).toEqual([true, false, true, false]);
    expect(removeEmptyLayers(doc.layers)).toBe(4);
    expect(doc.layers.map((l) => l.name)).toEqual(['Background', 'Full']);
  });
  it('removes hidden layers anywhere in the tree and dissolves broken links', () => {
    const { doc, a, b, c } = fixture();
    const g = layer('group', 'G', 1, 1);
    const hiddenChild = layer('solid', 'H', 1, 1);
    hiddenChild.visible = false;
    g.children = [hiddenChild];
    doc.layers.push(g);
    linkLayers(doc.layers, [a.id, b.id]);
    b.visible = false;
    expect(removeHiddenLayers(doc.layers)).toBe(2);
    expect(allLayers(doc.layers).map((l) => l.name)).toEqual(['A', 'C', 'G']);
    expect(a.linkGroup).toBeUndefined();
    void c;
  });
  it('keeps links between layers inside and outside a group when a hidden layer in the group goes', () => {
    const { doc, a, b } = fixture();
    const g = layer('group', 'G', 1, 1);
    const hidden = layer('solid', 'H', 1, 1);
    hidden.visible = false;
    doc.layers = [a, g];
    g.children = [b, hidden];
    linkLayers(doc.layers, [a.id, b.id], 'pair');
    expect(removeHiddenLayers(doc.layers)).toBe(1);
    expect([a.linkGroup, b.linkGroup]).toEqual(['pair', 'pair']);
  });
  it('gives layers brought in from elsewhere link groups of their own', () => {
    const { a, b, c } = fixture();
    const g = layer('group', 'G', 1, 1);
    g.children = [c];
    a.linkGroup = b.linkGroup = 'one';
    c.linkGroup = 'two';
    renewLinkGroups([a, b, g]);
    expect(a.linkGroup).toBe(b.linkGroup);
    expect([a.linkGroup, c.linkGroup]).not.toContain('one');
    expect(c.linkGroup).not.toBe('two');
    expect(c.linkGroup).not.toBe(a.linkGroup);
  });
  it('splits transparency into a mask and an opaque image', () => {
    const img = { width: 2, height: 1, data: new Uint8ClampedArray([10, 20, 30, 128, 1, 2, 3, 0]) };
    const { mask, opaque } = transparencyToMask(img);
    expect([...mask.data]).toEqual([128, 0]);
    expect([...opaque.data]).toEqual([10, 20, 30, 255, 1, 2, 3, 255]);
    expect(img.data[3]).toBe(128);
  });
  it('builds paste-into and paste-outside masks from the selection', () => {
    const sel = { width: 3, height: 1, data: new Uint8Array([0, 128, 255]) };
    expect([...pasteMask(sel, false).data]).toEqual([0, 128, 255]);
    expect([...pasteMask(sel, true).data]).toEqual([255, 127, 0]);
    expect(pasteMask(sel, false).data).not.toBe(sel.data);
  });
  it('locks and releases the Background layer', () => {
    const l = layer('pixel', 'Background', 1, 1);
    makeBackground(l);
    expect(ownLock(l, 'position')).toBe(true);
    expect(ownLock(l, 'transparency')).toBe(true);
    expect(ownLock(l, 'pixels')).toBe(false);
    releaseBackground(l);
    expect(l.background).toBeUndefined();
    expect(ownLock(l, 'position')).toBe(false);
  });
});
