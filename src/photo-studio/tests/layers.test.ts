import { describe, expect, it } from 'vitest';
import { layer, newDocument, allLayers } from '../src/model/document';
import {
  groupLayers,
  mergeVisibleStack,
  moveLayers,
  reorderLayers,
  selectedRoots,
  visibleRows,
} from '../src/model/layers';
import {
  selectionFrame,
  transformSelection,
  worldPoint,
  snapTargets,
} from '../src/model/transform';
import { History } from '../src/history/history';
import { validateDocument } from '../src/model/serialization';
import { makeBackground } from '../src/model/housekeeping';

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
describe('layer organization', () => {
  it('groups nonadjacent siblings in stack order and only edits selected ancestors once', () => {
    const { doc, a, b, c } = fixture();
    const id = groupLayers(doc, new Set([c.id, a.id]));
    const g = doc.layers[1];
    expect(doc.layers.map((l) => l.id)).toEqual([b.id, id]);
    expect(g.children.map((l) => l.id)).toEqual([a.id, c.id]);
    expect(selectedRoots(doc.layers, new Set([g.id, a.id]))).toEqual([g]);
    expect(visibleRows(doc.layers, new Set([g.id])).map((l) => l.id)).toEqual([g.id, b.id]);
    expect(validateDocument(doc)).toBe(doc);
  });
  it('moves into and out of nested groups without changing geometry or order', () => {
    const { doc, a, b, c } = fixture();
    const group = layer('group', 'G', 400, 300);
    doc.layers.push(group);
    moveLayers(doc, new Set([b.id, a.id]), group.id, 'inside');
    expect(group.children).toEqual([a, b]);
    expect(b.transform.x).toBe(100);
    moveLayers(doc, new Set([a.id]), c.id, 'above');
    expect(doc.layers).toEqual([c, a, group]);
    moveLayers(doc, new Set([b.id]), null, 'above');
    expect(doc.layers).toEqual([c, a, group, b]);
  });
  it('rejects cycles, locked ancestors, and incompatible grouping atomically through history', () => {
    const { doc, a, b } = fixture();
    const id = groupLayers(doc, new Set([a.id]))!;
    const history = new History(doc);
    const attempt = (edit: Parameters<History['execute']>[1]) => {
      expect(() => history.execute('Invalid move', edit)).toThrow();
      expect(history.document).toBe(doc);
      expect(history.canUndo).toBe(false);
    };
    attempt((d) => moveLayers(d, new Set([id]), a.id, 'above'));
    attempt((d) => groupLayers(d, new Set([a.id, b.id])));
    doc.layers[0].locked = true;
    attempt((d) => moveLayers(d, new Set([a.id]), b.id, 'above'));
  });
  it('keeps selected blocks in order when raising and lowering', () => {
    const { doc, a, b, c } = fixture();
    const ids = new Set([a.id, b.id]);
    reorderLayers(doc, ids, true);
    expect(doc.layers).toEqual([c, a, b]);
    reorderLayers(doc, ids, false);
    expect(doc.layers).toEqual([a, b, c]);
  });
  it('keeps the Background layer at the bottom of the stack', () => {
    const { doc, a, b } = fixture();
    makeBackground(a);
    const names = () => doc.layers.map((l) => l.name);
    // Lowering a layer stops above the Background; the Background does not rise.
    reorderLayers(doc, new Set([b.id]), false);
    expect(names()).toEqual(['A', 'B', 'C']);
    reorderLayers(doc, new Set([a.id]), true);
    expect(names()).toEqual(['A', 'B', 'C']);
    reorderLayers(doc, new Set([a.id, b.id]), true);
    expect(names()).toEqual(['A', 'C', 'B']);
    // Dragging below it, dragging it, or grouping it is refused.
    expect(() => moveLayers(doc, new Set([b.id]), a.id, 'below')).toThrow('Background');
    expect(() => moveLayers(doc, new Set([a.id]), b.id, 'above')).toThrow('Background');
    expect(() => groupLayers(doc, new Set([a.id, b.id]))).toThrow('Background');
    moveLayers(doc, new Set([b.id]), a.id, 'above');
    expect(names()).toEqual(['A', 'B', 'C']);
  });
  it('rejects nesting that would make a saved project unreadable', () => {
    const { doc, a } = fixture();
    let parent = layer('group', 'Nested', 400, 300);
    doc.layers.push(parent);
    for (let i = 0; i < 11; i++) {
      const child = layer('group', 'Nested', 400, 300);
      parent.children.push(child);
      parent = child;
    }
    const history = new History(doc);
    expect(() =>
      history.execute('Too deep', (d) => moveLayers(d, new Set([a.id]), parent.id, 'inside')),
    ).toThrow();
    expect(history.document).toBe(doc);
  });
});
describe('Merge Visible', () => {
  it('keeps hidden layers, also inside visible groups, below or above the merged layer', () => {
    const named = (kind: 'pixel' | 'group', name: string, visible = true) => Object.assign(layer(kind, name, 10, 10), { visible });
    const g = named('group', 'G');
    g.children = [named('pixel', 'Inner', false), named('pixel', 'B'), named('pixel', 'InnerTop', false)];
    const hiddenGroup = named('group', 'HiddenGroup', false);
    hiddenGroup.children = [named('pixel', 'Child')];
    const merged = named('pixel', 'Merged');
    const out = mergeVisibleStack([named('pixel', 'Low', false), named('pixel', 'A'), g, hiddenGroup], merged);
    expect(out.map((l) => l.name)).toEqual(['Low', 'Inner', 'Merged', 'InnerTop', 'HiddenGroup']);
    expect(out[4].children.map((l) => l.name)).toEqual(['Child']);
    expect(mergeVisibleStack([named('pixel', 'H', false)], merged).map((l) => l.name)).toEqual(['H', 'Merged']);
  });
});
describe('shared transforms', () => {
  it('maps every rotated corner through the same scale and rotation', () => {
    const { doc, a, b } = fixture();
    a.transform.rotation = 30;
    const roots = [a, b],
      before = selectionFrame(roots)!;
    const corners = roots.map((l) => worldPoint(l.transform, 0, 0));
    const after = {
      ...before,
      x: before.x + 30,
      y: before.y + 40,
      width: before.width * 2,
      height: before.height * 2,
      rotation: 90,
    };
    transformSelection(roots, before, after);
    roots.forEach((l, i) => {
      const p = worldPoint(l.transform, 0, 0),
        old = corners[i];
      expect(p[0]).toBeCloseTo(
        after.x + after.width / 2 - 2 * (old[1] - before.y - before.height / 2),
      );
      expect(p[1]).toBeCloseTo(
        after.y + after.height / 2 + 2 * (old[0] - before.x - before.width / 2),
      );
      expect(l.sourceWidth).toBe(40);
    });
    expect(snapTargets(doc, roots).x).not.toContain(a.transform.x);
  });
  it('translates nested descendants and rectangular masks once and protects unsupported masks', () => {
    const { doc, a, b } = fixture();
    groupLayers(doc, new Set([a.id, b.id]));
    const g = doc.layers[0];
    g.mask = { x: 5, y: 10, width: 120, height: 30 };
    const before = selectionFrame([g])!;
    transformSelection([g], before, { ...before, x: before.x + 10, y: before.y + 20 });
    expect(a.transform.x).toBe(10);
    expect(b.transform.x).toBe(110);
    expect(g.mask.x).toBe(15);
    const snapshot = structuredClone(g);
    expect(() => transformSelection([g], before, { ...before, rotation: 45 })).toThrow(
      /rectangular masks/,
    );
    expect(g).toEqual(snapshot);
    g.maskAsset = 'bitmap';
    expect(() => transformSelection([g], before, { ...before, x: 50 })).toThrow(/bitmap or painted mask/);
    expect(allLayers([g])).toHaveLength(3);
  });
});
