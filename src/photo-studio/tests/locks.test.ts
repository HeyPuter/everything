import { describe, it, expect } from 'vitest';
import { layer, newDocument } from '../src/model/document';
import {
  ownLock,
  layerLock,
  setFullLock,
  setPartialLock,
  exportProtection,
} from '../src/model/locks';
import { assertEditable, reorderLayers } from '../src/model/layers';
import { validateDocument } from '../src/model/serialization';
import { makeBackground } from '../src/model/housekeeping';

describe('independent PSD layer protection', () => {
  it('checks each operation independently for every combination of protection bits', () => {
    for (let flags = 0; flags < 16; flags++) {
      const l = layer('paint', 'Pixels', 37, 23);
      l.protection = {
        transparency: !!(flags & 1),
        composite: !!(flags & 2),
        position: !!(flags & 4),
        artboards: !!(flags & 8),
      };
      expect(ownLock(l, 'transparency')).toBe(!!(flags & 1));
      expect(ownLock(l, 'pixels')).toBe(!!(flags & 2));
      expect(ownLock(l, 'position')).toBe(!!(flags & 4));
      expect(ownLock(l)).toBe(false);
      expect(exportProtection(l)).toEqual(l.protection);
    }
  });
  it('inherits the relevant protection through nested groups, without affecting siblings', () => {
    const d = newDocument(37, 23),
      g = layer('group', 'Outer', 37, 23),
      nested = layer('group', 'Inner', 37, 23),
      child = layer('paint', 'Child', 37, 23),
      sibling = layer('paint', 'Sibling', 37, 23);
    nested.children = [child];
    g.children = [nested];
    d.layers = [g, sibling];
    setPartialLock(g, 'position', true);
    expect(layerLock(d.layers, child.id, 'position')).toBe(true);
    expect(layerLock(d.layers, sibling.id, 'position')).toBe(false);
    expect(layerLock(d.layers, child.id, 'pixels')).toBe(false);
    expect(() => assertEditable(d, [child], 'position')).toThrow();
    expect(() => assertEditable(d, [child])).not.toThrow();
    setPartialLock(child, 'composite', true);
    expect(() => assertEditable(d, [g], 'pixels')).toThrow();
    expect(() => assertEditable(d, [g])).not.toThrow();
    setFullLock(g, true);
    for (const operation of [
      'all',
      'position',
      'pixels',
      'transparency',
    ] as const)
      expect(layerLock(d.layers, child.id, operation)).toBe(true);
    expect(layerLock(d.layers, g.id, 'all', false)).toBe(false);
    expect(layerLock(d.layers, child.id, 'all', false)).toBe(true);
    expect(layerLock(d.layers, 'missing')).toBe(false);
  });
  it('expands legacy full locks and releases only the selected protection', () => {
    const l = layer('paint', 'Old project', 37, 23);
    l.locked = true;
    setPartialLock(l, 'position', false);
    expect(l.locked).toBe(false);
    expect(l.protection).toEqual({
      transparency: true,
      composite: true,
      position: false,
    });
    expect(ownLock(l, 'pixels')).toBe(true);
    setPartialLock(l, 'position', true);
    expect(l.locked).toBe(true);
    setFullLock(l, false);
    expect(exportProtection(l)).toEqual({
      transparency: false,
      composite: false,
      position: false,
    });
  });
  it('unlocking the Background keeps its transparency and position locks', () => {
    const l = layer('pixel', 'Background', 37, 23);
    makeBackground(l);
    setFullLock(l, true);
    expect(exportProtection(l)).toEqual({ transparency: true, composite: true, position: true });
    setFullLock(l, false);
    expect(l.locked).toBe(false);
    expect([ownLock(l, 'transparency'), ownLock(l, 'pixels'), ownLock(l, 'position')]).toEqual([true, false, true]);
  });
  it('retains legacy transparency flags separately and applies full-lock overrides on export', () => {
    const l = layer('paint', 'Record flag', 37, 23);
    l.transparencyProtected = true;
    expect(ownLock(l, 'transparency')).toBe(true);
    expect(ownLock(l, 'position')).toBe(false);
    expect(exportProtection(l).transparency).toBe(false);
    setPartialLock(l, 'transparency', false);
    expect(l.transparencyProtected).toBe(false);
    l.locked = true;
    expect(exportProtection(l)).toEqual({
      transparency: true,
      composite: true,
      position: true,
    });
  });
  it('keeps partial locks and captured painting policies on structural edits and native validation', () => {
    const d = newDocument(37, 23),
      l = layer('paint', 'Brush', 37, 23);
    setPartialLock(l, 'position', true);
    l.strokes = [
      {
        points: [[7.25, 9.5]],
        color: '#1b6ef7',
        size: 4.25,
        preserveAlpha: true,
      },
    ];
    d.layers = [l, layer('paint', 'Other', 37, 23)];
    reorderLayers(d, new Set([l.id]), true);
    expect(d.layers[1].protection).toEqual(l.protection);
    expect(d.layers[1]).toBe(l);
    setPartialLock(l, 'transparency', false);
    expect(l.strokes[0].preserveAlpha).toBe(true);
    expect(validateDocument(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });
  it('rejects malformed lock metadata and painting policy fields', () => {
    const d = newDocument(37, 23),
      l = layer('paint', 'Brush', 37, 23);
    d.layers = [l];
    for (const bad of [
      null,
      { transparency: true },
      { transparency: 1, composite: false, position: false },
      { transparency: false, composite: false, position: false, artboards: 1 },
    ]) {
      expect(() =>
        validateDocument({ ...d, layers: [{ ...l, protection: bad }] }),
      ).toThrow('protection');
    }
    expect(() =>
      validateDocument({ ...d, layers: [{ ...l, transparencyProtected: 1 }] }),
    ).toThrow('protection');
    expect(() =>
      validateDocument({
        ...d,
        layers: [
          {
            ...l,
            strokes: [
              {
                points: [[1, 2]],
                color: '#112233',
                size: 2,
                preserveAlpha: 'yes',
              },
            ],
          },
        ],
      }),
    ).toThrow('stroke');
  });
});
