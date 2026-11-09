// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/drawing.js';
import { PropertiesPalette } from '../src/ui/properties.js';

const base = { layer: '0', color: 256, linetype: 'ByLayer', lineweight: -1 };

function palette(ent) {
  const d = new Drawing();
  let id;
  d.transaction('add', () => (id = d.add({ ...base, ...ent }).id));
  const p = new PropertiesPalette({ doc: { drawing: d, selection: new Set([id]) }, camera: {}, run() {} });
  document.body.append(p.el);
  p.render();
  return { d, id, p };
}

const type = (inp, value) => {
  inp.focus();
  inp.value = value;
  inp.dispatchEvent(new Event('blur'));
};

describe('Properties fields', () => {
  it('limits the text obliquing angle to ±85 degrees', () => {
    const { d, id, p } = palette({ type: 'text', x: 0, y: 0, h: 2.5, rot: 0, value: 'A', style: 'Standard', widthFactor: 1, oblique: 0 });
    const inp = p.el.querySelector('[data-key="prop:Obliquing"]');
    type(inp, '90');
    expect(d.get(id).oblique).toBe(0);
    expect(inp.getAttribute('aria-invalid')).toBe('true');
    type(inp, '-95');
    expect(d.get(id).oblique).toBe(0);
    type(inp, '30');
    expect(d.get(id).oblique).toBeCloseTo(Math.PI / 6, 12);
    p.el.remove();
  });
});
