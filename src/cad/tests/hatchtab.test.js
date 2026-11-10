// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { hatchTab } from '../src/ui/hatchtab.js';

// swatches draw on a later frame; jsdom has no canvas to draw them on
globalThis.requestAnimationFrame = () => 0;

function render(st) {
  const changes = [];
  const cancelled = [];
  const app = { doc: { drawing: null }, editor: { cancel: () => cancelled.push('cancel') }, focusCanvas: () => cancelled.push('focus') };
  const tab = hatchTab(app, st, () => changes.push({ ...st }));
  const el = tab.render();
  document.body.replaceChildren(el);
  const field = (label) => el.querySelector(`input[aria-label="${label}"]`);
  const set = (inp, v) => {
    inp.value = v;
    inp.dispatchEvent(new Event('change'));
  };
  return { el, field, set, changes, cancelled };
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

  it('cancels the hatch on Escape in a field, after undoing what was typed there', () => {
    const st = { pattern: 'SOLID', scale: 1.5, angle: 0 };
    const { field, cancelled, changes } = render(st);
    const scale = field('Scale');
    const esc = () => {
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      scale.dispatchEvent(e);
      return e;
    };
    // A value being typed: Escape first puts the current one back.
    scale.value = '7';
    esc();
    expect(scale.value).toBe('1.5');
    expect(cancelled).toEqual([]);
    // Nothing typed: Escape cancels the command, as it does on the drawing.
    esc();
    expect(cancelled).toEqual(['cancel', 'focus']);
    expect(changes).toHaveLength(0);
    expect(st.scale).toBe(1.5);
  });
});
