import { describe, it, expect } from 'vitest';
import { vSlider } from '../src/effects/layout.js';

function fakeCtx(onLevels = true) {
  const subs = new Set();
  const ctx = {
    def: { params: [{ id: 'gain', label: 'Gain', type: 'number', min: -40, max: 20, step: 0.1, default: 0, unit: 'dB' }] },
    values: { gain: 0 },
    set: (id, v) => {
      ctx.values = { ...ctx.values, [id]: v };
      subs.forEach((fn) => fn(ctx.values));
    },
    subscribe: (fn) => subs.add(fn),
    levels: null,
  };
  if (onLevels) ctx.onLevels = (fn) => (ctx.levels = fn);
  return ctx;
}

describe('vertical effect faders', () => {
  it('show a labelled scale beside the fader', () => {
    const el = vSlider(fakeCtx(), 'gain');
    const labels = [...el.querySelectorAll('.fx-vtick-label')].map((l) => l.textContent);
    expect(labels).toContain('0');
    expect(labels).toContain('-40');
    expect(el.querySelector('.fx-vmeter')).toBeNull();
  });

  it('can show the output level while the dialog previews', () => {
    const ctx = fakeCtx();
    const el = vSlider(ctx, 'gain', { meter: 'out' });
    const fill = el.querySelector('.fx-vmeter-fill');
    ctx.levels([1, 1], [0.5, 0.25]);
    expect(fill.style.clipPath).toBe('inset(10.0% 0 0 0)'); // -6 dB on a -60..0 scale
    ctx.levels(null, null);
    expect(fill.style.clipPath).toBe('inset(100.0% 0 0 0)');
  });
});
