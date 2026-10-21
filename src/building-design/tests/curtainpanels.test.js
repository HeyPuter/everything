import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { Scene } from '../src/core/scene.js';

describe('curtain wall mullions and panels', () => {
  it('leave out removed mullion segments and empty panels', () => {
    const { doc, wall } = project();
    const ct = doc.all('wallType').find((t) => t.curtain);
    const w = wall([0, 0], [6000, 0], { typeId: ct.id });
    const tris = (el) => new Scene(doc).mesh(el).pos.length / 9;
    const plain = tris(doc.get(w.id));
    doc.transact('e', () => doc.update(w.id, { panels: { '0:0': 'empty' } }));
    const lessGlass = tris(doc.get(w.id));
    expect(lessGlass).toBeLessThan(plain);
    doc.transact('m', () => doc.update(w.id, { mullionsOff: ['v:1:0'] }));
    expect(tris(doc.get(w.id))).toBeLessThan(lessGlass);
    doc.transact('d', () => doc.update(w.id, { mullionsOff: null, panels: { '0:0': 'door' } }));
    expect(tris(doc.get(w.id))).toBeGreaterThan(plain);
  });
});
