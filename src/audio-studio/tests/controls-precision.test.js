import { describe, expect, it, vi } from 'vitest';
import { hotNumber, knob } from '../src/ui/controls.js';
import { paramControls } from '../src/effects/param-ui.js';
import { toPosition, fromPosition } from '../src/effects/params.js';

const arrow = (el, key) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

describe('fractional control increments', () => {
  it.each([['number field', hotNumber], ['knob', knob]])('%s retains every decimal of its configured step', (_, control) => {
    for (const step of [0.0025, 0.25, 2.5, 2.5e-7, 0.1]) {
      const changed = vi.fn();
      const el = control({ label: 'Value', value: 0, min: -10, max: 10, step, onChange: changed });
      arrow(el, 'ArrowUp');
      expect(el.getValue()).toBe(step);
      expect(changed).toHaveBeenLastCalledWith(step);
      arrow(el, 'ArrowDown');
      expect(el.getValue()).toBe(0);
      arrow(el, 'ArrowDown');
      expect(el.getValue()).toBe(-step);
    }
  });

  it('moves a logarithmic frequency field by its exact 0.0025 position step', () => {
    const p = { id: 'frequency', label: 'Frequency', min: 20, max: 20000, step: 1, default: 500, unit: 'Hz', scale: 'log' };
    let value = p.default;
    const c = paramControls({ params: [p] }, () => ({ frequency: value }), (_, v) => { value = v; });
    const position = toPosition(p, value);
    const expected = fromPosition(p, Math.round((position + 0.0025) / 0.0025) * 0.0025);
    arrow(c.el.querySelector('.hot'), 'ArrowUp');
    expect(value).toBe(expected);
  });
});
