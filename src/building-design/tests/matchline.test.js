import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { Scene } from '../src/core/scene.js';
import { viewPlacement } from '../src/core/annotate.js';

describe('matchlines and view references', () => {
  it('show matchlines in the plans of the levels they span', () => {
    const { doc, add, L1, L2 } = project();
    const m = add({ kind: 'matchline', a: [0, -5000], b: [0, 5000], name: 'A', z0: L1.elevation - 1, z1: L1.elevation + 1 });
    const scene = new Scene(doc);
    const p1 = doc.all('plan').find((v) => v.levelId === L1.id);
    const p2 = doc.all('plan').find((v) => v.levelId === L2.id);
    expect(scene.planOf(p1, doc.get(m.id)).texts[0].text).toBe('MATCH LINE - A');
    expect(scene.planOf(p2, doc.get(m.id))?.lines.length ?? 0).toBe(0);
  });

  it('name the target view and where it is placed', () => {
    const { doc, add } = project();
    const [p1, p2] = doc.all('plan');
    const sheet = add({ kind: 'sheet', name: 'Plans', number: 'A-101' });
    add({ kind: 'viewport', viewId: sheet.id, placedId: p2.id, at: [100, 100] });
    expect(viewPlacement(doc, p2.id)).toMatchObject({ detail: '1' });
    const ref = add({ kind: 'viewRef', viewId: p1.id, at: [0, 0], targetId: p2.id });
    const g = new Scene(doc).planOf(p1, doc.get(ref.id));
    expect(g.texts.map((t) => t.text)).toEqual([`SEE ${p2.name.toUpperCase()}`, '1 / A-101']);
  });
});
