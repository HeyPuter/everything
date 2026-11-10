// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { PropertiesPalette } from '../src/ui/properties.js';

const base = { layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1 };

function setup() {
  const A = new Drawing();
  const B = new Drawing();
  let c, l;
  A.transaction('add', () => (c = A.add({ ...base, type: 'circle', cx: 0, cy: 0, r: 5 }).id));
  B.transaction('add', () => (l = B.add({ ...base, type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }).id));
  expect(l).toBe(c); // ids restart at 1 in every drawing
  const docA = { drawing: A, selection: new Set([c]) };
  const docB = { drawing: B, selection: new Set() };
  const app = { doc: docA, camera: {}, run() {} };
  const p = new PropertiesPalette(app);
  document.body.append(p.el);
  p.render();
  return { A, B, c, l, app, p, docB };
}

describe('Properties palette when the active drawing changes', () => {
  it('commits a pending edit to the drawing it was made in', () => {
    const { A, B, c, l, app, p, docB } = setup();
    const before = structuredClone(B.get(l));
    const radius = p.el.querySelector('[data-key="prop:Radius"]');
    radius.focus();
    radius.value = '42';
    app.doc = docB; // e.g. an import finished in the background and was activated
    p.render();
    radius.dispatchEvent(new Event('blur'));
    expect(A.get(c).r).toBe(42);
    expect(B.get(l)).toEqual(before);
    p.el.remove();
  });
  it('shows the new drawing even while a field has focus', () => {
    const { app, p, docB } = setup();
    p.el.querySelector('[data-key="prop:Radius"]').focus();
    app.doc = docB;
    p.render();
    expect(p.el.querySelector('[data-key="prop:Radius"]')).toBe(null);
    p.el.remove();
  });
  it('still keeps the field being edited when the same drawing re-renders', () => {
    const { p } = setup();
    const radius = p.el.querySelector('[data-key="prop:Radius"]');
    radius.focus();
    p.render();
    expect(p.el.querySelector('[data-key="prop:Radius"]')).toBe(radius);
    p.el.remove();
  });
});
