import { describe, it, expect } from 'vitest';
import { project } from './helpers.js';
import { viewGraphics } from '../src/core/graphics.js';

describe('element graphics overrides', () => {
  it('win over category overrides in their view only', () => {
    const { doc, wall } = project();
    const w = wall([0, 0], [4000, 0]);
    const [p1, p2] = doc.all('plan');
    doc.transact('o', () => {
      doc.update(p1.id, { overrides: { walls: { color: '#00ff00', weight: 2 } }, elOverrides: { [w.id]: { color: '#ff0000', halftone: true } } });
    });
    const g = viewGraphics(doc, doc.get(p1.id), doc.get(w.id));
    expect(g.color).toBe('#ff0000');
    expect(g.weight).toBe(2);
    expect(g.halftone).toBe(true);
    expect(viewGraphics(doc, doc.get(p2.id), doc.get(w.id)).color).toBeNull();
  });
});
