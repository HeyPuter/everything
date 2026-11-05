// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { hatchTab } from '../src/ui/hatchtab.js';

// swatches draw on a later frame; jsdom has no canvas to draw them on
globalThis.requestAnimationFrame = () => 0;

function render(st) {
  const changes = [];
  const tab = hatchTab({ doc: { drawing: null } }, st, () => changes.push({ ...st }));
  const el = tab.render();
  document.body.replaceChildren(el);
  const field = (label) => el.querySelector(`input[aria-label="${label}"]`);
  const set = (inp, v) => {
    inp.value = v;
    inp.dispatchEvent(new Event('change'));
  };
  return { el, field, set, changes };
}

describe('Hatch Creation tab', () => {
  it('puts a rejected scale back to the current one', () => {
    const st = { pattern: 'SOLID', scale: 1.5, angle: 0 };
    const { field, set, changes } = render(st);
    for (const bad of ['0', '-2', '']) {
      set(field('Scale'), bad);
      expect(field('Scale').value).toBe('1.5');
      expect(field('Scale').getAttribute('aria-invalid')).toBe('true');
    }
    expect(changes).toHaveLength(0);
    set(field('Scale'), '2.5');
    expect(st.scale).toBe(2.5);
    expect(field('Scale').getAttribute('aria-invalid')).toBe(null);
    set(field('Angle'), '30');
    expect(st.angle).toBeCloseTo(Math.PI / 6, 12);
    set(field('Angle'), '');
    expect(field('Angle').value).toBe('30');
    expect(changes).toHaveLength(2);
  });
});
